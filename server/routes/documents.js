'use strict';

const { Router } = require('express');
const multer = require('multer');
const { pool } = require('../db');
const { sendDocumentDeliveredMobilePush } = require('../services/mobilePush');
const { uploadFile, downloadFile, getSignedDownloadUrl, deleteFile, buildKey, sanitizeFilename } = require('../services/s3');
const { recordActivityEvent } = require('../services/activityLog');
const { apiScopeAllowed } = require('../middleware/requireApiScope');
const { resolveRefundOrBalance } = require('../services/taxFactExtractor');

const router = Router();

// Multer: memory storage only (no disk writes on Railway)
// ── Allowed file types (MIME + extension allowlist) ──────────────────────────
const ALLOWED_MIME_TYPES = new Set([
  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
  // Archives (for tax packages)
  'application/zip',
  'application/x-zip-compressed',
]);

const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.txt', '.csv', '.jpg', '.jpeg', '.png', '.gif', '.webp',
  '.heic', '.heif', '.zip',
]);

function fileFilter(req, file, cb) {
  const ext = require('path').extname(file.originalname || '').toLowerCase();
  if (!ALLOWED_MIME_TYPES.has(file.mimetype) || !ALLOWED_EXTENSIONS.has(ext)) {
    return cb(new Error(`File type not allowed: ${ext || file.mimetype}. Allowed: PDF, Word, Excel, images, CSV, ZIP.`));
  }
  cb(null, true);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter,
});

const SAFE_COLUMNS = `
  id, firm_id, owner_type, owner_id, year, doc_type, display_name,
  mime_type, size_bytes, uploaded_by_type, uploaded_by_id,
  folder_section, folder_category, document_folder_id, folder_subcategory,
  is_delivered, delivered_at, viewed_at, deleted_at, deleted_by, delete_reason, created_at
`;

const DOCUMENT_FOLDER_SECTIONS = new Set(['firm_uploaded', 'client_uploaded']);
const DOCUMENT_FOLDER_CATEGORIES = new Set(['tax', 'bookkeeping', 'ias', 'other']);

function cleanFolderName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

