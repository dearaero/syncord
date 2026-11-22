import test,{after} from 'node:test';import assert from 'node:assert/strict';import{build}from'esbuild';import{mkdtempSync,rmSync,readFileSync}from'node:fs';import{tmpdir}from'node:os';import path from'node:path';import{pathToFileURL}from'node:url';
const dir=mkdtempSync(path.join(tmpdir(),'syncord-fake-dm-'));
await build({stdin:{resolveDir:process.cwd(),contents:`export * from './src/renderer/plugins/fakeDM/model';export * from './src/renderer/plugins/fakeDM/storage';`},bundle:true,platform:'neutral',format:'esm',outfile:path.join(dir,'test.mjs'),logLevel:'silent'});
const M=await import(pathToFileURL(path.join(dir,'test.mjs')));after(()=>rmSync(dir,{recursive:true,force:true}));
const A='1554184140704841939',B='1554184140704841940',C='1554184140704841941',D='1554184140704841942';
let serial=0;const row=(extra={})=>({id:'syncord-local:00000000-0000-4000-8000-'+String(++serial).padStart(12,'0'),accountId:A,channelId:C,authorId:B,kind:'message',content:'Hello\n**world**',timestamp:'2026-10-30T12:00:00.000Z',createdAt:1,updatedAt:1,...extra});
function harness(initial){let account=A,writes=0;const data={records:initial};const store=new M.LocalStore({settings:{get:k=>data[k],set:(k,v)=>{data[k]=v;writes++;}}},()=>account,()=>true);return{store,data,get writes(){return writes;},set account(v){account=v;}};}
test('local IDs, account/channel binding, text, ISO and timestamps are structurally validated',()=>{
 assert.ok(M.validate(row(),A,C));for(const extra of [{id:A},{accountId:B},{channelId:D},{authorId:'1'},{content:''},{content:'   '},{content:'a'.repeat(8001)},{timestamp:'2026-02-30T00:00:00.000Z'},{updatedAt:0},{createdAt:Infinity},{kind:'unknown'}])assert.equal(M.validate(row(extra),A,C),undefined);
});
test('answered and missed calls validate participants, exact start/end and bounded durations without RTC actions',()=>{
 const call=row({kind:'call',content:'',receiverId:A,missed:false,endedAt:'2026-10-30T12:01:00.000Z'});assert.ok(M.validate(call,A,C));assert.ok(M.validate({...call,missed:true,endedAt:call.timestamp},A,C));for(const extra of [{receiverId:B},{missed:true},{endedAt:'2026-10-30T11:59:00.000Z'},{endedAt:'2026-11-01T12:00:00.000Z'}])assert.equal(M.validate({...call,...extra},A,C),undefined);
});
test('loading is idempotent, rejects unknown schemas and skips corrupt, duplicate or cross-account records',()=>{
 const one=row(),db={version:1,accounts:{[A]:{[C]:[one,one,row({content:''}),row({accountId:B})]}}};const loaded=M.load(db);assert.equal(loaded.accounts[A][C].length,1);assert.deepEqual(M.load(loaded),loaded);assert.throws(()=>M.load('{invalid'),/fd.invalid/);assert.throws(()=>M.load({version:2,accounts:{}}),/fd.invalid/);
});
test('same-timestamp ordering is stable, historical/future dates survive round trips unchanged',()=>{
 const a=row({createdAt:2,updatedAt:2}),b=row(),older=row({timestamp:'2020-01-01T00:00:00.000Z'}),future=row({timestamp:'2030-01-01T00:00:00.000Z'});const loaded=M.load({version:1,accounts:{[A]:{[C]:[future,a,b,older]}}});assert.deepEqual(loaded.accounts[A][C].map(r=>r.id),[older.id,b.id,a.id,future.id]);assert.deepEqual(M.load(loaded),loaded);
});
test('local date/time round trips preserve selected seconds; impossible dates and malformed local values fail',()=>{
 for(const value of ['2026-10-30T20:45:37','2020-01-01T00:00:00','2030-05-15T10:01:02'])assert.equal(M.toLocal(M.parseDate(value)),value);for(const value of ['2026-02-30T00:00:00','2026-10-30T25:10:00','garbage','2026-01-01'])assert.equal(M.parseDate(value),undefined);
});
test('create, edit, single delete and clear touch only local channel/account data; restore survives re-instantiation',()=>{
 const h=harness(),one=row(),two=row({channelId:D});h.store.update(C,one,[A,B]);h.store.update(D,two,[A,B]);h.store.update(C,{...one,content:'edited',updatedAt:2},[A,B]);assert.equal(h.store.rows(C)[0].content,'edited');assert.equal(h.store.rows(C).length,1);assert.throws(()=>h.store.update(C,row({authorId:D}),[A,B]),/fd.invalid/);
 h.account=B;assert.deepEqual(h.store.rows(C),[]);h.store.update(C,row({accountId:B,authorId:A}),[A,B]);h.store.remove(C);h.account=A;assert.equal(h.store.rows(C).length,1);const restored=harness(h.data.records);assert.deepEqual(restored.store.rows(C),h.store.rows(C));h.store.remove(C,one.id);assert.equal(h.store.rows(C).length,0);assert.equal(h.store.rows(D).length,1);h.store.dispose();
});
test('model enforces channel and total byte quotas independently of UI without replacing valid stored data',()=>{
 const h=harness();for(let n=0;n<M.LIMITS.channel;n++)h.store.update(C,row(),[A,B]);assert.throws(()=>h.store.update(C,row(),[A,B]),/fd.limit/);const writes=h.writes;assert.equal(h.store.rows(C).length,200);assert.equal(h.writes,writes);
 const g=harness();for(let n=0;n<14;n++)g.store.update(C,row({content:'a'.repeat(8000)}),[A,B]);assert.throws(()=>{for(let n=0;n<10;n++)g.store.update(C,row({content:'a'.repeat(8000)}),[A,B]);},/fd.limit/);assert.ok(new TextEncoder().encode(JSON.stringify(g.data.records)).byteLength<=M.LIMITS.bytes);
});
test('storage errors cannot be reported as saved; subscribers are removed without deleting persisted records',()=>{
 let notice=0;const h=harness(),off=h.store.subscribe(()=>notice++);h.store.update(C,row(),[A,B]);assert.equal(notice,1);off();h.store.update(C,row(),[A,B]);assert.equal(notice,1);h.store.dispose();assert.equal(h.store.rows(C).length,2);
 const store=new M.LocalStore({settings:{get(){},set(){throw Error('write denied');}}},()=>A,()=>true);assert.throws(()=>store.update(C,row(),[A,B]),/write denied/);assert.equal(store.rows(C).length,0);
});
test('model/store have no Discord mutation, network, credential, DOM or separate localStorage path',()=>{
 for(const file of ['model','storage'])assert.doesNotMatch(readFileSync('src/renderer/plugins/fakeDM/'+file+'.ts','utf8'),/MESSAGE_CREATE|MESSAGE_DELETE|CALL_CREATE|CALL_UPDATE|\.dispatch\(|MessageStore|ReadStateStore|localStorage|fetch\(|getToken|innerHTML|ipcRenderer|new WebSocket/);
});
