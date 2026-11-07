"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const fs = require("node:fs");
const { runCodex } = require("../../inference/codex-runner.cjs");

function harness(behavior = "success") {
  let options,
    child,
    calls = [];
  function spawnProcess(_binary, args, opts) {
    options = opts;
    assert.ok(args.includes('cli_auth_credentials_store="ephemeral"'));
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit("exit", 0);
    const send = (event) => child.stdout.write(JSON.stringify(event) + "\n");
    child.stdin = new Writable({
      write(chunk, _encoding, done) {
        for (const line of chunk.toString().trim().split("\n")) {
          const event = JSON.parse(line);
          calls.push(event);
          if (event.id !== undefined && !event.method) {
            if (behavior === 'dynamic' && event.id === 200 && event.result) queueMicrotask(() => {
              send({method:'item/completed',params:{threadId:'thread-synthetic',item:{type:'agentMessage',text:'There are 3 clients.'}}});
              send({method:'turn/completed',params:{threadId:'thread-synthetic',turn:{id:'turn-synthetic',status:'completed',items:[]}}});
            });
            continue;
          }
          if (event.method === "initialize")
            queueMicrotask(() =>
              send({ id: event.id, result: { userAgent: "fixture" } }),
            );
          if (event.method === "account/login/start")
            queueMicrotask(() =>
              send({ id: event.id, result: { type: "apiKey" } }),
            );
          if (event.method === "thread/start")
            queueMicrotask(() =>
              send({
                id: event.id,
                result: { thread: { id: "thread-synthetic" } },
              }),
            );
          if (event.method === "turn/start")
            queueMicrotask(() => {
              send({
                id: event.id,
                result: { turn: { id: "turn-synthetic" } },
              });
              if (behavior === "timeout") return;
              if (["tool", "dynamic"].includes(behavior)) {
                send({
                  id: 200,
                  method: "item/tool/call",
                  params: { threadId: "thread-synthetic", turnId: "turn-synthetic", tool: "firm_count", arguments: {}, callId: "call-1" },
                });
                return;
              }
              send({
                method: "item/completed",
                params: {
                  threadId: "foreign-thread",
                  item: {
                    type: "agentMessage",
                    phase: "final_answer",
                    text: "Not this job",
                  },
                },
              });
              send({
                method: "thread/tokenUsage/updated",
                params: {
                  threadId: "thread-synthetic",
                  tokenUsage: { total: { inputTokens: 18, outputTokens: 7 } },
                },
              });
              send({
                method: "item/completed",
                params: {
                  threadId: "thread-synthetic",
                  item: { type: "agentMessage", text: "Synthetic summary" },
                },
              });
              send({
                method: "turn/completed",
                params: {
                  threadId: "thread-synthetic",
                  turn: {
                    id: "turn-synthetic",
                    status: behavior === "failure" ? "failed" : "completed",
                    items: [],
                  },
                },
              });
            });
        }
        done();
      },
    });
    return child;
  }
  return {
    spawnProcess,
    get options() {
      return options;
    },
    calls,
  };
}
test("Codex text job authenticates, isolates process environment, and returns final text plus usage", async () => {
  const h = harness();
  const result = await runCodex({
    model: "gpt-6-luna",
    prompt: "Synthetic source only",
    spawnProcess: h.spawnProcess,
    env: { PATH: process.env.PATH, OPENAI_API_KEY: "synthetic-api-key" },
  });
  assert.equal(result.text, "Synthetic summary");
  assert.deepEqual(result.usage, { inputTokens: 18, outputTokens: 7 });
  assert.deepEqual(Object.keys(h.options.env).sort(), [
    "LANG",
    "OPENAI_API_KEY",
    "PATH",
  ]);
  const start = h.calls.find((c) => c.method === "thread/start");
  assert.equal(start.params.ephemeral, true);
  assert.equal(start.params.sandbox, "read-only");
  assert.equal(start.params.config.features.shell_tool, false);
  assert.deepEqual(
    h.calls.find((c) => c.method === "account/login/start").params,
    { type: "apiKey", apiKey: "synthetic-api-key" },
  );
  assert.equal(fs.existsSync(h.options.cwd), false);
});
test("Codex workspace token uses environment auth without API-key login or unrelated credentials", async () => {
  const h = harness();
  const result = await runCodex({
    model: "gpt-6-luna",
    prompt: "Synthetic source only",
    spawnProcess: h.spawnProcess,
    env: {
      PATH: process.env.PATH,
      CODEX_ACCESS_TOKEN: "synthetic-codex-token",
      OPENAI_API_KEY: "unused-synthetic-api-key",
      DATABASE_URL: "must-not-be-forwarded",
    },
  });
  assert.equal(result.text, "Synthetic summary");
  assert.deepEqual(h.options.env, {
    PATH: process.env.PATH,
    CODEX_ACCESS_TOKEN: "synthetic-codex-token",
    LANG: "C.UTF-8",
  });
  assert.equal(h.calls.some((c) => c.method === "account/login/start"), false);
  assert.equal(fs.existsSync(h.options.cwd), false);
});
test("Codex job refuses missing credentials before starting a process", async () => {
  const h = harness();
  await assert.rejects(
    runCodex({ prompt: "Synthetic", model: "gpt-6-luna", env: {}, spawnProcess: h.spawnProcess }),
    /Dedicated inference credentials are required/,
  );
  assert.equal(h.options, undefined);
});
test("Platform project and service-account keys in the setup placeholder use API-key authentication", async () => {
  for (const key of ["sk-proj-synthetic-fixture", "sk-svcacct-synthetic-fixture"]) {
    const h = harness();
    const result = await runCodex({
      model: "gpt-6-luna",
      prompt: "Synthetic source only",
      spawnProcess: h.spawnProcess,
      env: { PATH: process.env.PATH, CODEX_ACCESS_TOKEN: key },
    });
    assert.equal(result.text, "Synthetic summary");
    assert.equal(h.options.env.CODEX_ACCESS_TOKEN, undefined);
    assert.equal(h.options.env.OPENAI_API_KEY, key);
    assert.deepEqual(
      h.calls.find((c) => c.method === "account/login/start").params,
      { type: "apiKey", apiKey: key },
    );
    assert.equal(fs.existsSync(h.options.cwd), false);
  }
});
test("Codex text job rejects tool requests, provider failures, and hung processes", async () => {
  for (const behavior of ["tool", "failure", "timeout"]) {
    const h = harness(behavior);
    await assert.rejects(
      runCodex({
        model: "gpt-6-luna",
        prompt: "Synthetic",
        spawnProcess: h.spawnProcess,
        timeoutMs: behavior === "timeout" ? 30 : 1000,
        env: { PATH: process.env.PATH, CODEX_ACCESS_TOKEN: "synthetic-codex-token" },
      }),
    );
    assert.equal(fs.existsSync(h.options.cwd), false);
    if (behavior === "tool")
      assert.ok(h.calls.some((c) => c.id === 200 && c.error));
  }
});


test('App-server tools return results in the active thread and pending writes stop without execution', async () => {
  for (const confirm of [false, true]) {
    const h = harness('dynamic'); let called = 0;
    const result = await runCodex({ model:'gpt-6-luna', prompt:'Count clients',
      tools:[{type:'function',name:'firm_count',description:'Count',inputSchema:{type:'object'}}],
      onTool: async (name, input) => { called++; assert.equal(name,'firm_count'); assert.deepEqual(input,{});
        return confirm ? {pendingTool:{name,input}} : {total_count:3}; },
      spawnProcess:h.spawnProcess, env:{PATH:process.env.PATH,OPENAI_API_KEY:'synthetic'},
    });
    assert.equal(called,1);
    assert.equal(h.calls.find(c=>c.method==='thread/start').params.dynamicTools[0].name,'firm_count');
    if (confirm) assert.equal(result.pendingTool.name,'firm_count');
    else { assert.equal(result.text,'There are 3 clients.'); assert.equal(h.calls.find(c=>c.id===200&&!c.method).result.success,true); }
    assert.equal(fs.existsSync(h.options.cwd),false);
  }
});
