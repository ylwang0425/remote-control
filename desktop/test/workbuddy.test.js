'use strict';
// Isolated native-format fixtures. Never writes to the installed WorkBuddy DB.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {WorkBuddyAdapter,nativeWorkspaceKey,MAX_HISTORY_BYTES}=require('../src/adapters/workbuddy');
const {createDispatcher}=require('../src/index');
const SID='11111111-2222-4333-8444-555555555555';
const AT='2026-10-11T05:00:00Z';
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ai-remote-workbuddy-'));
  const cwd=path.join(root,'workspace');fs.mkdirSync(cwd);
  const filename=path.join(root,'workbuddy.db');
  const db=new DatabaseSync(filename);
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY,cwd TEXT,title TEXT,custom_title TEXT,created_at TEXT,updated_at TEXT,last_activity_at TEXT,deleted_at TEXT,transport TEXT)');
  const add=(id=SID,transport='local',deleted=null)=>db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?)').run(id,cwd,'WorkBuddy local fixture',null,AT,AT,AT,deleted,transport);
  const folder=path.join(root,'projects',nativeWorkspaceKey(cwd));fs.mkdirSync(folder,{recursive:true});
  const transcript=path.join(folder,SID+'.jsonl');
  let adapter;
  t.after(()=>{try{adapter?.close();}catch{}try{db.close();}catch{}
    const resolved=path.resolve(root),temp=path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved),temp);assert.ok(path.basename(resolved).startsWith('ai-remote-workbuddy-'));
    fs.rmSync(resolved,{recursive:true,force:true});
  });
  return{root,cwd,db,add,transcript,open:()=>adapter=WorkBuddyAdapter.open({configDir:root})};
}
function message(id,role,content,extra={}){return{id,type:'message',role,content,timestamp:AT,...extra};}
function write(file,records,terminated=true){fs.writeFileSync(file,records.map(r=>JSON.stringify(r)).join('\n')+(terminated?'\n':''),'utf8');}
test('real-format history projects Markdown and distinct tool records without database writes',t=>{
  const f=fixture(t);f.add();
  write(f.transcript,[message('u1','user','查看项目'),message('a1','assistant','## 结果\n\n**Markdown**\n```js\nconsole.log(1)\n```'),
    {id:'c1',type:'function_call',callId:'call-1',name:'read_file',arguments:{path:'config.json'},timestamp:AT},
    {id:'r1',type:'function_call_result',callId:'call-1',output:'读取完成',timestamp:AT},
    {id:'hidden',type:'reasoning',content:'internal',timestamp:AT},
    message('internal','user','hidden',{providerData:{isCompactInternal:true}})]);
  const before=fs.readFileSync(path.join(f.root,'workbuddy.db'));
  const adapter=f.open();assert.equal(adapter.listSessions().length,1);
  const result=adapter.readSession(SID);
  assert.equal(result.messages.length,4);assert.match(result.messages[1].text,/\*\*Markdown\*\*/);
  assert.equal(result.messages[2].role,'tool');assert.notEqual(result.messages[2].id,result.messages[3].id);
  assert.equal(result.status,'unknown');assert.equal(result.canStop,false);
  assert.equal(result.pendingQuestions,undefined);assert.equal(result.pendingApprovals,undefined);
  assert.throws(()=>adapter.db.exec("UPDATE sessions SET title='changed'"),/readonly|read-only/i);
  assert.deepEqual(fs.readFileSync(path.join(f.root,'workbuddy.db')),before);
});
test('listing excludes remote and deleted rows, and an empty genuine schema stays empty',t=>{
  const f=fixture(t);const adapter=f.open();assert.deepEqual(adapter.listSessions(),[]);
  f.add();f.add('remote-session','remote');f.add('deleted-session','local',AT);
  assert.deepEqual(adapter.listSessions().map(x=>x.id),[SID]);
  assert.throws(()=>adapter.readSession('remote-session'),e=>e.code==='session_not_found');
  assert.throws(()=>adapter.readSession('../escape'),e=>e.code==='invalid_params');
  assert.throws(()=>adapter.readSession(SID),e=>e.code==='session_gone');
});
test('edited-history forks select the latest native parent chain instead of mixing old replies',t=>{
  const f=fixture(t);f.add();
  write(f.transcript,[message('root','user','root'),message('old','user','old question',{parentId:'root'}),
    message('old-reply','assistant','old reply',{parentId:'old'}),
    message('new','user','edited question',{parentId:'root'}),message('new-reply','assistant','new reply',{parentId:'new'})]);
  assert.deepEqual(f.open().readSession(SID).messages.map(x=>x.text),['root','edited question','new reply']);
});
test('a complete unterminated JSONL record is read; an incomplete append is marked truncated',t=>{
  const f=fixture(t);f.add();write(f.transcript,[message('a1','assistant','中文内容')],false);
  const a=f.open();assert.equal(a.readSession(SID).messages.length,1);
  fs.appendFileSync(f.transcript,'\n{"type":"message","content":"中文');
  const result=a.readSession(SID);assert.equal(result.messages.length,1);assert.equal(result.historyTruncated,true);
});
test('native input_text/output_text blocks render actual user and assistant text',t=>{
  const f=fixture(t);f.add();
  write(f.transcript,[message('request-1','user',[{type:'input_text',text:'用户消息'}]),
    message('request-1','assistant',[{type:'output_text',text:'**助手回复**',providerData:{annotations:[]}}])]);
  const result=f.open().readSession(SID);
  assert.deepEqual(result.messages.map(x=>x.text),['用户消息','**助手回复**']);
  assert.notEqual(result.messages[0].id,result.messages[1].id);
});

