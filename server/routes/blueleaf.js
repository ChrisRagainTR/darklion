'use strict';

const { Router } = require('express');
const { pool } = require('../db');
const blueleafService = require('../services/blueleaf');

const router = Router();
const activeSyncs = new Map();

function syncKey(firmId, personId) {
  return `${firmId}:${personId}`;
}

function startBackgroundPersonSync({ token, personId, householdId, firmId }) {
  const key = syncKey(firmId, personId);
  if (activeSyncs.has(key)) return { started: false, alreadyRunning: true };

  activeSyncs.set(key, { startedAt: new Date() });
  setImmediate(async () => {
    try {
      await blueleafService.syncPerson(token, personId, householdId, firmId, pool);
      console.log(`[blueleaf] Background sync complete for person ${personId}`);
    } catch (e) {
      console.error(`[blueleaf] Background sync failed for person ${personId}:`, e.message);
    } finally {
      activeSyncs.delete(key);
    }
  });

  return { started: true, alreadyRunning: false };
}

// GET /api/blueleaf/households — list all Blueleaf households
router.get('/blueleaf/households', async (req, res) => {
  const { rows: firmRows } = await pool.query('SELECT blueleaf_api_token FROM firms WHERE id = $1', [req.firm.id]);
  const token = require('../utils/encryption').decrypt(firmRows[0]?.blueleaf_api_token) || '';
  if (!token) return res.status(503).json({ error: 'Blueleaf not configured' });
  try {
    const households = await blueleafService.fetchHouseholds(token);
    res.json(households);
  } catch (err) {
    console.error('Blueleaf households error:', err.message);
    res.status(502).json({ error: 'Failed to fetch Blueleaf households: ' + err.message });
  }
});

// POST /api/people/:id/financial-planning/enable — enable FP + set household
router.post('/people/:id/financial-planning/enable', async (req, res) => {
  const personId = parseInt(req.params.id);
  const { blueleaf_household_id } = req.body;
  if (!blueleaf_household_id) return res.status(400).json({ error: 'blueleaf_household_id required' });

  try {
    // Verify person belongs to this firm
    const check = await pool.query(
      'SELECT id FROM people WHERE id = $1 AND firm_id = $2',
      [personId, req.firm.id]
    );
    if (!check.rows[0]) return res.status(404).json({ error: 'Person not found' });

    await pool.query(
      `UPDATE people SET financial_planning_enabled = TRUE, blueleaf_household_id = $1 WHERE id = $2`,
      [blueleaf_household_id, personId]
    );

    // Trigger an immediate background sync without holding the HTTP request open.
    const { rows: firmRows } = await pool.query('SELECT blueleaf_api_token FROM firms WHERE id = $1', [req.firm.id]);
    const token = require('../utils/encryption').decrypt(firmRows[0]?.blueleaf_api_token) || '';
    const sync = token
      ? startBackgroundPersonSync({ token, personId, householdId: blueleaf_household_id, firmId: req.firm.id })
      : { started: false, alreadyRunning: false };

    res.status(sync.started || sync.alreadyRunning ? 202 : 200).json({ ok: true, sync });
  } catch (err) {
    console.error('Enable financial planning error:', err.message);
    res.status(500).json({ error: 'Failed to enable financial planning' });
  }
});

// DELETE /api/people/:id/financial-planning — disable FP
router.delete('/people/:id/financial-planning', async (req, res) => {
  const personId = parseInt(req.params.id);
  try {
    const check = await pool.query(
      'SELECT id FROM people WHERE id = $1 AND firm_id = $2',
      [personId, req.firm.id]
    );
    if (!check.rows[0]) return res.status(404).json({ error: 'Person not found' });

    await pool.query(
      `UPDATE people SET financial_planning_enabled = FALSE, blueleaf_household_id = NULL WHERE id = $1`,
      [personId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Disable financial planning error:', err.message);
    res.status(500).json({ error: 'Failed to disable financial planning' });
  }
});

// GET /api/people/:id/investments — latest snapshot
router.get('/people/:id/investments', async (req, res) => {
  const personId = parseInt(req.params.id);
  try {
    const check = await pool.query(
      'SELECT id, financial_planning_enabled, blueleaf_household_id, blueleaf_hidden_accounts FROM people WHERE id = $1 AND firm_id = $2',
      [personId, req.firm.id]
    );
    if (!check.rows[0]) return res.status(404).json({ error: 'Person not found' });

    const person = check.rows[0];
    if (!person.financial_planning_enabled) return res.json({ enabled: false });

    const { rows } = await pool.query(
      `SELECT * FROM blueleaf_snapshots WHERE person_id = $1 ORDER BY snapshot_date DESC LIMIT 1`,
      [personId]
    );

    const hiddenAccounts = person.blueleaf_hidden_accounts || [];
    if (!rows[0]) return res.json({ enabled: true, snapshot: null, hiddenAccounts });
    res.json({ enabled: true, snapshot: rows[0], hiddenAccounts });
  } catch (err) {
    console.error('Get investments error:', err.message);
    res.status(500).json({ error: 'Failed to fetch investments' });
  }
});

// POST /api/people/:id/investments/sync — manual sync
router.post('/people/:id/investments/sync', async (req, res) => {
  const personId = parseInt(req.params.id);
  const { rows: firmRows } = await pool.query('SELECT blueleaf_api_token FROM firms WHERE id = $1', [req.firm.id]);
  const token = require('../utils/encryption').decrypt(firmRows[0]?.blueleaf_api_token) || '';
  if (!token) return res.status(503).json({ error: 'Blueleaf not configured' });

  try {
    const { rows } = await pool.query(
      'SELECT id, financial_planning_enabled, blueleaf_household_id FROM people WHERE id = $1 AND firm_id = $2',
      [personId, req.firm.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Person not found' });
    const person = rows[0];
    if (!person.financial_planning_enabled || !person.blueleaf_household_id) {
      return res.status(400).json({ error: 'Financial planning not enabled for this person' });
    }

    const sync = startBackgroundPersonSync({
      token,
      personId,
      householdId: person.blueleaf_household_id,
      firmId: req.firm.id,
    });
    res.status(sync.started || sync.alreadyRunning ? 202 : 200).json({ ok: true, sync });
  } catch (err) {
    console.error('Manual sync error:', err.message);
    res.status(500).json({ error: 'Sync failed: ' + err.message });
  }
});

// PATCH /api/people/:id/investments/hidden — save hidden account IDs
router.patch('/people/:id/investments/hidden', async (req, res) => {
  const personId = parseInt(req.params.id);
  const { hidden_accounts } = req.body; // array of account ID strings
  if (!Array.isArray(hidden_accounts)) return res.status(400).json({ error: 'hidden_accounts must be an array' });
  try {
    await pool.query(
      'UPDATE people SET blueleaf_hidden_accounts = $1 WHERE id = $2 AND firm_id = $3',
      [JSON.stringify(hidden_accounts), personId, req.firm.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save hidden accounts' });
  }
});

module.exports = router;