async function ownerBelongsToFirm(firmId, ownerType, ownerId) {
  if (!['person', 'company'].includes(ownerType) || !Number.isInteger(ownerId) || ownerId < 1) return false;
  const table = ownerType === 'person' ? 'people' : 'companies';
  const { rows } = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1 AND firm_id = $2`, [ownerId, firmId]);
  return rows.length > 0;
}

function folderAppliesToOwner(folder, ownerType, ownerId) {
  if (!folder) return false;
  if (folder.scope === 'firm') return folder.applies_to === 'all' || folder.applies_to === ownerType;
  return folder.scope === 'client' && folder.owner_type === ownerType && Number(folder.owner_id) === Number(ownerId);
}

async function resolveDocumentFolder(firmId, folderId, ownerType, ownerId) {
  const id = parseInt(folderId, 10);
  if (!id) return null;
  const { rows } = await pool.query(
    `SELECT id, firm_id, scope, applies_to, owner_type, owner_id,
            folder_section, folder_category, name
       FROM document_folders
      WHERE id = $1 AND firm_id = $2 AND archived_at IS NULL`,
    [id, firmId]
  );
  const folder = rows[0];
  if (!folder || !folderAppliesToOwner(folder, ownerType, ownerId)) return null;
  return folder;
}

function appBaseUrl(req) {
  return (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

function documentDto(row, req) {
  const baseUrl = appBaseUrl(req);
  return {
    id: row.id,
    name: row.display_name || '',
    display_name: row.display_name || '',
    category: row.folder_category || row.doc_type || 'other',
    folder_category: row.folder_category || null,
    document_folder_id: row.document_folder_id || null,
    folder_subcategory: row.folder_subcategory || '',
    folder_section: row.folder_section || null,
    doc_type: row.doc_type || null,
    year: row.year || '',
    owner_type: row.owner_type,
    owner_id: row.owner_id,
    relationship_id: row.relationship_id || null,
    relationship_name: row.relationship_name || null,
    person_id: row.person_id || (row.owner_type === 'person' ? row.owner_id : null),
    person_name: row.person_name || null,
    company_id: row.company_id || (row.owner_type === 'company' ? row.owner_id : null),
    company_name: row.company_name || null,
    mime_type: row.mime_type || '',
    size: row.size_bytes || 0,
    size_bytes: row.size_bytes || 0,
    is_delivered: !!row.is_delivered,
    delivered_at: row.delivered_at || null,
    viewed_at: row.viewed_at || null,
    uploaded_by_type: row.uploaded_by_type || null,
    deleted_at: row.deleted_at || null,
    deleted_by: row.deleted_by || null,
    delete_reason: row.delete_reason || '',
    created_at: row.created_at || null,
    download_url: `${baseUrl}/api/documents/${row.id}/download`,
    open_url: `${baseUrl}/api/documents/${row.id}/open`,
  };
}

function addDeletedFilter(where, params, mode = '') {
  const deletedMode = String(mode || '').toLowerCase();
  if (deletedMode === 'only' || deletedMode === 'trash' || deletedMode === 'true') {
    return `${where} AND d.deleted_at IS NOT NULL`;
  }
  if (deletedMode === 'all') return where;
  return `${where} AND d.deleted_at IS NULL`;
}

function addPlainDeletedFilter(where, mode = '') {
  const deletedMode = String(mode || '').toLowerCase();
  if (deletedMode === 'only' || deletedMode === 'trash' || deletedMode === 'true') {
    return `${where} AND deleted_at IS NOT NULL`;
  }
  if (deletedMode === 'all') return where;
  return `${where} AND deleted_at IS NULL`;
}

function canPermanentDelete(req) {
  if (req.firm?.isApiToken) return apiScopeAllowed(req, 'documents_delete', null);
  return ['owner', 'admin'].includes(req.firm?.role || '');
}

router.use((req, res, next) => {
  if (!req.firm?.isApiToken) return next();
  const isRead = ['GET', 'HEAD'].includes(req.method);
  const scope = isRead ? 'documents_read' : req.method === 'DELETE' ? 'documents_delete' : 'documents_write';
  const fallbackScope = scope === 'documents_delete' ? null : 'general_api';
  if (apiScopeAllowed(req, scope, fallbackScope)) return next();
  return res.status(403).json({ error: `API token scope required: ${scope}` });
});

function normalizeTaxReportData(data) {
  if (!data || typeof data !== 'object') return null;
  const client = data.client || {};
  const verified = data.verified_facts || {};
  const verifiedValue = (key) => verified[key]?.value;
  const refundOrBalance = resolveRefundOrBalance(data, verified)?.amount ?? null;
  return {
    agi: verifiedValue('adjusted_gross_income') ?? data.adjusted_gross_income ?? data.agi ?? data.total_income ?? null,
    adjusted_gross_income: verifiedValue('adjusted_gross_income') ?? data.adjusted_gross_income ?? data.agi ?? data.total_income ?? null,
    taxable_income: verifiedValue('taxable_income') ?? data.taxable_income ?? null,
    total_tax: verifiedValue('total_tax') ?? data.total_tax ?? null,
    total_payments: verifiedValue('total_payments') ?? data.total_payments ?? null,
    refund_or_balance_due: refundOrBalance,
    filing_status: verifiedValue('filing_status') ?? client.filing_status ?? data.filing_status ?? null,
    tax_year: verifiedValue('tax_year') ?? client.tax_year ?? data.tax_year ?? null,
    form_type: client.form_type ?? data.form_type ?? null,
    client_name: client.names ?? data.client_name ?? null,
    verified_facts: data.verified_facts || null,
    verified_fact_status: data.verified_fact_status || null,
    verified_fact_missing: data.verified_fact_missing || [],
    source: data.verified_facts ? 'verified_tax_report_data' : 'tax_report_data',
    raw: data,
  };
}

async function getDeliveryLinksForDocument(client, firmId, documentId) {
  const { rows } = await client.query(
    `SELECT DISTINCT td.id, td.status, td.title, td.review_doc_id, td.signature_doc_id
       FROM tax_deliveries td
       LEFT JOIN tax_delivery_signers tds ON tds.delivery_id = td.id
      WHERE td.firm_id = $1
        AND ($2 IN (td.review_doc_id, td.signature_doc_id) OR tds.signed_doc_id = $2)
      ORDER BY td.id`,
    [firmId, documentId]
  );
  return rows;
}

async function deleteS3BestEffort(docs) {
  for (const doc of docs) {
    if (!doc?.s3_key) continue;
    try {
      await deleteFile({ key: doc.s3_key, bucket: doc.s3_bucket });
    } catch (s3Err) {
      console.error('S3 delete failed (continuing DB delete):', s3Err.message);
    }
  }
}

async function extractTaxDataLiveFromPdf(firmId, documentId) {
  const { rows } = await pool.query(
    'SELECT id, display_name, s3_key, s3_bucket, mime_type FROM documents WHERE id = $1 AND firm_id = $2 AND deleted_at IS NULL',
    [documentId, firmId]
  );
  const doc = rows[0];
  if (!doc) return { status: 404, body: { error: 'Document not found' } };
  if (doc.mime_type && doc.mime_type !== 'application/pdf') {
    return { status: 400, body: { error: 'Extracted data is only available for PDF documents' } };
  }

  const { extractPdfData } = require('../services/pdfExtract');
  const { analyzeTaxReturn } = require('../services/taxAnalysis');
  const { extractCore1040Facts } = require('../services/taxFactExtractor');
  const buffer = await downloadFile({ key: doc.s3_key, bucket: doc.s3_bucket });
  const pdfData = await extractPdfData(buffer);
  const verifiedFacts = extractCore1040Facts(pdfData);
  const reportData = await analyzeTaxReturn(pdfData.text, verifiedFacts);
  return {
    status: 200,
    body: {
      document_id: doc.id,
      document_name: doc.display_name,
      delivery_id: null,
      extraction_status: 'completed',
      ...normalizeTaxReportData(reportData),
      source: 'live_pdf_extraction',
    },
  };
}

// ── GET /documents/mobile-index ────────────────────────────────────
// Staff mobile document index across the firm.
router.get('/mobile-index', async (req, res) => {
  const firmId = req.firm.id;
  const limit = Math.min(parseInt(req.query.limit, 10) || 500, 1000);
  const ownerType = String(req.query.owner_type || '').trim();
  const ownerId = parseInt(req.query.owner_id, 10);
  const relationshipId = parseInt(req.query.relationship_id, 10);
  const params = [firmId];
  let where = 'd.firm_id = $1 AND d.deleted_at IS NULL';

  if (relationshipId) {
    params.push(relationshipId);
    where += ` AND (
      (d.owner_type = 'person' AND p.relationship_id = $${params.length})
      OR (d.owner_type = 'company' AND c.relationship_id = $${params.length})
    )`;
  } else if (ownerType && ownerId) {
    params.push(ownerType, ownerId);
    where += ` AND d.owner_type = $${params.length - 1} AND d.owner_id = $${params.length}`;
  }
  params.push(limit);

  try {
    const { rows } = await pool.query(
      `SELECT d.${SAFE_COLUMNS.replace(/\s+/g, ' ').trim().split(', ').join(', d.')},
              COALESCE(p.relationship_id, c.relationship_id) AS relationship_id,
              r.name AS relationship_name,
              p.id AS person_id,
              NULLIF(CONCAT_WS(' ', p.first_name, p.last_name), '') AS person_name,
              c.id AS company_id,
              c.company_name
         FROM documents d
         LEFT JOIN people p ON d.owner_type = 'person' AND p.id = d.owner_id AND p.firm_id = d.firm_id
         LEFT JOIN companies c ON d.owner_type = 'company' AND c.id = d.owner_id AND c.firm_id = d.firm_id
         LEFT JOIN relationships r ON r.id = COALESCE(p.relationship_id, c.relationship_id) AND r.firm_id = d.firm_id
        WHERE ${where}
        ORDER BY d.year DESC NULLS LAST, d.created_at DESC
        LIMIT $${params.length}`,
      params
    );
    res.json({ documents: rows.map(row => documentDto(row, req)) });
  } catch (err) {
    console.error('GET /documents/mobile-index error:', err);
    res.status(500).json({ error: 'Failed to fetch mobile document index' });
  }
});

// ── GET /documents ──────────────────────────────────────────────────
// Query: owner_type+owner_id OR relationship_id, year?, doc_type?, category?, is_delivered?
router.get('/', async (req, res) => {
  const firmId = req.firm.id;
  const { owner_type, owner_id, relationship_id, year, doc_type, is_delivered, folder_category, folder_section, include_deleted, deleted } = req.query;
  const category = req.query.category || folder_category;
  const deletedMode = include_deleted || deleted;

  if (relationship_id) {
    const params = [firmId, parseInt(relationship_id)];
    let where = `d.firm_id = $1 AND (
      (d.owner_type = 'person' AND p.relationship_id = $2)
      OR (d.owner_type = 'company' AND c.relationship_id = $2)
    )`;
    where = addDeletedFilter(where, params, deletedMode);

    if (year) { params.push(year); where += ` AND d.year = $${params.length}`; }
    if (doc_type) { params.push(doc_type); where += ` AND d.doc_type = $${params.length}`; }
    if (category) { params.push(category); where += ` AND d.folder_category = $${params.length}`; }
    if (folder_section) { params.push(folder_section); where += ` AND d.folder_section = $${params.length}`; }
    if (is_delivered !== undefined) {
      params.push(is_delivered === 'true' || is_delivered === '1');
      where += ` AND d.is_delivered = $${params.length}`;
    }

    try {
      const { rows } = await pool.query(
        `SELECT d.${SAFE_COLUMNS.replace(/\s+/g, ' ').trim().split(', ').join(', d.')},
                COALESCE(p.relationship_id, c.relationship_id) AS relationship_id,
                r.name AS relationship_name,
                p.id AS person_id,
                NULLIF(CONCAT_WS(' ', p.first_name, p.last_name), '') AS person_name,
                c.id AS company_id,
                c.company_name
           FROM documents d
           LEFT JOIN people p ON d.owner_type = 'person' AND p.id = d.owner_id AND p.firm_id = d.firm_id
           LEFT JOIN companies c ON d.owner_type = 'company' AND c.id = d.owner_id AND c.firm_id = d.firm_id
           LEFT JOIN relationships r ON r.id = COALESCE(p.relationship_id, c.relationship_id)
          WHERE ${where}
          ORDER BY d.year DESC, d.created_at DESC`,
        params
      );
      return res.json({ documents: rows.map(row => documentDto(row, req)) });
    } catch (err) {
      console.error('GET /documents relationship error:', err);
      return res.status(500).json({ error: 'Failed to fetch documents' });
    }
  }

  if (!owner_type || !owner_id) {
    return res.status(400).json({ error: 'owner_type and owner_id are required, or pass relationship_id' });
  }

  const params = [firmId, owner_type, parseInt(owner_id)];
  let where = 'firm_id = $1 AND owner_type = $2 AND owner_id = $3';
  where = addPlainDeletedFilter(where, deletedMode);

  if (year) { params.push(year); where += ` AND year = $${params.length}`; }
  if (doc_type) { params.push(doc_type); where += ` AND doc_type = $${params.length}`; }
  if (category) { params.push(category); where += ` AND folder_category = $${params.length}`; }
  if (folder_section) { params.push(folder_section); where += ` AND folder_section = $${params.length}`; }
  if (is_delivered !== undefined) {
    params.push(is_delivered === 'true' || is_delivered === '1');
    where += ` AND is_delivered = $${params.length}`;
  }

  try {
    const { rows } = await pool.query(
      `SELECT ${SAFE_COLUMNS} FROM documents WHERE ${where} ORDER BY year DESC, created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /documents error:', err);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

// ── GET /documents/folders ─────────────────────────────────────────
// Effective custom folders for one person or company. Firm folders are
// returned dynamically, so they automatically apply to existing/future clients.
router.get('/folders', async (req, res) => {
  const firmId = req.firm.id;
  const ownerType = String(req.query.owner_type || '').trim();
  const ownerId = parseInt(req.query.owner_id, 10);

  try {
    if (!await ownerBelongsToFirm(firmId, ownerType, ownerId)) {
      return res.status(400).json({ error: 'A valid owner_type and owner_id are required' });
    }
    const { rows } = await pool.query(
      `SELECT id, scope, applies_to, owner_type, owner_id,
              folder_section, folder_category, name, created_at
         FROM document_folders
        WHERE firm_id = $1
          AND archived_at IS NULL
          AND (
            (scope = 'firm' AND applies_to IN ('all', $2))
            OR (scope = 'client' AND owner_type = $2 AND owner_id = $3)
          )
        ORDER BY folder_section, folder_category, LOWER(name)`,
      [firmId, ownerType, ownerId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /documents/folders error:', err);
    res.status(500).json({ error: 'Failed to fetch document folders' });
  }
});

// ── POST /documents/folders ────────────────────────────────────────
router.post('/folders', async (req, res) => {
  const firmId = req.firm.id;
  const userId = req.firm.userId || null;
  const name = cleanFolderName(req.body.name);
  const folderSection = String(req.body.folder_section || '').trim();
  const folderCategory = String(req.body.folder_category || '').trim();
  const scope = req.body.scope === 'firm' ? 'firm' : 'client';
  const appliesTo = ['all', 'person', 'company'].includes(req.body.applies_to) ? req.body.applies_to : 'all';
  const ownerType = String(req.body.owner_type || '').trim();
  const ownerId = parseInt(req.body.owner_id, 10);

  if (!name || name.length > 100 || /[\\/]/.test(name)) {
    return res.status(400).json({ error: 'Folder name must be 1-100 characters and cannot contain slashes' });
  }
  if (!DOCUMENT_FOLDER_SECTIONS.has(folderSection)) {
    return res.status(400).json({ error: 'Invalid folder section' });
  }
  if (!DOCUMENT_FOLDER_CATEGORIES.has(folderCategory)) {
    return res.status(400).json({ error: 'Invalid folder category' });
  }
  try {
    if (scope === 'client' && !await ownerBelongsToFirm(firmId, ownerType, ownerId)) {
      return res.status(400).json({ error: 'A valid client is required for a client-specific folder' });
    }
    const { rows } = await pool.query(
      `INSERT INTO document_folders
         (firm_id, scope, applies_to, owner_type, owner_id,
          folder_section, folder_category, name, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, scope, applies_to, owner_type, owner_id,
                 folder_section, folder_category, name, created_at`,
      [
        firmId,
        scope,
        scope === 'firm' ? appliesTo : ownerType,
        scope === 'client' ? ownerType : null,
        scope === 'client' ? ownerId : null,
        folderSection,
        folderCategory,
        name,
        userId,
      ]
    );
    const folder = rows[0];
    recordActivityEvent({
      firmId,
      eventType: 'document_folder_created',
      title: `Document folder created: ${folder.name}`,
      summary: `${folder.name} was added to ${folder.folder_section === 'client_uploaded' ? 'Uploaded by Client' : 'Delivered by Advisor'}.`,
      personId: folder.owner_type === 'person' ? folder.owner_id : null,
      companyId: folder.owner_type === 'company' ? folder.owner_id : null,
      entityType: folder.owner_type || 'firm',
      entityId: folder.owner_id || firmId,
      sourceTable: 'document_folders',
      sourceId: String(folder.id),
      dedupeKey: `document_folder_created:${folder.id}`,
      metadata: folder,
    });
    res.status(201).json(folder);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A folder with that name already exists there' });
    console.error('POST /documents/folders error:', err);
    res.status(500).json({ error: 'Failed to create document folder' });
  }
});

// ── GET /documents/:id ── metadata for a single document ─────────────
router.get('/:id', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);
  try {
    const { rows } = await pool.query(
      `SELECT d.${SAFE_COLUMNS.replace(/\s+/g, ' ').trim().split(', ').join(', d.')},
              COALESCE(p.relationship_id, c.relationship_id) AS relationship_id,
              r.name AS relationship_name,
              p.id AS person_id,
              NULLIF(CONCAT_WS(' ', p.first_name, p.last_name), '') AS person_name,
              c.id AS company_id,
              c.company_name
         FROM documents d
         LEFT JOIN people p ON d.owner_type = 'person' AND p.id = d.owner_id AND p.firm_id = d.firm_id
         LEFT JOIN companies c ON d.owner_type = 'company' AND c.id = d.owner_id AND c.firm_id = d.firm_id
         LEFT JOIN relationships r ON r.id = COALESCE(p.relationship_id, c.relationship_id)
        WHERE d.id = $1 AND d.firm_id = $2 AND d.deleted_at IS NULL`,
      [id, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Document not found' });
    res.json({ document: documentDto(rows[0], req) });
  } catch (err) {
    console.error('GET /documents/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch document' });
  }
});

// ── GET /documents/:id/extracted_data ── normalized parsed tax data ───
router.get('/:id/extracted_data', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);
  try {
    const { rows } = await pool.query(
      `SELECT td.id AS delivery_id, td.status, td.tax_year, td.tax_report_status, td.tax_report_data,
              d.display_name AS document_name
         FROM documents d
         JOIN tax_deliveries td ON td.firm_id = d.firm_id
          AND d.id IN (td.review_doc_id, td.signature_doc_id)
        WHERE d.id = $1 AND d.firm_id = $2 AND d.deleted_at IS NULL
        ORDER BY td.updated_at DESC
        LIMIT 1`,
      [id, firmId]
    );
    if (!rows[0]) {
      const live = await extractTaxDataLiveFromPdf(firmId, id);
      return res.status(live.status).json(live.body);
    }
    const normalized = normalizeTaxReportData(rows[0].tax_report_data);
    if (!normalized) {
      const live = await extractTaxDataLiveFromPdf(firmId, id);
      return res.status(live.status).json(live.body);
    }
    res.json({
      document_id: id,
      document_name: rows[0].document_name,
      delivery_id: rows[0].delivery_id,
      extraction_status: rows[0].tax_report_status || 'none',
      ...normalized,
    });
  } catch (err) {
    console.error('GET /documents/:id/extracted_data error:', err);
    res.status(500).json({ error: 'Failed to fetch extracted data' });
  }
});

