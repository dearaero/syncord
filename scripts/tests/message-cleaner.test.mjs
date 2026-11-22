import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const temp=mkdtempSync(path.join(tmpdir(),'syncord-cleaner-'));
await build({stdin:{resolveDir:process.cwd(),loader:'ts',contents:'export * from "./src/renderer/plugins/messageCleaner/engine";export * from "./src/renderer/plugins/messageCleaner/discord";export {CleanupMeter} from "./src/renderer/plugins/messageCleaner/metrics";export {DeleteWindow} from "./src/renderer/plugins/messageCleaner/deleteWindow";export {DeletePacer} from "./src/renderer/plugins/messageCleaner/pacer";export {resolveUtils} from "./src/renderer/webpack/common/utils";export {initWebpack,find} from "./src/renderer/webpack";'},bundle:true,platform:'neutral',format:'esm',outfile:path.join(temp,'engine.mjs'),logLevel:'warning'});
const T=await import(pathToFileURL(path.join(temp,'engine.mjs')).href);rmSync(temp,{recursive:true,force:true});
const USER='100000000000000001',OTHER='100000000000000002',CHANNEL='200000000000000001';
const target={channelId:CHANNEL,userId:USER,name:'Test chat'};
const id=n=>(300000000000000000n+BigInt(n)).toString();
const msg=(n,user=USER,type=0)=>({id:id(n),channel_id:CHANNEL,author:{id:user},type});
function fixture(messages=[],overrides={}){
 let clock=1_800_000_000_000;const calls=[],waits=[],states=[],deleted=[];let loggedIn=USER;
 const port={assertTarget(t){assert.equal(t.channelId,CHANNEL);if(loggedIn!==t.userId)throw new Error('Account changed');},
  async request(method,channel,key){calls.push({method,channel,key,at:clock});if(overrides.request)return overrides.request(method,channel,key,calls.length);
   return method==='get'?{status:200,body:messages.filter(m=>BigInt(m.id)<BigInt(key)).slice(0,100)}:{status:204};},
  deleted(channel,key){deleted.push([channel,key]);overrides.deleted?.(channel,key);}};
 const engine=new T.MessageCleanup(port,s=>{states.push(s);overrides.changed?.(s);},()=>clock,async(ms,signal)=>{assert.equal(signal.aborted,false);waits.push(ms);if(overrides.sleep)await overrides.sleep(ms,signal);clock+=ms;});
 return {engine,calls,waits,states,deleted,account:id=>{loggedIn=id;},now:()=>clock};
}
test('cleaner: validates options and cooldowns, never opens a request on invalid target/limit',async()=>{
 assert.equal(T.parseCooldown(''),0);assert.equal(T.parseCooldown('  '),0);assert.equal(T.parseCooldown('0.25'),250);assert.equal(T.parseCooldown('86400'),86400000);
 for(const value of ['-1','Infinity','NaN','86401','0x10','1e3'])assert.throws(()=>T.parseCooldown(value));
 for(const value of [null,'../../','0','18446744073709551616','1'.repeat(100)])assert.equal(T.validId(value),false);
 const f=fixture();for(const patch of [{channelId:'../x'},{userId:'wrong'}])await assert.rejects(f.engine.run({...target,...patch},10,0));
 await assert.rejects(f.engine.run(target,11,0));await assert.rejects(f.engine.run(target,10,Infinity));assert.equal(f.calls.length,0);
});
test('cleaner: last 10 means own messages across unloaded pages; newest first, no other authors or webhook/system deletion',async()=>{
 const history=Array.from({length:220},(_,i)=>msg(220-i,i%15===0?USER:OTHER));
 history[0].type=3;history[15].webhook_id='webhook';history[30].type=21;
 const f=fixture(history);await f.engine.run(target,10,0);
 const expected=history.filter(m=>m.author.id===USER&&!m.webhook_id&&m.type===0).slice(0,10).map(m=>m.id);
 assert.deepEqual(f.deleted.map(v=>v[1]),expected);assert.equal(f.engine.snapshot().phase,'completed');assert.equal(f.engine.snapshot().deleted,10);
 assert.equal(f.calls.filter(c=>c.method==='get').length,2);assert.equal(f.waits.length,0);assert.equal(f.engine.snapshot().skipped,2);
 assert.ok(f.calls.every(c=>c.channel===CHANNEL));
});
test('cleaner: last 100 and all finish with constant-size history pages, never discover future messages',async()=>{
 const history=Array.from({length:305},(_,i)=>msg(305-i,i%2?OTHER:USER));
 for(const limit of [100,null]){const f=fixture(history);await f.engine.run(target,limit,0);assert.equal(f.deleted.length,limit??153);assert.equal(f.engine.snapshot().phase,'completed');
 const reads=f.calls.filter(c=>c.method==='get');assert.ok(reads.length>=2);for(let i=1;i<reads.length;i++)assert.ok(BigInt(reads[i].key)<BigInt(reads[i-1].key));
 const cutoff=((BigInt(f.now())-1420070400000n)<<22n).toString();assert.equal(reads[0].key,cutoff);}
});
test('cleaner: honors configured cooldown between deletions and exhausted response headers',async()=>{
 let page=0,deletes=0;
 const f=fixture([],{request:async method=>method==='get'?{status:200,body:page++?[]:[msg(2),msg(1)]}:{status:204,headers:++deletes===1?{'X-RateLimit-Remaining':'0','X-RateLimit-Reset-After':'2.25'}:{}}});
 await f.engine.run(target,null,500);assert.equal(f.deleted.length,2);assert.deepEqual(f.waits,[2300]);
 const custom=fixture([msg(3),msg(2),msg(1)]);await custom.engine.run(target,10,750);assert.deepEqual(custom.waits,[750,750]);
});
test('cleaner: 429 retries the same message only after the full server deadline; success counts once',async()=>{
 let tries=0,page=0;const f=fixture([],{request:async method=>method==='get'?{status:200,body:page++?[]:[msg(1)]}:++tries===1?{status:429,body:{retry_after:52576,global:true}}:{status:204}});
 await f.engine.run(target,10,0);assert.deepEqual(f.waits,[52576050]);assert.equal(f.deleted.length,1);assert.equal(f.engine.snapshot().deleted,1);
 assert.deepEqual(f.calls.filter(c=>c.method==='del').map(c=>c.key),[id(1),id(1)]);assert.ok(f.states.some(s=>s.phase==='waiting'));
});
test('cleaner: thrown native HTTP errors and Headers retry-after are understood',async()=>{
 let tries=0,page=0;const f=fixture([],{request:async method=>{if(method==='get')return{status:200,body:page++?[]:[msg(1)]};if(++tries===1)throw {response:{status:429,headers:new Headers({'Retry-After':'1.25'})}};return{status:204};}});
 await f.engine.run(target,10,0);assert.deepEqual(f.waits,[1300]);assert.equal(f.deleted.length,1);
 assert.equal(T.retryDelay({headers:{'Retry-After':'Thu, 15 Oct 2026 12:00:00 GMT'}},Date.parse('Thu, 15 Oct 2026 11:59:00 GMT')),60000);
});
test('cleaner: rate limits survive Stop/Start; new runs do not bypass pending waits',async()=>{
 let page=0,deletes=0,stopped=false;let f;
 f=fixture([],{request:async method=>method==='get'?{status:200,body:page++%2?[]:[msg(1)]}:++deletes===1?{status:429,body:{retry_after:3600}}:{status:204},changed:s=>{if(s.phase==='waiting'&&!stopped){stopped=true;f.engine.stop();}}});
 await f.engine.run(target,10,0);assert.equal(f.engine.snapshot().phase,'stopped');assert.equal(f.deleted.length,0);
 page=0;await f.engine.run(target,10,0);assert.ok(f.waits.some(ms=>ms>=3600000));assert.equal(f.deleted.length,1);
});
test('cleaner: no retry on forbidden, wrong channel, or malformed pagination',async()=>{
 for(const response of [{status:403},{status:401},{status:500},{status:0}]){
  const f=fixture([],{request:async()=>response});await f.engine.run(target,10,0);assert.equal(f.calls.length,1);assert.equal(f.engine.snapshot().phase,'error');assert.equal(f.deleted.length,0);
 }
 for(const body of [[{...msg(1),channel_id:OTHER}],[msg(1),msg(1)],null,[null],[{...msg(1),id:'../'}]]){
  const f=fixture([],{request:async()=>({status:200,body})});await f.engine.run(target,10,0);assert.equal(f.engine.snapshot().phase,'error');assert.equal(f.deleted.length,0);
 }
 const f=fixture([],{request:async method=>method==='get'?{status:200,body:[msg(1)]}:{status:204}});await f.engine.run(target,null,0);assert.equal(f.calls.filter(c=>c.method==='del').length,1);assert.equal(f.engine.snapshot().phase,'error');
});
test('cleaner: unknown message 404 is skipped; channel 404 stops, never retries blindly',async()=>{
 for(const code of [10008,10003]){let page=0;const f=fixture([],{request:async method=>method==='get'?{status:200,body:page++?[]:[msg(1)]}:{status:404,body:{code}}});await f.engine.run(target,10,0);
 assert.equal(f.deleted.length,0);assert.equal(f.engine.snapshot().phase,code===10008?'completed':'error');assert.equal(f.engine.snapshot().missing,code===10008?1:0);}
});
test('cleaner: account change stops before the next deletion; cancellation keeps in-flight success accurate',async()=>{
 let f;f=fixture([msg(3),msg(2),msg(1)],{deleted:()=>f.account(OTHER)});await f.engine.run(target,null,0);assert.equal(f.deleted.length,1);assert.equal(f.engine.snapshot().phase,'error');
 let release;const held=new Promise(resolve=>{release=resolve;});let requested;const hit=new Promise(resolve=>{requested=resolve;});
 const g=fixture([],{request:async method=>{if(method==='get')return{status:200,body:[msg(2),msg(1)]};requested();await held;return{status:204};}});
 const running=g.engine.run(target,null,0);await hit;g.engine.stop();await assert.rejects(g.engine.run(target,10,0));release();await running;
 assert.equal(g.deleted.length,1);assert.equal(g.engine.snapshot().deleted,1);assert.equal(g.engine.snapshot().phase,'stopped');assert.equal(g.engine.active(),false);
});
test('cleaner: real abortable timer is released promptly on Stop',async()=>{
 const c=new AbortController();const waiting=T.abortableSleep(1e9,c.signal);c.abort();await assert.rejects(waiting,{name:'AbortError'});
});
test('cleaner adapter: native REST keeps authentication internal, awaits deletion, emits only confirmed cache updates',async()=>{
 const calls=[],events=[];let account=USER;
 const userStore={getCurrentUser:()=>({id:account}),getUser:()=>({username:'<unsafe name>'})};
 const chan={id:CHANNEL,type:1,recipients:[OTHER]};
 const rest={post(){},put(){},patch(){},async get(o){assert.equal(this,rest);calls.push(['get',o]);return{status:200,body:[]};},async del(o){assert.equal(this,rest);calls.push(['del',o]);return{status:204};}};
 const dispatcher={marker:true,dispatch(e){assert.equal(this.marker,true);events.push(e);return Promise.resolve();}};
 globalThis.window={Syncord:{common:{stores:{UserStore:userStore,ChannelStore:{getChannel:()=>chan},SelectedChannelStore:{getChannelId:()=>CHANNEL}},utils:{RestAPI:rest},flux:{FluxDispatcher:dispatcher}}}};
 const p=T.discordPort({warn(){}});const t=T.selectedTarget();assert.equal(t.name,'<unsafe name>');p.assertTarget(t);
 await p.request('get',CHANNEL,id(4));await p.request('del',CHANNEL,id(3));assert.equal(events.length,0);p.deleted(CHANNEL,id(3));assert.deepEqual(events,[{type:'MESSAGE_DELETE',channelId:CHANNEL,id:id(3)}]);
 for(const [method,o]of calls){assert.equal(o.retries,0);assert.equal(o.failImmediatelyWhenRateLimited,true);assert.equal(o.rejectWithError,true);assert.equal('headers'in o,false);assert.equal('body'in o,false);}
 assert.deepEqual(calls[0][1].query,{limit:100,before:id(4)});assert.equal(calls[1][1].url,`/channels/${CHANNEL}/messages/${id(3)}`);
 account=OTHER;assert.throws(()=>p.assertTarget(t),/account changed/);delete globalThis.window;
});
test('cleaner adapter: permission computation ignores patched can(); unsupported channels and missing modules fail closed',()=>{
 const c={id:CHANNEL,type:0,guild_id:OTHER,name:'test'};const stores={UserStore:{getCurrentUser:()=>({id:USER})},ChannelStore:{getChannel:()=>c},SelectedChannelStore:{getChannelId:()=>CHANNEL},PermissionStore:{can:()=>true,computePermissions:()=>0n}};
 globalThis.window={Syncord:{common:{stores}}};assert.throws(()=>T.assertTarget(target),/Read Message History/);stores.PermissionStore.computePermissions=()=>8n;T.assertTarget(target);
 c.type=4;assert.equal(T.selectedTarget(),undefined);assert.throws(()=>T.assertTarget(target));assert.throws(()=>T.discordPort({warn(){}}),/not ready/);delete globalThis.window;
});

