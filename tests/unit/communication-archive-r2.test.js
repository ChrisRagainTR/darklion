'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createR2Archive, legacyVersionKey } = require('../../server/services/communicationArchiveR2');
const { sha256Hex, stableStringify } = require('../../server/services/communicationArchiveCanonical');
const { copyVersion, inventory } = require('../../scripts/migrate-archive-to-r2');
const env = { COMMUNICATION_ARCHIVE_BUCKET: 'synthetic-archive',
  COMMUNICATION_ARCHIVE_R2_ENDPOINT: 'https://' + 'a'.repeat(32) + '.r2.cloudflarestorage.com',
  COMMUNICATION_ARCHIVE_ACCESS_KEY_ID: 'synthetic-key', COMMUNICATION_ARCHIVE_SECRET_ACCESS_KEY: 'synthetic-secret',
  COMMUNICATION_ARCHIVE_R2_BUCKET_LOCK_ENABLED: 'true' };

test('archive canonicalization preserves database timestamps in nested metadata', () => {
  const event = { source_metadata: { retained_at: new Date('2026-09-27T16:00:00Z'), visible_until: new Date('2026-10-04T16:00:00Z') } };
  assert.deepEqual(JSON.parse(stableStringify(event)), JSON.parse(JSON.stringify(event)));
  assert.equal(stableStringify(event), stableStringify(JSON.parse(JSON.stringify(event))));
});

