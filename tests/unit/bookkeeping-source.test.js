'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const express = require('express');
const source = fs.readFileSync(path.join(__dirname,'../../server/routes/bookkeeping-source.js'),'utf8');

test('bookkeeping source saves only valid providers for the authenticated firm and survives subsequent requests', async () => {
  const state={ provider:'ledgerhq' }, calls=[];
  const context={module:{exports:{}},require:name=>name==='express'?express:{pool:{query:async(sql,args)=>{
    calls.push({sql,args});
    if(args[0]!=='29' || args[1]!==1)return {rows:[]};
    state.provider=args[2];return {rows:[{bookkeeping_provider:state.provider}]};
  }}}};
  vm.runInNewContext(source,context);
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.firm={id:1};next();});app.use(context.module.exports);
  const server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const put=(id,provider)=>fetch(`${base}/${id}/bookkeeping-source`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider})});
  try {
    for(const provider of ['qbo','ledgerhq']){
      const res=await put(29,provider);assert.equal(res.status,200);assert.equal((await res.json()).provider,provider);assert.equal(state.provider,provider);
    }
    const before=calls.length;assert.equal((await put(29,'other')).status,400);assert.equal(calls.length,before);
    assert.equal((await put(999,'qbo')).status,404);assert.equal(state.provider,'ledgerhq');
    assert.match(calls[0].sql,/firm_id = \$2/);assert.equal(calls[0].args[1],1);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