test('cleaner adapter: visible route wins over a stale selected channel; home/settings never target the previous chat',()=>{
 const stale='200000000000000099';
 globalThis.window={location:{protocol:'https:',pathname:`/channels/@me/${CHANNEL}`},Syncord:{common:{stores:{UserStore:{getCurrentUser:()=>({id:USER})},SelectedChannelStore:{getChannelId:()=>stale},ChannelStore:{getChannel:id=>({id,type:1})}}}}};
 assert.equal(T.selectedTarget()?.channelId,CHANNEL);
 for(const pathname of ['/channels/@me','/channels/@me/','/shop','/quest-home','/settings','/channels/123','/channels/@me/not-a-channel']){
  window.location.pathname=pathname;assert.equal(T.selectedTarget(),undefined,pathname);
 }
 window.location.pathname=`/channels/${OTHER}/${CHANNEL}`;assert.equal(T.selectedTarget()?.channelId,CHANNEL);
 window.Syncord.common.stores.SelectedChannelStore=undefined;assert.equal(T.selectedTarget()?.channelId,CHANNEL);
 delete globalThis.window;
});
test('cleaner adapter: cached modern REST object without getAPIBaseURL is discovered despite a stale common entry',async()=>{
 const calls=[];
 const rest={get:async o=>{calls.push(['get',o]);return{status:200,body:[]};},post(){},put(){},patch(){},del:async o=>{calls.push(['del',o]);return{status:204};}};
 const raw=Object.assign(function rawHttp(){throw new Error('Raw transport must not be used');},rest);
 const wrong={get:true,post:true,put:true,patch:true,del:true};
 globalThis.window={Syncord:{common:{utils:{RestAPI:wrong}},webpack:{findByProps:()=>undefined,find:predicate=>[raw,wrong,{Bo:rest},rest].find(predicate),getRequire:()=>{throw new Error('Discovery must not load factories');}}}};
 const p=T.discordPort({warn(){}});await p.request('get',CHANNEL,id(2));await p.request('del',CHANNEL,id(1));
 assert.equal(calls.length,2);assert.equal(calls[0][1].url,`/channels/${CHANNEL}/messages`);assert.equal(calls[1][1].url,`/channels/${CHANNEL}/messages/${id(1)}`);
 delete globalThis.window;
});

