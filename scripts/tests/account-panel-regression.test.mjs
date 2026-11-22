import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
const root=process.cwd(),electron=['Electron.app/Contents/MacOS/Electron','electron.exe','electron'].map(n=>path.join(root,'node_modules/electron/dist',n)).find(existsSync);
test('Hidden Channels retains the native dispatcher receiver and handles rejected dispatch promises',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'syncord-dispatch-regression-'));
 try{
  await build({stdin:{resolveDir:root,loader:'ts',contents:"export {revealChannelNames} from './src/renderer/plugins/showHiddenChannels/factoryPatch';"},bundle:true,platform:'node',format:'esm',outfile:path.join(dir,'test.mjs'),logLevel:'silent',plugins:[{name:'stubs',setup(b){
   b.onResolve({filter:/\/api\/logger$/},()=>({path:'logger',namespace:'fixture'}));b.onResolve({filter:/\/api\/settings$/},()=>({path:'settings',namespace:'fixture'}));b.onResolve({filter:/\/webpack$/},()=>({path:'webpack',namespace:'fixture'}));
   b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path==='logger'?"export const createLogger=()=>({warn:()=>{},info:()=>{}})":a.path==='settings'?"export const settings={get:()=>false}":"export const beforeWebpackReady=()=>{}"}));
  }}]});
  const {revealChannelNames}=await import(path.join(dir,'test.mjs'));const receiver={_waitQueue:[],dispatch(action){this._waitQueue.push(action);return Promise.resolve();}};
  globalThis.window={Syncord:{common:{flux:{FluxDispatcher:receiver}},webpack:{findByProps:()=>undefined}}};
  assert.equal(revealChannelNames(),true);assert.equal(receiver._waitQueue[0].type,'APEX_EXPERIMENT_OVERRIDE_CREATE');
  window.Syncord.common.flux.FluxDispatcher=undefined;window.Syncord.webpack.findByProps=()=>receiver;assert.equal(revealChannelNames(),true);assert.equal(receiver._waitQueue.length,2);
  receiver.dispatch=function(){assert.equal(this,receiver);return Promise.reject(new Error('Native dispatch unavailable'));};assert.equal(revealChannelNames(),true);await new Promise(r=>setTimeout(r,10));
 }finally{delete globalThis.window;rmSync(dir,{recursive:true,force:true});}
});
function setup(){
 window.disposers=[];
 const el=(value)=>{if(value==null)return document.createTextNode('');if(typeof value==='string')return document.createTextNode(value);const node=document.createElement(value.tag);for(const [k,v]of Object.entries(value.props??{})){if(k==='style')Object.assign(node.style,v);else if(k==='className')node.className=v;else if(k.startsWith('on')&&typeof v==='function')node.addEventListener(k.slice(2).toLowerCase(),v);else if(v!=null)node.setAttribute(k,String(v));}for(const child of value.children??[])node.append(el(child));return node;};
 window.Syncord={common:{react:{React:{createElement:(tag,props,...children)=>({tag,props,children}),useState:()=>[false,()=>{}]},ReactDOM:{createRoot:host=>({render:value=>host.replaceChildren(el(value)),unmount:()=>host.replaceChildren()})}}}};
 window.ctx={log:{warn(){},info(){},error(){}},css:{inject(){}},disposable:fn=>disposers.push(fn)};
 window.ui={read:()=>({active:false,mute:true,deaf:true}),toggleActive(){},setMute(){},setDeaf(){}};
}
async function checks(){
 const wait=ms=>new Promise(r=>setTimeout(r,ms));const out={};const settings=document.querySelector('[aria-label="User Settings"]');const initial=settings.getBoundingClientRect().top;
 window.removeFake=window.startFake(ctx,ui);await wait(80);
 // A stream of unrelated chat mutations must not rediscover/measure the account panel.
 const chat=document.createElement('main');document.body.append(chat);await wait(40);
 const query=document.querySelectorAll.bind(document),rect=Element.prototype.getBoundingClientRect;let documentQueries=0,rectReads=0;
 document.querySelectorAll=function(...args){documentQueries++;return query(...args);};Element.prototype.getBoundingClientRect=function(){rectReads++;return rect.call(this);};
 for(let i=0;i<32;i++){chat.textContent='Message '+i;await new Promise(requestAnimationFrame);}
 await wait(40);document.querySelectorAll=query;Element.prototype.getBoundingClientRect=rect;
 console.log('ACCOUNT_PERF:'+JSON.stringify({mutationFrames:32,documentQueries,rectReads}));
 if(!window.baselineMode)out.noChatScans=documentQueries===0&&rectReads===0;
 chat.remove();
 out.bounded=document.querySelector('#Syncord-fake-voice-slot').offsetHeight===32;out.nativeSamePosition=Math.abs(settings.getBoundingClientRect().top-initial)<1;
 // Native audio wrapper is taller than its buttons; copying that height must not expand the row.
 document.querySelector('.audioButtonParent_fixture').style.height='800px';document.body.append(document.createElement('span'));await wait(80);
 out.wrapperNotCopied=document.querySelector('#Syncord-fake-voice-slot').offsetHeight===32;
 // React may reparent native controls while keeping the old container alive.
 document.querySelector('.audioButtonParent_fixture').style.height='32px';
 const previous=document.getElementById('panel'),replacement=document.createElement('section');previous.id='old-panel';replacement.id='panel';replacement.setAttribute('aria-label','User status and settings');replacement.style.left='80px';replacement.append(document.getElementById('controls'));document.body.append(replacement);await wait(80);
 const moved=document.getElementById('Syncord-fake-voice-host'),reserved=document.getElementById('Syncord-fake-voice-slot');out.reparented=!moved.hidden&&Math.abs(moved.getBoundingClientRect().left-reserved.getBoundingClientRect().left)<1;
 // Reserving an extra control must not wrap the real settings/audio controls in a narrow sidebar.
 removeFake();document.querySelector('.audioButtonParent_fixture').style.height='32px';document.querySelector('#controls').style.width='130px';const narrow=settings.getBoundingClientRect().top;
 window.removeFake=window.startFake(ctx,ui);await wait(80);out.noWrap=Math.abs(settings.getBoundingClientRect().top-narrow)<1&&!document.querySelector('#Syncord-fake-voice-slot');
 removeFake();out.cleaned=!document.querySelector('#Syncord-fake-voice-host,#Syncord-fake-voice-slot');document.querySelector('#controls').style.width='300px';window.stressCycle=async()=>{const start=disposers.length,remove=startFake(ctx,ui);await new Promise(requestAnimationFrame);if(!document.getElementById('Syncord-fake-voice-host'))throw Error('Stress fixture could not mount');remove();for(const off of disposers.splice(start))off();await new Promise(requestAnimationFrame);};await stressCycle();return out;
}
function driver(dir,checks){const {app,BrowserWindow}=require('electron');app.disableHardwareAcceleration();app.setPath('userData',require('node:path').join(dir,'profile'));app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:800,height:650,webPreferences:{backgroundThrottling:false}});w.webContents.on('console-message',(_e,...args)=>{const message=typeof args[0]==='object'?args[0]?.message:args[1];if(message?.startsWith('ACCOUNT_PERF:'))console.log(message);});try{await w.loadFile(require('node:path').join(dir,'index.html'));console.log('ACCOUNT_LAYOUT:'+JSON.stringify(await w.webContents.executeJavaScript('('+checks+')()')));
 w.webContents.debugger.attach('1.3');await w.webContents.debugger.sendCommand('HeapProfiler.collectGarbage');const before=await w.webContents.debugger.sendCommand('Memory.getDOMCounters');await w.webContents.executeJavaScript('(async()=>{for(let i=0;i<20;i++)await stressCycle();})()');await w.webContents.debugger.sendCommand('HeapProfiler.collectGarbage');const after=await w.webContents.debugger.sendCommand('Memory.getDOMCounters');console.log('ACCOUNT_LEAK:'+JSON.stringify({cycles:20,before,after}));if(after.jsEventListeners>before.jsEventListeners||after.nodes>before.nodes+4)throw Error('Account UI resources accumulate across stop/start');w.webContents.debugger.detach();app.exit(0);}catch(e){console.error(e.stack);app.exit(1);}});}
