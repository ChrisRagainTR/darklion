'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const express = require('express');
const safety = require('../../server/services/runtimeSafety');

function staging(overrides = {}) {
  return { DARKLION_ISOLATED_STAGING: 'true', RAILWAY_ENVIRONMENT_NAME: 'staging', NODE_ENV: 'production',
    BACKGROUND_JOBS_ENABLED: 'false', OUTBOUND_DELIVERY_MODE: 'capture', DARKLION_CAPTURE_DIR: '/unused',
    JWT_SECRET: 'j'.repeat(64), ENCRYPTION_KEY: 'e'.repeat(64), DARKLION_STAGING_ACCESS_KEY: 's'.repeat(64),
    DOCUMENT_STORAGE_READ_PROVIDER: 'r2', DOCUMENT_STORAGE_WRITE_PROVIDER: 'r2',
    AWS_S3_BUCKET: 'darklion-staging-documents', R2_DOCUMENT_BUCKET: 'darklion-staging-documents',
    R2_HISTORY_BUCKET: 'darklion-staging-document-versions', ...overrides };
}
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darklion-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('production defaults preserve jobs and live delivery', async () => {
  const env = { RAILWAY_ENVIRONMENT_NAME: 'production', RESEND_API_KEY: 'synthetic-provider-key' };
  safety.assertRuntimeSafety(env);
  assert.equal(safety.backgroundJobsEnabled(env), true);
  assert.equal(await safety.captureNotification('email', {}, env), null);
  assert.deepEqual(safety.realtimeConfiguration(env), { enabled: false });
  assert.deepEqual(safety.realtimeConfiguration({ PUSHER_KEY: 'public', PUSHER_CLUSTER: 'cluster' }), { enabled: true, key: 'public', cluster: 'cluster' });
});

test('staging refuses production identity, automatic jobs, live sending, and provider credentials', () => {
  safety.assertRuntimeSafety(staging());
  for (const override of [
    { RAILWAY_ENVIRONMENT_NAME: 'production' }, { BACKGROUND_JOBS_ENABLED: 'true' },
    { OUTBOUND_DELIVERY_MODE: 'live' }, { DARKLION_CAPTURE_DIR: '' },
    { DARKLION_STAGING_ACCESS_KEY: '' }, { ENCRYPTION_KEY: '' }, { JWT_SECRET: '' },
    { R2_HISTORY_BUCKET: 'darklion-document-versions' }, { R2_HISTORY_BUCKET: 'darklion-staging-documents' },
    { DOCUMENT_STORAGE_READ_PROVIDER: 'aws' }, { COMMUNICATION_ARCHIVE_FAIL_CLOSED: 'false' },
    ...['RESEND_API_KEY', 'TWILIO_AUTH_TOKEN', 'PUSHER_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_SERVICES_ACCOUNT_JSON',
      'STRIPE_SECRET_KEY', 'AWS_SECRET_ACCESS_KEY', 'EMAIL_INBOUND_WEBHOOK_SECRET', 'BLUELEAF_PASSWORD', 'FUTURE_PROVIDER_API_KEY'].map(k => ({ [k]: 'private-value' })),
  ]) assert.throws(() => safety.assertRuntimeSafety(staging(override)), e => !e.message.includes('private-value'));
  assert.throws(() => safety.assertRuntimeSafety({ RAILWAY_ENVIRONMENT_NAME: 'staging' }));
  assert.throws(() => safety.assertRuntimeSafety({ OUTBOUND_DELIVERY_MODE: 'capture' }));
  assert.deepEqual(safety.realtimeConfiguration(staging({ PUSHER_KEY: 'live-key', PUSHER_CLUSTER: 'us2' })), { enabled: false });
});

