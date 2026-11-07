'use strict';

const { pool } = require('../db');

// Refresh tokens for a company
async function refreshTokens(realmId) {
  const { rows } = await pool.query('SELECT * FROM companies WHERE realm_id = $1', [realmId]);
  const company = rows[0];
  if (!company) throw new Error(`Company ${realmId} not found`);

  const clientId = process.env.QB_CLIENT_ID;
  const clientSecret = process.env.QB_CLIENT_SECRET;

  const tokenRes = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      'Accept': 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: company.refresh_token,
    }),
  });

  if (!tokenRes.ok) {
    const errBody = await tokenRes.text().catch(() => '');
    // Clear tokens so the company shows as disconnected and prompts reconnect
    await pool.query(
      "UPDATE companies SET access_token = '', refresh_token = '', token_expires_at = 0 WHERE realm_id = $1",
      [realmId]
    );
    throw new Error(`QBO token refresh failed (${tokenRes.status}): ${errBody}`);
  }

  const tokens = await tokenRes.json();
  const expiresAt = Date.now() + tokens.expires_in * 1000;

  await pool.query(
    'UPDATE companies SET access_token = $1, refresh_token = $2, token_expires_at = $3 WHERE realm_id = $4',
    [tokens.access_token, tokens.refresh_token, expiresAt, realmId]
  );

  return tokens.access_token;
}

// Refresh all QBO tokens for all connected companies — call nightly to keep tokens alive
async function refreshAllTokens() {
  const { rows } = await pool.query(
    "SELECT realm_id, company_name FROM companies WHERE refresh_token IS NOT NULL AND refresh_token != '' AND access_token != ''"
  );
  const results = { refreshed: 0, failed: 0, errors: [] };
  for (const c of rows) {
    try {
      await refreshTokens(c.realm_id);
      results.refreshed++;
      console.log(`[qbo-refresh] Refreshed: ${c.company_name || c.realm_id}`);
    } catch (e) {
      results.failed++;
      results.errors.push({ realm_id: c.realm_id, company: c.company_name, error: e.message });
      console.error(`[qbo-refresh] Failed: ${c.company_name || c.realm_id} — ${e.message}`);
    }
  }
  return results;
}

// Get a valid access token, refreshing if needed
async function getAccessToken(realmId) {
  const { rows } = await pool.query('SELECT * FROM companies WHERE realm_id = $1', [realmId]);
  const company = rows[0];
  if (!company) throw new Error(`Company ${realmId} not found`);

  // Refresh if token expires within 5 minutes
  if (Date.now() > Number(company.token_expires_at) - 300000) {
    return refreshTokens(realmId);
  }

  return company.access_token;
}

module.exports = {
  refreshTokens,
  refreshAllTokens,
  getAccessToken,
};
