import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=process.cwd(),electron=['Electron.app/Contents/MacOS/Electron','electron.exe','electron'].map(n=>path.join(root,'node_modules/electron/dist',n)).find(existsSync);
test('all built-ins disabled: registration/startAll install no active timers, observers, global DOM listeners, frames or network work',{skip:!electron,timeout:20000},async()=>{
 const dir=mkdtempSync(tmpdir()+'/syncord-disabled-plugins-');
 try{
  await build({stdin:{resolveDir:root,contents:`import './src/renderer/plugins';import {list,startAll} from './src/renderer/api/plugin/manager';import {settings} from './src/renderer/api/settings';window.ready=(async()=>{await settings.init();for(const p of list())settings.set('plugins.'+p.id+'.enabled',false);await settings.flush();await startAll();return list().map(p=>({id:p.id,enabled:p.enabled,started:p.started}));})();`},bundle:true,platform:'browser',format:'iife',outfile:dir+'/fixture.js',loader:{'.png':'dataurl'},define:{__SYNCORD_VERSION__:'"0.4.5"'},logLevel:'silent'});
  writeFileSync(dir+'/index.html',`<!doctype html><html><body><script>
   window.audit={intervals:0,observers:0,frames:0,network:0,listeners:0};window.SyncordNative={getSettings:async()=>({}),setSettings:async()=>{}};
   const timers=new Set(),timeout=window.setTimeout.bind(window),clear=window.clearTimeout.bind(window);window.setTimeout=(fn,ms,...args)=>{const id=timeout(()=>{timers.delete(id);fn(...args)},ms);timers.add(id);return id};window.clearTimeout=id=>{timers.delete(id);clear(id)};Object.defineProperty(audit,'timeouts',{enumerable:true,get:()=>timers.size});
   const interval=window.setInterval.bind(window);window.setInterval=(...args)=>{audit.intervals++;return interval(...args)};
   const raf=window.requestAnimationFrame.bind(window);window.requestAnimationFrame=(...args)=>{audit.frames++;return raf(...args)};
   const Observer=window.MutationObserver;window.MutationObserver=class extends Observer{constructor(fn){audit.observers++;super(fn)}};
   const add=EventTarget.prototype.addEventListener;EventTarget.prototype.addEventListener=function(...args){if(this===window||this===document)audit.listeners++;return add.apply(this,args)};
   window.fetch=()=>{audit.network++;return Promise.reject(Error('Disabled plugin network'))};XMLHttpRequest.prototype.send=function(){audit.network++;throw Error('Disabled plugin XHR')};window.WebSocket=class{constructor(){audit.network++;throw Error('Disabled plugin socket')}};
   window.Syncord={common:{stores:{},actions:{},react:{},utils:{}},webpack:{getRequire:()=>undefined}};
  </script><script src="fixture.js"></script></body></html>`);
  writeFileSync(dir+'/main.cjs',`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(dir+'/profile')});app.whenReady().then(async()=>{const win=new BrowserWindow({show:false});try{await win.loadFile(${JSON.stringify(dir+'/index.html')});const plugins=await win.webContents.executeJavaScript('ready');await new Promise(r=>setTimeout(r,100));console.log('DISABLED_PLUGINS:'+JSON.stringify({plugins,audit:await win.webContents.executeJavaScript('audit')}));win.destroy();app.exit(0)}catch(e){console.error(e);win.destroy();app.exit(1)}});`);
  const run=spawnSync(electron,[dir+'/main.cjs'],{encoding:'utf8',timeout:15000,env:{...process.env,ELECTRON_RUN_AS_NODE:''}});assert.equal(run.status,0,run.stdout+'\n'+run.stderr);
  const line=run.stdout.split('\n').find(s=>s.startsWith('DISABLED_PLUGINS:'));assert.ok(line,run.stdout);const result=JSON.parse(line.slice('DISABLED_PLUGINS:'.length));assert(result.plugins.length>=30);assert(result.plugins.every(p=>!p.enabled&&!p.started));assert.deepEqual(result.audit,{intervals:0,observers:0,frames:0,network:0,listeners:0,timeouts:0});console.log('DISABLED_PLUGINS_AUDIT:'+JSON.stringify({count:result.plugins.length,...result.audit}));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('plugin bulk UI: filtered list still updates all, exact restore, close/reopen during work, keyboard focus, locales and narrow layout',{skip:!electron,timeout:30000},async()=>{
 const dir=mkdtempSync(tmpdir()+'/syncord-plugin-bulk-ui-');
 try{
  await build({stdin:{resolveDir:root,contents:`
   import {settings} from './src/renderer/api/settings';import * as manager from './src/renderer/api/plugin/manager';
   import * as bulk from './src/renderer/api/plugin/bulk';import {openSettings,closeSettings} from './src/renderer/ui/settingsPanel';
   import {setLocale,SUPPORTED_LOCALES,t} from './src/renderer/i18n';
   window.api={...manager,...bulk,settings,openSettings,closeSettings,setLocale,SUPPORTED_LOCALES,t};
   window.ready=(async()=>{await settings.init();for(const p of manager.list())settings.set('plugins.'+p.id+'.enabled',false);
    window.starts=Array(10).fill(0);window.cleanups=Array(10).fill(0);
    for(let i=0;i<10;i++){manager.definePlugin({id:'fixture-'+i,name:'Fixture '+i,permissions:{},enabledByDefault:false,start(ctx){starts[i]++;ctx.disposable(()=>cleanups[i]++);},async stop(){if(window.stopGate)await window.stopGate;}});settings.set('plugins.fixture-'+i+'.enabled',i<7);}
    await manager.startAll();await settings.flush();})();
  `},bundle:true,platform:'browser',format:'iife',outfile:dir+'/fixture.js',loader:{'.png':'dataurl'},define:{__SYNCORD_VERSION__:'"0.4.5"'},logLevel:'silent'});
  writeFileSync(dir+'/index.html','<!doctype html><html><style>body{margin:0;background:#111;color:#eee;font:14px system-ui;--font-primary:system-ui;--background-primary:#313338;--background-secondary:#202127;--text-normal:#eee;--text-muted:#aaa}</style><body><script>window.saved={};window.SyncordNative={getSettings:async()=>saved,setSettings:async value=>{saved=structuredClone(value)}};window.Syncord={common:{stores:{},actions:{},react:{},utils:{}},webpack:{getRequire:()=>undefined}};</script><script src="fixture.js"></script></body></html>');
  writeFileSync(dir+'/main.cjs',`
   const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict');app.setPath('userData',${JSON.stringify(dir+'/profile')});
   app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{backgroundThrottling:false}});try{
    await win.loadFile(${JSON.stringify(dir+'/index.html')});const run=s=>win.webContents.executeJavaScript(s),wait=ms=>new Promise(r=>setTimeout(r,ms));
    const idle=async()=>{for(let i=0;i<100;i++){if(!await run('api.pluginOperationBusy()'))return;await wait(10);}throw Error('Bulk stuck');};
    await run('ready');await run('api.openSettings()');assert.equal(await run('document.querySelectorAll("[data-plugin-bulk]").length'),3);
    assert.equal(await run('document.querySelector("[data-plugin-bulk=restore]").disabled'),true);
    await run('window.search=document.querySelector("[data-dion-search]");search.value="Fixture 0";search.dispatchEvent(new Event("input"))');
    assert.equal(await run('document.querySelectorAll("input[data-dion-plugin]").length'),1);
    await run('document.querySelector("[data-plugin-bulk=disable]").click()');await idle();
    assert.equal(await run('api.list().filter(p=>p.enabled||p.started).length'),0);assert.equal(await run('saved["ui.plugins.previousState"].states["fixture-6"]'),true);
    await run('document.querySelector("[data-plugin-bulk=restore]").focus()');assert.equal(await run('document.activeElement.dataset.pluginBulk'),'restore');await run('document.activeElement.click()');await idle();await wait(30);
    assert.equal(await run('api.list().filter(p=>p.started).length'),7);assert.equal(await run('starts.slice(7).every(n=>n===0)'),true);
    await run('window.stopGate=new Promise(resolve=>window.releaseStop=resolve);document.querySelector("[data-plugin-bulk=disable]").click()');await wait(20);
    assert.equal(await run('Array.from(document.querySelectorAll("[data-plugin-bulk],input[data-dion-plugin]")).every(el=>el.disabled)'),true);
    await run('api.closeSettings();api.openSettings()');assert.equal(await run('document.querySelector("[data-plugin-bulk=restore]").disabled'),true);
    await run('releaseStop();window.stopGate=undefined');await idle();await run('document.querySelector("[data-plugin-bulk=restore]").click()');await idle();assert.equal(await run('api.list().filter(p=>p.started).length'),7);
    for(const locale of await run('api.SUPPORTED_LOCALES')){await run('api.setLocale('+JSON.stringify(locale)+')');assert.equal(await run('document.querySelector("[data-plugin-bulk=restore]").textContent'),await run('api.t("pluginsBulk.restore")'));}
    await run('api.setLocale("tr")');win.setContentSize(650,850);await wait(50);assert.equal(await run('document.querySelector(".dion-panel").scrollWidth<=document.querySelector(".dion-panel").clientWidth+1'),true);
    if(process.env.SYNCORD_BULK_SCREENSHOT)require('node:fs').writeFileSync(process.env.SYNCORD_BULK_SCREENSHOT,(await win.webContents.capturePage()).toPNG());
    await run('api.openSettings("performance")');assert.equal(await run('getComputedStyle(document.querySelector("[data-dion-plugin-bulk]")).display'),'none');
    await run('api.closeSettings();api.stopAll();void 0');console.log('PLUGIN_BULK_UI_OK');win.destroy();app.exit(0);
   }catch(e){console.error(e);win.destroy();app.exit(1)}});
  `);
  const result=spawnSync(electron,[dir+'/main.cjs'],{encoding:'utf8',timeout:25000,env:{...process.env,ELECTRON_RUN_AS_NODE:''}});assert.equal(result.status,0,result.stdout+'\n'+result.stderr);assert.match(result.stdout,/PLUGIN_BULK_UI_OK/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
