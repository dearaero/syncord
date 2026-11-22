import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(path.join(tmpdir(),'syncord-eco-badges-')),out=path.join(dir,'bundle.mjs');
await build({stdin:{resolveDir:process.cwd(),contents:`export * from './src/renderer/api/ecosystem/badges';export * from './src/renderer/api/ecosystem/art';export * from './src/renderer/plugins/showBadges/badges';export {ECOSYSTEM_CHANGED} from './src/shared/ecosystem';`},bundle:true,platform:'neutral',format:'esm',outfile:out,logLevel:'silent'});const E=await import(pathToFileURL(out).href);rmSync(dir,{recursive:true,force:true});
const A='1554184140704841939',B='1554184140704841940',badge={id:'first-light',name:'First <Light>',description:'desc',art:'spark',price:25},drain=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const fixture=()=>{globalThis.window=new EventTarget();window.Syncord={common:{stores:{UserProfileStore:{getUserProfile:()=>({badges:[]})}}},webpack:{find:()=>undefined,getRequire:()=>({c:{}})}};};test.afterEach(()=>delete globalThis.window);
test('official badges share visible targets, serialize batches and render trusted inline art alongside native badges',async()=>{
 fixture();const calls=[],changed=[];const f=E.watchOfficialBadges(ids=>new Promise(resolve=>calls.push({ids,resolve})),ids=>changed.push(ids));const ids=Array.from({length:100},(_,i)=>String(1554184140704841939n+BigInt(i)));f.update([...ids,...ids]);assert.equal(calls.length,1);assert.equal(calls[0].ids.length,50);f.update(ids);assert.equal(calls.length,1);
 calls[0].resolve(Object.fromEntries(calls[0].ids.map(id=>[id,[badge]])));await drain();assert.equal(calls.length,2);assert.equal(calls[1].ids.length,50);calls[1].resolve({});await drain();f.update(ids);assert.equal(calls.length,2);assert.equal(changed.length,2);
 const defs=E.badgesForUser({id:A,public_flags:1<<7}).badges;assert.ok(defs.some(b=>b.id==='brilliance'));const def=defs.find(b=>b.id==='syncord:first-light'),html=E.badgeImgHtml(def,14);assert.ok(html.includes('<svg'));assert.ok(html.includes('&lt;Light&gt;'));assert.ok(!html.includes('src='));f.release();assert.deepEqual(E.officialBadges(A),[]);
});
test('invalidated and disabled in-flight badge results cannot resurrect stale selections',async()=>{
 fixture();const calls=[];let changes=0;const f=E.watchOfficialBadges(ids=>new Promise(resolve=>calls.push({ids,resolve})),()=>changes++);f.update([A]);window.dispatchEvent(new CustomEvent(E.ECOSYSTEM_CHANGED,{detail:{id:A}}));calls[0].resolve({[A]:[badge]});await drain();assert.equal(calls.length,2);assert.deepEqual(E.officialBadges(A),[]);calls[1].resolve({[A]:[]});await drain();assert.equal(changes,1);f.update([B]);f.release();calls[2].resolve({[B]:[badge]});await drain();assert.equal(changes,1);assert.deepEqual(E.officialBadges(B),[]);
});
test('uploaded SVG chat badges use bounded native image data compatible with Discord CSP',async()=>{
 fixture();const image='1'.repeat(64),f=E.watchOfficialBadges(async()=>({[A]:[{...badge,image}]}),()=>{});f.update([A]);await drain();
 try{const def=E.badgesForUser({id:A}).badges.find(b=>b.id==='syncord:first-light'),html=E.badgeImgHtml(def,14);assert.ok(html.includes('data-syncord-badge-image="'+image+'"'));assert.ok(html.includes('src="data:image/svg+xml;'));assert.ok(!html.includes('https://api.syncord.pro'));const data='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');await E.loadBadgeImage(image,async()=>data);assert.ok(E.badgeImgHtml(def,14).includes(data));assert.ok(!html.includes('<svg'));assert.ok(html.includes('referrerpolicy="no-referrer"'));assert.ok(!E.badgeImgHtml({...def,ecosystemImage:'https://evil.test/x.svg'},14).includes('evil.test'));}finally{f.release();}
});
test('failed official lookup uses a short negative cache and never spins or adds idle polling',async()=>{
 fixture();const realNow=Date.now;let now=1000,n=0;Date.now=()=>now;const f=E.watchOfficialBadges(async()=>{n++;throw Error('offline');},()=>{});try{f.update([A]);await drain();f.update([A]);await drain();assert.equal(n,1);now+=30001;f.update([A]);await drain();assert.equal(n,2);}finally{f.release();Date.now=realNow;}
});
test('official public badge cache stays bounded while visiting many users',async()=>{
 fixture();const f=E.watchOfficialBadges(async ids=>Object.fromEntries(ids.map(id=>[id,[badge]])),()=>{}),ids=Array.from({length:550},(_,i)=>String(1554184140704850000n+BigInt(i)));for(let i=0;i<550;i+=50){f.update(ids.slice(i,i+50));await drain();}assert.deepEqual(E.officialBadges(ids[0]),[]);assert.equal(E.officialBadges(ids.at(-1)).length,1);f.release();
});

