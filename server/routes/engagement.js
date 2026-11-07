'use strict';

const { Router } = require('express');
const multer = require('multer');
const { pool } = require('../db');
const { uploadFile, downloadFile, getSignedDownloadUrl, buildKey, sanitizeFilename } = require('../services/s3');
const { extractEngagementLetter } = require('../services/claude');

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const BUCKET = process.env.AWS_S3_BUCKET || 'darklion-s3';

// Auto-create table on first use
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS engagement_letters (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL,
      relationship_id INTEGER NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL DEFAULT '',
      s3_key TEXT NOT NULL,
      s3_bucket TEXT NOT NULL,
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

// GET /:relId — list all engagement letters for a relationship
router.get('/:relId', async (req, res) => {
  const firmId = req.firm.id;
  const { relId } = req.params;
  try {
    await ensureTable();
    const { rows: rel } = await pool.query('SELECT id FROM relationships WHERE id = $1 AND firm_id = $2', [relId, firmId]);
    if (!rel.length) return res.status(404).json({ error: 'Relationship not found' });
    const { rows } = await pool.query(
      `SELECT id, display_name, status, extracted_data, extracted_at, retired_at, size_bytes, created_at
       FROM engagement_letters WHERE relationship_id = $1 AND firm_id = $2
       ORDER BY status ASC, created_at DESC`,
      [relId, firmId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /engagement/:relId error:', err);
    res.status(500).json({ error: 'Failed to fetch engagement letters' });
  }
});

// POST /:relId/upload — upload PDF and auto-extract
router.post('/:relId/upload', upload.single('file'), async (req, res) => {
  const firmId = req.firm.id;
  const userId = req.firm.userId;
  const { relId } = req.params;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!req.file.mimetype.includes('pdf')) return res.status(400).json({ error: 'Only PDF files accepted' });

  try {
    await ensureTable();
    const { rows: rel } = await pool.query('SELECT id FROM relationships WHERE id = $1 AND firm_id = $2', [relId, firmId]);
    if (!rel.length) return res.status(404).json({ error: 'Relationship not found' });

    // Upload to S3
    const ext = 'pdf';
    const safeName = sanitizeFilename(req.file.originalname.replace(/\.pdf$/i, ''));
    const key = buildKey({firmId,ownerType:'relationship',ownerId:relId,docType:'engagement',filename:safeName+'.'+ext});
    await uploadFile({ firmId: firmId, buffer: req.file.buffer, key, bucket: BUCKET, mimeType: 'application/pdf' });

    const displayName = req.file.originalname.replace(/\.pdf$/i, '').replace(/_/g, ' ');

    // Enforce 6-letter limit per relationship
    const { rows: countRows } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM engagement_letters WHERE relationship_id = $1 AND firm_id = $2',
      [relId, firmId]
    );
    if (countRows[0].count >= 6) {
      return res.status(400).json({ error: 'Maximum of 6 engagement letters per relationship. Retire existing letters before uploading new ones.' });
    }

    // Insert record immediately so we can return an id
    const { rows } = await pool.query(`
      INSERT INTO engagement_letters (firm_id, relationship_id, display_name, s3_key, s3_bucket, mime_type, size_bytes, status, created_by)
      VALUES ($1, $2, $3, $4, $5, 'application/pdf', $6, 'active', $7)
      RETURNING *
    `, [firmId, relId, displayName, key, BUCKET, req.file.size, userId || null]);
    const letter = rows[0];

    // Async: extract data with Claude (don't block response)
    setImmediate(async () => {
      try {
        const pdfBuffer = req.file.buffer;
        const extracted = await extractEngagementLetter(pdfBuffer, firmId);
        await pool.query(
          'UPDATE engagement_letters SET extracted_data = $1, extracted_at = NOW() WHERE id = $2',
          [JSON.stringify(extracted), letter.id]
        );
      } catch (e) {
        console.error('[engagement] AI extraction failed for letter', letter.id, e.message);
        await pool.query(
          "UPDATE engagement_letters SET extracted_data = $1, extracted_at = NOW() WHERE id = $2",
          [JSON.stringify({ error: e.message, ai_summary: 'Extraction failed — please review manually.' }), letter.id]
        );
      }
    });

    res.status(201).json({ ...letter, extracting: true });
  } catch (err) {
    console.error('POST /engagement/:relId/upload error:', err);
    res.status(500).json({ error: 'Failed to upload engagement letter' });
  }
});

// POST /:relId/:id/retire — retire an engagement letter
router.post('/:relId/:id/retire', async (req, res) => {
  const firmId = req.firm.id;
  const userId = req.firm.userId;
  const { relId, id } = req.params;
  try {
    const { rows } = await pool.query(
      `UPDATE engagement_letters SET status = 'retired', retired_at = NOW(), retired_by = $1
       WHERE id = $2 AND relationship_id = $3 AND firm_id = $4
       RETURNING id, status, retired_at`,
      [userId || null, id, relId, firmId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Letter not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('POST /engagement/:relId/:id/retire error:', err);
    res.status(500).json({ error: 'Failed to retire engagement letter' });
  }
});

// POST /:relId/:id/reactivate — un-retire
router.post('/:relId/:id/reactivate', async (req, res) => {
  const firmId = req.firm.id;
  const { relId, id } = req.params;
  try {
    const { rows } = await pool.query(
      `UPDATE engagement_letters SET status = 'active', retired_at = NULL, retired_by = NULL
       WHERE id = $1 AND relationship_id = $2 AND firm_id = $3 RETURNING id, status`,
      [id, relId, firmId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Letter not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to reactivate' });
  }
});

// GET /:relId/:id/url — get signed download URL
router.get('/:relId/:id/url', async (req, res) => {
  const firmId = req.firm.id;
  const { relId, id } = req.params;
  try {
    const { rows } = await pool.query(
      'SELECT s3_key, s3_bucket FROM engagement_letters WHERE id = $1 AND relationship_id = $2 AND firm_id = $3',
      [id, relId, firmId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const url = await getSignedDownloadUrl({ key: rows[0].s3_key, bucket: rows[0].s3_bucket });
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get download URL' });
  }
});

// POST /:relId/:id/re-extract — re-run AI extraction on existing letter
router.post('/:relId/:id/re-extract', async (req, res) => {
  const firmId = req.firm.id;
  const { relId, id } = req.params;
  try {
    const { rows } = await pool.query(
      'SELECT id, s3_key, s3_bucket FROM engagement_letters WHERE id = $1 AND relationship_id = $2 AND firm_id = $3',
      [id, relId, firmId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const letter = rows[0];

    // Reset extracted_data
    await pool.query('UPDATE engagement_letters SET extracted_data = NULL, extracted_at = NULL WHERE id = $1', [id]);

    // Re-download and extract async
    setImmediate(async () => {
      try {
        const buffer = await downloadFile({ key: letter.s3_key, bucket: letter.s3_bucket });
        const extracted = await extractEngagementLetter(buffer, firmId);
        await pool.query(
          'UPDATE engagement_letters SET extracted_data = $1, extracted_at = NOW() WHERE id = $2',
          [JSON.stringify(extracted), letter.id]
        );
      } catch(e) {
        console.error('[engagement] re-extraction failed for letter', letter.id, e.message);
        await pool.query(
          "UPDATE engagement_letters SET extracted_data = $1, extracted_at = NOW() WHERE id = $2",
          [JSON.stringify({ error: e.message, ai_summary: 'Re-extraction failed.' }), letter.id]
        );
      }
    });

    res.json({ ok: true, extracting: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /:relId/:id/extracted — poll for extracted data (client polls after upload)
router.get('/:relId/:id/extracted', async (req, res) => {
  const firmId = req.firm.id;
  const { relId, id } = req.params;
  try {
    const { rows } = await pool.query(
      'SELECT id, extracted_data, extracted_at, status FROM engagement_letters WHERE id = $1 AND relationship_id = $2 AND firm_id = $3',
      [id, relId, firmId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to poll' });
  }
});

module.exports = router;
