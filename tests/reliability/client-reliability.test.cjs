const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const portal = fs.readFileSync(path.join(root, 'public/portal.html'), 'utf8');
const mobile = fs.readFileSync(path.join(root, 'mobile/src/screens/MessagesScreen.tsx'), 'utf8');
function functions(source, names) {
 const tree = ts.createSourceFile('source.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
 const found = [];
 function visit(node) { if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) found.push(node.getText(tree)); ts.forEachChild(node, visit); }
 visit(tree); assert.equal(found.length, names.length); return ts.transpileModule(found.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
function context(extra = {}) { return vm.createContext({ console, AbortController, Response, FormData, setTimeout, clearTimeout, ...extra }); }
function deferred() { let resolve, reject; const promise = new Promise((a,b) => {resolve=a; reject=b;}); return { promise, resolve, reject }; }
const scripts = [...portal.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
const portalScript = scripts.find(s=>s.includes('async function loadMessages'));
test('all portal inline scripts parse', () => { scripts.forEach(source => new vm.Script(source)); });

test('signing requests accept a large drawn signature, and that parser runs before the default 100 KB one', () => {
  const index = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
  const signParser = index.indexOf("tax-deliveries\\/\\d+\\/sign$/, express.json({ limit: '2mb' })");
  const defaultParser = index.indexOf('app.use(express.json());');
  assert.ok(signParser > 0 && signParser < defaultParser);
});

test('portal asset versions match file contents, so a changed file never reuses a cached address', () => {
  const crypto = require('node:crypto');
  for (const f of ['portal-experience.css', 'js/portal-tax.js', 'js/portal-docs.js']) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'public', f))).digest('hex').slice(0, 10);
    assert.ok(portal.includes('/' + f + '?v=' + hash), f + ' must be referenced as ?v=' + hash);
  }
});

test('mobile read deduplication is scoped to credentials, failures release requests, writes are never retried', async () => {
 let calls = 0; const pending = deferred();
 const source = fs.readFileSync(path.join(root, 'mobile/src/api/client.ts'),'utf8').replace(/import Constants[^\n]*\n/, 'const Constants = { expoConfig: {} };\n');
 const ctx = context({ exports:{}, process:{env:{}}, fetch:async ()=>{calls++;return pending.promise;} });
 vm.runInContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText, ctx);
 const a = ctx.exports.apiFetch('/items',{},'client-a'); const b = ctx.exports.apiFetch('/items',{},'client-a');
 const c = ctx.exports.apiFetch('/items',{},'client-b'); assert.equal(calls,2);
 pending.resolve({ok:true,json:async()=>({items:[1]})}); await Promise.all([a,b,c]);
 ctx.fetch = async()=>{calls++;throw new Error('offline');};
 await assert.rejects(ctx.exports.apiFetch('/send',{method:'POST'},'client-a'),/offline/); assert.equal(calls,3);
 await assert.rejects(ctx.exports.apiFetch('/send',{method:'POST'},'client-a'),/offline/); assert.equal(calls,4);
});