// ── POST /documents/upload ──────────────────────────────────────────
router.post('/upload', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const firmId = req.firm.id;
  const userId = req.firm.userId;
  const { owner_type, owner_id, year, doc_type, display_name, folder_section, folder_category, folder_id } = req.body;

  if (!owner_type || !owner_id) {
    return res.status(400).json({ error: 'owner_type and owner_id are required' });
  }
  const ownerId = Number(owner_id);
  if (!['person', 'company'].includes(owner_type) || !Number.isSafeInteger(ownerId) || ownerId < 1) {
    return res.status(400).json({ error: 'Invalid document owner' });
  }

  let safeFolderSection = folder_section || 'firm_uploaded';
  if (!['firm_uploaded', 'client_uploaded'].includes(safeFolderSection)) {
    return res.status(400).json({ error: 'Invalid folder section. Use firm_uploaded or client_uploaded.' });
  }

  let safeFolderCategory = folder_category || doc_type || 'other';
  let selectedFolder = null;

  // Organizer folder is locked — staff cannot upload or overwrite directly.
  // Writes come exclusively from the backend auto-trigger on organizer submission.
  if (safeFolderCategory === 'organizer' || doc_type === 'organizer') {
    return res.status(403).json({ error: 'Organizer folder is managed automatically. Staff cannot upload directly.' });
  }

  if (!['tax', 'bookkeeping', 'ias', 'other', 'engagement_letter'].includes(safeFolderCategory)) {
    return res.status(400).json({ error: 'Invalid folder category.' });
  }

  try {
    if (!await ownerBelongsToFirm(firmId, owner_type, ownerId)) {
      return res.status(404).json({ error: 'Document owner not found' });
    }
    if (folder_id) {
      selectedFolder = await resolveDocumentFolder(firmId, folder_id, owner_type, ownerId);
      if (!selectedFolder) return res.status(400).json({ error: 'That folder is not available for this client' });
      safeFolderSection = selectedFolder.folder_section;
      safeFolderCategory = selectedFolder.folder_category;
    }
  } catch (err) {
    console.error('POST /documents/upload owner/folder lookup error:', err);
    return res.status(500).json({ error: 'Failed to validate document owner or folder' });
  }

  const bucket = process.env.AWS_S3_BUCKET || 'darklion-s3';
  const filename = sanitizeFilename(req.file.originalname || 'upload');
  const key = buildKey({
    firmId,
    ownerType: owner_type,
    ownerId,
    year: year || '',
    docType: doc_type || safeFolderCategory || 'other',
    filename,
  });

  try {
    await uploadFile({ firmId: firmId,
      buffer: req.file.buffer,
      key,
      mimeType: req.file.mimetype,
      bucket,
    });

    const { rows } = await pool.query(
      `INSERT INTO documents
       (firm_id, owner_type, owner_id, year, doc_type, display_name,
          s3_bucket, s3_key, mime_type, size_bytes, uploaded_by_type, uploaded_by_id,
          folder_section, folder_category, document_folder_id, folder_subcategory, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
       RETURNING ${SAFE_COLUMNS}`,
      [
        firmId,
        owner_type,
        ownerId,
        year || '',
        doc_type || safeFolderCategory || 'other',
        display_name || filename,
        bucket,
        key,
        req.file.mimetype,
        req.file.size,
        userId ? 'staff' : 'staff',
        userId || null,
        safeFolderSection,
        safeFolderCategory,
        selectedFolder?.id || null,
        selectedFolder?.name || '',
      ]
    );

    const savedDoc = rows[0];
    recordActivityEvent({
      firmId,
      eventType: 'document_uploaded_by_staff',
      title: `Staff uploaded document: ${savedDoc.display_name || filename}`,
      summary: `${savedDoc.display_name || filename} was uploaded to ${savedDoc.owner_type} #${savedDoc.owner_id}.`,
      personId: savedDoc.owner_type === 'person' ? savedDoc.owner_id : null,
      companyId: savedDoc.owner_type === 'company' ? savedDoc.owner_id : null,
      taxYear: savedDoc.year || '',
      entityType: savedDoc.owner_type,
      entityId: savedDoc.owner_id,
      sourceTable: 'documents',
      sourceId: String(savedDoc.id),
      dedupeKey: `document_uploaded_by_staff:${savedDoc.id}`,
      metadata: {
        document_id: savedDoc.id,
        display_name: savedDoc.display_name,
        owner_type: savedDoc.owner_type,
        owner_id: savedDoc.owner_id,
        folder_section: savedDoc.folder_section,
        folder_category: savedDoc.folder_category,
        document_folder_id: savedDoc.document_folder_id,
        folder_subcategory: savedDoc.folder_subcategory,
        doc_type: savedDoc.doc_type,
        year: savedDoc.year || '',
      },
    });
    res.status(201).json(savedDoc);

    // === ORGANIZER AUTO-PARSE TRIGGER ===
    // If this upload lands in the 'organizer' folder category and belongs to a person,
    // automatically kick off the parser to build their digital checklist.
    if (
      (folder_category === 'organizer' || doc_type === 'organizer') &&
      owner_type === 'person' &&
      savedDoc.mime_type === 'application/pdf'
    ) {
      setImmediate(async () => {
        try {
          const { parseOrganizerPdf } = require('../services/organizerParser');
          const { downloadFile } = require('../services/s3');
          const pdfBuffer = await downloadFile({ key: savedDoc.s3_key, bucket: savedDoc.s3_bucket });

          // Get firm companies for firm-provides detection
          const companiesRes = await pool.query(`
            SELECT c.company_name AS name FROM companies c
            JOIN people p ON p.relationship_id = c.relationship_id
            WHERE p.id = $1 AND c.firm_id = $2
          `, [parseInt(owner_id), firmId]);
          const firmCompanyNames = companiesRes.rows.map(r => r.name);

          const taxYear = savedDoc.year || year || '2025';
          const { clientName, items } = await parseOrganizerPdf(pdfBuffer, firmCompanyNames, { useFirmPayerDefaults: await require('../services/firmIntegrations').legacyIntegrationOwner(firmId) });

          // Upsert organizer
          const orgRes = await pool.query(`
            INSERT INTO tax_organizers (firm_id, person_id, tax_year, status, source_document_id)
            VALUES ($1, $2, $3, 'pending', $4)
            ON CONFLICT (person_id, tax_year)
            DO UPDATE SET source_document_id = $4, status = 'pending', updated_at = NOW()
            RETURNING *
          `, [firmId, parseInt(owner_id), taxYear, savedDoc.id]);
          const organizer = orgRes.rows[0];

          // Replace items
          await pool.query('DELETE FROM tax_organizer_items WHERE organizer_id = $1', [organizer.id]);
          for (const item of items) {
            await pool.query(`
              INSERT INTO tax_organizer_items
                (organizer_id, section, payer_name, account_number, owner, prior_year_amount, ein, sentinel_provides, display_order)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            `, [organizer.id, item.section, item.payerName, item.accountNumber || '',
                item.owner || 'joint', item.prior_year_amount || null,
                item.ein || '', item.sentinel_provides || false, item.display_order || 0]);
          }
          console.log(`[organizer] Auto-parsed ${items.length} items for ${clientName} (person ${owner_id}, year ${taxYear})`);
        } catch (parseErr) {
          console.error('[organizer] Auto-parse failed:', parseErr.message);
        }
      });
    }

  } catch (err) {
    console.error('POST /documents/upload error:', err);
    res.status(500).json({ error: err.message || 'Failed to upload document' });
  }
});

