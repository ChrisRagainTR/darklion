'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const express = require('express');
const jwt = require('jsonwebtoken');

function loadRoute(name, stubs) {
  const filename = path.resolve(__dirname, '../../server/routes', name + '.js');
  const localRequire = createRequire(filename), module = { exports: {} };
  vm.compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(
    name => Object.hasOwn(stubs, name) ? stubs[name] : name.startsWith('.') ? {} : localRequire(name), module, module.exports);
  return module.exports;
}

async function verifyFirmBoundaries(pool, existingFirmId, initDB) {
  const { getFirmFeatures, setFirmFeature, requireFirmFeature } = require('../../server/services/firmFeatures');
  const { requireFirm } = require('../../server/middleware/requireFirm');
  const ledgerhq = require('../../server/services/ledgerhq');
  const alpha = (await pool.query(`INSERT INTO firms (name,email,password_hash,slug)
    VALUES ('Synthetic Alpha','alpha@boundaries.invalid','not-a-login-hash','boundaries-alpha') RETURNING id`)).rows[0];
  const beta = (await pool.query(`INSERT INTO firms (name,email,password_hash,slug)
    VALUES ('Synthetic Beta','beta@boundaries.invalid','not-a-login-hash','boundaries-beta') RETURNING id`)).rows[0];
  const fixtures = [];
  process.env.JWT_SECRET = 'synthetic-disposable-firm-boundary-test-only';
  for (const firm of [alpha, beta]) {
    const staff = (await pool.query(`INSERT INTO firm_users (firm_id,name,email,role,accepted_at)
      VALUES ($1,'Synthetic Staff',$2,'owner',NOW()) RETURNING id`, [firm.id, `staff-${firm.id}@boundaries.invalid`])).rows[0];
    const relationship = (await pool.query("INSERT INTO relationships (firm_id,name) VALUES ($1,'Synthetic Household') RETURNING id", [firm.id])).rows[0];
    const person = (await pool.query(`INSERT INTO people (firm_id,relationship_id,first_name,last_name,email)
      VALUES ($1,$2,'Synthetic','Client',$3) RETURNING id`, [firm.id, relationship.id, `client-${firm.id}@boundaries.invalid`])).rows[0];
    const company = (await pool.query(`INSERT INTO companies (firm_id,relationship_id,realm_id,company_name,access_token,refresh_token,token_expires_at)
      VALUES ($1,$2,$3,'Synthetic Company','test-access','test-refresh',0) RETURNING id,realm_id`, [firm.id, relationship.id, 'synthetic-realm-' + firm.id])).rows[0];
    await pool.query("INSERT INTO person_company_access (person_id,company_id,access_level) VALUES ($1,$2,'owner')", [person.id, company.id]);
    fixtures.push({ firmId: firm.id, staffId: staff.id, personId: person.id, relationshipId: relationship.id, ...company,
      token: jwt.sign({ firmId: firm.id, userId: staff.id, type: 'staff' }, process.env.JWT_SECRET) });
  }
  const [a, b] = fixtures;
  const unowned = (await pool.query(`INSERT INTO companies (realm_id,company_name,access_token,refresh_token,token_expires_at)
    VALUES ('synthetic-unowned','Unowned legacy fixture','test-access','test-refresh',0) RETURNING id,realm_id`)).rows[0];
  const features = { getFirmFeatures, requireFirmFeature };
  const stubs = { '../db': { pool }, '../middleware/requireFirm': { requireFirm }, '../services/firmFeatures': features,
    '../services/ledgerhq': ledgerhq, '../services/audit': { auditLog: async () => {} },
    '../services/scanner': { getLatestScan: async () => ({ synthetic: true }) } };
  stubs['./bookkeeping-source'] = loadRoute('bookkeeping-source', stubs);
  const app = express(); app.use(express.json());
  const firmRouter = loadRoute('firms', stubs);
  const featureRoute = firmRouter.stack.find(layer => layer.route?.path === '/features').route;
  app.get('/firms/features', ...featureRoute.stack.map(layer => layer.handle));
  app.use('/api/emma-chat', requireFirm, loadRoute('emma-chat', stubs));
  app.use('/api/ledgerhq', requireFirm, loadRoute('ledgerhq', stubs).router);
  app.use('/api', requireFirm, loadRoute('api', { ...stubs, '../services/ledgerhq': { ...ledgerhq, getStatus: async () => ({ connected: false }) } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (firm, url, method = 'GET', data) => fetch(base + url, { method,
    headers: { Authorization: 'Bearer ' + firm.token, 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data) });
  try {
    assert.deepEqual(await getFirmFeatures(existingFirmId), { embedded_chat: true });
    assert.equal((await request(a, '/firms/features')).status, 200);
    assert.equal((await fetch(base + '/firms/features')).status, 401);
    const portalToken = jwt.sign({ firmId: a.firmId, personId: a.personId, type: 'portal' }, process.env.JWT_SECRET);
    assert.equal((await request({ token: portalToken }, '/firms/features')).status, 401);
    const mismatchedToken = jwt.sign({ firmId: a.firmId, userId: b.staffId, type: 'staff' }, process.env.JWT_SECRET);
    assert.equal((await request({ token: mismatchedToken }, '/firms/features')).status, 401);
    assert.equal((await request(a, '/firms/features', 'PUT', { embedded_chat: false })).status, 404);
    assert.equal((await request(a, '/api/emma-chat/session')).status, 200);
    const change = { firmId: b.firmId, feature: 'embedded_chat', enabled: false, expected: true, reason: 'Synthetic isolated rollout' };
    await setFirmFeature(change);
    await initDB(); // Restart never changes the selected rollout or another firm's default.
    assert.deepEqual(await getFirmFeatures(a.firmId), { embedded_chat: true });
    assert.deepEqual(await getFirmFeatures(b.firmId), { embedded_chat: false });
    assert.deepEqual((await (await request(a, '/firms/features?firmId=' + b.firmId)).json()).features, { embedded_chat: true });
    assert.equal((await request(b, '/api/emma-chat/session')).status, 404);
    for (const url of ['/message', '/briefing', '/reply-for/' + a.staffId, '/briefing-for/' + b.staffId, '/test-draft/1']) {
      const res = await request(b, '/api/emma-chat' + url, 'POST', { message: 'Must never run' });
      assert.equal(res.status, 404, url); assert.equal((await res.json()).code, 'FEATURE_DISABLED');
    }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM emma_sessions WHERE firm_id=$1', [b.firmId])).rows[0].n, 0);
    await assert.rejects(setFirmFeature(change), /changed since/);
    await assert.rejects(setFirmFeature({ ...change, feature: 'not_a_feature' }), /Unknown feature/);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE firm_id=$1 AND action='firm_feature_changed'", [b.firmId])).rows[0].n, 1);
    await pool.query(`INSERT INTO emma_sessions (firm_id,user_id,session_date) VALUES ($1,$2,'2020-01-01')`, [b.firmId, b.staffId]);
    await request(a, '/api/emma-chat/session');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM emma_sessions WHERE firm_id=$1 AND session_date='2020-01-01'", [b.firmId])).rows[0].n, 1);
    await verifyBriefingCron(pool, a, b);
    await setFirmFeature({ ...change, enabled: true, expected: false, reason: 'Synthetic rollback' });
    assert.equal((await request(b, '/api/emma-chat/session')).status, 200);
    // Missing configuration storage cannot silently re-enable a disabled feature.
    await pool.query('ALTER TABLE firm_feature_flags RENAME TO fixture_unavailable_flags');
    try {
      assert.equal((await request(b, '/firms/features')).status, 503);
      assert.equal((await request(b, '/api/emma-chat/message', 'POST', { message: 'Must not run' })).status, 503);
    } finally { await pool.query('ALTER TABLE fixture_unavailable_flags RENAME TO firm_feature_flags'); }

    for (const [own, foreign] of [[a, b], [b, a]]) {
      const detail = await request(own, '/api/companies/' + own.id);
      assert.equal(detail.status, 200); assert.equal((await detail.json()).firm_id, own.firmId);
      assert.equal((await request(own, '/api/companies/' + own.id + '/bookkeeping-source', 'PUT', { provider: 'qbo' })).status, 200);
      assert.equal((await request(own, '/api/companies/' + own.realm_id + '/scans?type=variance')).status, 200);
      for (const denied of [foreign, unowned]) {
        for (const [method, url, body] of [
          ['GET', `/api/companies/${denied.id}`], ['PUT', `/api/companies/${denied.id}`, { company_name: 'Must not change' }],
          ['PUT', `/api/companies/${denied.id}/bookkeeping-source`, { provider: 'qbo' }],
          ['POST', `/api/companies/${denied.id}/disconnect-qbo`, {}],
          ['GET', `/api/companies/id/${denied.id}/ledgerhq/close-packages`],
          ['POST', `/api/companies/id/${denied.id}/ledgerhq/close-package`, {}],
          ['GET', `/api/ledgerhq/company-links/${denied.id}`], ['PUT', `/api/ledgerhq/company-links/${denied.id}`, { providerCompanyId: 'must-not-link' }],
          ['DELETE', `/api/ledgerhq/company-links/${denied.id}`],
        ]) assert.equal((await request(own, url, method, body)).status, 404, method + ' ' + url);
        assert.equal((await request(own, '/api/companies/' + denied.realm_id + '/scans?type=variance')).status, 403);
      }
      for (const body of [{ relationship_id: foreign.relationshipId }, { bookkeeper_id: foreign.staffId }]) {
        assert.equal((await request(own, '/api/companies/' + own.id, 'PUT', body)).status, 404);
      }
      assert.equal((await request(own, '/api/companies/' + own.id, 'PUT', { notes: 'Own firm update', bookkeeper_id: own.staffId, relationship_id: own.relationshipId })).status, 200);
      assert.equal((await request(own, '/api/ledgerhq/company-links/' + own.id, 'PUT', { providerCompanyId: 'synthetic-provider-' + own.id })).status, 200);
      await assert.rejects(ledgerhq.saveCompanyLink({ firmId: foreign.firmId, companyId: own.id, providerCompanyId: 'cannot-steal' }), /ownership/);
      assert.equal(await ledgerhq.getCompanyLink(own.id, foreign.firmId), null);
      assert.equal((await ledgerhq.getCompanyLink(own.id, own.firmId)).provider_company_id, 'synthetic-provider-' + own.id);
    }
    const unchanged = (await pool.query('SELECT company_name,access_token,bookkeeping_provider FROM companies WHERE id=$1', [unowned.id])).rows[0];
    assert.equal(unchanged.company_name, 'Unowned legacy fixture'); assert.equal(unchanged.access_token, 'test-access');
    assert.equal(unchanged.bookkeeping_provider, 'ledgerhq');

    // Existing companies can keep archived same-firm assignments while their
    // notes/address change, including clients that echo the unchanged ID.
    const archived = (await pool.query(`INSERT INTO firm_users (firm_id,name,email,role,accepted_at,archived_at)
      VALUES ($1,'Archived Synthetic','archived@boundaries.invalid','staff',NOW(),NOW()) RETURNING id`, [a.firmId])).rows[0];
    const otherArchived = (await pool.query(`INSERT INTO firm_users (firm_id,name,email,role,accepted_at,archived_at)
      VALUES ($1,'Other Archived Synthetic','other-archived@boundaries.invalid','staff',NOW(),NOW()) RETURNING id`, [a.firmId])).rows[0];
    const pending = (await pool.query(`INSERT INTO firm_users (firm_id,name,email,role)
      VALUES ($1,'Pending Synthetic','pending@boundaries.invalid','staff') RETURNING id`, [a.firmId])).rows[0];
    await pool.query("UPDATE companies SET bookkeeper_id=$1,bookkeeping_service='monthly' WHERE id=$2", [archived.id, a.id]);
    for (const body of [{ notes: 'Edit with omitted assignment' }, { notes: 'Edit with unchanged assignment', bookkeeper_id: String(archived.id) }]) {
      const result = await request(a, '/api/companies/' + a.id, 'PUT', body);
      assert.equal(result.status, 200); const updated = await result.json();
      assert.equal(updated.bookkeeper_id, archived.id); assert.equal(updated.bookkeeping_service, 'monthly');
    }
    for (const id of [otherArchived.id, pending.id, b.staffId]) {
      assert.equal((await request(a, '/api/companies/' + a.id, 'PUT', { bookkeeper_id: id })).status, 404);
    }
    const cleared = await request(a, '/api/companies/' + a.id, 'PUT', { bookkeeper_id: null, bookkeeping_service: null });
    assert.equal(cleared.status, 200); const clearedBody = await cleared.json();
    assert.equal(clearedBody.bookkeeper_id, null); assert.equal(clearedBody.bookkeeping_service, null);
    assert.equal((await request(a, '/api/companies/' + a.id, 'PUT', { bookkeeper_id: archived.id })).status, 404);
    assert.equal((await request(a, '/api/companies/' + a.id, 'PUT', { bookkeeper_id: a.staffId })).status, 200);

    // Reports with a stale/null firm owner are never returned through a valid link.
    for (const [owner, period] of [[a.firmId, '2026-01'], [b.firmId, '2026-02'], [null, '2026-03']]) {
      await pool.query(`INSERT INTO ledgerhq_close_packages (firm_id,darklion_company_id,ledgerhq_company_id,period)
        VALUES ($1,$2,$3,$4)`, [owner, a.id, 'synthetic-provider-' + a.id, period]);
    }
    assert.deepEqual((await ledgerhq.listLedgerHqClosePackages(a.id, a.firmId)).map(row => row.period), ['2026-01']);
    assert.deepEqual(await ledgerhq.listLedgerHqClosePackages(a.id, b.firmId), []);

    // Corrupt legacy relationships must not expose the foreign person's details.
    await pool.query('UPDATE companies SET relationship_id=$1 WHERE id=$2', [b.relationshipId, a.id]);
    await pool.query("INSERT INTO person_company_access (person_id,company_id,access_level) VALUES ($1,$2,'owner')", [b.personId, a.id]);
    const filtered = await (await request(a, '/api/companies/' + a.id)).json();
    assert.equal(filtered.relationship, null); assert.deepEqual(filtered.people.map(p => p.person_id), [a.personId]);
    // A corrupt existing provider link cannot be silently reassigned to a firm.
    await pool.query('UPDATE company_bookkeeping_links SET firm_id=$1 WHERE darklion_company_id=$2', [b.firmId, a.id]);
    assert.equal(await ledgerhq.getCompanyLink(a.id, b.firmId), null);
    await assert.rejects(ledgerhq.saveCompanyLink({ firmId: a.firmId, companyId: a.id, providerCompanyId: 'cannot-reassign' }), /ownership/);
    const { auditFirmOwnership } = require('../../scripts/audit-firm-ownership');
    const audit = await auditFirmOwnership(pool);
    assert.equal(audit.ownership.find(row => row.table === 'companies').missing_firm, 1);
    for (const boundary of ['company_relationship', 'bookkeeping_link_company', 'person_company_access']) {
      assert.equal(audit.boundaries.find(row => row.boundary === boundary).mismatches, 1);
    }
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}

async function verifyBriefingCron(pool, enabled, disabled) {
  const ts = require('typescript');
  const source = fs.readFileSync(path.resolve(__dirname, '../../server/index.js'), 'utf8');
  const tree = ts.createSourceFile('index.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const fn = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'startEmmaBriefingCron');
  const calls = [], scheduled = [], errors = [];
  const context = vm.createContext({ pool, AI_MODEL: 'synthetic-model', Date, Promise,
    process: { env: { ANTHROPIC_API_KEY: 'synthetic-never-used-for-http' } },
    console: { log() {}, error: (...args) => errors.push(args) },
    setTimeout: (cb, ms) => ms === 500 ? cb() : scheduled.push(cb),
    require: name => {
      if (name === './db') return { pool };
      if (name === '@anthropic-ai/sdk') return class { messages = { create: async () => ({ content: [{ text: 'Synthetic briefing' }] }) }; };
      if (name === './services/emmaContext') return { getFirmContext: async id => { calls.push(id); return {}; } };
      if (name === './services/emmaPrompt') return { buildSystemPrompt: async () => 'Synthetic prompt' };
      if (name === './services/firmFeatures') return require('../../server/services/firmFeatures');
      throw new Error('Unexpected dependency: ' + name);
    },
  });
  vm.runInContext(fn.getText(tree), context);
  context.startEmmaBriefingCron(); await scheduled.shift()();
  assert.deepEqual(errors, []); assert.ok(calls.includes(enabled.firmId)); assert.ok(!calls.includes(disabled.firmId));
}

module.exports = { verifyFirmBoundaries };
