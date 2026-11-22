import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=process.cwd(),electron=['Electron.app/Contents/MacOS/Electron','electron.exe','electron'].map(n=>path.join(root,'node_modules/electron/dist',n)).find(existsSync);
test('core performance mode: real Chromium motion, media, end callbacks, settings, locales, responsive UI, cleanup and restoration',{skip:!electron,timeout:45000},async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'syncord-performance-ui-'));
 try{
  await build({stdin:{resolveDir:root,contents:`
   import {settings} from './src/renderer/api/settings';
   import {openSettings,closeSettings} from './src/renderer/ui/settingsPanel';
   import {setLocale,SUPPORTED_LOCALES,t} from './src/renderer/i18n';
   import * as mode from './src/renderer/core/performance';
   window.api={settings,openSettings,closeSettings,setLocale,SUPPORTED_LOCALES,t,...mode};
   window.ready=(async()=>{await settings.init();window.stopMode=mode.startPerformanceMode();})();
  `},bundle:true,platform:'browser',format:'iife',outfile:dir+'/fixture.js',loader:{'.png':'dataurl'},define:{__SYNCORD_VERSION__:'"0.4.5"'},logLevel:'silent'});
  writeFileSync(dir+'/index.html',`<!doctype html><html><head><style>
  body{margin:0;background:#111;color:#eee;font:14px system-ui;--font-primary:system-ui;--background-primary:#313338;--background-secondary:#202127;--text-normal:#eee;--text-muted:#aaa}
  @keyframes pulse{from{opacity:.4}to{opacity:1}}
  .motion{animation:pulse 1s infinite alternate;transition:transform 1s;backdrop-filter:blur(10px);width:12px;height:12px;background:#888;display:inline-block}
  .emoji{animation:pulse 1s infinite alternate;width:12px;height:12px;display:inline-block;background:green}
  #scroller{height:30px;overflow:auto;width:100px}#scroller div{height:1000px}
  </style></head><body><div id="bench"></div><div class="emoji" id="emoji"></div><img class="emoji" id="gif" alt="emoji" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"><div id="scroller"><div></div></div><script>window.saved={};window.SyncordNative={getSettings:async()=>saved,setSettings:async value=>{saved={...value}}};window.Syncord={common:{stores:{},actions:{},utils:{},react:{}},webpack:{getRequire:()=>undefined}};for(let i=0;i<160;i++){const node=document.createElement('button');node.className='motion';node.textContent='';document.querySelector('#bench').append(node);}window.originalAnimate=Element.prototype.animate;window.originalScroll=Element.prototype.scrollTo;</script><script src="fixture.js"></script></body></html>`);
  writeFileSync(dir+'/app.cjs',`
  const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');
  app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1180,height:850,webPreferences:{nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});try{
   await win.loadFile(${JSON.stringify(dir+'/index.html')});const run=s=>win.webContents.executeJavaScript(s),wait=ms=>new Promise(r=>setTimeout(r,ms));await run('ready');await wait(80);
   const baseline=await run('document.getAnimations().filter(a=>a.effect?.target?.closest("#bench")&&a.playState==="running").length');assert.equal(baseline,160);
   await run('api.openSettings("performance")');assert.equal(await run('document.querySelector("[data-dion-performance]").hidden'),false);assert.equal(await run('document.querySelector("[data-performance-mode]").checked'),false);
   await run('window.before=window.saved;window.pending=document.querySelector(".motion").animate([{opacity:.2},{opacity:1}],{duration:10000,fill:"forwards"});window.completed=false;pending.finished.then(()=>completed=true);document.querySelector("[data-performance-mode]").click()');await wait(100);
   const active=await run('document.getAnimations().filter(a=>a.effect?.target?.closest("#bench")&&a.playState==="running").length');assert.equal(active,0);assert.equal(await run('completed'),true);assert.equal(await run('parseFloat(getComputedStyle(document.querySelector(".motion")).animationDuration)<.001'),true);assert.equal(await run('getComputedStyle(document.querySelector(".motion")).backdropFilter'),'none');
   assert.equal(await run('getComputedStyle(document.querySelector("#emoji")).animationDuration'),'1s');assert.equal(await run('document.querySelector("#gif").complete'),true);
   await run('window.media=document.querySelector("#emoji").animate([{opacity:.3},{opacity:1}],{duration:5000,iterations:Infinity});window.direct=document.querySelector(".motion").animate([{opacity:.2},{opacity:1}],{duration:10000});window.ended=false;direct.finished.then(()=>ended=true)');await wait(50);assert.equal(await run('ended'),true);assert.equal(await run('media.effect.getTiming().duration'),5000);assert.equal(await run('media.playState'),'running');
   await run('document.querySelector("#scroller").scrollTo({top:700,behavior:"smooth"})');assert.equal(await run('document.querySelector("#scroller").scrollTop'),700);
   await run('api.settings.flush()');assert.equal(await run('saved["ui.performanceMode"]'),true);assert.equal(await run('api.settings.get("plugins.spotify-controls.enabled")'),undefined);
   for(const locale of await run('api.SUPPORTED_LOCALES')){await run('api.setLocale('+JSON.stringify(locale)+')');assert.equal(await run('document.querySelector("[data-performance-mode]").getAttribute("aria-label")'),await run('api.t("pm.mode")'));assert.equal(await run('document.querySelector("[data-dion-tab=performance] strong").textContent'),await run('api.t("pm.name")'));}
   await run('api.setLocale("tr")');win.setContentSize(650,850);await wait(50);assert.equal(await run('document.querySelector(".dion-panel").scrollWidth<=document.querySelector(".dion-panel").clientWidth+1'),true);
   if(process.env.PERFORMANCE_MODE_SCREENSHOT)require('node:fs').writeFileSync(process.env.PERFORMANCE_MODE_SCREENSHOT,(await win.webContents.capturePage()).toPNG());
   await run('api.closeSettings();api.openSettings("performance")');assert.equal(await run('document.querySelector("[data-performance-mode]").checked'),true);
   for(let i=0;i<20;i++){await run('api.setPerformanceMode(false,false);api.setPerformanceMode(true,false)');}assert.equal(await run('document.querySelectorAll("#Syncord-performance-mode").length'),1);
   await run('document.querySelector("[data-performance-mode]").click()');await wait(50);assert.equal(await run('document.documentElement.hasAttribute("data-syncord-performance")'),false);assert.equal(await run('Element.prototype.animate===originalAnimate'),true);assert.equal(await run('Element.prototype.scrollTo===originalScroll'),true);assert.equal(await run('getComputedStyle(document.querySelector(".motion")).animationDuration'),'1s');
   await run('api.setPerformanceMode(true);api.settings.flush();stopMode();window.stopMode=api.startPerformanceMode();void 0');assert.equal(await run('api.performanceModeEnabled()'),true);assert.equal(await run('document.documentElement.getAttribute("data-syncord-performance")'),'true');
   await run('api.closeSettings();stopMode();media.cancel()');assert.equal(await run('document.querySelectorAll("#Syncord-performance-mode,#Syncord-performance-panel").length'),0);assert.equal(await run('Element.prototype.animate===originalAnimate'),true);
   await win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('HeapProfiler.collectGarbage');const beforeDOM=await win.webContents.debugger.sendCommand('Memory.getDOMCounters');
   for(let i=0;i<20;i++)await run('api.openSettings("performance");api.closeSettings()');
   await wait(400);await win.webContents.debugger.sendCommand('HeapProfiler.collectGarbage');const afterDOM=await win.webContents.debugger.sendCommand('Memory.getDOMCounters');assert(afterDOM.nodes<=beforeDOM.nodes+50,JSON.stringify({beforeDOM,afterDOM}));win.webContents.debugger.detach();
   console.log('PERFORMANCE_UI_METRICS:'+JSON.stringify({runningInterfaceAnimationsBefore:baseline,runningInterfaceAnimationsAfter:active,mediaPreserved:true,callbacksPreserved:true,locales:18,cleanupCycles:20,retainedDomNodesDelta:afterDOM.nodes-beforeDOM.nodes}));
   win.destroy();app.exit(0);
  }catch(e){console.error(e);win.destroy();app.exit(1);}}).catch(e=>{console.error(e);app.exit(1)});
  `);
  const result=spawnSync(electron,[dir+'/app.cjs'],{encoding:'utf8',timeout:40000,env:{...process.env,ELECTRON_RUN_AS_NODE:''}});
  assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout+'\n'+result.stderr);console.log(result.stdout.match(/PERFORMANCE_UI_METRICS:.*/)?.[0]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
