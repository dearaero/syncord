import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(path.join(tmpdir(),'syncord-dm-closer-'));
await build({stdin:{resolveDir:process.cwd(),contents:"export * from './src/renderer/plugins/dmCloser/engine'; export * from './src/renderer/plugins/dmCloser/discord';",loader:'ts'},bundle:true,platform:'neutral',format:'esm',outfile:path.join(dir,'test.mjs'),logLevel:'silent'});
const T=await import(pathToFileURL(path.join(dir,'test.mjs')).href);process.on('exit',()=>rmSync(dir,{recursive:true,force:true}));
const USER='100000000000000001',OTHER='100000000000000002';
const target=(kind='dm',n=1)=>({id:String(200000000000000000n+BigInt(n)),kind,name:`${kind} ${n}`});
const plan=(targets,extra={})=>({userId:USER,includeGuilds:targets.some(t=>t.kind==='guild'),targets,owned:0,unknown:0,...extra});
function fixture(extra={}){
 let clock=1000;const calls=[],ack=[],waits=[],states=[];
 const port={assertAccount:id=>assert.equal(id,USER),inspect(){},async request(t){calls.push({...t});return{status:t.kind==='guild'?204:200};},acknowledged(t){ack.push(t.id);},...extra};
 const engine=new T.DmCloser(port,s=>states.push(s),()=>clock,async(ms,signal)=>{if(signal.aborted)throw new DOMException('Stopped','AbortError');waits.push(ms);clock+=ms;});
 return{engine,port,calls,ack,waits,states,setNow:n=>clock=n};
}
test('DM closer: explicit run, frozen scope, one request at a time, separate success counts',async()=>{
 const f=fixture(),list=[target(),target('group',2),target('guild',3)],p=plan(list);assert.equal(f.calls.length,0);
 const run=f.engine.run(p);list.push(target('guild',4));await run;
 assert.deepEqual(f.calls.map(t=>t.kind),['dm','group','guild']);assert.equal(f.ack.length,3);
 const s=f.engine.snapshot();assert.equal(s.phase,'completed');assert.equal(s.processed,3);assert.equal(s.closed,1);assert.equal(s.groups,1);assert.equal(s.guilds,1);
});
test('DM closer: rejects duplicate, malformed, non-private kind and unsolicited server plans',async()=>{
 for(const p of [plan([target(),target()]),plan([{...target(),id:'../../guilds/x'}]),plan([{...target(),kind:'channel'}]),plan([target('guild')],{includeGuilds:false}),plan([],{userId:'0'})]){
  const f=fixture();await assert.rejects(f.engine.run(p));assert.equal(f.calls.length,0);
 }
});
test('DM closer: ownership/membership checks skip safely with bounded issue history',async()=>{
 const f=fixture({inspect:t=>t.kind==='guild'?'owned server, kept':undefined});await f.engine.run(plan(Array.from({length:60},(_,i)=>target('guild',i+1))));
 assert.equal(f.calls.length,0);assert.equal(f.engine.snapshot().skipped,60);assert.equal(f.engine.snapshot().issues.length,20);
});
test('DM closer: complete Retry-After honoured and ownership rechecked after waiting',async()=>{
 let owner=false,requests=0;
 const f=fixture({inspect:()=>owner?'owned server, kept':undefined,async request(){requests++;owner=true;return{status:429,body:{retry_after:3601.5},headers:{'Retry-After':'3602'}};}});
 await f.engine.run(plan([target('guild')]));assert.equal(requests,1);assert.deepEqual(f.waits,[3602050]);assert.equal(f.engine.snapshot().guilds,0);assert.equal(f.engine.snapshot().skipped,1);
});
test('DM closer: native thrown 429, quota resets and clock skew use full relative deadlines',async()=>{
 let requests=0;const f=fixture({async request(){if(++requests===1)throw{response:{status:429,body:{retry_after:2}}};return{status:200,headers:{'X-RateLimit-Remaining':'0','X-RateLimit-Reset-After':'1.5','X-RateLimit-Reset':'99999999'}};}});
 await f.engine.run(plan([target(),target('group',2)]));assert.deepEqual(f.waits,[2050,1500]);assert.equal(f.engine.snapshot().processed,2);
});
test('DM closer: Stop waits for the in-flight result, never starts the next action, guards duplicate Start',async()=>{
 let resolve;const f=fixture({request:()=>new Promise(r=>resolve=r)});const p=plan([target(),target('group',2)]);const running=f.engine.run(p);
 await assert.rejects(f.engine.run(p),/already running/);f.engine.stop();assert.equal(f.engine.active(),true);resolve({status:204});await running;
 assert.equal(f.ack.length,1);assert.equal(f.engine.snapshot().closed,1);assert.equal(f.engine.snapshot().processed,1);assert.equal(f.engine.snapshot().phase,'stopped');assert.equal(f.engine.active(),false);
});
test('DM closer: account switch after success stops subsequent requests and avoids old-account dispatch',async()=>{
 let switched=false,requests=0;const f=fixture({assertAccount(){if(switched)throw new Error('Account changed');},async request(){requests++;switched=true;return{status:204};}});
 await f.engine.run(plan([target(),target('group',2)]));assert.equal(requests,1);assert.equal(f.ack.length,0);assert.equal(f.engine.snapshot().closed,1);assert.equal(f.engine.snapshot().phase,'error');
});
test('DM closer: failed/ambiguous requests are never counted as successful or blindly retried',async()=>{
 for(const result of [{status:0},{status:500},{status:202},{status:400,body:{captcha_key:['required']}},{status:401},{status:404,body:{code:0}}]){
  let requests=0;const f=fixture({async request(){requests++;return result;}});await f.engine.run(plan([target(),target('group',2)]));assert.equal(requests,1);assert.equal(f.engine.snapshot().phase,'error');assert.equal(f.ack.length,0);assert.equal(f.engine.snapshot().failed,1);
 }
});
test('DM closer: known missing targets skip, repeated denial stops, repeated rate limits are bounded',async()=>{
 const missing=fixture({request:async()=>({status:404,body:{code:10003}})});await missing.engine.run(plan([target()]));assert.equal(missing.engine.snapshot().skipped,1);assert.equal(missing.engine.snapshot().closed,0);
 let denied=0;const f=fixture({async request(){denied++;return{status:403};}});await f.engine.run(plan(Array.from({length:10},(_,i)=>target('dm',i+1))));assert.equal(denied,3);assert.equal(f.engine.snapshot().phase,'error');assert.equal(f.engine.snapshot().failed,3);
 let requests=0;const g=fixture({async request(){requests++;return{status:429,body:{retry_after:1}};}});await g.engine.run(plan([target()]));assert.equal(requests,5);assert.equal(g.engine.snapshot().phase,'error');
});
test('DM closer: rate deadlines survive Stop/Start and waiting can be cancelled immediately',async()=>{
 let clock=1000,requests=0,rejectWait,waiting;
 const port={assertAccount(){},inspect(){},acknowledged(){},async request(){requests++;return requests===1?{status:429,body:{retry_after:30}}:{status:204};}};
 const engine=new T.DmCloser(port,()=>{},()=>clock,(ms,signal)=>new Promise((resolve,reject)=>{waiting=ms;rejectWait=()=>reject(new DOMException('Stopped','AbortError'));signal.addEventListener('abort',rejectWait,{once:true});}));
 const run=engine.run(plan([target()]));await new Promise(r=>setTimeout(r,0));assert.equal(waiting,30050);engine.stop();await run;assert.equal(engine.snapshot().phase,'stopped');
 const next=engine.run(plan([target()]));await new Promise(r=>setTimeout(r,0));assert.equal(requests,1);assert.equal(waiting,30050);engine.stop();await next;
});
function nativeFixture(){
 const channels={ [target().id]:{id:target().id,type:1,recipients:[OTHER]},[target('group',2).id]:{id:target('group',2).id,type:3,name:'Group'},[target('dm',9).id]:{id:target('dm',9).id,type:0,guild_id:target('guild',3).id} };
 const guilds={a:{id:target('guild',3).id,name:'Other server',ownerId:OTHER},b:{id:target('guild',4).id,name:'Owned',owner_id:USER},c:{id:target('guild',5).id,name:'Unknown'},d:{id:target('guild',6).id,name:'Conflicting',ownerId:OTHER,owner_id:USER}};
 const calls=[],events=[];let current=USER;
 const rest={get(){},post(){},put(){},patch(){},async del(o){assert.equal(this,rest);calls.push(o);return{status:204};}};
 globalThis.window={Syncord:{common:{utils:{RestAPI:undefined},stores:{UserStore:{getCurrentUser:()=>({id:current}),getUser:()=>({username:'Someone'})},ChannelStore:{getMutablePrivateChannels:()=>channels,getChannel:id=>channels[id]},GuildStore:{getGuilds:()=>guilds,getGuild:id=>Object.values(guilds).find(g=>g.id===id)}},flux:{FluxDispatcher:{dispatch(e){assert.equal(this,window.Syncord.common.flux.FluxDispatcher);events.push(e);}}}},webpack:{find:predicate=>[rest].find(predicate)}}};
 return{channels,guilds,calls,events,setUser:id=>current=id};
}
test('DM closer native adapter: all private channels irrespective of filters; guilds opt in, owners/unknown kept',()=>{
 const previous=globalThis.window;try{
 const f=nativeFixture();let p=T.closingPlan(false);assert.deepEqual(p.targets.map(t=>t.kind),['dm','group']);assert.equal(p.includeGuilds,false);
 p=T.closingPlan(true);assert.equal(p.targets.length,3);assert.equal(p.owned,2);assert.equal(p.unknown,1);assert.equal(p.targets.at(-1).id,f.guilds.a.id);
 delete window.Syncord.common.stores.GuildStore;assert.equal(T.closingPlan(false).targets.length,2);assert.throws(()=>T.closingPlan(true),/server list/);
 }finally{globalThis.window=previous;}
});
test('DM closer native adapter: exact close/leave endpoints and Flux payloads, never guild deletion',async()=>{
 const previous=globalThis.window;try{
 const f=nativeFixture(),port=T.discordPort({warn(){}});const p=T.closingPlan(true);
 for(const t of p.targets){await port.request(t,p.userId);port.acknowledged(t,p.userId);}
 assert.deepEqual(f.calls.map(o=>o.url),[`/channels/${target().id}`,`/channels/${target('group',2).id}`,`/users/@me/guilds/${f.guilds.a.id}`]);
 assert.equal(f.calls.every(o=>o.retries===0&&o.rejectWithError&&o.failImmediatelyWhenRateLimited),true);
 assert.deepEqual(f.events.map(e=>e.type),['CHANNEL_DELETE','CHANNEL_DELETE','GUILD_DELETE']);assert.deepEqual(f.events[2],{type:'GUILD_DELETE',guild:{id:f.guilds.a.id}});
 assert.throws(()=>port.request(target('dm',9),USER),/Target changed/);f.guilds.a.ownerId=USER;assert.throws(()=>port.request(p.targets.at(-1),USER),/owned server/);
 f.setUser(OTHER);assert.throws(()=>port.request(p.targets[0],USER),/account changed/);assert.equal(f.calls.length,3);
 }finally{globalThis.window=previous;}
});
