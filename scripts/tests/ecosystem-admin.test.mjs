import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {createRequire} from 'node:module';import {readFileSync,realpathSync,readdirSync} from 'node:fs';import {createHash,randomBytes,randomUUID} from 'node:crypto';
const require=createRequire(realpathSync('services/ecosystem/node_modules/wrangler/package.json')),{Miniflare,convertV4MiniflareOptions}=require('miniflare'),{unstable_splitSqlQuery}=require('wrangler');
const origin='https://api.syncord.pro',A='1554184140704841939',B='1554184140704841940',random=()=>randomBytes(32).toString('hex'),hash=s=>createHash('sha256').update(s).digest('hex');
test('Ecosystem Admin real workerd/D1 authorization and transactional security',{timeout:90000},async t=>{
 const bundle=await build({entryPoints:['services/ecosystem/src/index.ts'],bundle:true,platform:'browser',format:'esm',write:false,logLevel:'silent'});
 let user=A,mfa=true,scope='identify',revokes=0,exchanges=0,ip=0;const upstream=[];
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-17',d1Databases:['DB'],bindings:{PUBLIC_ORIGIN:origin,DISCORD_CLIENT_ID:A,DISCORD_CLIENT_SECRET:'test-provider-secret',ADMIN_DISCORD_IDS:A},outboundService:async request=>{
  const u=new URL(request.url);assert.equal(u.origin,'https://discord.com');
  if(u.pathname==='/api/oauth2/token'){exchanges++;const form=new URLSearchParams(await request.text());assert.equal(form.get('client_secret'),'test-provider-secret');upstream.push(Object.fromEntries(form));return Response.json({access_token:'test-identify-only',refresh_token:'must-not-persist',token_type:'Bearer',scope});}
  if(u.pathname==='/api/v10/users/@me'){assert.equal(request.headers.get('authorization'),'Bearer test-identify-only');return Response.json({id:user,username:'Owner <img onerror=bad()>',mfa_enabled:mfa});}
  if(u.pathname==='/api/oauth2/token/revoke'){revokes++;return new Response(null,{status:200});}throw Error('Unexpected Discord route');
 }}));
 try{
 const db=await mf.getD1Database('DB');for(const file of readdirSync('services/ecosystem/migrations').filter(n=>n.endsWith('.sql')).sort())await db.batch(unstable_splitSqlQuery(readFileSync('services/ecosystem/migrations/'+file,'utf8')).map(sql=>db.prepare(sql)));
 const call=async(path,{method='GET',data,cookie,headers={},raw}={})=>{const r=await mf.dispatchFetch(origin+path,{method,redirect:'manual',headers:{'cf-connecting-ip':'198.51.100.'+(++ip),...(cookie?{cookie}:{}),...(data!==undefined?{'content-type':'application/json'}:{}),...headers},...(data!==undefined?{body:JSON.stringify(data)}:raw!==undefined?{body:raw}:{})});return{r,status:r.status,value:r.headers.get('content-type')?.includes('application/json')?await r.json():await r.text()};};
 const start=async()=>{const r=await call('/admin/login',{method:'POST',headers:{origin}});assert.equal(r.status,303,JSON.stringify(r.value));const target=new URL(r.r.headers.get('location')),state=target.searchParams.get('state'),cookie=r.r.headers.get('set-cookie').split(';')[0];assert.equal(target.origin,'https://discord.com');assert.equal(target.searchParams.get('scope'),'identify');assert.equal(target.searchParams.get('redirect_uri'),origin+'/oauth/callback');assert.equal(target.searchParams.get('prompt'),'consent');return{state,cookie,target,path:'/oauth/callback?state='+state+'&iss=https%3A%2F%2Fdiscord.com&code='+randomUUID()};};
 const login=async()=>{const begun=await start(),done=await call(begun.path,{cookie:begun.cookie});const cookies=done.r.headers.getSetCookie(),admin=cookies.find(c=>c.startsWith('__Host-syncord-admin='));return{...begun,done,cookie:admin?.split(';')[0]};};
 let owner,csrf;
 await t.test('public shell contains no credentials; admin data and operations reject unauthenticated, forged-ID and desktop tokens',async()=>{
  const page=await call('/admin');assert.equal(page.status,200);assert.ok(page.value.includes('Ecosystem Admin'));assert.ok(!page.value.includes('test-provider-secret'));assert.ok(!page.value.includes(A));
  assert.equal(page.r.headers.get('referrer-policy'),'same-origin');assert.equal((await call('/admin/')).r.headers.get('referrer-policy'),'same-origin');
  assert.ok(page.r.headers.get('content-security-policy').includes("form-action 'self' https://discord.com/oauth2/authorize;"));
  for(const path of ['/admin/app.js','/admin/style.css','/admin/api/me'])assert.equal((await call(path)).r.headers.get('referrer-policy'),'no-referrer');
  const csp=page.r.headers.get('content-security-policy');assert.ok(csp.includes("frame-ancestors 'none'"));assert.ok(!csp.includes('unsafe-inline'));assert.ok(csp.includes("form-action 'self'"));assert.equal(page.r.headers.get('cache-control'),'no-store');
  for(const path of ['/admin/api/me','/admin/api/badges','/admin/api/audit','/admin/api/accounts','/admin/api/overview']){assert.equal((await call(path)).status,401);assert.equal((await call(path,{headers:{authorization:'Bearer '+random(),'x-discord-id':A,'x-admin':'true'}})).status,401);}
  for(const headers of [{origin:'https://evil.test'},{origin:'null','sec-fetch-site':'same-origin'},{origin,'sec-fetch-site':'same-site'},{}])assert.equal((await call('/admin/login',{method:'POST',headers})).status,403);
 });
 await t.test('fresh browser-bound OAuth, identify-only scope and verified allowlist create a separate short HttpOnly admin session',async()=>{
  owner=await login();assert.equal(owner.done.status,303);assert.equal(owner.done.r.headers.get('location'),'/admin');assert.equal(owner.done.r.headers.get('referrer-policy'),'no-referrer');assert.ok(owner.done.r.headers.get('content-security-policy').includes("form-action 'self';"));assert.ok(owner.cookie);const cookie=owner.done.r.headers.getSetCookie().find(c=>c.startsWith('__Host-syncord-admin='));assert.match(cookie,/HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=900/);
  const me=await call('/admin/api/me',{cookie:owner.cookie});assert.equal(me.status,200);assert.equal(me.value.id,A);csrf=me.value.csrf;assert.match(csrf,/^[a-f0-9]{64}$/);assert.ok(me.value.expiresAt-Date.now()<=900000);assert.ok(!JSON.stringify(me.value).includes(owner.cookie.split('=')[1]));
  const row=await db.prepare('SELECT * FROM admin_sessions').first();assert.equal(row.hash,hash(owner.cookie.split('=')[1]));assert.ok(!JSON.stringify(row).includes('test-identify-only'));assert.equal(revokes,1);assert.equal(upstream[0].redirect_uri,origin+'/oauth/callback');assert.equal(createHash('sha256').update(upstream[0].code_verifier).digest('base64url'),owner.target.searchParams.get('code_challenge'));
  assert.equal(await db.prepare('SELECT * FROM accounts').first(),null,'admin login must not create a wallet or welcome award');assert.equal((await call('/v1/me',{headers:{authorization:'Bearer '+owner.cookie.split('=')[1]}})).status,401);
 });
 await t.test('OAuth callback rejects missing/swapped cookies, bad issuer, stale state and replay before exchange',async()=>{
  const s=await start(),count=exchanges;assert.equal((await call(s.path)).status,401);assert.equal((await call(s.path,{cookie:s.cookie.replace(/=.+$/,'='+random())})).status,401);assert.equal((await call(s.path.replace('https%3A%2F%2Fdiscord.com','https%3A%2F%2Fevil.test'),{cookie:s.cookie})).status,401);
  const wrongOrigin=await mf.dispatchFetch('https://evil.test'+s.path,{headers:{cookie:s.cookie},redirect:'manual'});assert.equal(wrongOrigin.status,403);assert.equal(exchanges,count);assert.equal((await call(owner.path,{cookie:owner.cookie})).status,410);
  await db.prepare('UPDATE admin_challenges SET expires_at=0 WHERE state_hash=?').bind(hash(s.state)).run();assert.equal((await call(s.path,{cookie:s.cookie})).status,410);
 });
 await t.test('a non-admin, account without MFA and excess OAuth scopes cannot obtain admin sessions',async()=>{
  const n=(await db.prepare('SELECT COUNT(*) n FROM admin_sessions').first()).n;user=B;const denied=await login();assert.ok(!denied.cookie);assert.equal(denied.done.r.headers.get('location'),'/admin?error=admin_access_denied');user=A;mfa=false;const noMfa=await login();assert.ok(!noMfa.cookie);assert.equal(noMfa.done.r.headers.get('location'),'/admin?error=admin_mfa_required');mfa=true;scope='identify email';const wrong=await login();assert.ok(!wrong.cookie);scope='identify';assert.equal((await db.prepare('SELECT COUNT(*) n FROM admin_sessions').first()).n,n);assert.equal(revokes,4);
 });
 const mutate=(path,data,method='POST',headers={})=>call(path,{method,data,cookie:owner.cookie,headers:{origin,'x-csrf-token':csrf,...headers}});
 const draft={key:randomUUID(),id:'admin-fixture',name:'Safe <script>globalThis.bad=1</script>',description:'Stored as text, never HTML.',art:'spark',price:75,available:true};
 await t.test('all writes require same-origin, exact CSRF binding and strict JSON fields; no side effects on denial',async()=>{
  for(const headers of [{origin:'https://evil.test'},{origin:'null'},{origin:'https://api.syncord.pro.evil.test'},{'x-csrf-token':random()},{'sec-fetch-site':'same-site'}])assert.equal((await mutate('/admin/api/badges',draft,'POST',headers)).status,403);
  assert.equal((await call('/admin/api/badges',{method:'POST',data:draft,cookie:owner.cookie,headers:{origin}})).status,403);
  assert.equal((await mutate('/admin/api/badges',{...draft,balance:100000})).status,400);assert.equal((await mutate('/admin/api/badges',{...draft,art:'https://evil.test/x.svg'})).status,400);assert.equal((await mutate('/admin/api/badges',{...draft,price:0})).status,400);assert.equal((await mutate('/admin/api/badges',{...draft,id:"x';DROP TABLE badges;--"})).status,400);
  const large=await mutate('/admin/api/badges',{...draft,svg:'<svg viewBox="0 0 24 24">'+' '.repeat(524288)+'</svg>'});assert.equal(large.status,413);
  assert.equal((await call('/admin/api/badges',{method:'POST',raw:'{}',cookie:owner.cookie,headers:{origin,'x-csrf-token':csrf,'content-type':'application/jsonp'}})).status,415);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM badges WHERE supporter_tier=0').first()).n,4);assert.equal((await db.prepare('SELECT COUNT(*) n FROM badges WHERE supporter_tier>0').first()).n,3);
 });
 await t.test('concurrent duplicate create is atomic and audited once; key cannot be reassigned',async()=>{
  const responses=await Promise.all([mutate('/admin/api/badges',draft),mutate('/admin/api/badges',draft),mutate('/admin/api/badges',draft)]);assert.ok(responses.every(r=>r.status===200),JSON.stringify(responses));assert.equal((await db.prepare('SELECT COUNT(*) n FROM admin_audit WHERE request_key=?').bind(draft.key).first()).n,1);assert.equal((await db.prepare('SELECT revision FROM badges WHERE id=?').bind(draft.id).first()).revision,1);
  assert.equal((await mutate('/admin/api/badges',{...draft,price:76})).status,409);assert.equal((await mutate('/admin/api/badges',{...draft,key:randomUUID()})).status,409);assert.equal((await call('/v1/catalog')).value.find(b=>b.id===draft.id).price,75);
 });
 await t.test('optimistic revision prevents lost updates, failed changes produce no audit, and retries remain safe',async()=>{
  const {id,...rest}=draft,data={...rest,key:randomUUID(),revision:1,price:80};const other={...data,key:randomUUID(),price:90};const results=await Promise.all([mutate('/admin/api/badges/'+id,data,'PUT'),mutate('/admin/api/badges/'+id,other,'PUT')]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const winner=results[0].status===200?data:other;assert.equal((await mutate('/admin/api/badges/'+id,winner,'PUT')).status,200);const row=await db.prepare('SELECT * FROM badges WHERE id=?').bind(id).first();assert.equal(row.revision,2);assert.equal(row.price,winner.price);assert.equal((await db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='badge.update'").first()).n,1);
 });
 await t.test('taking an owned badge off sale preserves official ownership and ledger; physical deletion stays forbidden',async()=>{
  await db.prepare('INSERT INTO accounts(id,username,created_at) VALUES(?,?,?)').bind(B,'Fixture',Date.now()).run();await db.prepare('UPDATE wallets SET balance=50 WHERE account_id=?').bind(B).run();await db.prepare('INSERT INTO purchases(id,account_id,badge_id,price,request_key,created_at) VALUES(?,?,?,?,?,?)').bind(randomUUID(),B,'first-light',25,randomUUID(),Date.now()).run();await db.prepare('UPDATE owned_badges SET active=1 WHERE account_id=?').bind(B).run();
  const badge=(await call('/admin/api/badges',{cookie:owner.cookie})).value.find(b=>b.id==='first-light');const {owners,available,revision,id,is_deleted,...data}=badge;
  assert.equal(owners,1);const retired=await mutate('/admin/api/badges/'+id,{...data,available:false,revision,key:randomUUID()},'PUT');assert.equal(retired.status,200,JSON.stringify(retired.value));assert.ok(!(await call('/v1/catalog')).value.some(b=>b.id===id));assert.equal((await call('/v1/badges/lookup',{method:'POST',data:{ids:[B]}})).value[B][0].id,id);
  await assert.rejects(db.prepare('DELETE FROM badges WHERE id=?').bind(id).run(),/admin_soft_delete_required/);assert.equal((await db.prepare('SELECT balance FROM wallets WHERE account_id=?').bind(B).first()).balance,25);assert.equal((await db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='badge.delete'").first()).n,0);
 });
 await t.test('unused badge deletion is safe to retry and leaves an immutable audit trail',async()=>{
  const data={key:randomUUID(),revision:2};const concurrent=await Promise.all(Array.from({length:3},()=>mutate('/admin/api/badges/'+draft.id,data,'DELETE')));assert.ok(concurrent.every(r=>r.status===200),JSON.stringify(concurrent));assert.equal((await mutate('/admin/api/badges/'+draft.id,data,'DELETE')).status,200);assert.equal((await db.prepare('SELECT * FROM badges WHERE id=?').bind(draft.id).first()).is_deleted,1);assert.ok(!(await call('/admin/api/badges',{cookie:owner.cookie})).value.some(b=>b.id===draft.id));assert.equal((await db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='badge.delete'").first()).n,1);
  await assert.rejects(db.prepare('DELETE FROM admin_audit').run(),/admin_audit_immutable/);await assert.rejects(db.prepare("UPDATE admin_audit SET actor_id='forged'").run(),/admin_audit_immutable/);
 });
 await t.test('account/ledger/audit reads are bounded and contain no credential/session data',async()=>{
  const accounts=await call('/admin/api/accounts',{cookie:owner.cookie});assert.equal(accounts.value.entries[0].id,B);const ledger=await call('/admin/api/accounts/'+B+'/transactions',{cookie:owner.cookie});assert.equal(ledger.value.entries.length,1);assert.equal(ledger.value.entries[0].delta,-25);
  const audit=await call('/admin/api/audit',{cookie:owner.cookie});assert.ok(audit.value.entries.length>=5);assert.ok(audit.value.entries.length<=50);assert.ok(!JSON.stringify(audit.value).includes(owner.cookie.split('=')[1]));assert.ok(!JSON.stringify(audit.value).includes(csrf));assert.equal((await call('/admin/api/audit?before=not-a-number',{cookie:owner.cookie})).status,400);
 });
 await t.test('login, account reads and writes have independent enforced quotas',async()=>{
  await db.prepare('DELETE FROM request_limits').run();
  for(let i=0;i<6;i++)assert.equal((await call('/admin/login',{method:'POST',headers:{origin,'cf-connecting-ip':'198.51.100.250'}})).status,i<5?303:429);
  for(let i=0;i<91;i++)assert.equal((await call('/admin/api/me',{cookie:owner.cookie})).status,i<90?200:429);
  for(let i=0;i<21;i++)assert.equal((await mutate('/admin/api/badges',{...draft,unexpected:true})).status,i<20?400:429);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='badge.create'").first()).n,1);
  await db.prepare('DELETE FROM request_limits').run();
 });
 await t.test('cookie expiry/revocation, CSRF logout and duplicate-cookie refusal close sessions',async()=>{
  assert.equal((await call('/admin/api/me',{cookie:owner.cookie+'; '+owner.cookie})).status,401);assert.equal((await call('/admin/logout',{method:'POST',cookie:owner.cookie,headers:{origin}})).status,403);
  const other=await login();await db.prepare('UPDATE admin_sessions SET expires_at=0 WHERE hash=?').bind(hash(other.cookie.split('=')[1])).run();assert.equal((await call('/admin/api/me',{cookie:other.cookie})).status,401);
  const logout=await mutate('/admin/logout',undefined);assert.equal(logout.status,204);assert.match(logout.r.headers.get('set-cookie'),/Max-Age=0/);assert.equal((await call('/admin/api/me',{cookie:owner.cookie})).status,401);
 });
 }finally{await mf.dispose();}
});