function fixture() {
  const objects = new Map(), commands = [];
  const client = { async send(command) {
    const { Bucket, Key, Body, Metadata, ContentType } = command.input;
    assert.equal(command.input.VersionId, undefined, 'R2 must never receive an AWS VersionId');
    assert.equal(command.input.ObjectLockMode, undefined);
    assert.equal(command.input.ChecksumAlgorithm, undefined);
    commands.push(command);
    const id = Bucket + '/' + Key, old = objects.get(id);
    if (command.constructor.name === 'PutObjectCommand') {
      if (old) throw Object.assign(new Error('Bucket locked'), { $metadata: { httpStatusCode: 403 } });
      objects.set(id, { Body: Buffer.from(Body), Metadata, ContentType, ETag: 'etag' }); return {};
    }
    if (!old) throw Object.assign(new Error('Missing'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
    return { ...old, Body: Object.assign(Buffer.from(old.Body), { transformToByteArray: async () => old.Body }) };
  } };
  const api = createR2Archive({ env, client, sign: async (_c, cmd) => cmd.input });
  return { objects, client, commands, api };
}

test('R2 archives verify bytes and retain stable versions across retries', async () => {
  const { api, commands } = fixture();
  const args = { key: 'events/firm/1/event.json', body: 'synthetic message' };
  const first = await api.putImmutableObject(args), again = await api.putImmutableObject(args);
  assert.equal(first.versionId, again.versionId); assert.equal(again.alreadyExisted, true);
  assert.equal(first.objectLockMode, 'R2_BUCKET_LOCK'); assert.ok(first.retainUntilDate);
  const read = await api.getImmutableObject({ key: args.key, versionId: first.versionId });
  assert.equal(read.body.toString(), args.body);
  assert.equal(commands.filter(c => c.constructor.name === 'PutObjectCommand').length, 1);
  assert.equal((await api.getSignedArchiveDownloadUrl({ key: args.key, versionId: first.versionId })).Key, args.key);
  await assert.rejects(api.putImmutableObject({ ...args, body: 'different' }), { code: 'ARCHIVE_CHECKSUM_CONFLICT' });
});

test('corruption and mismatched versions fail closed on reads and retries', async () => {
  const { api, objects } = fixture();
  const a = await api.putImmutableObject({ key: 'a', body: 'original' });
  const b = await api.putImmutableObject({ key: 'b', body: 'other' });
  await assert.rejects(api.getImmutableObject({ key: 'b', versionId: a.versionId }), { code: 'ARCHIVE_VERSION_MISMATCH' });
  await assert.rejects(api.getSignedArchiveDownloadUrl({ key: 'a', versionId: b.versionId }), { code: 'ARCHIVE_VERSION_MISMATCH' });
  objects.get(env.COMMUNICATION_ARCHIVE_BUCKET + '/a').Body = Buffer.from('tampered');
  await assert.rejects(api.getImmutableObject({ key: 'a', versionId: a.versionId }), { code: 'ARCHIVE_CHECKSUM_MISMATCH' });
  await assert.rejects(api.putImmutableObject({ key: 'a', body: 'original' }), { code: 'ARCHIVE_CHECKSUM_MISMATCH' });
});

test('R2 refuses missing credentials, unsafe endpoints, missing locks and AWS options', () => {
  for (const override of [
    { COMMUNICATION_ARCHIVE_ACCESS_KEY_ID: '' }, { COMMUNICATION_ARCHIVE_SECRET_ACCESS_KEY: '' },
    { COMMUNICATION_ARCHIVE_R2_ENDPOINT: 'http://example.com' }, { COMMUNICATION_ARCHIVE_R2_ENDPOINT: env.COMMUNICATION_ARCHIVE_R2_ENDPOINT + '/wrong' },
    { COMMUNICATION_ARCHIVE_R2_BUCKET_LOCK_ENABLED: 'false' }, { COMMUNICATION_ARCHIVE_OBJECT_LOCK_ENABLED: 'true' },
    { COMMUNICATION_ARCHIVE_EXPECTED_BUCKET_OWNER: '123456789012' }, { COMMUNICATION_ARCHIVE_SESSION_TOKEN: 'aws-session' },
  ]) assert.throws(() => createR2Archive({ env: { ...env, ...override, AWS_ACCESS_KEY_ID: 'no-fallback', AWS_SECRET_ACCESS_KEY: 'no-fallback' } }));
});

test('S3 migration preserves every version and existing unversioned export links', async () => {
  const f = fixture(), key = 'exports/1/export/manifest.json', data = { 'old+version': 'first', 'new/version': 'second' };
  const source = { send: async command => {
    assert.equal(command.constructor.name, 'GetObjectCommand');
    assert.equal(command.input.Bucket, 'legacy-bucket');
    const body = Buffer.from(data[command.input.VersionId]);
    return { Body: { transformToByteArray: async () => body }, ContentType: 'application/json', Metadata: { content_sha256: sha256Hex(body) } };
  } };
  for (const id of Object.keys(data)) {
    const args = { source, target: f.client, sourceBucket: 'legacy-bucket', targetBucket: env.COMMUNICATION_ARCHIVE_BUCKET,
      version: { Key: key, VersionId: id, IsLatest: id === 'new/version' } };
    await copyVersion(args); await copyVersion(args);
    assert.equal((await f.api.getImmutableObject({ key, versionId: id })).body.toString(), data[id]);
    assert.equal((await f.api.getSignedArchiveDownloadUrl({ key, versionId: id })).Key, legacyVersionKey(key, id));
  }
  assert.equal((await f.api.getImmutableObject({ key })).body.toString(), 'second');
  await assert.rejects(f.api.getImmutableObject({ key, versionId: 'absent' }), { name: 'NoSuchKey' });
  assert.equal(f.objects.size, 3);
});

test('migration never replaces a conflicting destination', async () => {
  const f = fixture(), body = Buffer.from('legacy'), key = 'events/firm/1/example.json';
  await f.api.putImmutableObject({ key, body: 'different existing object' });
  const source = { send: async () => ({ Body: { transformToByteArray: async () => body }, Metadata: {} }) };
  await assert.rejects(copyVersion({ source, target: f.client, sourceBucket: 'legacy', targetBucket: env.COMMUNICATION_ARCHIVE_BUCKET,
    version: { Key: key, VersionId: 'legacy-version', IsLatest: true } }), /MIGRATION_DESTINATION_CONFLICT/);
  assert.equal((await f.api.getImmutableObject({ key })).body.toString(), 'different existing object');
});

test('version inventory paginates and preserves delete markers', async () => {
  let n = 0;
  const data = await inventory({ send: async command => {
    n++;
    if (n === 1) return { IsTruncated: true, NextKeyMarker: 'key', NextVersionIdMarker: 'old', Versions: [{ Key: 'key', VersionId: 'old' }] };
    assert.equal(command.input.KeyMarker, 'key'); assert.equal(command.input.VersionIdMarker, 'old');
    return { IsTruncated: false, DeleteMarkers: [{ Key: 'deleted', VersionId: 'marker', IsLatest: true }] };
  } }, 'bucket');
  assert.equal(n, 2); assert.equal(data.versions.length, 1); assert.equal(data.deleteMarkers.length, 1);
});
