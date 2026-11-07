'use strict';

// Authenticate a verified synthetic user through the app. Never forge a JWT or
// reuse an auth file from another environment, firm, or deployment.
const fs = require('node:fs');
const path = require('node:path');
const { verifyRelease } = require('../scripts/verify-release');
const AUTH_STATE_PATH = path.resolve(__dirname, '.auth/user.json');

module.exports = async function globalSetup() {
  fs.rmSync(AUTH_STATE_PATH, { force: true });
  // Static contract tests do not contact a deployment or need credentials.
  if (process.env.E2E_LOCAL_CONTRACTS === 'true') {
    const target = new URL(process.env.BASE_URL || 'http://unset.invalid');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) throw new Error('Local contracts must use an explicit loopback target');
    fs.mkdirSync(path.dirname(AUTH_STATE_PATH), { recursive: true, mode: 0o700 });
    fs.writeFileSync(AUTH_STATE_PATH, JSON.stringify({ cookies: [], origins: [] }), { mode: 0o600 });
    return;
  }
  const env = process.env;
  if (env.E2E_ISOLATION_VERIFIED !== 'true' || env.EXPECTED_ENVIRONMENT !== 'staging') throw new Error('Verified isolated staging is required');
  if (!env.TEST_EMAIL?.endsWith('@darklion.example.invalid') || !env.TEST_PASSWORD || !env.E2E_STAGING_ACCESS_KEY) throw new Error('Synthetic staging credentials are required');
  const firmId = Number(env.E2E_FIRM_ID);
  if (!Number.isSafeInteger(firmId) || firmId <= 0) throw new Error('E2E_FIRM_ID must identify the seeded synthetic firm');
  await verifyRelease({ baseUrl: env.BASE_URL, expectedCommit: env.EXPECTED_COMMIT, expectedEnvironment: env.EXPECTED_ENVIRONMENT });
  const response = await fetch(env.BASE_URL + '/firms/login', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', 'X-DarkLion-Staging-Key': env.E2E_STAGING_ACCESS_KEY },
    body: JSON.stringify({ email: env.TEST_EMAIL, password: env.TEST_PASSWORD }),
  });
  if (!response.ok) throw new Error('Synthetic staff login failed (' + response.status + ')');
  const data = await response.json();
  if (!data.token || data.firm?.id !== firmId) throw new Error('Synthetic staff login resolved to the wrong firm');
  const me = await fetch(env.BASE_URL + '/firms/me', {
    redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Bearer ' + data.token, 'X-DarkLion-Staging-Key': env.E2E_STAGING_ACCESS_KEY },
  });
  if (!me.ok || (await me.json()).id !== firmId) throw new Error('Synthetic staff identity verification failed');
  fs.mkdirSync(path.dirname(AUTH_STATE_PATH), { recursive: true, mode: 0o700 });
  const origin = new URL(env.BASE_URL);
  fs.writeFileSync(AUTH_STATE_PATH, JSON.stringify({ cookies: [{ name: 'dl_staging_access', value: env.E2E_STAGING_ACCESS_KEY,
    domain: origin.hostname, path: '/', httpOnly: true, secure: true, sameSite: 'Strict', expires: Math.floor(Date.now() / 1000) + 3600,
  }], origins: [{ origin: env.BASE_URL,
    localStorage: [{ name: 'dl_token', value: data.token }, { name: 'dl_firm', value: JSON.stringify(data.firm) }],
  }] }), { mode: 0o600 });
};
