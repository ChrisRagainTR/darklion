'use strict';
const { verifyRelease } = require('./verify-release');

// Only the two seed-staging.js fixtures, through real password authentication.
// Uses no production secret or forged token. Does not send messages or upload.
async function verifyStagingSmoke(env = process.env) {
  if (env.STAGING_SMOKE_CONFIRMATION !== 'synthetic-reads-only' || env.EXPECTED_ENVIRONMENT !== 'staging') throw new Error('Isolated staging is required');
  for (const k of ['E2E_STAGING_ACCESS_KEY','STAGING_STAFF_PASSWORD','STAGING_CLIENT_PASSWORD']) if (!env[k]) throw new Error(k + ' is required');
  const expected = { baseUrl: env.BASE_URL, expectedCommit: env.EXPECTED_COMMIT, expectedEnvironment: 'staging' };
  await verifyRelease(expected);
  const base = new URL(env.BASE_URL).origin;
  const headers = { 'Content-Type': 'application/json', 'X-DarkLion-Staging-Key': env.E2E_STAGING_ACCESS_KEY };
  async function request(path, { token, body, status = 200 } = {}) {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { ...headers, ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status !== status) throw new Error('Unexpected status for ' + path + ': ' + response.status);
    return response.json();
  }
  const firms = [];
  for (const name of ['alpha','beta']) {
    const slug = 'darklion-staging-' + name;
    const staff = await request('/firms/login', { body: { email: `staff-${name}@darklion.example.invalid`, password: env.STAGING_STAFF_PASSWORD } });
    const me = await request('/firms/me', { token: staff.token });
    if (me.name !== 'Synthetic ' + name.toUpperCase() || me.id !== staff.firm?.id) throw new Error('Unexpected synthetic firm identity');
    const portal = await request('/portal-auth/login', { body: { email: 'client@darklion.example.invalid', password: env.STAGING_CLIENT_PASSWORD, firmSlug: slug } });
    const person = await request('/portal/me', { token: portal.token });
    if (person.id !== portal.person?.id || person.firmId !== me.id) throw new Error('Unexpected synthetic client identity');
    await request('/api/people/' + person.id, { token: staff.token });
    await request('/api/people/' + person.id, { token: portal.token, status: 401 });
    firms.push({ slug, firmId: me.id, personId: person.id, relationshipId: person.relationshipId, token: staff.token });
  }
  if (firms[0].firmId === firms[1].firmId || firms[0].personId === firms[1].personId) throw new Error('Fixtures must be distinct');
  for (const [own, other] of [[firms[0],firms[1]],[firms[1],firms[0]]]) {
    await request('/api/people/' + other.personId, { token: own.token, status: 404 });
    await request('/api/relationships/' + other.relationshipId, { token: own.token, status: 404 });
  }
  if ((await fetch(base + '/firms/me', { redirect: 'error', signal: AbortSignal.timeout(10000) })).status !== 401) throw new Error('Staging gate is not enforced');
  const config = await fetch(base + '/realtime-config.js', { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!config.ok || !(await config.text()).includes('"enabled":false')) throw new Error('Staging realtime must be disabled');
  await verifyRelease(expected);
  return { revision: env.EXPECTED_COMMIT, environment: 'staging', firms: firms.map(({ token, ...record }) => record), checks: ['actual staff and client password logins', 'same client email resolves by firm slug', 'own-record read', 'cross-firm person/relationship denial', 'portal token denied staff API', 'staging gate', 'realtime disabled', 'exact revision before/after'], limitations: ['No document or archive storage verification', 'No production data or installed-device tests'] };
}
if (require.main === module) verifyStagingSmoke().then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { verifyStagingSmoke };
