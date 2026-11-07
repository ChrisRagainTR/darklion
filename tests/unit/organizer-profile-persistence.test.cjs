"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');

function backend() {
  const source = fs.readFileSync(path.join(root, 'server/routes/organizer.js'), 'utf8');
  const code = source.slice(source.indexOf('async function getOrganizerProfile('), source.indexOf('async function syncQuestionnaireChecklist('));
  const state = { people: [{ id: 11, firm_id: 7, first_name: 'Sample', profile_revision: '0' }], deps: [
    { id: 41, person_id: 11, firm_id: 7, full_name: 'Child Example', relationship: 'Child', ssn_last4: 'metadata', ssn_on_file: true, active: true, display_order: 0 },
    { id: 42, person_id: 11, firm_id: 7, full_name: 'Other Example', active: true, display_order: 1 },
    { id: 43, person_id: 11, firm_id: 8, full_name: 'Foreign', active: true, display_order: 0 },
  ] };
  let snapshot;
  let failInsert = false;
  const queries = [];
  const query = async (sql, args = []) => {
    queries.push({ sql, args });
    const q = sql.replace(/\s+/g, ' ').trim().toUpperCase();
    if (q === 'BEGIN') { snapshot = structuredClone(state); return { rows: [] }; }
    if (q === 'COMMIT') return { rows: [] };
    if (q === 'ROLLBACK') { state.people = snapshot.people; state.deps = snapshot.deps; return { rows: [] }; }
    if (q.startsWith('SELECT') && q.includes('FROM PEOPLE')) return { rows: state.people.filter(p => p.id === Number(args[0]) && p.firm_id === Number(args[1])) };
    if (q.startsWith('UPDATE PEOPLE')) { const p = state.people.find(p => p.id === Number(args[15]) && p.firm_id === Number(args[16])); if (p) { p.first_name = args[0] ?? p.first_name; if (q.includes('PROFILE_REVISION = PROFILE_REVISION + 1')) p.profile_revision = String(BigInt(p.profile_revision) + 1n); } return { rowCount: p ? 1 : 0, rows: [] }; }
    if (q.startsWith('SELECT') && q.includes('FROM PERSON_DEPENDENTS')) return { rows: state.deps.filter(d => d.person_id === Number(args[0]) && d.firm_id === Number(args[1]) && d.active).sort((a,b) => a.display_order - b.display_order) };
    if (q.startsWith('UPDATE PERSON_DEPENDENTS')) {
      const id = q.includes('WHERE ID = $1') ? Number(args[0]) : null;
      for (const d of state.deps.filter(d => d.person_id === 11 && d.firm_id === 7 && (id === null || d.id === id))) {
        if (q.includes('ACTIVE = FALSE')) d.active = false;
        else { d.full_name = args[3]; d.relationship = args[4]; d.display_order = args[7]; }
      }
      return { rows: [], rowCount: 1 };
    }
    if (q.startsWith('INSERT INTO PERSON_DEPENDENTS')) {
      if (failInsert) throw Error('synthetic insert failure');
      state.deps.push({ id: 99, firm_id: Number(args[0]), person_id: Number(args[1]), full_name: args[2], active: true, display_order: args.at(-1) });
      return { rows: [] };
    }
    throw Error('Unexpected SQL: ' + sql);
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  const api = vm.runInNewContext(code + '\n({ saveOrganizerProfile, getOrganizerProfile })', { pool });
  return { ...api, state, queries, setFailInsert: () => { failInsert = true; } };
}

test('stale portal revision rejects before any people or dependent mutation', async () => {
  const b = backend();
  await assert.rejects(b.saveOrganizerProfile(11, 7, { taxpayer: { first_name: 'Changed' }, deletedDependentIds: [42] }, null, '9'), e => e.status === 409);
  assert.equal(b.state.people[0].first_name, 'Sample');
  assert.equal(b.state.deps.find(d => d.id === 42).active, true);
  assert.equal(b.queries.filter(q => /UPDATE (people|person_dependents)/i.test(q.sql)).length, 0);
});

test('matching revision increments transactionally and GET returns new revision', async () => {
  const b = backend();
  const saved = await b.saveOrganizerProfile(11, 7, { taxpayer: { first_name: 'Changed' } }, null, '0');
  assert.equal(saved.profile_revision, '1');
  assert.equal((await b.getOrganizerProfile(11, 7)).profile_revision, '1');
  await assert.rejects(b.saveOrganizerProfile(11, 7, {}, null, '0'), e => e.status === 409);
});

test('staff save rejects a stale loaded profile revision before mutation', async () => {
  const b = backend();
  await assert.rejects(b.saveOrganizerProfile(11, 7, { taxpayer: { first_name: 'Stale' } }, null, '9'), e => e.status === 409);
  assert.equal(b.state.people[0].first_name, 'Sample');
});

test('staff save increments revision so an already loaded portal tab is stale', async () => {
  const b = backend();
  await b.saveOrganizerProfile(11, 7, { taxpayer: { first_name: 'Staff' } });
  assert.equal(b.state.people[0].profile_revision, '1');
  await assert.rejects(b.saveOrganizerProfile(11, 7, {}, null, '0'), e => e.status === 409);
});

test('portal route requires expected revision and maps stale save to 409', () => {
  const source = fs.readFileSync(path.join(root, 'server/routes/organizer.js'), 'utf8');
  const route = source.slice(source.indexOf("router.put('/client/:year/profile'"), source.indexOf("router.post('/client/:year/answers'"));
  assert.match(route, /expected_revision/);
  assert.match(route, /status\(409\)/);
});

test('staff route requires expected revision and maps conflict', () => {
  const source = fs.readFileSync(path.join(root, 'server/routes/organizer.js'), 'utf8');
  const route = source.slice(source.indexOf("router.put('/:personId/profile'"), source.indexOf("router.get('/all-years'"));
  assert.match(route, /expected_revision/);
  assert.match(route, /status\(409\)/);
});

test('advisor editor preserves dependent identity and sends explicit deletion list', () => {
  const source = fs.readFileSync(path.join(root, 'server/views/crm-person.ejs'), 'utf8');
  const editor = source.slice(source.indexOf('function editOrganizerProfile()'), source.indexOf('async function saveOrganizerProfileFromAdvisor()'));
  assert.match(editor, /data-dependent-id/);
  assert.match(editor, /deletedDependentIds/);
  assert.match(editor, /id:\s*Number\(row\.dataset\.dependentId\)/);
  const save = source.slice(source.indexOf('async function saveOrganizerProfileFromAdvisor()'), source.indexOf('async function saveOrganizerProfileFromAdvisor()') + 1100);
  assert.match(save, /expected_revision/);
});

test('people migration declares idempotent non-null bigint revision', () => {
  const source = fs.readFileSync(path.join(root, 'server/db.js'), 'utf8');
  assert.match(source, /ALTER TABLE people ADD COLUMN IF NOT EXISTS profile_revision BIGINT NOT NULL DEFAULT 0/i);
});

test('profile save keeps existing dependent identity and private metadata, and does not delete omitted rows', async () => {
  const b = backend();
  await b.saveOrganizerProfile(11, 7, { dependents: [{ id: 41, full_name: 'Updated Example', relationship: 'Child' }] });
  assert.equal(b.state.deps.find(d => d.id === 41).full_name, 'Updated Example');
  assert.equal(b.state.deps.find(d => d.id === 41).ssn_last4, 'metadata');
  assert.equal(b.state.deps.find(d => d.id === 41).ssn_on_file, true);
  assert.equal(b.state.deps.find(d => d.id === 42).active, true);
  assert.equal(b.state.deps.find(d => d.id === 43).active, true);
});

test('explicit deletion is scoped and foreign IDs are rejected atomically', async () => {
  const b = backend();
  await assert.rejects(b.saveOrganizerProfile(11, 7, { taxpayer: { first_name: 'Changed' }, deletedDependentIds: [43] }), /dependent/i);
  assert.equal(b.state.people[0].first_name, 'Sample');
  await b.saveOrganizerProfile(11, 7, { deletedDependentIds: [42] });
  assert.equal(b.state.deps.find(d => d.id === 42).active, false);
  assert.equal(b.state.deps.find(d => d.id === 43).active, true);
});

test('failed dependent insert rolls back taxpayer and existing dependent changes', async () => {
  const b = backend(); b.setFailInsert();
  await assert.rejects(b.saveOrganizerProfile(11, 7, { taxpayer: { first_name: 'Changed' }, dependents: [{ id: 41, full_name: 'Updated' }, { full_name: 'New' }] }), /synthetic insert failure/);
  assert.equal(b.state.people[0].first_name, 'Sample');
  assert.equal(b.state.deps.find(d => d.id === 41).full_name, 'Child Example');
  assert.ok(b.queries.some(q => q.sql === 'ROLLBACK'));
});

test('an explicitly blank spouse name clears the saved spouse', async () => {
  const b = backend();
  await b.saveOrganizerProfile(11, 7, { spouse: { first_name: '', last_name: '' } });
  const update = b.queries.find(q => q.sql.includes('UPDATE people SET'));
  assert.equal(update.args[11], '');
});

test('omitted dependent fields do not erase existing values', async () => {
  const b = backend();
  await b.saveOrganizerProfile(11, 7, { dependents: [{ id: 41, full_name: 'Updated' }] });
  const update = b.queries.find(q => q.sql.includes('UPDATE person_dependents SET full_name'));
  assert.match(update.sql, /relationship\s*=\s*COALESCE\(/i);
  assert.equal(update.args[4], null);
  assert.equal(update.args[5], null);
  assert.equal(update.args[6], null);
});

test('unknown dependent IDs cannot become inserts or cross tenant edits', async () => {
  const b = backend();
  await assert.rejects(b.saveOrganizerProfile(11, 7, { dependents: [{ id: 43, full_name: 'Changed' }] }), /dependent/i);
  assert.equal(b.state.deps.find(d => d.id === 43).full_name, 'Foreign');
});

function frontend() {
  const html = fs.readFileSync(path.join(root, 'public/organizer.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/g).at(-1).replace(/^<script>|<\/script>$/g, '');
  const calls = [];
  let response = { ok: true, json: async () => ({ profile: { profile_revision: '1', dependents: [{ id: 41, full_name: 'Child Example' }] } }) };
  const rows = [{ dataset: { dependentId: '41' }, querySelector: sel => ({ value: ({ '.dep-name, input': 'Child Example', '.dep-relationship': 'Child', '.dep-dob': 'On File', '.dep-school': 'School' })[sel] }), querySelectorAll: () => [] }];
  const elements = new Map();
  const context = { URLSearchParams, location: { search: '' }, localStorage: { getItem: () => 'synthetic-token' }, document: { getElementById: id => {
    if (!elements.has(id)) elements.set(id, id === 'dep-list' ? { innerHTML: '', appendChild(row) { rows.push(row); } } : { value: '', style: {}, classList: { add() {}, remove() {} }, addEventListener() {} });
    return elements.get(id);
  }, querySelectorAll: sel => sel === '#dep-list .dep-row' ? rows : [], querySelector: () => null, createElement: () => ({ dataset: {}, innerHTML: '', className: '' }), addEventListener() {} }, window: { scrollTo() {} }, console, fetch: async (...args) => { calls.push(args); return response; }, alert() {} };
  // Execute actual browser functions in a small DOM harness; suppress page startup only.
  vm.runInNewContext(script.replace(/\bbootOrganizer\(\);\s*$/, '').replace('let organizerBootReady = false;', 'var organizerBootReady = false;').replace('let profileRevision = null;', 'var profileRevision = null;'), context);
  context.profileRevision = '0';
  return { context, calls, rows, setResponse: r => { response = r; } };
}

test('step one waits for successful save and retains step on HTTP error', async () => {
  const f = frontend();
  f.setResponse({ ok: false, status: 500, json: async () => ({ error: 'synthetic save failed' }) });
  f.context.organizerBootReady = true;
  await f.context.saveProfileAndNext();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][1].method, 'PUT');
  assert.notEqual(f.context.document.getElementById('step-2').className, 'active');
});

test('saved new dependent receives returned ID before a later profile save', async () => {
  const f = frontend();
  f.context.organizerBootReady = true;
  f.rows[0].dataset.dependentId = '';
  f.setResponse({ ok: true, json: async () => ({ profile: { profile_revision: '1', dependents: [{ id: 99, full_name: 'Child Example' }] } }) });
  const firstSave = f.context.saveProfileIfLive();
  const secondSave = f.context.saveProfileIfLive();
  await Promise.all([firstSave, secondSave]);
  assert.equal(JSON.parse(f.calls[0][1].body).profile.dependents[0].id, undefined);
  assert.equal(JSON.parse(f.calls[1][1].body).profile.dependents[0].id, 99);
});

test('committed save with changed dependent row requires reload before retry', async () => {
  const f = frontend();
  f.context.organizerBootReady = true;
  f.rows[0].dataset.dependentId = '';
  f.context.profileRevision = '3';
  f.setResponse({ ok: true, json: async () => ({ profile: { profile_revision: '4', dependents: [{ id: 99, full_name: 'Before Edit' }] } }) });
  await assert.rejects(f.context.saveProfileIfLive(), /Refresh/);
  await assert.rejects(f.context.saveProfileIfLive(), /Refresh/);
  assert.equal(f.calls.length, 1);
});

test('ambiguous committed save response cannot be retried with an ID-less dependent', async () => {
  const f = frontend();
  f.context.organizerBootReady = true;
  f.rows[0].dataset.dependentId = '';
  f.setResponse({ ok: true, json: async () => { throw new Error('response lost'); } });
  await assert.rejects(f.context.saveProfileIfLive(), /response lost/);
  await assert.rejects(f.context.saveProfileIfLive(), /Refresh/);
  assert.equal(f.calls.length, 1);
});

test('stale profile conflict prevents advancement and preserves revision', async () => {
  const f = frontend();
  f.context.organizerBootReady = true;
  f.context.profileRevision = '3';
  f.setResponse({ ok: false, status: 409 });
  await f.context.saveProfileAndNext();
  assert.equal(f.calls.length, 1);
  assert.equal(f.context.profileRevision, '3');
  assert.match(f.context.document.getElementById('profile-save-error').textContent, /Refresh/i);
  assert.notEqual(f.context.document.getElementById('step-2').className, 'active');
});

test('profile save sends loaded revision and advances it from server response', async () => {
  const f = frontend();
  f.context.organizerBootReady = true;
  f.context.profileRevision = '3';
  f.setResponse({ ok: true, json: async () => ({ profile: { profile_revision: '4', dependents: [{ id: 41, full_name: 'Child Example' }] } }) });
  await f.context.saveProfileIfLive();
  assert.equal(JSON.parse(f.calls[0][1].body).expected_revision, '3');
  assert.equal(f.context.profileRevision, '4');
});

test('submit does not send profile or submit when answers HTTP save fails', async () => {
  const f = frontend();
  f.context.organizerBootReady = true;
  f.setResponse({ ok: false, status: 503 });
  await f.context.submitOrg();
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0][0], /\/answers$/);
});

