import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {PNG} from 'pngjs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {createServer} from 'node:https';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,realpathSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
const root=process.cwd(),origin='https://api.syncord.pro',A='1554184140704841939',B='1554184140704841940';
const require=createRequire(realpathSync('services/ecosystem/node_modules/wrangler/package.json'));
const {Miniflare,convertV4MiniflareOptions}=require('miniflare'),{unstable_splitSqlQuery}=require('wrangler');
const electron=['Electron.app/Contents/MacOS/Electron','electron.exe','electron'].map(p=>path.join(root,'node_modules/electron/dist',p)).find(existsSync);

async function checks(){
 const $=id=>document.getElementById(id),pause=ms=>new Promise(r=>setTimeout(r,ms));
 const check=(ok,label)=>{if(!ok)throw Error(label);};
 const until=async(fn,label)=>{const start=Date.now();while(!fn()){if(Date.now()-start>5000)throw Error(label+' · '+$('status').textContent+' · '+$('confirm-error').textContent);await pause(15);}};
 const button=(scope,label)=>{const b=[...$(scope).querySelectorAll('button')].find(e=>e.textContent===label);check(b,'Missing '+label);b.click();};
 const card=id=>[...$('catalog').children].find(e=>e.querySelector('code')?.textContent===id);
 const edit=(name,value)=>{const e=$('badge-form').elements.namedItem(name);e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}));};
 const upload=async(source,name='badge.svg')=>{const dt=new DataTransfer();dt.items.add(new File([source],name,{type:'image/svg+xml'}));$('badge-svg').files=dt.files;$('badge-svg').dispatchEvent(new Event('change'));await until(()=>$('svg-name').textContent===name&&!$('badge-form').querySelector('[type=submit]').disabled,'SVG read/preview');};
 await until(()=>!$('workspace').hidden&&card('first-light'),'authenticated catalog');
 check($('admin-name').textContent.includes('<img'),'account name is text');check(!document.querySelector('#identity img'),'identity escaping');
 check(card('first-light').querySelector('img').naturalWidth>0,'CSP permits trusted badge artwork');
 const remove=[...card('first-light').querySelectorAll('button')].find(e=>e.textContent==='Delete');check(!remove.disabled,'owned badge supports soft deletion');
 $('new-badge').click();check($('svg-name').textContent.includes('512 KB'),'512 KB upload hint');const oversize=new DataTransfer();oversize.items.add(new File(['a'.repeat(524289)],'large.svg',{type:'image/svg+xml'}));$('badge-svg').files=oversize.files;$('badge-svg').dispatchEvent(new Event('change'));await until(()=>$('editor-error').textContent.includes('512 KB'),'over-limit file blocked');edit('id','ui-fixture');edit('name','Badge <img src=x onerror=bad()>');edit('description','Description <script>bad()</script>');edit('price','65');edit('art','shield');
 await upload('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" onload="top.__unsafeSvg=1"><image href="https://evil.test/svg-probe"/></svg>','unsafe.svg');await pause(30);check(!window.__unsafeSvg,'untrusted preview cannot execute scripts');
 $('badge-form').requestSubmit();$('confirm-submit').click();await until(()=>$('confirm-error').textContent.includes('SVG is invalid'),'unsafe upload rejected by Worker');$('confirm').close();
 await upload('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><desc>'+'a'.repeat(70000)+'</desc><circle cx="12" cy="12" r="10" fill="#abcdef"/></svg>');
 check($('preview-art').src.startsWith('data:image/svg+xml'),'file preview uses an isolated image');
 check($('preview-name').textContent.includes('<img')&&!$('preview-name').children.length,'preview escaping');
 edit('id','invalid id');$('badge-form').requestSubmit();check(!$('confirm').open,'invalid badge ID blocked by browser');edit('id','ui-fixture');
 $('badge-form').requestSubmit();check($('confirm').open&&!card('ui-fixture'),'review before create');$('confirm-submit').click();
 await until(()=>!!card('ui-fixture'),'created through real Worker');check(!card('ui-fixture').querySelector('script'),'description escaping');
 card('ui-fixture').scrollIntoView();await until(()=>card('ui-fixture').querySelector('img').naturalWidth>0,'uploaded image loads from Worker');check(/\/v1\/badge-art\/[a-f0-9]{64}\.svg$/.test(card('ui-fixture').querySelector('img').src),'stored SVG is content-addressed');
 check(card('ui-fixture').querySelectorAll('img').length===1&&card('ui-fixture').textContent.includes('<script>'),'name/description remain literal text');
 const firstImage=card('ui-fixture').querySelector('img').src;card('ui-fixture').querySelector('button').click();check($('badge-form').elements.namedItem('id').readOnly,'immutable ID');check($('preview-art').src===firstImage,'existing SVG is preserved when reopening');edit('price','70');$('badge-form').requestSubmit();$('confirm-submit').click();
 await until(()=>$('confirm-error').textContent.includes('could not be completed'),'lost successful write response');
 $('confirm-submit').click();await until(()=>!$('confirm').open&&card('ui-fixture').textContent.includes('70 SP'),'retry acknowledges same mutation');
 check(card('ui-fixture').querySelector('img').src===firstImage,'metadata edit retains uploaded image');
 button('catalog','Take off sale');$('confirm-submit').click();await until(()=>!$('confirm').open&&card('first-light').textContent.includes('Off sale'),'off sale');
 check(card('first-light').textContent.includes('Off sale'),'owned badge can be retired');
 card('first-light').querySelector('button').click();await upload('<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z" fill="#ff00ff"/></svg>','replacement.svg');$('badge-form').requestSubmit();$('confirm-submit').click();await until(()=>!$('confirm').open&&card('first-light').querySelector('img').src.includes('/v1/badge-art/'),'owned badge SVG updated');
 const pngBytes=new Uint8Array(await(await fetch('/__fixture/png')).arrayBuffer());
 const uploadPng=async()=>{const files=new DataTransfer();files.items.add(new File([pngBytes],'badge.png',{type:'image/png'}));$('badge-svg').files=files.files;$('badge-svg').dispatchEvent(new Event('change'));await until(()=>$('svg-name').textContent==='badge.png'&&!$('badge-form').querySelector('[type=submit]').disabled,'PNG selected');check($('preview-art').src.startsWith('data:image/png;base64,'),'local PNG preview');};
 card('first-light').querySelector('button').click();const tooLarge=new DataTransfer();tooLarge.items.add(new File([new Uint8Array(524289)],'oversize.png',{type:'image/png'}));$('badge-svg').files=tooLarge.files;$('badge-svg').dispatchEvent(new Event('change'));await until(()=>$('editor-error').textContent.includes('512 KB'),'PNG client 512 KB limit');await uploadPng();$('badge-form').requestSubmit();$('confirm-submit').click();await until(()=>!$('confirm').open&&card('first-light').querySelector('img').src.includes('/v1/custom-badge-art/'),'PNG saved');await until(()=>card('first-light').querySelector('img').naturalWidth===128,'PNG loads through real CSP and Worker');
 const pngImage=card('first-light').querySelector('img').src;card('first-light').querySelector('button').click();edit('description','PNG metadata update');$('badge-form').requestSubmit();$('confirm-submit').click();await until(()=>!$('confirm').open&&card('first-light').textContent.includes('PNG metadata update'),'PNG retained on metadata edit');check(card('first-light').querySelector('img').src===pngImage,'PNG reference preserved');
 $('badge-search').value='ui-fixture';$('badge-search').dispatchEvent(new Event('input'));check($('catalog').children.length===1,'catalog search');
 button('catalog','Delete');check($('confirm-submit').disabled,'delete needs exact ID');$('delete-id').value='wrong';$('delete-id').dispatchEvent(new Event('input'));check($('confirm-submit').disabled,'wrong delete ID');
 $('delete-id').value='ui-fixture';$('delete-id').dispatchEvent(new Event('input'));$('confirm-submit').click();await until(()=>!$('confirm').open&&!card('ui-fixture'),'unused badge soft deleted');
 $('badge-search').value='';$('badge-search').dispatchEvent(new Event('input'));const ownedDelete=[...card('first-light').querySelectorAll('button')].find(b=>b.textContent==='Delete');ownedDelete.click();check($('confirm-text').textContent.includes('including existing owners'),'delete explains effect on owners');$('delete-id').value='first-light';$('delete-id').dispatchEvent(new Event('input'));$('confirm-submit').click();await until(()=>!$('confirm').open&&!card('first-light'),'owned badge soft deleted');
 document.querySelector('[data-tab=accounts]').click();await until(()=>$('account-results').querySelector('tbody tr'),'accounts loaded');
 $('account-search').value='slow';$('account-search-form').requestSubmit();await pause(30);
 $('account-search').value='Account';$('account-search-form').requestSubmit();await until(()=>$('account-results').querySelector('tbody tr'),'latest account search');await pause(250);
 check($('account-results').querySelectorAll('table').length===1&&$('account-results').textContent.includes('Account <img>'),'stale search ignored');
 check(!$('account-results').querySelector('img'),'account table escaping');button('account-results','Transactions');await until(()=>$('details-body').querySelectorAll('tbody tr').length===50,'ledger first page');
 $('details-more').click();$('details-more').click();await until(()=>$('details-body').querySelectorAll('tbody tr').length===51,'ledger next page');check($('details-more').hidden,'end of ledger');$('details').close();
 document.querySelector('[data-tab=audit]').click();await until(()=>$('audit-results').children.length>=5,'activity log');
 check($('audit-results').textContent.includes('badge.update')&&$('audit-results').textContent.includes('Before'),'before/after audit');check(!$('audit-results').querySelector('img,script'),'audit escaping');
 document.querySelector('[data-tab=badges]').click();$('badge-search').value='';$('badge-search').dispatchEvent(new Event('input'));
 check(document.documentElement.scrollWidth<=innerWidth+1,'responsive catalog');
 document.querySelector('[data-tab=supporters]').click();await until(()=>$('supporter-official').children.length===3&&$('supporter-reviews').querySelector('[data-badge-id]'),'supporter section');
 $('supporter-account-id').value='1554184140704841940';$('supporter-search').requestSubmit();await until(()=>$('supporter-tier'),'supporter account');check($('supporter-account').textContent.includes('Account <img>')&&!$('supporter-account').querySelector('img'),'supporter account literal text');
 $('supporter-tier').value='2';$('supporter-tier-save').click();check($('supporter-confirm').open&&$('supporter-confirm-text').textContent.includes('Tier 1 → Tier 2'),'tier review before write');$('supporter-confirm-save').click();await until(()=>$('supporter-confirm-error').textContent.includes('could not be completed'),'lost tier response');$('supporter-confirm-save').click();await until(()=>!$('supporter-confirm').open&&$('supporter-tier').value==='2','tier retry succeeds');
 $('supporter-refresh').click();await until(()=>$('supporter-reviews').querySelectorAll('[data-badge-id]').length===2,'two reviews');$('supporter-reviews').querySelector('[data-badge-id="custom-'+ 'a'.repeat(32)+'"]').click();await until(()=>$('supporter-review').querySelector('img')?.naturalWidth===128,'authenticated processed preview');check(!$('supporter-review').querySelector('script'),'review text is escaped');$('supporter-review').querySelector('[data-supporter-decision=approve]').click();$('supporter-confirm-save').click();await until(()=>$('supporter-review').querySelector('[data-supporter-decision=revoke]')&&!$('supporter-review').querySelector('[data-supporter-decision=revoke]').disabled,'approval');$('supporter-review-reason').value='Policy change';$('supporter-review').querySelector('[data-supporter-decision=revoke]').click();$('supporter-confirm-save').click();await until(()=>$('supporter-review').textContent.includes('REVOKED')&&!$('supporter-confirm-save').disabled,'revocation');
 $('supporter-reviews').querySelector('[data-badge-id="custom-'+ 'b'.repeat(32)+'"]').click();check(!$('supporter-review').querySelector('[data-supporter-decision=approve]').disabled&&!$('supporter-review').querySelector('[data-supporter-decision=reject]').disabled,'administrator self-review buttons enabled');check($('supporter-review').textContent.includes('You are reviewing your own badge.'),'self-review audit notice');$('supporter-review-reason').value='Needs revision';$('supporter-review').querySelector('[data-supporter-decision=reject]').click();$('supporter-confirm-save').click();await until(()=>$('supporter-review').textContent.includes('REJECTED')&&!$('supporter-confirm-save').disabled,'rejection');
 button('supporter-official','Edit artwork');await uploadPng();check($('badge-form').elements.price.disabled&&$('badge-form').elements.available.disabled,'official tier cannot be sold');edit('name','Official Tier One');$('badge-form').requestSubmit();$('confirm-submit').click();await until(()=>!$('confirm').open&&$('supporter-official').textContent.includes('Official Tier One'),'official artwork uses same secure editor');
 check($('supporter-activity').textContent.includes('tier')&&$('supporter-activity').textContent.includes('revoke'),'supporter tier/moderation history');check(document.documentElement.scrollWidth<=innerWidth+1,'responsive Supporter panel');
 document.querySelector('[data-tab=supporters]').scrollIntoView({block:'start'});console.log('SUPPORTER_VISUAL_READY');await until(()=>window.__supporterPreviewComplete,'supporter screenshot');
 $('logout').click();await until(()=>!$('login').hidden&&$('workspace').hidden,'logout');check(!$('catalog').children.length&&!$('audit-results').children.length,'logout clears data');
 const denied=await fetch('/admin/api/me');check(denied.status===401,'logout revokes real server session');
 return{supporterTiers:true,supporterModeration:true,supporterArtwork:true,supporterRetry:true,forms:true,svgUpload:true,svgReplacement:true,escaping:true,retry:true,retirement:true,deletion:true,ledger:true,audit:true,logout:true};
}

