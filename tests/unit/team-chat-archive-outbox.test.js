'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// The archive service is exercised against a recording stand-in for the database.
const queries = [];
let nextRows = [];
const fakePool = {
  async query(sql, params) {
    queries.push({ sql: String(sql), params });
    const rows = nextRows;
    nextRows = [];
    return { rows };
  },
};
const dbPath = path.resolve(__dirname, '../../server/db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool: fakePool } };
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
const archive = require('../../server/services/communicationArchive');

function messageRow() {
  return {
    id: 41,
    conversation_id: 7,
    conversation_type: 'dm',
    title: '',
    sender_staff_user_id: 3,
    body_encrypted: null,
    client_nonce: 'tc-msg-synthetic',
    created_at: new Date('2026-11-09T15:00:00Z'),
    immutable_sha256: 'b'.repeat(64),
    retained_at: new Date('2026-11-09T15:00:00Z'),
    visible_until: null,
    metadata: {},
  };
}

test('a sent message gets a durable archive job on the same database client', async () => {
  const calls = [];
  const client = { async query(sql, params) { calls.push({ sql: String(sql), params }); return { rows: [] }; } };
  const job = await archive.queueTeamChatMessageArchive(client, { firmId: 9, row: messageRow(), attachmentRows: [] });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO communication_archive_outbox/);
  assert.match(calls[0].sql, /'pending',NOW\(\) \+ INTERVAL '2 minutes'/);
  assert.match(calls[0].sql, /ON CONFLICT \(firm_id, source_key\) DO NOTHING/);
  assert.equal(calls[0].params[0], 9);
  assert.ok(job.sourceKey.startsWith('team-chat-send:'));
  assert.equal(calls[0].params[1], job.sourceKey);
  assert.equal(JSON.parse(calls[0].params[3]).event_id, job.event.event_id);
});

test('the retry worker archives claimed jobs and scopes them to their firm', async () => {
  queries.length = 0;
  nextRows = [{ id: 1, firm_id: '9', source_key: 'team-chat-send:abc', payload_json: { event_id: 'e1', firm_id: 9 } }];
  const seen = [];
  const result = await archive.processTeamChatArchiveOutbox({
    capture: async (event, opts) => { seen.push({ event, opts }); return { archived: true }; },
  });
  assert.deepEqual(result, { claimed: 1, archived: 1, failed: 0 });
  assert.match(queries[0].sql, /FOR UPDATE SKIP LOCKED/);
  assert.equal(queries[0].params[0], 'team-chat-send:%');
  assert.equal(seen[0].event.firm_id, 9);
  assert.equal(seen[0].event.source_key, 'team-chat-send:abc');
  assert.equal(seen[0].opts.allowQueue, true);
});

test('a capture that fails or stays queued is counted as failed and never dropped', async () => {
  queries.length = 0;
  nextRows = [
    { id: 1, firm_id: 9, source_key: 'team-chat-send:a', payload_json: JSON.stringify({ event_id: 'e1' }) },
    { id: 2, firm_id: 9, source_key: 'team-chat-send:b', payload_json: { event_id: 'e2' } },
    { id: 3, firm_id: 9, source_key: 'team-chat-send:c', payload_json: { event_id: 'e3' } },
  ];
  let n = 0;
  const result = await archive.processTeamChatArchiveOutbox({
    capture: async () => {
      n += 1;
      if (n === 1) throw new Error('storage unavailable');
      if (n === 2) return { queued: true };
      return { archived: true };
    },
  });
  assert.deepEqual(result, { claimed: 3, archived: 1, failed: 2 });
  assert.equal(queries.filter((q) => /DELETE/i.test(q.sql)).length, 0);
});
