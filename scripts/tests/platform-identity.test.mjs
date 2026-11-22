import test,{after} from 'node:test';import assert from 'node:assert/strict';import{build}from'esbuild';import{mkdtempSync,rmSync,readFileSync}from'node:fs';import{tmpdir}from'node:os';import path from'node:path';import{pathToFileURL}from'node:url';import {EventEmitter} from 'node:events';
const dir=mkdtempSync(path.join(tmpdir(),'syncord-identity-'));let serial=0;
await build({stdin:{resolveDir:process.cwd(),contents:`export * from './src/renderer/api/platformIdentity';export {before} from './src/renderer/api/patcher';`},bundle:true,platform:'neutral',format:'esm',outfile:path.join(dir,'identity.mjs'),logLevel:'silent'});
const load=()=>import(pathToFileURL(path.join(dir,'identity.mjs')).href+'?case='+serial++);
const A='1554184140704841939',B='1554184140704841940';const tick=()=>new Promise(resolve=>setImmediate(resolve));
after(()=>rmSync(dir,{recursive:true,force:true}));
function fixture(M){
 let now=0,account=A,allowed=true,privateReads=0,ready=true,closeError=false,connectError=false;const timers=new Map();let next=0;const trace=[],sent=[];
 const clock={now:()=>now,set(fn){timers.set(++next,fn);return next;},clear(id){timers.delete(id);}};
 const nativeProperties=Object.freeze({browser:'Discord Client',os:'Mac OS X',device:'desktop',system_locale:'tr'}),presence=Object.freeze({status:'invisible',activities:[{name:'Playing'}]});
 function body(){const result={properties:{...nativeProperties},presence};Object.defineProperty(result,'privateCredential',{get(){privateReads++;throw Error('must not inspect');},enumerable:true});return result;}
 class Gateway extends EventEmitter{
  closed=false;
  send=(op,data,...rest)=>{const pack=()=>{};pack();const webSocket=true;if(webSocket&&this.isSessionEstablished())sent.push({op,data,rest});};
  isClosed(){return this.closed;}
  isSessionEstablished(){return !this.closed;}
  _cleanup(){trace.push('cleanup');}
  close(){if(closeError)throw Error('native close failure');if(this.isClosed())return;this._cleanup();this.closed=true;trace.push('close');setImmediate(()=>{trace.push('native-reset');this.emit('disconnect',{reason:'Disconnect requested by user'});});}
  connect(){if(connectError)return false;if(this.isClosed()){trace.push('WILL_RECONNECT');this.closed=false;this._connect();return true;}return false;}
  _connect(){trace.push('connect');queueMicrotask(()=>{this.send(2,body(),false);if(ready)identity.connected();});}
 }
 let target=new Gateway();const original=target.send,ctx={plugin:{id:'platform-spoofer'},permissions:{webpackPatch:true},patch:{before:M.before}};
 const identity=M.attachIdentity(ctx,()=>account,()=>allowed,()=>target,clock);
 return {identity,ctx,clock,trace,sent,timers,body,original,nativeProperties,presence,get target(){return target;},set target(v){target=v;},get reads(){return privateReads;},set account(v){account=v;},set allowed(v){allowed=v;},set ready(v){ready=v;},set closeError(v){closeError=v;},set connectError(v){connectError=v;},advance(){now+=16000;},expire(){for(const fn of [...timers.values()])fn();}};
}
test('Apply performs one native full reconnect and changes Identify properties before the original send, not just a future callback',async()=>{
 for(const [platform,browser,os]of [['mobile','Discord iOS','iOS'],['web','Discord Web','Mac OS X'],['desktop','Discord Client','Mac OS X'],['vr','Discord VR','Android']]){
  const M=await load(),f=fixture(M);assert.equal(M.isIdentityBuilder(f.target),true);assert.equal(f.identity.snapshot().available,true);assert.equal(f.target.send,f.original);assert.deepEqual(f.trace,[]);
  assert.equal(f.identity.request([platform],A),true);assert.equal(f.identity.snapshot().busy,true);assert.equal(f.sent.length,0);await tick();
  assert.deepEqual(f.trace,['cleanup','close','native-reset','WILL_RECONNECT','connect']);assert.equal(f.sent.length,1);const {op,data,rest}=f.sent[0];assert.equal(op,2);assert.deepEqual(rest,[false]);assert.equal(data.properties.browser,browser);assert.equal(data.properties.os,os);assert.equal(data.properties.system_locale,'tr');assert.equal(data.presence,f.presence);assert.equal(f.reads,0);assert.equal(f.nativeProperties.browser,'Discord Client');assert.equal(f.identity.snapshot().phase,'connected');assert.equal(f.identity.snapshot().busy,false);assert.equal(f.timers.size,0);assert.equal(f.target.listenerCount('disconnect'),0);f.identity.dispose();assert.equal(f.target.send,f.original);
 }
});
test('native close completion must precede connect; repeated Apply cannot close a connecting socket or storm Identify',async()=>{
 const M=await load(),f=fixture(M);f.identity.request(['mobile'],A);assert.equal(f.identity.request(['web'],A),false);await tick();assert.equal(f.identity.request(['web'],A),false);assert.equal(f.sent.length,1);f.advance();assert.equal(f.identity.request(['web'],A),true);await tick();assert.equal(f.sent.length,2);assert.equal(f.sent[1].data.properties.browser,'Discord Web');f.identity.dispose();
});
test('only opcode 2 public properties are changed; unrelated messages, args and shared HTTP metadata retain identity',async()=>{
 const M=await load(),f=fixture(M);f.identity.request(['mobile'],A);await tick();for(const op of [1,3,4,6]){const data=f.body();f.target.send(op,data,42);assert.equal(f.sent.at(-1).data,data);assert.equal(data.properties.browser,'Discord Client');assert.deepEqual(f.sent.at(-1).rest,[42]);}assert.equal(f.reads,0);f.identity.dispose();
});
test('Restore uses the native reconnect with the hook removed and preserves status/activity values',async()=>{
 const M=await load(),f=fixture(M);f.identity.request(['mobile'],A);await tick();f.advance();assert.equal(f.identity.restore(A),true);await tick();assert.equal(f.sent.at(-1).data.properties.browser,'Discord Client');assert.equal(f.sent.at(-1).data.presence,f.presence);assert.equal(f.identity.snapshot().phase,'connected');assert.equal(f.target.send,f.original);f.identity.dispose();
});
test('no extra sessions for multiple choices or Console; enabling/disabling never initiates a reconnect',async()=>{
 const M=await load(),f=fixture(M);assert.equal(f.identity.request(['mobile','desktop'],A),false);assert.equal(f.identity.snapshot().phase,'multiple');assert.equal(f.identity.request(['console'],A),false);assert.equal(f.identity.snapshot().phase,'console');assert.equal(f.target.send,f.original);f.identity.dispose();await tick();assert.deepEqual(f.trace,[]);
});
test('account/security changes cannot send spoofed Identify or reconnect as the previous account',async()=>{
 for(const change of ['account','security']){
  const M=await load(),f=fixture(M);f.identity.request(['mobile'],A);if(change==='account')f.account=B;else f.allowed=false;await tick();assert.equal(f.sent.length,0);f.identity.clear();assert.equal(f.target.send,f.original);assert.equal(f.target.listenerCount('disconnect'),0);assert.equal(f.timers.size,0);f.identity.dispose();
 }
});
test('disable while native close is pending restores the hook and finishes only that already-requested reconnect with defaults',async()=>{
 const M=await load(),f=fixture(M);f.identity.request(['mobile'],A);f.identity.dispose();assert.equal(f.target.send,f.original);await tick();assert.equal(f.sent.length,1);assert.equal(f.sent[0].data.properties.browser,'Discord Client');assert.equal(f.target.listenerCount('disconnect'),0);assert.equal(f.timers.size,0);assert.equal(f.identity.request(['mobile'],A),false);
});
test('timeouts, incompatible packets and native errors cannot report successful completion',async()=>{
 const M=await load(),f=fixture(M);f.ready=false;f.identity.request(['mobile'],A);await tick();assert.equal(f.identity.snapshot().phase,'prepared');f.expire();assert.equal(f.identity.snapshot().phase,'failed');assert.equal(f.target.send,f.original);assert.equal(f.timers.size,0);f.identity.dispose();
 const N=await load(),g=fixture(N);g.identity.request(['mobile'],A);await tick();g.target.send(2,Object.freeze(g.body()));assert.equal(g.identity.snapshot().phase,'failed');assert.equal(g.target.send,g.original);assert.equal(g.reads,0);g.identity.dispose();
});
test('native lifecycle failures and readonly send hooks fail without a success state or repeated reconnect',async()=>{
 for(const mode of ['close','connect','readonly']){
  const M=await load(),f=fixture(M);if(mode==='close')f.closeError=true;if(mode==='connect')f.connectError=true;if(mode==='readonly')Object.defineProperty(f.target,'send',{writable:false});
  f.identity.request(['mobile'],A);await tick();assert.equal(f.identity.snapshot().phase,'failed');assert.equal(f.target.send,f.original);assert.equal(f.sent.length,0);assert.equal(f.target.listenerCount('disconnect'),0);assert.equal(f.timers.size,0);f.identity.dispose();
 }
});
test('a later native reconnect keeps the requested identity and observes READY without starting an extra reconnect',async()=>{
 const M=await load(),f=fixture(M);f.identity.request(['mobile'],A);await tick();const count=f.trace.length;f.target.send(2,f.body(),false);assert.equal(f.identity.snapshot().phase,'prepared');f.identity.connected();assert.equal(f.identity.snapshot().phase,'connected');assert.equal(f.sent.at(-1).data.properties.browser,'Discord iOS');assert.equal(f.trace.length,count);f.identity.dispose();
});
test('unknown gateway versions and wrong owners fail closed without installing any transport hook',async()=>{
 const M=await load(),f=fixture(M);f.identity.dispose();assert.throws(()=>M.attachIdentity({...f.ctx,plugin:{id:'other'}},()=>A,()=>true),/denied/);assert.throws(()=>M.attachIdentity({...f.ctx,permissions:{}},()=>A,()=>true),/denied/);
 const identity=M.attachIdentity(f.ctx,()=>A,()=>true,()=>({send(){},close(){},connect(){}}),f.clock);assert.equal(identity.snapshot().available,false);assert.equal(identity.request(['mobile'],A),false);identity.dispose();
});
test('native instance replacement disarms the old instance instead of closing an unrelated/new account connection',async()=>{
 const M=await load(),f=fixture(M);f.identity.request(['mobile'],A);await tick();const old=f.target;f.target={};assert.equal(f.identity.snapshot().available,false);assert.equal(old.send,f.original);assert.equal(f.identity.snapshot().phase,'idle');f.identity.dispose();
});
test('source has no raw WebSocket interception, credentials, prototype hooks or direct session-state writes',()=>{
 const source=readFileSync('src/renderer/api/platformIdentity.ts','utf8');assert.doesNotMatch(source,/getToken|\.token\b|\.sessionId\b|\.seq\b|new WebSocket|eval\(|new Function|\.prototype\.(send|close)|webSocket\.close/);
 assert.match(source,/ctx.patch.before\(builder,'send'/);assert.match(source,/args\[0\]!==2/);assert.match(source,/Object.getOwnPropertyDescriptor\(args\[1\],'properties'\)/);assert.doesNotMatch(source,/Object\.(?:entries|values|keys|getOwnPropertyDescriptors)\(args\[1\]\)|\.\.\.args\[1\]/);
});
