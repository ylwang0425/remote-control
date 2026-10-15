'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Client, Journal, RemoteError, loadConfig, candidates, prepare, collect, dispatch, ask, parseArgs } = require('../ai-remote-dispatch/scripts/remote-ai.cjs');

const A = '0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70';
const B = '1f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70';
const token = 'X'.repeat(43);
const cfg = { origin: 'https://example.test', clientId: A, token };
const computer = (id = A, overrides = {}) => ({ clientId: id, ownerName: 'Person-'+id[0], clientName: 'PC-'+id[0], online: true,
  capabilities: { 'models.list': true, 'session.create': true, 'session.read': true }, tools: [{id:'dsh',available:true},{id:'workbuddy',available:true}], ...overrides });
const task = { taskId: A, requestId: B, computerId: A, tool: 'dsh', model: 'model', sessionId: 'chat' };
const receipt = { sessionId: 'new-chat', tool: 'dsh', model: 'model' };
const catalog = tool => ({ tool, models: [{ id: 'model', isDefault: true, ...(tool === 'dsh' ? { provider: 'provider' } : {}) }], projects: [{id:'native-project',name:'Project',cwd:'D:\\project'}] });
const read = (overrides={}) => ({ id:'chat',tool:'dsh',status:'idle',canStop:false,messages:[{role:'assistant',text:'verified answer'}],...overrides });
const memoryJournal = () => ({ saves: [], save(t) { this.saves.push(structuredClone(t)); } });

function responseTransport(status, value, inspect = () => {}) {
  return (url, options, callback) => {
    const req = new EventEmitter();
    req.destroy = err => { if (err) queueMicrotask(() => req.emit('error', err)); };
    req.end = raw => {
      inspect(url, options, JSON.parse(raw));
      queueMicrotask(() => {
        const res = new EventEmitter(); res.statusCode = status; res.resume = () => {};
        callback(res);
        if (status < 300 || status >= 400) { res.emit('data', Buffer.from(JSON.stringify(value))); res.emit('end'); }
      });
    };
    return req;
  };
}

test('registration binds HTTPS server and own credential; rejects unsafe URL forms', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-config-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file = path.join(dir,'config.json');
  const write = relayUrl => fs.writeFileSync(file, JSON.stringify({relayUrl,clientId:A,bridgeToken:token}));
  write('wss://example.test/bridge'); assert.deepEqual(loadConfig(file),cfg);
  for (const value of ['http://example.test','ws://example.test/bridge','wss://user:pass@example.test/bridge','wss://example.test/bridge?q=1','wss://example.test/bridge#fragment','https://example.test/other']) {
    write(value); assert.throws(()=>loadConfig(file),RemoteError);
  }
});

test('HTTPS transport pins origin, uses own bearer, verifies TLS and exact target', async () => {
  let seen = 0;
  const client = new Client(cfg,responseTransport(200,{ok:true,result:{accepted:true}},(url,opts,body)=>{
    seen++; assert.equal(url.href,'https://example.test/api/fleet/rpc'); assert.equal(opts.rejectUnauthorized,true);
    assert.equal(opts.headers.Authorization,'Bearer '+token); assert.equal(opts.headers.Origin,cfg.origin);
    assert.equal(body.clientId,B); assert.equal(body.method,'session.stop');
  }));
  await client.rpc(B,'session.stop',{tool:'dsh',sessionId:'chat'}); assert.equal(seen,1);
  assert.throws(()=>client.rpc('some-name','session.stop',{}),RemoteError);
  assert.throws(()=>client.rpc(B,'shell.run',{}),RemoteError);
});

test('redirect refusal never makes a second request', async () => {
  let count=0;
  const client = new Client(cfg,responseTransport(302,null,()=>count++));
  await assert.rejects(client.inventory(),e=>e.code==='redirect_refused'); assert.equal(count,1);
});

test('HTTP 200 native failure remains failure; ambiguous native errors stay uncertain', async () => {
  const client = new Client(cfg,responseTransport(200,{ok:false,error:{code:'bridge_error',message:'native failed'}}));
  await assert.rejects(client.rpc(A,'session.create',{}),e=>e.code==='bridge_error'&&e.uncertain);
  const rejected = new Client(cfg,responseTransport(403,{ok:false,error:{code:'forbidden',message:'disabled'}}));
  await assert.rejects(rejected.inventory(),e=>e.code==='forbidden'&&!e.uncertain);
});

