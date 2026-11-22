import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(path.join(tmpdir(),'syncord-memory-log-'));let sequence=0;
await build({stdin:{resolveDir:process.cwd(),contents:`export * from './src/renderer/plugins/messageLogger/log';`},outfile:path.join(dir,'log.mjs'),bundle:true,format:'esm',platform:'node',logLevel:'silent',plugins:[{name:'persistence-failure-fixture',setup(b){
 b.onResolve({filter:/^\.\/(db|files)$/},a=>a.importer.endsWith('/messageLogger/log.ts')?{path:a.path,namespace:'fixture'}:undefined);
 b.onResolve({filter:/ui\/toast$/},()=>({path:'toast',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path==='./db'?`export const visitLogRows=async visit=>{for(const row of globalThis.state.seed??[])if(visit(row)===false)break;};export const writeLogRows=async()=>{throw Error('Unexpected full snapshot write');};export const clearLogRows=async()=>{globalThis.state.rows.clear();};export const writeLogChanges=async values=>{const state=globalThis.state;state.calls++;state.sizes.push(values.length);if(state.gate)await state.gate;if(state.fail){state.fail=false;throw Error('Disk full');}for(const[id,row]of values)row===undefined?state.rows.delete(id):state.rows.set(id,structuredClone(row));};`:a.path==='./files'?`export const forgetMessageFiles=()=>{},queueMessageFiles=()=>{},wipeSavedFiles=async()=>{};`:`export const showToast=()=>{};`}));
 }}]});test.after(()=>rmSync(dir,{recursive:true,force:true}));
const delay=()=>new Promise(r=>setTimeout(r,5));const until=async(fn)=>{for(let i=0;i<200;i++){if(fn())return;await delay();}assert.fail('Persistence did not settle');};
async function fresh(){globalThis.window=globalThis;globalThis.localStorage={removeItem(){},getItem(){return null;}};globalThis.state={rows:new Map(),calls:0,sizes:[],fail:false};const m=await import(pathToFileURL(path.join(dir,'log.mjs')).href+'?case='+sequence++);m.setLogLimit(0);m.loadLog();await m.whenLogReady();return m;}
const message=(id,content='body')=>({id,channel_id:'channel',content,author:{id:'person',username:'Test'}});
test('log incremental storage: bursts persist every record in batches of at most 128 without snapshot writes',async()=>{
 const m=await fresh();for(let i=0;i<1024;i++)m.rememberDelete(message(String(i)));await until(()=>state.rows.size===1024);assert.equal(m.logCount(),1024);assert.ok(state.sizes.every(n=>n<=128));assert.equal(state.calls,8);
});
test('log incremental storage: a failed batch is retried with the latest edit instead of overwriting it',async()=>{
 const m=await fresh();state.fail=true;m.rememberDelete(message('retry'));await until(()=>state.calls===1);await delay();assert.equal(state.rows.size,0);m.rememberEdit(message('retry'),'new content');await until(()=>state.rows.get('retry')?.content==='new content');assert.equal(state.rows.get('retry').edits[0].content,'body');
});
test('log incremental storage: Clear during a pending write cannot resurrect old records or lose new ones',async()=>{
 const m=await fresh();let release;state.gate=new Promise(r=>{release=r;});m.rememberDelete(message('old'));await until(()=>state.calls===1);m.clearLog();m.rememberDelete(message('new'));state.gate=undefined;release();await until(()=>state.rows.has('new')&&!state.rows.has('old'));assert.equal(m.logCount(),1);
});

test('log streaming hydrate: Clear during loading stops old records and keeps subsequent events',async()=>{
 globalThis.window=globalThis;globalThis.localStorage={removeItem(){},getItem(){return null;}};globalThis.state={rows:new Map(),calls:0,sizes:[],fail:false};
 const m=await import(pathToFileURL(path.join(dir,'log.mjs')).href+'?case='+sequence++);m.setLogLimit(0);
 const first={id:'old-first',channelId:'channel',authorId:'person',author:'Test',content:'old',timestamp:1};
 const second={...first,id:'old-second'};
 state.seed={*[Symbol.iterator](){yield first;m.clearLog();m.rememberDelete(message('new-during-load'));yield second;}};
 m.loadLog();await m.whenLogReady();await until(()=>state.rows.has('new-during-load'));
 assert.equal(m.logCount(),1);assert.equal(m.entry('channel','old-first'),undefined);assert.equal(m.entry('channel','old-second'),undefined);assert.equal(m.entry('channel','new-during-load').content,'body');assert.equal(state.rows.size,1);
});
