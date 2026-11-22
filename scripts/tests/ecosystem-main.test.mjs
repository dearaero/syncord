import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';import {createHash,randomUUID} from 'node:crypto';
const A='1554184140704841939',B='1554184140704841940',origin='https://api.syncord.pro';
const f=globalThis.ecof={platform:'darwin',secure:true,backend:'gnome_libsecret',secrets:new Map(),safe:false,locked:false,network:false,opens:[],calls:[],route:()=>Response.json({})};
const dir=mkdtempSync(path.join(tmpdir(),'syncord-eco-main-')),out=path.join(dir,'main.mjs');
const stub={
 '../security/navigation':`export const openExternal=async url=>{globalThis.ecof.opens.push(url);return true;};`,
 '../security/safeStorage':`const f=globalThis.ecof;export const encryptionAvailable=()=>f.secure;export const loadSecret=k=>f.secrets.get(k);export const storeSecret=(k,v)=>{if(!f.secure)return false;f.secrets.set(k,v);return true;};export const deleteSecret=k=>f.secrets.delete(k);`,
 '../security/modes':`export const isSafeMode=()=>globalThis.ecof.safe;export const isLockdown=()=>globalThis.ecof.locked;`,
 '../security/networkBroker':`export const isNetworkLockedDown=()=>globalThis.ecof.network;`,
 electron:`export const safeStorage={getSelectedStorageBackend:()=>globalThis.ecof.backend};`
};
await build({stdin:{resolveDir:process.cwd(),contents:"export * from './src/main/ecosystem/index';export * from './src/renderer/api/ecosystem/badges';"},bundle:true,platform:'node',format:'esm',outfile:out,define:{__SYNCORD_ECOSYSTEM_ORIGIN__:JSON.stringify(origin),'process.platform':'globalThis.ecof.platform'},logLevel:'silent',plugins:[{name:'fixture',setup(b){b.onResolve({filter:/.*/},a=>a.path in stub?{path:a.path,namespace:'stub'}:undefined);b.onLoad({filter:/.*/,namespace:'stub'},a=>({contents:stub[a.path]}));}}]});
const E=await import(pathToFileURL(out).href);rmSync(dir,{recursive:true,force:true});
const nativeFetch=globalThis.fetch;globalThis.fetch=async(url,init)=>{f.calls.push({url,init});return f.route(url,init);};
test.after(()=>{globalThis.fetch=nativeFetch;delete globalThis.ecof;});
const me=(id=A)=>({id,username:'Verified',avatar:null,balance:50,badges:[]});
const token='a'.repeat(64);const put=id=>f.secrets.set('ecosystem-'+id,token);
test('Ecosystem main: narrow bridge never exposes credentials, binds accounts and uses validated OAuth navigation',async()=>{
 f.route=(url,init)=>url.endsWith('/challenge')?Response.json({state:'b'.repeat(64),expiresAt:Date.now()+600000}):url.endsWith('/poll')?Response.json({linked:true,accountId:A}):Response.json(me());
 const linked=await E.ecosystemLink(A);assert.deepEqual(Object.keys(linked),['expiresAt']);assert.equal(E.ecosystemStatus(A).pendingUntil,linked.expiresAt);assert.equal(E.ecosystemStatus(B).pendingUntil,undefined);assert.equal(f.opens.at(-1),origin+'/oauth/start?state='+'b'.repeat(64));const challenge=JSON.parse(f.calls.at(-1).init.body);assert.match(challenge.pollToken,/^[a-f0-9]{64}$/);assert.match(challenge.sessionHash,/^[a-f0-9]{64}$/);assert.equal(challenge.accountId,A);
 assert.deepEqual(await E.ecosystemPoll(A),{linked:true});const saved=f.secrets.get('ecosystem-'+A);assert.equal(createHash('sha256').update(saved).digest('hex'),challenge.sessionHash);assert.equal(E.ecosystemStatus(B).linked,false);assert.deepEqual(await E.ecosystemProfile(A),me());const request=f.calls.at(-1);assert.equal(request.url,origin+'/v1/me');assert.equal(request.init.headers.authorization,'Bearer '+saved);assert.equal(request.init.redirect,'error');assert.equal(request.init.credentials,'omit');
 assert.ok(!JSON.stringify(await E.ecosystemProfile(A)).includes(saved));await assert.rejects(E.ecosystemProfile(B),/Link this Discord account/);await assert.rejects(E.ecosystemLookup(['https://evil.test']),/Invalid Discord/);await assert.rejects(E.ecosystemBuy(A,'first-light',randomUUID(),-10),/Invalid badge price/);
});
test('Ecosystem main: Safe Mode, Lockdown, broker kill switch and insecure Linux keyrings fail closed',async()=>{
 for(const key of ['safe','locked','network']){f[key]=true;const n=f.calls.length;await assert.rejects(E.ecosystemCatalog(),/disabled/);assert.equal(f.calls.length,n);f[key]=false;}
 f.secure=false;await assert.rejects(E.ecosystemLink(B),/Secure OS storage/);f.secure=true;f.platform='linux';f.backend='basic_text';assert.equal(E.ecosystemStatus(A).encryptedStorage,false);await assert.rejects(E.ecosystemLink(B),/Secure OS storage/);f.backend='gnome_libsecret';assert.equal(E.ecosystemStatus(A).encryptedStorage,true);f.platform='darwin';
});
test('Ecosystem main: malicious or mismatched API data is rejected; errors do not expose private details',async()=>{
 put(A);f.route=()=>Response.json(me(B));await assert.rejects(E.ecosystemProfile(A),/account mismatch/);f.route=()=>Response.json([{id:'first-light',name:'Badge',description:'desc',price:25,art:'<script>'}]);await assert.rejects(E.ecosystemCatalog(),/Invalid Ecosystem badge/);
 f.route=()=>new Response('x'.repeat(262145));await assert.rejects(E.ecosystemCatalog(),/too large/);f.route=()=>Response.json({error:'SQL private data'}, {status:500});await assert.rejects(E.ecosystemProfile(A),error=>error.message==='The Ecosystem request failed. Please retry.');
});
test('Ecosystem main accepts only image content hashes and never arbitrary image URLs or SVG markup',async()=>{
 const badge={id:'uploaded',name:'SVG',description:'custom',price:25,art:'spark',image:'1'.repeat(64)};
 f.route=()=>Response.json([badge]);assert.deepEqual(await E.ecosystemCatalog(),[badge]);
 for(const image of ['https://evil.test/x.svg','data:image/svg+xml,<svg/>','<svg/>','A'.repeat(64)]){f.route=()=>Response.json([{...badge,image}]);await assert.rejects(E.ecosystemCatalog(),/Invalid badge image/);}
 f.route=()=>Response.json([{...badge,image:null}]);assert.equal((await E.ecosystemCatalog())[0].image,undefined);
});
test('badge artwork bridge pins the origin, verifies bytes/hash, bounds responses and respects security gates even on cache hits',async()=>{
 const svg='<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M0 0h32v32H0z"/></svg>',image=createHash('sha256').update(svg).digest('hex');
 const response=(body=svg,type='image/svg+xml')=>new Response(body,{headers:{'content-type':type}});
 f.route=()=>response();const n=f.calls.length;
 const [a,b]=await Promise.all([E.ecosystemArt(image),E.ecosystemArt(image)]);assert.equal(a,b);assert.equal(a,'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64'));assert.equal(f.calls.length,n+1);
 const req=f.calls.at(-1);assert.equal(req.url,origin+'/v1/badge-art/'+image+'.svg');assert.equal(req.init.credentials,'omit');assert.equal(req.init.redirect,'error');assert.deepEqual(req.init.headers,{accept:'image/svg+xml'});
 for(const key of ['safe','locked','network']){f[key]=true;await assert.rejects(E.ecosystemArt(image),/disabled/);f[key]=false;}
 await E.ecosystemArt(image);assert.equal(f.calls.length,n+1);
 for(const input of [undefined,'https://evil.test/a.svg','../x','A'.repeat(64)])await assert.rejects(E.ecosystemArt(input),/Invalid badge image/);
 const missing='f'.repeat(64);f.route=()=>response(svg,'text/html');await assert.rejects(E.ecosystemArt(missing),/Invalid badge image response/);
 f.route=()=>response('x'.repeat(524289));await assert.rejects(E.ecosystemArt(missing),/too large/);
 f.route=()=>response();await assert.rejects(E.ecosystemArt(missing),/hash mismatch/);
 const large='<svg><desc>'+'a'.repeat(524288-24)+'</desc></svg>';assert.equal(Buffer.byteLength(large),524288);f.route=()=>response(large);assert.equal(await E.ecosystemArt(createHash('sha256').update(large).digest('hex')),'data:image/svg+xml;base64,'+Buffer.from(large).toString('base64'));
 let finish;f.route=()=>new Promise(r=>finish=r);const other=svg.replace('32','31'),late=E.ecosystemArt(createHash('sha256').update(other).digest('hex')); await Promise.resolve();await Promise.resolve();f.locked=true;finish(response(other));await assert.rejects(late,/disabled/);f.locked=false;
});
test('Ecosystem main: late 401 cannot erase a newer session; disconnect removes local credentials even offline',async()=>{
 put(A);let finish;f.route=()=>new Promise(resolve=>{finish=resolve;});const old=E.ecosystemProfile(A);f.secrets.set('ecosystem-'+A,'c'.repeat(64));finish(Response.json({error:'session_expired'},{status:401}));await assert.rejects(old,/expired/);assert.equal(f.secrets.get('ecosystem-'+A),'c'.repeat(64));f.route=()=>Promise.reject(Error('offline'));await assert.rejects(E.ecosystemDisconnect(A),/offline/);assert.equal(E.ecosystemStatus(A).linked,false);
});
test('Ecosystem main: replacing a pending verification invalidates old network responses',async()=>{
 let finish;f.route=()=>new Promise(resolve=>{finish=resolve;});const old=E.ecosystemLink(B);f.route=()=>Response.json({state:'d'.repeat(64),expiresAt:Date.now()+600000});await E.ecosystemLink(B);finish(Response.json({state:'e'.repeat(64),expiresAt:Date.now()+600000}));await assert.rejects(old,/superseded/);f.route=()=>Response.json({linked:true,accountId:A});await assert.rejects(E.ecosystemPoll(B),/Account changed/);assert.equal(E.ecosystemStatus(B).linked,false);
});
test('Ecosystem main: public badge cache batches at 50, caches briefly and evicts beyond 512 users',async()=>{
 f.route=(_url,init)=>Response.json(Object.fromEntries(JSON.parse(init.body).ids.map(id=>[id,[]])));const ids=Array.from({length:550},(_,i)=>String(1554184140704843000n+BigInt(i))),n=f.calls.length;
 for(let i=0;i<ids.length;i+=50)await E.ecosystemLookup(ids.slice(i,i+50));assert.equal(f.calls.length-n,11);await E.ecosystemLookup([ids.at(-1)]);assert.equal(f.calls.length-n,11);await E.ecosystemLookup([ids[0]]);assert.equal(f.calls.length-n,12);await assert.rejects(E.ecosystemLookup(ids),/Too many/);
});
test('Ecosystem bridge is fixed, registered through trusted-sender wrapper, and renderer artifacts do not embed server secrets',()=>{
 const preload=readFileSync('src/preload/index.ts','utf8'),ipc=readFileSync('src/main/ipc.ts','utf8'),context=readFileSync('src/renderer/api/plugin/context.ts','utf8');assert.match(preload,/buy:\(account,badge,key,price\)=>ipcRenderer.invoke\(ECO_IPC.BUY,account,badge,key,price\)/);assert.match(ipc,/Object.entries\(ecosystemHandlers\)\)handle\(channel/);assert.match(context,/ecosystem-badges/);assert.ok(!preload.includes('DISCORD_CLIENT_SECRET'));assert.ok(!readFileSync('src/renderer/ui/ecosystem/index.ts','utf8').includes('DISCORD_CLIENT_SECRET'));
});