// ── GET /documents/:id/url ── (alias for download, returns JSON)
router.get('/:id/url', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      'SELECT s3_key, s3_bucket FROM documents WHERE id = $1 AND firm_id = $2 AND deleted_at IS NULL',
      [parseInt(id), firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Document not found' });
    const url = await getSignedDownloadUrl({ key: rows[0].s3_key, bucket: rows[0].s3_bucket });
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to generate URL' });
  }
});

// ── GET /documents/:id/open ── (302 redirect — iOS Safari safe)
router.get('/:id/open', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      'SELECT s3_key, s3_bucket FROM documents WHERE id = $1 AND firm_id = $2 AND deleted_at IS NULL',
      [parseInt(id), firmId]
    );
    if (!rows[0]) return res.status(404).send('Document not found');
    const url = await getSignedDownloadUrl({ key: rows[0].s3_key, bucket: rows[0].s3_bucket });
    res.redirect(302, url);
  } catch (err) {
    res.status(500).send('Failed to open document');
  }
});

// ── GET /documents/:id/download ─────────────────────────────────────
router.get('/:id/download', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;

  try {
    const { rows } = await pool.query(
      'SELECT s3_key, s3_bucket FROM documents WHERE id = $1 AND firm_id = $2 AND deleted_at IS NULL',
      [parseInt(id), firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Document not found' });

    const url = await getSignedDownloadUrl({ key: rows[0].s3_key, bucket: rows[0].s3_bucket });
    res.json({ url });
  } catch (err) {
    console.error('GET /documents/:id/download error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate download URL' });
  }
});

