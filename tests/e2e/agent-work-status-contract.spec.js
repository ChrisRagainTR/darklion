// tests/e2e/agent-work-status-contract.spec.js
// Source-level contract checks for Agent Work capability discovery.

'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test.describe('Agent Work status capability contract', () => {
  test('status returns effective API-token capabilities and summary resource metadata', () => {
    const route = readRepoFile('server/routes/agent-work.js');

    expect(route).toContain('API_TOKEN_DEFAULT_CAPABILITIES');
    expect(route).toContain('summaries_read: true');
    expect(route).toContain('function effectiveCapabilities(connection)');
    expect(route).toContain('const capabilities = effectiveCapabilities(req.agentConnection)');
    expect(route).toContain('resources: capabilityResources(capabilities)');
    expect(route).toContain('detail_marks_viewed: false');
  });

  test('API token defaults and new token creation include summaries_read', () => {
    const db = readRepoFile('server/db.js');
    const firms = readRepoFile('server/routes/firms.js');

    expect(db).toContain('"summaries_read":true');
    expect(db).toContain('ALTER TABLE api_tokens ALTER COLUMN scopes SET DEFAULT');
    expect(firms).toContain('summaries_read: true');
  });

  test('summaries endpoint enforces explicit summaries_read disablement for API tokens', () => {
    const summaries = readRepoFile('server/routes/summaries.js');

    expect(summaries).toContain('function apiTokenCanReadSummaries(req)');
    expect(summaries).toContain('scopes.general_api !== false && scopes.summaries_read !== false');
    expect(summaries).toContain("API key is not enabled for summary access");
    expect(summaries).toContain('staff_user_id is required for API-token summary access');
  });

  test('docs expose summary discovery in status response', () => {
    const markdown = readRepoFile('docs/api-docs.md');
    const html = readRepoFile('server/views/api-docs.ejs');
    const openapi = readRepoFile('docs/openapi.json');

    for (const source of [markdown, html, openapi]) {
      expect(source).toContain('summaries_read');
      expect(source).toContain('detail_marks_viewed');
    }
  });
});
