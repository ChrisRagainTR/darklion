'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function routeHarness(kind, { firmId = 7, rows, mfa = false } = {}) {
  const file = kind === 'portal' ? 'portal-auth.js' : 'firms.js';
  const source = fs.readFileSync(path.join(__dirname, '../../server/routes', file), 'utf8');
  const start = source.indexOf("router.post('/login'");
  const end = source.indexOf('\n// ---', start);
  let handler; const queries = []; const sessions = []; const identities = [];
  const account = kind === 'portal'
    ? { id: 11, firm_id: 7, signer_role: 'spouse', spouse_portal_password_hash: 'valid-hash', spouse_email: 'user@example.invalid' }
    : { id: 12, firm_id: 7, password_hash: 'valid-hash', accepted_at: '2026-01-01', role: 'admin' };
  vm.runInNewContext(source.slice(start, end), {
    router: { post: (_path, _limiter, fn) => { handler = fn; } },
    loginLimiter: null, portalLoginLimiter: null, console,
    resolveLoginFirm: async email => { identities.push(email); return firmId; },
    pool: { query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: sql.includes('SELECT') ? (rows ?? (params[1] == null ? [] : [account])) : [] };
    } },
    bcrypt: { compare: async (password, hash) => password === 'correct' && hash === 'valid-hash' },
    auditLog: async () => {},
    buildPortalToken: async (person, firm, role) => { sessions.push({ person: person.id, firm, role }); return 'portal-session'; },
    portalSessionBody: (_req, _res, token) => ({ token }),
    buildToken: async person => { sessions.push({ person: person.id, firm: person.firm_id, role: person.role }); return 'staff-session'; },
    require: module => module.endsWith('accountSecurity') ? {
      requireLoginMfa: async (_identity, code) => {
        if (mfa && code !== '123456') throw Object.assign(new Error('Authentication code required'), { code: 'MFA_REQUIRED' });
      }, ensureAccount: async () => ({ mfa_enabled: mfa })
    } : { getFirmPreferences: async () => ({ staffMfaRequired: false }) },
  });
  return { queries, sessions, identities, run: async (body = {}) => {
    let status = 200; let data;
    await handler({ body: { email: ' USER@EXAMPLE.INVALID ', password: 'correct', firmSlug: 'wrong-firm', ...body }, domainFirm: { id: 99, slug: 'wrong-domain' } }, {
      status: code => { status = code; return { json: value => { data = value; } }; },
      json: value => { data = value; },
    });
    return { status, data };
  } };
}

for (const kind of ['portal', 'staff']) {
  test(`${kind} login derives firm from records, ignoring submitted and branded firm selectors`, async () => {
    const h = routeHarness(kind);
    const result = await h.run();
    assert.equal(result.status, 200);
    assert.equal(h.identities[0], 'user@example.invalid');
    assert.deepEqual(Array.from(h.queries[0].params), ['user@example.invalid', 7]);
    assert.equal(h.sessions[0].firm, 7);
    assert.equal(h.sessions[0].role, kind === 'portal' ? 'spouse' : 'admin');
  });
  test(`${kind} login rejects ambiguous firm identity and cannot bypass it with a slug`, async () => {
    const h = routeHarness(kind, { firmId: null });
    const result = await h.run();
    assert.equal(result.status, 401);
    assert.equal(h.sessions.length, 0);
    assert.equal(result.data.error.includes('firm code'), false);
  });
  test(`${kind} login requires MFA only after verifying the password`, async () => {
    const h = routeHarness(kind, { mfa: true });
    const wrong = await h.run({ password: 'wrong' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.data.code, undefined);
    assert.equal((await h.run()).data.code, 'MFA_REQUIRED');
    assert.equal(h.sessions.length, 0);
    assert.equal((await h.run({ mfaCode: '123456' })).status, 200);
    assert.equal(h.sessions.length, 1);
  });
}
