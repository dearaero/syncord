import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(path.join(tmpdir(),'syncord-shared-events-'));
const out=path.join(dir,'bundle.mjs');
await build({stdin:{resolveDir:process.cwd(),loader:'ts',contents:`export * from './src/renderer/api/discordEvents/hub';export * from './src/renderer/api/discordEvents/coverage';export * from './src/renderer/api/patcher';export * from './src/renderer/plugins/messageLogger/recent';`},bundle:true,platform:'neutral',format:'esm',outfile:out,logLevel:'warning'});
const {EventHub,GuildCoverage,instead,RecentMessages}=await import(pathToFileURL(out).href);rmSync(dir,{recursive:true,force:true});
const U='1425993161108357191',V='1425993161108357192',G='1425993161108357193',H='1425993161108357194';
function fixture(guilds=[G,H]) {
 const jobs=new Map(),sent=[],errors=[];let next=0;
 const deps={guildIds:()=>guilds,retainedGuilds:()=>new Set([G]),nativeFeatures:id=>({typing:id===G,activities:id===G,threads:id===G}),
   dispatch:action=>sent.push(structuredClone(action)),set:fn=>{const id=++next;jobs.set(id,fn);return id;},clear:id=>jobs.delete(id),report:err=>errors.push(err),changed(){}};
 const coverage=new GuildCoverage(deps);
 const flush=()=>{for(const [id,fn] of [...jobs]){jobs.delete(id);fn();}};
 return {coverage,deps,jobs,sent,errors,flush};
}
test('event hub: one native dispatch, before-store delete preservation and after-store observers',()=>{
 const order=[],hub=new EventHub(err=>{throw err;}),flux={dispatch(action){order.push('native:'+action.type);return 7;}},original=flux.dispatch;
 hub.attach(flux,()=>order.push('before'),()=>order.push('after'));
 const wrapped=flux.dispatch;assert.equal(hub.attach(flux,()=>{},()=>{}),true);assert.equal(flux.dispatch,wrapped);
 const undo=hub.intercept((action,next)=>{order.push('logger');return next(action);});
 const stop=hub.listen('MESSAGE_DELETE',()=>order.push('activity'));
 assert.equal(flux.dispatch({type:'MESSAGE_DELETE'}),7);assert.deepEqual(order,['before','logger','native:MESSAGE_DELETE','activity','after']);
 undo();stop();hub.detach();assert.equal(flux.dispatch,original);assert.deepEqual(hub.counts(),{listeners:0,interceptors:0,attached:false});
});
test('event hub: failing consumers cannot duplicate or cancel Discord dispatch; native errors are preserved',()=>{
 for(const failAfter of [true,false]){
  let calls=0;const errors=[],hub=new EventHub(err=>errors.push(err)),flux={dispatch(){calls++;return 3;}};
  hub.attach(flux,()=>{},()=>{});hub.intercept((action,next)=>{if(failAfter)next(action);throw new Error('plugin');});
  hub.listen('X',()=>{throw new Error('listener');});assert.equal(flux.dispatch({type:'X'}),3);assert.equal(calls,1);assert.equal(errors.length,2);
 }
 const error=new Error('native'),hub=new EventHub(()=>{}),flux={dispatch(){throw error;}};
 hub.attach(flux,()=>{},()=>{});hub.intercept((action,next)=>next(action));assert.throws(()=>flux.dispatch({type:'X'}),err=>err===error);
});
test('coverage: two plugins share one debounced guild update and selected-member lease',()=>{
 const f=fixture(),a=f.coverage.acquire({typing:true,activities:true,userIds:[U]}),b=f.coverage.acquire({threads:true,userIds:[U]});
 assert.equal(f.jobs.size,1);f.flush();assert.equal(f.coverage.status().consumers,2);assert.equal(f.coverage.status().guilds,2);
 assert.equal(f.sent.filter(e=>e.type==='GUILD_SUBSCRIPTIONS_FLUSH').length,1);
 assert.equal(f.sent.filter(e=>e.type==='GUILD_SUBSCRIPTIONS_MEMBERS_ADD').length,2);
 a.update({typing:true,activities:true,userIds:[U]});f.flush();assert.equal(f.sent.filter(e=>e.type==='GUILD_SUBSCRIPTIONS_FLUSH').length,1);
 a.release();f.flush();assert.equal(f.coverage.status().members,2);b.release();assert.equal(f.coverage.status().members,0);assert.equal(f.jobs.size,0);
 const restore=f.sent.filter(e=>e.type==='GUILD_SUBSCRIPTIONS_FLUSH').at(-1).subscriptions;
 assert.deepEqual(restore[G],{typing:true,activities:true,threads:true});assert.deepEqual(restore[H],{typing:false,activities:false,threads:false});
});
test('coverage: native member ranges and other users survive an idle unsubscribe flush',()=>{
 const f=fixture(),lease=f.coverage.acquire({typing:true,activities:true,userIds:[U]});f.flush();
 const original={typing:false,activities:false,threads:true,channels:{c:[[0,99],[200,299]]},members:[V],member_updates:true,thread_member_lists:['t']};
 const action={type:'GUILD_SUBSCRIPTIONS_FLUSH',subscriptions:{[H]:original}};f.coverage.before(action);
 assert.deepEqual(action.subscriptions[H],{...original,typing:true,activities:true,members:[V,U]});assert.deepEqual(original.members,[V]);
 lease.release();const restore=f.sent.filter(e=>e.type==='GUILD_SUBSCRIPTIONS_FLUSH').at(-1).subscriptions[H];
 assert.deepEqual(restore,{typing:false,activities:false,threads:true});assert.equal('channels' in restore,false);
});
test('coverage: idle/reconnect/join/leave restore unopened guilds without leaking selected-guild member refs',()=>{
 const f=fixture(),lease=f.coverage.acquire({typing:true,userIds:[U]});f.flush();
 f.coverage.after({type:'IDLE',idle:true});f.flush();
 assert.equal(f.sent.filter(e=>e.type==='GUILD_SUBSCRIPTIONS_MEMBERS_ADD'&&e.guildId===G).length,1);
 assert.equal(f.sent.filter(e=>e.type==='GUILD_SUBSCRIPTIONS_MEMBERS_ADD'&&e.guildId===H).length,2);
 f.coverage.after({type:'CONNECTION_CLOSED'});assert.equal(f.jobs.size,0);
 f.coverage.after({type:'CONNECTION_RESUMED'});f.flush();assert.equal(f.coverage.status().guilds,2);
 f.deps.guildIds=()=>[G];f.coverage.after({type:'GUILD_DELETE',guild:{id:H}});f.flush();assert.equal(f.coverage.status().guilds,1);
 f.coverage.after({type:'CONNECTION_CLOSED'});lease.release();assert.equal(f.coverage.status().members,0);assert.equal(f.jobs.size,0);
});
test('coverage: 200 guild startup is bounded, uses native batches, does not subscribe member lists or fetch history',()=>{
 const f=fixture(Array.from({length:200},(_,i)=>String(1425993161108357100n+BigInt(i)))),lease=f.coverage.acquire({threads:true});f.flush();
 const batches=f.sent.filter(e=>e.type==='GUILD_SUBSCRIPTIONS_FLUSH');assert.equal(batches.length,8);
 for(const batch of batches)for(const value of Object.values(batch.subscriptions))assert.deepEqual(Object.keys(value).sort(),['activities','threads','typing']);
 assert.equal(f.jobs.size,0);lease.release();assert.equal(f.coverage.status().guilds,0);
});