// ── PUT /documents/:id ──────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;
  const { display_name, doc_type, year, is_delivered, folder_section, folder_category, folder_id } = req.body;

  try {
    // Check the current document first so custom folders remain scoped to the
    // same client and organizer documents keep their existing lock.
    const lockCheck = await pool.query(
      `SELECT owner_type, owner_id, folder_section, folder_category,
              document_folder_id, is_delivered
         FROM documents
        WHERE id = $1 AND firm_id = $2 AND deleted_at IS NULL`,
      [parseInt(id), firmId]
    );
    const current = lockCheck.rows[0];
    if (!current) return res.status(404).json({ error: 'Document not found' });
    if (current.folder_category === 'organizer') {
      return res.status(403).json({ error: 'Organizer documents cannot be edited by staff.' });
    }

    const sets = [];
    const params = [];
    const addSet = (column, value) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (display_name !== undefined) addSet('display_name', display_name);
    if (doc_type !== undefined && !(folder_id !== undefined && parseInt(folder_id, 10))) addSet('doc_type', doc_type);
    if (year !== undefined) addSet('year', year);

    if (folder_id !== undefined) {
      const selectedId = parseInt(folder_id, 10);
      if (selectedId) {
        const selectedFolder = await resolveDocumentFolder(firmId, selectedId, current.owner_type, current.owner_id);
        if (!selectedFolder) return res.status(400).json({ error: 'That folder is not available for this client' });
        addSet('document_folder_id', selectedFolder.id);
        addSet('folder_subcategory', selectedFolder.name);
        addSet('folder_section', selectedFolder.folder_section);
        addSet('folder_category', selectedFolder.folder_category);
        addSet('doc_type', selectedFolder.folder_category);
      } else {
        addSet('document_folder_id', null);
        addSet('folder_subcategory', '');
        if (folder_section !== undefined) addSet('folder_section', folder_section);
        if (folder_category !== undefined) addSet('folder_category', folder_category);
      }
    } else {
      if (folder_section !== undefined) addSet('folder_section', folder_section);
      if (folder_category !== undefined) addSet('folder_category', folder_category);
      const changedPlacement =
        (folder_section !== undefined && folder_section !== current.folder_section)
        || (folder_category !== undefined && folder_category !== current.folder_category);
      if (changedPlacement && current.document_folder_id) {
        addSet('document_folder_id', null);
        addSet('folder_subcategory', '');
      }
    }

    if (is_delivered !== undefined) {
      const val = is_delivered === true || is_delivered === 'true' || is_delivered === 1;
      addSet('is_delivered', val);
      if (val) sets.push('delivered_at = NOW()');
    }

    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(parseInt(id));
    params.push(firmId);

    const { rows } = await pool.query(
      `UPDATE documents SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND firm_id = $${params.length} AND deleted_at IS NULL RETURNING ${SAFE_COLUMNS}`,
      params
    );
    if (is_delivered !== undefined && !current.is_delivered && rows[0].is_delivered) {
      setImmediate(() => sendDocumentDeliveredMobilePush({ firmId, document: rows[0] }));
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('PUT /documents/:id error:', err);
    res.status(500).json({ error: 'Failed to update document' });
  }
});

