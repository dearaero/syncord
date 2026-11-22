import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
const dir=mkdtempSync(path.join(tmpdir(),'syncord-svg-'));
await build({stdin:{resolveDir:process.cwd(),contents:"export {sanitizeBadgeSvg} from './services/ecosystem/src/svg';export {body} from './services/ecosystem/src/http';"},bundle:true,platform:'browser',format:'esm',outfile:path.join(dir,'svg.mjs'),logLevel:'silent'});
const {sanitizeBadgeSvg,body}=await import(pathToFileURL(path.join(dir,'svg.mjs')).href);rmSync(dir,{recursive:true,force:true});
const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><linearGradient id="paint"><stop stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><style>.paint {fill:url(#paint);stroke-width:2}</style><path class="paint" d="M1 1h20v20H1z"/></svg>';
const digest=s=>createHash('sha256').update(s).digest('hex');
const limit=512*1024;
const fullSvg=()=>{const frame='<svg xmlns="http://www.w3.org/2000/svg" height="32" viewBox="0 0 24 24" width="32"><desc></desc><circle cx="12" cy="12" r="10"></circle></svg>';return frame.replace('<desc>','<desc>'+'a'.repeat(limit-Buffer.byteLength(frame)));};
test('SVG accepts exactly 512 KiB in both source and canonical form and counts UTF-8 bytes',()=>{
 const source=fullSvg();assert.equal(Buffer.byteLength(source),limit);assert.equal(sanitizeBadgeSvg(source),source);
 assert.throws(()=>sanitizeBadgeSvg(source.replace('<desc>','<desc>a')),e=>e.status===413);
 assert.throws(()=>sanitizeBadgeSvg(source.replace(/a/g,'é')),e=>e.status===413);
});

test('SVG static profile parses namespaces, gradients and presentation CSS into a canonical inert document',()=>{
 const safe=sanitizeBadgeSvg(svg);assert.ok(safe.includes('fill="url(#paint)"'));assert.ok(!safe.includes('<style'));assert.equal(sanitizeBadgeSvg(safe),safe);
 assert.match(sanitizeBadgeSvg('<svg width="32" height="32"><path style="fill:currentColor" d="M0 0h4v4z"/></svg>'),/viewBox="0 0 32 32"/);
 const use='<svg viewBox="0 0 24 24" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><path id="shape" d="M0 0h2v2z"/></defs><use xlink:href="#shape"/></svg>';assert.ok(sanitizeBadgeSvg(use).includes('href="#shape"'));
 const title=sanitizeBadgeSvg('<svg viewBox="0 0 1 1"><title>&lt;img onerror=bad()&gt;</title></svg>');assert.ok(title.includes('&lt;img'));
 const editor=sanitizeBadgeSvg('<svg xmlns="http://www.w3.org/2000/svg" xmlns:rdf="urn:rdf" viewBox="0 0 24 24" width="10mm"><metadata><rdf:record>Editor details</rdf:record></metadata><circle cx="12" cy="12" r="10"/></svg>');assert.ok(!editor.includes('metadata'));assert.ok(editor.includes('width="32"'));
 assert.ok(sanitizeBadgeSvg('<svg viewBox="0 0 24 24"><defs><mask id="m" style="mask-type:alpha"><rect width="24" height="24" fill="white"/></mask></defs><path mask="url(#m)" d="M0 0h24v24z"/></svg>').includes('mask-type="alpha"'));
});
test('SVG parser rejects active/remote content, entity tricks, invalid XML, reference cycles and resource exhaustion',()=>{
 const wrap=s=>'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">'+s+'</svg>';
 for(const source of [
  wrap('<script>alert(1)</script>'),wrap('<foreignObject><div>bad</div></foreignObject>'),wrap('<image href="https://evil.test/x"/>'),wrap('<animate attributeName="href" values="https://evil.test"/>'),
  '<svg viewBox="0 0 24 24" onload="bad()"/>',wrap('<path fill="url(&#104;ttps://evil.test/x)"/>'),wrap('<use href="data:image/svg+xml,evil"/>'),wrap('<use href="//evil.test/x"/>'),wrap('<style>@import "https://evil.test";</style>'),wrap('<style>.p{fill:u\\72l(https://evil.test)}</style>'),
  '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>'+wrap('<title>&x;</title>'),'<?xml-stylesheet href="https://evil.test/x"?>'+wrap(''),wrap('<g></svg>'),'<svg xmlns="http://www.w3.org/1999/xhtml" viewBox="0 0 1 1"/>',
  wrap('<use id="self" href="#self"/>'),wrap('<use href="#missing"/>'),wrap('<g id="same"/><g id="same"/>'),wrap('<g>'.repeat(33)+'</g>'.repeat(33)),wrap('<path/>'.repeat(1025)),wrap('<filter id="f"><feGaussianBlur stdDeviation="999999"/></filter>'),wrap('<path d="M1e999 0"/>'),'<svg viewBox="0 0 -1 1"/>',
 ])assert.throws(()=>sanitizeBadgeSvg(source),e=>e.code==='admin_invalid_svg',source.slice(0,100));
 assert.throws(()=>sanitizeBadgeSvg(wrap(' '.repeat(524288))),e=>e.status===413);
 const expanded=wrap('<style>.a{stroke-dasharray:'+('1 '.repeat(1000))+'}</style>'+'<path class="a" d="M0 0h1"/>'.repeat(300));assert.throws(()=>sanitizeBadgeSvg(expanded),e=>e.status===413,'canonical CSS expansion stays bounded');
});
test('SVG uploads use a bounded JSON envelope without changing the desktop API body limit',async()=>{
 const request=size=>new Request('https://api.syncord.pro/admin/api/badges',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({svg:'a'.repeat(size)})});
 await assert.rejects(body(request(17000)),e=>e.status===413);
 await assert.rejects(body(request(524288*2+4097),524288*2+4096),e=>e.status===413);
 assert.equal((await body(request(524288),524288*2+4096)).svg.length,524288);
});

const require=createRequire(realpathSync('services/ecosystem/node_modules/wrangler/package.json'));
const {Miniflare,convertV4MiniflareOptions}=require('miniflare'),{unstable_splitSqlQuery}=require('wrangler');
const origin='https://api.syncord.pro',A='1554184140704841939';
test('SVG Worker/D1: authorized atomic upload, immutable images, retries, rollback and official ownership',{timeout:30000},async()=>{
 const bundle=await build({entryPoints:['services/ecosystem/src/index.ts'],bundle:true,platform:'browser',format:'esm',write:false,logLevel:'silent'});
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-17',d1Databases:['DB'],bindings:{PUBLIC_ORIGIN:origin,DISCORD_CLIENT_ID:A,DISCORD_CLIENT_SECRET:'fixture',ADMIN_DISCORD_IDS:A},outboundService:async r=>{
  const p=new URL(r.url).pathname;if(p==='/api/oauth2/token')return Response.json({access_token:'fixture',token_type:'Bearer',scope:'identify'});if(p==='/api/v10/users/@me')return Response.json({id:A,username:'Fixture',mfa_enabled:true});if(p==='/api/oauth2/token/revoke')return new Response(null);throw Error('Unexpected provider route');
 }}));
 try{
  const db=await mf.getD1Database('DB');for(const file of readdirSync('services/ecosystem/migrations').filter(f=>f.endsWith('.sql')).sort())await db.batch(unstable_splitSqlQuery(readFileSync('services/ecosystem/migrations/'+file,'utf8')).map(s=>db.prepare(s)));
  const login=await mf.dispatchFetch(origin+'/admin/login',{method:'POST',headers:{origin},redirect:'manual'}),state=new URL(login.headers.get('location')).searchParams.get('state');
  const callback=await mf.dispatchFetch(origin+'/oauth/callback?state='+state+'&code=fixture&iss=https%3A%2F%2Fdiscord.com',{headers:{cookie:login.headers.get('set-cookie').split(';')[0]},redirect:'manual'});
  const cookie=callback.headers.getSetCookie().find(c=>c.startsWith('__Host-syncord-admin=')).split(';')[0];
  const me=await(await mf.dispatchFetch(origin+'/admin/api/me',{headers:{cookie}})).json();
  // Explicit framing preserves large-body 401/403 assertions when Miniflare replies before its proxy finishes the upload.
  const call=async(route,method='GET',data,headers={})=>{const r=await mf.dispatchFetch(origin+route,{method,redirect:'manual',headers:{...(data?{'content-type':'application/json','content-length':String(Buffer.byteLength(JSON.stringify(data)))}:{}),...headers},...(data?{body:JSON.stringify(data)}:{})});return{r,status:r.status,value:r.headers.get('content-type')?.includes('json')?await r.json():await r.text()};};
  const mutate=(route,data,method='POST',headers={})=>call(route,method,data,{cookie,origin,'x-csrf-token':me.csrf,...headers});
  const draft={id:'uploaded',key:randomUUID(),name:'Uploaded',description:'A file',art:'spark',price:25,available:true,svg:fullSvg()};
  // Authentication is independent of SVG size; the authorized request below exercises the full 512 KiB boundary.
  // A small unauthorized body avoids Miniflare's early-response upload EPIPE transport race.
  const unauthorized={...draft,svg:'<svg viewBox="0 0 1 1"/>'};
  assert.equal((await call('/admin/api/badges','POST',unauthorized)).status,401);assert.equal((await mutate('/admin/api/badges',unauthorized,'POST',{'x-csrf-token':'0'.repeat(64)})).status,403);assert.equal((await db.prepare('SELECT COUNT(*) n FROM badge_art').first()).n,0);
  const unsafe=await mutate('/admin/api/badges',{...draft,svg:'<svg viewBox="0 0 1 1" onload="bad()"/>'});assert.equal(unsafe.status,400);assert.equal(unsafe.value.error,'admin_invalid_svg');
  assert.equal((await mutate('/admin/api/badges',{...draft,svg:' '.repeat(524289)})).status,413);
  const created=await mutate('/admin/api/badges',draft);assert.equal(created.status,200,JSON.stringify(created.value));const image=digest(fullSvg());assert.equal(created.value.item.image,image);assert.ok(!('svg' in created.value.item));assert.equal((await mutate('/admin/api/badges',draft)).value.replayed,true);
  const asset=await call('/v1/badge-art/'+image+'.svg');assert.equal(asset.status,200);assert.equal(asset.value,fullSvg());assert.equal(asset.r.headers.get('content-type'),'image/svg+xml; charset=utf-8');assert.ok(asset.r.headers.get('content-security-policy').includes('sandbox'));assert.ok(asset.r.headers.get('cache-control').includes('immutable'));assert.equal(asset.r.headers.get('cross-origin-resource-policy'),'cross-origin');assert.equal(asset.r.headers.get('access-control-allow-origin'),'*');
  const catalog=(await call('/v1/catalog')).value.find(b=>b.id==='uploaded');assert.equal(catalog.image,image);assert.ok(!JSON.stringify(catalog).includes('<svg'));
  await db.prepare('INSERT INTO accounts(id,username,created_at) VALUES(?,?,?)').bind(A,'Owner',Date.now()).run();await db.prepare("INSERT INTO reward_grants VALUES(?,?,'verified-welcome',?,50,?)").bind(randomUUID(),A,A,Date.now()).run();await db.prepare('INSERT INTO purchases VALUES(?,?,?,?,?,?)').bind(randomUUID(),A,'uploaded',25,randomUUID(),Date.now()).run();await db.prepare('UPDATE owned_badges SET active=1 WHERE account_id=?').bind(A).run();
  assert.equal((await call('/v1/badges/lookup','POST',{ids:[A]})).value[A][0].image,image);
  const {id,key,...fields}=draft;delete fields.svg;
  assert.equal((await mutate('/admin/api/badges/uploaded',{...fields,key:randomUUID(),revision:1,image:'f'.repeat(64)},'PUT')).status,409);
  const changed='<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#abcdef"/></svg>',newImage=digest(sanitizeBadgeSvg(changed));
  const edit={...fields,key:randomUUID(),revision:1,svg:changed};assert.equal((await mutate('/admin/api/badges/uploaded',edit,'PUT')).status,200);assert.equal((await mutate('/admin/api/badges/uploaded',edit,'PUT')).value.replayed,true);
  assert.equal((await call('/v1/badges/lookup','POST',{ids:[A]})).value[A][0].image,newImage);assert.equal((await call('/v1/badge-art/'+image+'.svg')).status,200,'old audit artwork stays available');
  const before=(await db.prepare('SELECT COUNT(*) n FROM badge_art').first()).n;
  assert.equal((await mutate('/admin/api/badges/uploaded',{...edit,key:randomUUID(),svg:changed.replace('#abcdef','#111111')},'PUT')).status,409);assert.equal((await db.prepare('SELECT COUNT(*) n FROM badge_art').first()).n,before,'stale edit cannot orphan an asset');
  assert.equal((await mutate('/admin/api/badges/uploaded',{...fields,key:randomUUID(),revision:2,image:newImage,available:false},'PUT')).status,200);assert.equal((await db.prepare('SELECT balance FROM wallets WHERE account_id=?').bind(A).first()).balance,25);assert.equal((await db.prepare('SELECT COUNT(*) n FROM ledger').first()).n,2);
  assert.equal((await mutate('/admin/api/badges/uploaded',{...fields,key:randomUUID(),revision:3,image:null},'PUT')).status,200);assert.equal((await call('/v1/badges/lookup','POST',{ids:[A]})).value[A][0].image,null,'built-in artwork can be restored');
  assert.equal((await mutate('/admin/api/badges/uploaded',{key:randomUUID(),revision:4},'DELETE')).status,200);assert.equal((await db.prepare("SELECT is_deleted FROM badges WHERE id='uploaded'").first()).is_deleted,1);assert.deepEqual((await call('/v1/badges/lookup','POST',{ids:[A]})).value[A],[]);
  assert.equal((await mutate('/admin/api/badges',{...draft,id:'shared-image',key:randomUUID(),svg:changed})).status,200);assert.equal((await db.prepare('SELECT COUNT(*) n FROM badge_art').first()).n,before,'art is deduplicated by canonical hash');
  await assert.rejects(db.prepare('UPDATE badge_art SET svg=\'bad\'').run(),/admin_art_immutable/);await assert.rejects(db.prepare('DELETE FROM badge_art').run(),/admin_art_immutable/);
  assert.equal((await call('/v1/badge-art/'+'0'.repeat(64)+'.svg')).status,404);
 }finally{await mf.dispose();}
});

