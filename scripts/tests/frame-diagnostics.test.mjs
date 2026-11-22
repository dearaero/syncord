import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=process.cwd(),electron=['Electron.app/Contents/MacOS/Electron','electron.exe','electron'].map(n=>path.join(root,'node_modules/electron/dist',n)).find(existsSync);

async function bundle(dir){
 const out=dir+'/diag.js';
 await build({stdin:{resolveDir:root,contents:`export * from './src/renderer/core/performance/diagnostics';`},bundle:true,platform:'browser',format:'iife',globalName:'D',outfile:out,logLevel:'silent'});
 return out;
}

test('frame diagnostics: bundle positions map to modules; scripts are grouped per source and frame',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'syncord-frame-diag-'));
 try{
  const {readFileSync}=await import('node:fs');
  const D=new Function(readFileSync(await bundle(dir),'utf8')+';return D;')();
  const map=[[100,'ui/userNames'],[500,'plugins/showBadges'],[900,'plugins/platformIndicators']];
  assert.equal(D.sourceFor('https://discord.com/assets/web.js',10,map),'Discord');
  assert.equal(D.sourceFor('',10,map),'unknown');
  assert.equal(D.sourceFor('syncord-renderer.js',50,map),'Syncord');
  assert.equal(D.sourceFor('syncord-renderer.js',500,map),'Syncord:plugins/showBadges');
  assert.equal(D.sourceFor('syncord-renderer.js',899,map),'Syncord:plugins/showBadges');
  assert.equal(D.sourceFor('syncord-renderer.js',5000,map),'Syncord:plugins/platformIndicators');
  D.resetFrameDiagnostics();
  const s=(pos,duration,layout)=>({sourceURL:'syncord-renderer.js',sourceCharPosition:pos,duration,forcedStyleAndLayoutDuration:layout});
  D.recordFrame({duration:120,blockingDuration:70,scripts:[s(600,40,10),s(700,30,5),{sourceURL:'https://discord.com/a.js',duration:20}]},map);
  D.recordFrame({duration:80,scripts:[s(950,60,0)]},map);
  const r=D.frameReport();
  assert.equal(r.frames,2);assert.equal(r.blockingMs,100);assert.equal(r.worstMs,120);
  assert.deepEqual(r.sources.map(x=>[x.source,x.scriptMs,x.layoutMs,x.frames]),[
   ['Syncord:plugins/showBadges',70,15,1],['Syncord:plugins/platformIndicators',60,0,1],['Discord',20,0,1]]);
  assert.match(D.frameReportText(r),/Syncord:plugins\/showBadges \| 70 ms \| 15 ms \| 1/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

// The production renderer is injected with webFrame.executeJavaScript; this
// proves Chromium attributes a slow frame inside such a script to its module.
test('frame diagnostics in real Electron: a slow rAF in executeJavaScript code is attributed to its module',{skip:!electron,timeout:30000},async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'syncord-frame-diag-e-'));
 try{
  const diag=await bundle(dir);
  writeFileSync(dir+'/index.html','<!doctype html><html><body><p>fixture</p></body></html>');
  writeFileSync(dir+'/preload.cjs',`const {webFrame}=require('electron');const fs=require('fs');
const diag=fs.readFileSync(${JSON.stringify(diag)},'utf8')+';window.__D=D;D.startFrameDiagnostics();';
const marker='\\n  // src/renderer/plugins/slowFixture/index.ts\\n';
const slow='function slowFixtureScan(){const end=performance.now()+150;while(performance.now()<end){}}\\nrequestAnimationFrame(slowFixtureScan);\\n';
const code=diag+marker+slow;const at=code.indexOf(marker)+1;
webFrame.executeJavaScript(code+';Object.defineProperty(window,"__SyncordModuleMap",{value:[['+at+',"plugins/slowFixture"]]});\\n//# sourceURL=syncord-renderer.js\\n');`);
  writeFileSync(dir+'/main.cjs',`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(dir+'/profile')});app.whenReady().then(async()=>{const win=new BrowserWindow({show:true,width:400,height:300,webPreferences:{backgroundThrottling:false,contextIsolation:false,sandbox:false,preload:${JSON.stringify(dir+'/preload.cjs')}}});try{await win.loadFile(${JSON.stringify(dir+'/index.html')});const r=await win.webContents.executeJavaScript('new Promise(r=>setTimeout(()=>r(window.__D?{supported:window.__D.frameReport().supported,types:PerformanceObserver.supportedEntryTypes,sources:window.__D.frameReport().sources.map(s=>s.source)}:null),1500))');console.log('FRAME_DIAG:'+JSON.stringify(r));win.destroy();app.exit(0)}catch(e){console.error(e);win.destroy();app.exit(1)}});`);
  const run=spawnSync(electron,[dir+'/main.cjs'],{encoding:'utf8',timeout:25000,env:{...process.env,ELECTRON_RUN_AS_NODE:''}});
  assert.equal(run.status,0,run.stdout+'\n'+run.stderr);
  const line=run.stdout.split('\n').find(l=>l.startsWith('FRAME_DIAG:'));assert.ok(line,run.stdout+run.stderr);
  const r=JSON.parse(line.slice(11));console.log(line);
  assert.ok(r,'diagnostics loaded');assert.equal(r.supported,true);
  assert.ok(r.types.includes('long-animation-frame'),'Electron reports long animation frames');
  assert.ok(r.sources.includes('Syncord:plugins/slowFixture'),JSON.stringify(r.sources));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