test('another account activation reaches the open renderer through both cache layers without restart',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});globalThis.window=new EventTarget();
 const id='1554184140704899999',badge={id:'remote-badge',name:'Remote',description:'New active badge',art:'spark',price:25};let active=[],changes=0;
 f.route=()=>Response.json({[id]:active});const before=f.calls.length,watch=E.watchOfficialBadges(E.ecosystemLookup,()=>changes++),flush=()=>new Promise(setImmediate);
 try{
  watch.update([id]);await flush();assert.deepEqual(E.officialBadges(id),[]);assert.equal(f.calls.length,before+1);
  active=[badge];t.mock.timers.tick(29999);assert.equal(f.calls.length,before+1);t.mock.timers.tick(1);await flush();assert.deepEqual(E.officialBadges(id),[badge]);assert.equal(f.calls.length,before+2);
  active=[];t.mock.timers.tick(30000);await flush();assert.deepEqual(E.officialBadges(id),[]);assert.equal(changes,3);
  for(const request of f.calls.slice(before)){assert.equal(request.url,origin+'/v1/badges/lookup');assert.equal(request.init.credentials,'omit');assert.equal(request.init.headers.authorization,undefined);}
 }finally{watch.release();delete globalThis.window;}
});

test('Drop distinguishes an undeployed service from linking, rate limits and expired invitations without uploading metadata to old Workers',async()=>{
 const id='12345678-1234-4123-8123-123456789abc',payload={receiver:B,name:'private-name.zip',size:2147483685};
 f.secrets.delete('ecosystem-'+A);let before=f.calls.length;
 await assert.rejects(E.ecosystemDrop(A,undefined,'invite',payload),/^Error: drop.link_required$/);assert.equal(f.calls.length,before);
 put(A);
 for(const features of [undefined,{},[],{drop:'1'},{drop:2},{drop:1},{drop:1,dropInbox:'1'},{drop:1,dropInbox:1},{drop:1,dropInbox:1,dropPresence:'1'}]){
  f.route=()=>Response.json({service:'syncord-ecosystem',version:1,verificationConfigured:true,...(features===undefined?{}:{features})});before=f.calls.length;
  await assert.rejects(E.ecosystemDrop(A,undefined,'invite',payload),/^Error: drop.unavailable$/);
  assert.equal(f.calls.length,before+1);const request=f.calls.at(-1);assert.equal(request.url,origin+'/health');assert.equal(request.init.method,'GET');assert.equal(request.init.body,undefined);assert.equal(request.init.headers.authorization,undefined);
 }
 f.route=url=>url.endsWith('/health')?Response.json({features:{drop:1,dropInbox:1,dropPresence:1}}):Response.json({id});before=f.calls.length;
 assert.deepEqual(await E.ecosystemDrop(A,undefined,'invite',payload),{id});assert.equal(f.calls.length,before+2);
 const sent=f.calls.at(-1);assert.equal(sent.url,origin+'/v1/drop/invites');assert.equal(sent.init.method,'POST');assert.deepEqual(JSON.parse(sent.init.body),payload);assert.equal(sent.init.headers.authorization,'Bearer '+token);
 before=f.calls.length;await E.ecosystemDrop(A,id,'view');await E.ecosystemDrop(A,id,'view');assert.equal(f.calls.length,before+2);assert.ok(f.calls.slice(before).every(r=>r.url===origin+'/v1/drop/'+id),'setup polls do not add health polling');
 f.route=()=>Response.json([]);before=f.calls.length;assert.deepEqual(await E.ecosystemDrop(A,undefined,'inbox'),[]);assert.equal(f.calls.length,before+1);assert.equal(f.calls.at(-1).url,origin+'/v1/drop/inbox');assert.equal(f.calls.at(-1).init.method,'GET');
 const pulse={lease:id,available:true};await E.ecosystemDrop(A,undefined,'inbox',pulse);assert.equal(f.calls.at(-1).init.method,'POST');assert.deepEqual(JSON.parse(f.calls.at(-1).init.body),pulse);
 for(const [status,code,expected] of [[409,'drop.recipient_unavailable','recipient_unavailable'],[404,'not_found','unavailable'],[503,'service_unavailable','unavailable'],[429,'rate_limited','rate'],[401,'session_expired','link_required'],[404,'drop.expired','expired'],[403,'drop.denied','denied']]){
  put(A);f.route=()=>Response.json({error:code},{status});await assert.rejects(E.ecosystemDrop(A,id,'view'),e=>e.message==='drop.'+expected);
  assert.equal(f.secrets.has('ecosystem-'+A),status!==401);
 }
});