test('Fake Voice reservation keeps native account controls in their row with stretched wrappers and narrow sidebars',{skip:!electron,timeout:15000},async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'syncord-account-layout-'));
 try{
  await build({stdin:{resolveDir:root,loader:'ts',contents:"import {installFakeVoiceUi} from './src/renderer/plugins/fakeVoice/ui';window.startFake=installFakeVoiceUi;"},bundle:true,platform:'browser',format:'iife',outfile:path.join(dir,'fixture.js'),logLevel:'silent',plugins:[{name:'performance-baseline',setup(b){if(process.env.SYNCORD_PERF_BASELINE)b.onLoad({filter:/plugins\/fakeVoice\/ui\.ts$/},()=>({contents:readFileSync(process.env.SYNCORD_PERF_BASELINE+'/fakeVoice.ts','utf8'),loader:'ts'}));}}]});
  writeFileSync(path.join(dir,'index.html'),`<style>body{margin:0;color:white;background:#111}#panel{position:fixed;bottom:10px;left:10px;width:400px;height:48px}#controls{display:flex;flex-wrap:wrap;align-items:center;width:300px}.audioButtonParent_fixture{display:flex;flex:0 0 48px;height:32px;align-items:flex-start}button{flex:none;width:32px;height:32px;padding:0}.chevron{width:16px}.colorBrand_fixture{color:gray}</style><section id="panel" aria-label="User status and settings"><div id="controls"><div class="audioButtonParent_fixture"><button role="switch" aria-checked="false" class="colorBrand_fixture" aria-label="Mute"><svg width="20" height="20"></svg></button><button class="chevron colorBrand_fixture"><svg width="12" height="12"></svg></button></div><div class="audioButtonParent_fixture"><button role="switch" aria-checked="false" class="colorBrand_fixture" aria-label="Deafen"><svg width="20" height="20"></svg></button><button class="chevron colorBrand_fixture"><svg width="12" height="12"></svg></button></div><button aria-label="User Settings">S</button></div></section><script>window.baselineMode=${Boolean(process.env.SYNCORD_PERF_BASELINE)};(${setup.toString()})();</script><script src="fixture.js"></script>`);
  writeFileSync(path.join(dir,'main.cjs'),`(${driver.toString()})(${JSON.stringify(dir)},${JSON.stringify(checks.toString())});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const r=spawnSync(electron,[path.join(dir,'main.cjs')],{env,encoding:'utf8',timeout:12000});assert.equal(r.status,0,r.stdout+r.stderr);const row=r.stdout.split('\n').find(l=>l.startsWith('ACCOUNT_LAYOUT:'));assert.ok(row,r.stdout);const perf=r.stdout.split('\n').find(l=>l.startsWith('ACCOUNT_PERF:'));if(perf)console.log(perf);const leak=r.stdout.split('\n').find(l=>l.startsWith('ACCOUNT_LEAK:'));if(leak)console.log(leak);const values=JSON.parse(row.slice('ACCOUNT_LAYOUT:'.length));for(const [k,v]of Object.entries(values))assert.equal(v,true,k);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
