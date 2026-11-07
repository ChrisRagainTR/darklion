'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const express = require('express');
const { createReleaseHealth, releaseIdentity } = require('../../server/services/releaseHealth');
const { verifyRelease } = require('../../scripts/verify-release');

const COMMIT = 'a'.repeat(40);
const env = { RAILWAY_GIT_COMMIT_SHA: COMMIT, RAILWAY_ENVIRONMENT_NAME: 'development' };

async function listen(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, checkDatabase = async () => {}, timeoutMs = 30) {
  const health = createReleaseHealth({ checkDatabase, env, timeoutMs });
  const app = express();
  app.use(health.router);
  const base = await listen(t, app);
  return { ...health, base };
}

test('liveness stays available while readiness waits for initialization', async t => {
  let probes = 0;
  const health = await fixture(t, async () => { probes++; });
  const live = await fetch(`${health.base}/health`);
  assert.equal(live.status, 200);
  assert.equal(live.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await live.json(), { status: 'ok', release: { commit: COMMIT, environment: 'development' } });
  const starting = await fetch(`${health.base}/ready`);
  assert.equal(starting.status, 503);
  assert.equal(starting.headers.get('retry-after'), '2');
  assert.equal((await starting.json()).status, 'starting');
  assert.equal(probes, 0);

  health.markReady();
  assert.equal((await fetch(`${health.base}/ready`)).status, 200);
  assert.equal(probes, 1);
});

test('database failure is redacted and readiness recovers without restarting', async t => {
  let fail = true;
  const health = await fixture(t, async () => { if (fail) throw new Error('private database password'); });
  health.markReady();
  const unavailable = await fetch(`${health.base}/ready`);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { status: 'unavailable', release: { commit: COMMIT, environment: 'development' } });
  assert.equal((await fetch(`${health.base}/health`)).status, 200);
  fail = false;
  assert.equal((await fetch(`${health.base}/ready`)).status, 200);
});

test('a hanging probe times out without queuing more database queries', async t => {
  let finish;
  let probes = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  const health = await fixture(t, () => { probes++; return pending; });
  health.markReady();
  const responses = await Promise.all(Array.from({ length: 6 }, () => fetch(`${health.base}/ready`)));
  responses.forEach(response => assert.equal(response.status, 503));
  assert.equal((await fetch(`${health.base}/ready`)).status, 503);
  assert.equal(probes, 1);
  finish();
  await pending;
  assert.equal((await fetch(`${health.base}/ready`)).status, 200);
});

test('startup failure wins over an in-flight probe and cannot be marked ready again', async t => {
  let finish;
  let began;
  const probing = new Promise(resolve => { began = resolve; });
  const health = await fixture(t, () => { began(); return new Promise(resolve => { finish = resolve; }); });
  health.markReady();
  const response = fetch(`${health.base}/ready`);
  await probing;
  health.markFailed();
  finish();
  assert.equal((await response).status, 503);
  health.markReady();
  assert.equal((await fetch(`${health.base}/ready`)).status, 503);
});

test('release metadata only includes validated identity fields', () => {
  assert.deepEqual(releaseIdentity({ ...env, JWT_SECRET: 'private', DATABASE_URL: 'private' }), {
    commit: COMMIT, environment: 'development',
  });
  assert.deepEqual(releaseIdentity({ RAILWAY_GIT_COMMIT_SHA: 'invalid', RAILWAY_ENVIRONMENT_NAME: 'https://private' }), {
    commit: null, environment: null,
  });
  assert.deepEqual(releaseIdentity({ NODE_ENV: 'test' }), { commit: null, environment: 'test' });
});

// Execute the actual startup entrypoint with all external services stubbed.
// This catches mount order and premature markReady calls without a real DB,
// credentials, migrations, scheduled jobs, or customer notifications.
async function startupFixture(t, { workersFail = false, jobsEnabled = true } = {}) {
  const filename = path.resolve(__dirname, '../../server/index.js');
  const localRequire = createRequire(filename);
  let server;
  let initialize;
  let rejectInitialization;
  let exited = false;
  let workersStarted = false;
  let domainLookups = 0;
  let probes = 0;
  const initialized = new Promise((resolve, reject) => { initialize = resolve; rejectInitialization = reject; });
  const external = new Proxy(function () {}, {
    get(_target, key) { return key === 'then' ? undefined : external; },
    apply() { return external; },
    construct() { return {}; },
  });
  function fakeExpress() {
    const app = express();
    app.listen = (_port, _host, callback) => {
      server = express.application.listen.call(app, 0, '127.0.0.1', callback);
      return server;
    };
    return app;
  }
  Object.assign(fakeExpress, express);
  function stubRequire(name) {
    if (name === 'express') return fakeExpress;
    if (name === 'path') return path;
    if (name === 'fs') return { existsSync: () => false };
    if (name === './db') return {
      initDB: () => initialized,
      pool: { query: async () => { probes++; } },
    };
    if (['helmet', 'express-rate-limit', './services/releaseHealth', './services/runtimeSafety'].includes(name)) return localRequire(name);
    if (name === './middleware/domainFirm') return { domainFirmMiddleware(_req, _res, next) { domainLookups++; next(); } };
    if (name === './mcp/cors') return { mcpCors: (_req, _res, next) => next() };
    if (name === './scheduler') return new Proxy({}, { get: () => () => {
      workersStarted = true;
      if (workersFail) throw new Error('synthetic scheduler failure');
    } });
    return external;
  }
  const silent = { log() {}, warn() {}, error() {} };
  const run = vm.compileFunction(fs.readFileSync(filename, 'utf8'),
    ['require', '__dirname', 'process', 'console', 'setTimeout', 'setInterval'], { filename });
  run(stubRequire, path.dirname(filename), {
    env: { ...env, NODE_ENV: 'production', JWT_SECRET: 'synthetic-release-test-secret-32-characters', ENCRYPTION_KEY: '1'.repeat(64), BACKGROUND_JOBS_ENABLED: String(jobsEnabled) },
    on() {}, exit() { exited = true; },
  }, silent, () => 0, () => 0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    initialize, rejectInitialization,
    state: () => ({ exited, workersStarted, domainLookups, probes }),
  };
}

