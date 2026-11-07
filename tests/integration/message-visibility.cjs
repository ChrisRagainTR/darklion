'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const express = require('express');

// Use the actual route SQL against the disposable bootstrap database. Provider
// adapters and authentication are outside this fixture; no external service runs.
function routeHandler(name, routePath, pool) {
  const filename = path.resolve(__dirname, '../../server/routes', name + '.js');
  const localRequire = createRequire(filename), module = { exports: {} };
  const factories = ['createAgentWorkCrmRouter', 'createAgentWorkDocumentsRouter', 'createAgentWorkPipelinesRouter',
    'createAgentWorkStaffRouter', 'createAgentWorkMyWorkRouter', 'createAgentWorkCommunicationsRouter', 'createAgentWorkBusinessRouter'];
  const emptyRouters = Object.fromEntries(factories.map(name => [name, () => express.Router()]));
  const load = name => {
    if (name === '../db') return { pool };
    if (['../services/firmPreferences', '../services/staffInboxVisibility'].includes(name)) return localRequire(name);
    if (name === '../services/agentConnections') return { auditAgentEvent: async () => {} };
    if (name.startsWith('./agent-work-')) return emptyRouters;
    if (name.startsWith('.')) return {};
    return localRequire(name);
  };
  vm.compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(load, module, module.exports);
  const route = module.exports.stack.find(layer => layer.route?.path === routePath && layer.route.methods.get);
  assert.ok(route, name + routePath);
  return route.route.stack.at(-1).handle;
}

async function verifyMessageVisibility(pool, firmId) {
  const user = (await pool.query('SELECT id FROM firm_users WHERE firm_id=$1 ORDER BY id LIMIT 1', [firmId])).rows[0];
  const person = (await pool.query("INSERT INTO people (firm_id,first_name,last_name,email) VALUES ($1,'Synthetic','Messages','visibility@example.invalid') RETURNING id", [firmId])).rows[0];
  const thread = (await pool.query("INSERT INTO message_threads (firm_id,person_id,staff_user_id,subject,category) VALUES ($1,$2,$3,'Synthetic visibility','internal') RETURNING id", [firmId, person.id, user.id])).rows[0];
  await pool.query(`INSERT INTO messages (thread_id,sender_type,sender_id,body,created_at)
    VALUES ($1,'staff',$2,'Visible original',NOW()-INTERVAL '1 minute')`, [thread.id, user.id]);
  for (const sender of ['staff', 'client']) {
    await pool.query(`INSERT INTO messages (thread_id,sender_type,sender_id,body,removed_at,message_type)
      VALUES ($1,$2,$3,'Hidden archive failure',NOW(),'task')`, [thread.id, sender, sender === 'staff' ? user.id : person.id]);
  }
  const app = express();
  app.use((req, _res, next) => {
    req.firm = { id: firmId, userId: user.id }; req.portal = { firmId, personId: person.id };
    req.agentFirmId = firmId; req.agentStaffUserId = user.id; req.agentConnection = { id: null };
    next();
  });
  for (const [url, file, routePath] of [
    ['/staff', 'messages', '/'], ['/all', 'messages', '/all'], ['/counts', 'messages', '/unread-count'],
    ['/client', 'portal', '/messages'], ['/agent', 'agent-work', '/inbox/threads'], ['/agent-summary', 'agent-work', '/inbox/summary'],
    ['/agent-thread/:threadId', 'agent-work', '/inbox/threads/:threadId'],
  ]) app.get(url, routeHandler(file, routePath, pool));
  app.get('/foreign-agent-thread/:threadId', (req, res, next) => {
    req.agentFirmId = -1;
    next();
  }, routeHandler('agent-work', '/inbox/threads/:threadId', pool));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    async function get(p) { const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`); assert.equal(r.status, 200, p); return r.json(); }
    for (const url of ['/staff', '/all']) {
      const row = (await get(url)).find(row => row.id === thread.id);
      assert.equal(row.lastPreview, 'Visible original'); assert.equal(row.unreadCount, 0);
      if (url === '/staff') assert.equal(row.hasTaskMessages, false);
    }
    const client = (await get('/client')).find(row => row.id === user.id);
    assert.equal(client.lastPreview, 'Visible original'); assert.equal(client.unreadCount, 1);
    assert.deepEqual(await get('/client?search=Hidden'), []);
    assert.equal((await get('/client?search=Visible')).length, 1);
    const counts = await get('/counts'); assert.equal(counts.unread_count, 0); assert.equal(counts.task_count, 0);
    const agent = (await get('/agent')).threads.find(row => row.id === thread.id);
    assert.equal(agent.lastPreview, 'Visible original'); assert.equal(agent.unreadCount, 0);
    assert.equal((await get('/agent?unread=true')).threads.length, 0);
    assert.equal((await get('/agent-summary')).summary.unread_messages, 0);

    // Exercise the real PostgreSQL bind parameters, sender names, and read-only
    // detail behavior. Mocked pools do not detect unused parameter positions.
    await pool.query(`INSERT INTO messages (thread_id,sender_type,sender_id,body)
      VALUES ($1,'client',$2,'Visible client reply')`, [thread.id, person.id]);
    const beforeRead = (await pool.query('SELECT id, read_at FROM messages WHERE thread_id=$1 ORDER BY id', [thread.id])).rows;
    const detail = await get('/agent-thread/' + thread.id);
    assert.equal(detail.thread.id, thread.id);
    assert.deepEqual(detail.messages.map(message => message.body), ['Visible original', 'Visible client reply']);
    assert.equal(detail.messages[1].senderName, 'Synthetic Messages');
    assert.ok(detail.messages[0].senderName);
    assert.deepEqual(detail.pendingDrafts, []);
    assert.deepEqual((await pool.query('SELECT id, read_at FROM messages WHERE thread_id=$1 ORDER BY id', [thread.id])).rows, beforeRead);
    const foreign = await fetch(`http://127.0.0.1:${server.address().port}/foreign-agent-thread/${thread.id}`);
    assert.equal(foreign.status, 404);
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}

module.exports = { verifyMessageVisibility };
