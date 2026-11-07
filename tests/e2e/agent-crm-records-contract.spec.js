'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  relationshipDto,
  personDto,
  companyDto,
  listRelationships,
  getPerson,
} = require('../../server/services/agentCrm');

const root = path.join(__dirname, '..', '..');

test('CRM DTOs expose explicit allowlists and omit sensitive or internal fields', () => {
  const sensitive = {
    id: 7,
    name: 'Household',
    first_name: 'Ada',
    company_name: 'Ada LLC',
    notes: 'internal',
    ssn_encrypted: 'ciphertext',
    ssn_last4: '1234',
    date_of_birth: '1900-01-01',
    date_of_birth_encrypted: 'ciphertext',
    ein_encrypted: 'ciphertext',
    access_token: 'secret',
    refresh_token: 'secret',
    portal_password_hash: 'hash',
  };

  for (const dto of [relationshipDto(sensitive), personDto(sensitive), companyDto(sensitive)]) {
    assert.equal(dto.notes, undefined);
    assert.equal(dto.ssn_encrypted, undefined);
    assert.equal(dto.ssn_last4, undefined);
    assert.equal(dto.date_of_birth, undefined);
    assert.equal(dto.date_of_birth_encrypted, undefined);
    assert.equal(dto.ein_encrypted, undefined);
    assert.equal(dto.access_token, undefined);
    assert.equal(dto.refresh_token, undefined);
    assert.equal(dto.portal_password_hash, undefined);
  }
});

test('CRM relationship list is bound to the authenticated firm', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ id: 1, name: 'One', company_count: '2', people_count: '3' }] };
    },
  };
  const result = await listRelationships({ firmId: 44, db });
  assert.deepEqual(calls[0].params, [44]);
  assert.match(calls[0].sql, /WHERE r\.firm_id = \$1/);
  assert.equal(result[0].company_count, 2);
  assert.equal(result[0].people_count, 3);
});

test('person detail and company-access lookup both enforce firm ownership', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('FROM people p LEFT JOIN')) return { rows: [{ id: 8, relationship_id: 2, email: 'a@example.com' }] };
      return { rows: [] };
    },
  };
  await getPerson({ firmId: 55, personId: 8, db });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].params, [8, 55]);
  assert.deepEqual(calls[1].params, [8, 55]);
  assert.match(calls[0].sql, /p\.firm_id = \$2/);
  assert.match(calls[1].sql, /c\.firm_id = \$2/);
});

test('Agent Work CRM routes have separate read/write capability gates and no delete routes', () => {
  const routeSource = fs.readFileSync(path.join(root, 'server/routes/agent-work-crm.js'), 'utf8');
  const agentSource = fs.readFileSync(path.join(root, 'server/routes/agent-work.js'), 'utf8');

  assert.match(routeSource, /requireCapability\('crm_read'\)/);
  assert.match(routeSource, /requireCapability\('crm_write'\)/);
  assert.doesNotMatch(routeSource, /router\.delete\(/);
  assert.match(agentSource, /crm_read: canRead/);
  assert.match(agentSource, /crm_write: canWrite/);
  assert.match(agentSource, /router\.use\('\/crm', createAgentWorkCrmRouter/);
});

test('CRM service never selects raw records with SELECT star', () => {
  const serviceSource = fs.readFileSync(path.join(root, 'server/services/agentCrm.js'), 'utf8');
  assert.doesNotMatch(serviceSource, /SELECT\s+\*/i);
  assert.doesNotMatch(serviceSource, /ssn_/i);
  assert.doesNotMatch(serviceSource, /date_of_birth/i);
  assert.doesNotMatch(serviceSource, /ein_encrypted/i);
});

test('company-specific CRM routes pass staff scope and enforce firm-user company restrictions', () => {
  const routeSource = fs.readFileSync(path.join(root, 'server/routes/agent-work-crm.js'), 'utf8');
  const serviceSource = fs.readFileSync(path.join(root, 'server/services/agentCrm.js'), 'utf8');
  assert.match(routeSource, /staffUserId: req\.agentStaffUserId/);
  assert.match(serviceSource, /firm_user_companies restricted/);
  assert.match(serviceSource, /allowed\.firm_user_id = \$3 AND allowed\.realm_id = c\.realm_id/);
  assert.match(serviceSource, /c\.firm_id = \$2/);
});