test('native user display removes injected context before budgeting and keeps assistant text literal',t=>{
  const f=fixture(t);f.add();
  const context='<system-reminder data-role="environment">'+'internal context '.repeat(5000)+'</system-reminder>\n';
  const assistant='```xml\n<system-reminder>literal example</system-reminder>\n```';
  write(f.transcript,[message('context-only','user',context),
    message('greeting','user',[{type:'input_text',text:context+'<user_query>**你好**</user_query>'}]),
    message('response','assistant',[{type:'output_text',text:assistant}])]);
  const result=f.open().readSession(SID);
  assert.deepEqual(result.messages.map(x=>x.text),['**你好**',assistant]);
  assert.equal(result.historyTruncated,false);
});

test('oversized visible text reports truncation and preserves Unicode character boundaries',t=>{
  const f=fixture(t);f.add();
  write(f.transcript,[message('large','assistant','🙂'.repeat(66000))]);
  const result=f.open().readSession(SID);
  assert.equal(result.historyTruncated,true);
  assert.equal([...result.messages[0].text].length,65536);
  assert.ok(result.messages[0].text.endsWith('🙂…'));
  assert.equal(result.messages[0]._textTruncated,undefined);
});
test('bounded UTF-8 tail skips a partially cut oversized record and retains recent messages',t=>{
  const f=fixture(t);f.add();
  write(f.transcript,[message('old','user','中'.repeat(Math.ceil(MAX_HISTORY_BYTES/3)+100)),message('u1','user','最近的问题'),message('a1','assistant','最近的回答')]);
  const result=f.open().readSession(SID);
  assert.deepEqual(result.messages.map(x=>x.text),['最近的问题','最近的回答']);assert.equal(result.historyTruncated,true);
});
test('history bounds and redaction do not turn compact/null metadata into pending decisions',t=>{
  const f=fixture(t);f.add();
  const rows=Array.from({length:205},(_,i)=>message('m'+i,'assistant','row '+i,{providerData:{parentSessionId:null,compactType:null}}));
  rows.push(message('last','assistant','Authorization: Bearer sample-credential-value'));
  write(f.transcript,rows);const result=f.open().readSession(SID);
  assert.equal(result.messages.length,200);assert.equal(result.historyTruncated,true);
  assert.ok(!result.messages.at(-1).text.includes('sample-credential-value'));
});
test('dispatcher lists and reads WorkBuddy while refusing all writes before any other tool opens',async t=>{
  let dispatcher;
  t.after(()=>dispatcher?.close());
  const f=fixture(t);f.add();write(f.transcript,[message('u1','user','hello'),message('a1','assistant','world')]);
  let otherOpens=0;
  dispatcher=createDispatcher({workbuddy:{configDir:f.root},codex:{},dsh:{},createLogPath:path.join(f.root,'creates.json')},()=>{},
    {codex:async()=>{otherOpens++;throw new Error('fixture');},dsh:async()=>{otherOpens++;throw new Error('fixture');}});
  for(const method of ['session.send','session.stop','session.answer','session.approve','models.list','session.create']){
    await assert.rejects(dispatcher.dispatch({method,params:{tool:'workbuddy',sessionId:SID}}),e=>e.code==='not_capable');
  }
  assert.equal(otherOpens,0);
  const listed=await dispatcher.dispatch({method:'sessions.list',params:{tool:'workbuddy'}});
  assert.equal(listed.sessions.length,1);assert.deepEqual(listed.capabilities.tools,['workbuddy']);
  assert.equal(listed.capabilities['session.send'],false);assert.equal(listed.capabilities['session.send:workbuddy'],false);
  assert.equal(listed.capabilities['models.list:workbuddy'],false);assert.equal(listed.capabilities['session.create:workbuddy'],false);
  const read=await dispatcher.dispatch({method:'session.read',params:{tool:'workbuddy',sessionId:SID}});
  assert.deepEqual(read.messages.map(x=>x.text),['hello','world']);
  assert.equal(dispatcher.describe().workbuddy.readOnly,true);
});