test('common REST resolution: real cached namespace export, late initialization, no base helper and no factory execution',async()=>{
 const previousM=Object.getOwnPropertyDescriptor(Function.prototype,'m');
 const previousWindow=globalThis.window,previousDocument=globalThis.document;
 let factoryCalls=0;const calls=[];
 const req=()=>{factoryCalls++;throw new Error('Must never execute Discord factories');};
 Object.defineProperty(req,'m',{value:Object.fromEntries(Array.from({length:600},(_,i)=>[String(i),()=>{}])),configurable:true});req.c={};
 const chunks=[];chunks.push=chunk=>{chunk[2](req);return 1;};
 globalThis.window={webpackChunkdiscord_app:chunks};globalThis.document={documentElement:{}};
 try {
  T.initWebpack();assert.equal(T.resolveUtils().RestAPI,undefined);
  const api={get:async o=>{calls.push(o);return{status:200,body:[]};},post(){},put(){},patch(){},del:async o=>{calls.push(o);return{status:204};}};
  const raw=Object.assign(function rawHttp(){throw new Error('Wrong transport');},api);
  req.c.raw={exports:{transport:raw}};req.c.http={exports:{Bo:api,TP:()=>'/api/v9'}};
  assert.equal(T.resolveUtils().RestAPI,api);
  window.Syncord={common:{utils:{RestAPI:undefined}},webpack:{find:T.find}};
  const port=T.discordPort({warn(){}});await port.request('get',CHANNEL,id(2));await port.request('del',CHANNEL,id(1));
  assert.equal(calls.length,2);assert.equal(factoryCalls,0);
 }finally{
  if(previousM)Object.defineProperty(Function.prototype,'m',previousM);else delete Function.prototype.m;
  if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow;
  if(previousDocument===undefined)delete globalThis.document;else globalThis.document=previousDocument;
 }
});
test('cleaner speed: relative reset avoids extra waits from a skewed computer clock',async()=>{
 let page=0,deletes=0;
 const f=fixture([],{request:async method=>method==='get'?{status:200,body:page++?[]:[msg(2),msg(1)]}:{status:204,headers:++deletes===1?{'x-ratelimit-remaining':'0','x-ratelimit-reset-after':'2.25','x-ratelimit-reset':String((f.now()+122250)/1000)}:{}}});
 await f.engine.run(target,null,0);assert.deepEqual(f.waits,[2300]);assert.equal(f.deleted.length,2);assert.equal(f.engine.snapshot().phase,'completed');
});
test('cleaner speed: absolute reset fallback uses the server Date when clocks differ',async()=>{
 for(const relative of [undefined,'invalid','']){
  let page=0,deletes=0;const serverTime=1_800_000_120_000;
  const f=fixture([],{request:async method=>method==='get'?{status:200,body:page++?[]:[msg(2),msg(1)]}:{status:204,headers:++deletes===1?{'x-ratelimit-remaining':'0','x-ratelimit-reset-after':relative,'x-ratelimit-reset':String((serverTime+2500)/1000),Date:new Date(serverTime).toUTCString()}:{}}});
  await f.engine.run(target,null,0);assert.deepEqual(f.waits,[2550]);assert.equal(f.deleted.length,2);
 }
});
test('cleaner speed: valid zero relative reset does not add an absolute-clock delay',async()=>{
 let page=0,deletes=0;
 const f=fixture([],{request:async method=>method==='get'?{status:200,body:page++?[]:[msg(2),msg(1)]}:{status:204,headers:++deletes===1?{'x-ratelimit-remaining':'0','x-ratelimit-reset-after':'0','x-ratelimit-reset':String((f.now()+120000)/1000)}:{}}});
 await f.engine.run(target,null,0);assert.deepEqual(f.waits,[]);assert.equal(f.deleted.length,2);
});
test('cleaner speed: optimizing reset math never shortens an explicit 429 Retry-After',async()=>{
 let page=0,attempts=0;
 const f=fixture([],{request:async method=>method==='get'?{status:200,body:page++?[]:[msg(1)]}:++attempts===1?{status:429,body:{retry_after:8},headers:{'x-ratelimit-remaining':'0','x-ratelimit-reset-after':'1','Retry-After':'12'}}:{status:204}});
 await f.engine.run(target,10,0);assert.deepEqual(f.waits,[12050]);assert.equal(f.deleted.length,1);
});

