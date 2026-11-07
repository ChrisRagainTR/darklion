'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Readable}=require('stream'),{createHash}=require('crypto');
const {createDocumentStorage,configuration}=require('../../server/services/documentStorage');
const env={AWS_S3_BUCKET:'logical',DOCUMENT_STORAGE_READ_PROVIDER:'r2',DOCUMENT_STORAGE_WRITE_PROVIDER:'r2',
R2_ENDPOINT:'https://example.r2.cloudflarestorage.com',R2_ACCESS_KEY_ID:'test',R2_SECRET_ACCESS_KEY:'test',R2_DOCUMENT_BUCKET:'current',R2_HISTORY_BUCKET:'history'};
function fake(){
const objects=new Map(),calls=[];let failure=null;
return {objects,calls,set fail(fn){failure=fn;},async send(c){
const p=c.input,id=p.Bucket+'/'+p.Key;calls.push({command:c.constructor.name,...p});if(failure)failure(c);
const o=objects.get(id);
if(c.constructor.name==='HeadObjectCommand'||c.constructor.name==='GetObjectCommand'){
if(!o)throw {$metadata:{httpStatusCode:404}};
if(p.IfMatch&&p.IfMatch!==o.ETag)throw {$metadata:{httpStatusCode:412}};
return {...o,Body:Readable.from([o.bytes])};
}
if(c.constructor.name==='PutObjectCommand'){
if(p.IfNoneMatch==='*'&&o||p.IfMatch&&p.IfMatch!==o?.ETag)throw {$metadata:{httpStatusCode:412}};
const bytes=Buffer.from(p.Body);objects.set(id,{...p,bytes,ETag:'"'+createHash('md5').update(bytes).digest('hex')+'"'});return {};
}
if(c.constructor.name==='DeleteObjectCommand'){objects.delete(id);return {};}
throw Error('Unexpected '+c.constructor.name);
}};
}
function setup(){const r2=fake(),aws=fake();return {r2,aws,api:createDocumentStorage({env,clients:{r2,aws},sign:async(c,cmd)=>'signed:'+cmd.input.Bucket+'/'+cmd.input.Key})};}
test('AWS defaults preserve existing contract',async()=>{const aws=fake(),api=createDocumentStorage({env:{},clients:{aws}});assert.equal(api.config.read,'aws');await api.uploadFile({bucket:'legacy',key:'k',buffer:Buffer.from('a')});assert.equal((await api.downloadFile({bucket:'legacy',key:'k'})).toString(),'a');await api.deleteFile({bucket:'legacy',key:'k'});assert.equal(aws.objects.size,0);});
test('invalid and mixed configuration fails closed',()=>{assert.throws(()=>configuration({...env,DOCUMENT_STORAGE_READ_PROVIDER:'typo'}));assert.throws(()=>configuration({...env,DOCUMENT_STORAGE_WRITE_PROVIDER:'aws'}));assert.throws(()=>configuration({...env,R2_ENDPOINT:'http://example.r2.cloudflarestorage.com'}));});
test('writes paused blocks upload delete restore',async()=>{const api=createDocumentStorage({env:{...env,DOCUMENT_STORAGE_WRITES_PAUSED:'true'}});for(const fn of ['uploadFile','deleteFile','restoreVersion'])await assert.rejects(api[fn]({}),{code:'DOCUMENT_WRITES_PAUSED'});});
test('R2 lifecycle preserves versions, tombstones and restores',async()=>{
const {api,r2,aws}=setup(),args={bucket:'logical',key:'1/person/2/a.pdf'};
const v1=await api.uploadFile({...args,buffer:Buffer.from('first'),mimeType:'application/pdf'});
await api.uploadFile({...args,buffer:Buffer.from('second'),mimeType:'application/pdf'});
assert.equal((await api.downloadFile(args)).toString(),'second');
assert.match(await api.getSignedDownloadUrl(args),/^signed:current/);
await api.deleteFile(args);await assert.rejects(api.downloadFile(args),{code:'DOCUMENT_NOT_FOUND'});await assert.rejects(api.getSignedDownloadUrl(args),{code:'DOCUMENT_NOT_FOUND'});
await api.restoreVersion({...args,versionId:v1.versionId});assert.equal((await api.downloadFile(args)).toString(),'first');
assert.equal(aws.calls.length,0);assert.equal(r2.calls.filter(c=>c.command==='DeleteObjectCommand').length,0);
assert.ok([...r2.objects.keys()].some(k=>k.endsWith('/previous')));
});
test('history failure prevents current mutation',async()=>{
const {api,r2}=setup();r2.fail=c=>{if(c.input.Bucket==='history')throw Error('history unavailable');};
await assert.rejects(api.uploadFile({bucket:'logical',key:'k',buffer:Buffer.from('new')}));assert.equal(r2.objects.has('current/k'),false);
});
test('concurrent update cannot be overwritten or deleted',async()=>{
for(const action of ['upload','delete']){
const {api,r2}=setup(),args={bucket:'logical',key:'k'};await api.uploadFile({...args,buffer:Buffer.from('old')});
let injected=false;r2.fail=c=>{if(!injected&&c.constructor.name==='PutObjectCommand'&&c.input.Bucket==='current'){injected=true;r2.objects.set('current/k',{bytes:Buffer.from('concurrent'),ETag:'different',Metadata:{}});}};
await assert.rejects(action==='upload'?api.uploadFile({...args,buffer:Buffer.from('loser')}):api.deleteFile(args));
assert.equal(r2.objects.get('current/k').bytes.toString(),'concurrent');
}});
test('receipt failure keeps durable commit pointer',async()=>{
const {api,r2}=setup();r2.fail=c=>{if(c.input.Key.endsWith('/committed.json'))throw Error('receipt unavailable');};
const result=await api.uploadFile({bucket:'logical',key:'k',buffer:Buffer.from('ok')});assert.equal(result.receiptPending,true);assert.equal(r2.objects.get('current/k').Metadata['dl-history'],result.historyPrefix);
});
test('unmapped bucket and cross-key restore fail',async()=>{
const {api}=setup();await assert.rejects(api.downloadFile({bucket:'other',key:'k'}),{code:'UNMAPPED_DOCUMENT_BUCKET'});
const v=await api.uploadFile({bucket:'logical',key:'1/k',buffer:Buffer.from('a')});
await assert.rejects(api.restoreVersion({bucket:'logical',key:'2/k',versionId:v.versionId}));
});
test('missing receipt can be repaired idempotently',async()=>{
const {api,r2}=setup(),args={bucket:'logical',key:'k'};
r2.fail=c=>{if(c.input.Key.endsWith('/committed.json'))throw Error('receipt unavailable');};
await api.uploadFile({...args,buffer:Buffer.from('repair')});r2.fail=null;
assert.equal((await api.repairHistoryReceipt(args)).repaired,true);
assert.equal((await api.repairHistoryReceipt(args)).alreadyCommitted,true);
});
test('pilot routes marked keys to R2 and ordinary documents to AWS', async()=>{
 const aws=fake(),r2=fake();
 const pilotEnv={...env,DOCUMENT_STORAGE_READ_PROVIDER:'aws',DOCUMENT_STORAGE_WRITE_PROVIDER:'aws',DOCUMENT_STORAGE_R2_PILOT:'true'};
 const api=createDocumentStorage({env:pilotEnv,clients:{aws,r2},sign:async(c,cmd)=>cmd.input.Bucket});
 const ordinary={bucket:'logical',key:'1/person/2/file.pdf'},pilot={bucket:'logical',key:'1/person/2/__r2_pilot__/file.pdf'};
 await api.uploadFile({...ordinary,buffer:Buffer.from('aws')});
 const version=await api.uploadFile({...pilot,buffer:Buffer.from('r2')});
 assert.equal((await api.downloadFile(ordinary)).toString(),'aws');
 assert.equal((await api.downloadFile(pilot)).toString(),'r2');
 assert.equal(await api.getSignedDownloadUrl(pilot),'current');
 await api.deleteFile(pilot);await assert.rejects(api.downloadFile(pilot),{code:'DOCUMENT_NOT_FOUND'});
 await api.restoreVersion({...pilot,versionId:version.versionId});
 assert.equal((await api.downloadFile(pilot)).toString(),'r2');
 assert.equal(aws.objects.size,1);
 const disabled=createDocumentStorage({env:{AWS_S3_BUCKET:'logical'},clients:{aws}});
 await assert.rejects(disabled.downloadFile(pilot),{code:'R2_PILOT_DISABLED'});
});
