import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const dir=mkdtempSync(path.join(tmpdir(),'syncord-time-machine-'));
test.after(()=>rmSync(dir,{recursive:true,force:true}));
await build({stdin:{resolveDir:process.cwd(),contents:`export * from './src/renderer/plugins/timeMachine/model';export {parseSnapshotRect} from './src/shared/snapshot';export {timeMachineCatalog} from './src/renderer/i18n/timeMachine';export {SUPPORTED_LOCALES} from './src/shared/i18nLocale';`},
  outfile:path.join(dir,'model.mjs'),bundle:true,format:'esm',platform:'node',logLevel:'silent'});
// Same persistence fixtures as memory-log: the real log module over an in-memory db.
await build({stdin:{resolveDir:process.cwd(),contents:`export * from './src/renderer/plugins/messageLogger/log';`},outfile:path.join(dir,'log.mjs'),bundle:true,format:'esm',platform:'node',logLevel:'silent',plugins:[{name:'fixture',setup(b){
  b.onResolve({filter:/^\.\/(db|files)$/},a=>a.importer.endsWith('/messageLogger/log.ts')?{path:a.path,namespace:'fixture'}:undefined);
  b.onResolve({filter:/ui\/toast$/},()=>({path:'toast',namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path==='./db'?`export const visitLogRows=async()=>{};export const writeLogRows=async()=>{};export const clearLogRows=async()=>{};export const writeLogChanges=async()=>{};`:a.path==='./files'?`export const forgetMessageFiles=()=>{},queueMessageFiles=()=>{},wipeSavedFiles=async()=>{};`:`export const showToast=()=>{};`}));
}}]});
const M=await import(pathToFileURL(path.join(dir,'model.mjs')).href);

const row={id:'1',authorId:'a',content:'final',deleted:500,
  edits:[{at:200,content:'first'},{at:300,content:'second'}],
  activity:[{at:250,kind:'react',emoji:'👍',userId:'b'},{at:400,kind:'pin'}]};

test('time machine: timeline orders every logged event by time',()=>{
  const events=M.buildTimeline([row]);
  assert.deepEqual(events.map(e=>e.kind),['edit','react','edit','pin','delete']);
  assert.equal(events[1].actor,'b');assert.equal(events[1].emoji,'👍');
  assert.equal(events[0].actor,'a');
});

test('time machine: each position rewinds exactly the events from it onward',()=>{
  const events=M.buildTimeline([row]);
  const at=p=>{const cut=M.cutAt(events,p);return [M.contentAt(row,cut),M.deletedBefore(row,cut)];};
  assert.deepEqual(at(0),['first',false]);
  assert.deepEqual(at(2),['second',false]);
  assert.deepEqual(at(3),['final',false]);
  assert.deepEqual(at(4),['final',false]);
  assert.deepEqual(at(5),['final',true],'the present keeps the deletion');
  assert.equal(M.cutAt(events,events.length),Infinity);
});

test('time machine: snowflake creation time and helpers',()=>{
  assert.equal(M.createdAt('175928847299117063'),1462015105796);
  assert.ok(Number.isNaN(M.createdAt('nonce-1')));
  assert.equal(M.createdAt(M.snowflakeAt(1462015105796)),1462015105796,'a moment survives the round trip');
  assert.deepEqual(M.density([],4),[0,0,0,0]);
  const d=M.density(M.buildTimeline([row]),2);assert.equal(Math.max(...d),1);assert.equal(d.length,2);
  assert.ok(M.stepDelay(16)<M.stepDelay(1));
});

test('time machine: snapshot area is validated before it reaches main',()=>{
  assert.deepEqual(M.parseSnapshotRect({x:1.4,y:2,width:300.6,height:400}),{x:1,y:2,width:301,height:400});
  for(const bad of [null,{},{x:-1,y:0,width:1,height:1},{x:0,y:0,width:0,height:1},{x:0,y:0,width:9000,height:1},{x:0,y:0,width:'1',height:1},{x:NaN,y:0,width:1,height:1}])
    assert.throws(()=>M.parseSnapshotRect(bad),/Invalid snapshot area/);
});

test('time machine: every locale has a complete catalog',()=>{
  for(const locale of M.SUPPORTED_LOCALES){const c=M.timeMachineCatalog(locale);assert.ok(c['tm.evReact'].includes('{emoji}'),locale);assert.ok(c['tm.deletedAt'].includes('{time}'),locale);}
});

test('message logger: reactions and pins are kept with edits and survive deletion',async()=>{
  globalThis.window=globalThis;globalThis.localStorage={removeItem(){},getItem(){return null;}};
  const log=await import(pathToFileURL(path.join(dir,'log.mjs')).href);
  log.setLogLimit(0);log.loadLog();await log.whenLogReady();
  const changed=[];const off=log.onLogChange(id=>changed.push(id));
  const message={id:'42',channel_id:'c',content:'hi',author:{id:'a',username:'A'}};
  log.rememberActivity(message,{at:1,kind:'react',emoji:'🔥',userId:'b'});
  log.rememberEdit(message,'hello');
  log.rememberActivity(message,{at:3,kind:'pin'});
  log.rememberDelete({...message,content:'hello'});
  const [saved]=log.channelLog('c');
  assert.equal(saved.content,'hello');assert.equal(saved.edits.length,1);assert.ok(saved.deleted);
  assert.deepEqual(saved.activity.map(a=>a.kind),['react','pin']);
  assert.deepEqual(changed,['c','c','c','c']);
  for(let i=0;i<40;i++)log.rememberActivity(message,{at:10+i,kind:'react',emoji:'x'});
  assert.equal(log.channelLog('c')[0].activity.length,24,'activity is capped per message');
  off();log.rememberActivity(message,{at:99,kind:'unpin'});assert.equal(changed.length,44);
});
