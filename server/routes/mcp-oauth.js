'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { requireFirm } = require('../middleware/requireFirm');
const {
  OAuthError,
  hashToken,
  redeemMcpAuthorizationCode,
  rotateMcpRefreshToken,
} = require('../services/mcpOAuth');

const router = Router();
const SUPPORTED_SCOPES = new Set(['darklion:read', 'darklion:write', 'darklion:communicate']);
const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: 'temporarily_unavailable', error_description: 'Too many registration requests.' },
});
const tokenLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: 'temporarily_unavailable', error_description: 'Too many token requests.' },
});

function publicOrigin() {
  const configured = process.env.PUBLIC_APP_URL || process.env.APP_URL || 'http://localhost:8080';
  const url = new URL(configured);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('PUBLIC_APP_URL must use HTTPS (HTTP is allowed only for loopback development).');
  }
  return url.origin;
}

function mcpResource() {
  return `${publicOrigin()}/mcp`;
}

function oauthError(res, error) {
  const isOAuthError = error instanceof OAuthError;
  const status = isOAuthError ? error.status : 500;
  const code = isOAuthError ? error.code : 'server_error';
  res.set('Cache-Control', 'no-store');
  if (status === 401) res.set('WWW-Authenticate', `Bearer error="${code}"`);
  return res.status(status).json({
    error: code,
    ...(isOAuthError && error.message ? { error_description: error.message } : {}),
  });
}

function parseScopes(value) {
  const scopes = [...new Set(String(value || 'darklion:read').trim().split(/\s+/).filter(Boolean))];
  if (!scopes.length || scopes.some(scope => !SUPPORTED_SCOPES.has(scope))) {
    throw new OAuthError('invalid_scope', 'Supported scopes are darklion:read, darklion:write, and darklion:communicate.');
  }
  if (scopes.includes('darklion:write') && !scopes.includes('darklion:read')) scopes.unshift('darklion:read');
  if (scopes.includes('darklion:communicate') && !scopes.includes('darklion:read')) scopes.unshift('darklion:read');
  return scopes;
}

function validateRedirectUri(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
    return !url.username && !url.password && !url.hash
      && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback));
  } catch (_) {
    return false;
  }
}

function addRedirectParams(redirectUri, params) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  }
  return url.toString();
}

async function registeredClient(clientId, redirectUri) {
  const { rows } = await pool.query(
    'SELECT client_id, client_name, redirect_uris FROM mcp_oauth_clients WHERE client_id = $1 LIMIT 1',
    [clientId]
  );
  const client = rows[0];
  if (!client || !Array.isArray(client.redirect_uris) || !client.redirect_uris.includes(redirectUri)) {
    throw new OAuthError('invalid_request', 'Unknown client or unregistered redirect_uri.');
  }
  return client;
}

function validateAuthorizationRequest(body) {
  if (body.response_type !== 'code') throw new OAuthError('unsupported_response_type', 'response_type must be code.');
  if (!body.client_id || !body.redirect_uri) throw new OAuthError('invalid_request', 'client_id and redirect_uri are required.');
  if (typeof body.state !== 'string' || !body.state || body.state.length > 1024) {
    throw new OAuthError('invalid_request', 'A nonempty state parameter is required.');
  }
  if (body.resource !== mcpResource()) throw new OAuthError('invalid_target', `resource must be ${mcpResource()}.`);
  if (body.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(body.code_challenge || '')) {
    throw new OAuthError('invalid_request', 'PKCE with code_challenge_method S256 is required.');
  }
  return parseScopes(body.scope);
}

function sendProtectedResourceMetadata(req, res) {
  res.json({
    resource: mcpResource(),
    authorization_servers: [publicOrigin()],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ['header'],
  });
}

router.get('/.well-known/oauth-protected-resource', sendProtectedResourceMetadata);
router.get('/.well-known/oauth-protected-resource/mcp', sendProtectedResourceMetadata);

router.get('/.well-known/oauth-authorization-server', (req, res) => {
  const issuer = publicOrigin();
  res.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...SUPPORTED_SCOPES],
  });
});

