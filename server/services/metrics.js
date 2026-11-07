'use strict';

// Firm-level metric cache — slow-to-compute numbers refreshed by cron and read
// by /api/dashboard/intel for instant page loads. New metric keys are added by
// implementing a compute function and adding it to METRIC_REFRESHERS.

const { pool } = require('../db');

async function readMetric(firmId, key) {
  const { rows } = await pool.query(
    `SELECT value, computed_at FROM firm_metrics WHERE firm_id = $1 AND metric_key = $2`,
    [firmId, key]
  );
  return rows[0] || null;
}

async function writeMetric(firmId, key, value) {
  await pool.query(
    `INSERT INTO firm_metrics (firm_id, metric_key, value, computed_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (firm_id, metric_key)
     DO UPDATE SET value = EXCLUDED.value, computed_at = NOW()`,
    [firmId, key, value]
  );
}

// ── MRR ──────────────────────────────────────────────────────────────────────
// Refreshes every relationship's mrr column via the existing syncAllMRR pager,
// then aggregates to the firm-level snapshot we cache here. Past-due is a
// separate small Stripe call per account (limited result set, fast).
async function computeMrrForFirm(firmId) {
  const { syncAllMRR } = require('./billingMrr');

  // Refresh per-relationship MRR (writes relationships.mrr)
  await syncAllMRR(firmId).catch(e =>
    console.error(`[metrics] syncAllMRR firm ${firmId}:`, e.message)
  );

  // Aggregate to firm-level total
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(mrr), 0)::float AS total FROM relationships WHERE firm_id = $1`,
    [firmId]
  );
  const mrr = Math.round((rows[0]?.total || 0) * 100) / 100;

  // Past-due check — single small Stripe query per account
  let pastDue = false;
  try {
    const Stripe = require('stripe');
    const STRIPE_KEYS = (await require('./firmIntegrations').stripeAccounts(firmId)).map(a=>a.key);
    for (const key of STRIPE_KEYS) {
      if (pastDue) break;
      const stripe = Stripe(key, { apiVersion: '2024-12-18.acacia' });
      try {
        const r = await stripe.subscriptions.list({ status: 'past_due', limit: 1 });
        if (r.data.length > 0) pastDue = true;
      } catch (e) {
        console.error('[metrics] past_due Stripe check:', e.message);
      }
    }
  } catch (e) {
    console.error('[metrics] past_due:', e.message);
  }

  const value = { mrr, past_due: pastDue };
  await writeMetric(firmId, 'mrr', value);
  return value;
}

const METRIC_REFRESHERS = {
  mrr: computeMrrForFirm,
};

async function refreshAll(firmId) {
  for (const [key, fn] of Object.entries(METRIC_REFRESHERS)) {
    try {
      await fn(firmId);
    } catch (e) {
      console.error(`[metrics] refresh ${key} firm ${firmId}:`, e.message);
    }
  }
}

async function refreshAllFirms() {
  const { rows: firms } = await pool.query('SELECT id FROM firms');
  for (const firm of firms) {
    await refreshAll(firm.id);
  }
}

module.exports = {
  readMetric,
  writeMetric,
  computeMrrForFirm,
  refreshAll,
  refreshAllFirms,
};
