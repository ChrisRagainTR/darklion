'use strict';

const { pool } = require('../db');
const { uploadFile, buildKey, sanitizeFilename } = require('./s3');
const { generatePDF } = require('./pdf');
const { resolveProposalPrimaryPerson } = require('./portalAccess');

const BUCKET = process.env.AWS_S3_BUCKET || 'darklion-s3';

async function ensureEngagementLettersTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS engagement_letters (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL,
      relationship_id INTEGER NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL DEFAULT '',
      s3_key TEXT NOT NULL DEFAULT '',
      s3_bucket TEXT NOT NULL DEFAULT '',
      mime_type TEXT DEFAULT 'application/pdf',
      size_bytes INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      extracted_data JSONB,
      extracted_at TIMESTAMPTZ,
      retired_at TIMESTAMPTZ,
      retired_by INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      created_by INTEGER
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_engagement_letters_rel ON engagement_letters(relationship_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_engagement_letters_firm ON engagement_letters(firm_id)`);
}

function proposalDisplayName(eng) {
  const client = eng.company_name || eng.client_name || eng.proposal_client_name || 'Client';
  const type = eng.engagement_type === 'wealth' ? 'Wealth Management' : 'Tax Services';
  const signedDate = eng.signed_at ? new Date(eng.signed_at) : new Date();
  const yyyy = signedDate.getFullYear();
  const mm = String(signedDate.getMonth() + 1).padStart(2, '0');
  const dd = String(signedDate.getDate()).padStart(2, '0');
  return `Signed ${type} Engagement Letter - ${client} - ${yyyy}-${mm}-${dd}.pdf`;
}

function extractedDataForEngagement(eng, documentId = null) {
  return {
    proposal_id: eng.proposal_id_val,
    document_id: documentId,
    engagement_type: eng.engagement_type,
    company_name: eng.company_name,
    client_name: eng.client_name || eng.proposal_client_name,
    contact_email: eng.contact_email || eng.proposal_client_email,
    entity_type: eng.entity_type,
    owners: eng.owners,
    monthly_price: eng.monthly_price,
    signed_by_name: eng.signed_by_name,
    signed_at: eng.signed_at,
    signed2_by_name: eng.signed2_by_name,
    signed2_at: eng.signed2_at,
    ai_summary: `Signed ${eng.engagement_type === 'wealth' ? 'wealth management' : 'tax services'} engagement letter. Monthly: $${eng.monthly_price || 0}. Signer: ${eng.signed_by_name || 'Unknown'}.`,
  };
}

async function loadSignedProposalEngagement(proposalId, firmId) {
  const { rows } = await pool.query(
    `SELECT p.id AS proposal_id_val,
            p.firm_id,
            p.relationship_id,
            p.public_token,
            p.client_name AS proposal_client_name,
            p.client_email AS proposal_client_email,
            pe.id AS engagement_id_val,
            pe.*
     FROM proposals p
     JOIN proposal_engagements pe ON pe.proposal_id = p.id
     WHERE p.id = $1 AND p.firm_id = $2 AND pe.status = 'signed'
     ORDER BY pe.created_at DESC
     LIMIT 1`,
    [proposalId, firmId]
  );
  return rows[0] || null;
}

async function findExistingEngagementDocument({ firmId, personId, displayName }) {
  const { rows } = await pool.query(
    `SELECT * FROM documents
     WHERE firm_id = $1
       AND owner_type = 'person'
       AND owner_id = $2
       AND doc_type = 'engagement_letter'
       AND folder_category = 'engagement_letter'
       AND display_name = $3
     ORDER BY created_at DESC
     LIMIT 1`,
    [firmId, personId, displayName]
  );
  return rows[0] || null;
}

async function upsertEngagementLetterRecord({ firmId, relationshipId, displayName, document, eng, userId = null }) {
  await ensureEngagementLettersTable();
  const extractedData = extractedDataForEngagement(eng, document?.id || null);

  const { rows: existing } = await pool.query(
    `SELECT id FROM engagement_letters
     WHERE firm_id = $1 AND relationship_id = $2 AND display_name = $3 AND status = 'active'
     ORDER BY created_at DESC
     LIMIT 1`,
    [firmId, relationshipId, displayName]
  );

  if (existing[0]) {
    const { rows } = await pool.query(
      `UPDATE engagement_letters
       SET s3_key = $1,
           s3_bucket = $2,
           mime_type = 'application/pdf',
           size_bytes = $3,
           extracted_data = $4,
           extracted_at = NOW()
       WHERE id = $5
       RETURNING id`,
      [document.s3_key, document.s3_bucket, document.size_bytes || 0, JSON.stringify(extractedData), existing[0].id]
    );
    return rows[0];
  }

  const { rows } = await pool.query(
    `INSERT INTO engagement_letters (firm_id, relationship_id, display_name, s3_key, s3_bucket, mime_type, size_bytes, status, extracted_data, extracted_at, created_by)
     VALUES ($1, $2, $3, $4, $5, 'application/pdf', $6, 'active', $7, NOW(), $8)
     RETURNING id`,
    [firmId, relationshipId, displayName, document.s3_key, document.s3_bucket, document.size_bytes || 0, JSON.stringify(extractedData), userId || null]
  );
  return rows[0];
}

async function saveSignedProposalEngagementLetter(proposalId, firmId, { userId = null, baseUrl = null } = {}) {
  const eng = await loadSignedProposalEngagement(proposalId, firmId);
  if (!eng) return { ok: false, status: 'not_signed', reason: 'Signed engagement not found' };
  if (!eng.relationship_id) return { ok: false, status: 'no_relationship', reason: 'No relationship linked to this proposal' };

  const resolved = await resolveProposalPrimaryPerson(proposalId, firmId, { createIfMissing: true });
  if (!resolved.ok) return { ok: false, status: resolved.status, reason: resolved.reason };

  const person = resolved.person;
  const displayName = proposalDisplayName(eng);
  let document = await findExistingEngagementDocument({ firmId, personId: person.id, displayName });
  let reusedDocument = true;

  if (!document) {
    reusedDocument = false;
    const appUrl = (baseUrl || process.env.APP_URL || 'http://localhost:8080').replace(/\/+$/, '');
    const pageUrl = `${appUrl}/p/${eng.public_token}/sign?pdf=1`;
    const pdfResult = await generatePDF(null, pageUrl);
    const pdfBuffer = Buffer.isBuffer(pdfResult) ? pdfResult : Buffer.from(pdfResult);
    const filename = sanitizeFilename(displayName);
    const key = buildKey({
      firmId,
      ownerType: 'person',
      ownerId: person.id,
      year: '',
      docType: 'engagement_letter',
      filename,
    });

    await uploadFile({ firmId: firmId, buffer: pdfBuffer, key, bucket: BUCKET, mimeType: 'application/pdf' });

    const { rows } = await pool.query(
      `INSERT INTO documents
         (firm_id, owner_type, owner_id, year, doc_type, display_name,
          s3_bucket, s3_key, mime_type, size_bytes, uploaded_by_type, uploaded_by_id,
          folder_section, folder_category, is_delivered, delivered_at, created_at)
       VALUES ($1, 'person', $2, '', 'engagement_letter', $3,
               $4, $5, 'application/pdf', $6, 'system', $7,
               'firm_uploaded', 'engagement_letter', true, NOW(), NOW())
       RETURNING *`,
      [firmId, person.id, displayName, BUCKET, key, pdfBuffer.length, userId || null]
    );
    document = rows[0];
  }

  const letter = await upsertEngagementLetterRecord({
    firmId,
    relationshipId: eng.relationship_id,
    displayName,
    document,
    eng,
    userId,
  });

  await pool.query('UPDATE proposal_engagements SET saved_to_crm = true WHERE id = $1', [eng.engagement_id_val]);

  return {
    ok: true,
    status: reusedDocument ? 'existing_document' : 'saved',
    proposalId,
    personId: person.id,
    relationshipId: eng.relationship_id,
    documentId: document.id,
    engagementLetterId: letter.id,
    displayName,
    reusedDocument,
  };
}

module.exports = {
  saveSignedProposalEngagementLetter,
  ensureEngagementLettersTable,
};