test('adaptive DELETE credits: max three, no stale or out-of-order capacity, serialized cooldown and bucket changes',()=>{
 const w=new T.DeleteWindow();assert.equal(w.width(1000,0),1);
 w.observe('bucket','5',5000,1000);assert.equal(w.width(1000,0),3);w.reserve(3);
 w.observe('bucket','2',4900,1100);w.observe('bucket','4',4900,1100);assert.equal(w.width(1100,0),1);
 assert.equal(w.width(1100,50),1);w.reserve(2);assert.equal(w.blockedUntil(1100),6000);
 assert.equal(w.width(6001,0),1);w.observe('bucket','5',5000,6001);assert.equal(w.width(6001,0),3);
 w.observe('different-age-bucket','20',5000,6002);assert.equal(w.width(6002,0),1);
 const missing=new T.DeleteWindow();missing.observe('bucket','5',5000,1000);missing.reserve(3);missing.observe(undefined,undefined,0,1001);missing.observe('bucket','5',5000,1002);assert.equal(missing.width(1002,0),1);
});
async function latencyScenario(Engine=T.MessageCleanup,{headers=true,stopAtParallel=false,failAtParallel=false,rateAtParallel=false,parallelErrorAt=2,cooldown=0,limit=10,rtt=80}={}){
 let now=1_800_000_000_000,done=false,error,active=0,peak=0,count=0;const pending=[],widths=[],starts=[],deleted=[],waits=[];
 const messages=Array.from({length:10},(_,i)=>msg(10-i));
 const port={assertTarget(){},deleted(channel,id){deleted.push(id);},async request(method,channel,key){
  if(method==='get')return{status:200,body:messages.filter(m=>BigInt(m.id)<BigInt(key)).slice(0,100)};
  starts.push(now);active++;peak=Math.max(peak,active);const sequence=++count;
  return new Promise(resolve=>pending.push(()=>{active--;if(failAtParallel&&sequence===parallelErrorAt){resolve({status:403});return;}
   if(rateAtParallel&&sequence===parallelErrorAt){resolve({status:429,body:{retry_after:3,global:true}});return;}
   resolve({status:204,headers:headers?{'x-ratelimit-bucket':'delete-test','x-ratelimit-remaining':String(100-sequence),'x-ratelimit-reset-after':'100'}:{}});}));
 }};
 const engine=new Engine(port,()=>{},()=>now,async(ms,signal)=>{if(signal.aborted)throw new DOMException('Stopped','AbortError');waits.push(ms);now+=ms;});
 const run=engine.run(target,limit,cooldown).then(()=>{done=true;},e=>{error=e;done=true;});
 for(let turn=0;turn<100&&!done;turn++){
  for(let i=0;i<30;i++)await Promise.resolve();
  if(pending.length){const group=pending.splice(0);widths.push(group.length);if(stopAtParallel&&group.length>1)engine.stop();now+=rtt;for(const resolve of group)resolve();}
 }
 await run;if(error)throw error;return{now,elapsed:now-1_800_000_000_000,peak,widths,starts,deleted,waits,state:engine.snapshot(),active:engine.active()};
}
test('bounded parallel deletion: deterministic 80ms RTT benchmark uses four rounds instead of ten',async()=>{
 const fast=await latencyScenario();assert.equal(fast.peak,3);assert.deepEqual(fast.widths,[1,3,3,3]);assert.equal(fast.elapsed,320);assert.equal(fast.deleted.length,10);assert.equal(fast.state.phase,'completed');

});
test('missing quota metadata: two serial acknowledgements precede bounded overlap and accurate metrics',async()=>{
 const r=await latencyScenario(T.MessageCleanup,{headers:false});
 assert.equal(r.state.phase,'completed');assert.equal(r.peak,2);assert.deepEqual(r.widths,[1,1,2,2,2,2]);
 assert.equal(r.deleted.length,10);assert.equal(new Set(r.deleted).size,10);assert.ok(r.elapsed>=480&&r.elapsed<500);
 assert.equal(r.state.metrics.peakConcurrency,2);assert.equal(r.state.metrics.requests,11);assert.ok(r.state.metrics.averageRequestMs>=800/11&&r.state.metrics.averageRequestMs<75);
 assert.ok(r.state.metrics.pacingWaitMs>0&&r.state.metrics.pacingWaitMs<20);
 assert.equal(r.state.metrics.rateWaitMs,0);assert.equal(r.state.metrics.rateLimitResponses,0);
 assert.match(r.state.pacing,/up to 2 in flight.*quota metadata unavailable/);
});
test('missing quota metadata: 429 pauses fully and disables overlap for the rest of the job, including late successes',async()=>{
 // Reject the first request of the parallel group; its peer succeeds later.
 const r=await latencyScenario(T.MessageCleanup,{headers:false,rateAtParallel:true,parallelErrorAt:3});
 assert.equal(r.state.phase,'completed');assert.equal(r.peak,2);assert.deepEqual(r.widths.slice(0,3),[1,1,2]);
 assert.ok(r.widths.slice(3).every(n=>n===1));assert.ok(r.waits.some(ms=>ms>=3050));
 assert.ok(r.starts[4]>=r.starts[2]+3050);assert.equal(new Set(r.deleted).size,10);
 assert.equal(r.state.metrics.rateLimitResponses,1);assert.match(r.state.pacing,/Sequential.*Rate limit observed/);
});
test('missing quota metadata: cooldown stays serial and Stop settles only the two in-flight deletions',async()=>{
 const slow=await latencyScenario(T.MessageCleanup,{headers:false,cooldown:200});
 assert.equal(slow.peak,1);assert.equal(slow.deleted.length,10);assert.equal(slow.state.metrics.cooldownWaitMs,1800);
 const stopped=await latencyScenario(T.MessageCleanup,{headers:false,stopAtParallel:true});
 assert.equal(stopped.state.phase,'stopped');assert.equal(stopped.deleted.length,4);assert.deepEqual(stopped.widths,[1,1,2]);assert.equal(stopped.active,false);
 const failed=await latencyScenario(T.MessageCleanup,{headers:false,failAtParallel:true,parallelErrorAt:3});
 assert.equal(failed.state.phase,'error');assert.equal(failed.deleted.length,3);assert.deepEqual(failed.widths,[1,1,2]);assert.equal(failed.active,false);
});
test('missing quota metadata: never substitute speculative credits for an exhausted or previously known bucket',()=>{
 const w=new T.DeleteWindow();w.observe(undefined,undefined,0,0);assert.equal(w.width(0,0),1);
 w.observe(undefined,undefined,0,80);assert.equal(w.width(80,0),2);
 w.observe('known','0',1000,160);assert.equal(w.width(160,0),1);assert.equal(w.blockedUntil(160),1160);
 assert.equal(w.width(1160,0),1);w.observe(undefined,undefined,0,1160);w.observe(undefined,undefined,0,1240);assert.equal(w.width(1240,0),1);
 const limited=new T.DeleteWindow();limited.observe(undefined,undefined,0,0);limited.limited(5000);
 limited.observe(undefined,undefined,0,100);limited.observe(undefined,undefined,0,200);assert.equal(limited.width(6000,0),1);
 assert.match(limited.description(6000,0),/Rate limit observed/);
 // Metadata arriving from one peer must not undo the fallback group's 429.
 const mixed=new T.DeleteWindow();mixed.observe(undefined,undefined,0,0);mixed.observe(undefined,undefined,0,80);mixed.reserve(2);
 mixed.observe('late','5',1000,160);mixed.limited(5000);mixed.observe('late','5',1000,5100);assert.equal(mixed.width(5100,0),1);
});
test('bounded parallel deletion: explicit cooldown always keeps one in-flight request',async()=>{
 const r=await latencyScenario(T.MessageCleanup,{cooldown:200});assert.equal(r.peak,1);assert.equal(r.deleted.length,10);assert.ok(r.waits.every(ms=>ms>=200));
});
test('bounded parallel deletion: Stop settles all three in-flight results, issues no next group',async()=>{
 const r=await latencyScenario(T.MessageCleanup,{stopAtParallel:true});assert.equal(r.state.phase,'stopped');assert.equal(r.deleted.length,4);assert.equal(r.active,false);assert.deepEqual(r.widths,[1,3]);
});
test('bounded parallel deletion: one failure still counts the other in-flight successes before stopping',async()=>{
 const r=await latencyScenario(T.MessageCleanup,{failAtParallel:true});assert.equal(r.state.phase,'error');assert.equal(r.deleted.length,3);assert.equal(r.active,false);assert.deepEqual(r.widths,[1,3]);
});
test('bounded parallel deletion: global 429 retries initially serial after the complete server wait',async()=>{
 const r=await latencyScenario(T.MessageCleanup,{rateAtParallel:true});assert.equal(r.state.phase,'completed');assert.equal(r.deleted.length,10);assert.equal(r.widths[2],1);assert.ok(r.waits.some(ms=>ms>=3050));
 const retryStart=r.starts[4];assert.ok(retryStart>=r.starts[1]+3050);assert.equal(new Set(r.deleted).size,10);
});
function recentMessage(n,user=USER,ageDays=1){return{id:((BigInt(1_800_000_000_000-ageDays*86400000-1420070400000)<<22n)+BigInt(n)).toString(),channel_id:CHANNEL,author:{id:user},type:0};}
async function bulkScenario({limit=100,cooldown=0,denied=false,status=204,code,rate=false}={}){
 let now=1_800_000_000_000,calls=0;const singles=[],bulks=[],deleted=[],waits=[];
 const history=Array.from({length:80},(_,i)=>recentMessage(80-i,i%3===0?OTHER:USER));history.push(recentMessage(1,USER,20));
 const engine=new T.MessageCleanup({assertTarget(){},canBulk:()=>!denied,
  async request(method,channel,key){if(method==='get')return{status:200,body:history.filter(m=>BigInt(m.id)<BigInt(key)).slice(0,100)};singles.push(key);return{status:204};},
  async bulk(channel,ids){bulks.push([...ids]);if(rate&&++calls===1)return{status:429,body:{retry_after:5,global:true}};return{status,body:{code}};},deleted(channel,id){deleted.push(id);}},()=>{},()=>now,async(ms)=>{waits.push(ms);now+=ms;});
 await engine.run(target,limit,cooldown);return{engine,singles,bulks,deleted,history,waits};
}
test('bulk cleanup: only eligible own recent messages; old messages stay individual and last-10 never expands scope',async()=>{
 for(const limit of [10,100,null]){const r=await bulkScenario({limit});const expected=r.history.filter(m=>m.author.id===USER).slice(0,limit??Infinity).map(m=>m.id);
 assert.deepEqual(r.deleted,expected);assert.equal(r.bulks.length,1);assert.equal(r.bulks[0].length,limit===10?10:53);assert.equal(r.singles.length,limit===10?0:1);assert.equal(r.engine.snapshot().phase,'completed');}
});
test('bulk cleanup: missing permissions/cooldown disable bulk; rejected endpoint falls back once to own-message deletion',async()=>{
 for(const config of [{denied:true},{cooldown:20}]){const r=await bulkScenario(config);assert.equal(r.bulks.length,0);assert.equal(r.singles.length,54);assert.equal(r.engine.snapshot().phase,'completed');}
 for(const result of [{status:403},{status:404},{status:405},{status:400,code:20002},{status:400,code:50034}]){const r=await bulkScenario(result);assert.equal(r.bulks.length,1);assert.equal(r.singles.length,54);assert.equal(r.engine.snapshot().deleted,54);}
 const failure=await bulkScenario({status:500});assert.equal(failure.engine.snapshot().phase,'error');assert.equal(failure.deleted.length,0);assert.equal(failure.singles.length,0);
});
test('bulk cleanup: global rate limit waits and retries bulk, never switches endpoint to bypass it',async()=>{
 const r=await bulkScenario({rate:true});assert.equal(r.bulks.length,2);assert.deepEqual(r.waits,[5050]);assert.equal(r.singles.length,1);assert.equal(r.deleted.length,54);
});
test('native bulk adapter: fresh computed Manage Messages permission, exact IDs/body, no DM or lost-permission request',async()=>{
 const calls=[];let bits=8n;const c={id:CHANNEL,type:0,guild_id:OTHER};
 const rest={get(){},put(){},patch(){},del(){},async post(o){calls.push(o);return{status:204};}};
 globalThis.window={Syncord:{common:{stores:{UserStore:{getCurrentUser:()=>({id:USER})},ChannelStore:{getChannel:()=>c},PermissionStore:{can:()=>true,computePermissions:()=>bits}},utils:{RestAPI:rest}}}};
 const p=T.discordPort({warn(){}});assert.equal(p.canBulk(target),true);await p.bulk(CHANNEL,[id(2),id(1)]);assert.deepEqual(calls[0].body,{messages:[id(2),id(1)]});assert.equal(calls[0].url,`/channels/${CHANNEL}/messages/bulk-delete`);assert.equal(calls[0].retries,0);
 bits=(1n<<13n)|(1n<<10n)|(1n<<16n);assert.equal(p.canBulk(target),true);bits=0n;assert.equal(p.canBulk(target),false);assert.equal((await p.bulk(CHANNEL,[id(2),id(1)])).status,403);assert.equal(calls.length,1);
 bits=8n;delete c.guild_id;c.type=1;assert.equal(p.canBulk(target),false);await p.bulk(CHANNEL,[id(2),id(1)]);assert.equal(calls.length,1);
 assert.throws(()=>p.bulk(CHANNEL,[id(1)]));assert.throws(()=>p.bulk(CHANNEL,[id(1),id(1)]));assert.throws(()=>p.bulk(CHANNEL,['../',id(1)]));delete globalThis.window;
});

