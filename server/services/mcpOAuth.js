'use strict';

const crypto = require('crypto');
const { pool } = require('../db');

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

class OAuthError extends Error {
  constructor(code, description, status = 400) {
    super(description);
    this.name = 'OAuthError';
    this.code = code;
    this.status = status;
  }
}

function hashToken(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomToken(prefix) {
  return `${prefix}${crypto.randomBytes(32).toString('base64url')}`;
}

function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

async function assertActiveStaff(db, firmId, staffUserId) {
  const { rows } = await db.query(
    `SELECT fu.role
       FROM firm_users fu
       JOIN firms f ON f.id = fu.firm_id
      WHERE fu.id = $1 AND fu.firm_id = $2
        AND fu.accepted_at IS NOT NULL AND fu.archived_at IS NULL
      LIMIT 1`,
    [staffUserId, firmId]
  );
  if (!rows[0]) throw new OAuthError('invalid_grant', 'The authorizing staff account is inactive.', 401);
  return rows[0];
}

async function insertTokenPair(db, grant) {
  const accessToken = randomToken('dlo_at_');
  const refreshToken = randomToken('dlo_rt_');
  const familyId = grant.refreshFamilyId || crypto.randomUUID();

  await db.query(
    `INSERT INTO mcp_oauth_access_tokens
       (token_hash, client_id, resource, firm_id, staff_user_id, scopes, refresh_family_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + ($8 * INTERVAL '1 second'))`,
    [hashToken(accessToken), grant.clientId, grant.resource, grant.firmId, grant.staffUserId,
      grant.scopes, familyId, ACCESS_TOKEN_TTL_SECONDS]
  );
  await db.query(
    `INSERT INTO mcp_oauth_refresh_tokens
       (token_hash, refresh_family_id, client_id, resource, firm_id, staff_user_id, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + ($8 * INTERVAL '1 second'))`,
    [hashToken(refreshToken), familyId, grant.clientId, grant.resource, grant.firmId,
      grant.staffUserId, grant.scopes, REFRESH_TOKEN_TTL_SECONDS]
  );

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: grant.scopes.join(' '),
  };
}

async function redeemMcpAuthorizationCode(rawCode, clientId, redirectUri, resource, verifier) {
  if (!rawCode || !verifier) throw new OAuthError('invalid_grant', 'Authorization code and code_verifier are required.');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows } = await db.query('SELECT * FROM mcp_oauth_codes WHERE code_hash = $1 FOR UPDATE', [hashToken(rawCode)]);
    const grant = rows[0];
    const challengeMatches = grant && /^[A-Za-z0-9._~-]{43,128}$/.test(verifier)
      && pkceChallenge(verifier) === grant.code_challenge;
    if (!grant || grant.consumed_at || new Date(grant.expires_at) <= new Date()
        || grant.client_id !== clientId || grant.redirect_uri !== redirectUri
        || grant.resource !== resource || !challengeMatches) {
      throw new OAuthError('invalid_grant', 'Authorization code is invalid, expired, or already used.');
    }
    await assertActiveStaff(db, grant.firm_id, grant.staff_user_id);
    await db.query('UPDATE mcp_oauth_codes SET consumed_at = NOW() WHERE code_hash = $1', [hashToken(rawCode)]);
    const tokens = await insertTokenPair(db, {
      clientId: grant.client_id,
      resource: grant.resource,
      firmId: grant.firm_id,
      staffUserId: grant.staff_user_id,
      scopes: grant.scopes,
    });
    await db.query('COMMIT');
    return tokens;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}

async function rotateMcpRefreshToken(rawToken, clientId, resource) {
  if (!rawToken) throw new OAuthError('invalid_grant', 'Refresh token is required.');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows } = await db.query(
      `SELECT * FROM mcp_oauth_refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
      [hashToken(rawToken)]
    );
    const grant = rows[0];
    if (!grant || grant.client_id !== clientId || grant.resource !== resource) {
      throw new OAuthError('invalid_grant', 'Refresh token is invalid.');
    }
    if (grant.consumed_at || grant.revoked_at) {
      await db.query(
        'UPDATE mcp_oauth_refresh_tokens SET revoked_at = COALESCE(revoked_at, NOW()) WHERE refresh_family_id = $1',
        [grant.refresh_family_id]
      );
      await db.query(
        'UPDATE mcp_oauth_access_tokens SET revoked_at = COALESCE(revoked_at, NOW()) WHERE refresh_family_id = $1',
        [grant.refresh_family_id]
      );
      await db.query('COMMIT');
      throw new OAuthError('invalid_grant', 'Refresh token replay detected. Reauthorization is required.');
    }
    if (new Date(grant.expires_at) <= new Date()) {
      throw new OAuthError('invalid_grant', 'Refresh token is expired.');
    }
    await assertActiveStaff(db, grant.firm_id, grant.staff_user_id);
    await db.query('UPDATE mcp_oauth_refresh_tokens SET consumed_at = NOW() WHERE token_hash = $1', [hashToken(rawToken)]);
    const tokens = await insertTokenPair(db, {
      clientId: grant.client_id,
      resource: grant.resource,
      firmId: grant.firm_id,
      staffUserId: grant.staff_user_id,
      scopes: grant.scopes,
      refreshFamilyId: grant.refresh_family_id,
    });
    await db.query('COMMIT');
    return tokens;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}

async function authenticateMcpAccessToken(rawToken) {
  if (!rawToken || !rawToken.startsWith('dlo_at_')) {
    throw new OAuthError('invalid_token', 'Bearer token is missing or invalid.', 401);
  }
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT t.client_id, t.resource, t.firm_id, t.staff_user_id, t.scopes, t.expires_at, fu.role
         FROM mcp_oauth_access_tokens t
         JOIN firm_users fu ON fu.id = t.staff_user_id AND fu.firm_id = t.firm_id
         JOIN firms f ON f.id = t.firm_id
        WHERE t.token_hash = $1 AND t.expires_at > NOW() AND t.revoked_at IS NULL
          AND fu.accepted_at IS NOT NULL AND fu.archived_at IS NULL
        LIMIT 1`,
      [hashToken(rawToken)]
    ));
  } catch (_) {
    throw new OAuthError('temporarily_unavailable', 'Token validation is temporarily unavailable.', 503);
  }
  const token = rows[0];
  if (!token) throw new OAuthError('invalid_token', 'Bearer token is expired, revoked, or invalid.', 401);
  return {
    firmId: token.firm_id,
    staffUserId: token.staff_user_id,
    role: token.role,
    scopes: token.scopes,
    clientId: token.client_id,
    resource: token.resource,
    expiresAt: Math.floor(new Date(token.expires_at).getTime() / 1000),
  };
}

module.exports = {
  OAuthError,
  authenticateMcpAccessToken,
  hashToken,
  pkceChallenge,
  redeemMcpAuthorizationCode,
  rotateMcpRefreshToken,
};
