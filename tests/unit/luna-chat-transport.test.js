'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const vm = require('node:vm');
const { chat, toolResult } = require('../../inference/chat-transport.cjs');

test('Luna HTTP stream roundtrips shared reads and stops for a write without running it', async t => {
  let selected = 'read_record', executions = 0, reserved = 0;
  const server = http.createServer(async (req,res) => {
    if(req.url.startsWith('/chat/tool/')) return toolResult(req,res);
    await chat(req,res,'gpt-6-luna',async options => {
      assert.equal(options.model,'gpt-6-luna');
      assert.equal(options.tools[0].name,'read_record');
      const result = await options.onTool(selected,{id:12});
      if(result.pendingTool) return {pendingTool:result.pendingTool,usage:{inputTokens:1}};
      assert.deepEqual(result,{total_count:3});
      return {text:'3 clients',usage:{inputTokens:1,outputTokens:2}};
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const context={require:()=>({completeText:async options=>{reserved++;assert.equal(options.providerOverride,'codex');assert.equal(options.firmId,7);return options.run();}}),
    process:{env:{DARKLION_INFERENCE_URL:`http://127.0.0.1:${server.address().port}`,DARKLION_INFERENCE_TOKEN:'synthetic'}},
    module:{exports:{}},URL,fetch,AbortController,setTimeout,clearTimeout,TextDecoder};
  vm.runInNewContext(fs.readFileSync(require.resolve('../../server/services/lunaChat'),'utf8'),context);
  const request={firmId:7,instructions:'Synthetic',messages:[{role:'user',content:'Count'}],
    tools:['read_record','write_record'].map(name=>({name,description:name,input_schema:{type:'object'}})),
    isReadOnly:name=>name==='read_record',executeTool:async()=>{executions++;return {total_count:3};}};
  const result=await context.module.exports.runLunaChat(request);
  assert.equal(result.text,'3 clients');assert.equal(result.provider,'codex-app-server');assert.equal(executions,1);
  selected='write_record';
  const pending=await context.module.exports.runLunaChat(request);
  assert.equal(pending.pendingTool.name,'write_record');assert.equal(executions,1);assert.equal(reserved,2);
});
