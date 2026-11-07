// tests/e2e/relationship-move-regression.spec.js
// Source-level coverage for one-off CRM relationship move tools.

'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function compact(source) {
  return source.replace(/\s+/g, ' ');
}

test.describe('CRM relationship move tools', () => {
  test('person move endpoint updates relationship and can sync company access transactionally', () => {
    const source = readRepoFile('server/routes/people.js');
    const routeStart = source.indexOf("router.post('/:id/move-relationship'");
    const routeEnd = source.indexOf('// PUT /:id', routeStart);
    expect(routeStart).toBeGreaterThan(-1);
    expect(routeEnd).toBeGreaterThan(routeStart);

    const route = compact(source.slice(routeStart, routeEnd));
    expect(route).toContain("await client.query('BEGIN')");
    expect(route).toContain('SELECT id, relationship_id, first_name, last_name FROM people WHERE id = $1 AND firm_id = $2 FOR UPDATE');
    expect(route).toContain('UPDATE people SET relationship_id = $1, updated_at = NOW() WHERE id = $2 AND firm_id = $3');
    expect(route).toContain('INSERT INTO person_company_access (person_id, company_id, access_level)');
    expect(route).toContain('DELETE FROM person_company_access pca USING companies c');
    expect(route).toContain("await client.query('COMMIT')");
    expect(route).toContain("await client.query('ROLLBACK').catch(() => {})");
  });

  test('company move endpoint updates relationship and can sync people access transactionally', () => {
    const source = readRepoFile('server/routes/api.js');
    const routeStart = source.indexOf("router.post('/companies/:id([0-9]+)/move-relationship'");
    const routeEnd = source.indexOf('// DELETE /api/companies/id/:id', routeStart);
    expect(routeStart).toBeGreaterThan(-1);
    expect(routeEnd).toBeGreaterThan(routeStart);

    const route = compact(source.slice(routeStart, routeEnd));
    expect(route).toContain("await client.query('BEGIN')");
    expect(route).toContain('SELECT id, relationship_id, company_name FROM companies WHERE id = $1 AND firm_id = $2 FOR UPDATE');
    expect(route).toContain('UPDATE companies SET relationship_id = $1 WHERE id = $2 AND firm_id = $3');
    expect(route).toContain('INSERT INTO person_company_access (person_id, company_id, access_level)');
    expect(route).toContain('DELETE FROM person_company_access pca USING people p');
    expect(route).toContain("await client.query('COMMIT')");
    expect(route).toContain("await client.query('ROLLBACK').catch(() => {})");
  });

  test('person and company profile pages expose the small move control', () => {
    const personView = readRepoFile('server/views/crm-person.ejs');
    const companyView = readRepoFile('server/views/crm-company.ejs');

    for (const source of [personView, companyView]) {
      expect(source).toContain('id="move-relationship-modal"');
      expect(source).toContain('id="move-relationship-select"');
      expect(source).toContain('id="move-sync-access" checked');
      expect(source).toContain('openMoveRelationshipModal()');
      expect(source).toContain('submitMoveRelationship()');
      expect(source).toContain("apiFetch('/api/relationships')");
      expect(source).toContain('sync_company_access');
    }

    expect(personView).toContain('/api/people/${personId}/move-relationship');
    expect(companyView).toContain('/api/companies/${companyId}/move-relationship');
  });
});
