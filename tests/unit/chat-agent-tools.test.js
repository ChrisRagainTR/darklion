'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { createChatAgentTools } = require('../../server/services/chatAgentTools');
const { getToolAccessCatalog } = require('../../server/mcp/tools');

test('staff chat exposes the complete external tool catalog and preserves read/write classification', () => {
  const chat = createChatAgentTools(12, 34);
  assert.deepEqual(chat.definitions.map(t => t.name), getToolAccessCatalog().map(t => t.name));
  for (const tool of getToolAccessCatalog()) {
    assert.equal(chat.isReadOnly(tool.name), tool.annotations.readOnlyHint === true);
  }
  assert.equal(chat.isReadOnly('darklion_send_client_message'), false);
  assert.equal(chat.isReadOnly('unknown'), false);
  assert.throws(() => createChatAgentTools(12, null), /staff identity/);
  assert.throws(() => createChatAgentTools(0, 34), /staff identity/);
});

test('shared chat tools validate inputs, bind firm/staff server-side, and surface API denials', async t => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'synthetic-chat-test-secret';
  t.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });
  const previousStaging = process.env.DARKLION_ISOLATED_STAGING;
  const previousKey = process.env.DARKLION_STAGING_ACCESS_KEY;
  process.env.DARKLION_ISOLATED_STAGING = 'true';
  process.env.DARKLION_STAGING_ACCESS_KEY = 'synthetic-staging-key';
  t.after(() => {
    for (const [name, value] of [['DARKLION_ISOLATED_STAGING', previousStaging], ['DARKLION_STAGING_ACCESS_KEY', previousKey]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  let calls = 0;
  let responseStatus = 200;
  t.mock.method(global, 'fetch', async (url, options) => {
    calls++;
    assert.equal(options.headers['X-DarkLion-Staging-Key'], 'synthetic-staging-key');
    assert.equal(url.pathname, '/api/agent-work/crm/relationships/9');
    const principal = jwt.verify(options.headers.Authorization.slice(7), process.env.JWT_SECRET);
    assert.equal(principal.firm_id, 12);
    assert.equal(principal.staff_user_id, 34);
    assert.equal(principal.aud, 'darklion-agent-work');
    assert.equal(principal.client_id, 'darklion-staff-chat');
    return new Response(JSON.stringify(responseStatus === 200 ? { id: 9 } : { error: 'Forbidden' }), { status: responseStatus });
  });
  const chat = createChatAgentTools(12, 34);
  await assert.rejects(chat.execute('darklion_get_relationship', { relationship_id: -1 }));
  await assert.rejects(chat.execute('not_a_tool', {}), /Unknown agent tool/);
  assert.equal(calls, 0);
  assert.deepEqual(await chat.execute('darklion_get_relationship', { relationship_id: 9, firm_id: 999, staff_user_id: 999 }), { id: 9 });
  responseStatus = 403;
  await assert.rejects(chat.execute('darklion_get_relationship', { relationship_id: 9 }), /Forbidden/);
});

test('chat route runs shared reads and waits for confirmation before shared writes', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../../server/routes/emma-chat'), 'utf8');
  const start = source.indexOf("router.post('/message',");
  const end = source.indexOf('// Helper: build a concise text summary', start);
  let handler, history = [], modelCalls = 0, apiCalls = 0;
  let selectedTool = 'darklion_status';
  const context = {
    router: { post(_path, callback) { handler = callback; } },
    pool: { async query(sql, values) {
      if (sql.startsWith('SELECT')) return { rows: [{ messages: history }] };
      history = JSON.parse(values[3]);
      return { rows: [] };
    } },
    process: { env: {} },
    LUNA_MODEL: 'gpt-6-luna',
    buildSystemPrompt: async () => 'Synthetic',
    runLunaChat: async options => {
      modelCalls++;
      const input = { name: 'Synthetic' };
      if (!options.isReadOnly(selectedTool)) return { pendingTool: { name: selectedTool, input } };
      await options.executeTool(selectedTool, input);
      return { text: 'The read completed.' };
    },
    createChatAgentTools: (firm, staff) => {
      assert.equal(firm, 12); assert.equal(staff, 34);
      return { definitions: [], isReadOnly: name => name === 'darklion_status', async execute(name) { apiCalls++; return { name }; } };
    },
    formatToolResult: () => 'Action completed.',
    console,
  };
  vm.runInNewContext(source.slice(start, end), context);
  const request = async message => {
    let result;
    const res = { status() { return this; }, json(value) { result = value; return value; } };
    await handler({ firm: { id: 12, userId: 34 }, headers: {}, body: { message } }, res);
    return result;
  };
  assert.equal((await request('Check access')).reply, 'The read completed.');
  assert.equal(apiCalls, 1);
  selectedTool = 'darklion_create_relationship'; modelCalls = 0;
  const pending = await request('Create a synthetic relationship');
  assert.equal(pending.has_tool, true);
  assert.match(pending.reply, /Synthetic/);
  assert.equal(apiCalls, 1, 'a proposed write must not execute');
  assert.match((await request('yes')).reply, /Action completed/);
  assert.equal(apiCalls, 2);
  assert.equal(modelCalls, 1, 'confirmation executes the saved action without another model call');
});


test('CRM list results provide exact totals instead of requiring model counting', async t => {
  const prior = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'synthetic-count-test';
  t.after(() => { if (prior === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = prior; });
  t.mock.method(global, 'fetch', async url => new Response(JSON.stringify(
    url.pathname.endsWith('/companies') ? { companies: [{id: 1}, {id: 2}] } : [{id: 1}, {id: 2}, {id: 3}]
  )));
  const chat = createChatAgentTools(1, 1);
  assert.equal((await chat.execute('darklion_list_relationships', {})).total_count, 3);
  assert.equal((await chat.execute('darklion_list_people', {})).total_count, 3);
  assert.equal((await chat.execute('darklion_list_companies', {})).total_count, 2);
});
