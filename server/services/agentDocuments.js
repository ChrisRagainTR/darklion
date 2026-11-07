'use strict';

const { pool } = require('../db');
const { downloadFile, getSignedDownloadUrl } = require('./s3');
const { resolveRefundOrBalance } = require('./taxFactExtractor');

const FOLDER_SECTIONS = new Set(['firm_uploaded', 'client_uploaded']);
const FOLDER_CATEGORIES = new Set(['tax', 'bookkeeping', 'ias', 'other']);
const OWNER_TYPES = new Set(['person', 'company']);

const DOCUMENT_SELECT = `
  d.id, d.owner_type, d.owner_id, d.year, d.doc_type, d.display_name,
  d.mime_type, d.size_bytes, d.uploaded_by_type, d.folder_section,
  d.folder_category, d.document_folder_id, d.folder_subcategory,
  d.is_delivered, d.delivered_at, d.deleted_at, d.delete_reason, d.created_at,
  COALESCE(p.relationship_id, c.relationship_id) AS relationship_id,
  r.name AS relationship_name,
  CASE WHEN d.owner_type = 'person' THEN p.id END AS person_id,
  CASE WHEN d.owner_type = 'person' THEN NULLIF(CONCAT_WS(' ', p.first_name, p.last_name), '') END AS person_name,
  CASE WHEN d.owner_type = 'company' THEN c.id END AS company_id,
  CASE WHEN d.owner_type = 'company' THEN c.company_name END AS company_name
`;