test('submit refuses authenticated boot failure before any write', async () => {
  const f = frontend();
  await f.context.submitOrg();
  assert.equal(f.calls.length, 0);
});

test('dependent IDs survive browser collection and failed boot cannot submit demo profile', async () => {
  const f = frontend();
  assert.equal(f.context.collectProfile().dependents[0].id, 41);
  f.context.organizerBootReady = false;
  await f.context.goStep(2);
  assert.equal(f.calls.length, 0);
});
function blankRow(values = {}) {
  return { dataset: {}, querySelector: sel => ({ value: values[sel] || '' }), querySelectorAll: () => Object.values(values).map(value => ({ value })) };
}

test('an untouched blank dependent row does not block Next after a successful save', async () => {
  const f = frontend();
  const steps = [];
  f.context.goStep = n => steps.push(n);
  f.context.organizerBootReady = true;
  f.rows.push(blankRow());
  await f.context.saveProfileAndNext();
  assert.equal(JSON.parse(f.calls[0][1].body).profile.dependents.length, 1);
  assert.deepEqual(steps, [2]);
});

test('a saved dependent with a cleared name is not silently dropped', async () => {
  const f = frontend();
  const steps = [];
  f.context.goStep = n => steps.push(n);
  f.context.organizerBootReady = true;
  f.rows[0] = { dataset: { dependentId: '41' }, querySelector: () => ({ value: '' }), querySelectorAll: () => [] };
  await f.context.saveProfileAndNext();
  assert.equal(f.calls.length, 0);
  assert.deepEqual(steps, []);
  assert.match(f.context.document.getElementById('profile-save-error').textContent, /name for each dependent/);
});

test('a new row with details but no name asks for a name instead of dropping it', async () => {
  const f = frontend();
  f.context.organizerBootReady = true;
  f.rows.push(blankRow({ '.dep-relationship': 'Daughter' }));
  await f.context.saveProfileAndNext();
  assert.equal(f.calls.length, 0);
});

test('a failed answers save shows an error and stays on the questions step', async () => {
  const f = frontend();
  const steps = [];
  f.context.goStep = n => steps.push(n);
  f.setResponse({ ok: false, status: 500, json: async () => ({}) });
  await f.context.saveAnswersAndNext();
  await f.context.saveAnswersThenReview();
  assert.deepEqual(steps, []);
  assert.match(f.context.document.getElementById('question-error').textContent, /not saved/);
});
