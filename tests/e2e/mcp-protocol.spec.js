const { test, expect } = require('@playwright/test');
const { McpServer, InMemoryTransport, LATEST_PROTOCOL_VERSION } = require('@modelcontextprotocol/server');
const express = require('express');
const jwt = require('jsonwebtoken');
const { registerDarkLionTools, getToolAccessCatalog } = require('../../server/mcp/tools');
const { createDarkLionMcpRouter, requiredScopeForBody, requiredScopesForBody, verifier } = require('../../server/mcp/router');
const { mcpCors } = require('../../server/mcp/cors');
const { pool } = require('../../server/db');

async function protocolHarness() {
  const server = new McpServer({ name: 'darklion-test', version: '1.0.0' });
  registerDarkLionTools(server, { firmId: 7, staffUserId: 11, clientId: 'test-client', scopes: ['agent_work'] });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const pending = new Map();
  clientTransport.onmessage = message => {
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); waiter(message); }
  };
  await clientTransport.start();
  await server.connect(serverTransport);
  let id = 0;
  const request = (method, params = {}) => new Promise(resolve => {
    const requestId = ++id;
    pending.set(requestId, resolve);
    clientTransport.send({ jsonrpc: '2.0', id: requestId, method, params });
  });
  await request('initialize', { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return { request, close: () => Promise.all([clientTransport.close(), server.close()]) };
}

test.describe('DarkLion MCP protocol', () => {
  test('returns OAuth bearer challenges and rejects untrusted browser origins', async () => {
    const app = express();
    app.use(express.json());
    app.use(mcpCors);
    app.use('/mcp', createDarkLionMcpRouter());
    const listener = await new Promise(resolve => {
      const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
    const endpoint = `http://127.0.0.1:${listener.address().port}/mcp`;
    try {
      const unauthenticated = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.headers.get('www-authenticate')).toContain('Bearer');
      expect(unauthenticated.headers.get('www-authenticate')).toContain('resource_metadata=');

      const hostileOrigin = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://attacker.example' }, body: '{}',
      });
      expect(hostileOrigin.status).toBe(403);

      const preflight = await fetch(endpoint, {
        method: 'OPTIONS',
        headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'POST' },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
      expect(preflight.headers.get('access-control-allow-headers')).toContain('MCP-Protocol-Version');
    } finally {
      await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    }
  });

  test('requires write scope before dispatching mutating tools', () => {
    expect(requiredScopeForBody({ method: 'tools/list' })).toBe('darklion:read');
    expect(requiredScopeForBody({ method: 'tools/call', params: { name: 'darklion_status' } })).toBe('darklion:read');
    expect(requiredScopeForBody({ method: 'tools/call', params: { name: 'darklion_backfill_transactions' } })).toBe('darklion:write');
    expect(requiredScopeForBody({ method: 'tools/call', params: { name: 'darklion_send_client_message' } })).toBe('darklion:communicate');
    expect(requiredScopeForBody([
      { method: 'tools/call', params: { name: 'darklion_status' } },
      { method: 'tools/call', params: { name: 'darklion_reply_team_conversation' } },
    ])).toBe('darklion:write');
    expect(requiredScopesForBody([
      { method: 'tools/call', params: { name: 'darklion_update_relationship' } },
      { method: 'tools/call', params: { name: 'darklion_send_client_message' } },
    ])).toEqual(['darklion:read', 'darklion:write', 'darklion:communicate']);
  });

  test('derives OAuth scope enforcement from the registered tool catalog', () => {
    const catalog = getToolAccessCatalog();
    expect(catalog.length).toBeGreaterThan(0);
    for (const tool of catalog) {
      if (tool.annotations.readOnlyHint) expect(tool.requiredScope).toBe('darklion:read');
      else expect(tool.requiredScope).not.toBe('darklion:read');
    }
  });

  test('verifies OAuth token expiry, resource, scopes, and staff principal', async () => {
    const originalQuery = pool.query;
    pool.query = async () => ({ rows: [{
      client_id: 'client-1', resource: 'https://darklion.ai/mcp', firm_id: 7,
      staff_user_id: 11, scopes: ['darklion:read'], expires_at: new Date(Date.now() + 60_000), role: 'staff',
    }] });
    try {
      const auth = await verifier.verifyAccessToken('dlo_at_test');
      expect(auth).toMatchObject({ clientId: 'client-1', scopes: ['darklion:read'] });
      expect(auth.darklion).toMatchObject({ firmId: 7, staffUserId: 11, resource: 'https://darklion.ai/mcp' });

      pool.query = async () => ({ rows: [{
        client_id: 'client-1', resource: 'https://other.example/mcp', firm_id: 7,
        staff_user_id: 11, scopes: ['darklion:read'], expires_at: new Date(Date.now() + 60_000), role: 'staff',
      }] });
      await expect(verifier.verifyAccessToken('dlo_at_wrong_resource')).rejects.toMatchObject({ code: 'invalid_token' });
    } finally {
      pool.query = originalQuery;
    }
  });

  test('advertises 62 strictly described tools with output schemas and accurate annotations', async () => {
    const harness = await protocolHarness();
    try {
      const response = await harness.request('tools/list');
      expect(response.error).toBeUndefined();
      expect(response.result.tools).toHaveLength(62);
      for (const tool of response.result.tools) {
        expect(tool.name).toMatch(/^darklion_/);
        expect(tool.description.length).toBeGreaterThan(20);
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.outputSchema.type).toBe('object');
        if (tool.name === 'darklion_trash_document') expect(tool.annotations.destructiveHint).toBe(true);
        else expect(tool.annotations.destructiveHint).toBe(false);
      }
      const byName = Object.fromEntries(response.result.tools.map(tool => [tool.name, tool]));
      expect(byName.darklion_status.annotations.readOnlyHint).toBe(true);
      expect(byName.darklion_search_crm.annotations.readOnlyHint).toBe(true);
      expect(byName.darklion_search_crm.inputSchema).toHaveProperty('properties.query');
      expect(byName.darklion_create_inbox_draft.annotations.readOnlyHint).toBe(false);
      expect(byName.darklion_reply_team_conversation.annotations.idempotentHint).toBe(false);
      expect(byName.darklion_get_revenue_forecast.annotations.openWorldHint).toBe(true);
      expect(byName.darklion_backfill_transactions.annotations.openWorldHint).toBe(true);
      expect(byName.darklion_search_transactions.annotations.openWorldHint).toBe(false);
      expect(byName.darklion_search_transactions.inputSchema).toHaveProperty('properties.amount_exact');
      expect(byName.darklion_search_transactions.inputSchema).toHaveProperty('properties.amount_near');
      expect(byName.darklion_search_transactions.inputSchema).toHaveProperty('properties.amount_min');
      expect(byName.darklion_search_transactions.inputSchema).toHaveProperty('properties.amount_max');
    } finally { await harness.close(); }
  });

  test('returns structured content and uses only a short-lived internal JWT upstream', async () => {
    const originalFetch = global.fetch;
    const originalSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'test-only-secret-with-enough-entropy';
    let captured;
    global.fetch = async (url, options) => {
      captured = { url: String(url), options };
      return new Response(JSON.stringify({ ok: true, firm_id: 7 }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const harness = await protocolHarness();
    try {
      const response = await harness.request('tools/call', { name: 'darklion_status', arguments: {} });
      expect(response.error).toBeUndefined();
      expect(response.result.structuredContent).toEqual({ ok: true, firm_id: 7 });
      expect(response.result.content[0].type).toBe('text');
      expect(captured.options.headers['X-DarkLion-Internal-MCP']).toBe('1');
      const raw = captured.options.headers.Authorization.replace('Bearer ', '');
      expect(raw).not.toContain('oauth');
      const claims = jwt.verify(raw, process.env.JWT_SECRET, { algorithms: ['HS256'], issuer: 'darklion-mcp', audience: 'darklion-agent-work' });
      expect(claims).toMatchObject({ firm_id: 7, staff_user_id: 11, client_id: 'test-client' });
      expect(claims.exp - claims.iat).toBe(30);
    } finally {
      await harness.close();
      global.fetch = originalFetch;
      if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalSecret;
    }
  });

  test('delegates CRM search arguments to the firm-scoped Agent Work route', async () => {
    const originalFetch = global.fetch;
    const originalSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'test-only-secret-with-enough-entropy';
    let capturedUrl;
    global.fetch = async url => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ relationships: [], companies: [], people: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const harness = await protocolHarness();
    try {
      const response = await harness.request('tools/call', {
        name: 'darklion_search_crm', arguments: { query: 'Smith', limit: 10 },
      });
      expect(response.error).toBeUndefined();
      expect(capturedUrl).toContain('/api/agent-work/crm/search?q=Smith&limit=10');
    } finally {
      await harness.close();
      global.fetch = originalFetch;
      if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalSecret;
    }
  });

  test('rejects invalid transaction filters before any API call', async () => {
    const harness = await protocolHarness();
    try {
      const response = await harness.request('tools/call', {
        name: 'darklion_search_transactions',
        arguments: { company_id: 3, amount_min: 20, amount_max: 10 },
      });
      expect(response.result.isError).toBe(true);
      expect(response.result.content[0].text).toContain('amount_min');
    } finally { await harness.close(); }
  });
});