test('candidates honor offline computers and explicit per-tool false capabilities', () => {
  const inv = {computers:[computer(A,{online:false}), computer(B,{capabilities:{'models.list':true,'session.create':true,'session.read':true,'session.create:workbuddy':false}})]};
  assert.deepEqual(candidates(inv,{tool:'auto'}).map(c=>[c.computer.clientId,c.tool]),[[B,'dsh']]);
  assert.throws(()=>candidates(inv,{owner:'absent'}),e=>e.code==='no_target');
  assert.throws(()=>candidates({computers:[computer(),computer(B,{clientName:'PC-0'})]},{computer:'PC-0'}),e=>e.code==='ambiguous_target');
  const nativeId='01a13d97-11bd-7370-9ae4-c61ca9dbf89c';
  assert.equal(candidates({computers:[computer(nativeId)]},{tool:'dsh'})[0].computer.clientId,nativeId);
});

test('prepare uses live model/provider/project; refuses ambiguity before creation', async () => {
  const client = {rpc:async(c,m,p)=>{assert.equal(c,A);assert.equal(m,'models.list');return catalog(p.tool);}};
  const p = await prepare(client,{computer:computer(),tool:'dsh'},{project:'Project'});
  assert.deepEqual(p.params,{tool:'dsh',model:'model',provider:'provider',projectId:'native-project'});
  await assert.rejects(prepare(client,{computer:computer(),tool:'dsh'},{model:'invented'}),e=>e.code==='no_model');
  await assert.rejects(prepare(client,{computer:computer(),tool:'dsh'},{project:'D:\\unlisted'}),e=>e.code==='invalid_project');
  await assert.rejects(prepare({rpc:async()=>({tool:'dsh',models:[{id:'m',provider:'one'},{id:'m',provider:'two'}]})},{computer:computer(),tool:'dsh'},{model:'m'}),e=>e.code==='ambiguous_model');
});

test('completed requires actual idle assistant reply; working/unknown/partial not success', async () => {
  assert.equal((await collect({rpc:async()=>read()},task,0)).status,'completed');
  for (const update of [{status:'working'},{status:'unknown'},{messages:[]},{activeTurnId:'turn'},{canStop:true}]) {
    assert.notEqual((await collect({rpc:async()=>read(update)},task,0)).status,'completed');
  }
  assert.equal((await collect({rpc:async()=>read()},{...task,partial:true},0)).status,'creation-partial');
  assert.equal((await collect({rpc:async()=>read({status:'error'})},task,0)).status,'failed');
});

test('native pending questions and permissions returned without automatic answer/approval', async () => {
  for (const pending of [{pendingQuestions:[{callId:'q',questions:[]}]},{pendingApprovals:[{id:'approval',toolName:'Bash'}]}]) {
    const methods=[]; const result=await collect({rpc:async(c,m)=>{methods.push(m);return read(pending);}},task,0);
    assert.equal(result.status,'needs-input'); assert.deepEqual(methods,['session.read']);
  }
});

test('collect polls original session and never sends again', async () => {
  let clock=0, calls=0;
  const result=await collect({rpc:async(c,m,p)=>{assert.equal(m,'session.read');assert.equal(p.sessionId,'chat');return read({status:++calls===1?'working':'idle'});}},task,10,{now:()=>clock,pause:async ms=>{clock+=ms;}});
  assert.equal(result.status,'completed'); assert.equal(calls,2);
});

test('dispatch journals BEFORE mutation, keeps request ID, and never retries uncertain creation', async () => {
  const journal=memoryJournal(), methods=[];
  const client={rpc:async(c,m,p)=>{assert.equal(journal.saves.length,1);assert.equal(journal.saves[0].requestId,p.requestId);methods.push(m);throw new RemoteError('bridge_timeout','timeout',true);}};
  const result=await dispatch(client,journal,{computer:computer(),tool:'dsh',params:{model:'model',provider:'p'}},'SECRET_QUESTION',0);
  assert.equal(result.status,'creation-unknown'); assert.deepEqual(methods,['session.create']);
  assert.ok(!JSON.stringify(journal.saves).includes('SECRET_QUESTION')); assert.ok(!JSON.stringify(journal.saves).includes(token));
  const unresolved=await collect(client,journal.saves.at(-1),0);assert.equal(unresolved.status,'creation-unknown');assert.equal(methods.length,1);
});