test('image data loading deduplicates, serializes, bounds content and briefly caches failures',async()=>{
 const image='4'.repeat(64),next='5'.repeat(64),data='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');let calls=0,finish;
 const first=E.loadBadgeImage(image,()=>{calls++;return new Promise(r=>finish=r);});
 const duplicate=E.loadBadgeImage(image,()=>assert.fail('Duplicate image request'));
 const second=E.loadBadgeImage(next,async()=>{calls++;return data;});await drain();assert.equal(calls,1);finish(data);assert.equal(await first,data);assert.equal(await duplicate,data);assert.equal(await second,data);assert.equal(calls,2);
 const realNow=Date.now;let now=Date.now();Date.now=()=>now;
 try{for(const [index,value]of ['https://evil.test/x.svg','data:image/svg+xml,<svg/>','data:image/svg+xml;base64,@@@@','data:image/svg+xml;base64,'+'A'.repeat(699052)].entries()){
  const id=(index+6).toString(16).repeat(64);await assert.rejects(E.loadBadgeImage(id,async()=>value),/Invalid badge image data/);
  await assert.rejects(E.loadBadgeImage(id,()=>assert.fail('Failed image retry loop')),/unavailable/);now+=30001;assert.equal(await E.loadBadgeImage(id,async()=>data),data);
 }}finally{Date.now=realNow;}
});

test('renderer accepts 512 KiB image data without recursive-regex overflow and rejects bad padding',async()=>{
 const data='data:image/svg+xml;base64,'+Buffer.alloc(512*1024,97).toString('base64');
 assert.equal(await E.loadBadgeImage('b'.repeat(64),async()=>data),data);
 for(const [i,value] of ['A','AA=','A===','====','AA=A'].entries())await assert.rejects(E.loadBadgeImage(String(i+10).padStart(64,'0'),async()=>'data:image/svg+xml;base64,'+value),/Invalid badge image data/);
});

test('visible empty badges refresh automatically: add, replace, edit and remove without local events',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});fixture();
 let rows=[],calls=0,changes=0,finish;
 const watch=E.watchOfficialBadges(async()=>{calls++;return new Promise(resolve=>finish=()=>resolve({[A]:rows}));},()=>changes++);
 const flush=async()=>{finish();await drain();};
 try{
  watch.update([A]);await flush();assert.deepEqual(E.officialBadges(A),[]);
  rows=[badge];t.mock.timers.tick(29999);assert.equal(calls,1);t.mock.timers.tick(1);assert.equal(calls,2);await flush();assert.deepEqual(E.officialBadges(A),[badge]);
  rows=[{...badge,id:'orbit-badge',image:'e'.repeat(64)}];t.mock.timers.tick(30000);assert.deepEqual(E.officialBadges(A),[badge],'last result remains visible during refresh');await flush();assert.deepEqual(E.officialBadges(A),rows);
  rows=[{...rows[0],name:'Edited',image:'d'.repeat(64)}];t.mock.timers.tick(30000);await flush();assert.deepEqual(E.officialBadges(A),rows);
  t.mock.timers.tick(30000);await flush();assert.equal(changes,4,'identical results do not repaint');
  rows=[];t.mock.timers.tick(30000);await flush();assert.deepEqual(E.officialBadges(A),[]);assert.equal(changes,5);
  watch.update([]);const before=calls;t.mock.timers.tick(120000);assert.equal(calls,before,'no targets means no requests');
 }finally{watch.release();}
});

test('one refresh lane pauses while hidden, wakes on return, retains badges on failure and cleans up',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});fixture();
 const doc=globalThis.document=new EventTarget();doc.visibilityState='visible';let calls=0,fail=false,finish;
 const lookup=async()=>{calls++;if(fail)throw Error('offline');return new Promise(resolve=>finish=()=>resolve({[A]:[badge]}));};
 const one=E.watchOfficialBadges(lookup,()=>{}),two=E.watchOfficialBadges(lookup,()=>{});
 try{
  one.update([A]);two.update([A]);finish();await drain();assert.equal(calls,1);
  doc.visibilityState='hidden';doc.dispatchEvent(new Event('visibilitychange'));t.mock.timers.tick(90000);one.update([A]);assert.equal(calls,1);
  doc.visibilityState='visible';doc.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'));assert.equal(calls,2,'return/focus deduplicate');
  t.mock.timers.tick(90000);assert.equal(calls,2,'slow response never overlaps');finish();await drain();
  fail=true;t.mock.timers.tick(30000);await drain();assert.equal(calls,3);assert.deepEqual(E.officialBadges(A),[badge],'network failure does not erase last known badges');
  window.dispatchEvent(new Event('online'));one.update([A]);t.mock.timers.tick(29999);assert.equal(calls,3,'failure backoff is shared');
  fail=false;t.mock.timers.tick(1);assert.equal(calls,4);finish();await drain();one.release();t.mock.timers.tick(30000);assert.equal(calls,5,'remaining surface still refreshes');
  two.release();finish();await drain();assert.deepEqual(E.officialBadges(A),[]);
  const before=calls;t.mock.timers.tick(120000);window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('online'));doc.dispatchEvent(new Event('visibilitychange'));assert.equal(calls,before,'last release removes timer and listeners');
 }finally{one.release();two.release();delete globalThis.document;}
});