test('shared rate bucket: exhausted DELETE also pauses known GET in the same channel/bucket',async()=>{
 let page=0;
 const f=fixture([],{request:async method=>method==='get'?{status:200,body:page++?[]:[msg(1)],headers:{'x-ratelimit-bucket':'shared','x-ratelimit-remaining':'5','x-ratelimit-reset-after':'2'}}:{status:204,headers:{'x-ratelimit-bucket':'shared','x-ratelimit-remaining':'0','x-ratelimit-reset-after':'2'}}});
 await f.engine.run(target,null,0);assert.deepEqual(f.waits,[2050]);assert.equal(f.engine.snapshot().phase,'completed');
});
test('bounded parallel integration: quota exhaustion/out-of-order responses never overbook a server window',async()=>{
 let now=1_800_000_000_000,windowStart=now,used=0,done=false;const initial=now,pending=[],starts=[],widths=[];let rejected=0;
 const messages=Array.from({length:10},(_,i)=>msg(10-i));
 const engine=new T.MessageCleanup({assertTarget(){},deleted(){},async request(method,channel,key){
  if(method==='get')return{status:200,body:messages.filter(m=>BigInt(m.id)<BigInt(key)).slice(0,100)};
  if(now>=windowStart+1000){windowStart=now;used=0;}used++;starts.push(now);
  if(used>4){rejected++;return{status:429,body:{retry_after:1}};}
  const left=4-used,end=windowStart+1000;
  return new Promise(resolve=>pending.push(()=>resolve({status:204,headers:{'x-ratelimit-bucket':'known','x-ratelimit-remaining':String(left),'x-ratelimit-reset-after':String((end-now)/1000)}})));
 }},()=>{},()=>now,async(ms)=>{now+=ms;});
 const run=engine.run(target,10,0).then(()=>{done=true;});
 for(let t=0;t<100&&!done;t++){for(let j=0;j<30;j++)await Promise.resolve();if(pending.length){const group=pending.splice(0);widths.push(group.length);now+=80;for(const resolve of group.reverse())resolve();}}
 await run;assert.equal(engine.snapshot().deleted,10);assert.equal(rejected,0);assert.deepEqual(widths,[1,2,1,1,2,1,1,1]);
 for(let i=0;i<3;i++)assert.ok(starts.filter(s=>s>=initial+i*1000&&s<initial+(i+1)*1000).length<=4);
 assert.equal(now-initial,2260);
});

test('bulk fallback stays disabled across history pages and bulk IDs are counted separately',async()=>{
 const history=Array.from({length:205},(_,i)=>recentMessage(205-i));let bulks=0,singles=0;
 const e=new T.MessageCleanup({assertTarget(){},canBulk:()=>true,deleted(){},async bulk(){bulks++;return{status:400,body:{code:20002}};},async request(method,channel,before){if(method==='get')return{status:200,body:history.filter(m=>BigInt(m.id)<BigInt(before)).slice(0,100)};singles++;return{status:204};}},()=>{},()=>1800000000000);
 await e.run(target,null,0);assert.equal(e.snapshot().phase,'completed');assert.equal(bulks,1);assert.equal(singles,205);assert.equal(e.snapshot().bulkProcessed,0);
 const accepted=await bulkScenario({limit:10});assert.equal(accepted.engine.snapshot().bulkProcessed,10);assert.equal(accepted.engine.snapshot().deleted,10);
});

test('real metrics: measured elapsed time, overlapping requests, averaged API duration and frozen completion',()=>{
 let now=1000;const m=new T.CleanupMeter(()=>now);const first=m.request();now=1100;const second=m.request();now=1300;first();now=1400;second();
 const r=m.snapshot(2);assert.equal(r.elapsedMs,400);assert.equal(r.messagesPerSecond,5);assert.equal(r.requests,2);assert.equal(r.peakConcurrency,2);assert.equal(r.averageRequestMs,300);
 m.finish();now=10000;assert.equal(m.snapshot(2).elapsedMs,400);assert.equal(m.snapshot(2).messagesPerSecond,5);
});
test('real metrics: overlapping waits are unioned and rate/cooldown portions never counted twice',()=>{
 let now=1000;const m=new T.CleanupMeter(()=>now);const a=m.wait(2000,1500);now=1200;const b=m.wait(2200,1600);now=1700;
 assert.equal(m.snapshot(0).rateWaitMs,600);assert.equal(m.snapshot(0).cooldownWaitMs,100);
 now=2000;a();now=2200;b();m.limited();const r=m.snapshot(0);assert.equal(r.rateWaitMs,600);assert.equal(r.cooldownWaitMs,600);assert.equal(r.rateLimitResponses,1);assert.equal(r.elapsedMs,1200);
});
test('real metrics: engine includes requested cooldown and server waits but excludes bulk IDs from deletion speed',async()=>{
 const slow=await latencyScenario(T.MessageCleanup,{cooldown:200});const metrics=slow.state.metrics;
 assert.equal(metrics.elapsedMs,slow.elapsed);assert.equal(metrics.cooldownWaitMs,1800);assert.equal(metrics.rateWaitMs,0);assert.equal(metrics.peakConcurrency,1);assert.equal(metrics.messagesPerSecond,10000/slow.elapsed);
 const limited=await latencyScenario(T.MessageCleanup,{rateAtParallel:true});assert.equal(limited.state.metrics.rateLimitResponses,1);assert.ok(limited.state.metrics.rateWaitMs>=3050);assert.equal(limited.state.metrics.peakConcurrency,3);
 const grouped=await bulkScenario({limit:10});assert.equal(grouped.engine.snapshot().metrics.messagesPerSecond,0);
});
test('real metrics: API serial reason is explained when metadata is missing or buckets change',()=>{
 const w=new T.DeleteWindow();w.observe(undefined,undefined,0,0);assert.match(w.description(0,0),/metadata unavailable/);
 w.observe('a','5',1000,0);assert.match(w.description(0,0),/Adaptive/);w.observe('b','5',1000,1);assert.match(w.description(1,0),/bucket changed/);assert.match(w.description(1,200),/custom cooldown/);
});

