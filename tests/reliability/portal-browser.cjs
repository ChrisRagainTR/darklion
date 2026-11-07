const { chromium }=require('playwright');
const http=require('http');const fs=require('fs');const assert=require('assert/strict');const path=require('path');
const JWT='eyJhbGciOiJIUzI1NiJ9.eyJ0eXBlIjoicG9ydGFsIn0.c2lnbmF0dXJl';
(async()=>{
 const server=http.createServer((req,res)=>{const urlPath=req.url.split('?')[0];const file=path.join(__dirname,'../../public',urlPath==='/'?'portal.html':decodeURIComponent(urlPath));try{res.end(fs.readFileSync(file));}catch{res.statusCode=404;res.end();}}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({headless:true});
 // Mocked portal API. The web portal is signed in by an HttpOnly cookie, so these mocks answer
 // without any Authorization header; each scenario records what the page sent.
 async function portalPage(opts={}){
  const page=await browser.newPage(opts.viewport?{viewport:opts.viewport}:{});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const s={errors,failDocs:opts.failDocs!==false,sendCount:0,failThread:false,threadCalls:[],authHeaders:[],adopt:[],logout:0,me:opts.me||{}};
  await page.route('**/*',async route=>{
   const u=new URL(route.request().url());const p=u.pathname;
   if(u.hostname!=='127.0.0.1') {if(p.includes('pusher')) return route.fulfill({contentType:'application/javascript',body:'window.Pusher=class { subscribe(){return {bind(){}}} };'});return route.fulfill({body:''});}
   if(p.startsWith('/portal/')||p.startsWith('/portal-auth/')){
    const auth=route.request().headers()['authorization'];if(auth)s.authHeaders.push(p+' '+auth);
    let body=[];let status=200;
    if(p==='/portal-auth/session/adopt'){s.adopt.push(auth||'');status=opts.adoptStatus||200;body=status===200?{ok:true,preview:!!s.me.preview}:{error:'Invalid token'};}
    if(p==='/portal-auth/session/logout'){s.logout++;body={ok:true};}
    if(p==='/portal/me'){if(opts.signedOut){status=401;body={error:'Authentication required'};}else body={firstName:'Test',lastName:'Client',email:'test@example.invalid',filingStatus:'Single',realtimeChannel:'private-portal-1-1',preview:false,...s.me};}
    if(p==='/portal/documents'&&s.failDocs){status=503;body={error:'Unavailable'};}
    if(p==='/portal/messages')body=[{id:1,name:'Test Advisor',unreadCount:0}];
    if(p.includes('/messages/thread/')){s.threadCalls.push(route.request().method()+' '+p+u.search);status=s.failThread?503:200;body=s.failThread?{error:'Unavailable'}:{threadId:1,messages:[]};}
    if(p==='/portal/messages/send'){s.sendCount++;s.failThread=s.sendCount===1;body={threadId:1};}
    if(p==='/portal-auth/firm-info') {await new Promise(r=>setTimeout(r,250));body={firmName:'Test Firm'};}
    if(p==='/portal/investments') body={enabled:false};
    if(p==='/portal/organizer/client/2025') body={profile:{profile_revision:1},items:[],questions:[],organizer:{}};
    if(p==='/portal/account-security') body={mfaEnabled:false,sessions:[],currentSessionId:null};
    if(p==='/portal/account-security/profile') body={email:'test@example.invalid',address:{}};
    return route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
   }
   return route.continue();});
  if(opts.storedToken){await page.goto(base+'/storage-setup');await page.evaluate(t=>localStorage.setItem('portalToken',t),opts.storedToken);}
  return {page,s};
 }
 const stored=page=>page.evaluate(()=>localStorage.getItem('portalToken'));

 // 1. Cookie session: no token in storage, no Authorization header, portal works end to end.
 {
 const {page,s}=await portalPage();
 await page.goto(base+'/');
 await page.waitForFunction(()=>!document.body.classList.contains('portal-auth-pending'));
 await page.waitForSelector('#portal-load-warning');assert.match(await page.locator('#portal-load-warning').innerText(),/documents/);
 await page.waitForTimeout(600);
 // Home renders once even though the overview refreshes several times during load.
 assert.match(await page.locator("#homeGreeting").innerText(), /Test/);
 assert.equal(await page.locator('#homeAttention > .row').count() <= 3, true);
 assert.equal(await page.locator('#tab-overview .home-hero').count(), 1);
 await page.locator('.tab-btn[data-tab="messages"]').click();
 // Opening Messages shows the list only: no conversation is opened, fetched, or marked read until the client picks one.
 await page.waitForSelector('.chat-contact-row');await page.waitForTimeout(300);
 assert.deepEqual(s.threadCalls,[]);assert.equal(await page.locator('#chatInput').isVisible(),false);
 await page.locator('.chat-contact-row').first().click();await page.waitForSelector('#chatInput',{state:'visible'});
 assert.match(s.threadCalls[0],/^GET \/portal\/messages\/thread\/1\?markRead=0$/);
 await page.locator('#chatInput').fill('Local fixture only');
 await page.evaluate(()=>{document.querySelector('#chatInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));});
 // Use the actual exposed handler if Enter is not wired by the client.
 if(!s.sendCount) await page.evaluate(()=>window.sendChatMessage?.());
 await page.waitForFunction(()=>document.getElementById('chat-request-status')?.textContent.includes('Message sent'));
 assert.equal(s.sendCount,1);assert.equal(await page.locator('#chatInput').inputValue(),'');
 // A send whose refresh failed keeps its warning; a clean send's confirmation clears itself.
 await page.waitForTimeout(4500);
 assert.match(await page.locator('#chat-request-status').innerText(),/Message sent\. Could not refresh/);
 await page.locator('#chatInput').fill('Second local fixture');
 await page.locator('#chatInput').press('Enter');
 await page.waitForFunction(()=>document.getElementById('chat-request-status')?.textContent==='Message sent.');
 await page.waitForFunction(()=>document.getElementById('chat-request-status')?.textContent==='',null,{timeout:6000});
 assert.equal(s.sendCount,2);
 assert.deepEqual(s.authHeaders,[],'cookie session sends no Authorization header');
 assert.deepEqual(s.adopt,[]);assert.equal(await stored(page),null);
 assert.equal(await page.locator('#ghost-banner').isVisible(),false);
 // Sign out ends the session on the server (clears the cookie) and goes to sign-in.
 await page.locator('#logoutBtn').click();
 await page.waitForURL(/\/portal-login$/);
 assert.equal(s.logout,1);
 assert.deepEqual(s.errors,[]);
 await page.close();
 }

 // 2. Migration: a session saved in localStorage before the cookie is moved into it and removed.
 {
 const {page,s}=await portalPage({storedToken:JWT});
 await page.goto(base+'/');
 await page.waitForFunction(()=>!document.body.classList.contains('portal-auth-pending'));
 await page.waitForFunction(()=>localStorage.getItem('portalToken')===null);
 assert.deepEqual(s.adopt,['Bearer '+JWT]);
 assert.match(await page.locator('#homeGreeting').innerText(),/Test/);
 // This page load keeps using the handed token (works even if the cookie were dropped); nothing is stored.
 assert.ok(s.authHeaders.some(h=>h.startsWith('/portal/me Bearer '+JWT)));
 await page.reload();await page.waitForFunction(()=>!document.body.classList.contains('portal-auth-pending'));
 assert.equal(s.adopt.length,1,'next load runs on the cookie alone');
 assert.deepEqual(s.errors,[]);
 await page.close();
 }

 // 3. Migration with a token the server no longer accepts: removed, and the visitor is sent to sign in.
 {
 const {page,s}=await portalPage({storedToken:JWT,adoptStatus:401,signedOut:true});
 await page.goto(base+'/');
 await page.waitForURL(/\/portal-login$/);
 assert.equal(await stored(page),null);
 assert.equal(s.adopt.length,1);
 await page.close();
 }

 // 4. No session at all: /portal/me answers 401 and the portal goes to sign in.
 {
 const {page,s}=await portalPage({signedOut:true});
 await page.goto(base+'/');
 await page.waitForURL(/\/portal-login$/);
 assert.deepEqual(s.adopt,[]);
 assert.equal(await page.evaluate(()=>!!sessionStorage.getItem('portalAuthBounce')),true,'sign-in page will not bounce straight back');
 await page.close();
 }

 // 5. Advisor preview link: token adopted, removed from the address bar, banner from /portal/me.
 {
 const {page,s}=await portalPage({me:{preview:true,previewBy:'Pat Advisor'}});
 await page.goto(base+'/?preview_token='+JWT);
 await page.waitForFunction(()=>!document.body.classList.contains('portal-auth-pending'));
 assert.deepEqual(s.adopt,['Bearer '+JWT]);
 assert.equal(new URL(page.url()).search,'');
 await page.waitForSelector('#ghost-banner',{state:'visible'});
 assert.match(await page.locator('#ghost-banner-text').innerText(),/Advisor Preview — viewing portal as Test Client/);
 assert.equal(await stored(page),null);
 assert.deepEqual(s.errors,[]);
 await page.close();
 }

 // 6. Organizer and Account pages run on the cookie too, and render at desktop and phone widths.
 for (const viewport of [{width:1280,height:900},{width:390,height:844}]) {
  {
  const {page,s}=await portalPage({viewport,failDocs:false});
  await page.goto(base+'/organizer.html?year=2025');
  await page.waitForFunction('organizerBootReady===true');
  assert.deepEqual(s.authHeaders,[]);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true,'organizer fits '+viewport.width);
  assert.deepEqual(s.errors,[]);
  await page.close();
  }
  {
  const {page,s}=await portalPage({viewport,failDocs:false});
  await page.goto(base+'/account.html?mode=client');
  await page.waitForFunction(()=>document.getElementById('address-card')&&!document.getElementById('address-card').hidden);
  assert.deepEqual(s.authHeaders,[]);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true,'account fits '+viewport.width);
  assert.deepEqual(s.errors,[]);
  await page.close();
  }
  {
  const {page,s}=await portalPage({viewport,failDocs:false});
  await page.goto(base+'/');
  await page.waitForFunction(()=>!document.body.classList.contains('portal-auth-pending'));
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true,'portal fits '+viewport.width);
  assert.deepEqual(s.errors,[]);
  await page.close();
  }
 }
 // 7. Organizer without a session goes to sign in.
 {
 const {page}=await portalPage({signedOut:true});
 await page.goto(base+'/organizer.html?year=2025');
 await page.waitForURL(/\/client-login$/);
 await page.close();
 }
 console.log('PASS local portal: cookie session (no stored token, no auth header), migration of saved sessions, 401 → sign-in, preview link, sign-out, organizer/account on cookie at 1280px and 390px, partial load visible, message acknowledged despite failed refresh, no runtime errors');
 await browser.close();server.close();
})().catch(e=>{console.error(e);process.exit(1)});
