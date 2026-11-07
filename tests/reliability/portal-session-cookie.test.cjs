'use strict';
// S3c: web portal session in an HttpOnly cookie, Bearer unchanged for the native app.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const express = require('express');

process.env.JWT_SECRET = 'portal-session-cookie-test-secret';
const server = p => path.resolve(__dirname, '../../server', p);
const queries = [];
const state = { personEnabled: true, revokedSids: new Set(), passwordHash: null };

// Synthetic database: answers only what the portal session paths ask.
const pool = {
  async query(sql, params = []) {
    queries.push({ sql, params });
    if (/FROM people WHERE id=\$1 AND firm_id=\$2/.test(sql)) {
      return { rows: Number(params[0]) === 11 && Number(params[1]) === 7 ? [{ id: 11, firm_id: 7, relationship_id: null, email: 'client@example.invalid', first_name: 'Test', last_name: 'Client', spouse_name: null, spouse_email: null, portal_enabled: state.personEnabled, spouse_portal_enabled: false }] : [] };
    }
    if (/FROM firm_users WHERE id=\$1 AND firm_id=\$2/.test(sql)) return { rows: [{ id: 3 }] };
    if (/SELECT version,mfa_enabled FROM account_security/.test(sql)) return { rows: [{ version: 0, mfa_enabled: false }] };
    if (/SELECT id FROM account_sessions WHERE id=\$5/.test(sql)) return { rows: state.revokedSids.has(params[4]) ? [] : [{ id: params[4] }], rowCount: state.revokedSids.has(params[4]) ? 0 : 1 };
    if (/^\s*UPDATE account_sessions SET revoked_at=NOW\(\)/.test(sql)) { state.revokedSids.add(params[4]); return { rows: [], rowCount: 1 }; }
    if (/SELECT DISTINCT firm_id FROM/.test(sql)) return { rows: [{ firm_id: 7 }] };
    if (/CROSS JOIN LATERAL/.test(sql)) return { rows: [{ id: 11, firm_id: 7, email: 'client@example.invalid', first_name: 'Test', last_name: 'Client', firm_name: 'Example Firm', signer_role: 'taxpayer', portal_password_hash: state.passwordHash }] };
    if (/SELECT \* FROM account_security WHERE/.test(sql)) return { rows: [{ version: 0, mfa_enabled: false }] };
    if (/portal_password_hash AS hash FROM people/.test(sql)) return { rows: [{ hash: state.passwordHash }] };
    return { rows: [], rowCount: 0 };
  },
};
function stub(file, exports) {
  const filename = require.resolve(server(file));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
stub('db.js', { pool });
stub('services/subscriptions.js', { requireSubscription: (_req, _res, next) => next() });
stub('services/audit.js', { auditLog: async () => {} });
stub('services/email.js', { sendPasswordReset: async () => {} });
stub('services/portalAccess.js', { sendPortalInviteForPerson: async () => ({}) });

const { requirePortal } = require(server('middleware/requirePortal.js'));
const portalSession = require(server('services/portalSession.js'));
const accountSecurity = require(server('services/accountSecurity.js'));

let base, host, httpServer;
const sessionToken = (claims = {}) => jwt.sign({ personId: 11, firmId: 7, type: 'portal', signerRole: 'taxpayer', av: 0, sid: '00000000-0000-4000-8000-000000000001', ...claims }, process.env.JWT_SECRET, { expiresIn: '7d' });
const previewToken = () => jwt.sign({ personId: 11, firmId: 7, type: 'portal', signerRole: 'taxpayer', ghostedBy: 3, previewStaff: { av: 0, sid: '00000000-0000-4000-8000-0000000000aa' }, ghostedByName: 'Pat Advisor' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const cookieFor = token => `${portalSession.COOKIE_NAME}=${token}`;

before(async () => {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/portal-auth', require(server('routes/portal-auth.js')));
  app.all('/portal/probe', requirePortal, (req, res) => res.json({ source: req.portalAuthSource, preview: req.portal.preview, personId: req.portal.personId, previewBy: req.portal.previewByName }));
  httpServer = app.listen(0, '127.0.0.1');
  await new Promise(resolve => httpServer.once('listening', resolve));
  host = `127.0.0.1:${httpServer.address().port}`;
  base = `http://${host}`;
  state.passwordHash = await bcrypt.hash('Correct1!', 4);
});
after(() => new Promise(resolve => { httpServer.close(resolve); httpServer.closeAllConnections(); }));

test('cookie parser reads the session cookie among others', () => {
  assert.deepEqual(portalSession.parseCookies('a=1; portal_session=x.y.z; b="q%20r"'), { a: '1', portal_session: 'x.y.z', b: 'q r' });
  assert.deepEqual(portalSession.parseCookies(''), {});
});

test('cookie session is accepted for reads', async () => {
  const res = await fetch(base + '/portal/probe', { headers: { Cookie: cookieFor(sessionToken()) } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { source: 'cookie', preview: false, personId: 11, previewBy: null });
});

test('no token and no cookie is 401', async () => {
  assert.equal((await fetch(base + '/portal/probe')).status, 401);
});

test('"Bearer null", "Bearer undefined" and an empty Bearer fall through to the cookie', async () => {
  for (const authorization of ['Bearer null', 'Bearer undefined', 'Bearer ', 'Bearer']) {
    const res = await fetch(base + '/portal/probe', { headers: { Authorization: authorization, Cookie: cookieFor(sessionToken()) } });
    assert.equal(res.status, 200, authorization);
    assert.equal((await res.json()).source, 'cookie');
  }
});

test('a real Bearer token wins over the cookie and keeps working without one', async () => {
  const res = await fetch(base + '/portal/probe', { headers: { Authorization: 'Bearer ' + sessionToken() } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).source, 'bearer');
  const bad = await fetch(base + '/portal/probe', { headers: { Authorization: 'Bearer ' + sessionToken({ personId: 99 }), Cookie: cookieFor(sessionToken()) } });
  assert.equal(bad.status, 401, 'an invalid Bearer token does not silently fall back to the cookie');
});

test('cookie writes from another site are rejected (CSRF guard)', async () => {
  for (const headers of [{ Origin: 'https://evil.example' }, { Origin: 'null' }, { Referer: 'https://evil.example/page' }, {}]) {
    const res = await fetch(base + '/portal/probe', { method: 'POST', headers: { ...headers, Cookie: cookieFor(sessionToken()) } });
    assert.equal(res.status, 403, JSON.stringify(headers));
    assert.equal((await res.json()).error, 'Cross-site request blocked');
  }
});

test('cookie writes from this site are allowed (Origin, or Referer when Origin is missing or null)', async () => {
  for (const headers of [{ Origin: base }, { Referer: base + '/portal' }, { Origin: 'null', Referer: base + '/portal' }]) {
    const res = await fetch(base + '/portal/probe', { method: 'PUT', headers: { ...headers, Cookie: cookieFor(sessionToken()) } });
    assert.equal(res.status, 200, JSON.stringify(headers));
  }
  const forwarded = await fetch(base + '/portal/probe', { method: 'POST', headers: { Origin: 'https://my.example.invalid', 'X-Forwarded-Host': 'my.example.invalid', Cookie: cookieFor(sessionToken()) } });
  assert.equal(forwarded.status, 200, 'public host forwarded by the proxy counts as this site');
});

test('Bearer requests are not affected by the Origin check', async () => {
  const res = await fetch(base + '/portal/probe', { method: 'POST', headers: { Origin: 'https://evil.example', Authorization: 'Bearer ' + sessionToken() } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).source, 'bearer');
});

test('adopt validates the Bearer token and sets the HttpOnly cookie for its remaining lifetime', async () => {
  const res = await fetch(base + '/portal-auth/session/adopt', { method: 'POST', headers: { Origin: base, Authorization: 'Bearer ' + sessionToken() } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, preview: false });
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /^portal_session=[\w-]+\.[\w-]+\.[\w-]+;/);
  for (const attribute of ['HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(cookie.includes(attribute), attribute);
  assert.ok(!cookie.includes('Secure'), 'plain http test server: not Secure');
  const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)[1]);
  assert.ok(maxAge > 7 * 86400 - 60 && maxAge <= 7 * 86400, String(maxAge));
  const reuse = await fetch(base + '/portal/probe', { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(reuse.status, 200);
});

test('adopt marks the cookie Secure behind an https proxy', async () => {
  const res = await fetch(base + '/portal-auth/session/adopt', { method: 'POST', headers: { Origin: base, 'X-Forwarded-Proto': 'https', Authorization: 'Bearer ' + sessionToken() } });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('set-cookie').includes('Secure'));
});

test('adopt refuses other sites, missing tokens and invalid tokens without setting a cookie', async () => {
  const cases = [
    [{ Origin: 'https://evil.example', Authorization: 'Bearer ' + sessionToken() }, 403],
    [{ Origin: base }, 401],
    [{ Origin: base, Authorization: 'Bearer ' + jwt.sign({ personId: 11, firmId: 7, type: 'portal' }, 'wrong-secret') }, 401],
    [{ Origin: base, Authorization: 'Bearer ' + jwt.sign({ personId: 11, firmId: 7, type: 'staff' }, process.env.JWT_SECRET) }, 401],
  ];
  for (const [headers, status] of cases) {
    const res = await fetch(base + '/portal-auth/session/adopt', { method: 'POST', headers });
    assert.equal(res.status, status, JSON.stringify(Object.keys(headers)));
    assert.equal(res.headers.get('set-cookie'), null);
  }
});

test('an adopted advisor preview stays read-only and reports who is previewing', async () => {
  const res = await fetch(base + '/portal-auth/session/adopt', { method: 'POST', headers: { Origin: base, Authorization: 'Bearer ' + previewToken() } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, preview: true });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const read = await fetch(base + '/portal/probe', { headers: { Cookie: cookie } });
  assert.deepEqual(await read.json(), { source: 'cookie', preview: true, personId: 11, previewBy: 'Pat Advisor' });
  const write = await fetch(base + '/portal/probe', { method: 'POST', headers: { Origin: base, Cookie: cookie } });
  assert.equal(write.status, 403);
  assert.equal((await write.json()).error, 'Advisor preview is read-only');
});

test('logout revokes the cookie session on the server and clears the cookie', async () => {
  const sid = '00000000-0000-4000-8000-0000000000b1';
  const token = sessionToken({ sid });
  const res = await fetch(base + '/portal-auth/session/logout', { method: 'POST', headers: { Origin: base, Cookie: cookieFor(token) } });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /^portal_session=;/);
  assert.match(cookie, /Expires=Thu, 01 Jan 1970/);
  assert.ok(cookie.includes('HttpOnly') && cookie.includes('SameSite=Strict'));
  assert.ok(state.revokedSids.has(sid));
  const after = await fetch(base + '/portal/probe', { headers: { Cookie: cookieFor(token) } });
  assert.equal(after.status, 401, 'the revoked session no longer works anywhere');
});

test('logout from another site is refused; logout with an expired or preview token still clears the cookie', async () => {
  const sid = '00000000-0000-4000-8000-0000000000b2';
  const foreign = await fetch(base + '/portal-auth/session/logout', { method: 'POST', headers: { Origin: 'https://evil.example', Cookie: cookieFor(sessionToken({ sid })) } });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get('set-cookie'), null);
  assert.equal(state.revokedSids.has(sid), false);
  const before = queries.length;
  const preview = await fetch(base + '/portal-auth/session/logout', { method: 'POST', headers: { Origin: base, Cookie: cookieFor(previewToken()) } });
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get('set-cookie'), /^portal_session=;/);
  assert.equal(queries.slice(before).some(q => /UPDATE account_sessions/.test(q.sql)), false, 'preview logout never touches the advisor session');
  const expired = jwt.sign({ personId: 11, firmId: 7, type: 'portal', sid, exp: Math.floor(Date.now() / 1000) - 10 }, process.env.JWT_SECRET);
  const stale = await fetch(base + '/portal-auth/session/logout', { method: 'POST', headers: { Origin: base, Cookie: cookieFor(expired) } });
  assert.equal(stale.status, 200);
  assert.match(stale.headers.get('set-cookie'), /^portal_session=;/);
});

test('web sign-in sets the cookie and leaves the token out; app sign-in is unchanged', async () => {
  const login = body => fetch(base + '/portal-auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ email: 'client@example.invalid', password: 'Correct1!', ...body }) });
  const web = await login({ session: 'cookie' });
  assert.equal(web.status, 200);
  const webBody = await web.json();
  assert.equal(webBody.session, 'cookie');
  assert.equal(webBody.token, undefined);
  const cookie = web.headers.get('set-cookie');
  assert.ok(cookie && cookie.startsWith('portal_session=') && cookie.includes('HttpOnly'));
  assert.equal((await fetch(base + '/portal/probe', { headers: { Cookie: cookie.split(';')[0] } })).status, 200);

  const app = await fetch(base + '/portal-auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'client@example.invalid', password: 'Correct1!' }) });
  assert.equal(app.status, 200);
  assert.equal(app.headers.get('set-cookie'), null, 'native app sign-in gets no cookie');
  assert.match((await app.json()).token, /^[\w-]+\.[\w-]+\.[\w-]+$/);

  const forged = await fetch(base + '/portal-auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ email: 'client@example.invalid', password: 'Correct1!', session: 'cookie' }) });
  assert.equal(forged.headers.get('set-cookie'), null, 'another site cannot plant a session cookie');
});

test('accountSecurity identity used by logout matches the revoke route', () => {
  assert.deepEqual(accountSecurity.identity({ firmId: 7, kind: 'portal', accountId: 11, signerRole: 'taxpayer' }), [7, 'portal', 11, 'taxpayer']);
});

test('same-site check: default ports, forwarded host, and look-alike hosts', () => {
  const req = headers => ({ headers });
  assert.equal(portalSession.sameOriginRequest(req({ host: 'darklion.ai:443', origin: 'https://darklion.ai' })), true);
  assert.equal(portalSession.sameOriginRequest(req({ host: 'internal:8080', 'x-forwarded-host': 'my.example.invalid', origin: 'https://my.example.invalid' })), true);
  assert.equal(portalSession.sameOriginRequest(req({ host: 'darklion.ai', origin: 'https://darklion.ai.evil.example' })), false);
  assert.equal(portalSession.sameOriginRequest(req({ host: 'darklion.ai', origin: 'https://evil.example', referer: 'https://darklion.ai/portal' })), false, 'a foreign Origin is not rescued by Referer');
  assert.equal(portalSession.sameOriginRequest(req({ origin: 'https://darklion.ai' })), false, 'no host, no match');
  assert.equal(portalSession.wantsWebSession({ headers: { host: 'darklion.ai', origin: 'https://darklion.ai' }, body: {} }), false, 'only when the sign-in page asks');
});