test('real startup serves probes before domain resolution, HTTPS, and auth; readiness waits for DB and workers', async t => {
  const app = await startupFixture(t);
  const options = { headers: { Host: 'synthetic-firm.example.invalid' }, redirect: 'manual' };
  assert.equal((await fetch(`${app.base}/health`, options)).status, 200);
  assert.equal((await fetch(`${app.base}/ready`, options)).status, 503);
  assert.deepEqual(app.state(), { exited: false, workersStarted: false, domainLookups: 0, probes: 0 });
  app.initialize();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await fetch(`${app.base}/ready`, options)).status, 200);
  assert.deepEqual(app.state(), { exited: false, workersStarted: true, domainLookups: 0, probes: 1 });
});

for (const failure of ['database', 'workers']) {
  test(`real startup never becomes ready after ${failure} initialization fails`, async t => {
    const app = await startupFixture(t, { workersFail: failure === 'workers' });
    if (failure === 'database') app.rejectInitialization(new Error('synthetic database failure'));
    else app.initialize();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await fetch(`${app.base}/ready`)).status, 503);
    assert.equal(app.state().exited, true);
    assert.equal(app.state().probes, 0);
  });
}

test('release verification proves a ready revision over HTTP', async t => {
  const health = await fixture(t);
  health.markReady();
  assert.deepEqual(await verifyRelease({
    baseUrl: health.base, expectedCommit: COMMIT, expectedEnvironment: 'development',
  }), { origin: health.base, commit: COMMIT, environment: 'development' });
});

const body = (commit = COMMIT, environment = 'development') => ({ status: 'ok', release: { commit, environment } });
const response = (value, status = 200) => ({ status, json: async () => value });
const verification = { baseUrl: 'https://synthetic.example.invalid', expectedCommit: COMMIT, expectedEnvironment: 'development', timeoutMs: 40, intervalMs: 1 };

test('release verifier waits through startup, transport errors, and an older revision', async () => {
  const attempts = [null, response(body(), 503), response(body('b'.repeat(40))), response(body())];
  let count = 0;
  await verifyRelease({ ...verification, timeoutMs: 1000, fetchImpl: async (url, options) => {
    assert.equal(url.pathname, '/ready');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    const current = attempts[count++];
    if (!current) throw new Error('private transport error');
    return current;
  } });
  assert.equal(count, 4);
});

test('release verifier rejects the wrong environment immediately', async () => {
  let attempts = 0;
  await assert.rejects(verifyRelease({ ...verification, fetchImpl: async () => {
    attempts++; return response(body(COMMIT, 'production'));
  } }), /different environment/);
  assert.equal(attempts, 1);
});

test('a healthy old revision, missing identity, or invalid response cannot pass', async () => {
  for (const value of [body('b'.repeat(40)), body(null), { status: 'ok' }, null]) {
    await assert.rejects(verifyRelease({ ...verification, fetchImpl: async () => response(value) }), /timed out/);
  }
});

test('release verifier requires an explicit origin, full revision, and environment before sending requests', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return response(body()); };
  for (const invalid of [
    { baseUrl: undefined }, { baseUrl: 'http://remote.example.invalid' },
    { baseUrl: 'https://user:private@example.invalid' }, { baseUrl: 'https://example.invalid/?secret=value' },
    { baseUrl: 'https://example.invalid/path' }, { expectedCommit: 'abc123' },
    { expectedEnvironment: '' }, { timeoutMs: NaN }, { timeoutMs: 0 },
  ]) await assert.rejects(verifyRelease({ ...verification, ...invalid, fetchImpl }));
  assert.equal(calls, 0);
});

test('real startup can become ready with all scheduled workers disabled', async t => {
  const app = await startupFixture(t, { jobsEnabled: false });
  app.initialize();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await fetch(`${app.base}/ready`)).status, 200);
  assert.equal(app.state().workersStarted, false);
});