// ── POST /documents/:id/restore ── restore from Trash ───────────────
router.post('/:id/restore', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);
  try {
    const { rows } = await pool.query(
      `UPDATE documents
          SET deleted_at = NULL, deleted_by = NULL, delete_reason = ''
        WHERE id = $1 AND firm_id = $2 AND deleted_at IS NOT NULL
        RETURNING ${SAFE_COLUMNS}`,
      [id, firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Deleted document not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('POST /documents/:id/restore error:', err);
    res.status(500).json({ error: 'Failed to restore document' });
  }
});

// ── DELETE /documents/:id/permanent ── admin hard delete from Trash ──
router.delete('/:id/permanent', async (req, res) => {
  if (!canPermanentDelete(req)) return res.status(403).json({ error: 'Only owners/admins can permanently delete documents.' });
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);
  const confirmDelete = String(req.body?.confirm_delete || req.body?.confirm || '').trim().toUpperCase();
  if (confirmDelete !== 'DELETE') {
    return res.status(409).json({ error: 'Type DELETE to permanently delete this document from Trash.', requires_confirmation: true, confirmation_text: 'DELETE' });
  }

  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows } = await db.query(
      'SELECT id, s3_key, s3_bucket, folder_category FROM documents WHERE id = $1 AND firm_id = $2 AND deleted_at IS NOT NULL',
      [id, firmId]
    );
    if (!rows[0]) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Deleted document not found' });
    }
    if (rows[0].folder_category === 'organizer') {
      await db.query('ROLLBACK');
      return res.status(403).json({ error: 'Organizer documents cannot be permanently deleted by staff.' });
    }
    await db.query('DELETE FROM documents WHERE id = $1 AND firm_id = $2 AND deleted_at IS NOT NULL', [id, firmId]);
    await db.query('COMMIT');
    await deleteS3BestEffort(rows);
    res.json({ success: true, permanently_deleted_document_ids: [id] });
  } catch (err) {
    try { await db.query('ROLLBACK'); } catch (_) {}
    console.error('DELETE /documents/:id/permanent error:', err);
    res.status(500).json({ error: 'Failed to permanently delete document' });
  } finally {
    db.release();
  }
});

