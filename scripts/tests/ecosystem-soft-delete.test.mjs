import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {readFileSync,readdirSync,realpathSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
const require=createRequire(realpathSync('services/ecosystem/node_modules/wrangler/package.json'));
const {Miniflare,convertV4MiniflareOptions}=require('miniflare'),{unstable_splitSqlQuery}=require('wrangler');
const origin='https://api.syncord.pro',A='1554184140704841939',B='1554184140704841940',C='1554184140704841941';
const hash=s=>createHash('sha256').update(s).digest('hex');
test('badge soft deletion: upgrade compatibility, all surfaces, ownership retention and write races',{timeout:30000},async t=>{
 const bundle=await build({entryPoints:['services/ecosystem/src/index.ts'],bundle:true,platform:'browser',format:'esm',write:false,logLevel:'silent'});
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-17',d1Databases:['DB'],bindings:{PUBLIC_ORIGIN:origin,DISCORD_CLIENT_ID:A,DISCORD_CLIENT_SECRET:'fixture',ADMIN_DISCORD_IDS:A},outboundService:async r=>{
  const p=new URL(r.url).pathname;if(p==='/api/oauth2/token')return Response.json({access_token:'fixture',token_type:'Bearer',scope:'identify'});if(p==='/api/v10/users/@me')return Response.json({id:A,username:'Admin',mfa_enabled:true});if(p==='/api/oauth2/token/revoke')return new Response(null);throw Error('Unexpected provider request');
 }}));
 try{
  const db=await mf.getD1Database('DB'),migrations=readdirSync('services/ecosystem/migrations').filter(n=>n.endsWith('.sql')).sort();
  const migrate=async name=>db.batch(unstable_splitSqlQuery(readFileSync('services/ecosystem/migrations/'+name,'utf8')).map(s=>db.prepare(s)));
  for(const name of migrations.filter(n=>n<'0004'))await migrate(name);
  // Existing pre-migration receipts must remain valid after changing delete semantics.
  const legacyId='legacy-unused',legacyCreate={key:randomUUID(),id:legacyId,name:'Legacy',description:'old receipt',art:'spark',price:1,available:true};
  const legacyAfter={id:legacyId,name:'Legacy',description:'old receipt',art:'spark',price:1,available:1,revision:1,image:null};
  const audit=(key,action,id,revision,after,before=null)=>db.prepare('INSERT INTO admin_audit(actor_id,request_key,action,target_id,expected_revision,request_hash,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(A,key,action,id,revision,hash(JSON.stringify([action,id,revision,after])),before?JSON.stringify(before):null,after?JSON.stringify(after):null,Date.now()).run();
  await audit(legacyCreate.key,'badge.create',legacyId,0,legacyAfter);const legacyDelete={key:randomUUID(),revision:1};await audit(legacyDelete.key,'badge.delete',legacyId,1,null,legacyAfter);
  for(const name of migrations.filter(n=>n>='0004'))await migrate(name);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM badges WHERE is_deleted=0 AND supporter_tier=0').first()).n,4);
  let ip=0;const call=async(path,method='GET',data,headers={})=>{const r=await mf.dispatchFetch(origin+path,{method,redirect:'manual',headers:{'cf-connecting-ip':'192.0.2.'+(++ip),...(data?{'content-type':'application/json'}:{}),...headers},...(data?{body:JSON.stringify(data)}:{})});return{status:r.status,headers:r.headers,value:r.headers.get('content-type')?.includes('json')?await r.json():await r.text()};};
  const login=await call('/admin/login','POST',undefined,{origin}),state=new URL(login.headers.get('location')).searchParams.get('state');
  const callback=await call('/oauth/callback?state='+state+'&code=fixture&iss=https%3A%2F%2Fdiscord.com','GET',undefined,{cookie:login.headers.get('set-cookie').split(';')[0]});
  const cookie=callback.headers.getSetCookie().find(v=>v.startsWith('__Host-syncord-admin=')).split(';')[0],me=(await call('/admin/api/me','GET',undefined,{cookie})).value;
  const mutate=(id,data,method='DELETE',extra={})=>call('/admin/api/badges'+(id?'/'+id:''),method,data,{cookie,origin,'x-csrf-token':me.csrf,...extra});
  const adminGet=path=>call('/admin/api/'+path,'GET',undefined,{cookie});
  const tokens=new Map([[B,'b'.repeat(64)],[C,'c'.repeat(64)]]),purchaseKeys=new Map();
  for(const id of [B,C]){
   await db.prepare('INSERT INTO accounts(id,username,created_at) VALUES(?,?,?)').bind(id,'Owner '+id,Date.now()).run();
   await db.prepare('INSERT INTO sessions(hash,account_id,created_at,expires_at) VALUES(?,?,?,?)').bind(hash(tokens.get(id)),id,Date.now(),Date.now()+3600000).run();
   await db.prepare("INSERT INTO reward_grants VALUES(?,?,'verified-welcome',?,50,?)").bind(randomUUID(),id,id,Date.now()).run();
   for(let i=0;i<4;i++)await db.prepare("INSERT INTO reward_grants VALUES(?,?,'community-contribution',?,25,?)").bind(randomUUID(),id,id+':'+i,Date.now()).run();
   const key=randomUUID();purchaseKeys.set(id,key);await db.prepare("INSERT INTO purchases VALUES(?,?,'first-light',25,?,?)").bind(randomUUID(),id,key,Date.now()).run();
  }
  await db.prepare("INSERT INTO purchases VALUES(?,?,'orbital',100,?,?)").bind(randomUUID(),B,randomUUID(),Date.now()).run();
  await db.prepare('UPDATE owned_badges SET active=1').run();
  const ownerCall=(id,path,method='GET',data)=>call(path,method,data,{authorization:'Bearer '+tokens.get(id)});
  const snapshot=async()=>({wallets:(await db.prepare('SELECT * FROM wallets ORDER BY account_id').all()).results,ledger:(await db.prepare('SELECT * FROM ledger ORDER BY id').all()).results,purchases:(await db.prepare('SELECT * FROM purchases ORDER BY id').all()).results,ownership:(await db.prepare('SELECT account_id,badge_id,purchase_id FROM owned_badges ORDER BY account_id,badge_id').all()).results});
  const original=await snapshot(),deletion={key:randomUUID(),revision:1};
  await t.test('pre-upgrade create/delete retries still acknowledge the same immutable receipts',async()=>{
   assert.equal((await mutate('',legacyCreate,'POST')).value.replayed,true);const replay=await mutate(legacyId,legacyDelete);assert.equal(replay.status,200);assert.equal(replay.value.replayed,true);assert.equal(replay.value.item,null);assert.equal(await db.prepare('SELECT * FROM badges WHERE id=?').bind(legacyId).first(),null);
  });
  await t.test('authorization, CSRF, stale revisions and forbidden fields cause no deletion',async()=>{
   assert.equal((await call('/admin/api/badges/first-light','DELETE',deletion)).status,401);
   assert.equal((await mutate('first-light',deletion,'DELETE',{'x-csrf-token':'x'})).status,403);
   assert.equal((await mutate('first-light',deletion,'DELETE',{origin:'https://evil.test'})).status,403);
   assert.equal((await mutate('first-light',{...deletion,revision:2})).status,409);
   assert.equal((await mutate('first-light',{...deletion,is_deleted:1})).status,400);
   assert.equal((await db.prepare("SELECT is_deleted FROM badges WHERE id='first-light'").first()).is_deleted,0);
  });
  await t.test('concurrent owner-bearing deletion is one audited terminal mutation, safe to retry',async()=>{
   const replies=await Promise.all(Array.from({length:3},()=>mutate('first-light',deletion)));assert.ok(replies.every(r=>r.status===200),JSON.stringify(replies));assert.ok(replies.every(r=>r.value.item.is_deleted===1));
   assert.equal((await mutate('first-light',deletion)).value.replayed,true);
   const row=await db.prepare("SELECT * FROM badges WHERE id='first-light'").first();assert.equal(row.is_deleted,1);assert.equal(row.available,0);assert.equal(row.revision,2);
   assert.equal((await db.prepare('SELECT COUNT(*) n FROM admin_audit WHERE request_key=?').bind(deletion.key).first()).n,1);
   const audit=await db.prepare('SELECT before_json,after_json FROM admin_audit WHERE request_key=?').bind(deletion.key).first();assert.equal(JSON.parse(audit.before_json).is_deleted,0);assert.equal(JSON.parse(audit.after_json).is_deleted,1);
   assert.equal((await db.prepare("SELECT COUNT(*) n FROM owned_badges WHERE badge_id='first-light' AND active=1").first()).n,0);
   assert.deepEqual(await snapshot(),original);
  });
  await t.test('store, owner profile, chat/profile lookup, admin catalog and displayed counts omit deleted badges',async()=>{
   assert.ok(!(await call('/v1/catalog')).value.some(b=>b.id==='first-light'));
   assert.ok(!(await adminGet('badges')).value.some(b=>b.id==='first-light'));assert.equal((await adminGet('overview')).value.badges,3);
   assert.deepEqual((await ownerCall(B,'/v1/me')).value.badges.map(b=>b.id),['orbital']);assert.deepEqual((await ownerCall(C,'/v1/me')).value.badges,[]);
   const lookup=(await call('/v1/badges/lookup','POST',{ids:[B,C]})).value;assert.deepEqual(lookup[B].map(b=>b.id),['orbital']);assert.deepEqual(lookup[C],[]);
   const counts=(await adminGet('accounts')).value.entries;assert.equal(counts.find(a=>a.id===B).badges,1);assert.equal(counts.find(a=>a.id===C).badges,0);
   assert.equal((await ownerCall(B,'/v1/me/transactions')).value.entries.length,7);
  });
  await t.test('deleted IDs cannot be reused/restored/activated/bought and failed activation batches roll back',async()=>{
   assert.equal((await ownerCall(C,'/v1/me/purchases','POST',{badgeId:'first-light',idempotencyKey:randomUUID(),expectedPrice:25})).status,404);
   assert.equal((await ownerCall(B,'/v1/me/purchases','POST',{badgeId:'first-light',idempotencyKey:purchaseKeys.get(B),expectedPrice:25})).status,200,'old successful purchase receipt still replays without showing deleted badge');
   assert.equal((await ownerCall(B,'/v1/me/badges','PUT',{ids:['orbital','first-light']})).status,403);
   await assert.rejects(db.batch([db.prepare('UPDATE owned_badges SET active=0 WHERE account_id=?').bind(B),db.prepare("UPDATE owned_badges SET active=1 WHERE account_id=? AND badge_id='first-light'").bind(B)]),/badge_unavailable/);
   assert.equal((await db.prepare("SELECT active FROM owned_badges WHERE account_id=? AND badge_id='orbital'").bind(B).first()).active,1);
   await assert.rejects(db.prepare("UPDATE badges SET is_deleted=0 WHERE id='first-light'").run(),/admin_badge_deleted/);
   await assert.rejects(db.prepare("UPDATE badges SET available=1 WHERE id='first-light'").run(),/admin_badge_deleted/);
   await assert.rejects(db.prepare("DELETE FROM badges WHERE id='guardian'").run(),/admin_soft_delete_required/);
   assert.equal((await mutate('',{...legacyCreate,id:'first-light',key:randomUUID()},'POST')).status,409);
   assert.equal((await mutate('first-light',{key:randomUUID(),revision:2})).status,404);
   assert.deepEqual(await snapshot(),original);
  });
  await t.test('delete/edit races cannot resurrect an owned badge or produce two successful commands',async()=>{
   const edit={key:randomUUID(),revision:1,name:'Orbital edited',description:'concurrent',art:'orbit',price:100,image:null,available:true};
   const replies=await Promise.all([mutate('orbital',{key:randomUUID(),revision:1}),mutate('orbital',edit,'PUT')]);assert.equal(replies.filter(r=>r.status===200).length,1,JSON.stringify(replies));assert.ok(replies.every(r=>[200,404,409].includes(r.status)));
   const current=await db.prepare("SELECT * FROM badges WHERE id='orbital'").first();if(!current.is_deleted)assert.equal((await mutate('orbital',{key:randomUUID(),revision:current.revision})).status,200);
   assert.deepEqual((await ownerCall(B,'/v1/me')).value.badges,[]);assert.deepEqual((await call('/v1/badges/lookup','POST',{ids:[B,C]})).value,{[B]:[],[C]:[]});assert.deepEqual(await snapshot(),original);
  });
  await t.test('retained deleted rows do not consume the live catalog limit',async()=>{
   await db.prepare("WITH RECURSIVE n(v) AS(SELECT 0 UNION ALL SELECT v+1 FROM n WHERE v<509) INSERT INTO badges(id,name,description,art,price,available) SELECT 'capacity-'||v,'Capacity badge','','spark',1,1 FROM n").run();
   const draft={...legacyCreate,id:'capacity-new',key:randomUUID()};assert.equal((await mutate('',draft,'POST')).value.error,'admin_catalog_full');
   assert.equal((await mutate('capacity-0',{key:randomUUID(),revision:1})).status,200);
   assert.equal((await mutate('',draft,'POST')).status,200);assert.equal((await adminGet('overview')).value.badges,512);
   assert.equal((await db.prepare('SELECT COUNT(*) n FROM badges WHERE supporter_tier=0').first()).n,515);assert.equal((await db.prepare('SELECT COUNT(*) n FROM badges WHERE is_deleted=1').first()).n,3);
  });

 }finally{await mf.dispose();}
});
