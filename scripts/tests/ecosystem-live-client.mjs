/** Explicit live acceptance harness. Uses real production API, real main IPC and
 * preload, isolated Electron profiles, and Discord-shaped fixture DOM/stores.
 * It does not pretend to be a second signed-in Discord installation.
 * --purchase-first-light authorizes spending up to 25 SP once, retaining the
 * owned badge and active selection. Temporary client sessions are revoked.
 */
import {build} from 'esbuild';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {tmpdir} from 'node:os';
const root=process.cwd(),accountId=process.argv[2],observeOnly=process.argv[3]==='--observe-only';
if(!/^\d{17,20}$/.test(accountId??'')||BigInt(accountId)>=(1n<<64n)||!['--purchase-first-light','--observe-only'].includes(process.argv[3]))throw Error('Usage: node scripts/tests/ecosystem-live-client.mjs <consenting-account-id> --purchase-first-light|--observe-only');
const electron=['Electron.app/Contents/MacOS/Electron','electron.exe','electron'].map(p=>path.join(root,'node_modules/electron/dist',p)).find(existsSync);if(!electron)throw Error('Electron missing');
const dir=mkdtempSync(path.join(tmpdir(),'syncord-eco-live-client-'));
const defines={__SYNCORD_ECOSYSTEM_ORIGIN__:JSON.stringify('https://api.syncord.pro'),__SYNCORD_VERSION__:JSON.stringify(JSON.parse(readFileSync('package.json','utf8')).version)};
function rendererSetup(accountId){
 const G='1554184140704900001',C='1554184140704900002',user={id:accountId,username:'Live validation account',public_flags:128};
 let current=user;const listeners=new Map();const flux={dispatch(action){for(const fn of listeners.get(action.type)??[])fn(action);},subscribe(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},unsubscribe(name,fn){listeners.get(name)?.delete(fn);}};
 window.Syncord={common:{flux:{FluxDispatcher:flux},actions:{},stores:{UserStore:{getCurrentUser:()=>current,getUser:id=>({...user,id})},UserProfileStore:{getUserProfile:()=>({badges:[]}),getGuildMemberProfile:()=>({badges:[]})},SelectedGuildStore:{getGuildId:()=>G},SelectedChannelStore:{getChannelId:()=>C},ChannelStore:{getChannel:id=>({id,type:0,guild_id:G})},PermissionStore:{computePermissions:()=>1024n},GuildStore:{getGuildIds:()=>[]},PresenceStore:{getStatus:()=> 'online',getActivities:()=>[]}}},webpack:{find:()=>undefined,findByStoreName:()=>undefined,getRequire:()=>({c:{}})}};
 const message=document.querySelector('#message-username-1');message.__reactFiber$fixture={memoizedProps:{message:{id:'1',channel_id:C,author:user}}};
 const member=document.querySelector('.member_fixture .username_fixture');member.__reactFiber$fixture={memoizedProps:{},return:{memoizedProps:{member:{user},guildId:G}}};
 window.liveUser=accountId;window.liveAccount=value=>{current=value;flux.dispatch({type:'CURRENT_USER_UPDATE'});};
}
async function ownerChecks(){
 const q=s=>document.querySelector(s),wait=ms=>new Promise(r=>setTimeout(r,ms)),until=async(fn,label,timeout=20000)=>{const end=Date.now()+timeout;while(!fn()){if(Date.now()>end)throw Error('Timeout '+label+': '+q('.eco-status')?.textContent);await wait(100);}},click=s=>{const b=q(s);if(!b||b.disabled)throw Error('Unavailable action '+s);b.click();};
 await until(()=>window.liveReady,'renderer');await until(()=>q('[data-eco-link]')&&!q('[data-eco-link]').disabled,'initial link');click('[data-eco-link]');await until(()=>q('[data-eco-balance]').textContent!=='— SP','real Discord approval',570000);
 const before=await SyncordNative.ecosystem.profile(liveUser),alreadyOwned=before.badges.some(b=>b.id==='first-light');
 click('[data-eco-tab="2"]');await until(()=>q('[data-eco-buy="first-light"]'),'real catalog');
 if(!alreadyOwned){
  if(before.balance<25)throw Error('Not enough SP for the authorized live test');
  click('[data-eco-buy="first-light"]');if(!q('[data-eco-buy="first-light"]').textContent.includes('25 SP'))throw Error('Unexpected live price');
  click('[data-eco-buy="first-light"]');await until(()=>q('.eco-status').textContent.includes('simulated transport loss'),'lost successful reply');
  click('[data-eco-buy="first-light"]');await until(()=>q('[data-eco-buy="first-light"]').textContent==='Owned','idempotent retry');
 }
 const after=await SyncordNative.ecosystem.profile(liveUser);if(after.balance!==before.balance-(alreadyOwned?0:25))throw Error('Incorrect purchase debit');
 click('[data-eco-tab="3"]');await until(()=>q('[data-eco-active="first-light"]'),'owned badge');if(q('[data-eco-active="first-light"]').getAttribute('aria-pressed')!=='true'){click('[data-eco-active="first-light"]');await until(()=>q('[data-eco-active="first-light"]').getAttribute('aria-pressed')==='true','activation');}
 click('[data-eco-tab="4"]');click('[data-eco-history]');await until(()=>q('tbody')?.rows.length>=2,'real ledger');const history=await SyncordNative.ecosystem.history(liveUser);if(history.entries.filter(e=>e.delta===-25&&e.reason==='Badge purchase').length!==1)throw Error('Duplicate purchase ledger');
 const plainAccount=await SyncordNative.ecosystem.status('1554184140704900999');if(plainAccount.linked)throw Error('Session leaked across accounts');let denied=false;try{await SyncordNative.ecosystem.profile('1554184140704900999');}catch{denied=true;}if(!denied)throw Error('Other account profile unexpectedly accessible');
 return{balanceBefore:before.balance,balanceAfter:after.balance,purchased:!alreadyOwned,retryPreservedDebit:!alreadyOwned,ledgerEntries:history.entries.length,accountSeparated:denied};
}
async function observerChecks(){
 const wait=ms=>new Promise(r=>setTimeout(r,ms)),until=async(fn,label)=>{const end=Date.now()+20000;while(!fn()){if(Date.now()>end)throw Error('Timeout '+label);await wait(50);}};
 await until(()=>window.liveReady,'observer renderer');const bridge=SyncordNative.ecosystem;if((await bridge.status(liveUser)).linked)throw Error('Observer unexpectedly authenticated');
 window.startLiveBadges();await until(()=>document.querySelector('#message-username-1 + .dion-badges')?.dataset.ids.includes('syncord:first-light'),'official badge');
 const message=()=>document.querySelector('#message-username-1 + .dion-badges');if(!message().dataset.ids.includes('brilliance'))throw Error('Native badge lost');await until(()=>message().querySelector('img')?.naturalWidth>0,'real native badge image');
 if(document.querySelector('.dion-member-badges'))throw Error('Member preference default changed');window.setLiveMemberBadges(true);await until(()=>document.querySelector('.dion-member-badges')?.dataset.ids.includes('syncord:first-light'),'member badge');window.setLiveMemberBadges(false);await until(()=>!document.querySelector('.dion-member-badges'),'member setting off');if(!message().dataset.ids.includes('syncord:first-light'))throw Error('Member toggle removed chat badge');
 return{unauthenticatedObserver:true,officialBadge:true,nativeBadgePreserved:true,nativeBadgeImageLoaded:true,memberToggle:true,ids:message().dataset.ids};
}
function driver(dir,accountId){
 const {app,BrowserWindow,session}=require('electron'),fs=require('node:fs'),path=require('node:path');const mode=process.argv.includes('--observer')?'observer':process.argv.includes('--resume')?'resume':'owner';
 app.setName('Syncord Acceptance');app.disableHardwareAcceleration();app.setPath('userData',path.join(dir,mode==='observer'?'observer-profile':'owner-profile'));
 app.whenReady().then(async()=>{
  let window;const native=require(path.join(dir,'native.cjs'));let dropReply=mode==='owner',attempts=[];const originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{const response=await originalFetch(url,init);if(url==='https://api.syncord.pro/v1/me/purchases'&&init?.method==='POST'){attempts.push(JSON.parse(init.body).idempotencyKey);if(dropReply&&response.ok){dropReply=false;await response.body?.cancel();throw Error('simulated transport loss after successful purchase');}}return response;};
  try{
   native.registerIpc();await session.defaultSession.protocol.handle('https',request=>{const u=new URL(request.url);if(['https://cdn.discordapp.com','https://cdn.discord.com'].includes(u.origin)&&/^\/badge-icons\/[a-f0-9]{32}\.png$/.test(u.pathname))return originalFetch(u.href,{redirect:'error',credentials:'omit',signal:AbortSignal.timeout(10000)});if(u.origin!=='https://discord.com')return new Response('Not part of this fixture',{status:404});return new Response(fs.readFileSync(path.join(dir,'index.html')),{headers:{'content-type':'text/html; charset=utf-8'}});});
   window=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{preload:path.join(dir,'preload.js'),sandbox:false,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
   const timer=setTimeout(()=>{console.error('Live acceptance timed out');app.exit(1);},590000);await window.loadURL('https://discord.com/channels/@me');let result;
   if(mode==='owner'){
    console.log('Live client opened. Approve Discord in the browser for this isolated test client.');result=await window.webContents.executeJavaScript('('+ownerChecks.toString()+')()');
    const secretFile=path.join(native.SyncordUserDataPath(),'secrets','ecosystem-'+accountId+'.bin'),blob=fs.readFileSync(secretFile);if(/^[a-f0-9]{64}$/.test(blob.toString('utf8')))throw Error('Session stored in plaintext');result.encryptedSessionFile=blob.length>64;result.identicalRetryKey=attempts.length===0||attempts.length===2&&attempts[0]===attempts[1];if(!result.identicalRetryKey)throw Error('Purchase retry key changed');
   }else if(mode==='observer'){result=await window.webContents.executeJavaScript('('+observerChecks.toString()+')()');}
   else{
    const saved=native.ecosystemStatus(accountId);if(!saved.linked)throw Error('Encrypted session did not survive process restart');const value=await native.ecosystemProfile(accountId);if(!value.badges.some(b=>b.id==='first-light'&&b.active))throw Error('Ownership/activation lost after restart');await native.ecosystemDisconnect(accountId);if(native.ecosystemStatus(accountId).linked)throw Error('Local temporary session remains after disconnect');result={restoredAfterProcessRestart:true,balance:value.balance,temporarySessionRemoved:true};
   }
   await new Promise(resolve=>setTimeout(resolve,150));fs.writeFileSync('/tmp/syncord-ecosystem-live-'+mode+'.png',(await window.webContents.capturePage()).toPNG());await window.webContents.executeJavaScript('window.disposeLive?.()');clearTimeout(timer);console.log('LIVE_ACCEPTANCE '+JSON.stringify({mode,...result}));window.destroy();app.exit(0);
  }catch(error){console.error(error.message);try{if(mode!=='observer')await native.ecosystemDisconnect(accountId);}catch{}window?.destroy();app.exit(1);}
 });
}
try{
 await build({stdin:{resolveDir:root,contents:`export{registerIpc}from './src/main/ipc';export*from './src/main/ecosystem';export{SyncordUserDataPath}from './src/main/security/core';`},bundle:true,platform:'node',format:'cjs',external:['electron'],define:defines,outfile:path.join(dir,'native.cjs'),logLevel:'silent'});
 await build({entryPoints:['src/preload/index.ts'],bundle:true,platform:'node',format:'cjs',external:['electron'],define:defines,outfile:path.join(dir,'preload.js'),logLevel:'silent'});
 const entry=`import{mountEcosystem,unmountEcosystem}from './src/renderer/ui/ecosystem';import{ShowBadgesPlugin}from './src/renderer/plugins/showBadges';import{createPluginContext}from './src/renderer/api/plugin/context';import{initSettings,settings}from './src/renderer/api/settings';import{SHOW_BADGES_SETTINGS_EVENT}from './src/renderer/plugins/showBadges/settings';const setup=${rendererSetup.toString()};let context;async function ready(){setup(${JSON.stringify(accountId)});await initSettings();const observer=new URLSearchParams(location.search).has('observer');window.startLiveBadges=()=>{context=createPluginContext(ShowBadgesPlugin);ShowBadgesPlugin.start(context);};window.setLiveMemberBadges=value=>{settings.set('plugins.show-badges.data.memberList',value);window.dispatchEvent(new Event(SHOW_BADGES_SETTINGS_EVENT));};window.disposeLive=()=>{unmountEcosystem();context?._disposeAll();};mountEcosystem(document.getElementById('ecosystem'));window.liveReady=true;}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready,{once:true});else void ready();`;
 await build({stdin:{resolveDir:root,contents:entry},bundle:true,platform:'browser',format:'iife',define:defines,outfile:path.join(dir,'renderer.js'),logLevel:'silent'});
 writeFileSync(path.join(dir,'index.html'),`<!doctype html><html><meta charset="utf-8"><title>Syncord isolated live acceptance</title><body style="background:#191a20;color:#f2f3f5;font:14px system-ui;margin:24px"><h2>Isolated Electron · live Syncord API</h2><div id="ecosystem"></div><section style="position:fixed;right:20px;bottom:20px;background:#23242a;padding:18px;border-radius:12px;z-index:10"><h3>Discord-shaped fixture: public badge rendering</h3><ul id="messages" style="padding:0"><li id="chat-messages-1554184140704900002-1" style="list-style:none"><h3><span id="message-username-1">Message author</span></h3></li></ul><aside data-list-id="members-1554184140704900001"><div class="member_fixture" data-list-item-id="members-${accountId}"><div class="nameAndDecorators_fixture"><span class="username_fixture">Member list user</span></div></div></aside></section></body></html>`);
 writeFileSync(path.join(dir,'main.cjs'),`const ownerChecks=${ownerChecks.toString()},observerChecks=${observerChecks.toString()};(${driver.toString()})(${JSON.stringify(dir)},${JSON.stringify(accountId)});`);
 const run=async mode=>{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.Syncord_ORIGINAL_PRELOAD;
  await new Promise((resolve,reject)=>{const child=spawn(electron,[path.join(dir,'main.cjs'),...(mode==='owner'?[]:['--'+mode])],{env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',chunk=>process.stdout.write(chunk));child.stderr.on('data',chunk=>process.stderr.write(chunk));child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('Live '+mode+' client failed with code '+code)));});
 };
 if(observeOnly)await run('observer');else{await run('owner');try{await run('observer');}finally{await run('resume');}}
 console.log(observeOnly?'Public observer acceptance completed; no authenticated session or purchase was created.':'Live acceptance completed. Badge ownership/activation retained; isolated temporary session revoked.');
}finally{rmSync(dir,{recursive:true,force:true});}