test('mobile requests time out and report an unconfirmed write without retrying', async () => {
 const source = fs.readFileSync(path.join(root,'mobile/src/api/client.ts'),'utf8').replace(/import Constants[^\n]*\n/, 'const Constants = { expoConfig: {} };\n');
 const ctx=context({exports:{},process:{env:{}},setTimeout: fn=>setTimeout(fn,2),fetch:(_url,options)=>new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted'))))});
 vm.runInContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,ctx);
 await assert.rejects(ctx.exports.apiFetch('/read'), /connection took too long/);
 await assert.rejects(ctx.exports.apiFetch('/send',{method:'POST'}), /Confirmation was interrupted/);
});

function mobileContext(extra={}) {
 return context({selectedContact:{id:1}, selectedIdRef:{current:'1'}, threadRequest:{current:0}, contactsRequest:{current:0}, sendLock:{current:false}, token:'test', options:{}, lastThreadMessageKeyRef:{current:null},shouldFollowThreadRef:{current:false},forceScrollAfterSend:{current:false},pendingThreadScrollRef:{current:false}, latestPortalMessageKey:rows=>String(rows.at(-1)?.id||''),setContacts:()=>{},setError:()=>{},setRefreshing:()=>{},setLoadingThread:()=>{},setMessages:()=>{},requestThreadBottomScroll:()=>{},setShowJumpToLatest:()=>{}, ...extra});
}
test('late mobile thread response cannot replace the selected conversation',async()=>{
 const a=deferred(), b=deferred(); let rendered;
 const ctx=mobileContext({apiFetch:url=>url.endsWith('/1')?a.promise:b.promise,setMessages:rows=>rendered=rows});
 vm.runInContext(functions(mobile,['refreshSelectedThread']),ctx);
 const old=ctx.refreshSelectedThread({id:1});ctx.selectedIdRef.current='2';const current=ctx.refreshSelectedThread({id:2});
 b.resolve({messages:[{id:'b'}]});await current;a.resolve({messages:[{id:'a'}]});await old;assert.equal(rendered[0].id,'b');
});
test('mobile acknowledges a send even when refresh fails; failed sends retain text',async()=>{
 let body='hello', notice='', error='', sends=0;
 const ctx=mobileContext({body,selectedFiles:[],FormData, setSending:()=>{},setDeliveryNotice:v=>notice=v,setBody:v=>body=v,setSelectedFiles:()=>{},setError:v=>error=v,apiFetch:async url=>{if(url.endsWith('/send')){sends++;return {};}throw Error('offline');}});
 vm.runInContext(functions(mobile,['refreshSelectedThread','sendMessage']),ctx);
 await ctx.sendMessage();assert.equal(sends,1);assert.equal(body,'');assert.equal(notice,'Message sent.');assert.match(error,/refresh/);
 body='keep me';ctx.body=body;ctx.apiFetch=async()=>{throw Error('offline');};await ctx.sendMessage();assert.equal(body,'keep me');
});

test('portal reads can be shared without consuming each other response bodies',async()=>{
 let calls=0;const pending=deferred();const ctx=context({window:{fetch:async()=>{calls++;return pending.promise;}}});
 vm.runInContext('const portalPendingReads = new Map();\n'+functions(portalScript,['fetch']),ctx);
 const a=ctx.fetch('/same');const b=ctx.fetch('/same');pending.resolve(new Response('{"ok":true}'));const responses=await Promise.all([a,b]);
 assert.equal(calls,1);assert.equal((await responses[0].json()).ok,true);assert.equal((await responses[1].json()).ok,true);
});
test('portal conversation switching ignores stale responses and failed reads are not empty conversations',async()=>{
 const a=deferred(),b=deferred();let rendered, status='';const empty={style:{},append(){},removeAttribute(){}};const urls=[];
 const ctx=context({_selectedStaffId:1,_loadingMessages:null,_messageLoadVersion:0,_chatAllMessages:[],_sendingChat:false,portalHeaders:()=>({}),fetch:url=>{urls.push(url);return url.includes('/thread/1?')?a.promise:b.promise;},renderChatMessages:()=>{rendered=ctx._chatAllMessages;},syncContactFromThread:()=>{},markThreadSeen:()=>{},loadStaffList:()=>{},chatStatus:v=>status=v,document:{getElementById:()=>empty,createElement:()=>({})}});
 vm.runInContext(functions(portalScript,['loadMessages']),ctx);
 const old=ctx.loadMessages();ctx._selectedStaffId=2;const current=ctx.loadMessages();b.resolve(new Response('{"messages":[{"id":"b"}]}'));await current;a.resolve(new Response('{"messages":[{"id":"a"}]}'));await old;assert.equal(rendered[0].id,'b');
 // Fetching a thread never marks it read; that happens only once it is on screen.
 assert.ok(urls.every(url=>url.endsWith('?markRead=0')));
 ctx.fetch=async()=>{throw Error('offline');};await ctx.loadMessages();assert.match(status,/Could not refresh/);assert.equal(rendered[0].id,'b');
});

function loadMobileClient(extra) {
 const source = fs.readFileSync(path.join(root,'mobile/src/api/client.ts'),'utf8').replace(/import Constants[^\n]*\n/, 'const Constants = { expoConfig: {} };\n');
 const ctx = context({ exports:{}, process:{env:{}}, FormData, TypeError, ...extra });
 vm.runInContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText, ctx);
 return ctx;
}