test('event hub: shared hook survives Hide Typing toggles in both installation orders',()=>{
 for(const early of [true,false]) {
  let native=0,observed=0;const flux={dispatch(){native++;}},original=flux.dispatch,hub=new EventHub(()=>{});
  const patch=()=>instead(flux,'dispatch',(args,next)=>args[0].type==='LOCAL_TYPING'?undefined:next(...args));
  let undo=early?patch():undefined;hub.attach(flux,()=>{},()=>{});
  if(!early)undo=patch();const off=hub.listen('MESSAGE_CREATE',()=>observed++);
  flux.dispatch({type:'MESSAGE_CREATE'});flux.dispatch({type:'LOCAL_TYPING'});assert.equal(native,1);assert.equal(observed,1);
  undo();flux.dispatch({type:'MESSAGE_CREATE'});assert.equal(observed,2);
  undo=patch();off();hub.detach();flux.dispatch({type:'LOCAL_TYPING'});assert.equal(native,2);
  undo();assert.equal(flux.dispatch,original);
 }
});

test('coverage: waking from idle does not re-add native member references',()=>{
 const f=fixture(),lease=f.coverage.acquire({userIds:[U]});f.flush();const count=f.sent.length;
 f.coverage.after({type:'IDLE',idle:false});f.flush();assert.equal(f.sent.length,count);lease.release();
});
test('message snapshots: detached nested fields, count and size limits under heavy traffic',()=>{
 const evicted=[],cache=new RecentMessages(id=>evicted.push(id),10,32_000);
 const message={id:U,channel_id:G,content:'original',author:{id:U,username:'Name'},attachments:[{filename:'a',url:'https://cdn.discordapp.com/a',extra:{payload:'not retained'}}]};
 cache.set(U,message);message.author.username='Changed';message.attachments[0].url='changed';
 assert.equal(cache.get(U).author.username,'Name');assert.equal(cache.get(U).attachments[0].url,'https://cdn.discordapp.com/a');assert.equal('extra' in cache.get(U).attachments[0],false);
 for(let i=0;i<1000;i++)cache.set(String(i),{...message,content:'x'.repeat(8000)});
 assert.ok(cache.retainedBytes<=32_000);assert.ok(cache.size<=10);assert.ok(evicted.length>990);
 cache.clear();assert.equal(cache.retainedBytes,0);assert.equal(cache.size,0);
});

