const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// All routes require staff auth (requireFirm middleware applied at mount point)

// GET / — list all templates for firm
router.get('/', async (req, res) => {
  const firmId = req.firm.id;
  try {
    const { rows } = await pool.query(
      `SELECT id, name, body, created_by, created_at, updated_at
       FROM message_templates
       WHERE firm_id = $1
       ORDER BY name ASC`,
      [firmId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[GET /api/templates] error:', err);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

// POST / — create template
router.post('/', async (req, res) => {
  const firmId = req.firm.id;
  const userId = req.firm.userId;
  const { name, body } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!body || !body.trim()) return res.status(400).json({ error: 'Body is required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO message_templates (firm_id, name, body, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [firmId, name.trim(), body.trim(), userId || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[POST /api/templates] error:', err);
    res.status(500).json({ error: 'Failed to create template' });
  }
});

// PUT /:id — update template
router.put('/:id', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;
  const { name, body } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!body || !body.trim()) return res.status(400).json({ error: 'Body is required' });
  try {
    const { rows } = await pool.query(
      `UPDATE message_templates
       SET name = $1, body = $2, updated_at = NOW()
       WHERE id = $3 AND firm_id = $4
       RETURNING *`,
      [name.trim(), body.trim(), id, firmId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Template not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[PUT /api/templates/:id] error:', err);
    res.status(500).json({ error: 'Failed to update template' });
  }
});

// DELETE /:id — delete template
router.delete('/:id', async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM message_templates WHERE id = $1 AND firm_id = $2',
      [id, firmId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Template not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /api/templates/:id] error:', err);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

module.exports = router;
