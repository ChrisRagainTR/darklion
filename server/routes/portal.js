'use strict';

const { Router } = require('express');
const multer = require('multer');
const { pool } = require('../db');
const { archiveClientMessageCreatedFailClosed } = require('../services/communicationArchive');
const { getSignedDownloadUrl, uploadFile, downloadFile, buildKey, sanitizeFilename } = require('../services/s3');
const { embedSignature } = require('../services/sign-pdf');
const { classifyMessage } = require('../services/claude');
const { sendEmail, sendPortalNotification } = require('../services/email');
const { sendStaffMobilePush } = require('../services/mobilePush');
const { advancePipelineJob } = require('./tax-delivery');
const { fireTrigger } = require('../services/pipelineTriggers');
const { recordActivityEvent } = require('../services/activityLog');
const { buildClientTaxStatus } = require('../services/clientTaxStatus');
// Lazy require to avoid circular dependency
function cancelPendingNotification(personId) {
  try { require('./messages').cancelPendingNotification(personId); } catch(e) { /* non-fatal */ }
}

const router = Router();
const APP_URL = (process.env.APP_URL || 'http://localhost:8080').replace(/\/+$/, '');

// Staff photos are signed against the start of the current half hour, so every load in that window
// gets the same URL and the browser can reuse the cached image. A link never lives past an hour.
const AVATAR_SIGN_WINDOW_MS = 30 * 60 * 1000;
function signStaffAvatar(key, bucket) {
  const signingDate = new Date(Math.floor(Date.now() / AVATAR_SIGN_WINDOW_MS) * AVATAR_SIGN_WINDOW_MS);
  return getSignedDownloadUrl({ key, bucket, expiresIn: 3600, signingDate });
}

// Message preview for contact lists: whole words only, with an ellipsis when shortened.
function messagePreview(body, max = 100) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : text.slice(0, max)).replace(/[\s.,;:!?-]+$/, '') + '\u2026';
}

// Marks the client's unread staff messages in a thread as read, up to the newest message the client was shown.
async function markThreadRead(threadId, upToMessageId) {
  const params = [threadId];
  let upTo = '';
  if (upToMessageId) { params.push(upToMessageId); upTo = ' AND id <= $2'; }
  const result = await pool.query(
    `UPDATE messages SET read_at = NOW()
     WHERE thread_id = $1 AND sender_type = 'staff' AND is_internal = false AND removed_at IS NULL AND read_at IS NULL${upTo}`,
    params
  );
  return result.rowCount || 0;
}

function portalFolderAppliesToOwner(folder, ownerType, ownerId) {
  if (!folder) return false;
  if (folder.scope === 'firm') return folder.applies_to === 'all' || folder.applies_to === ownerType;
  return folder.scope === 'client' && folder.owner_type === ownerType && Number(folder.owner_id) === Number(ownerId);
}

async function resolvePortalDocumentFolder(firmId, folderId, ownerType, ownerId) {
  const id = parseInt(folderId, 10);
  if (!id) return null;
  const { rows } = await pool.query(
    `SELECT id, scope, applies_to, owner_type, owner_id,
            folder_section, folder_category, name
       FROM document_folders
      WHERE id = $1 AND firm_id = $2 AND archived_at IS NULL`,
    [id, firmId]
  );
  const folder = rows[0];
  return portalFolderAppliesToOwner(folder, ownerType, ownerId) ? folder : null;
}

// ── Allowed file types ────────────────────────────────────────────────────────
const _ALLOWED_MIME = new Set([
  'application/pdf','application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain','text/csv',
  'image/jpeg','image/png','image/gif','image/webp','image/heic','image/heif',
  'application/zip','application/x-zip-compressed',
]);
const _ALLOWED_EXT = new Set([
  '.pdf','.doc','.docx','.xls','.xlsx','.txt','.csv',
  '.jpg','.jpeg','.png','.gif','.webp','.heic','.heif','.zip',
]);
function _fileFilter(req, file, cb) {
  const ext = require('path').extname(file.originalname || '').toLowerCase();
  if (!_ALLOWED_MIME.has(file.mimetype) || !_ALLOWED_EXT.has(ext)) {
    // expose: this message is written for the client and is safe to return as-is.
    return cb(Object.assign(new Error(`File type not allowed: ${ext || file.mimetype}. Allowed: PDF, Word, Excel, images, CSV, ZIP.`), { expose: true }));
  }
  cb(null, true);
}

// Multer: memory storage for client uploads (max 50 MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: _fileFilter,
});

// Map upload errors to fixed client-facing text. Only our own file-type message
// passes through; multer/busboy internals never reach the client.
const _MULTER_MESSAGES = {
  LIMIT_FILE_SIZE: 'File is too large. The maximum size is 50 MB.',
  LIMIT_FILE_COUNT: 'Too many files. Please upload fewer files at once.',
  LIMIT_UNEXPECTED_FILE: 'Unexpected file. Please try the upload again.',
  LIMIT_PART_COUNT: 'Upload could not be processed. Please try again.',
  LIMIT_FIELD_KEY: 'Upload could not be processed. Please try again.',
  LIMIT_FIELD_VALUE: 'Upload could not be processed. Please try again.',
  LIMIT_FIELD_COUNT: 'Upload could not be processed. Please try again.',
};
function uploadErrorMessage(err) {
  if (err && err.expose) return err.message;
  if (err instanceof multer.MulterError) return _MULTER_MESSAGES[err.code] || 'Upload could not be processed. Please try again.';
  return 'Upload could not be processed. Please try again.';
}
function withUpload(middleware) {
  return (req, res, next) => middleware(req, res, (err) => {
    if (err) {
      if (!err.expose && !(err instanceof multer.MulterError)) console.error('Portal upload parse error:', err);
      return res.status(400).json({ error: uploadErrorMessage(err) });
    }
    next();
  });
}

