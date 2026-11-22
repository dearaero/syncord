import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(tmpdir()+'/syncord-drop-inbox-');
await build({stdin:{resolveDir:process.cwd(),contents:"export * from './src/renderer/plugins/syncordDrop/inbox';export * from './src/shared/drop';"},bundle:true,platform:'node',format:'esm',outfile:dir+'/fixture.mjs',logLevel:'silent'});
const {watchDropInbox,dropInbox}=await import(pathToFileURL(dir+'/fixture.mjs').href);
test.after(()=>rmSync(dir,{recursive:true,force:true}));
const A='100000000000000001',B='100000000000000002';
const invite=(id='12345678-1234-4123-8123-123456789abc',receiver=A)=>({id,receiver,sender:receiver===A?B:A,name:'x.zip',size:2147483685,senderName:'Sender',receiverName:'Receiver',state:'pending',expires:Date.now()+600000});
const flush=()=>new Promise(setImmediate);
test('Drop inbox contract rejects foreign accounts, SDP, terminal states, duplicates and unbounded lists',()=>{
 const v=invite(),sdp='v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 '+Array(32).fill('AB').join(':')+'\r\n';assert.deepEqual(dropInbox([v],A),[v]);
 for(const input of [{invites:[v]},Array(9).fill(v),[v,v],[{...v,receiver:B}],[{...v,state:'accepted'}],[{...v,name:'../x'}],[{...v,offer:sdp}]])assert.throws(()=>dropInbox(input,A),/drop.invalid/);
});
test('Drop heartbeat remains serial and live during panels/background; disabled reception and stop withdraw availability',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});
 let busy=false,enabled=true,hidden=false;const calls=[],shown=[];
 const p=watchDropInbox({account:()=>A,enabled:()=>enabled,busy:()=>busy,hidden:()=>hidden,read:async(id,active)=>{calls.push([id,active]);return active?[invite()]:[];},show:v=>{shown.push(v);busy=true;}});
 t.mock.timers.tick(1000);await flush();assert.deepEqual(calls,[[A,true]]);assert.equal(shown.length,1);
 t.mock.timers.tick(15000);await flush();assert.equal(calls.length,2,'busy panels keep the lease alive');assert.equal(shown.length,1);
 busy=false;hidden=true;t.mock.timers.tick(15000);await flush();assert.equal(calls.length,3);assert.equal(shown.length,1,'requests are deduplicated');
 t.mock.timers.tick(29999);p.wake();await flush();assert.equal(calls.length,3);t.mock.timers.tick(1);await flush();assert.equal(calls.length,4);
 enabled=false;p.wake();await flush();assert.deepEqual(calls.at(-1),[A,false]);const n=calls.length;t.mock.timers.tick(15000);await flush();assert.equal(calls.length,n);
 enabled=true;p.wake();await flush();assert.deepEqual(calls.at(-1),[A,true]);
 p.stop();await flush();assert.deepEqual(calls.at(-1),[A,false]);const end=calls.length;t.mock.timers.tick(600000);p.wake();await flush();assert.equal(calls.length,end);
});
test('Drop late renewals cannot display after account changes or stop; no overlapping reads and errors back off',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});
 let account=A,finish,fail=false;const calls=[],shown=[];
 const p=watchDropInbox({account:()=>account,enabled:()=>true,busy:()=>false,hidden:()=>false,read:async(id,active)=>{calls.push([id,active]);if(!active)return[];if(fail)throw Error('offline');return await new Promise(r=>finish=r);},show:v=>shown.push(v)});
 t.mock.timers.tick(1000);await flush();assert.deepEqual(calls,[[A,true]]);
 account=B;p.wake();await flush();assert.deepEqual(calls.at(-1),[A,false]);t.mock.timers.tick(60000);p.wake();assert.equal(calls.length,2);
 finish([invite()]);await flush();assert.equal(shown.length,0);t.mock.timers.tick(0);await flush();assert.deepEqual(calls.at(-1),[B,true]);
 fail=true;finish([]);await flush();t.mock.timers.tick(15000);await flush();const n=calls.length;
 for(let i=0;i<5;i++){p.wake();t.mock.timers.tick(1000);await flush();}assert.equal(calls.length,n);
 t.mock.timers.tick(55000);await flush();assert.equal(calls.length,n+1);
 p.stop();await flush();assert.deepEqual(calls.at(-1),[B,false]);
});
test('Stopping with an in-flight renewal withdraws immediately and discards its eventual invitations',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});let finish;const calls=[],shown=[];
 const p=watchDropInbox({account:()=>A,enabled:()=>true,busy:()=>false,hidden:()=>false,read:async(id,active)=>{calls.push(active);return active?await new Promise(r=>finish=r):[];},show:v=>shown.push(v)});
 t.mock.timers.tick(1000);await flush();p.stop();await flush();assert.deepEqual(calls,[true,false]);finish([invite()]);await flush();assert.deepEqual(shown,[]);
});
