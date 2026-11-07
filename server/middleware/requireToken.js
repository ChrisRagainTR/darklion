'use strict';
const crypto = require('crypto');
const { pool } = require('../db');

async function requireToken(req, res, next) {
  // Already authenticated via JWT? Skip.
  if (req.firm) return next();

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!token || !token.startsWith('dlk_')) return next(); // not a DarkLion API key, skip

  const hash = crypto.createHash('sha256').update(token).digest('hex');

  try {
    const { rows } = await pool.query(
      `SELECT at.firm_id, at.id as token_id, at.name AS token_name, at.staff_user_id, at.scopes,
              f.name as firm_name, f.slug,
              fu.id AS active_staff_user_id
       FROM api_tokens at
       JOIN firms f ON f.id = at.firm_id
       LEFT JOIN firm_users fu ON fu.id = at.staff_user_id
        AND fu.firm_id = at.firm_id
        AND fu.accepted_at IS NOT NULL
        AND fu.archived_at IS NULL
       WHERE at.token_hash = $1`,
      [hash]
    );
    if (!rows[0]) return res.status(401).json({ error: 'Invalid API token' });
    if (rows[0].staff_user_id && !rows[0].active_staff_user_id) {
      return res.status(401).json({ error: 'API token staff scope is inactive' });
    }

    // Update last_used_at async (non-blocking)
    pool.query('UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1', [rows[0].token_id]).catch(() => {});

    // Set req.firm to match the JWT middleware shape
    req.firm = {
      id: rows[0].firm_id,
      userId: rows[0].staff_user_id || null,
      role: 'api',
      firmName: rows[0].firm_name,
      isApiToken: true,
      tokenId: rows[0].token_id,
      tokenName: rows[0].token_name,
      tokenScopes: rows[0].scopes || {},
    };
    next();
  } catch (err) {
    console.error('[requireToken] error:', err);
    return res.status(500).json({ error: 'Token authentication failed' });
  }
}

module.exports = { requireToken };
