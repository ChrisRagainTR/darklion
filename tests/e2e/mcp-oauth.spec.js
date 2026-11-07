'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { pool } = require('../../server/db');

const repoRoot = path.resolve(__dirname, '../..');
const read = relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

test.describe('MCP OAuth 2.1 contract', () => {
  test('publishes protected-resource and authorization-server metadata', () => {
    const route = read('server/routes/mcp-oauth.js');
    expect(route).toContain("router.get('/.well-known/oauth-protected-resource'");
    expect(route).toContain("router.get('/.well-known/oauth-protected-resource/mcp'");
    expect(route).toContain("router.get('/.well-known/oauth-authorization-server'");
    expect(route).toContain("code_challenge_methods_supported: ['S256']");
    expect(route).toContain("token_endpoint_auth_methods_supported: ['none']");
    expect(route).toContain('authorization_response_iss_parameter_supported: true');
    expect(route).toContain('iss: publicOrigin()');
    expect(route).toContain("throw new OAuthError('invalid_request', 'A nonempty state parameter is required.')");
    expect(route).toContain("return `${publicOrigin()}/mcp`");
  });

  test('serves interoperable OAuth discovery documents over HTTP', async () => {
    const previous = process.env.PUBLIC_APP_URL;
    process.env.PUBLIC_APP_URL = 'https://darklion.example';
    const { router } = require('../../server/routes/mcp-oauth');
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use(router);
    const listener = await new Promise(resolve => {
      const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
    const base = `http://127.0.0.1:${listener.address().port}`;
    try {
      const resource = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
      expect(resource.status).toBe(200);
      expect(await resource.json()).toMatchObject({
        resource: 'https://darklion.example/mcp',
        authorization_servers: ['https://darklion.example'],
      });
      const authorization = await fetch(`${base}/.well-known/oauth-authorization-server`);
      expect(authorization.status).toBe(200);
      expect(await authorization.json()).toMatchObject({
        issuer: 'https://darklion.example',
        authorization_endpoint: 'https://darklion.example/oauth/authorize',
        token_endpoint: 'https://darklion.example/oauth/token',
        code_challenge_methods_supported: ['S256'],
      });
    } finally {
      await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
      if (previous === undefined) delete process.env.PUBLIC_APP_URL; else process.env.PUBLIC_APP_URL = previous;
    }
  });

  test('only accepts safe exact redirect URI forms', () => {
    const { parseScopes, validateRedirectUri } = require('../../server/routes/mcp-oauth');
    expect(validateRedirectUri('https://client.example/oauth/callback')).toBe(true);
    expect(validateRedirectUri('http://127.0.0.1:49152/callback')).toBe(true);
    expect(validateRedirectUri('http://localhost:3000/callback')).toBe(true);
    expect(validateRedirectUri('http://client.example/callback')).toBe(false);
    expect(validateRedirectUri('https://client.example/callback#fragment')).toBe(false);
    expect(validateRedirectUri('javascript:alert(1)')).toBe(false);
    expect(parseScopes('darklion:write')).toEqual(['darklion:read', 'darklion:write']);
    expect(parseScopes('darklion:communicate')).toEqual(['darklion:read', 'darklion:communicate']);
  });

  test('PKCE uses the RFC 7636 S256 transform', () => {
    const { pkceChallenge } = require('../../server/services/mcpOAuth');
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(pkceChallenge(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  test('redeems a one-use PKCE code into hashed opaque tokens transactionally', async () => {
    const service = require('../../server/services/mcpOAuth');
    const verifier = 'A'.repeat(43);
    const rawCode = 'dlo_code_test';
    const queries = [];
    const originalConnect = pool.connect;
    pool.connect = async () => ({
      async query(sql, params = []) {
        queries.push({ sql, params });
        if (sql.includes('SELECT * FROM mcp_oauth_codes')) return { rows: [{
          code_hash: service.hashToken(rawCode), client_id: 'client-1', redirect_uri: 'https://client.example/callback',
          resource: 'https://darklion.ai/mcp', firm_id: 7, staff_user_id: 11,
          scopes: ['darklion:read'], code_challenge: service.pkceChallenge(verifier),
          expires_at: new Date(Date.now() + 60_000), consumed_at: null,
        }] };
        if (sql.includes('SELECT fu.role')) return { rows: [{ role: 'staff' }] };
        return { rows: [] };
      },
      release() {},
    });
    try {
      const tokens = await service.redeemMcpAuthorizationCode(
        rawCode, 'client-1', 'https://client.example/callback', 'https://darklion.ai/mcp', verifier
      );
      expect(tokens.access_token).toMatch(/^dlo_at_/);
      expect(tokens.refresh_token).toMatch(/^dlo_rt_/);
      expect(tokens.expires_in).toBe(3600);
      expect(queries.some(query => query.sql === 'BEGIN')).toBe(true);
      expect(queries.some(query => query.sql === 'COMMIT')).toBe(true);
      expect(queries.some(query => query.sql.includes('SET consumed_at = NOW()'))).toBe(true);
      const accessInsert = queries.find(query => query.sql.includes('INSERT INTO mcp_oauth_access_tokens'));
      const refreshInsert = queries.find(query => query.sql.includes('INSERT INTO mcp_oauth_refresh_tokens'));
      expect(accessInsert.params[0]).toBe(service.hashToken(tokens.access_token));
      expect(refreshInsert.params[0]).toBe(service.hashToken(tokens.refresh_token));
      expect(accessInsert.params).not.toContain(tokens.access_token);
      expect(refreshInsert.params).not.toContain(tokens.refresh_token);
    } finally {
      pool.connect = originalConnect;
    }
  });

  test('stores only hashes for codes and bearer credentials', () => {
    const db = read('server/db.js');
    const service = read('server/services/mcpOAuth.js');
    expect(db).toContain('CREATE TABLE IF NOT EXISTS mcp_oauth_codes');
    expect(db).toContain('CREATE TABLE IF NOT EXISTS mcp_oauth_access_tokens');
    expect(db).toContain('CREATE TABLE IF NOT EXISTS mcp_oauth_refresh_tokens');
    expect(service).toContain("crypto.createHash('sha256').update(value).digest('hex')");
    expect(service).not.toContain('console.log');
    expect(service).not.toMatch(/INSERT INTO mcp_oauth_(?:access|refresh)_tokens[\s\S]{0,250}\baccess_token\b/);
  });

  test('rotates refresh tokens and revokes the family on replay', () => {
    const service = read('server/services/mcpOAuth.js');
    expect(service).toContain('SELECT * FROM mcp_oauth_refresh_tokens WHERE token_hash = $1 FOR UPDATE');
    expect(service).toContain('Refresh token replay detected. Reauthorization is required.');
    expect(service).toContain('UPDATE mcp_oauth_refresh_tokens SET revoked_at');
    expect(service).toContain('UPDATE mcp_oauth_access_tokens SET revoked_at');
    expect(service).toContain('UPDATE mcp_oauth_refresh_tokens SET consumed_at = NOW()');
  });

  test('bearer authentication rechecks active staff and returns the MCP principal shape', () => {
    const service = require('../../server/services/mcpOAuth');
    expect(typeof service.authenticateMcpAccessToken).toBe('function');
    const source = read('server/services/mcpOAuth.js');
    expect(source).toContain('fu.accepted_at IS NOT NULL AND fu.archived_at IS NULL');
    for (const field of ['firmId', 'staffUserId', 'role', 'scopes', 'clientId', 'resource']) {
      expect(source).toContain(`${field}:`);
    }
  });

  test('login returnTo is internal-only and OAuth consent is explicit', () => {
    const login = read('public/login.html');
    const consent = read('server/views/mcp-authorize.ejs');
    expect(login).toContain('const parsedReturnTo = new URL(requestedReturnTo, location.origin)');
    expect(login).toContain('parsedReturnTo.origin === location.origin');
    expect(login).toContain('parsedReturnTo.pathname + parsedReturnTo.search + parsedReturnTo.hash');
    expect(consent).toContain("body.decision = decision");
    expect(consent).toContain("document.getElementById('allow')");
    expect(consent).toContain("localStorage.getItem('dl_token')");
  });
});
