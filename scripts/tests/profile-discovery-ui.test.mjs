import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=process.cwd(),electron=['Electron.app/Contents/MacOS/Electron','electron.exe','electron'].map(n=>path.join(root,'node_modules/electron/dist',n)).find(existsSync);

async function checks(){
 const wait=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 window.Syncord={common:{stores:{}},webpack:{getRequire:()=>undefined}};
 let reads=0;const watcher=api.watchProfileBadgeRows(()=>{reads++;return [];},()=>true);
 await wait();
 const original=Element.prototype.querySelectorAll;let discoveryReads=0;
 Element.prototype.querySelectorAll=function(selector){if(selector==='img[src*="/badge-icons/"]')discoveryReads++;return original.call(this,selector);};
 const profile=document.createElement('article');profile.className='user-profile-popout';
 const row=document.createElement('div');row.className='profileBadges_fixture';row.style.display='flex';
 row.__reactFiber$fixture={memoizedProps:{user:{id:'1425993161108357191'}}};
 // React can commit the enclosing profile and many nested badge nodes in one
 // task. They belong to one discovery root, not one scan per MutationRecord.
 document.body.append(profile);profile.append(row);
 for(let i=0;i<32;i++){
   const item=document.createElement('span');row.append(item);
   const img=document.createElement('img');img.width=img.height=22;img.src='https://cdn.discordapp.com/badge-icons/'+String(i).padStart(32,'a')+'.png';item.append(img);
 }
 await wait();const mountedReads=discoveryReads;const mountedIdentityReads=reads;
 discoveryReads=0;profile.querySelector('img').src='https://cdn.discordapp.com/badge-icons/'+ 'b'.repeat(32)+'.png';
 row.replaceChild(row.firstElementChild.cloneNode(true),row.firstElementChild);
 await wait();const replacementReads=discoveryReads;
 Element.prototype.querySelectorAll=original;
 const nativePreserved=row.querySelectorAll('img').length===32;
 const beforeStop=reads;watcher.stop();profile.append(document.createElement('p'));await wait();
 const stopped=reads===beforeStop&&!profile.querySelector('[data-syncord-profile-badges]');profile.remove();
 return {mountedReads,mountedIdentityReads,replacementReads,nativePreserved,stopped};
}
test('profile discovery: one native commit scans enclosing roots once and keeps replacement/cleanup behavior',{skip:!electron,timeout:20000},async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'syncord-profile-discovery-'));
 try{
  await build({stdin:{resolveDir:root,contents:`import {watchProfileBadgeRows} from './src/renderer/ui/ecosystem/profileBadges';window.api={watchProfileBadgeRows};`},bundle:true,platform:'browser',format:'iife',outfile:dir+'/fixture.js',logLevel:'silent'});
  writeFileSync(dir+'/index.html','<!doctype html><html><body><script src="fixture.js"></script></body></html>');
  writeFileSync(dir+'/main.cjs',`const {app,BrowserWindow,session}=require('electron');app.setPath('userData',${JSON.stringify(dir+'/profile')});app.whenReady().then(async()=>{session.defaultSession.webRequest.onBeforeRequest({urls:['https://cdn.discordapp.com/*']},(_,done)=>done({cancel:true}));const win=new BrowserWindow({show:false,width:800,height:600,webPreferences:{backgroundThrottling:false}});try{await win.loadFile(${JSON.stringify(dir+'/index.html')});console.log('PROFILE_DISCOVERY:'+JSON.stringify(await win.webContents.executeJavaScript('('+${JSON.stringify(checks.toString())}+')()')));win.destroy();app.exit(0)}catch(e){console.error(e);win.destroy();app.exit(1)}});`);
  const run=spawnSync(electron,[dir+'/main.cjs'],{encoding:'utf8',timeout:15000,env:{...process.env,ELECTRON_RUN_AS_NODE:''}});
  assert.equal(run.status,0,run.stdout+'\n'+run.stderr);const line=run.stdout.split('\n').find(s=>s.startsWith('PROFILE_DISCOVERY:'));assert.ok(line,run.stdout);console.log(line);
  const result=JSON.parse(line.slice('PROFILE_DISCOVERY:'.length));
  assert.equal(result.mountedReads,1);assert.equal(result.replacementReads,1);assert.equal(result.mountedIdentityReads,1);assert.equal(result.nativePreserved,true);assert.equal(result.stopped,true);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