// ── DELETE /documents/:id ── move to Trash (soft delete) ─────────────
router.delete('/:id', async (req, res) => {
  const firmId = req.firm.id;
  const id = parseInt(req.params.id);
  const userId = req.firm.userId || null;
  const confirmDelete = String(req.body?.confirm_delete || req.body?.confirm || '').trim().toUpperCase();
  const forceDelete = confirmDelete === 'DELETE';
  const db = await pool.connect();

  try {
    await db.query('BEGIN');

    const { rows } = await db.query(
      'SELECT id, folder_category FROM documents WHERE id = $1 AND firm_id = $2 AND deleted_at IS NULL',
      [id, firmId]
    );
    if (!rows[0]) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Document not found' });
    }

    // Organizer docs are locked — staff cannot delete
    if (rows[0].folder_category === 'organizer') {
      await db.query('ROLLBACK');
      return res.status(403).json({ error: 'Organizer documents cannot be deleted by staff.' });
    }

    const linkedDeliveries = await getDeliveryLinksForDocument(db, firmId, id);
    const nonDraftDeliveries = linkedDeliveries.filter(d => d.status !== 'draft');

    if (nonDraftDeliveries.length && !forceDelete) {
      await db.query('ROLLBACK');
      return res.status(409).json({
        error: 'This document is attached to a non-draft tax delivery. Type DELETE to move the delivery documents to Trash and remove the delivery record.',
        requires_confirmation: true,
        confirmation_text: 'DELETE',
        linked_deliveries: linkedDeliveries.map(d => ({ id: d.id, status: d.status, title: d.title })),
      });
    }

    let docsToTrash = rows;
    let deletedDeliveries = [];
    if (linkedDeliveries.length) {
      const deliveryIds = linkedDeliveries.map(d => d.id);
      const { rows: attachedDocs } = await db.query(
        `SELECT DISTINCT d.id, d.folder_category
           FROM documents d
          WHERE d.firm_id = $1
            AND d.deleted_at IS NULL
            AND d.folder_category != 'organizer'
            AND d.id IN (
              SELECT review_doc_id FROM tax_deliveries WHERE firm_id = $1 AND id = ANY($2::int[]) AND review_doc_id IS NOT NULL
              UNION
              SELECT signature_doc_id FROM tax_deliveries WHERE firm_id = $1 AND id = ANY($2::int[]) AND signature_doc_id IS NOT NULL
              UNION
              SELECT signed_doc_id FROM tax_delivery_signers WHERE delivery_id = ANY($2::int[]) AND signed_doc_id IS NOT NULL
            )`,
        [firmId, deliveryIds]
      );
      docsToTrash = attachedDocs.length ? attachedDocs : rows;

      // Preserve the previous delivery behavior, but keep files recoverable in Documents Trash.
      await db.query('DELETE FROM tax_deliveries WHERE firm_id = $1 AND id = ANY($2::int[])', [firmId, deliveryIds]);
      deletedDeliveries = linkedDeliveries.map(d => ({ id: d.id, status: d.status, title: d.title }));
    }

    const docIds = docsToTrash.map(d => d.id);
    const { rows: trashedDocs } = await db.query(
      `UPDATE documents
          SET deleted_at = NOW(), deleted_by = $3, delete_reason = COALESCE(NULLIF($4, ''), 'Moved to Trash')
        WHERE firm_id = $1 AND id = ANY($2::int[]) AND deleted_at IS NULL
        RETURNING ${SAFE_COLUMNS}`,
      [firmId, docIds, userId, req.body?.delete_reason || 'Moved to Trash']
    );

    await db.query('COMMIT');

    res.json({ success: true, trashed: true, deleted_document_ids: trashedDocs.map(d => d.id), deleted_deliveries: deletedDeliveries });
  } catch (err) {
    try { await db.query('ROLLBACK'); } catch (_) {}
    console.error('DELETE /documents/:id error:', err);
    res.status(500).json({ error: 'Failed to move document to Trash' });
  } finally {
    db.release();
  }
});