test('recovery: the reported missing retry time after 38 deletes waits then completes the same 100-message job',async()=>{
 let requests=0,limited=false;
 const history=Array.from({length:100},(_,i)=>msg(100-i));let f;
 f=fixture(history,{request:async(method,channel,before)=>{
  if(method==='get')return{status:200,body:history.filter(m=>BigInt(m.id)<BigInt(before))};
  if([39,40].includes(++requests)){limited=true;return{status:429,body:'error code: 1015'};}
  return{status:204};
 },changed:s=>{if(s.phase==='waiting'&&s.detail.includes('resume automatically'))assert.equal(s.deleted,38);}});
 await f.engine.run(target,100,0);
 assert.equal(limited,true);assert.equal(f.engine.snapshot().phase,'completed');assert.equal(f.engine.snapshot().deleted,100);
 assert.equal(f.engine.snapshot().scanned,100);assert.equal(new Set(f.deleted.map(m=>m[1])).size,100);assert.equal(f.waits[0],5050);assert.ok(f.engine.snapshot().metrics.pacingWaitMs>0);
 assert.equal(f.calls.filter(c=>c.method==='get').length,1);assert.equal(requests,102);assert.equal(f.engine.snapshot().metrics.rateLimitResponses,2);
 assert.ok(f.states.some(s=>s.phase==='waiting'&&s.detail.includes('resume automatically')));
});
test('recovery: read, individual DELETE and bulk keep retrying past five 429s with bounded exponential waits',async()=>{
 for(const route of ['get','del','bulk']){
  let attempts=0,reads=0;const waits=[],deleted=[];let now=1_800_000_000_000;
  const limited=()=>++attempts<=7?{status:429,body:'temporarily rate limited'}:{status:route==='get'?200:204,body:route==='get'?(reads++?[]:[msg(1)]):undefined};
  const e=new T.MessageCleanup({assertTarget(){},canBulk:()=>route==='bulk',
   request:async method=>method===route?limited():method==='get'?{status:200,body:reads++?[]:route==='bulk'?[recentMessage(2),recentMessage(1)]:[msg(1)]}:{status:204},
   bulk:async()=>limited(),deleted:(c,id)=>deleted.push(id)},()=>{},()=>now,async ms=>{waits.push(ms);now+=ms;});
  await e.run(target,10,0);
  assert.equal(e.snapshot().phase,'completed',route);assert.deepEqual(waits,[5050,10050,20050,40050,80050,160050,300050],route);
  assert.equal(e.snapshot().metrics.rateLimitResponses,7);assert.equal(e.snapshot().deleted,route==='bulk'?2:1);
 }
});
test('recovery: native retryAfter, JSON text and reset headers supply retry metadata without losing full deadlines',async()=>{
 const cases=[
  {error:{status:429,retryAfter:1.25},expected:1300},
  {error:{response:{status:429,retryAfter:2.5}},expected:2550},
  {error:{status:429,text:'{"retry_after":1.75,"global":true}'},expected:1800},
  {reply:{status:429,body:'{"retry_after":2.25}'},expected:2300},
  {reply:{status:429,headers:{'x-ratelimit-reset-after':'3.25'}},expected:3300},
  {reply:{status:429,retryAfter:2,body:{retry_after:3},headers:{'Retry-After':'4'}},expected:4050},
 ];
 for(const c of cases){let reads=0,attempts=0;const f=fixture([],{request:async method=>{
  if(method==='get')return{status:200,body:reads++?[]:[msg(1)]};
  if(++attempts===1){if(c.error)throw c.error;return c.reply;}return{status:204};
 }});await f.engine.run(target,10,0);assert.equal(f.engine.snapshot().phase,'completed');assert.deepEqual(f.waits,[c.expected]);assert.equal(f.deleted.length,1);}
 for(const v of [Infinity,NaN,-1,'invalid',1e308])assert.equal(T.retryDelay({retryAfter:v}),0);
});
test('recovery: missing-metadata wait is cancellable and survives Stop/Start without reissuing requests early',async()=>{
 let f,stopped=false,attempts=0,page=0;
 f=fixture([],{request:async method=>method==='get'?{status:200,body:page++%2?[]:[msg(1)]}:++attempts===1?{status:429}:{status:204},
  changed:s=>{if(s.phase==='waiting'&&!stopped){stopped=true;f.engine.stop();}}});
 await f.engine.run(target,10,0);assert.equal(f.engine.snapshot().phase,'stopped');assert.equal(attempts,1);page=0;
 await f.engine.run(target,10,0);assert.equal(f.engine.snapshot().phase,'completed');assert.equal(f.deleted.length,1);assert.ok(f.waits[0]>=5050);
});
test('pacing metrics: automatic spacing stays separate from custom cooldown and server waits',()=>{
 let now=1000;const m=new T.CleanupMeter(()=>now);const auto=m.wait(1500,0,0);now=1500;auto();const custom=m.wait(1800,0,1800);now=1800;custom();
 const rate=m.wait(2300,2200,2000);now=2300;rate();const s=m.snapshot(0);assert.equal(s.pacingWaitMs,600);assert.equal(s.cooldownWaitMs,300);assert.equal(s.rateWaitMs,400);
});


test('pacing: 540ms latency model keeps over 97% of prior unknown-quota throughput and spaces each overlap',async()=>{
 const r=await latencyScenario(T.MessageCleanup,{headers:false,rtt:540});
 const previousElapsed=6*540;
 assert.equal(r.state.phase,'completed');assert.equal(r.deleted.length,10);assert.equal(r.peak,2);assert.equal(r.elapsed,3320);
 assert.ok(previousElapsed/r.elapsed>0.97);assert.equal(r.state.metrics.rateLimitResponses,0);
 for(let i=2;i<r.starts.length;i+=2)assert.ok(r.starts[i+1]-r.starts[i]>=20);
 assert.ok(r.state.metrics.pacingWaitMs>0);assert.equal(r.state.metrics.cooldownWaitMs,0);
});
test('recovery: an account change during missing-metadata waiting prevents another deletion',async()=>{
 let attempts=0,reads=0,f;
 f=fixture([],{request:async method=>method==='get'?{status:200,body:reads++?[]:[msg(1)]}:(attempts++,{status:429}),sleep:async()=>f.account(OTHER)});
 await f.engine.run(target,10,0);assert.equal(attempts,1);assert.equal(f.deleted.length,0);assert.equal(f.engine.snapshot().phase,'error');assert.match(f.engine.snapshot().detail,/Account changed/);
});

test('feedback: retry zero is a short grace, available bucket budget never becomes a false long retry',()=>{
 assert.deepEqual(T.recoveryWait({status:429,body:{retry_after:0}},1,1000),{delay:550,source:'Discord zero-second retry grace'});
 assert.equal(T.recoveryWait({status:429,retryAfter:'0'},2,1000).delay,1050);
 assert.equal(T.recoveryWait({status:429,body:{retry_after:0},headers:{'x-ratelimit-remaining':'9','x-ratelimit-reset-after':'120'}},1,1000).delay,550);
 assert.equal(T.recoveryWait({status:429,body:{retry_after:1.5},headers:{'x-ratelimit-remaining':'9','x-ratelimit-reset-after':'120'}},1,1000).delay,1550);
 assert.equal(T.recoveryWait({status:429,body:{retry_after:1.5},headers:{'x-ratelimit-remaining':'0','x-ratelimit-reset-after':'120'}},1,1000).delay,120050);
 assert.equal(T.recoveryWait({status:429,headers:{'retry-after':'52576'}},16,1000).delay,52576050);
 assert.equal(T.recoveryWait({status:429},16,1000).delay,300050);
});
test('feedback: start interval exceeds observed RTT after throttling, does not multiply one parallel rejection, and survives restarts',()=>{
 const p=new T.DeletePacer();p.begin('account/channel');p.started(10000,20);p.completed(540,true,10540);p.limited(10000,16000,10540);
 assert.equal(p.interval(),810);assert.equal(p.until(),10810);
 p.limited(10010,16020,10550);assert.equal(p.interval(),810);
 p.begin('other/channel');assert.equal(p.interval(),0);p.begin('account/channel');assert.equal(p.interval(),810);
 p.started(16020,20);p.limited(16020,22000,16560);assert.equal(p.interval(),810,'a retry without acknowledged work does not compound the interval');
 for(let i=0;i<200;i++)p.completed(540,true,50000+i*1000,{rateWaitMs:0,pacingWaitMs:(i+1)*400});
 assert.equal(p.interval(),540);
 for(let i=0;i<8;i++)p.begin('fresh/'+i);p.begin('account/channel');assert.equal(p.interval(),0);
});

