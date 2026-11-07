'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { pool } = require('../../server/db');
const { authenticateStaffToken, validateStaffTokenPurpose } = require('../../server/middleware/requireFirm');
const { apiScopeAllowed } = require('../../server/middleware/requireApiScope');

const repoRoot = path.resolve(__dirname, '../..');

function source(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test.describe('Security boundary regressions', () => {
  test('staff authentication rejects portal and unknown token purposes', () => {
    expect(() => validateStaffTokenPurpose({ type: 'portal' })).toThrow(/Portal tokens/);
    expect(() => validateStaffTokenPurpose({ type: 'agent-callback' })).toThrow(/Invalid staff token type/);
    expect(() => validateStaffTokenPurpose({ type: 'staff' })).not.toThrow();
    expect(() => validateStaffTokenPurpose({ firmId: 1, userId: 2 })).not.toThrow();
  });

  test('shared validator authenticates staff through the database and rejects a signed portal token', async () => {
    const previousSecret = process.env.JWT_SECRET;
    const originalQuery = pool.query;
    process.env.JWT_SECRET = 'security-boundary-regression-secret';
    pool.query = async (_sql, params) => {
      if (Number(params[0]) === 22 && Number(params[1]) === 7) {
        return { rows: [{ id: 22, firm_id: 7, role: 'admin', email: 'staff@example.com', name: 'Staff User' }] };
      }
      return { rows: [] };
    };

    try {
      const staffToken = jwt.sign({ type: 'staff', firmId: 7, userId: 22 }, process.env.JWT_SECRET);
      const portalToken = jwt.sign({ type: 'portal', firmId: 7, personId: 99 }, process.env.JWT_SECRET);
      await expect(authenticateStaffToken(staffToken)).resolves.toMatchObject({ id: 7, userId: 22, role: 'admin' });
      await expect(authenticateStaffToken(portalToken)).rejects.toThrow(/Portal tokens/);
    } finally {
      pool.query = originalQuery;
      if (previousSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previousSecret;
    }
  });

  test('new staff tokens are typed and Pusher uses the shared staff validator', () => {
    const firms = source('server/routes/firms.js');
    const index = source('server/index.js');
    expect(firms).toContain("type: 'staff'");
    expect(index).toContain('await authenticateStaffToken(token)');
    expect(index).not.toContain('const payload = jwt.verify(token, process.env.JWT_SECRET);\n    const firmId = payload.firmId || payload.id;');
  });

  test('API token scopes deny explicit false values and preserve legacy fallback', () => {
    const request = scopes => ({ firm: { isApiToken: true, tokenScopes: scopes } });
    expect(apiScopeAllowed(request({ documents_read: false }), 'documents_read')).toBe(false);
    expect(apiScopeAllowed(request({ documents_read: true }), 'documents_read')).toBe(true);
    expect(apiScopeAllowed(request({ general_api: true }), 'documents_write')).toBe(true);
    expect(apiScopeAllowed(request({ general_api: false }), 'documents_write')).toBe(false);
    expect(apiScopeAllowed(request({}), 'documents_delete', null)).toBe(false);
    expect(apiScopeAllowed({ firm: { role: 'owner' } }, 'documents_delete', null)).toBe(true);
  });

  test('document deletion is explicitly scoped and legacy tokens are migrated to deny it', () => {
    const db = source('server/db.js');
    const documents = source('server/routes/documents.js');
    expect(db).toContain("'{documents_delete}', 'false'::jsonb");
    expect(documents).toContain("req.method === 'DELETE' ? 'documents_delete'");
    expect(documents).toContain("scope === 'documents_delete' ? null : 'general_api'");
  });

  test('repository tooling contains no embedded dev credentials', () => {
    const globalSetup = source('tests/global-setup.cjs');
    const screenshotHelp = source('scripts/screenshot-help.js');
    const captureHelp = source('scripts/capture-help-screenshots.js');
    const masterContext = source('DARKLION.md');
    const claudeContext = source('CLAUDE.md');
    for (const content of [globalSetup, screenshotHelp, captureHelp, masterContext, claudeContext]) {
      expect(content).not.toMatch(/JWT_SECRET\s*\|\|\s*['\"][A-Za-z0-9_-]{32,}['\"]/);
      expect(content).not.toContain("TEST_PASSWORD='DarkLion");
      expect(content).not.toContain('Password: DarkLion');
    }
  });

  test('Bookkeeper filters are parameterized and company joins are firm-scoped', () => {
    const bookkeeper = source('server/routes/bookkeeper.js');
    expect(bookkeeper).not.toContain("bu.status = '${status}'");
    expect(bookkeeper).not.toContain("bu.realm_id = '${realmId}'");
    expect(bookkeeper).toContain("conditions.push(`bu.status = $${params.length}`)");
    expect(bookkeeper).toContain("conditions.push(`bu.realm_id = $${params.length}`)");
    expect(bookkeeper).toContain('c.firm_id = deduped.firm_id');
    expect(bookkeeper).toContain("['pending', 'coded', 'all'].includes(status)");
  });
});