router.post('/oauth/register', registrationLimiter, async (req, res) => {
  try {
    const redirectUris = req.body && req.body.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length < 1 || redirectUris.length > 10
        || new Set(redirectUris).size !== redirectUris.length || redirectUris.some(uri => !validateRedirectUri(uri))) {
      throw new OAuthError('invalid_redirect_uri', 'Provide 1-10 unique HTTPS or loopback HTTP redirect_uris without fragments.');
    }
    if (req.body.token_endpoint_auth_method && req.body.token_endpoint_auth_method !== 'none') {
      throw new OAuthError('invalid_client_metadata', 'Only public clients using token_endpoint_auth_method none are supported.');
    }
    if (req.body.grant_types && (!Array.isArray(req.body.grant_types)
        || req.body.grant_types.some(type => !['authorization_code', 'refresh_token'].includes(type)))) {
      throw new OAuthError('invalid_client_metadata', 'Unsupported grant_types.');
    }
    if (req.body.response_types && (!Array.isArray(req.body.response_types)
        || req.body.response_types.some(type => type !== 'code'))) {
      throw new OAuthError('invalid_client_metadata', 'Only response_type code is supported.');
    }
    const clientId = `dlo_client_${crypto.randomBytes(18).toString('base64url')}`;
    const clientName = String(req.body.client_name || 'MCP client').trim().slice(0, 120) || 'MCP client';
    await pool.query(
      'INSERT INTO mcp_oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, $2, $3::jsonb)',
      [clientId, clientName, JSON.stringify(redirectUris)]
    );
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  } catch (error) {
    return oauthError(res, error);
  }
});

router.get('/oauth/authorize', async (req, res) => {
  try {
    const scopes = validateAuthorizationRequest(req.query);
    const client = await registeredClient(req.query.client_id, req.query.redirect_uri);
    res.set('Cache-Control', 'no-store');
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
    return res.render('mcp-authorize', {
      title: 'Authorize MCP Client',
      clientName: client.client_name,
      request: { ...req.query, scope: scopes.join(' ') },
    });
  } catch (error) {
    return oauthError(res, error);
  }
});

router.post('/oauth/authorize', requireFirm, async (req, res) => {
  try {
    const scopes = validateAuthorizationRequest(req.body);
    await registeredClient(req.body.client_id, req.body.redirect_uri);
    if (!req.firm.userId) throw new OAuthError('access_denied', 'A current staff login is required.', 403);
    if (req.body.decision !== 'allow') {
      return res.json({
        redirect_to: addRedirectParams(req.body.redirect_uri, {
          error: 'access_denied', state: req.body.state, iss: publicOrigin(),
        }),
      });
    }
    const code = `dlo_code_${crypto.randomBytes(32).toString('base64url')}`;
    await pool.query(
      `INSERT INTO mcp_oauth_codes
         (code_hash, client_id, redirect_uri, resource, firm_id, staff_user_id, scopes, code_challenge, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + INTERVAL '5 minutes')`,
      [hashToken(code), req.body.client_id, req.body.redirect_uri, req.body.resource,
        req.firm.id, req.firm.userId, scopes, req.body.code_challenge]
    );
    return res.json({
      redirect_to: addRedirectParams(req.body.redirect_uri, { code, state: req.body.state, iss: publicOrigin() }),
    });
  } catch (error) {
    return oauthError(res, error);
  }
});

router.post('/oauth/token', tokenLimiter, async (req, res) => {
  try {
    const { grant_type: grantType, client_id: clientId, resource } = req.body || {};
    if (!clientId) throw new OAuthError('invalid_client', 'client_id is required.', 401);
    if (resource !== mcpResource()) throw new OAuthError('invalid_target', `resource must be ${mcpResource()}.`);
    const { rows } = await pool.query('SELECT 1 FROM mcp_oauth_clients WHERE client_id = $1', [clientId]);
    if (!rows[0]) throw new OAuthError('invalid_client', 'Unknown client.', 401);
    let result;
    if (grantType === 'authorization_code') {
      result = await redeemMcpAuthorizationCode(
        req.body.code, clientId, req.body.redirect_uri, resource, req.body.code_verifier
      );
    } else if (grantType === 'refresh_token') {
      result = await rotateMcpRefreshToken(req.body.refresh_token, clientId, resource);
    } else {
      throw new OAuthError('unsupported_grant_type', 'Supported grant types are authorization_code and refresh_token.');
    }
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    return res.json(result);
  } catch (error) {
    return oauthError(res, error);
  }
});

module.exports = {
  router,
  mcpResource,
  parseScopes,
  publicOrigin,
  validateRedirectUri,
};
