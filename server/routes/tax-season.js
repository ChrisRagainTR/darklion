'use strict';

/**
 * tax-season.js — Tax Season visibility API routes
 *
 * GET  /api/tax-season/clients        — list all people with organizer_visible + organizer status
 * POST /api/tax-season/bulk           — { visible: true|false } — set for ALL people in firm
 * POST /api/tax-season/person/:personId — { visible: true|false } — set for one person
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireFirm } = require('../middleware/requireFirm');

// GET /api/tax-season/clients
router.get('/clients', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  try {
    const firmRes = await pool.query(
      'SELECT active_tax_year FROM firms WHERE id = $1',
      [firmId]
    );
    const taxYear = firmRes.rows[0]?.active_tax_year || '2025';

    const { rows } = await pool.query(`
      SELECT
        p.id,
        p.first_name,
        p.last_name,
        p.spouse_name,
        p.email,
        p.organizer_visible,
        p.personal_tax_engaged,
        o.status AS organizer_status
      FROM people p
      LEFT JOIN tax_organizers o ON o.person_id = p.id AND o.tax_year = $2
      WHERE p.firm_id = $1
      ORDER BY p.last_name ASC, p.first_name ASC
    `, [firmId, taxYear]);

    res.json({ clients: rows, taxYear });
  } catch (err) {
    console.error('GET /api/tax-season/clients error:', err);
    res.status(500).json({ error: 'Failed to fetch clients' });
  }
});

// POST /api/tax-season/bulk
router.post('/bulk', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  const { visible } = req.body;

  if (typeof visible !== 'boolean') {
    return res.status(400).json({ error: 'visible must be a boolean' });
  }

  try {
    await pool.query(
      'UPDATE people SET organizer_visible = $1 WHERE firm_id = $2 AND personal_tax_engaged = TRUE',
      [visible, firmId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/tax-season/bulk error:', err);
    res.status(500).json({ error: 'Failed to update visibility' });
  }
});

// POST /api/tax-season/person/:personId
router.post('/person/:personId', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  const { personId } = req.params;
  const { visible } = req.body;

  if (typeof visible !== 'boolean') {
    return res.status(400).json({ error: 'visible must be a boolean' });
  }

  try {
    const result = await pool.query(
      'UPDATE people SET organizer_visible = $1 WHERE id = $2 AND firm_id = $3 RETURNING id',
      [visible, parseInt(personId), firmId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Person not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/tax-season/person error:', err);
    res.status(500).json({ error: 'Failed to update visibility' });
  }
});

// PUT /api/tax-season/year
router.put('/year', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  const { year } = req.body;

  if (!year || !/^\d{4}$/.test(String(year))) {
    return res.status(400).json({ error: 'Year must be a 4-digit number' });
  }

  try {
    await pool.query(
      'UPDATE firms SET active_tax_year = $1 WHERE id = $2',
      [String(year), firmId]
    );
    res.json({ success: true, year: String(year) });
  } catch (err) {
    console.error('PUT /api/tax-season/year error:', err);
    res.status(500).json({ error: 'Failed to update tax year' });
  }
});

module.exports = router;