// A virtual clock advances only when an actual simulated HTTP/timer event is
// due. This exercises sustained quota pressure, not just latency with spare quota.
async function constrainedScenario({Engine=T.MessageCleanup,changeQuota=false,shortRetries=false,firstLimit=100}={}){
 let now=1_800_000_000_000,start=now,tokens=2,lastRefill=now,successes=0,done=false,failure;
 const events=[],attempts=[],deleted=[],states=[];const count=shortRetries?60:100;const history=Array.from({length:count},(_,i)=>msg(count-i));
 const schedule=(delay,signal)=>new Promise((resolve,reject)=>{
  const event={at:Math.ceil(now+delay),run(){signal?.removeEventListener('abort',abort);resolve();}};
  const abort=()=>{const at=events.indexOf(event);if(at>=0)events.splice(at,1);signal?.removeEventListener('abort',abort);reject(new DOMException('Stopped','AbortError'));};
  if(signal?.aborted){abort();return;}events.push(event);signal?.addEventListener('abort',abort,{once:true});
 });
 const e=new Engine({assertTarget(){},deleted(c,id){deleted.push(id);},async request(method,channel,before){
  if(method==='get')return{status:200,body:history.filter(m=>!deleted.includes(m.id)&&BigInt(m.id)<BigInt(before)).slice(0,100)};
  const quota=changeQuota&&successes>=35 ? 0.75 : 1.5;
  tokens=Math.min(2,tokens+(now-lastRefill)*quota/1000);lastRefill=now;
  const forced=shortRetries?new Map([[5,1],[15,1],[25,2],[35,2]]).get(attempts.length+1):undefined;
  const accepted=shortRetries?forced===undefined:tokens>=1;if(accepted){tokens--;successes++;}
  attempts.push({at:now,accepted,beforeSuccess:successes});
  await schedule(shortRetries?447:accepted?540:80);
  return accepted?{status:204}:{status:429,body:{global:false,...(forced!==undefined?{retry_after:forced}:{})}};
 }},s=>states.push(s),()=>now,schedule);
 const drive=async promise=>{
  done=false;promise.then(()=>done=true,error=>{failure=error;done=true;});
  for(let turn=0;turn<15000&&!done;turn++){
   for(let j=0;j<40;j++)await Promise.resolve();
   if(done)break;
   events.sort((a,b)=>a.at-b.at);const event=events.shift();if(!event)throw new Error('Cleanup is stuck without a request or timer');
   now=Math.max(now,event.at);event.run();
  }
  assert.equal(done,true,'bounded simulated completion');if(failure)throw failure;
 };
 await drive(e.run(target,firstLimit,0));
 const firstElapsed=now-start,firstInterval=e.snapshot().automaticIntervalMs,firstAttempts=attempts.length;
 const firstState=e.snapshot();
 // The same account/channel keeps its learned pace in another explicit job.
 history.push(...Array.from({length:10},(_,i)=>msg(110-i)));await drive(e.run(target,10,0));
 return{e,firstElapsed,firstInterval,firstAttempts,firstState,attempts,deleted,states,events};
}
test('feedback integration: sustained missing-header quota converges instead of repeating fast-send/backoff cycles',async()=>{
 const r=await constrainedScenario();
 assert.equal(r.firstState.phase,'completed');assert.equal(r.firstState.deleted,100);assert.equal(new Set(r.deleted).size,110);
 assert.ok(r.firstState.metrics.rateLimitResponses<=4,JSON.stringify(r.firstState.metrics));
 assert.ok(r.firstElapsed<100000,`simulated elapsed ${r.firstElapsed}`);
 assert.ok(r.firstInterval>=540,'actual launch spacing can exceed RTT');
 const corrections=r.attempts.filter(a=>a.beforeSuccess>=50&&!a.accepted);
 assert.ok(corrections.length<=2,'bounded corrections while reclaiming excess pacing');
 assert.equal(r.events.length,0);assert.ok(r.firstState.metrics.pacingWaitMs>0);
});
test('feedback integration: a lower quota mid-job is learned without resetting the target, counts or pacing on restart',async()=>{
 const r=await constrainedScenario({changeQuota:true});
 assert.equal(r.firstState.phase,'completed');assert.equal(r.firstState.deleted,100);assert.equal(new Set(r.deleted).size,110);
 assert.ok(r.firstState.metrics.rateLimitResponses<=8,JSON.stringify(r.firstState.metrics));
 const corrections=r.attempts.filter(a=>a.beforeSuccess>=70&&!a.accepted);
 assert.ok(corrections.length<=2,'lower quota remains stable while testing faster pacing');
 assert.ok(r.firstInterval>=1000);assert.equal(r.events.length,0);
});

test('feedback: Stop cancels a learned-interval wait and sends no next deletion',async()=>{
 let attempts=0,reads=0,stopped=false,f;
 f=fixture([],{request:async method=>method==='get'?{status:200,body:reads++?[]:[msg(3),msg(2),msg(1)]}:++attempts===1?{status:429,body:{global:false}}:{status:204},
  changed:s=>{if(s.phase==='waiting'&&s.detail.startsWith('Pacing')&&!stopped){stopped=true;f.engine.stop();}}});
 await f.engine.run(target,10,0);assert.equal(stopped,true);assert.equal(attempts,2);assert.equal(f.deleted.length,1);assert.equal(f.engine.snapshot().phase,'stopped');assert.equal(f.engine.active(),false);
});


test('cost pacing: four short retries do not leave the screenshot’s permanent two-second artificial interval',async()=>{
 const r=await constrainedScenario({shortRetries:true,firstLimit:null});
 assert.equal(r.firstState.phase,'completed');assert.equal(r.firstState.deleted,60);assert.equal(r.firstState.metrics.rateLimitResponses,4);
 assert.equal(new Set(r.deleted).size,70);assert.ok(r.firstState.metrics.rateWaitMs>=6000&&r.firstState.metrics.rateWaitMs<=6200);
 assert.ok(r.firstState.metrics.pacingWaitMs<20000,JSON.stringify(r.firstState.metrics));
 assert.ok(r.firstElapsed<55000,`simulated elapsed ${r.firstElapsed}`);
 assert.ok(r.firstInterval<1000,`permanent slowdown remains: ${r.firstInterval}`);assert.equal(r.events.length,0);
});
test('cost pacing: recent expensive rate waits hold recovery, then measured pacing cost can recover below the former 85% floor',()=>{
 const p=new T.DeletePacer();p.begin('account/channel');p.started(10000,0);p.completed(447,true,10447);p.limited(10000,12497,10447);
 const interval=p.interval();
 for(let i=1;i<=8;i++)p.completed(447,true,15000+i*1000,{rateWaitMs:10000,pacingWaitMs:i*200});
 assert.equal(p.interval(),interval,'recent server penalty is not immediately forgotten');
 for(let i=9;i<=100;i++)p.completed(447,true,15000+i*1000,{rateWaitMs:10000,pacingWaitMs:i*700});
 assert.ok(p.interval()<interval*.85,'no permanent percentage floor');assert.ok(p.interval()>=447,'no synthetic overlap recovery');
 p.begin('account/channel');assert.ok(p.interval()<interval*.85,'restart preserves the recovered pace');
});


test('cost pacing: repeated blocked retries without a successful deletion never compound the per-message interval',()=>{
 const p=new T.DeletePacer();p.begin('account/channel');p.started(10000,0);p.completed(447,true,10447,{rateWaitMs:0,pacingWaitMs:0});p.limited(10000,12497,10447);
 const initial=p.interval();
 for(let i=0;i<4;i++){const at=13000+i*3000;p.started(at,20);p.completed(447,false,at+447);p.limited(at,at+2497,at+447);}
 assert.equal(p.interval(),initial);assert.ok(initial<1000);
});