test('notification capture is private, recoverable, and fails if it cannot persist', async t => {
  const dir = temporary(t), env = staging({ DARKLION_CAPTURE_DIR: dir });
  const captured = await Promise.all(['email', 'sms', 'push', 'realtime'].map(channel => safety.captureNotification(channel, { to: 'test@example.invalid', body: channel }, env)));
  assert.equal(new Set(captured.map(c => c.id)).size, 4);
  const filename = path.join(dir, 'notifications.jsonl');
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  const records = fs.readFileSync(filename, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(r => r.channel).sort(), ['email', 'push', 'realtime', 'sms']);
  await assert.rejects(safety.captureNotification('email', {}, staging({ DARKLION_CAPTURE_DIR: filename })));
});

test('staging archive requires dedicated credentials, expected account, and Object Lock', () => {
  const archive = {
    COMMUNICATION_ARCHIVE_BUCKET: 'darklion-staging-communications-fixture',
    COMMUNICATION_ARCHIVE_REGION: 'us-east-2', COMMUNICATION_ARCHIVE_STORAGE_PROVIDER: 'aws',
    COMMUNICATION_ARCHIVE_ACCESS_KEY_ID: 'synthetic-key', COMMUNICATION_ARCHIVE_SECRET_ACCESS_KEY: 'synthetic-secret',
    COMMUNICATION_ARCHIVE_EXPECTED_BUCKET_OWNER: '123456789012', COMMUNICATION_ARCHIVE_OBJECT_LOCK_ENABLED: 'true',
  };
  safety.assertRuntimeSafety(staging(archive));
  for (const name of Object.keys(archive)) {
    assert.throws(() => safety.assertRuntimeSafety(staging({ ...archive, [name]: '' })));
  }
  for (const override of [
    { COMMUNICATION_ARCHIVE_BUCKET: 'production-archive' },
    { COMMUNICATION_ARCHIVE_STORAGE_PROVIDER: 'r2' },
    { COMMUNICATION_ARCHIVE_OBJECT_LOCK_ENABLED: 'false' },
    { COMMUNICATION_ARCHIVE_EXPECTED_BUCKET_OWNER: 'invalid' },
    { AWS_ACCESS_KEY_ID: 'generic-key' }, { AWS_SECRET_ACCESS_KEY: 'generic-secret' },
    { COMMUNICATION_ARCHIVE_ALLOW_LOCAL_FALLBACK: 'true' },
  ]) assert.throws(() => safety.assertRuntimeSafety(staging({ ...archive, ...override })));
});

test('R2 staging archive is separate, locked, and has no AWS credential fallback', () => {
  const archive = {
    COMMUNICATION_ARCHIVE_BUCKET: 'darklion-staging-communications-archive',
    COMMUNICATION_ARCHIVE_STORAGE_PROVIDER: 'r2',
    COMMUNICATION_ARCHIVE_R2_ENDPOINT: 'https://' + 'a'.repeat(32) + '.r2.cloudflarestorage.com',
    COMMUNICATION_ARCHIVE_R2_BUCKET_LOCK_ENABLED: 'true',
    COMMUNICATION_ARCHIVE_ACCESS_KEY_ID: 'archive-only', COMMUNICATION_ARCHIVE_SECRET_ACCESS_KEY: 'archive-only-secret',
  };
  safety.assertRuntimeSafety(staging(archive));
  for (const override of [{ COMMUNICATION_ARCHIVE_R2_BUCKET_LOCK_ENABLED: '' }, { COMMUNICATION_ARCHIVE_ACCESS_KEY_ID: '' },
    { COMMUNICATION_ARCHIVE_R2_ENDPOINT: 'https://example.com' }, { COMMUNICATION_ARCHIVE_OBJECT_LOCK_ENABLED: 'true' },
    { R2_ACCESS_KEY_ID: 'archive-only' }, { COMMUNICATION_ARCHIVE_EXPECTED_BUCKET_OWNER: '123456789012' }]) {
    assert.throws(() => safety.assertRuntimeSafety(staging({ ...archive, ...override })));
  }
});

