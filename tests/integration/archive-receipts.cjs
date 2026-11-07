'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { sha256Hex } = require('../../server/services/communicationArchiveCanonical');

// Real receipt/outbox SQL on CI's disposable PostgreSQL. Only the storage
// boundary is simulated; it must not call a live provider.
async function verifyArchiveReceipts(pool, firmId) {
  const filename = path.resolve(__dirname, '../../server/services/communicationArchive.js');
  const localRequire = createRequire(filename), module = { exports: {} };
  let failStorage = true;
  const objects = [];
  const storage = {
    archiveConfigured: () => true,
    archiveBucket: () => failStorage ? 'unconfigured' : 'synthetic-r2-archive',
    putImmutableObjectWithOptionalLocalFallback: async args => {
      if (failStorage) throw new Error('Synthetic storage outage');
      const checksum = sha256Hex(args.body);
      objects.push(args);
      return { bucket: 'synthetic-r2-archive', key: args.key, versionId: 'r2-sha256-' + checksum,
        checksumSha256: checksum, retainUntilDate: '2033-09-27T00:00:00.000Z', objectLockMode: 'R2_BUCKET_LOCK' };
    },
  };
  vm.compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(
    name => name === '../db' ? { pool } : name === './communicationArchiveStorage' ? storage
      : name === './s3' ? { downloadFile: async () => Buffer.from('synthetic attachment') } : localRequire(name), module, module.exports);
  const input = { firm_id: firmId, source_key: 'synthetic-retry', event_type: 'message.created',
    message: { source_id: 'synthetic-message', body: 'Synthetic only' },
    attachments: [{ attachment_id: 1, storage_key: 'synthetic.txt', storage_bucket: 'synthetic-docs', file_name: 'synthetic.txt' }] };
  await module.exports.captureEvent(input, { allowQueue: true });
  const pending = (await pool.query('SELECT * FROM communication_archive_events WHERE firm_id=$1 AND source_key=$2', [firmId, input.source_key])).rows[0];
  assert.equal(pending.status, 'pending'); assert.equal(pending.object_lock_mode, 'NONE');
  failStorage = false;
  await module.exports.captureEvent(input);
  const saved = (await pool.query('SELECT * FROM communication_archive_events WHERE firm_id=$1 AND source_key=$2', [firmId, input.source_key])).rows[0];
  assert.equal(saved.event_id, pending.event_id); assert.equal(saved.status, 'archived');
  assert.equal(saved.archive_bucket, 'synthetic-r2-archive'); assert.equal(saved.object_lock_mode, 'R2_BUCKET_LOCK');
  const bytes = objects.find(o => o.key === saved.archive_object_key).body;
  assert.deepEqual(saved.payload_json, JSON.parse(bytes));
  assert.equal(saved.content_sha256, saved.payload_json.content_sha256);
  assert.ok(saved.payload_json.attachments[0].archive_version_id.startsWith('r2-sha256-'));
  assert.equal((await pool.query('SELECT status FROM communication_archive_outbox WHERE firm_id=$1 AND source_key=$2', [firmId, input.source_key])).rows[0].status, 'archived');
  const count = objects.length;
  await module.exports.captureEvent(input);
  assert.equal(objects.length, count, 'An archived source must not write another object');
}
module.exports = { verifyArchiveReceipts };