// --- GET /portal/me ---
router.get('/me', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, firm_id, first_name, last_name, email, phone,
              filing_status, portal_last_login_at, created_at,
              spouse_name, spouse_email, organizer_visible
       FROM people
       WHERE id = $1 AND firm_id = $2`,
      [req.portal.personId, req.portal.firmId]
    );

    if (!rows[0]) return res.status(404).json({ error: 'Person not found' });
    const person = rows[0];
    const isSpouse = (req.portal.signerRole || 'taxpayer') === 'spouse';

    // When spouse logs in, show their name/email not the primary person's
    const displayFirst = isSpouse ? (person.spouse_name || '').split(' ')[0] || person.first_name : person.first_name;
    const displayLast  = isSpouse ? (person.spouse_name || '').split(' ').slice(1).join(' ') || person.last_name : person.last_name;
    const displayEmail = isSpouse ? (person.spouse_email || person.email) : person.email;

    // Get firm's active tax year
    const firmRes = await pool.query(
      'SELECT active_tax_year FROM firms WHERE id = $1',
      [person.firm_id]
    );
    const activeTaxYear = firmRes.rows[0]?.active_tax_year || '2025';

    res.json({
      id: person.id,
      firstName: displayFirst,
      lastName: displayLast,
      email: displayEmail,
      phone: person.phone,
      filingStatus: person.filing_status,
      lastLogin: person.portal_last_login_at,
      createdAt: person.created_at,
      signerRole: req.portal.signerRole || 'taxpayer',
      activeTaxYear,
      organizerVisible: person.organizer_visible || false,
      // The web portal signs in with an HttpOnly cookie and can't read its token, so it gets
      // its realtime channel and advisor-preview state here instead of decoding the token.
      realtimeChannel: `private-portal-${req.portal.firmId}-${req.portal.personId}`,
      preview: !!req.portal.preview,
      ...(req.portal.preview ? { previewBy: req.portal.previewByName || 'Your advisor' } : {}),
    });
  } catch (err) {
    console.error('Portal /me error:', err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// --- GET /portal/companies ---
router.get('/companies', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.company_name, c.entity_type,
              c.bookkeeping_service,
              (c.realm_id IS NOT NULL AND c.realm_id <> '') AS qbo_connected
       FROM person_company_access pca
       JOIN companies c ON c.id = pca.company_id
       WHERE pca.person_id = $1 AND c.firm_id = $2
       ORDER BY c.company_name ASC`,
      [req.portal.personId, req.portal.firmId]
    );

    res.json(rows);
  } catch (err) {
    console.error('Portal /companies error:', err);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

// --- POST /portal/companies/:id/tax-financials ---
// Client-initiated: pull year-end financials from QBO OR upload P&L + BS PDFs manually.
// Only allowed when bookkeeping_service = 'client_prepared'.
// Two modes:
//   1. QBO mode (multipart with no files, or JSON): requires realm_id on company
//   2. Upload mode (multipart with pl_file + bs_file): saves both PDFs directly
// Accept optional file uploads (pl_file and bs_file)
router.post('/companies/:id/tax-financials', withUpload(upload.fields([{ name: 'pl_file', maxCount: 1 }, { name: 'bs_file', maxCount: 1 }])), async (req, res) => {
  try {
    const personId = req.portal.personId;
    const companyId = parseInt(req.params.id);
    const year = req.body && req.body.year;

    // Verify this person has access to this company
    const { rows: access } = await pool.query(
      'SELECT 1 FROM person_company_access WHERE person_id = $1 AND company_id = $2',
      [personId, companyId]
    );
    if (!access.length) return res.status(403).json({ error: 'No access to this company' });

    // Fetch company details
    const { rows: cos } = await pool.query(
      'SELECT id, company_name, entity_type, bookkeeping_service, realm_id, firm_id, relationship_id FROM companies WHERE id = $1',
      [companyId]
    );
    if (!cos.length) return res.status(404).json({ error: 'Company not found' });
    const company = cos[0];

    // Enforce: only client_prepared companies
    if (company.bookkeeping_service !== 'client_prepared') {
      return res.status(403).json({ error: 'This feature is only available for client-prepared books' });
    }

    const { uploadFile, buildKey } = require('../services/s3');
    const { fireTrigger } = require('../services/pipelineTriggers');

    const firmId = company.firm_id;
    const taxYear = parseInt(year) || new Date().getFullYear() - 1;
    const bucket = process.env.AWS_S3_BUCKET;
    const safeName = (company.company_name || 'company').replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    const plFile = req.files && req.files['pl_file'] && req.files['pl_file'][0];
    const bsFile = req.files && req.files['bs_file'] && req.files['bs_file'][0];
    const isUploadMode = !!(plFile || bsFile);

    let savedDocs = [];

    if (isUploadMode) {
      // ── Upload mode: save P&L and/or BS PDFs directly ──────────────────────
      const filesToSave = [];
      if (plFile) filesToSave.push({ file: plFile, label: 'Profit & Loss', suffix: 'pl' });
      if (bsFile) filesToSave.push({ file: bsFile, label: 'Balance Sheet', suffix: 'bs' });

      for (const { file, label, suffix } of filesToSave) {
        const ext = (file.originalname || 'upload').split('.').pop().toLowerCase() || 'pdf';
        const s3Key = buildKey({
          firmId,
          ownerType: 'company',
          ownerId: company.id,
          filename: `${safeName}-${taxYear}-${suffix}-client-${timestamp}.${ext}`,
        });
        await uploadFile({ firmId: firmId, buffer: file.buffer, key: s3Key, mimeType: file.mimetype || 'application/pdf', bucket });

        const displayName = `${company.company_name || 'Company'} — ${taxYear} ${label} (Client Uploaded)`;
        const { rows: docs } = await pool.query(`
          INSERT INTO documents
            (firm_id, owner_type, owner_id, year, doc_type, display_name,
             s3_key, s3_bucket, mime_type, size_bytes,
             uploaded_by_type, uploaded_by_id,
             folder_section, folder_category, created_at)
          VALUES ($1, 'company', $2, $3, 'financial_statements', $4, $5, $6, $7, $8,
                  'client', $9, 'client_uploaded', 'tax', NOW())
          RETURNING id, display_name, created_at
        `, [firmId, company.id, String(taxYear), displayName, s3Key, bucket, file.mimetype || 'application/pdf', file.size || file.buffer.length, personId]);
        savedDocs.push(docs[0]);
      }

      // Fire trigger once for the batch
      const triggerCtx = {
        document_ids: savedDocs.map(d => d.id),
        tax_year: String(taxYear),
        company_id: company.id,
        submitted_by_person_id: personId,
        upload_mode: true,
      };
      fireTrigger(firmId, 'client_financials_submitted', company.id, triggerCtx, 'company')
        .catch(e => console.error('[portal/tax-financials] fireTrigger non-fatal:', e));

      return res.json({ success: true, documents: savedDocs, uploadMode: true });

    } else {
      // ── QBO mode: pull from QuickBooks and generate PDF ─────────────────────
      if (!company.realm_id) {
        return res.status(400).json({ error: 'QuickBooks not connected for this company' });
      }

      const { generateTaxFinancialsPdf } = require('../services/taxFinancialsPdf');

      const { pdfBuffer, generatedAt } = await generateTaxFinancialsPdf({
        realmId: company.realm_id,
        companyName: company.company_name || 'Company',
        entityType: company.entity_type,
        taxYear,
        firmId,
      });

      const s3Key = buildKey({
        firmId,
        ownerType: 'company',
        ownerId: company.id,
        filename: `${safeName}-${taxYear}-financials-client-${timestamp}.pdf`,
      });
      await uploadFile({ firmId: firmId, buffer: pdfBuffer, key: s3Key, mimeType: 'application/pdf', bucket });

      const displayName = `${company.company_name || 'Company'} — ${taxYear} Year-End Financials (Client Submitted)`;
      const { rows: docs } = await pool.query(`
        INSERT INTO documents
          (firm_id, owner_type, owner_id, year, doc_type, display_name,
           s3_key, s3_bucket, mime_type, size_bytes,
           uploaded_by_type, uploaded_by_id,
           folder_section, folder_category, created_at)
        VALUES ($1, 'company', $2, $3, 'financial_statements', $4, $5, $6, 'application/pdf', $7,
                'client', $8, 'client_uploaded', 'tax', NOW())
        RETURNING id, display_name, created_at
      `, [firmId, company.id, String(taxYear), displayName, s3Key, bucket, pdfBuffer.length, personId]);

      const savedDoc = docs[0];
      const triggerCtx = {
        document_id: savedDoc.id,
        document_name: savedDoc.display_name,
        tax_year: String(taxYear),
        company_id: company.id,
        submitted_by_person_id: personId,
      };
      fireTrigger(firmId, 'client_financials_submitted', company.id, triggerCtx, 'company')
        .catch(e => console.error('[portal/tax-financials] fireTrigger non-fatal:', e));

      return res.json({ success: true, document: savedDoc, generatedAt });
    }
  } catch (err) {
    console.error('[portal/tax-financials] Error:', err);
    res.status(500).json({ error: 'An error occurred. Please try again.' });
  }
});

// --- GET /portal/documents ---
router.get('/documents', async (req, res) => {
  try {
    const personId = req.portal.personId;

    // Get accessible company IDs
    const { rows: accessRows } = await pool.query(
      'SELECT company_id FROM person_company_access WHERE person_id = $1',
      [personId]
    );
    const companyIds = accessRows.map(r => r.company_id);

    let documents = [];
    try {
      let query;
      let params;

      // Show all docs EXCEPT private (staff-only). No is_delivered gate —
      // advisor and client portals share the same document bucket.
      if (companyIds.length > 0) {
        query = `
          SELECT id, owner_type, owner_id, doc_type,
                 display_name, mime_type, size_bytes,
                 delivered_at, viewed_at, year, folder_section, folder_category,
                 document_folder_id, folder_subcategory, created_at
          FROM documents
          WHERE firm_id = $3
            AND folder_section != 'private'
            AND deleted_at IS NULL
            AND (
              (owner_type = 'person' AND owner_id = $1)
              OR (owner_type = 'company' AND owner_id = ANY($2))
            )
          ORDER BY created_at DESC
        `;
        params = [personId, companyIds, req.portal.firmId];
      } else {
        query = `
          SELECT id, owner_type, owner_id, doc_type,
                 display_name, mime_type, size_bytes,
                 delivered_at, viewed_at, year, folder_section, folder_category,
                 document_folder_id, folder_subcategory, created_at
          FROM documents
          WHERE firm_id = $2
            AND folder_section != 'private'
            AND deleted_at IS NULL
            AND owner_type = 'person'
            AND owner_id = $1
          ORDER BY created_at DESC
        `;
        params = [personId, req.portal.firmId];
      }

      const { rows: docs } = await pool.query(query, params);
      documents = docs;
    } catch (e) {
      if (e.code === '42P01') {
        documents = [];
      } else {
        throw e;
      }
    }

    res.json(documents);
  } catch (err) {
    console.error('Portal /documents error:', err);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

// --- GET /portal/document-folders ---
// Clients can read staff-defined folders but cannot create or rename them.
router.get('/document-folders', async (req, res) => {
  const personId = req.portal.personId;
  const firmId = req.portal.firmId;
  try {
    const { rows: accessRows } = await pool.query(
      'SELECT company_id FROM person_company_access WHERE person_id = $1',
      [personId]
    );
    const companyIds = accessRows.map(row => row.company_id);
    const { rows } = await pool.query(
      `SELECT id, scope, applies_to, owner_type, owner_id,
              folder_section, folder_category, name, created_at
         FROM document_folders
        WHERE firm_id = $1
          AND archived_at IS NULL
          AND (
            (scope = 'firm' AND applies_to IN ('all', 'person', 'company'))
            OR (scope = 'client' AND owner_type = 'person' AND owner_id = $2)
            OR (scope = 'client' AND owner_type = 'company' AND owner_id = ANY($3::int[]))
          )
        ORDER BY folder_section, folder_category, LOWER(name)`,
      [firmId, personId, companyIds]
    );
    res.json(rows);
  } catch (err) {
    console.error('Portal /document-folders error:', err);
    res.status(500).json({ error: 'Failed to fetch document folders' });
  }
});

// --- GET /portal/documents/:id/download ---
router.get('/documents/:id/download', async (req, res) => {
  const personId = req.portal.personId;
  const docId = parseInt(req.params.id);

  try {
    const { rows: docRows } = await pool.query(
      `SELECT id, owner_type, owner_id, s3_key, s3_bucket, is_delivered, viewed_at, display_name,
              folder_section FROM documents WHERE id = $1 AND firm_id = $2 AND folder_section != 'private' AND deleted_at IS NULL`,
      [docId, req.portal.firmId]
    );
    if (!docRows[0]) return res.status(404).json({ error: 'Document not found' });

    const doc = docRows[0];

    // Verify access
    let hasAccess = false;

    if (doc.owner_type === 'person' && doc.owner_id === personId) {
      hasAccess = true;
    } else if (doc.owner_type === 'company') {
      const { rows: accessRows } = await pool.query(
        'SELECT 1 FROM person_company_access WHERE person_id = $1 AND company_id = $2',
        [personId, doc.owner_id]
      );
      hasAccess = accessRows.length > 0;
    }

    if (!hasAccess) return res.status(403).json({ error: 'Access denied' });

    // Generate signed URL
    const url = await getSignedDownloadUrl({ key: doc.s3_key, bucket: doc.s3_bucket });

    // Mark viewed_at if first view + log it
    if (!doc.viewed_at && !req.portal.preview) {
      await pool.query('UPDATE documents SET viewed_at = NOW() WHERE id = $1 AND firm_id = $2', [docId, req.portal.firmId]);
      console.log('Client first-viewed document:', doc.display_name);
    }

    res.json({ url });
  } catch (err) {
    console.error('Portal /documents/:id/download error:', err);
    res.status(500).json({ error: 'Failed to generate download URL.' });
  }
});

// --- GET /portal/stanford-tax ---
router.get('/stanford-tax', async (req, res) => {
  const personId = req.portal.personId;

  try {
    // Personal URL
    let personal_url = null;
    try {
      const { rows } = await pool.query(
        'SELECT stanford_tax_url FROM people WHERE id = $1',
        [personId]
      );
      personal_url = rows[0]?.stanford_tax_url || null;
    } catch (e) {
      if (e.code !== '42703') throw e; // 42703 = undefined_column, ignore if col doesn't exist
    }

    // Company URLs
    let companies = [];
    try {
      const { rows } = await pool.query(
        `SELECT c.company_name, c.stanford_tax_url AS url
         FROM person_company_access pca
         JOIN companies c ON c.id = pca.company_id
         WHERE pca.person_id = $1
           AND c.stanford_tax_url IS NOT NULL
           AND c.stanford_tax_url != ''
         ORDER BY c.company_name ASC`,
        [personId]
      );
      companies = rows;
    } catch (e) {
      if (e.code !== '42703') throw e;
    }

    res.json({ personal_url, companies });
  } catch (err) {
    console.error('Portal /stanford-tax error:', err);
    res.status(500).json({ error: 'Failed to fetch organizer links' });
  }
});

// Staff assigned to this client: bookkeeper on one of their businesses, preparer of one of their returns.
async function assignedStaffRoles(personId, firmId) {
  const roles = new Map();
  try {
    const { rows } = await pool.query(
      `SELECT c.bookkeeper_id AS staff_id, 'bookkeeper' AS kind
         FROM person_company_access pca
         JOIN companies c ON c.id = pca.company_id
        WHERE pca.person_id = $1 AND c.firm_id = $2 AND c.bookkeeper_id IS NOT NULL
          AND c.archived_at IS NULL AND COALESCE(c.bookkeeping_service, 'none') <> 'none'
       UNION
       SELECT td.created_by AS staff_id, 'preparer' AS kind
         FROM tax_deliveries td
        WHERE td.firm_id = $2 AND td.created_by IS NOT NULL AND td.status <> 'draft'
          AND (td.id IN (SELECT delivery_id FROM tax_delivery_signers WHERE person_id = $1)
               OR td.company_id IN (SELECT company_id FROM person_company_access WHERE person_id = $1))`,
      [personId, firmId]
    );
    for (const r of rows) {
      const list = roles.get(r.staff_id) || [];
      list.push(r.kind);
      roles.set(r.staff_id, list);
    }
  } catch (e) {
    console.error('Portal assigned staff lookup failed:', e.message);
  }
  return roles;
}

function staffRoleLabel(kinds, firmRole) {
  if (kinds && kinds.includes('preparer') && kinds.includes('bookkeeper')) return 'Your tax preparer and bookkeeper';
  if (kinds && kinds.includes('preparer')) return 'Your tax preparer';
  if (kinds && kinds.includes('bookkeeper')) return 'Your bookkeeper';
  return firmRole === 'owner' ? 'Partner' : '';
}

// --- GET /portal/messages --- staff this client works with (has a conversation with, or is assigned to them), with thread info
router.get('/messages', async (req, res) => {
  const personId = req.portal.personId;
  const firmId = req.portal.firmId;
  const bucket = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET || 'darklion-docs';
  const rawSearch = String(req.query.search || req.query.q || '').trim();
  const search = rawSearch.slice(0, 120);

  try {
    const staffParams = [firmId];
    let searchStaffFilter = '';
    if (search) {
      staffParams.push(personId, `%${search}%`);
      searchStaffFilter = `
        AND EXISTS (
          SELECT 1
          FROM message_threads mt_search
          JOIN messages m_search ON m_search.thread_id = mt_search.id
          WHERE mt_search.person_id = $2
            AND mt_search.firm_id = $1
            AND mt_search.staff_user_id = firm_users.id
            AND m_search.is_internal = false AND m_search.removed_at IS NULL
            AND m_search.body ILIKE $3
        )`;
    }

    // Active staff who have accepted their invite (pending invitees are never shown to clients)
    const { rows: allStaffRows } = await pool.query(
      `SELECT id, COALESCE(NULLIF(display_name, ''), NULLIF(name, ''), 'Advisor') as name, avatar_url, credentials, role
       FROM firm_users
       WHERE firm_id = $1 AND archived_at IS NULL AND accepted_at IS NOT NULL
       ${searchStaffFilter}
       ORDER BY COALESCE(NULLIF(display_name, ''), NULLIF(name, ''), 'Advisor')`,
      staffParams
    );

    // Get threads for this person (one per staff member)
    const threadParams = [personId, firmId];
    let threadSearchFilter = '';
    if (search) {
      threadParams.push(`%${search}%`);
      threadSearchFilter = `
        AND EXISTS (
          SELECT 1
          FROM messages m_match
          WHERE m_match.thread_id = mt.id AND m_match.removed_at IS NULL
            AND m_match.is_internal = false
            AND m_match.body ILIKE $3
        )`;
    }
    const { rows: threadRows } = await pool.query(
      `SELECT mt.id, mt.staff_user_id, mt.status, mt.last_message_at,
         EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = mt.id AND m.is_internal = false) as has_messages,
         (SELECT body FROM messages m WHERE m.thread_id = mt.id AND m.removed_at IS NULL AND m.is_internal = false ORDER BY m.created_at DESC LIMIT 1) as last_body,
         (SELECT COUNT(*) FROM messages m WHERE m.thread_id = mt.id AND m.removed_at IS NULL AND m.sender_type = 'staff' AND m.is_internal = false AND m.read_at IS NULL) as unread_count
       FROM message_threads mt
       WHERE mt.person_id = $1 AND mt.firm_id = $2
         AND mt.category IS DISTINCT FROM 'internal'
       ${threadSearchFilter}
       ORDER BY mt.last_message_at DESC NULLS LAST`,
      threadParams
    );

    // Build a map staffUserId -> thread
    const threadMap = {};
    const talkedWith = new Set();
    for (const t of threadRows) {
      if (t.staff_user_id && !threadMap[t.staff_user_id]) threadMap[t.staff_user_id] = t;
      if (t.staff_user_id && t.has_messages) talkedWith.add(t.staff_user_id);
    }

    const preferences = await require('../services/firmPreferences').getFirmPreferences(firmId);
    const assigned = await assignedStaffRoles(personId, firmId);
    // Clients see the people they work with: anyone they already have a conversation with, plus their assigned team.
    // A client with neither still gets a way in: the firm's configured contact order, else the owners, else everyone.
    let staffRows = search ? allStaffRows : allStaffRows.filter(s => talkedWith.has(s.id) || assigned.has(s.id));
    if (!staffRows.length && !search) {
      const configured = allStaffRows.filter(s => preferences.staffContactOrder.includes(s.id));
      const owners = allStaffRows.filter(s => s.role === 'owner');
      staffRows = configured.length ? configured : owners.length ? owners : allStaffRows;
    }
    const rank = s => { const idRank=preferences.staffContactOrder.indexOf(s.id); if(idRank>=0)return idRank;
      const nameRank=preferences.legacyStaffNames.indexOf(String(s.name||'').toLowerCase());return nameRank>=0?nameRank:1000; };
    staffRows.sort((a,b)=>rank(a)-rank(b)||String(a.name).localeCompare(String(b.name)));

    // Sign avatar URLs and merge with thread data
    const result = await Promise.all(staffRows.map(async (s) => {
      let avatar_url = null;
      if (s.avatar_url) {
        try { avatar_url = await signStaffAvatar(s.avatar_url, bucket); } catch(e) { /* non-fatal */ }
      }
      const thread = threadMap[s.id];
      return {
        id: s.id,
        name: s.name,
        avatar_url,
        credentials: s.credentials || '',
        roleLabel: staffRoleLabel(assigned.get(s.id), s.role),
        threadId: thread ? thread.id : null,
        lastMessageAt: thread ? thread.last_message_at : null,
        lastPreview: thread && thread.last_body ? messagePreview(thread.last_body) : '',
        unreadCount: thread ? (parseInt(thread.unread_count, 10) || 0) : 0,
      };
    }));

    res.json(result);
  } catch (err) {
    if (err.code === '42P01') return res.json([]);
    console.error('Portal /messages error:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// --- GET /portal/team --- staff who have messaged this client, with signed avatar URLs
router.get('/team', async (req, res) => {
  const personId = req.portal.personId;
  const firmId = req.portal.firmId;
  const bucket = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET || 'darklion-docs';
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT fu.id, COALESCE(NULLIF(fu.display_name, ''), NULLIF(fu.name, ''), 'Advisor') AS name, fu.avatar_url, fu.credentials
       FROM messages m
       JOIN message_threads mt ON mt.id = m.thread_id
       JOIN firm_users fu ON fu.id = m.sender_id AND fu.firm_id = mt.firm_id
       WHERE mt.person_id = $1 AND mt.firm_id = $2
         AND m.sender_type = 'staff' AND m.is_internal = false AND m.removed_at IS NULL
         AND fu.archived_at IS NULL AND fu.accepted_at IS NOT NULL`,
      [personId, firmId]
    );
    const result = await Promise.all(rows.map(async (member) => {
      let avatar_url = null;
      if (member.avatar_url) {
        try { avatar_url = await signStaffAvatar(member.avatar_url, bucket); } catch(e) { /* non-fatal */ }
      }
      return { id: member.id, name: member.name, credentials: member.credentials || '', avatar_url };
    }));
    res.json(result);
  } catch (err) {
    if (err.code === '42P01') return res.json([]);
    console.error('Portal /team error:', err);
    res.status(500).json({ error: 'Failed to fetch team' });
  }
});

// --- GET /portal/firm-team --- up to 5 staff, priority: owner → messaged this client → others
router.get('/firm-team', async (req, res) => {
  const firmId = req.portal.firmId;
  const personId = req.portal.personId;
  const bucket = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET || 'darklion-docs';
  try {
    // All active firm staff, left-joined with message counts for this client.
    // Owner(s) first (sort_order = 1), then everyone else sorted by message count desc.
    // Staff who've never messaged this client are still included (count = 0).
    const { rows: rawRows } = await pool.query(
      `SELECT fu.id,
              COALESCE(NULLIF(fu.display_name, ''), NULLIF(fu.name, ''), 'Advisor') AS name,
              fu.avatar_url, fu.credentials, fu.role,
              COALESCE(msg_counts.msg_count, 0) AS sort_order,
              CASE WHEN fu.role = 'owner' THEN 0 ELSE 1 END AS role_order
       FROM firm_users fu
       LEFT JOIN (
         SELECT m.sender_id, COUNT(m.id) AS msg_count
         FROM messages m
         JOIN message_threads mt ON mt.id = m.thread_id
         WHERE mt.person_id = $2 AND mt.firm_id=$1 AND m.sender_type = 'staff' AND m.is_internal = false AND m.removed_at IS NULL
         GROUP BY m.sender_id
       ) msg_counts ON msg_counts.sender_id = fu.id
       WHERE fu.firm_id = $1 AND fu.archived_at IS NULL AND fu.accepted_at IS NOT NULL
       ORDER BY role_order ASC, sort_order DESC
       LIMIT 5`,
      [firmId, personId]
    );
    const merged = rawRows;

    const result = await Promise.all(merged.map(async (member) => {
      let avatar_url = null;
      if (member.avatar_url) {
        try { avatar_url = await signStaffAvatar(member.avatar_url, bucket); } catch(e) { /* non-fatal */ }
      }
      return { id: member.id, name: member.name, credentials: member.credentials || '', role: member.role, avatar_url };
    }));
    res.json(result);
  } catch (err) {
    if (err.code === '42P01') return res.json([]);
    console.error('Portal /firm-team error:', err);
    res.status(500).json({ error: 'Failed to fetch firm team' });
  }
});

// --- GET /portal/messages/staff-contacts --- KEPT FOR BACKWARD COMPAT (redirects to /messages)
router.get('/messages/staff-contacts', async (req, res) => {
  // Redirect callers to the new /messages endpoint which returns staff list
  res.redirect(307, '/portal/messages');
});

// --- GET /portal/messages/thread/:staffUserId --- messages for the thread with this staff member
router.get('/messages/thread/:staffUserId', async (req, res) => {
  const personId = req.portal.personId;
  const firmId = req.portal.firmId;
  const staffUserId = parseInt(req.params.staffUserId);

  try {
    // Find the permanent thread for this person + staff pair. Advisor-side
    // archive only hides staff surfaces; it must not hide the portal stream.
    const { rows: threadRows } = await pool.query(
      `SELECT id FROM message_threads
       WHERE person_id = $1 AND staff_user_id = $2 AND firm_id = $3
         AND category IS DISTINCT FROM 'internal'
       ORDER BY last_message_at DESC NULLS LAST
       LIMIT 1`,
      [personId, staffUserId, firmId]
    );

    if (!threadRows[0]) {
      return res.json({ threadId: null, messages: [] });
    }

    const threadId = threadRows[0].id;

    // Fetch non-internal messages
    const { rows: msgs } = await pool.query(
      `SELECT m.id, m.sender_type, m.body, m.created_at, m.read_at,
              CASE WHEN m.sender_type = 'staff' THEN COALESCE(NULLIF(fu.display_name, ''), NULLIF(fu.name, ''), 'Advisor') ELSE NULL END AS sender_name
       FROM messages m
       LEFT JOIN firm_users fu ON fu.id = m.sender_id AND m.sender_type = 'staff'
       WHERE m.thread_id = $1 AND m.is_internal = false AND m.removed_at IS NULL
       ORDER BY m.created_at ASC`,
      [threadId]
    );

    // The web portal sends ?markRead=0 and marks read with POST .../read once the thread is on screen.
    // Installed iPhone app builds still rely on this fetch marking the thread read, so the default stays.
    // Never during advisor preview.
    if (!req.portal.preview && String(req.query.markRead) !== '0') await markThreadRead(threadId);

    // Fetch attachments
    const msgIds = msgs.map(m => m.id);
    const attachmentMap = {};
    if (msgIds.length > 0) {
      const { rows: attRows } = await pool.query(
        `SELECT ma.message_id, ma.id, d.display_name, d.mime_type, d.size_bytes, ma.document_id
         FROM message_attachments ma
         JOIN documents d ON d.id = ma.document_id
         WHERE ma.message_id = ANY($1)`,
        [msgIds]
      );
      for (const att of attRows) {
        if (!attachmentMap[att.message_id]) attachmentMap[att.message_id] = [];
        attachmentMap[att.message_id].push({
          id: att.id,
          documentId: att.document_id,
          displayName: att.display_name,
          mimeType: att.mime_type,
          sizeBytes: att.size_bytes,
        });
      }
    }

    res.json({
      threadId,
      messages: msgs.map(m => ({ ...m, attachments: attachmentMap[m.id] || [] })),
    });
  } catch (err) {
    if (err.code === '42P01') return res.json({ threadId: null, messages: [] });
    console.error('Portal /messages/thread/:staffUserId error:', err);
    res.status(500).json({ error: 'Failed to fetch thread' });
  }
});

// --- POST /portal/messages/thread/:staffUserId/read --- the client has seen this thread on screen
// Body: { upToMessageId } (optional) — only messages up to the newest one shown are marked read.
router.post('/messages/thread/:staffUserId/read', async (req, res) => {
  const staffUserId = Number(req.params.staffUserId);
  const rawUpTo = req.body && req.body.upToMessageId;
  const upToMessageId = rawUpTo == null || rawUpTo === '' ? null : Number(rawUpTo);
  if (!Number.isSafeInteger(staffUserId) || staffUserId < 1 || (upToMessageId !== null && (!Number.isSafeInteger(upToMessageId) || upToMessageId < 1))) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  // Advisor preview never changes what the client has read.
  if (req.portal.preview) return res.json({ ok: true, marked: 0 });
  try {
    const { rows } = await pool.query(
      `SELECT id FROM message_threads
       WHERE person_id = $1 AND staff_user_id = $2 AND firm_id = $3
         AND category IS DISTINCT FROM 'internal'
       ORDER BY last_message_at DESC NULLS LAST
       LIMIT 1`,
      [req.portal.personId, staffUserId, req.portal.firmId]
    );
    if (!rows[0]) return res.json({ ok: true, marked: 0 });
    const marked = await markThreadRead(rows[0].id, upToMessageId);
    res.json({ ok: true, marked });
  } catch (err) {
    if (err.code === '42P01') return res.json({ ok: true, marked: 0 });
    console.error('Portal /messages/thread/:staffUserId/read error:', err);
    res.status(500).json({ error: 'Failed to update messages' });
  }
});

// --- GET /portal/messages/:threadId --- full thread by threadId (legacy, kept for compat; does not mark read)
router.get('/messages/:threadId', async (req, res) => {
  const personId = req.portal.personId;
  const threadId = parseInt(req.params.threadId);

  try {
    const { rows: threadRows } = await pool.query(
      'SELECT id, subject, status, last_message_at, created_at FROM message_threads WHERE id = $1 AND person_id = $2 AND firm_id = $3',
      [threadId, personId, req.portal.firmId]
    );
    if (!threadRows[0]) return res.status(404).json({ error: 'Thread not found' });

    const { rows: msgs } = await pool.query(
      `SELECT m.id, m.sender_type, m.body, m.created_at, m.read_at,
              CASE WHEN m.sender_type = 'staff' THEN COALESCE(NULLIF(fu.display_name, ''), NULLIF(fu.name, ''), 'Advisor') ELSE NULL END AS sender_name
       FROM messages m
       LEFT JOIN firm_users fu ON fu.id = m.sender_id AND m.sender_type = 'staff'
       WHERE m.thread_id = $1 AND m.is_internal = false AND m.removed_at IS NULL
       ORDER BY m.created_at ASC`,
      [threadId]
    );

    const msgIds = msgs.map(m => m.id);
    const attachmentMap = {};
    if (msgIds.length > 0) {
      const { rows: attRows } = await pool.query(
        `SELECT ma.message_id, ma.id, d.display_name, d.mime_type, d.size_bytes, ma.document_id
         FROM message_attachments ma
         JOIN documents d ON d.id = ma.document_id
         WHERE ma.message_id = ANY($1)`,
        [msgIds]
      );
      for (const att of attRows) {
        if (!attachmentMap[att.message_id]) attachmentMap[att.message_id] = [];
        attachmentMap[att.message_id].push({
          id: att.id,
          documentId: att.document_id,
          displayName: att.display_name,
          mimeType: att.mime_type,
          sizeBytes: att.size_bytes,
        });
      }
    }

    res.json({
      thread: threadRows[0],
      messages: msgs.map(m => ({ ...m, attachments: attachmentMap[m.id] || [] })),
    });
  } catch (err) {
    console.error('Portal /messages/:threadId error:', err);
    res.status(500).json({ error: 'Failed to fetch thread' });
  }
});

// --- POST /portal/messages/send ---
router.post('/messages/send', withUpload(upload.array('files', 8)), async (req, res) => {
  const personId = req.portal.personId;
  const firmId = req.portal.firmId;
  const body = (req.body.body || '').trim();
  const files = req.files || [];
  const staffUserId = req.body.staff_user_id ? parseInt(req.body.staff_user_id) : null;

  if (!body && files.length === 0) {
    return res.status(400).json({ error: 'Message body or at least one file is required' });
  }

  if (!staffUserId) {
    return res.status(400).json({ error: 'staff_user_id is required' });
  }

  try {
    // Validate staff_user_id belongs to this firm
    const { rows: staffCheck } = await pool.query(
      'SELECT id FROM firm_users WHERE id = $1 AND firm_id = $2',
      [staffUserId, firmId]
    );
    if (!staffCheck[0]) return res.status(404).json({ error: 'Staff member not found' });

    // Find or create the permanent stream for this person + staff pair.
    // Advisor-side archive only hides the staff inbox; it must not fork or
    // remove the client's portal conversation.
    const { rows: existingRows } = await pool.query(
      `SELECT id FROM message_threads
       WHERE person_id = $1 AND staff_user_id = $2 AND firm_id = $3
         AND category IS DISTINCT FROM 'internal'
       ORDER BY last_message_at DESC NULLS LAST
       LIMIT 1`,
      [personId, staffUserId, firmId]
    );

    let threadId;
    let isNewThread = false;

    if (existingRows.length > 0) {
      threadId = existingRows[0].id;
    } else {
      // Create new thread for this person + staff pair
      const { rows } = await pool.query(
        `INSERT INTO message_threads (firm_id, person_id, staff_user_id, subject, status, last_message_at)
         VALUES ($1, $2, $3, $4, 'open', NOW())
         RETURNING id`,
        [firmId, personId, staffUserId, 'Client message']
      );
      threadId = rows[0].id;
      isNewThread = true;
    }

    // Insert message
    const { rows: msgRows } = await pool.query(
      `INSERT INTO messages (thread_id, sender_type, sender_id, body, is_internal)
       VALUES ($1, 'client', $2, $3, false)
       RETURNING id`,
      [threadId, personId, body || '']
    );
    const messageId = msgRows[0].id;

    // Upload files
    if (files.length > 0) {
      const bucket = process.env.AWS_S3_BUCKET || 'darklion-s3';
      const year = String(new Date().getFullYear());
      for (const f of files) {
        const key = buildKey({
          firmId,
          ownerType: 'person',
          ownerId: personId,
          year,
          docType: 'message_docs',
          filename: f.originalname,
        });
        await uploadFile({ firmId: firmId, buffer: f.buffer, key, mimeType: f.mimetype, bucket });
        const { rows: docRows } = await pool.query(
          `INSERT INTO documents (firm_id, owner_type, owner_id, doc_type, display_name, mime_type, size_bytes,
            s3_key, s3_bucket, year, folder_section, folder_category, uploaded_by_type, uploaded_by_id,
            is_delivered, created_at)
           VALUES ($1, 'person', $2, 'other', $3, $4, $5, $6, $7, $8, 'client_uploaded', 'message_docs', 'client', $2, false, NOW())
           RETURNING id`,
          [firmId, personId, f.originalname, f.mimetype, f.size, key, bucket, year]
        );
        await pool.query(
          'INSERT INTO message_attachments (message_id, document_id) VALUES ($1, $2)',
          [messageId, docRows[0].id]
        );
      }
    }

    // Flip thread status to 'open' and unhide it from the advisor inbox.
    await pool.query(
      `UPDATE message_threads SET status = 'open', staff_archived_at = NULL, last_message_at = NOW() WHERE id = $1`,
      [threadId]
    );

    await archiveClientMessageCreatedFailClosed({ firmId, messageId });

    cancelPendingNotification(personId);

    const pusher = req.app.get('pusher');
    if (pusher) {
      pusher.trigger(`private-firm-${firmId}`, 'message-new', { threadId, senderType: 'client' });
    }

    setImmediate(() => {
      sendStaffMobilePush({
        firmId,
        staffUserId,
        type: 'client_message',
        title: 'New client message',
        body: body || 'A client sent a new secure message.',
        data: { threadId, messageId, personId },
      }).catch(e => console.error('[mobile-push] staff client-message non-fatal:', e.message));
    });

    // Queue native Emma draft generation for the assigned staff user (non-blocking — never delays client response)
    if (body && body.trim()) {
      setImmediate(() => {
        const { enqueueEmmaDraftJob } = require('../services/emmaDraftJobs');
        enqueueEmmaDraftJob({
          firmId,
          threadId,
          sourceMessageId: messageId,
          personId,
          staffUserId,
          sourceEvent: 'inbox.message.received',
          priority: 3,
        }).catch(e => console.error('[emma-draft] enqueue inbox draft non-fatal:', e.message));
      });
    }

    if (isNewThread && body) {
      setImmediate(async () => {
        try {
          const result = await classifyMessage({ body, personId, firmId });
          if (result.category) {
            await pool.query('UPDATE message_threads SET category = $1 WHERE id = $2', [result.category, threadId]);
          }
          for (const c of (result.companies || [])) {
            await pool.query(
              `INSERT INTO thread_companies (thread_id, company_id, ai_confidence, added_by)
               VALUES ($1, $2, $3, 'ai') ON CONFLICT (thread_id, company_id) DO NOTHING`,
              [threadId, c.id, c.confidence]
            );
          }
        } catch (e) {
          console.error('[portal send] classification error (non-fatal):', e.message);
        }
      });
    }

    // Fire smart pipeline trigger (non-blocking)
    fireTrigger(firmId, 'portal_message_received', personId, {
      thread_id: threadId,
      message_id: messageId,
    }).catch(e => console.error('[portal] fireTrigger portal_message_received non-fatal:', e));

    res.json({ ok: true, threadId });
  } catch (err) {
    if (err.code === '42P01') {
      return res.status(503).json({ error: 'Messaging is not yet available' });
    }
    console.error('Portal /messages/send error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// --- GET /portal/attachments/:documentId/download ---
router.get('/attachments/:documentId/download', async (req, res) => {
  const personId = req.portal.personId;
  const documentId = parseInt(req.params.documentId);

  try {
    const { rows } = await pool.query(
      "SELECT id, s3_key, s3_bucket, owner_type, owner_id FROM documents WHERE id = $1 AND firm_id = $2 AND folder_section != 'private' AND deleted_at IS NULL",
      [documentId, req.portal.firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Document not found' });
    const doc = rows[0];

    // Verify access: must belong to this person directly, or to a company the person has access to
    let hasAccess = false;
    if (doc.owner_type === 'person' && doc.owner_id === personId) {
      hasAccess = true;
    } else if (doc.owner_type === 'company') {
      const { rows: accessRows } = await pool.query(
        'SELECT 1 FROM person_company_access WHERE person_id = $1 AND company_id = $2',
        [personId, doc.owner_id]
      );
      hasAccess = accessRows.length > 0;
    }
    if (!hasAccess) return res.status(403).json({ error: 'Access denied' });

    const url = await getSignedDownloadUrl({ key: doc.s3_key, bucket: doc.s3_bucket });
    res.json({ url });
  } catch (err) {
    console.error('Portal /attachments/:documentId/download error:', err);
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
});

// ── TAX DELIVERY PORTAL ENDPOINTS ────────────────────────────────────────

// ── Helper: strip internal QA keys from tax report data before it reaches a client ──
// Keep in sync with the copy in portal-mobile.js.
const INTERNAL_TAX_REPORT_KEYS = ['verified_facts', 'verified_fact_status', 'verified_fact_missing', 'core_fact_reconciliation_issues'];
function sanitizeTaxReportData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data || null;
  const clean = { ...data };
  for (const key of INTERNAL_TAX_REPORT_KEYS) delete clean[key];
  return clean;
}

// ── Helper: verify signer access ─────────────────────────────────────────
async function getSignerForDelivery(deliveryId, personId, signerRole) {
  const { rows } = await pool.query(
    `SELECT * FROM tax_delivery_signers WHERE delivery_id = $1 AND person_id = $2
     AND signer_role = $3 LIMIT 1`,
    [deliveryId, personId, signerRole || 'taxpayer']
  );
  return rows[0] || null;
}

// --- GET /portal/tax-deliveries ---
router.get('/tax-deliveries', async (req, res) => {
  const personId = req.portal.personId;
  try {
    // Show deliveries where:
    // 1. This person is a named signer, OR
    // 2. This person has portal access to the company the delivery belongs to
    // In both cases, show their own signer row if it exists (for approve/sign actions),
    // otherwise show null signer fields (view-only for company-access members)
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (td.id)
              td.id, td.title, td.tax_year, td.status, td.intro_note, td.tax_summary,
              co.company_name,
              tds.approved_at, tds.signed_at, tds.needs_changes_at, tds.needs_changes_note
       FROM tax_deliveries td
       LEFT JOIN companies co ON co.id = td.company_id
       LEFT JOIN tax_delivery_signers tds ON tds.delivery_id = td.id AND tds.person_id = $1 AND tds.signer_role = $2
       WHERE td.status IN ('sent','approved','needs_changes','signed')
         AND (
           EXISTS (SELECT 1 FROM tax_delivery_signers WHERE delivery_id = td.id AND person_id = $1)
           OR td.company_id IN (
             SELECT company_id FROM person_company_access WHERE person_id = $1
           )
         )
       ORDER BY td.id, td.created_at DESC`,
      [personId, req.portal.signerRole || 'taxpayer']
    );
    res.json(rows);
  } catch (err) {
    console.error('[portal] GET /tax-deliveries error:', err);
    res.status(500).json({ error: 'Failed to fetch tax deliveries' });
  }
});

// --- GET /portal/tax-status --- one tax-season view shared by the web portal and the iPhone app
router.get('/tax-status', async (req, res) => {
  try {
    const status = await buildClientTaxStatus({
      firmId: req.portal.firmId,
      personId: req.portal.personId,
      signerRole: req.portal.signerRole || 'taxpayer',
    });
    if (!status) return res.status(404).json({ error: 'Person not found' });
    res.json(status);
  } catch (err) {
    console.error('[portal] GET /tax-status error:', err);
    res.status(500).json({ error: 'Failed to load tax status' });
  }
});

// --- GET /portal/tax-deliveries/:id/summary ---
router.get('/tax-deliveries/:id/summary', async (req, res) => {
  const personId = req.portal.personId;
  const id = parseInt(req.params.id);
  try {
    const signer = await getSignerForDelivery(id, personId, req.portal.signerRole);
    if (!signer) return res.status(403).json({ error: 'Access denied' });
    const { rows } = await pool.query(
      'SELECT tax_report_data, tax_report_status FROM tax_deliveries WHERE id = $1 AND firm_id = $2',
      [id, req.portal.firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ status: rows[0].tax_report_status || 'none', data: sanitizeTaxReportData(rows[0].tax_report_data) });
  } catch (err) {
    console.error('[portal] GET /tax-deliveries/:id/summary error:', err);
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

// --- GET /portal/tax-deliveries/:id/download-review ---
router.get('/tax-deliveries/:id/download-review', async (req, res) => {
  const personId = req.portal.personId;
  const id = parseInt(req.params.id);
  try {
    const signer = await getSignerForDelivery(id, personId, req.portal.signerRole);
    if (!signer) return res.status(403).json({ error: 'Access denied' });

    const { rows } = await pool.query(
      `SELECT d.s3_key, d.s3_bucket FROM tax_deliveries td
       JOIN documents d ON d.id = td.review_doc_id
       WHERE td.id = $1`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Review document not found' });

    const url = await getSignedDownloadUrl({ key: rows[0].s3_key, bucket: rows[0].s3_bucket });
    res.json({ url });
  } catch (err) {
    console.error('[portal] GET /tax-deliveries/:id/download-review error:', err);
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
});

// --- GET /portal/tax-deliveries/:id/download-signature ---
router.get('/tax-deliveries/:id/download-signature', async (req, res) => {
  const personId = req.portal.personId;
  const id = parseInt(req.params.id);
  try {
    const signer = await getSignerForDelivery(id, personId, req.portal.signerRole);
    if (!signer) return res.status(403).json({ error: 'Access denied' });

    const { rows } = await pool.query(
      `SELECT d.s3_key, d.s3_bucket FROM tax_deliveries td
       JOIN documents d ON d.id = td.signature_doc_id
       WHERE td.id = $1`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Signature document not found' });

    const url = await getSignedDownloadUrl({ key: rows[0].s3_key, bucket: rows[0].s3_bucket });
    res.json({ url });
  } catch (err) {
    console.error('[portal] GET /tax-deliveries/:id/download-signature error:', err);
    res.status(500).json({ error: 'Failed to generate download URL' });
  }
});

// --- POST /portal/tax-deliveries/:id/approve ---
router.post('/tax-deliveries/:id/approve', async (req, res) => {
  const personId = req.portal.personId;
  const id = parseInt(req.params.id);
  try {
    const signer = await getSignerForDelivery(id, personId, req.portal.signerRole);
    if (!signer) return res.status(403).json({ error: 'Access denied' });

    await pool.query(
      `UPDATE tax_delivery_signers SET approved_at = NOW(), approved_ip = $1
       WHERE delivery_id = $2 AND person_id = $3 AND signer_role = $4`,
      [req.ip, id, personId, signer.signer_role]
    );

    await pool.query(
      'UPDATE people SET portal_last_login_at = NOW() WHERE id = $1',
      [personId]
    );

    // Check if ALL signers have now approved
    const { rows: allSigners } = await pool.query(
      'SELECT approved_at FROM tax_delivery_signers WHERE delivery_id = $1',
      [id]
    );
    const allApproved = allSigners.every(s => s.approved_at);
    if (allApproved) {
      await pool.query(
        "UPDATE tax_deliveries SET status = 'approved', updated_at = NOW() WHERE id = $1",
        [id]
      );
      const { rows: deliveryRows } = await pool.query(
        `SELECT td.firm_id, td.tax_year, td.company_id,
                p.first_name, p.last_name
         FROM tax_deliveries td
         LEFT JOIN tax_delivery_signers tds ON tds.delivery_id = td.id AND tds.signer_role = 'taxpayer'
         LEFT JOIN people p ON p.id = tds.person_id
         WHERE td.id = $1`,
        [id]
      );
      const d = deliveryRows[0];
      if (d) {
        const clientName = `${d.first_name || ''} ${d.last_name || ''}`.trim();
        recordActivityEvent({
          firmId: d.firm_id,
          eventType: 'tax_return_approved',
          title: `${d.tax_year} tax return approved`,
          summary: `${clientName || 'Client'} approved the ${d.tax_year} tax return.`,
          personId,
          companyId: d.company_id || null,
          taxYear: d.tax_year,
          entityType: d.company_id ? 'company' : 'person',
          entityId: d.company_id || personId,
          sourceTable: 'tax_deliveries',
          sourceId: String(id),
          dedupeKey: `tax_return_approved:${id}`,
          metadata: { delivery_id: id, all_approved: true },
        });
      }
      console.log(`[tax-delivery] All signers approved delivery ${id} — status → approved`);
    }

    res.json({ ok: true, allApproved });
  } catch (err) {
    console.error('[portal] POST /tax-deliveries/:id/approve error:', err);
    res.status(500).json({ error: 'Failed to approve delivery' });
  }
});

// --- POST /portal/tax-deliveries/:id/needs-changes ---
router.post('/tax-deliveries/:id/needs-changes', async (req, res) => {
  const personId = req.portal.personId;
  const id = parseInt(req.params.id);
  const { note } = req.body;
  if (!note) return res.status(400).json({ error: 'note is required' });

  try {
    const signer = await getSignerForDelivery(id, personId, req.portal.signerRole);
    if (!signer) return res.status(403).json({ error: 'Access denied' });

    await pool.query(
      `UPDATE tax_delivery_signers SET needs_changes_at = NOW(), needs_changes_note = $1
       WHERE delivery_id = $2 AND person_id = $3 AND signer_role = $4`,
      [note, id, personId, signer.signer_role]
    );

    await pool.query(
      "UPDATE tax_deliveries SET status = 'needs_changes', needs_changes_note = $1, updated_at = NOW() WHERE id = $2",
      [note, id]
    );

    // Fetch delivery and person info for notification
    const { rows: deliveryRows } = await pool.query(
      `SELECT td.tax_year, td.firm_id, co.company_name,
              p.first_name, p.last_name,
              f.email AS firm_email, f.name AS firm_name
       FROM tax_deliveries td
       LEFT JOIN companies co ON co.id = td.company_id
       JOIN people p ON p.id = $2
       JOIN firms f ON f.id = td.firm_id
       WHERE td.id = $1`,
      [id, personId]
    );
    if (deliveryRows[0]) {
      const d = deliveryRows[0];
      const clientName = `${d.first_name} ${d.last_name}`.trim();
      const entityLabel = d.company_name || clientName;

      // Firm is notified via staff message thread (below) — no separate email

      // Create a staff message thread so it appears in team inbox
      try {
        const subject = `⚠️ Changes Requested: ${clientName} — ${d.tax_year} Tax Return`;
        const body = `${clientName} has requested changes to their ${d.tax_year} tax return.\n\n"${note}"\n\nGo to the Tax tab on their record to review and resend.`;
        const { rows: threadRows } = await pool.query(
          `INSERT INTO message_threads (firm_id, person_id, subject, status, category, last_message_at)
           VALUES ($1, $2, $3, 'open', 'tax', NOW()) RETURNING id`,
          [d.firm_id, personId, subject]
        );
        if (threadRows[0]) {
          const { rows: messageRows } = await pool.query(
            `INSERT INTO messages (thread_id, sender_type, sender_id, body, is_internal)
             VALUES ($1, 'client', $2, $3, false)
             RETURNING id`,
            [threadRows[0].id, personId, body]
          );
          await archiveClientMessageCreatedFailClosed({ firmId: d.firm_id, messageId: messageRows[0].id });
        }
      } catch (msgErr) {
        console.error('[portal] needs-changes message thread error:', msgErr);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[portal] POST /tax-deliveries/:id/needs-changes error:', err);
    res.status(500).json({ error: 'Failed to submit changes request' });
  }
});

// --- POST /portal/tax-deliveries/:id/sign ---
router.post('/tax-deliveries/:id/sign', async (req, res) => {
  const personId = req.portal.personId;
  const id = parseInt(req.params.id);
  const { signature_data, signature_type = 'drawn' } = req.body;
  if (!signature_data) return res.status(400).json({ error: 'signature_data is required' });

  try {
    const signer = await getSignerForDelivery(id, personId, req.portal.signerRole);
    if (!signer) return res.status(403).json({ error: 'Access denied' });
    if (!signer.approved_at) return res.status(400).json({ error: 'You must approve the return before signing' });
    if (signer.signed_at) {
      const { rows: existingSigners } = await pool.query(
        'SELECT signed_at FROM tax_delivery_signers WHERE delivery_id = $1',
        [id]
      );
      return res.json({ ok: true, allSigned: existingSigners.every(s => s.signed_at), alreadySigned: true });
    }

    await pool.query(
      `UPDATE tax_delivery_signers SET
         signed_at = NOW(), signed_ip = $1, signature_data = $2, signature_type = $3
       WHERE delivery_id = $4 AND person_id = $5 AND signer_role = $6`,
      [req.ip, signature_data, signature_type, id, personId, signer.signer_role]
    );

    // Signed PDF is generated only when ALL signers have signed (see below)

    // Check if ALL signers have now signed
    const { rows: allSigners } = await pool.query(
      'SELECT signed_at, person_id, signer_role, signature_data, signature_type, signed_ip FROM tax_delivery_signers WHERE delivery_id = $1',
      [id]
    );
    const allSigned = allSigners.every(s => s.signed_at);

    if (allSigned) {
      await pool.query(
        "UPDATE tax_deliveries SET status = 'signed', updated_at = NOW() WHERE id = $1",
        [id]
      );

      // Fetch delivery info — get person via taxpayer signer row (td has no person_id column)
      const { rows: deliveryRows } = await pool.query(
        `SELECT td.*, co.company_name, f.email AS firm_email, f.name AS firm_name,
                p.first_name, p.last_name, p.email AS person_email,
                p.spouse_name, p.spouse_email
         FROM tax_deliveries td
         LEFT JOIN companies co ON co.id = td.company_id
         JOIN firms f ON f.id = td.firm_id
         LEFT JOIN tax_delivery_signers tds_p ON tds_p.delivery_id = td.id AND tds_p.signer_role = 'taxpayer'
         LEFT JOIN people p ON p.id = tds_p.person_id
         WHERE td.id = $1`,
        [id]
      );

      if (deliveryRows[0]) {
        const d = deliveryRows[0];
        const clientName = `${d.first_name || ''} ${d.last_name || ''}`.trim();
        let signedDocumentId = d.signed_doc_id || null;

        // Advance pipeline job if linked
        if (d.pipeline_job_id) {
          await advancePipelineJob(d.pipeline_job_id);
        }

        // Generate one combined signed PDF with all signatures
        try {
          if (d.signature_doc_id) {
            const bucket = process.env.AWS_S3_BUCKET || 'darklion-s3';
            const { rows: [sigDoc] } = await pool.query('SELECT s3_key, s3_bucket FROM documents WHERE id = $1 AND deleted_at IS NULL', [d.signature_doc_id]);
            if (sigDoc) {
              let pdfBuffer = await downloadFile({ key: sigDoc.s3_key, bucket: sigDoc.s3_bucket || bucket });
              // Embed each signer's signature in sequence
              for (const s of allSigners) {
                const isSpouse = s.signer_role === 'spouse';
                const signerName = isSpouse
                  ? (d.spouse_name || 'Spouse')
                  : `${d.first_name || ''} ${d.last_name || ''}`.trim();
                const signerEmail = isSpouse ? (d.spouse_email || '') : (d.person_email || '');
                pdfBuffer = await embedSignature(pdfBuffer, {
                  name: signerName,
                  email: signerEmail,
                  signedAt: s.signed_at,
                  signedIp: s.signed_ip || '',
                  signatureData: s.signature_data,
                  signatureType: s.signature_type || 'drawn',
                  taxYear: d.tax_year,
                  firmName: d.firm_name,
                });
              }
              const signedKey = buildKey({ firmId: d.firm_id, ownerType: 'tax_signed', ownerId: 0, year: String(d.tax_year || ''), docType: 'signed_return', filename: `signed_${Date.now()}.pdf` });
              await uploadFile({ firmId: d.firm_id, buffer: pdfBuffer, key: signedKey, mimeType: 'application/pdf', bucket });
              const docOwnerType = d.company_id ? 'company' : 'person';
              const docOwnerId = d.company_id || (allSigners.find(s => s.signer_role === 'taxpayer') || allSigners[0])?.person_id;
              const { rows: [finalDoc] } = await pool.query(
                `INSERT INTO documents (firm_id, owner_type, owner_id, doc_type, display_name, mime_type,
                   size_bytes, s3_key, s3_bucket, folder_section, folder_category, year, is_delivered, delivered_at)
                 VALUES ($1, $2, $3, 'signed_return', $4, 'application/pdf', $5, $6, $7,
                         'firm_uploaded', 'tax', $8, true, NOW())
                 RETURNING id`,
                [d.firm_id, docOwnerType, docOwnerId,
                 `${d.tax_year} Tax Return — Fully Signed (${clientName}).pdf`,
                 pdfBuffer.length, signedKey, bucket, String(d.tax_year)]
              );
              // Link final doc to the delivery
              await pool.query('UPDATE tax_deliveries SET signed_doc_id = $1 WHERE id = $2', [finalDoc.id, id]);
              signedDocumentId = finalDoc.id;
            }
          }
        } catch(pdfErr) {
          console.error('[portal] combined signed PDF error (non-fatal):', pdfErr);
        }

        // Firm is notified via pipeline task (fireTrigger below) — no separate email

        // Fire smart pipeline trigger once — on the taxpayer (primary signer) only
        const { rows: primarySignerRows } = await pool.query(
          `SELECT person_id FROM tax_delivery_signers WHERE delivery_id = $1
           ORDER BY CASE WHEN signer_role = 'taxpayer' THEN 0 ELSE 1 END LIMIT 1`,
          [id]
        );
        if (primarySignerRows[0]) {
          recordActivityEvent({
            firmId: d.firm_id,
            eventType: 'tax_return_signed',
            title: `${d.tax_year} tax return signed`,
            summary: `${clientName || 'Client'} fully signed the ${d.tax_year} tax return.`,
            personId: primarySignerRows[0].person_id,
            companyId: d.company_id || null,
            taxYear: d.tax_year,
            entityType: d.company_id ? 'company' : 'person',
            entityId: d.company_id || primarySignerRows[0].person_id,
            sourceTable: 'tax_deliveries',
            sourceId: String(id),
            dedupeKey: `tax_return_signed:${id}`,
            metadata: {
              delivery_id: id,
              signed_document_id: signedDocumentId,
              all_signed: true,
            },
          });
          fireTrigger(d.firm_id, 'tax_return_signed', primarySignerRows[0].person_id, {
            delivery_id: id,
            tax_year: d.tax_year,
          }).catch(e => console.error('[portal] fireTrigger tax_return_signed non-fatal:', e));
        }
      }
    }

    res.json({ ok: true, allSigned });
  } catch (err) {
    console.error('[portal] POST /tax-deliveries/:id/sign error:', err);
    res.status(500).json({ error: 'Failed to submit signature' });
  }
});

// --- POST /portal/upload ---
router.post('/upload', withUpload(upload.single('file')), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const personId = req.portal.personId;
  const firmId = req.portal.firmId;
  const { year, folder_category, company_id, folder_id } = req.body;

  // Optional company upload — verify person has access to that company
  let ownerType = 'person';
  let ownerId = personId;
  let selectedFolder = null;
  try {
    if (company_id) {
      const coId = Number(company_id);
      if (!Number.isSafeInteger(coId) || coId < 1) return res.status(400).json({ error: 'Invalid company' });
      const { rows: accessCheck } = await pool.query(
        `SELECT 1 FROM person_company_access pca
         JOIN companies c ON c.id = pca.company_id
         WHERE pca.person_id = $1 AND pca.company_id = $2 AND c.firm_id = $3`,
        [personId, coId, firmId]
      );
      if (!accessCheck.length) return res.status(403).json({ error: 'No access to that company' });
      ownerType = 'company';
      ownerId = coId;
    }
    if (folder_id) {
      selectedFolder = await resolvePortalDocumentFolder(firmId, folder_id, ownerType, ownerId);
      if (!selectedFolder || selectedFolder.folder_section !== 'client_uploaded') {
        return res.status(400).json({ error: 'That upload folder is not available for this client' });
      }
    }
  } catch (err) {
    console.error('Portal /upload folder lookup error:', err);
    return res.status(500).json({ error: 'Failed to validate upload folder' });
  }

  const bucket = process.env.AWS_S3_BUCKET || 'darklion-s3';
  const filename = sanitizeFilename(req.file.originalname || 'upload');
  const docType = selectedFolder?.folder_category
    || (['tax', 'bookkeeping', 'other'].includes(folder_category) ? folder_category : 'other');

  const safeYear = year || String(new Date().getFullYear());
  const key = buildKey({
    firmId,
    ownerType,
    ownerId,
    year: safeYear,
    docType,
    filename,
  });

  try {
    await uploadFile({ firmId: firmId,
      buffer: req.file.buffer,
      key,
      mimeType: req.file.mimetype,
      bucket,
    });

    const displayName = req.file.originalname || filename;

    const { rows } = await pool.query(
      `INSERT INTO documents
         (firm_id, owner_type, owner_id, doc_type, display_name,
          mime_type, size_bytes, s3_key, s3_bucket, year,
          folder_section, folder_category, uploaded_by_type, uploaded_by_id,
          document_folder_id, folder_subcategory, is_delivered, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'client_uploaded', $11, 'client', $12, $13, $14, false, NOW())
       RETURNING id, owner_type, owner_id, doc_type, display_name,
                 mime_type, size_bytes, year, folder_section, folder_category,
                 document_folder_id, folder_subcategory, uploaded_by_type, created_at`,
      [firmId, ownerType, ownerId, docType, displayName,
       req.file.mimetype, req.file.size, key, bucket, safeYear, docType, personId,
       selectedFolder?.id || null, selectedFolder?.name || '']
    );

    // Fire smart pipeline trigger (non-blocking)
    fireTrigger(firmId, 'document_uploaded_by_client', personId, {
      document_id: rows[0].id,
      filename: displayName,
    }).catch(e => console.error('[portal] fireTrigger document_uploaded_by_client non-fatal:', e));
    recordActivityEvent({
      firmId,
      eventType: 'document_uploaded_by_client',
      title: `Client uploaded document: ${displayName}`,
      summary: `${displayName} was uploaded by the client.`,
      personId: ownerType === 'person' ? personId : null,
      companyId: ownerType === 'company' ? ownerId : null,
      taxYear: safeYear,
      entityType: ownerType,
      entityId: ownerId,
      sourceTable: 'documents',
      sourceId: String(rows[0].id),
      dedupeKey: `document_uploaded_by_client:${rows[0].id}`,
      metadata: {
        document_id: rows[0].id,
        display_name: displayName,
        owner_type: ownerType,
        owner_id: ownerId,
        folder_section: 'client_uploaded',
        folder_category: docType,
        document_folder_id: selectedFolder?.id || null,
        folder_subcategory: selectedFolder?.name || '',
        doc_type: docType,
        year: safeYear,
      },
    });

    res.json({ ok: true, document: rows[0] });
  } catch (err) {
    console.error('Portal /upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// --- PUT /portal/documents/:id --- (move: year/category only, client_uploaded docs only)
router.put('/documents/:id', async (req, res) => {
  const personId = req.portal.personId;
  const docId = parseInt(req.params.id);
  const { year, folder_category, folder_id } = req.body;

  if (!year && !folder_category && folder_id === undefined) return res.status(400).json({ error: 'Nothing to update' });

  try {
    // Fetch doc and verify ownership — must be client_uploaded + belong to this person or their company
    const { rows: docRows } = await pool.query(
      `SELECT id, owner_type, owner_id, folder_section, folder_category, document_folder_id
         FROM documents
        WHERE id = $1 AND firm_id = $2 AND deleted_at IS NULL`,
      [docId, req.portal.firmId]
    );
    if (!docRows[0]) return res.status(404).json({ error: 'Document not found' });
    const doc = docRows[0];

    // Only allow moving client_uploaded docs
    if (doc.folder_section !== 'client_uploaded') {
      return res.status(403).json({ error: 'You can only move documents you uploaded' });
    }

    // Verify access
    let hasAccess = false;
    if (doc.owner_type === 'person' && doc.owner_id === personId) {
      hasAccess = true;
    } else if (doc.owner_type === 'company') {
      const { rows: accessRows } = await pool.query(
        'SELECT 1 FROM person_company_access WHERE person_id = $1 AND company_id = $2',
        [personId, doc.owner_id]
      );
      hasAccess = accessRows.length > 0;
    }
    if (!hasAccess) return res.status(403).json({ error: 'Access denied' });

    // Apply updates
    const sets = [];
    const params = [];
    if (year !== undefined) { params.push(year); sets.push(`year = $${params.length}`); }
    if (folder_id !== undefined) {
      const selectedId = parseInt(folder_id, 10);
      if (selectedId) {
        const selectedFolder = await resolvePortalDocumentFolder(
          req.portal.firmId,
          selectedId,
          doc.owner_type,
          doc.owner_id
        );
        if (!selectedFolder || selectedFolder.folder_section !== 'client_uploaded') {
          return res.status(400).json({ error: 'That upload folder is not available for this client' });
        }
        params.push(selectedFolder.id);
        sets.push(`document_folder_id = $${params.length}`);
        params.push(selectedFolder.name);
        sets.push(`folder_subcategory = $${params.length}`);
        params.push(selectedFolder.folder_category);
        sets.push(`folder_category = $${params.length}`);
        params.push(selectedFolder.folder_category);
        sets.push(`doc_type = $${params.length}`);
      } else {
        params.push(null);
        sets.push(`document_folder_id = $${params.length}`);
        params.push('');
        sets.push(`folder_subcategory = $${params.length}`);
      }
    }
    if (folder_category !== undefined && !parseInt(folder_id, 10)) {
      const safecat = ['tax', 'bookkeeping', 'other'].includes(folder_category) ? folder_category : 'other';
      params.push(safecat);
      sets.push(`folder_category = $${params.length}`);
      params.push(safecat);
      sets.push(`doc_type = $${params.length}`);
      if (safecat !== doc.folder_category && folder_id === undefined && doc.document_folder_id) {
        params.push(null);
        sets.push(`document_folder_id = $${params.length}`);
        params.push('');
        sets.push(`folder_subcategory = $${params.length}`);
      }
    }

    params.push(docId, req.portal.firmId);
    const { rows: updated } = await pool.query(
      `UPDATE documents SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND firm_id = $${params.length}
       RETURNING id, owner_type, owner_id, doc_type, display_name, year,
                 folder_section, folder_category, document_folder_id, folder_subcategory`,
      params
    );

    res.json({ ok: true, document: updated[0] });
  } catch (err) {
    console.error('Portal PUT /documents/:id error:', err);
    res.status(500).json({ error: 'Failed to update document' });
  }
});

function closePackageYear(period) {
  const match = String(period || '').match(/^(\d{4})/);
  return match ? Number(match[1]) : null;
}

// Clients see only the three statements the portal renders; review status and any
// other generated detail stay internal.
function clientClosePackage(pkg) {
  if (!pkg) return null;
  let rd = pkg.report_data;
  if (typeof rd === 'string') { try { rd = JSON.parse(rd); } catch (_) { rd = null; } }
  rd = rd && typeof rd === 'object' ? rd : {};
  return {
    id: pkg.id,
    period: pkg.period,
    report_data: { pnl: rd.pnl ?? null, balanceSheet: rd.balanceSheet ?? null, trialBalance: rd.trialBalance ?? null },
    generated_at: pkg.generated_at,
  };
}

// --- GET /portal/companies/:companyId/close-packages ---
// Returns cached close packages for current YTD plus the two prior full years.
// Client must have access to the company via person_company_access.
router.get('/companies/:companyId/close-packages', async (req, res) => {
  const personId = req.portal.personId;
  const companyId = parseInt(req.params.companyId);

  try {
    // Verify client has access to this company
    const { rows: access } = await pool.query(
      'SELECT 1 FROM person_company_access WHERE person_id = $1 AND company_id = $2',
      [personId, companyId]
    );
    if (!access.length) return res.status(403).json({ error: 'Access denied' });

    // Look up realm_id for the company
    const { rows: coRows } = await pool.query(
      'SELECT realm_id, company_name FROM companies WHERE id = $1',
      [companyId]
    );
    if (!coRows[0] || !coRows[0].realm_id) {
      return res.json({ ytd: null, priorYear: null, company_name: coRows[0]?.company_name || null });
    }
    const realmId = coRows[0].realm_id;
    const coName = coRows[0].company_name;

    const currentYear = new Date().getFullYear();
    const priorYears = [currentYear - 1, currentYear - 2];

    const { rows: packages } = await pool.query(
      `SELECT id, period, report_data, generated_at
       FROM close_packages WHERE realm_id = $1
       ORDER BY generated_at DESC`,
      [realmId]
    );

    function packageForYear(year) {
      const yearPkgs = packages.filter(p => closePackageYear(p.period) === year);
      return yearPkgs.find(p => p.period === String(year)) || yearPkgs[0] || null;
    }

    const ytd = packageForYear(currentYear);
    const priorPackages = priorYears.map(year => {
      const pkg = packageForYear(year);
      return {
        year,
        label: String(year),
        package: clientClosePackage(pkg),
      };
    });

    res.json({
      company_name: coName,
      currentYear,
      currentLabel: `${currentYear} YTD`,
      priorYears: priorPackages,
      // Backward-compatible aliases for older portal clients while the deployed asset rolls forward.
      priorYearNum: priorYears[0],
      priorLabel: String(priorYears[0]),
      ytd: clientClosePackage(ytd),
      prior: priorPackages[0]?.package || null,
    });
  } catch (err) {
    console.error('Portal /companies/:id/close-packages error:', err);
    res.status(500).json({ error: 'Failed to load close package' });
  }
});

// --- GET /portal/investments ---
router.get('/investments', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT financial_planning_enabled, blueleaf_household_id, blueleaf_hidden_accounts
       FROM people WHERE id = $1`,
      [req.portal.personId]
    );
    const person = rows[0];
    if (!person || !person.financial_planning_enabled) {
      return res.json({ enabled: false });
    }
    const { rows: snapshots } = await pool.query(
      `SELECT snapshot_date, performance, accounts, raw_balance, synced_at
       FROM blueleaf_snapshots WHERE person_id = $1 ORDER BY snapshot_date DESC LIMIT 1`,
      [req.portal.personId]
    );
    if (!snapshots[0]) return res.json({ enabled: true, snapshot: null });
    // Filter out advisor-hidden accounts before sending to client
    const hidden = person.blueleaf_hidden_accounts || [];
    const snapshot = snapshots[0];
    if (hidden.length && snapshot.accounts) {
      snapshot.accounts = snapshot.accounts.filter(a => !hidden.includes(a.id));
      snapshot.raw_balance = snapshot.accounts.reduce((s, a) => s + (a.balance || a.currentNetValue || 0), 0);
    }
    res.json({ enabled: true, snapshot });
  } catch (err) {
    console.error('Portal /investments error:', err);
    res.status(500).json({ error: 'Failed to fetch investments' });
  }
});

// ── Statement Portal Endpoints ───────────────────────────────────────────────

// Helper: generate list of YYYY-MM months from start_month to current month (inclusive)
function monthRange(startMonth) {
  const months = [];
  if (!startMonth || !/^\d{4}-\d{2}$/.test(startMonth)) return months;
  const now = new Date();
  // Previous month is typically the most recent statement needed (current month not closed yet)
  const endDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  let cur = new Date(parseInt(startMonth.split('-')[0]), parseInt(startMonth.split('-')[1]) - 1, 1);
  while (cur <= endDate) {
    months.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
    cur.setMonth(cur.getMonth() + 1);
  }
  return months;
}

// GET /portal/companies/:id/statements — list client_upload accounts + monthly status for this company
router.get('/companies/:id/statements', async (req, res) => {
  try {
    const personId = req.portal.personId;
    const companyId = parseInt(req.params.id);

    // Verify access
    const { rows: access } = await pool.query(
      'SELECT 1 FROM person_company_access WHERE person_id = $1 AND company_id = $2',
      [personId, companyId]
    );
    if (!access.length) return res.status(403).json({ error: 'No access to this company' });

    // Get company realm_id
    const { rows: cos } = await pool.query(
      'SELECT realm_id, company_name, firm_id FROM companies WHERE id = $1',
      [companyId]
    );
    const company = cos[0];
    if (!company || !company.realm_id) return res.json({ accounts: [], total_pending: 0 });

    const realmId = company.realm_id;

    // Load all client_upload schedules for this company
    const { rows: schedules } = await pool.query(
      `SELECT ss.id, ss.account_name, ss.institution, ss.statement_day, ss.start_month
       FROM statement_schedules ss
       WHERE ss.realm_id = $1
         AND ss.access_method = 'client_upload'
       ORDER BY ss.account_name ASC`,
      [realmId]
    );

    if (!schedules.length) return res.json({ accounts: [], total_pending: 0 });

    // For each schedule, load all monthly statuses
    const scheduleIds = schedules.map(s => s.id);
    const { rows: statuses } = await pool.query(
      `SELECT sms.schedule_id, sms.month, sms.status, sms.received_at, sms.document_id,
              d.display_name AS doc_file_name
       FROM statement_monthly_status sms
       LEFT JOIN documents d ON d.id = sms.document_id
       WHERE sms.schedule_id = ANY($1)
       ORDER BY sms.month ASC`,
      [scheduleIds]
    );

    const statusBySchedule = {};
    for (const s of statuses) {
      if (!statusBySchedule[s.schedule_id]) statusBySchedule[s.schedule_id] = {};
      statusBySchedule[s.schedule_id][s.month] = s;
    }

    const accounts = schedules.map(sched => {
      const months = monthRange(sched.start_month);
      const monthlyStatus = months.map(m => {
        const st = (statusBySchedule[sched.id] || {})[m];
        return {
          month: m,
          status: st ? st.status : 'pending',
          received_at: st ? st.received_at : null,
          document_id: st ? st.document_id : null,
          doc_file_name: st ? st.doc_file_name : null,
        };
      });
      const pendingCount = monthlyStatus.filter(m => !['uploaded','received'].includes(m.status)).length;
      return {
        id: sched.id,
        account_name: sched.account_name,
        institution: sched.institution,
        statement_day: sched.statement_day,
        start_month: sched.start_month,
        months: monthlyStatus,
        pending_count: pendingCount,
      };
    });

    const totalPending = accounts.reduce((s, a) => s + a.pending_count, 0);
    res.json({ accounts, total_pending: totalPending });
  } catch (err) {
    console.error('Portal /companies/:id/statements error:', err);
    res.status(500).json({ error: 'Failed to load statements' });
  }
});

// POST /portal/companies/:id/statements/:scheduleId/:month — upload a statement for a specific month
router.post('/companies/:id/statements/:scheduleId/:month', upload.single('file'), async (req, res) => {
  try {
    const personId = req.portal.personId;
    const companyId = parseInt(req.params.id);
    const scheduleId = parseInt(req.params.scheduleId);
    const month = req.params.month; // YYYY-MM

    if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Invalid month format' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Verify access
    const { rows: access } = await pool.query(
      'SELECT 1 FROM person_company_access WHERE person_id = $1 AND company_id = $2',
      [personId, companyId]
    );
    if (!access.length) return res.status(403).json({ error: 'No access to this company' });

    // Verify schedule belongs to this company
    const { rows: cos } = await pool.query(
      'SELECT realm_id, company_name, firm_id FROM companies WHERE id = $1',
      [companyId]
    );
    const company = cos[0];
    if (!company) return res.status(404).json({ error: 'Company not found' });

    const { rows: schedRows } = await pool.query(
      `SELECT ss.id, ss.account_name, ss.start_month
       FROM statement_schedules ss
       WHERE ss.id = $1 AND ss.realm_id = $2 AND ss.access_method = 'client_upload'`,
      [scheduleId, company.realm_id]
    );
    if (!schedRows.length) return res.status(404).json({ error: 'Statement account not found' });
    const schedule = schedRows[0];

    // Validate month is within range
    const validMonths = monthRange(schedule.start_month);
    if (!validMonths.includes(month)) return res.status(400).json({ error: 'Month is not in the required range' });

    const firmId = company.firm_id;
    const year = month.split('-')[0];
    const safeName = schedule.account_name.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const safeFile = require('path').basename(req.file.originalname || 'statement.pdf').replace(/[^a-z0-9._-]/gi, '_');
    const s3Key = `firms/${firmId}/companies/${companyId}/statements/${safeName}/${year}/${month}_${safeFile}`;
    const bucket = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET || 'darklion-documents';

    await uploadFile({ firmId: firmId,
      key: s3Key,
      buffer: req.file.buffer,
      contentType: req.file.mimetype || 'application/pdf',
      bucket,
    });

    // Save to documents table: client_uploaded / bookkeeping, folder = account name, year
    const displayName = `${schedule.account_name} — ${month} Statement`;
    const { rows: docRows } = await pool.query(
      `INSERT INTO documents
         (firm_id, owner_type, owner_id, year, display_name, s3_key, s3_bucket, mime_type, size_bytes,
          uploaded_by_type, uploaded_by_id, created_at, folder_section, folder_category, folder_subcategory)
       VALUES ($1, 'company', $2, $3, $4, $5, $6, $7, $8, 'client', $9, NOW(), 'client_uploaded', 'bookkeeping', $10)
       RETURNING id`,
      [firmId, companyId, year, displayName, s3Key, bucket,
       req.file.mimetype || 'application/pdf', req.file.size || req.file.buffer.length, personId, schedule.account_name]
    );
    const docId = docRows[0].id;
    // Upsert statement_monthly_status as 'uploaded'
    await pool.query(
      `INSERT INTO statement_monthly_status (schedule_id, realm_id, month, status, received_at, document_id, updated_at)
       VALUES ($1, $2, $3, 'uploaded', NOW(), $4, NOW())
       ON CONFLICT (schedule_id, month) DO UPDATE SET
         status = 'uploaded', received_at = NOW(), document_id = $4, updated_at = NOW()`,
      [scheduleId, company.realm_id, month, docId]
    );

    // Fire pipeline trigger
    try {
      const { fireTrigger } = require('../services/pipelineTriggers');
      fireTrigger(firmId, 'client_statement_uploaded', companyId, {
        account_name: schedule.account_name, month, document_id: docId
      }, 'company').catch(() => {});
    } catch(e) { /* non-fatal */ }

    recordActivityEvent({
      firmId,
      eventType: 'client_statement_uploaded',
      title: `Statement uploaded: ${schedule.account_name} ${month}`,
      summary: `${company.company_name || 'Client'} uploaded the ${month} statement for ${schedule.account_name}.`,
      companyId,
      taxYear: year,
      entityType: 'company',
      entityId: companyId,
      sourceTable: 'documents',
      sourceId: String(docId),
      dedupeKey: `client_statement_uploaded:${scheduleId}:${month}:${docId}`,
      metadata: {
        document_id: docId,
        schedule_id: scheduleId,
        account_name: schedule.account_name,
        month,
        folder_section: 'client_uploaded',
        folder_category: 'bookkeeping',
      },
    });

    res.json({ ok: true, document_id: docId, month });
  } catch (err) {
    console.error('Portal statement upload error:', err);
    res.status(500).json({ error: 'An error occurred. Please try again.' });
  }
});

// ── GET /portal/bookkeeping-questions ────────────────────────────────
// Returns all sent-to-client uncoded transactions for companies this person has access to
router.get('/bookkeeping-questions', async (req, res) => {
  try {
    const personId = req.portal.personId;

    // Get all company IDs this person has access to
    const { rows: access } = await pool.query(
      `SELECT c.id AS company_id, c.company_name, c.realm_id, c.firm_id
       FROM person_company_access pca
       JOIN companies c ON c.id = pca.company_id
       WHERE pca.person_id = $1`,
      [personId]
    );
    if (!access.length) return res.json({ questions: [] });

    const realmIds = access.map(a => a.realm_id);
    const companyMap = {};
    for (const a of access) companyMap[a.realm_id] = a;

    // Fetch sent-to-client, not yet coded by client, deduped by txn_qb_id
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (realm_id, txn_qb_id)
        id, realm_id, company_name, txn_qb_id, txn_type, txn_date, vendor_name,
        amount, description, original_account, ai_suggested_account, ai_confidence,
        sent_to_client_at
      FROM bookkeeper_uncoded
      WHERE realm_id = ANY($1::text[]) AND sent_to_client = TRUE AND coded_by_client = FALSE
        AND (amount IS NOT NULL AND amount != 0)
      ORDER BY realm_id, txn_qb_id, run_id DESC, id DESC
    `, [realmIds]);

    // Sort: oldest sent_to_client_at first so most urgent are on top
    rows.sort((a, b) => new Date(a.sent_to_client_at || 0) - new Date(b.sent_to_client_at || 0));

    // Fetch chart of accounts for each unique realm so client gets the same dropdown
    const { getChartOfAccounts } = require('../services/quickbooks');
    const coaCache = {};
    const accountOrder = { 'Income': 1, 'Other Income': 1, 'Expense': 2, 'Other Expense': 2, 'Cost of Goods Sold': 2, 'Equity': 3 };
    const groupLabels = { 1: 'Income', 2: 'Expenses', 3: 'Equity' };
    for (const r of realmIds) {
      try {
        const raw = await getChartOfAccounts(r);
        const relevant = raw.filter(a =>
          ['Income', 'Other Income', 'Expense', 'Other Expense', 'Cost of Goods Sold', 'Equity'].includes(a.AccountType)
        );
        relevant.sort((a, b) => {
          const oA = accountOrder[a.AccountType] || 99;
          const oB = accountOrder[b.AccountType] || 99;
          if (oA !== oB) return oA - oB;
          return (a.Name || '').localeCompare(b.Name || '');
        });
        const formatted = [];
        let lastGroup = null;
        for (const a of relevant) {
          const group = accountOrder[a.AccountType] || 99;
          if (group !== lastGroup) {
            formatted.push({ name: groupLabels[group] || '', isHeader: true });
            lastGroup = group;
          }
          formatted.push({ id: a.Id, name: a.Name, type: a.AccountType, isHeader: false });
        }
        coaCache[r] = formatted;
      } catch(e) {
        coaCache[r] = [];
      }
    }

    const questions = rows.map(t => ({
      id: t.id,
      companyName: t.company_name || companyMap[t.realm_id]?.company_name || '',
      txnType: t.txn_type,
      txnDate: t.txn_date,
      vendorName: t.vendor_name,
      amount: t.amount,
      description: t.description,
      aiSuggestedAccount: t.ai_suggested_account,
      aiConfidence: t.ai_confidence,
      sentAt: t.sent_to_client_at,
      accounts: coaCache[t.realm_id] || [],
    }));

    res.json({ questions });
  } catch (err) {
    console.error('Portal /bookkeeping-questions error:', err);
    res.status(500).json({ error: 'Failed to fetch bookkeeping questions' });
  }
});

// ── POST /portal/bookkeeping-questions/:id/code ────────────────────────
// Client submits their account choice → codes directly in QBO
router.post('/bookkeeping-questions/:id/code', async (req, res) => {
  try {
    const personId = req.portal.personId;
    const uncodedId = parseInt(req.params.id, 10);
    const { accountName } = req.body;

    if (!accountName) return res.status(400).json({ error: 'Account name required' });

    // Fetch the transaction and verify portal user has access to its company
    const { rows: txRows } = await pool.query(
      `SELECT bu.*, c.id AS company_id
       FROM bookkeeper_uncoded bu
       JOIN companies c ON c.realm_id = bu.realm_id
       JOIN person_company_access pca ON pca.company_id = c.id AND pca.person_id = $2
       WHERE bu.id = $1 AND bu.sent_to_client = TRUE AND bu.coded_by_client = FALSE`,
      [uncodedId, personId]
    );
    if (!txRows.length) return res.status(404).json({ error: 'Transaction not found or already coded' });

    const tx = txRows[0];

    // Write to QBO
    const { writeBackTransaction } = require('../services/quickbooks');
    await writeBackTransaction(tx.realm_id, tx.txn_qb_id, accountName, tx.txn_type);

    // Mark coded_by_client on this specific row only
    await pool.query(
      `UPDATE bookkeeper_uncoded
       SET coded_by_client = TRUE, coded_by_client_at = NOW(), coded_by_client_account = $1,
           status = 'coded', coded_account = $1, coded_at = NOW()
       WHERE id = $2`,
      [accountName, tx.id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('Portal /bookkeeping-questions/:id/code error:', err);
    res.status(500).json({ error: 'Failed to code transaction. Please try again.' });
  }
});

module.exports = router;
