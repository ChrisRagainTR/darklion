'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const template = fs.readFileSync(path.join(__dirname, '../../server/views/team-chat.ejs'), 'utf8');
const source = [...template.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(script => script.includes('async function refreshMessages'));
const tree = ts.createSourceFile('team-chat.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
let refreshSource;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'refreshMessages') refreshSource = node.getText(tree);
  ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(refreshSource);

function fixture(activeChat) {
  const requests = [], rendered = [];
  const ctx = vm.createContext({
    activeChat, activeFetchSeq: 3, lastRenderedSignature: '',
    chatKey: chat => String(chat?.id || ''),
    isActiveToken: (seq, key) => seq === 3 && key === String(activeChat.id),
    apiJson: async url => { requests.push(url); return { messages: [{ id: 1, body: 'Existing message' }] }; },
    renderMessages: messages => rendered.push(messages),
    combinedMessages: messages => messages, messageSignature: JSON.stringify,
    setComposerState() {}, setStatus() {}, setLiveState() {},
  });
  vm.runInContext(refreshSource, ctx);
  return { ctx, requests, rendered };
}

test('opening or refreshing a teammate without a DM shows an empty composer without an invalid history request', async () => {
  const f = fixture({ id: 'staff-21', synthetic_dm: true });
  await f.ctx.refreshMessages(true, false);
  assert.equal(f.requests.length, 0);
  assert.equal(f.rendered.length, 1);
  assert.equal(f.rendered[0].length, 0);
});

test('a stale placeholder refresh cannot clear the current conversation', async () => {
  const f = fixture({ id: '7' });
  await f.ctx.refreshMessages(true, false, { chat: { id: 'staff-21', synthetic_dm: true }, seq: 2 });
  assert.equal(f.requests.length, 0);
  assert.equal(f.rendered.length, 0);
});

test('an existing conversation still loads and renders its stored history', async () => {
  const f = fixture({ id: '7' });
  await f.ctx.refreshMessages(false, false);
  assert.equal(f.requests.length, 1);
  assert.match(f.requests[0], /conversation_id=7&/);
  assert.equal(f.rendered[0][0].body, 'Existing message');
});