test('staging gate keeps probes public and protects routes independently of staff tokens', async t => {
  const env = staging(), app = express();
  app.get('/ready', (_req, res) => res.json({ status: 'ready' }));
  app.use(safety.stagingAccess(env));
  app.get('/private', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/ready')).status, 200);
  for (const headers of [{}, { Authorization: 'Bearer staff-token' }, { 'X-DarkLion-Staging-Key': 'wrong' }]) {
    assert.equal((await fetch(base + '/private', { headers })).status, 401);
  }
  const response = await fetch(base + '/private', { headers: { 'X-DarkLion-Staging-Key': env.DARKLION_STAGING_ACCESS_KEY } });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(cookie.includes(attribute));
  assert.equal((await fetch(base + '/private', { headers: { Cookie: cookie.split(';')[0], Authorization: 'Bearer staff-token' } })).status, 200);
});

function loadService(file, env, stubs = {}) {
  const filename = path.resolve(__dirname, '../../server/services', file);
  const localRequire = createRequire(filename), module = { exports: {} };
  const runtime = { ...safety, captureNotification: (channel, payload) => safety.captureNotification(channel, payload, env) };
  const run = vm.compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports', 'process', 'fetch', 'console'], { filename });
  run(name => name === './runtimeSafety' ? runtime : (stubs[name] || localRequire(name)), module, module.exports, { env },
    () => { throw new Error('External delivery attempted'); }, console);
  return module.exports;
}

test('email, SMS and push adapters capture without contacting providers', async t => {
  const dir = temporary(t), env = staging({ DARKLION_CAPTURE_DIR: dir });
  const db = { pool: { query: async sql => ({ rows: sql.includes('FROM portal_mobile_devices') ? [{ push_token: 'ExpoPushToken[synthetic]' }] : [] }) } };
  const email = loadService('email.js', env, { '../db': db, './s3': {}, './emailReplyTokens': {} });
  assert.equal((await email.sendEmail({ to: 'client@example.invalid', subject: 'Fixture', html: '<p>Test</p>' })).captured, true);
  const sms = loadService('twilio.js', env, { twilio: () => { throw new Error('Twilio used'); } });
  assert.equal((await sms.sendSMS('+12025550123', 'Fixture')).status, 'captured');
  const push = loadService('mobilePush.js', env, { '../db': db });
  assert.deepEqual(await push.sendClientMobilePush({ firmId: 1, personId: 1, body: 'Fixture' }), { sent: 0, captured: 1 });
  assert.deepEqual(fs.readFileSync(path.join(dir, 'notifications.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).map(r => r.channel), ['email', 'sms', 'push']);
});

test('browser realtime never constructs a provider client when disabled; live mode uses server config', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../public/js/realtime.js'), 'utf8');
  let connections = 0;
  const window = { Pusher: class { constructor(key, options) { connections++; assert.equal(key, 'server-key'); assert.equal(options.cluster, 'server-cluster'); } } };
  vm.runInNewContext(source, { window });
  const disabled = window.DLRealtime.create({});
  assert.equal(disabled.subscribe('private-firm-1').subscribed, false);
  assert.equal(disabled.channel('private-firm-1').trigger('typing'), false);
  window.DL_REALTIME_CONFIG = { enabled: false, key: 'old-key' };
  window.DLRealtime.create({});
  assert.equal(connections, 0);
  window.DL_REALTIME_CONFIG = { enabled: true, key: 'server-key', cluster: 'server-cluster' };
  window.DLRealtime.create({ cluster: 'old-cluster' });
  assert.equal(connections, 1);
});

test('disabled draft jobs cannot claim work through a direct worker call', async () => {
  const filename = path.resolve(__dirname, '../../server/services/emmaDraftJobs.js');
  const module = { exports: {} };
  const db = { pool: { query: () => { throw new Error('Disabled worker queried the database'); } } };
  const run = vm.compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports', 'process', 'setInterval'], { filename });
  const localRequire = createRequire(filename);
  run(name => name === './runtimeSafety' ? { backgroundJobsEnabled: () => false } : name === '../db' ? db : localRequire(name),
    module, module.exports, { env: {} }, () => { throw new Error('Disabled worker registered a timer'); });
  module.exports.startEmmaDraftWorker({});
  assert.equal(await module.exports.processNextEmmaDraftJob(), null);
});
