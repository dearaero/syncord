import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(path.join(tmpdir(),'syncord-badges-')),file=path.join(dir,'bundle.mjs');
await build({stdin:{resolveDir:process.cwd(),loader:'ts',contents:`export * from './src/renderer/plugins/showBadges/badges';export * from './src/renderer/api/discordEvents/profileQueue';`},bundle:true,platform:'neutral',format:'esm',outfile:file,logLevel:'warning'});
const T=await import(pathToFileURL(file).href);rmSync(dir,{recursive:true,force:true});
const U='1425993161108357191',V='1425993161108357192',C='1425993161108357193',G='1425993161108357194',H='1425993161108357195';
const target=(id=U,guildId=G)=>({userId:id,guildId,channelId:C});
const drain=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function fixture(){
 let now=1000,n=0;const jobs=new Map(),calls=[],ready=new Set(),fetching=new Set(),denied=new Set();
 const key=t=>`${t.userId}:${t.guildId??''}`;
 const deps={now:()=>now,set:(fn,delay)=>{const id=++n;jobs.set(id,{fn,at:now+delay});return id;},clear:id=>jobs.delete(id),
   ready:t=>ready.has(key(t)),fetching:t=>fetching.has(key(t)),allowed:t=>!denied.has(t.channelId),
   fetch:(t,signal)=>new Promise((resolve,reject)=>calls.push({target:t,signal,resolve,reject}))};
 const queue=new T.ProfileQueue(deps);
 const tick=ms=>{const end=now+ms;for(;;){const next=[...jobs].filter(([,j])=>j.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;const [id,j]=next;jobs.delete(id);now=j.at;j.fn();}now=end;};
 return {queue,deps,jobs,calls,ready,fetching,denied,tick};
}
test('badge profiles: consumers share a deduplicated queue, one active request and native cache',async()=>{
 const f=fixture(),a=f.queue.acquire(),b=f.queue.acquire();a.update([target(),target(V)]);b.update([target(),target(V)]);
 assert.equal(f.queue.stats().pending,2);assert.equal(f.jobs.size,1);f.tick(0);assert.equal(f.calls.length,1);assert.equal(f.queue.stats().active,1);
 f.ready.add(`${U}:${G}`);f.calls[0].resolve();await drain();f.tick(1499);assert.equal(f.calls.length,1);f.tick(1);assert.equal(f.calls.length,2);
 f.ready.add(`${V}:${G}`);f.calls[1].resolve();await drain();assert.equal(f.jobs.size,0);
 a.update([target()]);b.update([target(V)]);assert.equal(f.jobs.size,0);
 a.release();b.release();assert.deepEqual(f.queue.stats(),{consumers:0,pending:0,recent:0,active:0,timers:0});
});
test('badge profiles: visible targets, pending requests and cooldown metadata are bounded',async()=>{
 const f=fixture(),a=f.queue.acquire(),b=f.queue.acquire();
 const targets=Array.from({length:1000},(_,i)=>target(String(1425993161108360000n+BigInt(i))));a.update(targets);b.update(targets.slice(100));
 assert.equal(f.queue.stats().pending,128);
 for(let i=0;i<300;i++){
   const t=target(String(1425993161108390000n+BigInt(i)));a.update([t]);b.update([]);f.tick(1500);f.calls.at(-1).resolve();await drain();
 }
 assert.ok(f.queue.stats().recent<=256);assert.ok(f.queue.stats().pending<=128);assert.ok(f.queue.stats().timers<=1);a.release();b.release();
});
test('badge profiles: native inflight requests, empty completed profiles and invalid/hidden targets are skipped',()=>{
 const f=fixture(),a=f.queue.acquire();f.fetching.add(`${U}:${G}`);f.ready.add(`${V}:${G}`);
 a.update([target(),target(V),target('invalid'),{...target(),channelId:'invalid'}]);assert.equal(f.jobs.size,0);
 f.fetching.clear();f.queue.completed(U,G);a.update([target()]);assert.equal(f.jobs.size,0);
 a.update([target(U,H)]);f.denied.add(C);f.tick(0);assert.equal(f.calls.length,0);assert.equal(f.jobs.size,0);a.release();
});
test('badge profiles: navigation drops queued users, disabling aborts native request and late results cannot leak into another session',async()=>{
 const f=fixture(),a=f.queue.acquire();a.update([target(),target(V)]);f.tick(0);a.update([]);a.release();
 assert.equal(f.calls[0].signal.aborted,true);assert.equal(f.jobs.size,0);
 const b=f.queue.acquire();b.update([target(V)]);f.tick(0);f.calls[0].resolve();await drain();assert.equal(f.queue.stats().recent,0);assert.equal(f.queue.stats().active,1);
 f.calls[1].resolve();await drain();b.release();assert.equal(f.jobs.size,0);
});
test('badge profiles: timeout and rate limits do not create parallel requests or a retry loop',async()=>{
 const f=fixture(),a=f.queue.acquire();a.update([target(),target(V)]);f.tick(0);f.calls[0].reject({status:429,body:{retry_after:90}});await drain();
 f.tick(89_999);assert.equal(f.calls.length,1);f.tick(1);assert.equal(f.calls.length,2);
 f.tick(20_000);await drain();assert.equal(f.calls[1].signal.aborted,true);assert.equal(f.calls.length,2);assert.ok(f.jobs.size<=1);a.release();assert.equal(f.jobs.size,0);
});
test('badge profiles: Cloudflare plain-text 429 honors long Retry-After across consumers and resets',async()=>{
 const f=fixture(),a=f.queue.acquire();a.update([target(),target(V)]);f.tick(0);
 f.calls[0].reject({status:429,body:null,response:{headers:{'retry-after':'52576'}}});await drain();
 a.release();const b=f.queue.acquire();b.update([target(V)]);f.tick(52576*1000-1);assert.equal(f.calls.length,1);
 f.tick(1);assert.equal(f.calls.length,2);b.release();assert.equal(f.jobs.size,0);
});
test('badge profiles: native Flux failure pauses even when the loader swallows rejection',async()=>{
 const f=fixture(),a=f.queue.acquire();a.update([target(),target(V)]);f.tick(0);
 f.queue.failed(U,G,{status:429,body:{retry_after:90}});f.calls[0].resolve();await drain();
 f.tick(89_999);assert.equal(f.calls.length,1);f.tick(1);assert.equal(f.calls.length,2);a.release();
});
test('badge profiles: missing failure metadata pauses background requests without a retry burst',async()=>{
 const f=fixture(),a=f.queue.acquire();a.update([target(),target(V)]);f.tick(0);
 f.queue.failed(U,G);f.calls[0].resolve();await drain();f.tick(29_999);assert.equal(f.calls.length,1);
 f.tick(1);assert.equal(f.calls.length,2);a.release();
});
function client(global=new Map(),guilds=new Map()){
 globalThis.window={Syncord:{common:{stores:{SelectedGuildStore:{getGuildId:()=>G},UserProfileStore:{getUserProfile:id=>global.get(id),getGuildMemberProfile:(id,guild)=>guilds.get(`${id}:${guild}`)}}},webpack:{find:()=>undefined,getRequire:()=>({c:{}})}}};T.clearBadgeCache();
}
test('badges: raw message public flags render without opening a profile',()=>{
 client();const row=T.badgesForUser({id:U,public_flags:1<<7});assert.equal(row.complete,false);assert.deepEqual(row.badges.map(b=>b.id),['brilliance']);
 assert.equal(T.badgesForUser({id:U,premium_type:2}).badges[0].id,'nitro');delete globalThis.window;
});
test('badges: native profile cache is the only source, user/guild badge changes and empty lists stay accurate',()=>{
 const profiles=new Map([[U,{badges:[]}]]),guilds=new Map();client(profiles,guilds);
 assert.equal(T.badgesForUser({id:U},G).complete,true);assert.deepEqual(T.badgesForUser({id:U},G).badges,[]);
 profiles.set(U,{badges:[{id:'premium',icon:'a'.repeat(32),description:'Nitro'},{id:'premium_tenure_1',icon:'b'.repeat(32),description:'Tenure'}]});
 guilds.set(`${U}:${G}`,{badges:[{id:'server-a',icon:'c'.repeat(32)}]});guilds.set(`${U}:${H}`,{badges:[{id:'server-b',icon:'d'.repeat(32)}]});
 assert.deepEqual(T.badgesForUser({id:U,publicFlags:1<<7,premiumType:2},G).badges.map(b=>b.id),['premium_tenure_1','server-a','brilliance']);
 assert.deepEqual(T.badgesForUser({id:U},H).badges.map(b=>b.id),['premium_tenure_1','server-b']);
 profiles.set(U,{badges:[]});guilds.clear();assert.deepEqual(T.badgesForUser({id:U},G).badges,[]);delete globalThis.window;
});
test('badges: remote icon injection is rejected and labels/sizes are safe',()=>{
 assert.equal(T.badgeImgHtml({id:'evil',icon:'https://evil.example/badge.png" onerror="bad',label:'x'},14),'');
 const html=T.badgeImgHtml({id:'badge',icon:'https://cdn.discordapp.com/badge-icons/'+ 'a'.repeat(32)+'.png',label:'<img " onerror="bad>&'},Infinity);
 assert.match(html,/width="14"/);assert.match(html,/&lt;img &quot;/);assert.ok(!html.includes('title="<'));assert.ok(!html.includes('onerror="'));
});
