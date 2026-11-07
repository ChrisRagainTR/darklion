'use strict';
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { enqueueSummary } = require('../services/summaryJobs');
const { getFirmPreferences } = require('../services/firmPreferences');
const { summaryVisibility, filterSummary } = require('../services/summaryVisibility');

function parseStaffUserId(value) {
  const id = parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function apiTokenCanReadSummaries(req) {
  const scopes = req.firm?.tokenScopes || {};
  return scopes.general_api !== false && scopes.summaries_read !== false;
}

async function getScopedSummaryStaffUserId(req, res) {
  if (req.firm?.userId) return req.firm.userId;

  if (!req.firm?.isApiToken) return null;
  if (!apiTokenCanReadSummaries(req)) {
    res.status(403).json({ error: 'API key is not enabled for summary access' });
    return null;
  }

  const staffUserId = parseStaffUserId(req.query.staff_user_id || req.body?.staff_user_id);
  if (!staffUserId) {
    res.status(400).json({ error: 'staff_user_id is required for API-token summary access' });
    return null;
  }

  const { rows } = await pool.query(
    'SELECT id FROM firm_users WHERE firm_id = $1 AND id = $2 AND accepted_at IS NOT NULL AND archived_at IS NULL LIMIT 1',
    [req.firm.id, staffUserId]
  );
  if (!rows.length) {
    res.status(403).json({ error: 'staff_user_id is not a valid staff user for this firm' });
    return null;
  }

  return staffUserId;
}

// GET /api/summaries?month=2026-03 - calendar data for a month
// Returns array of { date, viewed, thread_count }
router.get('/', async (req, res) => {
  const firmId = req.firm.id;
  const month = req.query.month || new Date().toISOString().slice(0, 7); // YYYY-MM

  try {
    const scopedStaffUserId = await getScopedSummaryStaffUserId(req, res);
    if (!scopedStaffUserId) return;
    const visibility = await summaryVisibility(firmId, scopedStaffUserId);

    const { rows } = await pool.query(`
      SELECT
        cs.summary_date::text as date,
        cs.summary_json,
        EXISTS(SELECT 1 FROM summary_views sv WHERE sv.firm_id=$1 AND sv.summary_date=cs.summary_date AND sv.firm_user_id=$2) as viewed
      FROM conversation_summaries cs
      WHERE cs.firm_id = $1
        AND TO_CHAR(cs.summary_date, 'YYYY-MM') = $3
      ORDER BY cs.summary_date DESC
    `, [firmId, scopedStaffUserId, month]);

    res.json(rows
      .map(row => ({
        date: row.date,
        viewed: row.viewed,
        thread_count: filterSummary(row.summary_json, scopedStaffUserId, visibility).thread_count,
      }))
      .filter(row => row.thread_count > 0)
    );
  } catch(err) {
    console.error('[GET /summaries] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/summaries/generate - manually trigger for a date (owner only)
router.post('/generate', async (req, res) => {
  if (req.firm.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  const firmId = req.firm.id;
  const date = req.body.date || new Date().toISOString().slice(0, 10);

  try {
    if(!(await getFirmPreferences(firmId)).aiEnabled)return res.status(403).json({error:'AI is disabled for this firm'});
    const job = await enqueueSummary(firmId, date);
    res.status(202).json({ ok: true, job });
  } catch(err) {
    console.error('[POST /summaries/generate] error:', err);
    res.status(500).json({ error: err.message });
  }
});
router.get('/jobs/:id',async(req,res)=>{
  if(req.firm.role!=='owner')return res.status(403).json({error:'Owner only'});
  try{const row=(await pool.query('SELECT id,status,attempts,updated_at FROM summary_jobs WHERE id=$1 AND firm_id=$2',[req.params.id,req.firm.id])).rows[0];res.status(row?200:404).json(row||{error:'Job not found'});}catch(_){res.status(400).json({error:'Invalid job'});}
});

// GET /api/summaries/:date - full summary for a specific date
// Also marks as viewed for this user
router.get('/:date', async (req, res) => {
  const firmId = req.firm.id;
  const date = req.params.date; // YYYY-MM-DD

  try {
    const scopedStaffUserId = await getScopedSummaryStaffUserId(req, res);
    if (!scopedStaffUserId) return;

    const { rows } = await pool.query(
      'SELECT * FROM conversation_summaries WHERE firm_id=$1 AND summary_date=$2',
      [firmId, date]
    );

    if (!rows.length) return res.status(404).json({ error: 'No summary for this date' });

    // Mark as viewed for the scoped staff user. API tokens read as that staff user's agent.
    if (!req.firm.supportSession) await pool.query(`
      INSERT INTO summary_views (firm_id, summary_date, firm_user_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (firm_id, summary_date, firm_user_id) DO NOTHING
    `, [firmId, date, scopedStaffUserId]);

    // Filter out the scoped user's own threads from the response —
    // "I can see everyone else's summaries, but my own threads are in My Inbox"
    const row = rows[0];
    const filtered = filterSummary(row.summary_json, scopedStaffUserId, await summaryVisibility(firmId, scopedStaffUserId));
    return res.json({ ...row, summary_json: filtered });
  } catch(err) {
    console.error('[GET /summaries/:date] error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
