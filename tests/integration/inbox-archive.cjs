'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { staffInboxPredicate } = require('../../server/services/staffInboxVisibility');
async function verifyInboxArchive(pool) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(`
      CREATE TEMP TABLE message_threads(id int, firm_id int, staff_user_id int, person_id int, status text, staff_archived_at timestamptz, subject text, category text, last_message_at timestamptz, created_at timestamptz) ON COMMIT DROP;
      CREATE TEMP TABLE thread_participants(id int, thread_id int, firm_user_id int, archived_at timestamptz) ON COMMIT DROP;
      CREATE TEMP TABLE people(id int, first_name text, last_name text, email text, phone text, relationship_id int) ON COMMIT DROP;
      CREATE TEMP TABLE firm_users(id int, name text, display_name text, email text) ON COMMIT DROP;
      CREATE TEMP TABLE relationships(id int, name text) ON COMMIT DROP;
      CREATE TEMP TABLE messages(id int, thread_id int, sender_type text, sender_id int, body text, is_internal boolean, message_type text, created_at timestamptz, removed_at timestamptz, read_at timestamptz) ON COMMIT DROP;
      CREATE TEMP TABLE message_drafts(id int, firm_id int, thread_id int, status text, draft_body text, confidence numeric, agent_notes text, created_at timestamptz, agent_connection_id int) ON COMMIT DROP;
      CREATE TEMP TABLE agent_connections(id int, agent_name text) ON COMMIT DROP;
      INSERT INTO people VALUES(1,'Synthetic','Client','test@example.invalid',NULL,NULL);
      INSERT INTO firm_users VALUES(10,'Owner',NULL,NULL),(20,'Other',NULL,NULL);
      INSERT INTO message_threads(id,firm_id,staff_user_id,person_id,status,staff_archived_at) VALUES
        (1,1,10,1,'open',NULL),(2,1,10,1,'open',NOW()),
        (3,1,20,1,'open',NOW()),(4,1,20,1,'open',NULL),
        (5,1,10,1,'archived',NULL),(6,2,10,1,'open',NULL),(7,1,20,1,'open',NULL);
      INSERT INTO thread_participants VALUES(1,2,10,NULL),(2,3,10,NULL),(3,4,10,NOW());
      INSERT INTO messages(id,thread_id,sender_type,body) SELECT id,id,'client','Synthetic' FROM message_threads;
      INSERT INTO message_drafts(id,firm_id,thread_id,status) SELECT id,firm_id,id,'pending' FROM message_threads;
    `);
    const source = fs.readFileSync(require.resolve('../../server/routes/agent-work'), 'utf8');
    const routes = new Map();
    vm.runInNewContext(source.slice(source.indexOf("router.get('/inbox/summary'"), source.indexOf("router.post('/inbox/threads/:threadId/draft'")), {
      router: { get(path, ...handlers) { routes.set(path, handlers.at(-1)); } }, pool: db,
      staffInboxPredicate, requireCapability: () => {}, audit: async () => {},
      safeLimit: value => Number(value) || 25, intId: Number, console,
    });
    async function call(path, query = {}, params = {}) {
      let payload, status = 200;
      await routes.get(path)({ agentFirmId: 1, agentStaffUserId: 10, query, params }, {
        status(code) { status = code; return this; }, json(value) { payload = value; },
      });
      assert.equal(status, 200); return payload;
    }
    const summary = (await call('/inbox/summary')).summary;
    assert.deepEqual(summary, { open_threads: 2, unread_messages: 2, pending_drafts: 2 });
    const listed = await call('/inbox/threads');
    assert.deepEqual(Array.from(listed.threads, t => t.id).sort(), [1,3]);
    assert.ok(listed.threads.every(t => t.isArchived === false));
    const archived = await call('/inbox/threads', { view: 'archived' });
    assert.deepEqual(Array.from(archived.threads, t => t.id).sort(), [2,4,5]);
    assert.ok(archived.threads.every(t => t.isArchived === true));
    const detail = await call('/inbox/threads/:threadId', {}, { threadId: 2 });
    assert.equal(detail.thread.status, 'open'); assert.equal(detail.thread.isArchived, true); assert.ok(detail.thread.archivedAt);
    await db.query('UPDATE message_threads SET staff_archived_at=NULL WHERE id=2');
    assert.equal((await call('/inbox/summary')).summary.open_threads,3);
    const unread = await call('/inbox/threads',{unread:'true'});
    assert.deepEqual(Array.from(unread.threads,t=>t.id).sort(),[1,2,3]);
  } finally { await db.query('ROLLBACK'); db.release(); }
}
module.exports = { verifyInboxArchive };
