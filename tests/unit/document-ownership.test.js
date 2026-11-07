'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const express = require('express');

async function fixture(t, route, query, storage = {}) {
  const filename = path.resolve(__dirname, '../../server/routes', route + '.js');
  const localRequire = createRequire(filename), module = { exports: {} };
  const calls = [];
  const stubs = {
    '../db': { pool: { query: async (sql, params) => { calls.push({ sql, params }); return query(sql, params); } } },
    '../services/s3': { buildKey: () => 'synthetic-key', sanitizeFilename: s => s, ...storage },
    '../services/mobilePush': {}, '../services/activityLog': { recordActivityEvent: () => {} },
    '../middleware/requireApiScope': {}, '../services/taxFactExtractor': {},
    '../services/communicationArchive': {}, '../services/sign-pdf': {}, '../services/claude': {},
    '../services/email': {}, './tax-delivery': {}, '../services/pipelineTriggers': { fireTrigger: async () => {} }, '../services/clientTaxStatus': {},
  };
  vm.compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(
    name => Object.hasOwn(stubs, name) ? stubs[name] : localRequire(name), module, module.exports);
  const app = express();
  app.use((req, _res, next) => { req.firm = { id: 1, userId: 11 }; req.portal = { firmId: 1, personId: 21 }; next(); });
  app.use(module.exports);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { base: `http://127.0.0.1:${server.address().port}`, calls };
}
function form(ownerType, ownerId) {
  const body = new FormData();
  body.append('file', new Blob(['synthetic'], { type: 'text/plain' }), 'synthetic.txt');
  body.append('owner_type', ownerType); body.append('owner_id', ownerId);
  return body;
}

test('staff cannot upload for a different firm or nonexistent owner, without a custom folder', async t => {
  let writes = 0;
  const f = await fixture(t, 'documents', async () => ({ rows: [] }), { uploadFile: async () => { writes++; } });
  for (const ownerType of ['person', 'company']) {
    const r = await fetch(f.base + '/upload', { method: 'POST', body: form(ownerType, '999') });
    assert.equal(r.status, 404);
    assert.deepEqual(f.calls.at(-1).params, [999, 1]);
    assert.match(f.calls.at(-1).sql, /firm_id = \$2/);
  }
  assert.equal(writes, 0);
  assert.equal(f.calls.some(c => /INSERT/.test(c.sql)), false);
});

test('malformed owners are rejected before querying or storing files', async t => {
  const f = await fixture(t, 'documents', () => { throw new Error('Unexpected query'); });
  for (const [type, id] of [['other', '21'], ['person', '21x'], ['person', '2.1'], ['person', '-1'], ['company', '0']]) {
    assert.equal((await fetch(f.base + '/upload', { method: 'POST', body: form(type, id) })).status, 400);
  }
  assert.equal(f.calls.length, 0);
});

test('valid staff owner can still upload', async t => {
  let writes = 0;
  const f = await fixture(t, 'documents', async (sql, params) => {
    if (sql.startsWith('SELECT 1 FROM people')) return { rows: params[0] === 21 && params[1] === 1 ? [{}] : [] };
    if (/INSERT INTO documents/.test(sql)) return { rows: [{ id: 41, firm_id: params[0], owner_type: params[1], owner_id: params[2] }] };
    throw new Error('Unexpected query');
  }, { uploadFile: async () => { writes++; } });
  const r = await fetch(f.base + '/upload', { method: 'POST', body: form('person', '21') });
  assert.equal(r.status, 201); assert.equal((await r.json()).owner_id, 21); assert.equal(writes, 1);
});

test('portal never signs another firm document even when owner ID matches its person', async t => {
  let signed = 0;
  const f = await fixture(t, 'portal', async (sql, params) => {
    const foreign = { id: 41, firm_id: 2, owner_type: 'person', owner_id: 21, viewed_at: null };
    return { rows: /firm_id = \$2/.test(sql) && params[1] !== foreign.firm_id ? [] : [foreign] };
  }, { getSignedDownloadUrl: async () => { signed++; return 'signed'; } });
  assert.equal((await fetch(f.base + '/documents/41/download')).status, 404);
  assert.equal(signed, 0); assert.equal(f.calls.length, 1);
});

test('portal own-document read signs the file and scopes first-view recording', async t => {
  const f = await fixture(t, 'portal', async (sql, params) => {
    assert.deepEqual(params, [41, 1]); assert.match(sql, /firm_id = \$2/);
    return { rows: sql.startsWith('UPDATE') ? [] : [{ id: 41, owner_type: 'person', owner_id: 21, s3_key: 'key', s3_bucket: 'bucket' }] };
  }, { getSignedDownloadUrl: async () => 'signed' });
  const r = await fetch(f.base + '/documents/41/download');
  assert.equal(r.status, 200); assert.equal((await r.json()).url, 'signed'); assert.equal(f.calls.length, 2);
});

test('portal upload rejects a foreign company even if an inconsistent access link exists', async t => {
  let writes = 0;
  const f = await fixture(t, 'portal', async (sql, params) => {
    assert.deepEqual(params, [21, 99, 1]);
    return { rows: /c.firm_id = \$3/.test(sql) ? [] : [{}] };
  }, { uploadFile: async () => { writes++; } });
  const body = form('person', '21'); body.append('company_id', '99');
  assert.equal((await fetch(f.base + '/upload', { method: 'POST', body })).status, 403);
  assert.equal(writes, 0);
});

test('portal custom folder uploads work and stay assigned to their validated destination', async t => {
  let writes = 0;
  const f = await fixture(t, 'portal', async (sql, params) => {
    if (/FROM document_folders/.test(sql)) {
      assert.deepEqual(params, [31, 1]);
      return { rows: [{ id: 31, scope: 'client', owner_type: 'person', owner_id: 21,
        folder_section: 'client_uploaded', folder_category: 'tax', name: 'Synthetic folder' }] };
    }
    if (/INSERT INTO documents/.test(sql)) {
      assert.deepEqual(params.slice(-2), [31, 'Synthetic folder']);
      return { rows: [{ id: 41, firm_id: params[0], owner_type: params[1], owner_id: params[2], document_folder_id: params[12] }] };
    }
    throw new Error('Unexpected query');
  }, { uploadFile: async () => { writes++; } });
  const body = form('person', '21'); body.append('folder_id', '31');
  const r = await fetch(f.base + '/upload', { method: 'POST', body });
  assert.equal(r.status, 200); assert.equal((await r.json()).document.document_folder_id, 31); assert.equal(writes, 1);
});