function driver(dir,base){
 const {app,BrowserWindow,session}=require('electron');app.disableHardwareAcceleration();app.setPath('userData',require('node:path').join(dir,'profile'));
 app.whenReady().then(async()=>{
  const errors=[];
  session.defaultSession.setCertificateVerifyProc((request,callback)=>callback(request.hostname==='127.0.0.1'?0:-3));
  let authorization,unexpectedEgress=false;
  session.defaultSession.webRequest.onBeforeRequest((details,callback)=>{
   const u=new URL(details.url);
   if(u.origin==='https://discord.com'&&u.pathname==='/oauth2/authorize'){authorization=u;callback({cancel:true});return;}
   if(u.origin!==base&&['https:','http:'].includes(u.protocol))unexpectedEgress=true;
   callback({cancel:u.origin!==base&&u.protocol!=='devtools:'});
  });
  const w=new BrowserWindow({show:false,width:440,height:850,webPreferences:{backgroundThrottling:false}});
  const authorizationBlocked=new Promise(resolve=>w.webContents.on('did-fail-load',(_event,code,_description,url)=>{if(code===-20&&url.startsWith('https://discord.com/oauth2/authorize?'))resolve();}));
  w.webContents.on('console-message',async event=>{if(event.message==='SUPPORTER_VISUAL_READY'){for(const width of [1240,440]){w.setContentSize(width,850);await new Promise(r=>setTimeout(r,60));require('node:fs').writeFileSync(require('node:path').join(dir,'supporter-'+width+'.png'),(await w.webContents.capturePage()).toPNG());}await w.webContents.executeJavaScript('window.__supporterPreviewComplete=true');}});
  w.webContents.on('console-message',event=>{if(event.level==='error'&&!/Failed to load resource.*(?:400|401|413|503)/.test(event.message))errors.push(event.message);});
  try{
   await w.loadURL(base+'/admin');
   await w.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const timer=setInterval(()=>{if(!document.getElementById('login').hidden){clearInterval(timer);document.querySelector('#login button').click();resolve();}else if(++n>200){clearInterval(timer);reject(Error('Login form unavailable'));}},20);})`);
   const deadline=Date.now()+5000;while(!authorization){if(Date.now()>deadline)throw Error('Native login form did not reach Discord authorization');await new Promise(r=>setTimeout(r,20));}
   await authorizationBlocked;while(w.webContents.isLoading())await new Promise(r=>setTimeout(r,20));
   if(authorization.searchParams.get('scope')!=='identify'||authorization.searchParams.get('code_challenge_method')!=='S256')throw Error('Wrong OAuth scope/PKCE');
   const state=authorization.searchParams.get('state'),cookies=await session.defaultSession.cookies.get({url:base});
   if(!cookies.some(c=>c.name.startsWith('__Host-syncord-admin-state-')&&c.httpOnly&&c.secure))throw Error('Browser state cookie missing');
   // The real browser sends the challenge cookie; only the Discord provider is
   // a local fixture. The external authorization request above is cancelled.
   await w.loadURL(base+'/oauth/callback?state='+encodeURIComponent(state)+'&code=fixture&iss=https%3A%2F%2Fdiscord.com');
   await w.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const timer=setInterval(()=>{if(document.querySelector('.badge-card')){clearInterval(timer);resolve();}else if(++n>200){clearInterval(timer);reject(Error('Initial catalog unavailable'));}},20);})`);
   for(const width of [1240,440]){w.setContentSize(width,850);await new Promise(r=>setTimeout(r,60));require('node:fs').writeFileSync(require('node:path').join(dir,'admin-'+width+'.png'),(await w.webContents.capturePage()).toPNG());}
   const result=await w.webContents.executeJavaScript('('+checks.toString()+')()');
   await w.webContents.executeJavaScript(`fetch('/__fixture/unavailable',{method:'POST'})`);await w.loadURL(base+'/admin');
   await w.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const timer=setInterval(()=>{if(!document.getElementById('login').hidden&&document.getElementById('status').textContent.includes('could not be completed')){clearInterval(timer);resolve();}else if(++n>200){clearInterval(timer);reject(Error('Startup service error was hidden'));}},20);})`);
   result.startupFailure=true;
   if(unexpectedEgress)throw Error('SVG preview or panel attempted external network access');
   if(errors.length)throw Error(errors.join('\n'));
   console.log('ADMIN_UI '+JSON.stringify(result));w.destroy();app.exit(0);
  }catch(e){console.error(e.stack+'\n'+JSON.stringify(errors));w.destroy();app.exit(1);}
 });
}

test('Admin browser uses actual CSP/Worker/D1: forms, uncertain writes, ownership, history and logout',{skip:!electron&&'Electron missing',timeout:30000},async()=>{
 const bundled=await build({entryPoints:['services/ecosystem/src/index.ts'],bundle:true,platform:'browser',format:'esm',write:false,logLevel:'silent'});
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-10-17',d1Databases:['DB'],r2Buckets:['BADGE_ASSETS'],images:{binding:'BADGE_IMAGES'},bindings:{PUBLIC_ORIGIN:origin,DISCORD_CLIENT_ID:A,DISCORD_CLIENT_SECRET:'fixture-only',ADMIN_DISCORD_IDS:A,SUPPORTER_UPLOAD_ENABLED:'true'},outboundService:async request=>{
  const p=new URL(request.url).pathname;
  if(p==='/api/oauth2/token')return Response.json({access_token:'fixture-only',token_type:'Bearer',scope:'identify'});
  if(p==='/api/v10/users/@me')return Response.json({id:A,username:'Owner <img onerror=bad()>',mfa_enabled:true});
  if(p==='/api/oauth2/token/revoke')return new Response(null,{status:200});throw Error('Unexpected OAuth endpoint');
 }}));
 const dir=mkdtempSync(path.join(tmpdir(),'syncord-admin-ui-'));let server;
 try{
  const certificate=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(dir,'key.pem'),'-out',path.join(dir,'cert.pem'),'-subj','/CN=127.0.0.1','-days','1'],{encoding:'utf8'});assert.equal(certificate.status,0,certificate.stderr);
  const db=await mf.getD1Database('DB');for(const file of readdirSync('services/ecosystem/migrations').filter(n=>n.endsWith('.sql')).sort())await db.batch(unstable_splitSqlQuery(readFileSync('services/ecosystem/migrations/'+file,'utf8')).map(sql=>db.prepare(sql)));
  await db.prepare('INSERT INTO accounts(id,username,created_at) VALUES(?,?,?)').bind(B,'Account <img>',Date.now()).run();
  await db.prepare('INSERT INTO accounts(id,username,created_at) VALUES(?,?,?)').bind(A,'Linked administrator',Date.now()).run();
  for(let i=0;i<2;i++)await db.prepare("INSERT INTO reward_grants VALUES(?,?,'community-contribution',?,25,?)").bind('fund-'+i,B,'fund-'+i,Date.now()).run();
  await db.prepare("INSERT INTO purchases VALUES('ui-purchase',?,'first-light',25,'ui-purchase',?)").bind(B,Date.now()).run();
  // Populate real ledger rows without any production requests or balances.
  for(let i=2;i<50;i++)await db.prepare("INSERT INTO reward_grants VALUES(?,?,'community-contribution',?,25,?)").bind('fund-'+i,B,'fund-'+i,Date.now()).run();
  const pendingId='custom-'+'a'.repeat(32),rejectedId='custom-'+'b'.repeat(32),now=Date.now();
  await db.prepare('INSERT INTO supporter_entitlements VALUES(?,1,0,1,?)').bind(B,now).run();
  const png=new PNG({width:128,height:128});png.data[0]=230;png.data[3]=90;const bytes=PNG.sync.write(png),digest=createHash('sha256').update(bytes).digest('hex'),key='processed/'+digest+'.png';await(await mf.getR2Bucket('BADGE_ASSETS')).put(key,bytes);await db.prepare('INSERT INTO custom_badge_assets VALUES(?,?,?,128,128,?)').bind(digest,key,bytes.length,now).run();
  await db.prepare("INSERT INTO custom_badges(id,account_id,name,description,status,image,revision,created_at,updated_at,submitted_at) VALUES(?,?,?,?,'PENDING_REVIEW',?,1,?,?,?)").bind(pendingId,B,'Personal <img>','Literal <script> text',digest,now,now,now).run();
  let lost=false,lostSupporter=false,unavailable=false,delayedDeleteRefresh=false,base;const failures=[],loginRequests=[];
  server=createServer({key:readFileSync(path.join(dir,'key.pem')),cert:readFileSync(path.join(dir,'cert.pem'))},async(req,res)=>{
   try{
    if(req.url==='/__fixture/png'){res.writeHead(200,{'content-type':'image/png'});res.end(bytes);return;}
    if(req.url==='/__fixture/unavailable'){unavailable=true;res.writeHead(204);res.end();return;}
    if(unavailable&&req.url==='/admin/api/me'){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'admin_unavailable'}));return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const data=Buffer.concat(chunks),headers=new Headers();
    for(const [key,value]of Object.entries(req.headers))if(typeof value==='string')headers.set(key,value);
    if(req.url==='/admin/login')loginRequests.push({origin:headers.get('origin'),site:headers.get('sec-fetch-site')});
    // Map the isolated TLS host to the fixed Worker origin only when Chromium
    // actually emitted that exact Origin. Missing/null/foreign origins survive.
    if(headers.get('origin')===base)headers.set('origin',origin);
    const r=await mf.dispatchFetch(origin+req.url,{method:req.method,headers,redirect:'manual',...(data.length?{body:data}:{} )});
    if(req.url.includes('q=slow'))await new Promise(resolve=>setTimeout(resolve,150));
    if(!r.ok)failures.push({path:req.url,status:r.status,error:await r.clone().text(),origin:headers.get('origin')});
    // A committed delete must keep confirmation busy until its catalog refresh finishes.
    if(req.method==='DELETE'&&req.url==='/admin/api/badges/ui-fixture'&&r.ok)delayedDeleteRefresh=true;
    else if(delayedDeleteRefresh&&req.method==='GET'&&req.url==='/admin/api/badges'){delayedDeleteRefresh=false;await new Promise(resolve=>setTimeout(resolve,200));}
    if(!lost&&req.method==='PUT'&&req.url==='/admin/api/badges/ui-fixture'&&r.ok){lost=true;res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'fixture_interrupted'}));return;}
    if(!lostSupporter&&req.method==='PUT'&&req.url==='/admin/api/supporter/accounts/'+B&&r.ok){lostSupporter=true;await db.prepare('INSERT INTO supporter_entitlements VALUES(?,1,0,1,?)').bind(A,now).run();await db.prepare("INSERT INTO custom_badges(id,account_id,name,description,status,image,revision,created_at,updated_at,submitted_at) VALUES(?,?,?,?,'PENDING_REVIEW',?,1,?,?,?)").bind(rejectedId,A,'Second personal','Needs review',digest,now+1,now+1,now+1).run();res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'fixture_interrupted'}));return;}
    res.writeHead(r.status,Object.fromEntries(r.headers));res.end(Buffer.from(await r.arrayBuffer()));
   }catch(e){res.writeHead(500);res.end(String(e));}
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='https://127.0.0.1:'+server.address().port;
  writeFileSync(path.join(dir,'main.cjs'),`const checks=${checks.toString()};(${driver.toString()})(${JSON.stringify(dir)},${JSON.stringify(base)});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const run=await new Promise((resolve,reject)=>{const child=spawn(electron,[path.join(dir,'main.cjs')],{env,stdio:['ignore','pipe','pipe']}),out=[],err=[];const timer=setTimeout(()=>{child.kill();reject(Error('Admin UI timed out'));},25000);child.stdout.on('data',d=>out.push(d));child.stderr.on('data',d=>err.push(d));child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);resolve({code,stdout:Buffer.concat(out).toString(),stderr:Buffer.concat(err).toString()});});});
  assert.equal(run.code,0,run.stdout+'\n'+run.stderr+'\n'+JSON.stringify({failures,loginRequests}));assert.ok(run.stdout.includes('ADMIN_UI '),run.stdout);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM supporter_commands WHERE action='tier'").first()).n,1,'uncertain tier retry is idempotent');assert.equal((await db.prepare('SELECT tier FROM supporter_entitlements WHERE account_id=?').bind(B).first()).tier,2);assert.equal((await db.prepare('SELECT status FROM custom_badges WHERE id=?').bind(pendingId).first()).status,'REVOKED');assert.equal((await db.prepare('SELECT status FROM custom_badges WHERE id=?').bind(rejectedId).first()).status,'REJECTED');const selfReview=await db.prepare("SELECT actor_id,owner_id FROM supporter_commands WHERE target_id=? AND action='reject'").bind(rejectedId).first();assert.deepEqual(selfReview,{actor_id:A,owner_id:A});
  assert.deepEqual(loginRequests,[{origin:base,site:'same-origin'}]);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='badge.update' AND target_id='ui-fixture'").first()).n,1,'retry must not mutate/audit twice');
  assert.equal((await db.prepare("SELECT * FROM badges WHERE id='ui-fixture'").first()).is_deleted,1);assert.equal((await db.prepare("SELECT * FROM badges WHERE id='first-light'").first()).is_deleted,1);assert.equal((await db.prepare("SELECT active FROM owned_badges WHERE badge_id='first-light'").first()).active,0);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM owned_badges WHERE badge_id='first-light'").first()).n,1);
  assert.match((await db.prepare("SELECT png_image FROM badges WHERE id='first-light'").first()).png_image,/^[a-f0-9]{64}$/);assert.match((await db.prepare("SELECT png_image FROM badges WHERE id='supporter-tier-1'").first()).png_image,/^[a-f0-9]{64}$/);
  if(process.env.SYNCORD_ADMIN_UI_PREVIEW){for(const width of [1240,440]){writeFileSync(path.join(tmpdir(),'syncord-admin-'+width+'.png'),readFileSync(path.join(dir,'admin-'+width+'.png')));writeFileSync('/private/tmp/syncord-supporter-web-'+width+'.png',readFileSync(path.join(dir,'supporter-'+width+'.png')));}}
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await mf.dispose();rmSync(dir,{recursive:true,force:true});}
});
