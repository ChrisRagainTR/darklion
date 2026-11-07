'use strict';

const { pool } = require('../db');

const DEFAULT_FEATURES = Object.freeze({ embedded_chat: true });

function validFirmId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('A valid firm ID is required');
  return id;
}

async function getFirmFeatures(firmId, db = pool) {
  const { rows } = await db.query(
    `SELECT flags.feature_key, flags.enabled
     FROM firms f LEFT JOIN firm_feature_flags flags ON flags.firm_id = f.id
     WHERE f.id = $1`, [validFirmId(firmId)]
  );
  if (!rows.length) throw new Error('Firm not found');
  const features = { ...DEFAULT_FEATURES };
  for (const row of rows) {
    if (Object.hasOwn(DEFAULT_FEATURES, row.feature_key)) features[row.feature_key] = row.enabled === true;
  }
  return features;
}

// Called by the operator command only, never by a customer-facing write route.
// Compare the previous effective value so stale commands cannot undo a rollout.
async function setFirmFeature({ firmId, feature, enabled, expected, reason }, db = pool) {
  firmId = validFirmId(firmId);
  if (!Object.hasOwn(DEFAULT_FEATURES, feature)) throw new Error('Unknown feature');
  if (typeof enabled !== 'boolean' || typeof expected !== 'boolean') throw new Error('Enabled and expected must be booleans');
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw new Error('A reason of 1-500 characters is required');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const firm = await client.query('SELECT id FROM firms WHERE id=$1 FOR UPDATE', [firmId]);
    if (!firm.rowCount) throw new Error('Firm not found');
    const before = (await getFirmFeatures(firmId, client))[feature];
    if (before !== expected) throw new Error('Feature changed since inspection; read it again');
    if (before !== enabled) {
      await client.query(`INSERT INTO firm_feature_flags (firm_id,feature_key,enabled)
        VALUES ($1,$2,$3) ON CONFLICT (firm_id,feature_key)
        DO UPDATE SET enabled=EXCLUDED.enabled, updated_at=NOW()`, [firmId, feature, enabled]);
      await client.query('INSERT INTO audit_log (firm_id,action,detail) VALUES ($1,$2,$3)',
        [firmId, 'firm_feature_changed', JSON.stringify({ feature, before, enabled, reason: reason.trim() })]);
    }
    await client.query('COMMIT');
    return { firmId, feature, before, enabled, changed: before !== enabled };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

function requireFirmFeature(feature) {
  if (!Object.hasOwn(DEFAULT_FEATURES, feature)) throw new Error('Unknown feature');
  return async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!(await getFirmFeatures(req.firm?.id))[feature]) {
        return res.status(404).json({ error: 'Feature unavailable', code: 'FEATURE_DISABLED' });
      }
      next();
    } catch (_) {
      res.status(503).json({ error: 'Feature configuration unavailable' });
    }
  };
}

module.exports = { DEFAULT_FEATURES, getFirmFeatures, setFirmFeature, requireFirmFeature };
