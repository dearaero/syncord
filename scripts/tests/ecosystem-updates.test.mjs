import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {realpathSync} from 'node:fs';
import {build} from 'esbuild';
const req=createRequire(realpathSync('services/ecosystem/node_modules/wrangler/package.json'));
const {Miniflare,convertV4MiniflareOptions}=req('miniflare');
const origin='https://api.syncord.pro';
const options=(bundled,extra)=>convertV4MiniflareOptions({modules:true,script:bundled,compatibilityDate:'2026-10-17',d1Databases:['DB'],bindings:{PUBLIC_ORIGIN:origin,DISCORD_CLIENT_ID:'1554184140704841939',DISCORD_CLIENT_SECRET:'fixture'},...extra});
test('update feed serves only validated release paths from the private bucket',{timeout:60000},async t=>{
 const bundled=(await build({entryPoints:['services/ecosystem/src/index.ts'],bundle:true,platform:'browser',format:'esm',write:false,logLevel:'silent'})).outputFiles[0].text;
 const mf=new Miniflare(options(bundled,{r2Buckets:['RELEASES']})),bare=new Miniflare(options(bundled,{}));
 try{
  const bucket=await mf.getR2Bucket('RELEASES'),archive=Buffer.from('payload-bytes'),name='syncord-1.2.3-mac-arm64.tar.gz';
  await bucket.put('channels/stable.json','{"signed":true}');await bucket.put('releases/1.2.3/'+name,archive);await bucket.put('secret.txt','nope');
  const get=(path,init)=>mf.dispatchFetch(origin+path,{redirect:'manual',...init});
  await t.test('descriptor and asset are served with hardening headers',async()=>{
   const feed=await get('/v1/update/stable');assert.equal(feed.status,200);assert.equal(await feed.text(),'{"signed":true}');assert.match(feed.headers.get('content-type'),/^application\/json/);assert.equal(feed.headers.get('x-content-type-options'),'nosniff');
   const asset=await get('/v1/update/releases/1.2.3/'+name);assert.equal(asset.status,200);assert.deepEqual(Buffer.from(await asset.arrayBuffer()),archive);assert.equal(asset.headers.get('content-length'),String(archive.length));
   const head=await get('/v1/update/stable',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
  });
  await t.test('anything that is not a channel or a Syncord bundle name is a 404 before the bucket is read',async()=>{
   for(const path of ['/v1/update/nightly','/v1/update/stable/extra','/v1/update/releases/1.2.3/secret.txt','/v1/update/releases/v1.2.3/'+name,'/v1/update/releases/..%2F/'+name,'/v1/update/releases/1.2.3/..%2Fsecret.txt','/v1/update/releases/1.2.3/syncord-%2e%2e.tar.gz','/v1/update/channels/stable.json'])assert.equal((await get(path)).status,404,path);
   assert.equal((await get('/v1/update/releases/9.9.9/'+name)).status,404);
  });
  await t.test('only GET and HEAD are accepted, and no credentials or cookies are involved',async()=>{
   for(const method of ['POST','PUT','DELETE'])assert.equal((await get('/v1/update/stable',{method})).status,405);
   assert.equal((await get('/v1/update/stable')).headers.get('set-cookie'),null);
  });
  await t.test('without the bucket binding the route fails closed instead of throwing',async()=>{
   const response=await bare.dispatchFetch(origin+'/v1/update/stable');assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'updates_unconfigured'});
  });
 }finally{await mf.dispose();await bare.dispose();}
});
