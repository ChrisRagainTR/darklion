'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');

function fixture(env) {
  const filename = path.resolve(__dirname, '../../server/services/communicationArchiveStorage.js');
  const localRequire = createRequire(filename), module = { exports: {} }, clients = [], commands = [];
  const sdk = { ...localRequire('@aws-sdk/client-s3'), S3Client: class {
    constructor(config) { clients.push(config); }
    async send(command) { commands.push(command.input); return { VersionId: 'version', Body: Buffer.from('synthetic') }; }
  } };
  vm.compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports', 'process'], { filename })(
    name => name === '@aws-sdk/client-s3' ? sdk : name === '@aws-sdk/s3-request-presigner'
      ? { getSignedUrl: async (_client, command) => { commands.push(command.input); return 'signed'; } } : localRequire(name),
    module, module.exports, { env });
  return { api: module.exports, clients, commands };
}

test('archive-only credentials and expected account are used for all storage paths', async () => {
  const f = fixture({ COMMUNICATION_ARCHIVE_BUCKET: 'synthetic-archive', COMMUNICATION_ARCHIVE_OBJECT_LOCK_ENABLED: 'true',
    COMMUNICATION_ARCHIVE_ACCESS_KEY_ID: 'archive-id', COMMUNICATION_ARCHIVE_SECRET_ACCESS_KEY: 'archive-secret',
    COMMUNICATION_ARCHIVE_SESSION_TOKEN: 'archive-session', COMMUNICATION_ARCHIVE_EXPECTED_BUCKET_OWNER: '123456789012',
    AWS_ACCESS_KEY_ID: 'document-id', AWS_SECRET_ACCESS_KEY: 'document-secret' });
  await f.api.putImmutableObject({ key: 'key', body: 'synthetic' });
  await f.api.getImmutableObject({ key: 'key' });
  await f.api.getSignedArchiveDownloadUrl({ key: 'key' });
  assert.equal(f.clients.length, 3);
  for (const c of f.clients) assert.deepEqual(c.credentials, { accessKeyId: 'archive-id', secretAccessKey: 'archive-secret', sessionToken: 'archive-session' });
  for (const c of f.commands) assert.equal(c.ExpectedBucketOwner, '123456789012');
  assert.equal(f.commands[0].ObjectLockMode, 'COMPLIANCE');
});

test('partial dedicated credentials cannot fall back to production credentials', async () => {
  for (const dedicated of [{ COMMUNICATION_ARCHIVE_ACCESS_KEY_ID: 'only-id' }, { COMMUNICATION_ARCHIVE_SECRET_ACCESS_KEY: 'only-secret' }, { COMMUNICATION_ARCHIVE_SESSION_TOKEN: 'only-session' }]) {
    const f = fixture({ ...dedicated, AWS_ACCESS_KEY_ID: 'document-id', AWS_SECRET_ACCESS_KEY: 'document-secret' });
    await assert.rejects(f.api.getImmutableObject({ key: 'key' }), { code: 'ARCHIVE_CREDENTIALS_INCOMPLETE' });
    assert.equal(f.clients.length, 0);
  }
});

test('existing production archive credentials keep working when dedicated keys are absent', async () => {
  const f = fixture({ AWS_ACCESS_KEY_ID: 'existing-id', AWS_SECRET_ACCESS_KEY: 'existing-secret' });
  await f.api.getImmutableObject({ key: 'key' });
  assert.deepEqual(f.clients[0].credentials, { accessKeyId: 'existing-id', secretAccessKey: 'existing-secret' });
  assert.equal(f.commands[0].ExpectedBucketOwner, undefined);
});

test('migration write pause leaves archive reads available', async () => {
  const f = fixture({ COMMUNICATION_ARCHIVE_BUCKET: 'synthetic-archive', COMMUNICATION_ARCHIVE_WRITES_PAUSED: 'true' });
  await assert.rejects(f.api.putImmutableObject({ key: 'key', body: 'synthetic' }), { code: 'ARCHIVE_WRITES_PAUSED' });
  assert.equal(f.commands.length, 0);
  await f.api.getImmutableObject({ key: 'key' });
  assert.equal(f.commands.length, 1);
});
