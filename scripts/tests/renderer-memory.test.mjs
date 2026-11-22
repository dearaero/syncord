import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
const executable=path.resolve('node_modules/electron/dist',process.platform==='darwin'?'Electron.app/Contents/MacOS/Electron':process.platform==='win32'?'electron.exe':'electron');
test('renderer memory: numeric native measurements and username observers ignore Settings while preserving native changes',{skip:!existsSync(executable),timeout:30000},async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'syncord-renderer-memory-'));
 try{
  await build({stdin:{resolveDir:process.cwd(),contents:`import {contextBridge} from 'electron';import {rendererMemory} from './src/preload/statistics';contextBridge.exposeInMainWorld('memory',{read:rendererMemory});`},outfile:path.join(dir,'preload.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron'],logLevel:'silent'});
  await build({stdin:{resolveDir:process.cwd(),contents:`import {usernameMutationRelevant} from './src/renderer/ui/userNames';window.relevant=usernameMutationRelevant;`},outfile:path.join(dir,'fixture.js'),bundle:true,platform:'browser',format:'iife',logLevel:'silent'});
  writeFileSync(path.join(dir,'index.html'),'<!doctype html><div id="Syncord-settings-root"><span id="metric">0</span></div><div id="native"><span id="username">Alice</span></div><script src="fixture.js"></script>');
  const checks=async()=>{
   const wait=()=>new Promise(r=>setTimeout(r,20));let scans=0;
   const observer=new MutationObserver(records=>{if(relevant(records))scans++;});observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['id','href','data-user-id']});
   const metric=document.getElementById('metric');for(let i=0;i<100;i++)metric.textContent=String(i);await wait();const settings=scans;
   for(const id of ['Syncord-spotify-island','Syncord-titlebar-btn','Syncord-fake-voice-host']){const surface=document.createElement('div');surface.id=id;document.body.append(surface);await wait();surface.textContent='Now playing';await wait();surface.remove();await wait();}const utility=scans;
   document.getElementById('username').textContent='Bob';await wait();const native=scans;
   const badge=document.createElement('span');badge.className='dion-badges';document.getElementById('native').append(badge);await wait();badge.textContent='Badge';await wait();badge.remove();await wait();const decorations=scans;
   const platform=document.createElement('span');platform.dataset.syncordPlatforms='';document.getElementById('native').append(platform);await wait();platform.remove();await wait();const platforms=scans;
   document.getElementById('username').dataset.userId='123456789012345678';await wait();const attributes=scans;
   metric.textContent='101';document.getElementById('username').textContent='Charlie';await wait();const mixed=scans;
   observer.disconnect();const first=memory.read(),second=memory.read();return{settings,utility,native,decorations,platforms,attributes,mixed,first,second};
  };
  writeFileSync(path.join(dir,'main.cjs'),`const {app,BrowserWindow}=require('electron');const path=require('node:path');app.disableHardwareAcceleration();app.setPath('userData',path.join(__dirname,'profile'));app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:false}});try{await w.loadFile(path.join(__dirname,'index.html'));console.log('RENDERER_MEMORY '+JSON.stringify(await w.webContents.executeJavaScript('('+${JSON.stringify(checks.toString())}+')()')));app.exit(0);}catch(e){console.error(e);app.exit(1);}});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const run=spawnSync(executable,[path.join(dir,'main.cjs')],{env,encoding:'utf8',timeout:20000,maxBuffer:1024*1024});assert.equal(run.status,0,run.stdout+run.stderr);const line=run.stdout.split('\n').find(l=>l.startsWith('RENDERER_MEMORY '));assert.ok(line,run.stdout+run.stderr);const r=JSON.parse(line.slice('RENDERER_MEMORY '.length));
  assert.equal(r.settings,0);assert.equal(r.utility,0);assert.equal(r.native,1);assert.equal(r.decorations,1);assert.equal(r.platforms,1);assert.equal(r.attributes,2);assert.equal(r.mixed,3);
  assert.ok(r.first.heap.used>0);assert.ok(r.first.heap.total>=r.first.heap.used);assert.ok(r.first.blink.used>=0);assert.ok(r.first.cache.images>=0);assert.deepEqual(r.first,r.second);
  const numeric=value=>typeof value==='number'&&Number.isFinite(value)||value!==null&&typeof value==='object'&&Object.values(value).every(numeric);assert.ok(numeric(r.first));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
