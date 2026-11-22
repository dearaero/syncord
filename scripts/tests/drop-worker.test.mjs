import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {createRequire} from 'node:module';import {readFileSync,readdirSync,realpathSync} from 'node:fs';import {createHash,randomBytes} from 'node:crypto';
const req=createRequire(realpathSync('services/ecosystem/node_modules/wrangler/package.json')),{Miniflare,convertV4MiniflareOptions}=req('miniflare'),{unstable_splitSqlQuery}=req('wrangler');
const A='100000000000000001',B='100000000000000002',C='100000000000000003',origin='https://api.syncord.pro';
test('Drop real Worker/D1: authenticated participants, consent, bounded invitations, SDP roles, replay/expiry, metadata-only storage',{timeout:60000},async t=>{
 const bundle=await build({entryPoints:['services/ecosystem/src/index.ts'],bundle:true,platform:'browser',format:'esm',write:false,logLevel:'silent'});
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-17',d1Databases:['DB'],bindings:{DISCORD_CLIENT_ID:A,DISCORD_CLIENT_SECRET:'fixture-only',PUBLIC_ORIGIN:origin},outboundService:()=>{throw Error('Drop must not call Discord or move file content');}}));
 try{
 const db=await mf.getD1Database('DB');for(const file of readdirSync('services/ecosystem/migrations').filter(n=>n.endsWith('.sql')).sort())await db.batch(unstable_splitSqlQuery(readFileSync('services/ecosystem/migrations/'+file,'utf8')).map(s=>db.prepare(s)));
 const sessions={};for(const id of [A,B,C]){const token=randomBytes(32).toString('hex');sessions[id]=token;await db.prepare('INSERT INTO accounts(id,username,created_at) VALUES(?,?,?)').bind(id,id,Date.now()).run();await db.prepare('INSERT INTO sessions(hash,account_id,created_at,expires_at) VALUES(?,?,?,?)').bind(createHash('sha256').update(token).digest('hex'),id,Date.now(),Date.now()+86400000).run();}
 const readiness=await mf.dispatchFetch(origin+'/health');assert.equal(readiness.status,200);const features=(await readiness.json()).features;assert.equal(features.drop,1);assert.equal(features.dropInbox,1);assert.equal(features.dropPresence,1);
 const landing=await mf.dispatchFetch(origin+'/drop/12345678-1234-4123-8123-123456789abc');assert.equal(landing.status,200);assert.match(landing.headers.get('content-type'),/text\/plain/);assert.ok(!(await landing.text()).includes('özel.zip'));
 let n=0;const call=async(path,actor=A,data,method=data===undefined?'GET':'POST')=>{const r=await mf.dispatchFetch(origin+path,{method,headers:{'cf-connecting-ip':'192.0.2.'+(++n),...(actor?{authorization:'Bearer '+sessions[actor]}:{}),...(data?{'content-type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});return{status:r.status,body:await r.json()};};
 const invite=()=>call('/v1/drop/invites',A,{receiver:B,name:'özel.zip',size:2*1024**3+1});
 assert.equal((await call('/v1/drop/invites',null,{receiver:B,name:'x',size:5})).status,401);
 const lease='12345678-1234-4123-8123-123456789abc';
 const availability=(actor,active=true,key=lease)=>call('/v1/drop/inbox',actor,{lease:key,available:active});
 assert.deepEqual((await invite()).body,{error:'drop.recipient_unavailable'},'a linked account alone is not an active plugin');
 assert.equal((await call('/v1/drop/inbox',null,{lease,available:true})).status,401);
 assert.equal((await call('/v1/drop/inbox',B,{lease,available:'true'})).status,400);
 assert.equal((await call('/v1/drop/inbox',B,{lease,available:true,account_id:C})).status,400);
 assert.equal((await availability(B)).status,200);
 await availability(C,false);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM drop_presence WHERE account_id=?').bind(B).first()).n,1,'another account cannot revoke the receiver');
 const created=await invite();assert.equal(created.status,201,JSON.stringify(created));const id=created.body.id,path='/v1/drop/'+id;
 assert.equal((await call('/v1/drop/inbox',null)).status,401);
 assert.deepEqual((await call('/v1/drop/inbox',A)).body,[]);
 assert.deepEqual((await call('/v1/drop/inbox',C)).body,[]);
 const inbox=await call('/v1/drop/inbox',B);assert.equal(inbox.status,200);assert.equal(inbox.body.length,1);assert.equal(inbox.body[0].id,id);assert.equal(inbox.body[0].receiver,B);assert.equal(inbox.body[0].offer,undefined);
 assert.equal(created.body.sender,A);assert.equal(created.body.receiver,B);assert.equal((await call(path,C)).status,404);assert.equal((await call(path+'/accept',A,{})).status,403);
 const sdp='v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 '+Array(32).fill('AB').join(':')+'\r\n';
 assert.equal((await call(path+'/offer',A,{sdp})).status,409);assert.equal((await call(path+'/accept',B,{})).body.state,'accepted');assert.equal((await call(path+'/offer',B,{sdp})).status,409);assert.deepEqual((await call('/v1/drop/inbox',B)).body,[]);
 assert.equal((await call(path+'/offer',A,{sdp})).status,200);assert.equal((await call(path,B)).body.offer,sdp);assert.equal((await call(path+'/answer',B,{sdp})).status,200);
 assert.equal((await call(path+'/connected',A,{})).body.state,'connected');const connected=await db.prepare('SELECT * FROM drop_invites WHERE id=?').bind(id).first();assert.equal(connected.offer,null);assert.equal(connected.answer,null);
 assert.equal((await call(path+'/accept',B,{})).status,409);assert.equal((await call(path+'/cancel',B,{})).body.state,'cancelled');assert.equal((await call(path+'/offer',A,{sdp})).status,409);
 const declined=await invite();assert.equal((await call('/v1/drop/'+declined.body.id+'/decline',B,{})).body.state,'declined');assert.equal((await call('/v1/drop/'+declined.body.id+'/accept',B,{})).status,409);assert.deepEqual((await call('/v1/drop/inbox',B)).body,[]);
 assert.equal((await call('/v1/drop/invites',A,{receiver:B,name:'../bad',size:10})).status,400);assert.equal((await call('/v1/drop/invites',A,{receiver:B,name:'x',size:10,fileBytes:'forbidden'})).status,400);
 const exp=await invite();await db.prepare('UPDATE drop_invites SET expires=0 WHERE id=?').bind(exp.body.id).run();assert.equal((await call('/v1/drop/'+exp.body.id,B)).status,404);
 // Stop after creation: the next sender view cancels, rather than waiting ten minutes.
 const stopped=await invite();await availability(B,false);
 assert.deepEqual((await call('/v1/drop/'+stopped.body.id,A)).body,{error:'drop.recipient_unavailable'});
 assert.equal((await db.prepare('SELECT state FROM drop_invites WHERE id=?').bind(stopped.body.id).first()).state,'cancelled');
 assert.equal((await invite()).body.error,'drop.recipient_unavailable');
 // Separate documents/devices own independent leases.
 const second='12345678-1234-4123-8123-123456789abd';await availability(B);await availability(B,true,second);await availability(B,false);
 assert.equal((await invite()).status,201);await availability(B,false,second);
 await availability(B);await db.prepare('UPDATE drop_presence SET expires=0 WHERE account_id=?').bind(B).run();assert.equal((await invite()).body.error,'drop.recipient_unavailable','crash leases expire');
 await availability(B);await db.prepare('UPDATE sessions SET revoked=1 WHERE account_id=?').bind(B).run();assert.equal((await invite()).body.error,'drop.recipient_unavailable','revoked sessions cannot receive');await db.prepare('UPDATE sessions SET revoked=0 WHERE account_id=?').bind(B).run();
 // A session cannot withdraw another authenticated session's lease, even on the same account.
 const token2=randomBytes(32).toString('hex');await db.prepare('INSERT INTO sessions(hash,account_id,created_at,expires_at) VALUES(?,?,?,?)').bind(createHash('sha256').update(token2).digest('hex'),B,Date.now(),Date.now()+86400000).run();
 const original=sessions[B];sessions[B]=token2;await availability(B,false);sessions[B]=original;
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM drop_presence WHERE account_id=? AND expires>?').bind(B,Date.now()).first()).n,1);
 for(let i=0;i<7;i++)assert.equal((await availability(B,true,'12345678-1234-4123-8123-'+String(i).padStart(12,'0'))).status,200);
 assert.equal((await availability(B,true,'12345678-1234-4123-8123-999999999999')).status,429);assert.equal((await availability(B)).status,200,'existing leases renew at the document cap');
 const attempts=await Promise.all(Array.from({length:15},invite));assert.ok(attempts.filter(r=>r.status===201).length<=4);assert.ok(attempts.some(r=>r.status===429));
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM drop_invites WHERE sender=? AND state IN (\'pending\',\'accepted\') AND expires>?').bind(A,Date.now()).first()).n<=4,true);
 assert.ok((await call('/v1/drop/inbox',B)).body.length<=8);
 const fields=(await db.prepare('PRAGMA table_info(drop_invites)').all()).results.map(x=>x.name);assert.ok(!fields.some(n=>/bytes|path|token|content|blob/.test(n)));
 }finally{await mf.dispose();}
});
