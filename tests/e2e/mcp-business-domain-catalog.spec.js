const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CATALOG_PATH = path.join(ROOT, 'docs/mcp-business-domain-catalog.json');

function loadCatalog() {
  return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
}

test.describe('implemented MCP business-domain catalog', () => {
  test('is machine-readable, complete across the audited domains, and uniquely named', () => {
    const catalog = loadCatalog();
    expect(catalog.schema_version).toBe(1);
    expect(catalog.status).toBe('implemented_mvp');
    expect(catalog.oauth_scopes).toEqual({ read: 'darklion:read', write: 'darklion:write', communicate: 'darklion:communicate' });

    const requiredDomains = [
      'communications', 'work', 'pipelines', 'bookkeeping', 'tax_deliveries',
      'organizers', 'proposals', 'billing', 'investments', 'emma', 'staff',
    ];
    expect(new Set(catalog.operations.map(operation => operation.domain)))
      .toEqual(new Set(requiredDomains));

    const names = catalog.operations.map(operation => operation.tool_name);
    expect(new Set(names).size).toBe(names.length);
    for (const operation of catalog.operations) {
      expect(operation.tool_name).toMatch(/^darklion_[a-z0-9_]+$/);
      expect(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).toContain(operation.method);
      expect(operation.path).toMatch(/^\/api\//);
      expect(['read', 'write']).toContain(operation.access.mode);
      expect(typeof operation.access.destructive).toBe('boolean');
      expect(typeof operation.access.open_world).toBe('boolean');
      expect(operation.required_capability).toMatch(/^[a-z0-9_]+$/);
      expect(['include', 'exclude']).toContain(operation.decision);
      expect(operation.rationale.length).toBeGreaterThan(20);
      expect(operation.security_behavior.length).toBeGreaterThan(20);
    }
  });

  test('ties every catalog operation to an exact route declaration in production source', () => {
    const { operations } = loadCatalog();
    for (const operation of operations) {
      const sourcePath = path.join(ROOT, operation.evidence.source_file);
      expect(fs.existsSync(sourcePath), `${operation.tool_name} source exists`).toBe(true);
      const source = fs.readFileSync(sourcePath, 'utf8');
      expect(source, `${operation.tool_name} route evidence`).toContain(operation.evidence.route_pattern);
    }
  });

  test('keeps destructive and unguarded external-write operations out of the MVP', () => {
    const { operations } = loadCatalog();
    for (const operation of operations) {
      const guardedClientSend = ['darklion_send_client_message', 'darklion_reply_client_message'].includes(operation.tool_name);
      if (operation.access.destructive || (operation.access.mode === 'write' && operation.access.open_world && !guardedClientSend)) {
        expect(operation.decision, operation.tool_name).toBe('exclude');
      }
    }
    expect(operations.filter(operation => operation.decision === 'include'))
      .toHaveLength(22);
  });

  test('records the concrete unsafe scope and response behaviors found by the audit', () => {
    const { operations } = loadCatalog();
    const byName = Object.fromEntries(operations.map(operation => [operation.tool_name, operation]));

    expect(byName.darklion_list_uncoded_transactions.decision).toBe('exclude');
    expect(byName.darklion_list_uncoded_transactions.rationale).toContain('interpolates');
    expect(byName.darklion_get_chart_of_accounts.security_behavior).toContain('derive realmId server-side');
    expect(byName.darklion_get_tax_delivery.security_behavior).toContain('approved_ip');
    expect(byName.darklion_list_tax_organizers.security_behavior).toContain('s3_key');
    expect(byName.darklion_list_proposals.security_behavior).toContain('public_token');
    expect(byName.darklion_get_proposal.security_behavior).toContain('primary_person_portal_invite_token');
    expect(byName.darklion_get_emma_thread_messages.rationale).toContain("does not enforce");
    expect(byName.darklion_get_emma_session_for_staff.rationale).toContain("another staff member's");
    expect(byName.darklion_get_portal_organizer.decision).toBe('exclude');
    expect(byName.darklion_get_conversation_summary.access.side_effect).toBeUndefined();
  });

});
