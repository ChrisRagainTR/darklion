'use strict';

const { setTimeout: sleep } = require('node:timers/promises');

// GET-only verification: no login, customer data, or service credentials.
async function verifyRelease({
  baseUrl,
  expectedCommit,
  expectedEnvironment,
  timeoutMs = 120000,
  intervalMs = 2000,
  requestTimeoutMs = 5000,
  fetchImpl = fetch,
}) {
  let target;
  try { target = new URL(baseUrl); } catch { throw new Error('BASE_URL must be an explicit application origin.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  if ((target.protocol !== 'https:' && !(local && target.protocol === 'http:')) ||
      target.username || target.password || target.search || target.hash || target.pathname !== '/') {
    throw new Error('BASE_URL must be an HTTPS origin without credentials, path, query, or fragment (HTTP is allowed on loopback).');
  }
  if (!/^[a-f0-9]{40}$/i.test(expectedCommit || '')) {
    throw new Error('EXPECTED_COMMIT must be a full 40-character Git commit SHA.');
  }
  if (!/^[a-z0-9_-]{1,64}$/i.test(expectedEnvironment || '')) {
    throw new Error('EXPECTED_ENVIRONMENT must name the target Railway environment.');
  }
  for (const value of [timeoutMs, intervalMs, requestTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Release timeouts must be positive integer milliseconds.');
  }

  const deadline = Date.now() + timeoutMs;
  const expected = expectedCommit.toLowerCase();
  let lastFailure = 'No readiness response received';
  do {
    let response;
    let body;
    try {
      response = await fetchImpl(new URL('/ready', target), {
        method: 'GET',
        redirect: 'error',
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
        signal: AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMs, deadline - Date.now()))),
      });
      body = await response.json();
    } catch {
      // A proxy error page or transport error can contain sensitive information.
      lastFailure = 'Readiness request failed or returned invalid JSON';
    }
    if (body) {
      if (body.release?.environment && body.release.environment !== expectedEnvironment) {
        throw new Error('Readiness reported a different environment; refusing to verify this target.');
      }
      if (response.status !== 200 || body.status !== 'ok') {
        lastFailure = 'Application is not ready';
      } else if (body.release?.environment !== expectedEnvironment) {
        lastFailure = 'Deployment environment is missing';
      } else if (body.release?.commit !== expected) {
        lastFailure = 'Expected commit is not serving yet';
      } else {
        return { origin: target.origin, commit: expected, environment: expectedEnvironment };
      }
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await sleep(Math.min(intervalMs, remaining));
  } while (Date.now() < deadline);
  throw new Error(`Release verification timed out: ${lastFailure}.`);
}

if (require.main === module) {
  verifyRelease({
    baseUrl: process.env.BASE_URL,
    expectedCommit: process.env.EXPECTED_COMMIT,
    expectedEnvironment: process.env.EXPECTED_ENVIRONMENT,
    timeoutMs: process.env.RELEASE_TIMEOUT_MS === undefined ? 120000 : Number(process.env.RELEASE_TIMEOUT_MS),
  }).then(result => {
    console.log(`Verified ${result.environment}: ${result.commit} at ${result.origin}`);
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { verifyRelease };