test('512 KiB schema upgrade preserves referenced historical artwork and immutable/soft-delete guards',{timeout:30000},async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-10-17',d1Databases:['DB']}));
 try{
  const db=await mf.getD1Database('DB'),files=readdirSync('services/ecosystem/migrations').filter(f=>f.endsWith('.sql')).sort();
  const migrate=async file=>db.batch(unstable_splitSqlQuery(readFileSync('services/ecosystem/migrations/'+file,'utf8')).map(s=>db.prepare(s)));
  for(const file of files.filter(f=>f<'0005'))await migrate(file);
  const safe=sanitizeBadgeSvg(svg),id=digest(safe);
  await db.prepare('INSERT INTO badge_art VALUES(?,?,123)').bind(id,safe).run();
  await db.prepare("UPDATE badges SET image=? WHERE id='first-light'").bind(id).run();
  await db.prepare("UPDATE badges SET is_deleted=1,available=0 WHERE id='first-light'").run();
  for(const file of files.filter(f=>f>='0005'))await migrate(file);
  assert.deepEqual(await db.prepare('SELECT * FROM badge_art WHERE id=?').bind(id).first(),{id,svg:safe,created_at:123});
  const badge=await db.prepare("SELECT image,is_deleted FROM badges WHERE id='first-light'").first();assert.deepEqual(badge,{image:id,is_deleted:1});
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  await assert.rejects(db.prepare('UPDATE badge_art SET svg=svg').run(),/admin_art_immutable/);
  await assert.rejects(db.prepare('DELETE FROM badge_art').run(),/admin_art_immutable/);
  await assert.rejects(db.prepare("DELETE FROM badges WHERE id='first-light'").run(),/admin_soft_delete_required/);
  await db.prepare('INSERT INTO badge_art VALUES(?,?,456)').bind(digest(fullSvg()),fullSvg()).run();
  await assert.rejects(db.prepare('INSERT INTO badge_art VALUES(?,?,456)').bind('f'.repeat(64),fullSvg()+'a').run(),/CHECK constraint/);
 }finally{await mf.dispose();}
});
