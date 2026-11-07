'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const route = fs.readFileSync(path.resolve(__dirname, '../../server/routes/agent-work.js'), 'utf8');

test.describe('Agent Work MCP authorization contract', () => {
  test('non-API capabilities fail closed', () => {
    expect(route).toContain("return connection?.capabilities?.[capability] === true");
    expect(route).not.toContain('return caps[capability] !== false');
  });

  test('internal delegation is short-lived, audience-bound, and staff-scoped', () => {
    expect(route).toContain("req.headers['x-darklion-internal-mcp'] === '1'");
    expect(route).toContain("issuer: 'darklion-mcp'");
    expect(route).toContain("audience: 'darklion-agent-work'");
    expect(route).toContain("accepted_at IS NOT NULL AND archived_at IS NULL");
    expect(route).toContain("scopes.includes('darklion:read')");
    expect(route).toContain("scopes.includes('darklion:write')");
  });

  test('company discovery respects firm and staff company scope', () => {
    expect(route).toContain("router.get('/companies', requireCapability('transactions_read')");
    expect(route).toContain('c.firm_id = $1');
    expect(route).toContain('restricted.firm_user_id = $2');
    expect(route).toContain('allowed.realm_id = c.realm_id');
  });

  test('CRM search is read-scoped, firm-bound, and does not audit raw queries', () => {
    expect(route).toContain("router.get('/crm/search', requireCapability('crm_read')");
    expect(route).toContain('firmId: req.agentFirmId, query, limit');
    expect(route).toContain('crm_read: canRead');
    expect(route).toContain("audit(req, 'crm_searched', {");
    expect(route).toContain('relationship_count: result.relationships.length');
    expect(route).not.toContain("audit(req, 'crm_searched', { query:");
  });

  test('Team Chat nonce replays do not repeat external side effects', () => {
    expect(route).toContain('const wasInserted = Boolean(rows[0])');
    expect(route).toContain("audit(req, 'team_chat_reply_replayed'");
  });
});