test('partial creation preserves real session; malformed receipt never invents completion', async () => {
  const journal=memoryJournal();
  const result=await dispatch({rpc:async(c,m)=>m==='session.create'?{...receipt,partial:true}:read({id:'new-chat'})},journal,{computer:computer(),tool:'dsh',params:{model:'model'}},'question',0);
  assert.equal(result.status,'creation-partial');assert.equal(result.sessionId,'new-chat');
  const bad=await dispatch({rpc:async()=>({tool:'workbuddy',sessionId:'wrong'})},memoryJournal(),{computer:computer(),tool:'dsh',params:{model:'model'}},'question',0);
  assert.equal(bad.status,'creation-unknown');assert.equal(bad.sessionId,undefined);
});

test('automatic dispatch can skip read-only preparation errors but never retries an attempted write elsewhere', async () => {
  const writes=[];
  const client={inventory:async()=>({computers:[computer(),computer(B)]}),rpc:async(c,m,p)=>{
    if(m==='models.list') return catalog(p.tool);
    writes.push([c,m]);throw new RemoteError('bridge_timeout','timeout',true);
  }};
  const result=await ask(client,memoryJournal(),{tool:'auto',wait:0},'question');
  assert.equal(result.results[0].status,'creation-unknown');assert.deepEqual(writes,[[A,'session.create']]);
});

test('fan-out serializes tool writers on each computer; different computers may run concurrently', async () => {
  const active=new Set(), sessions=new Map(); let max=0;
  const client={inventory:async()=>({computers:[computer(),computer(B)]}),rpc:async(c,m,p)=>{
    if(m==='models.list')return catalog(p.tool);
    if(m==='session.create'){
      assert.ok(!active.has(c),'same computer has overlapping writers');active.add(c);max=Math.max(max,active.size);
      await new Promise(r=>setTimeout(r,15)); const sid=c+'-'+p.tool;sessions.set(sid,{c,tool:p.tool});return{sessionId:sid,tool:p.tool,model:'model'};
    }
    const record=sessions.get(p.sessionId);active.delete(c);return read({id:p.sessionId,tool:record.tool});
  }};
  const result=await ask(client,memoryJournal(),{tool:'auto',wait:0,all:true},'question');
  assert.equal(result.results.length,4);assert.equal(result.notStarted,0);assert.equal(max,2);
});

test('pending task prevents next native writer on same computer', async () => {
  let writes=0;
  const client={inventory:async()=>({computers:[computer()]}),rpc:async(c,m,p)=>m==='models.list'?catalog(p.tool):m==='session.create'?(writes++,receipt):read({id:'new-chat',status:'working'})};
  const result=await ask(client,memoryJournal(),{tool:'auto',wait:0,all:true},'question');
  assert.equal(writes,1);assert.equal(result.notStarted,1);assert.equal(result.results[0].status,'pending');
});

test('journal resumption is bound to server and registered identity; task IDs cannot traverse', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-journal-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const journal=new Journal(cfg,dir);journal.save(task);assert.equal(journal.load(A).sessionId,'chat');
  assert.throws(()=>journal.load('../other'),e=>e.code==='local_storage');
  assert.throws(()=>new Journal({...cfg,clientId:B},dir).load(A),e=>e.code==='local_storage');
  assert.throws(()=>new Journal({...cfg,origin:'https://other.test'},dir).load(A),e=>e.code==='local_storage');
  assert.ok(!fs.readFileSync(path.join(dir,A+'.json'),'utf8').includes(token));
});

test('bounded wait and argument validation',()=>{
  assert.equal(parseArgs(['ask','--all','--wait-seconds','0']).options.all,true);
  for (const argv of [['ask','--wait-seconds','-1'],['ask','--wait-seconds','601'],['rpc','--unknown','x']])assert.throws(()=>parseArgs(argv),RemoteError);
});