class AgentDocumentError extends Error {
  constructor(message, status = 400, code = 'document_error', details = null) {
    super(message);
    this.name = 'AgentDocumentError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function positiveId(value, field) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new AgentDocumentError(`${field} must be a positive integer`, 400, 'invalid_input');
  return id;
}

function boundedInt(value, fallback, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : fallback;
}

function documentDto(row) {
  return {
    id: row.id,
    display_name: row.display_name || '',
    owner_type: row.owner_type,
    owner_id: row.owner_id,
    relationship_id: row.relationship_id || null,
    relationship_name: row.relationship_name || null,
    person_id: row.person_id || (row.owner_type === 'person' ? row.owner_id : null),
    person_name: row.person_name || null,
    company_id: row.company_id || (row.owner_type === 'company' ? row.owner_id : null),
    company_name: row.company_name || null,
    year: row.year || '',
    doc_type: row.doc_type || null,
    folder_section: row.folder_section || null,
    folder_category: row.folder_category || null,
    document_folder_id: row.document_folder_id || null,
    folder_subcategory: row.folder_subcategory || '',
    mime_type: row.mime_type || '',
    size_bytes: Number(row.size_bytes) || 0,
    uploaded_by_type: row.uploaded_by_type || null,
    is_delivered: row.is_delivered === true,
    delivered_at: row.delivered_at || null,
    deleted_at: row.deleted_at || null,
    delete_reason: row.delete_reason || '',
    created_at: row.created_at || null,
  };
}

function folderDto(row) {
  return {
    id: row.id,
    scope: row.scope,
    applies_to: row.applies_to,
    owner_type: row.owner_type || null,
    owner_id: row.owner_id || null,
    folder_section: row.folder_section,
    folder_category: row.folder_category,
    name: row.name,
    created_at: row.created_at || null,
  };
}

async function ownerBelongsToFirm(db, firmId, ownerType, ownerId, staffUserId = null) {
  if (!OWNER_TYPES.has(ownerType)) return false;
  const table = ownerType === 'person' ? 'people' : 'companies';
  if (ownerType === 'company' && staffUserId) {
    const { rows } = await db.query(
      `SELECT 1 FROM companies c
        WHERE c.id = $1 AND c.firm_id = $2
          AND (
            NOT EXISTS (SELECT 1 FROM firm_user_companies restricted WHERE restricted.firm_user_id = $3)
            OR EXISTS (
              SELECT 1 FROM firm_user_companies allowed
              WHERE allowed.firm_user_id = $3 AND allowed.realm_id = c.realm_id
            )
          )`,
      [ownerId, firmId, staffUserId]
    );
    return rows.length > 0;
  }
  const { rows } = await db.query(`SELECT 1 FROM ${table} WHERE id = $1 AND firm_id = $2`, [ownerId, firmId]);
  return rows.length > 0;
}

function documentJoins() {
  return `
    FROM documents d
    LEFT JOIN people p ON d.owner_type = 'person' AND p.id = d.owner_id AND p.firm_id = d.firm_id
    LEFT JOIN companies c ON d.owner_type = 'company' AND c.id = d.owner_id AND c.firm_id = d.firm_id
    LEFT JOIN relationships r ON r.id = COALESCE(p.relationship_id, c.relationship_id) AND r.firm_id = d.firm_id
  `;
}

function companyAccessPredicate(params, staffUserId) {
  if (!staffUserId) return '';
  params.push(staffUserId);
  const p = `$${params.length}`;
  return ` AND (
    d.owner_type <> 'company'
    OR NOT EXISTS (SELECT 1 FROM firm_user_companies restricted WHERE restricted.firm_user_id = ${p})
    OR EXISTS (
      SELECT 1 FROM firm_user_companies allowed
      WHERE allowed.firm_user_id = ${p} AND allowed.realm_id = c.realm_id
    )
  )`;
}

async function listDocuments({ firmId, staffUserId, filters = {}, db = pool }) {
  const params = [positiveId(firmId, 'firm_id')];
  let where = 'd.firm_id = $1';
  const deleted = String(filters.deleted || 'active').toLowerCase();
  if (deleted === 'trash') where += ' AND d.deleted_at IS NOT NULL';
  else if (deleted === 'all') { /* no deleted filter */ }
  else where += ' AND d.deleted_at IS NULL';

  if (filters.relationship_id) {
    params.push(positiveId(filters.relationship_id, 'relationship_id'));
    where += ` AND COALESCE(p.relationship_id, c.relationship_id) = $${params.length}`;
  } else if (filters.owner_type || filters.owner_id) {
    const ownerType = String(filters.owner_type || '');
    if (!OWNER_TYPES.has(ownerType)) throw new AgentDocumentError('owner_type must be person or company', 400, 'invalid_input');
    params.push(ownerType, positiveId(filters.owner_id, 'owner_id'));
    where += ` AND d.owner_type = $${params.length - 1} AND d.owner_id = $${params.length}`;
  }
  for (const [field, column] of [['year', 'year'], ['doc_type', 'doc_type'], ['folder_section', 'folder_section'], ['folder_category', 'folder_category']]) {
    if (filters[field] !== undefined && filters[field] !== '') {
      params.push(String(filters[field]));
      where += ` AND d.${column} = $${params.length}`;
    }
  }
  if (filters.is_delivered !== undefined) {
    params.push(filters.is_delivered === true || String(filters.is_delivered).toLowerCase() === 'true');
    where += ` AND d.is_delivered = $${params.length}`;
  }
  where += companyAccessPredicate(params, staffUserId);
  const limit = boundedInt(filters.limit, 50, 100) || 50;
  const offset = boundedInt(filters.offset, 0, 100_000);
  params.push(limit, offset);
  const { rows } = await db.query(
    `SELECT ${DOCUMENT_SELECT} ${documentJoins()} WHERE ${where}
     ORDER BY d.year DESC NULLS LAST, d.created_at DESC, d.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { documents: rows.map(documentDto), pagination: { limit, offset, count: rows.length } };
}

async function getDocument({ firmId, staffUserId, documentId, includeDeleted = false, db = pool }) {
  const params = [positiveId(documentId, 'document_id'), positiveId(firmId, 'firm_id')];
  let where = 'd.id = $1 AND d.firm_id = $2';
  if (!includeDeleted) where += ' AND d.deleted_at IS NULL';
  where += companyAccessPredicate(params, staffUserId);
  const { rows } = await db.query(`SELECT ${DOCUMENT_SELECT} ${documentJoins()} WHERE ${where} LIMIT 1`, params);
  if (!rows[0]) throw new AgentDocumentError('Document not found', 404, 'document_not_found');
  return documentDto(rows[0]);
}

async function listDocumentFolders({ firmId, staffUserId, ownerType, ownerId, db = pool }) {
  const id = positiveId(ownerId, 'owner_id');
  if (!await ownerBelongsToFirm(db, firmId, ownerType, id, staffUserId)) {
    throw new AgentDocumentError('Owner not found', 404, 'owner_not_found');
  }
  const { rows } = await db.query(
    `SELECT id, scope, applies_to, owner_type, owner_id, folder_section, folder_category, name, created_at
       FROM document_folders
      WHERE firm_id = $1 AND archived_at IS NULL
        AND ((scope = 'firm' AND applies_to IN ('all', $2))
          OR (scope = 'client' AND owner_type = $2 AND owner_id = $3))
      ORDER BY folder_section, folder_category, LOWER(name)`,
    [firmId, ownerType, id]
  );
  return { folders: rows.map(folderDto) };
}

async function createClientDocumentFolder({ firmId, staffUserId, input, db = pool }) {
  const ownerType = String(input.owner_type || '');
  const ownerId = positiveId(input.owner_id, 'owner_id');
  const name = String(input.name || '').replace(/\s+/g, ' ').trim();
  if (!name || name.length > 100 || /[\\/]/.test(name)) throw new AgentDocumentError('Folder name must be 1-100 characters and cannot contain slashes', 400, 'invalid_folder_name');
  if (!FOLDER_SECTIONS.has(input.folder_section)) throw new AgentDocumentError('Invalid folder_section', 400, 'invalid_folder_section');
  if (!FOLDER_CATEGORIES.has(input.folder_category)) throw new AgentDocumentError('Invalid folder_category', 400, 'invalid_folder_category');
  if (!await ownerBelongsToFirm(db, firmId, ownerType, ownerId, staffUserId)) throw new AgentDocumentError('Owner not found', 404, 'owner_not_found');
  try {
    const { rows } = await db.query(
      `INSERT INTO document_folders
         (firm_id, scope, applies_to, owner_type, owner_id, folder_section, folder_category, name, created_by)
       VALUES ($1, 'client', $2, $2, $3, $4, $5, $6, $7)
       RETURNING id, scope, applies_to, owner_type, owner_id, folder_section, folder_category, name, created_at`,
      [firmId, ownerType, ownerId, input.folder_section, input.folder_category, name, staffUserId || null]
    );
    return folderDto(rows[0]);
  } catch (error) {
    if (error.code === '23505') throw new AgentDocumentError('A folder with that name already exists', 409, 'folder_exists');
    throw error;
  }
}

async function resolveFolder(db, firmId, folderId, ownerType, ownerId) {
  const { rows } = await db.query(
    `SELECT id, scope, applies_to, owner_type, owner_id, folder_section, folder_category, name
       FROM document_folders WHERE id = $1 AND firm_id = $2 AND archived_at IS NULL`,
    [positiveId(folderId, 'folder_id'), firmId]
  );
  const folder = rows[0];
  const applies = folder && ((folder.scope === 'firm' && ['all', ownerType].includes(folder.applies_to))
    || (folder.scope === 'client' && folder.owner_type === ownerType && Number(folder.owner_id) === Number(ownerId)));
  if (!applies) throw new AgentDocumentError('Folder is not available for this document owner', 400, 'invalid_folder');
  return folder;
}

async function updateDocument({ firmId, staffUserId, documentId, input, db = pool }) {
  const current = await getDocument({ firmId, staffUserId, documentId, db });
  if (current.folder_category === 'organizer') throw new AgentDocumentError('Organizer documents cannot be edited', 403, 'organizer_locked');
  const sets = [];
  const params = [];
  const set = (column, value) => { params.push(value); sets.push(`${column} = $${params.length}`); };
  if (input.display_name !== undefined) {
    const name = String(input.display_name).trim();
    if (!name || name.length > 255) throw new AgentDocumentError('display_name must be 1-255 characters', 400, 'invalid_input');
    set('display_name', name);
  }
  if (input.year !== undefined) {
    const year = String(input.year).trim();
    if (year && !/^\d{4}$/.test(year)) throw new AgentDocumentError('year must be four digits or empty', 400, 'invalid_input');
    set('year', year);
  }
  if (input.doc_type !== undefined) {
    const docType = String(input.doc_type).trim();
    if (!docType || docType.length > 100) throw new AgentDocumentError('doc_type must be 1-100 characters', 400, 'invalid_input');
    set('doc_type', docType);
  }
  if (input.folder_id !== undefined && input.folder_id !== null) {
    const folder = await resolveFolder(db, firmId, input.folder_id, current.owner_type, current.owner_id);
    set('document_folder_id', folder.id);
    set('folder_subcategory', folder.name);
    set('folder_section', folder.folder_section);
    set('folder_category', folder.folder_category);
    set('doc_type', folder.folder_category);
  } else {
    if (input.folder_section !== undefined) {
      if (!FOLDER_SECTIONS.has(input.folder_section)) throw new AgentDocumentError('Invalid folder_section', 400, 'invalid_folder_section');
      set('folder_section', input.folder_section);
    }
    if (input.folder_category !== undefined) {
      if (!FOLDER_CATEGORIES.has(input.folder_category)) throw new AgentDocumentError('Invalid folder_category', 400, 'invalid_folder_category');
      set('folder_category', input.folder_category);
    }
    if ((input.folder_section !== undefined || input.folder_category !== undefined) && current.document_folder_id) {
      set('document_folder_id', null);
      set('folder_subcategory', '');
    }
  }
  if (!sets.length) throw new AgentDocumentError('Nothing to update', 400, 'nothing_to_update');
  params.push(documentId, firmId);
  const { rows } = await db.query(
    `UPDATE documents SET ${sets.join(', ')}
      WHERE id = $${params.length - 1} AND firm_id = $${params.length} AND deleted_at IS NULL
      RETURNING *`,
    params
  );
  if (!rows[0]) throw new AgentDocumentError('Document not found', 404, 'document_not_found');
  return getDocument({ firmId, staffUserId, documentId, db });
}

async function trashDocument({ firmId, staffUserId, documentId, reason, db = pool }) {
  const id = positiveId(documentId, 'document_id');
  const current = await getDocument({ firmId, staffUserId, documentId: id, db });
  if (current.folder_category === 'organizer') throw new AgentDocumentError('Organizer documents cannot be moved to Trash', 403, 'organizer_locked');
  const linked = await db.query(
    `SELECT DISTINCT td.id, td.status, td.title
       FROM tax_deliveries td
       LEFT JOIN tax_delivery_signers tds ON tds.delivery_id = td.id
      WHERE td.firm_id = $1 AND ($2 IN (td.review_doc_id, td.signature_doc_id) OR tds.signed_doc_id = $2)
      ORDER BY td.id`,
    [firmId, id]
  );
  if (linked.rows.length) {
    throw new AgentDocumentError('Document is attached to a tax delivery and cannot be trashed through MCP', 409, 'document_in_use', {
      linked_deliveries: linked.rows.map(row => ({ id: row.id, status: row.status, title: row.title || '' })),
    });
  }
  const cleanReason = String(reason || 'Moved to Trash by MCP').trim().slice(0, 500);
  const { rows } = await db.query(
    `UPDATE documents SET deleted_at = NOW(), deleted_by = $3, delete_reason = $4
      WHERE id = $1 AND firm_id = $2 AND deleted_at IS NULL RETURNING *`,
    [id, firmId, staffUserId || null, cleanReason]
  );
  if (!rows[0]) throw new AgentDocumentError('Document not found', 404, 'document_not_found');
  return { success: true, trashed: true, document_id: id };
}

async function restoreDocument({ firmId, staffUserId, documentId, db = pool }) {
  const id = positiveId(documentId, 'document_id');
  await getDocument({ firmId, staffUserId, documentId: id, includeDeleted: true, db });
  const { rows } = await db.query(
    `UPDATE documents SET deleted_at = NULL, deleted_by = NULL, delete_reason = ''
      WHERE id = $1 AND firm_id = $2 AND deleted_at IS NOT NULL RETURNING *`,
    [id, firmId]
  );
  if (!rows[0]) throw new AgentDocumentError('Deleted document not found', 404, 'document_not_found');
  return getDocument({ firmId, staffUserId, documentId: id, db });
}

async function getDocumentDownloadUrl({ firmId, staffUserId, documentId, db = pool, signer = getSignedDownloadUrl }) {
  await getDocument({ firmId, staffUserId, documentId, db });
  const { rows } = await db.query(
    'SELECT display_name, s3_key, s3_bucket FROM documents WHERE id = $1 AND firm_id = $2 AND deleted_at IS NULL',
    [documentId, firmId]
  );
  if (!rows[0]) throw new AgentDocumentError('Document not found', 404, 'document_not_found');
  const url = await signer({ key: rows[0].s3_key, bucket: rows[0].s3_bucket, filename: rows[0].display_name, expiresIn: 900 });
  return { document_id: Number(documentId), display_name: rows[0].display_name || '', url, expires_in_seconds: 900 };
}

function normalizedTaxData(data) {
  if (!data || typeof data !== 'object') return null;
  const client = data.client || {};
  const verified = data.verified_facts || {};
  const value = key => verified[key]?.value;
  const refundOrBalance = resolveRefundOrBalance(data, verified)?.amount ?? null;
  return {
    adjusted_gross_income: value('adjusted_gross_income') ?? data.adjusted_gross_income ?? data.agi ?? data.total_income ?? null,
    taxable_income: value('taxable_income') ?? data.taxable_income ?? null,
    total_tax: value('total_tax') ?? data.total_tax ?? null,
    total_payments: value('total_payments') ?? data.total_payments ?? null,
    refund_or_balance_due: refundOrBalance,
    filing_status: value('filing_status') ?? client.filing_status ?? data.filing_status ?? null,
    tax_year: value('tax_year') ?? client.tax_year ?? data.tax_year ?? null,
    form_type: client.form_type ?? data.form_type ?? null,
    client_name: client.names ?? data.client_name ?? null,
  };
}

async function getExtractedDocumentData({ firmId, staffUserId, documentId, live = false, db = pool, downloader = downloadFile, pdfExtractor, taxAnalyzer, factExtractor }) {
  const document = await getDocument({ firmId, staffUserId, documentId, db });
  const { rows } = await db.query(
    `SELECT td.id AS delivery_id, td.tax_report_status, td.tax_report_data
       FROM tax_deliveries td
      WHERE td.firm_id = $1 AND $2 IN (td.review_doc_id, td.signature_doc_id)
      ORDER BY td.updated_at DESC LIMIT 1`,
    [firmId, documentId]
  );
  const cached = normalizedTaxData(rows[0]?.tax_report_data);
  if (cached) return { document_id: Number(documentId), document_name: document.display_name, delivery_id: rows[0].delivery_id, extraction_status: rows[0].tax_report_status || 'completed', source: 'tax_report_data', data: cached };
  if (!live) return { document_id: Number(documentId), document_name: document.display_name, delivery_id: rows[0]?.delivery_id || null, extraction_status: rows[0]?.tax_report_status || 'none', source: null, data: null, live_extraction_available: document.mime_type === 'application/pdf' };
  if (document.mime_type && document.mime_type !== 'application/pdf') throw new AgentDocumentError('Live extraction is only available for PDF documents', 400, 'not_a_pdf');
  const stored = await db.query('SELECT s3_key, s3_bucket FROM documents WHERE id = $1 AND firm_id = $2 AND deleted_at IS NULL', [documentId, firmId]);
  const extract = pdfExtractor || require('./pdfExtract').extractPdfData;
  const analyze = taxAnalyzer || require('./taxAnalysis').analyzeTaxReturn;
  const facts = factExtractor || require('./taxFactExtractor').extractCore1040Facts;
  const buffer = await downloader({ key: stored.rows[0].s3_key, bucket: stored.rows[0].s3_bucket });
  const extracted = await extract(buffer);
  const text = typeof extracted === 'string' ? extracted : extracted.text;
  const report = await analyze(text, facts(extracted));
  return { document_id: Number(documentId), document_name: document.display_name, delivery_id: null, extraction_status: 'completed', source: 'live_pdf_extraction', data: normalizedTaxData(report) };
}

module.exports = {
  AgentDocumentError,
  createClientDocumentFolder,
  documentDto,
  getDocument,
  getDocumentDownloadUrl,
  getExtractedDocumentData,
  listDocumentFolders,
  listDocuments,
  restoreDocument,
  trashDocument,
  updateDocument,
};