// Virtual clock advances only at real HTTP completions or cancellable launch deadlines.
async function steadyScenario({count=60,cooldown=0,latency=i=>[540,1500,250][(i-1)%3],reply=()=>({status:204}),onState=()=>{},onDeleted=()=>{}}={}){
 let now=1_800_000_000_000,done=false,failure,active=0,peak=0,engine;
 const events=[],attempts=[],confirmed=[],states=[];
 const history=Array.from({length:count},(_,i)=>msg(count-i));
 const schedule=(delay,signal)=>new Promise((resolve,reject)=>{
  const event={at:Math.ceil(now+delay),run(){signal?.removeEventListener('abort',abort);resolve();}};
  const abort=()=>{const at=events.indexOf(event);if(at>=0)events.splice(at,1);signal?.removeEventListener('abort',abort);reject(new DOMException('Stopped','AbortError'));};
  if(signal?.aborted){abort();return;}events.push(event);signal?.addEventListener('abort',abort,{once:true});
 });
 engine=new T.MessageCleanup({assertTarget(){},deleted(channel,key){
  assert.ok(attempts.some(a=>a.id===key&&a.completed<=now&&a.status===204),'cache deletion follows actual acknowledgement');
  confirmed.push({id:key,at:now});onDeleted(engine,confirmed);
 },async request(method,channel,key){
  if(method==='get')return{status:200,body:history.filter(m=>BigInt(m.id)<BigInt(key)).slice(0,100)};
  const attempt={id:key,at:now,index:attempts.length+1};attempts.push(attempt);active++;peak=Math.max(peak,active);
  const response=reply(attempt,attempts);await schedule(latency(attempt.index));active--;
  attempt.completed=now;attempt.status=response.status;return response;
 }},s=>{states.push(s);onState(engine,s);},()=>now,schedule);
 const start=now;const running=engine.run(target,null,cooldown,'steady');running.then(()=>done=true,e=>{failure=e;done=true;});
 for(let turn=0;turn<20000&&!done;turn++){
  for(let flush=0;flush<50;flush++)await Promise.resolve();
  if(done)break;events.sort((a,b)=>a.at-b.at);const event=events.shift();assert.ok(event,'no stranded work');now=Math.max(now,event.at);event.run();
 }
 assert.equal(done,true,'bounded completion');if(failure)throw failure;await running;
 return{engine,state:engine.snapshot(),attempts,confirmed,peak,events,elapsed:now-start};
}
test('steady: sustained 1.4/s target uses a rolling queue despite variable response latency',async()=>{
 const r=await steadyScenario();assert.equal(r.state.phase,'completed');assert.equal(r.confirmed.length,60);assert.equal(new Set(r.confirmed.map(m=>m.id)).size,60);
 assert.equal(r.state.mode,'steady');assert.equal(r.peak,2);assert.equal(r.events.length,0);assert.equal(r.state.metrics.rateLimitResponses,0);
 const gaps=r.attempts.slice(1).map((a,i)=>a.at-r.attempts[i].at);
 assert.ok(gaps.every(ms=>ms>=T.STEADY_INTERVAL_MS&&ms<=T.STEADY_INTERVAL_MS+1),JSON.stringify(gaps));
 assert.ok(r.attempts[3].at<r.attempts[1].completed,'refill after a fast request, without waiting for its slow peer');
 assert.ok(r.state.metrics.messagesPerSecond>1.3&&r.state.metrics.messagesPerSecond<=1.45,JSON.stringify(r.state.metrics));
 assert.ok(r.state.metrics.recentMessagesPerSecond>=1.3);assert.equal(r.state.automaticIntervalMs,T.STEADY_INTERVAL_MS);
});
test('steady: rate limit invalidates queued launches, drains in-flight work and retries one probe after the full deadline',async()=>{
 const r=await steadyScenario({count:20,latency:()=>540,reply:a=>a.index===4?{status:429,body:{retry_after:2,global:false}}:{status:204}});
 assert.equal(r.state.phase,'completed');assert.equal(r.confirmed.length,20);assert.equal(r.attempts.length,21);assert.equal(r.state.metrics.rateLimitResponses,1);
 const rejected=r.attempts[3],probe=r.attempts[4];assert.equal(probe.id,rejected.id);
 assert.ok(probe.at>=rejected.completed+2050,'full mandatory retry');
 assert.ok(r.attempts[5].at>=probe.completed,'one fresh acknowledged probe before overlap');
 assert.equal(r.state.automaticIntervalMs,T.STEADY_INTERVAL_MS,'no permanent penalty added to the selected target');assert.equal(r.events.length,0);
});
test('steady: positive cooldown is sequential and starts only after the previous response plus cooldown',async()=>{
 const r=await steadyScenario({count:10,cooldown:1000,latency:()=>540});assert.equal(r.peak,1);assert.equal(r.confirmed.length,10);
 for(let i=1;i<r.attempts.length;i++)assert.ok(r.attempts[i].at>=r.attempts[i-1].completed+1000);
});
test('steady: Stop drains confirmed responses but cancels future paced launches',async()=>{
 let stopped=false;const r=await steadyScenario({count:30,onDeleted:(e,list)=>{if(list.length===5){stopped=true;e.stop();}}});
 assert.equal(stopped,true);assert.equal(r.state.phase,'stopped');assert.ok(r.confirmed.length>=5&&r.confirmed.length<=6);assert.equal(r.attempts.length,r.confirmed.length);
 assert.equal(r.state.deleted,r.confirmed.length);assert.equal(r.engine.active(),false);assert.equal(r.events.length,0);
});
test('steady: access failures drain in-flight responses without launching the rest of the page',async()=>{
 const r=await steadyScenario({count:30,reply:a=>a.index===4?{status:403}:{status:204}});
 assert.equal(r.state.phase,'error');assert.ok(r.attempts.length<=5);assert.equal(r.state.deleted,r.confirmed.length);assert.equal(r.events.length,0);assert.equal(r.engine.active(),false);
});
test('real metrics: last completed ten-second window is measured separately, includes idle windows and freezes at completion',()=>{
 let now=1000;const meter=new T.CleanupMeter(()=>now);
 for(let i=0;i<14;i++){now=1000+i*700;meter.confirmed();}
 assert.equal(meter.snapshot(14).recentMessagesPerSecond,undefined);
 now=11000;assert.equal(meter.snapshot(14).recentMessagesPerSecond,1.4);
 meter.confirmed();now=21000;assert.equal(meter.snapshot(15).recentMessagesPerSecond,.1);
 now=41000;assert.equal(meter.snapshot(15).recentMessagesPerSecond,0,'empty windows are not hidden');
 meter.finish();now=80000;assert.equal(meter.snapshot(15).elapsedMs,40000);assert.equal(meter.snapshot(15).messagesPerSecond,.375);
});
test('steady: invalid speed mode fails before reading or deleting',async()=>{
 const f=fixture();await assert.rejects(f.engine.run(target,10,0,'turbo'));assert.equal(f.calls.length,0);
});

test('steady: exhausted quota is honored even when another launch was already waiting for its start time',async()=>{
 const r=await steadyScenario({count:12,latency:()=>540,reply:a=>a.index===3?{status:204,headers:{'x-ratelimit-bucket':'delete','x-ratelimit-remaining':'0','x-ratelimit-reset-after':'3'}}:{status:204}});
 assert.equal(r.state.phase,'completed');assert.equal(r.confirmed.length,12);
 assert.ok(r.attempts[3].at>=r.attempts[2].completed+3050);assert.ok(r.state.metrics.rateWaitMs>=3049,JSON.stringify(r.state.metrics));
});
test('steady: missing retry metadata waits automatically and Stop cancels recovery without another request',async()=>{
 let stopped=false;const r=await steadyScenario({count:12,reply:()=>({status:429}),onState:(e,s)=>{if(s.phase==='waiting'&&s.detail.includes('resume automatically')){stopped=true;e.stop();}}});
 assert.equal(stopped,true);assert.equal(r.state.phase,'stopped');assert.equal(r.attempts.length,1);assert.equal(r.state.deleted,0);assert.equal(r.events.length,0);
});
test('steady: own-author last-N selection, account guard and no optimistic deletion remain enforced',async()=>{
 const history=Array.from({length:150},(_,i)=>msg(150-i,i%8===0?USER:OTHER));const f=fixture(history);
 await f.engine.run(target,10,0,'steady');assert.equal(f.engine.snapshot().phase,'completed');
 assert.deepEqual(f.deleted.map(m=>m[1]),history.filter(m=>m.author.id===USER).slice(0,10).map(m=>m.id));
 let g;g=fixture([msg(3),msg(2),msg(1)],{deleted:()=>g.account(OTHER)});await g.engine.run(target,10,0,'steady');
 assert.equal(g.deleted.length,1);assert.equal(g.engine.snapshot().phase,'error');
});