test('coverage: first native flush baseline is remembered before preparation finishes',()=>{
 const f=fixture(),lease=f.coverage.acquire({typing:true});
 f.coverage.before({type:'GUILD_SUBSCRIPTIONS_FLUSH',subscriptions:{[H]:{activities:true,threads:true,typing:false}}});
 f.flush();lease.release();const restored=f.sent.filter(e=>e.type==='GUILD_SUBSCRIPTIONS_FLUSH').at(-1).subscriptions[H];
 assert.deepEqual(restored,{typing:false,activities:true,threads:true});
});
test('coverage: re-enable after a disconnected disabled session starts a fresh lease',()=>{
 const f=fixture(),lease=f.coverage.acquire({userIds:[U]});f.flush();f.coverage.after({type:'CONNECTION_CLOSED'});lease.release();
 const next=f.coverage.acquire({userIds:[U]});assert.equal(f.jobs.size,1);f.flush();assert.equal(f.coverage.status().guilds,2);next.release();
});

test('event hub: frozen dispatcher attachment fails cleanly and remains retryable',()=>{
 const flux=Object.freeze({dispatch(){}}),hub=new EventHub(()=>{});assert.equal(hub.attach(flux,()=>{},()=>{}),false);
 assert.equal(hub.counts().attached,false);assert.equal(hub.attach({dispatch(){}},()=>{},()=>{}),true);hub.detach();
});
test('coverage: native retained member refs outside the selected guild are not duplicated on idle',()=>{
 const f=fixture(),lease=f.coverage.acquire({userIds:[U]});f.flush();const count=f.sent.filter(e=>e.type==='GUILD_SUBSCRIPTIONS_MEMBERS_ADD').length;
 f.deps.membersRetained=()=>true;f.coverage.after({type:'IDLE',idle:true});f.flush();
 assert.equal(f.sent.filter(e=>e.type==='GUILD_SUBSCRIPTIONS_MEMBERS_ADD').length,count);lease.release();
});