// ── POST /documents/:id/deliver ─────────────────────────────────────
router.post('/:id/deliver', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;

  try {
    const { rows } = await pool.query(
      `UPDATE documents SET is_delivered = true, delivered_at = NOW()
       WHERE id = $1 AND firm_id = $2 AND deleted_at IS NULL RETURNING ${SAFE_COLUMNS}`,
      [parseInt(id), firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Document not found' });
    setImmediate(() => sendDocumentDeliveredMobilePush({ firmId, document: rows[0] }));
    res.json(rows[0]);
  } catch (err) {
    console.error('POST /documents/:id/deliver error:', err);
    res.status(500).json({ error: 'Failed to mark as delivered' });
  }
});

// POST /api/documents/import-from-drive
// Imports all files from a Google Drive folder into DarkLion for a given company or person.
// Body: { folderId, ownerType ('company'|'person'), ownerId, driveUserEmail? }
router.post('/import-from-drive', async (req, res) => {
  const firmId = req.firm.id;
  const userId = req.firm.userId;
  const { folderId, ownerType = 'company', ownerId, driveUserEmail } = req.body;

  if (!folderId || !ownerId) {
    return res.status(400).json({ error: 'folderId and ownerId are required' });
  }

  // Verify owner belongs to this firm
  if (ownerType === 'company') {
    const { rows } = await pool.query('SELECT id FROM companies WHERE id=$1 AND firm_id=$2', [ownerId, firmId]);
    if (!rows.length) return res.status(404).json({ error: 'Company not found' });
  } else {
    const { rows } = await pool.query('SELECT id FROM people WHERE id=$1 AND firm_id=$2', [ownerId, firmId]);
    if (!rows.length) return res.status(404).json({ error: 'Person not found' });
  }

  // Run import in background, respond immediately
  res.json({ ok: true, message: 'Import started in background' });

  setImmediate(async () => {
    try {
      const { google } = require('googleapis');
      const path = require('path');
      let keyData;
      if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
        keyData = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      } else {
        // Try local path (dev/self-hosted)
        const keyPath = require('path').join(__dirname, '../../credentials/google-service-account.json');
        try { keyData = require(keyPath); } catch(e) {
          console.error('[drive-import] No service account credentials found. Set GOOGLE_SERVICE_ACCOUNT_JSON env var.');
          return;
        }
      }

      if(!await require('../services/firmIntegrations').legacyIntegrationOwner(req.firm.id)) throw new Error('Connect a firm-owned document source before using Drive import');
      const subject = driveUserEmail || process.env.GOOGLE_DRIVE_IMPERSONATE_EMAIL;
      if (!subject) throw new Error('Set GOOGLE_DRIVE_IMPERSONATE_EMAIL or pass driveUserEmail');
      const jwtClient = new google.auth.JWT({
        email: keyData.client_email,
        key: keyData.private_key,
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
        subject,
      });
      await jwtClient.authorize();
      const drive = google.drive({ version: 'v3', auth: jwtClient });

      const bucket = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET || 'darklion-documents';
      let imported = 0, skipped = 0, errors = 0;

      async function processFolder(drFolderId, yearHint) {
        const listRes = await drive.files.list({
          q: `'${drFolderId}' in parents and trashed=false`,
          fields: 'files(id, name, mimeType, size)',
          pageSize: 100,
        });

        for (const f of listRes.data.files) {
          if (f.mimeType === 'application/vnd.google-apps.folder') {
            // Extract year from folder name if possible
            const yearMatch = f.name.match(/20[0-9]{2}/);
            await processFolder(f.id, yearMatch ? yearMatch[0] : yearHint);
            continue;
          }

          // Skip Google native formats that can't be downloaded directly
          if (f.mimeType.startsWith('application/vnd.google-apps.')) {
            console.log(`[drive-import] Skip Google native: ${f.name}`);
            skipped++;
            continue;
          }

          try {
            // Categorize
            const n = f.name.toLowerCase();
            let category = 'other';
            if (n.includes('tax return') || n.includes('1099') || n.includes('federal') || n.includes('state financial') || n.includes('fl state')) category = 'tax';
            else if (n.includes('balance sheet') || n.includes('profit') || n.includes('financial') || n.includes('payroll') || n.includes('checking') || n.includes('transaction') || n.includes('brokerage') || n.includes('.xlsx') || n.includes('.csv')) category = 'bookkeeping';

            // Extract year
            const yearMatch = (yearHint || f.name).match(/20[0-9]{2}/);
            const year = yearMatch ? yearMatch[0] : String(new Date().getFullYear());

            // Check duplicate
            const safeName = f.name.replace(/[^a-zA-Z0-9._\-]/g, '_');
            const s3Key = `firms/${firmId}/${ownerType}s/${ownerId}/docs/${year}/${safeName}`;
            const exists = await pool.query(
              'SELECT id FROM documents WHERE firm_id=$1 AND s3_key=$2',
              [firmId, s3Key]
            );
            if (exists.rows.length) { skipped++; continue; }

            // Download
            const dlRes = await drive.files.get(
              { fileId: f.id, alt: 'media' },
              { responseType: 'arraybuffer' }
            );
            const buffer = Buffer.from(dlRes.data);
            const mimeType = f.mimeType || 'application/octet-stream';

            // Upload to S3
            await uploadFile({ firmId: firmId, buffer, key: s3Key, mimeType, bucket });

            // Register in DB
            await pool.query(
              `INSERT INTO documents (firm_id, owner_type, owner_id, doc_type, display_name, mime_type,
                size_bytes, s3_key, s3_bucket, year, folder_section, folder_category,
                uploaded_by_type, uploaded_by_id, is_delivered, created_at)
               VALUES ($1, $2, $3, 'other', $4, $5, $6, $7, $8, $9, 'firm_uploaded', $10, 'staff', $11, true, NOW())`,
              [firmId, ownerType, ownerId, f.name, mimeType, buffer.length, s3Key, bucket, year, category, userId || 1]
            );

            console.log(`[drive-import] ✅ ${f.name} (→ ${category}, ${year})`);
            imported++;
          } catch(e) {
            console.error(`[drive-import] ❌ ${f.name}: ${e.message}`);
            errors++;
          }
        }
      }

      await processFolder(folderId, null);
      console.log(`[drive-import] Done. Imported: ${imported}, Skipped: ${skipped}, Errors: ${errors}`);
    } catch(e) {
      console.error('[drive-import] Fatal error:', e.message);
    }
  });
});

module.exports = router;