test('mobile uploads are never cut off by the request time limit', async () => {
 let aborted = false;
 const ctx = loadMobileClient({ setTimeout: fn => setTimeout(fn, 2), fetch: (_url, options) => new Promise(resolve => {
   options.signal.addEventListener('abort', () => { aborted = true; });
   setTimeout(() => resolve({ ok: true, json: async () => ({ threadId: 1 }) }), 30);
 }) });
 const result = await ctx.exports.apiFetch('/portal/messages/send', { method: 'POST', body: new FormData() }, 'client');
 assert.equal(aborted, false); assert.equal(result.threadId, 1);
});

test('wrong password keeps the server message; an expired saved session signs out once', async () => {
 const expired = [];
 const ctx = loadMobileClient({ fetch: async () => ({ ok: false, status: 401, json: async () => ({ error: 'Invalid email or password' }) }) });
 ctx.exports.setUnauthorizedHandler(token => expired.push(token));
 await assert.rejects(ctx.exports.apiFetch('/portal-auth/login', { method: 'POST', body: '{}' }), /Invalid email or password/);
 assert.deepEqual(expired, []);
  await assert.rejects(ctx.exports.apiFetch('/portal/documents', {}, 'saved-token'), /session has expired/i);
 assert.deepEqual(expired, ['saved-token']);
});

test('server error pages and dropped connections produce readable messages', async () => {
 const page = loadMobileClient({ fetch: async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('JSON Parse error: Unexpected character: <'); } }) });
 await assert.rejects(page.exports.apiFetch('/portal/documents', {}, 'client'), /temporarily unavailable/);
 const offline = loadMobileClient({ fetch: async () => { throw new TypeError('Network request failed'); } });
 await assert.rejects(offline.exports.apiFetch('/portal/documents', {}, 'client'), /Could not reach your workspace/);
});

test('hidden screens refresh once when shown again, never on first display or while hidden', () => {
 const source = fs.readFileSync(path.join(root,'mobile/src/hooks/useRefreshOnReturn.ts'),'utf8').replace(/import[^\n]*\n/, '');
 const refs = []; let index = 0; const effects = [];
 const ctx = context({ exports:{},
  useRef: value => { if (refs.length <= index) refs.push({ current: value }); return refs[index++]; },
  useEffect: (fn, deps) => effects.push({ fn, deps }) });
 vm.runInContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText, ctx);
 let refreshes = 0; let previous;
 const render = active => {
  index = 0; effects.length = 0;
  ctx.exports.useRefreshOnReturn(active, () => refreshes++);
  const effect = effects[0];
  if (!previous || previous[0] !== effect.deps[0]) effect.fn();
  previous = effect.deps;
 };
 render(true); assert.equal(refreshes, 0);
 render(false); render(false); assert.equal(refreshes, 0);
 render(true); assert.equal(refreshes, 1);
 render(true); assert.equal(refreshes, 1);
});

test('portal uploads are never cut off by the request time limit', async () => {
 let aborted = false;
 const ctx = context({ FormData, setTimeout: fn => setTimeout(fn, 2), window: { fetch: (_url, options) => new Promise(resolve => {
   options.signal.addEventListener('abort', () => { aborted = true; });
   setTimeout(() => resolve(new Response('{"ok":true}')), 30);
 }) } });
 vm.runInContext('const portalPendingReads = new Map();\n'+functions(portalScript,['fetch']),ctx);
 const response = await ctx.fetch('/portal/documents/upload', { method: 'POST', body: new FormData() });
 assert.equal(aborted, false); assert.equal((await response.json()).ok, true);
});
