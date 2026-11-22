import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {mkdtempSync,writeFileSync,existsSync,rmSync} from "node:fs";
import {spawnSync} from "node:child_process";
import path from "node:path";
import {tmpdir} from "node:os";
const root=process.cwd();const electron=["Electron.app/Contents/MacOS/Electron","electron.exe","electron"].map(n=>path.join(root,"node_modules/electron/dist",n)).find(existsSync);
function setup(){
 window.saved=new Map();window.disposers=[];window.calls=[];window.notices=[];
 window.fake={phase:"idle",startedAt:null,bytes:0,detail:"Ready to record.",id:null,systemAudio:true,directory:"/test/Videos/Syncord Recordings"};
 window.discordInput='native-input';window.missingDiscordInput=false;
 window.Syncord={common:{stores:{MediaEngineStore:{getInputDeviceId:()=>discordInput,getInputDevices:()=>missingDiscordInput?{}:{'native-input':{id:'native-input',name:'Discord microphone'},'second-input':{id:'second-input',name:'Second Discord microphone'}}}}}};
 window.ctx={css:{inject(css){const style=document.createElement('style');style.textContent=css;document.head.append(style);disposers.push(()=>style.remove());}},disposable:fn=>disposers.push(fn),recording:{
  status:async()=>({...fake}),start:async options=>{calls.push(['start',options]);if(window.startFailure)throw new Error(window.startFailure);fake={...fake,phase:'choosing',detail:'Choose a screen or window.'};return {...fake};},
  stop:async()=>{calls.push(['stop']);fake={...fake,phase:'idle',detail:'Recording saved.'};return {...fake};},
  devices:async()=>{calls.push(['devices']);return[{id:'label:Loopback test',label:'Loopback test'}];},
  list:async()=>({items:[{id:'1792010101000-'+'a'.repeat(32),name:'<img src=x onerror=alert(1)>',createdAt:1792010101000,durationMs:3000,bytes:2000000,width:640,height:360,fps:15,microphone:true,output:true,recovered:false}],next:null,directory:fake.directory}),
  play:async id=>{calls.push(['play',id]);throw new Error('Synthetic unavailable clip');},readPlayback:async()=>new ArrayBuffer(0),closePlayback:async token=>calls.push(['closePlayback',token]),reveal:async id=>calls.push(['reveal',id]),
 }};
}
async function checks(){
 const result={};const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async fn=>{for(let n=0;n<100;n++){if(fn())return;await wait(20);}throw new Error('UI condition timed out');};
 const toolbar=document.getElementById('Syncord-recording-toolbar-btn');result.nextToCanvas=toolbar.parentElement.previousElementSibling.querySelector('#Syncord-multichat-toolbar-btn')!==null;
 result.idleNotRed=toolbar.dataset.recording==='false';
 document.querySelector('[data-recorder-expand]').click();result.expanded=document.querySelector('.dion-plugin').classList.contains('is-open');
 const resolution=document.querySelector('[data-recorder-option=resolution]');resolution.value='720';resolution.dispatchEvent(new Event('change',{bubbles:true}));result.resolutionSaved=saved.get('plugins.screen-recorder.data.resolution')===720;
 result.noDeviceUI=!document.querySelector('[data-recorder-device],[data-recorder-devices]');
 saved.set('plugins.screen-recorder.data.microphoneDevice','label:Old input');saved.set('plugins.screen-recorder.data.outputDevice','label:Old loopback');
 const output=document.querySelector('[data-recorder-option=output]');output.checked=true;output.dispatchEvent(new Event('change',{bubbles:true}));
 const mic=document.querySelector('[data-recorder-option=microphone]');mic.checked=true;mic.dispatchEvent(new Event('change',{bubbles:true}));
 toolbar.click();await until(()=>calls.some(c=>c[0]==='start'));await wait(20);result.sourceChoosing=toolbar.getAttribute('aria-label')==='Stop screen recording';result.notRedBeforeStarted=toolbar.dataset.recording==='false';
 fake={...fake,phase:'recording',startedAt:Date.now(),detail:'Recording…'};await window.refreshRecorder();result.redWhileRecording=toolbar.dataset.recording==='true'&&toolbar.getAttribute('aria-pressed')==='true';
 result.options=calls.find(c=>c[0]==='start')[1];
 toolbar.click();await until(()=>calls.some(c=>c[0]==='stop'));await wait(20);result.notRedAfterStop=toolbar.dataset.recording==='false';
 result.noAudioPrompt=!document.querySelector('.Syncord-recording-audio-setup')&&!calls.some(c=>c[0]==='devices');
 calls.length=0;window.discordInput='second-input';toolbar.click();await until(()=>calls.some(c=>c[0]==='start'));result.changedInput=calls.find(c=>c[0]==='start')[1].microphoneDevice==='label:Second Discord microphone';toolbar.click();await until(()=>fake.phase==='idle');await wait(20);
 calls.length=0;window.discordInput='default';toolbar.click();await until(()=>calls.some(c=>c[0]==='start'));result.defaultInput=calls.find(c=>c[0]==='start')[1].microphoneDevice==='';toolbar.click();await until(()=>fake.phase==='idle');await wait(20);
 calls.length=0;window.discordInput='native-input';window.missingDiscordInput=true;toolbar.click();await until(()=>notices.some(n=>n.text.includes("selected microphone is unavailable")));result.noWrongMicFallback=!calls.some(c=>c[0]==='start');window.missingDiscordInput=false;
 const originalStore=window.Syncord.common.stores.MediaEngineStore;window.Syncord.common.stores.MediaEngineStore=undefined;
 calls.length=0;toolbar.click();await until(()=>notices.some(n=>n.text.includes('Discord audio settings are not ready')));result.missingStoreNoWrongMic=!calls.some(c=>c[0]==='start');window.Syncord.common.stores.MediaEngineStore=originalStore;
 window.startFailure="Error invoking remote method 'Syncord_RECORDING_START': Error: Test capture failure.";
 toolbar.click();await until(()=>notices.some(n=>n.text==='Test capture failure.'));result.cleanFailure=notices.at(-1).text==='Test capture failure.';window.startFailure=null;calls.length=0;await window.refreshRecorder();
 window.missingDiscordInput=true;mic.checked=false;mic.dispatchEvent(new Event('change',{bubbles:true}));toolbar.click();await until(()=>calls.some(c=>c[0]==='start'));result.disabledMicDoesNotResolveInput=!calls.find(c=>c[0]==='start')[1].microphone;toolbar.click();await until(()=>fake.phase==='idle');await wait(20);window.missingDiscordInput=false;
 document.querySelector('[data-recorder-library]').click();await until(()=>document.querySelector('.Syncord-recording-library article'));
 const dialog=document.querySelector('dialog');result.topLayer=dialog.open;result.safeTitle=dialog.querySelector('h3').textContent.includes('<img')&&!dialog.querySelector('img');
 dialog.querySelector('[data-play]').click();await wait(10);result.inlinePreview=!!document.querySelector('.Syncord-recording-player')&&document.querySelector('.Syncord-recording-player').open;document.querySelector('[data-player-close]').click();dialog.querySelector('[data-reveal]').click();await wait(10);result.play=calls.some(c=>c[0]==='play');result.reveal=calls.some(c=>c[0]==='reveal');
 document.body.style.width='420px';await wait(20);result.libraryResponsive=dialog.getBoundingClientRect().width<=window.innerWidth;
 window.disposePanel();disposers.reverse().forEach(fn=>fn());await wait(20);result.cleaned=!document.getElementById('Syncord-recording-toolbar-btn')&&!document.querySelector('dialog');
 const wrapper=document.getElementById('toolbar');wrapper.append(document.createElement('div'));await wait(30);result.staysStopped=!document.getElementById('Syncord-recording-toolbar-btn');
 return result;
}
function driver(dir,checks){const {app,BrowserWindow}=require('electron');app.disableHardwareAcceleration();app.setPath('userData',require('node:path').join(dir,'profile'));
 app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:800,height:680,webPreferences:{backgroundThrottling:false}});try{await w.loadFile(require('node:path').join(dir,'index.html'));const r=await w.webContents.executeJavaScript('('+checks+')()');console.log('RECORDER_UI:'+JSON.stringify(r));w.destroy();app.exit(0);}catch(e){console.error(e.stack);app.exit(1);}});}
test('Screen Recorder UI: adjacent quick toggle, recording red state, automatic Discord input and no device picker, safe local library and complete cleanup',{skip:!electron&&'Electron missing',timeout:20_000},async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'syncord-recorder-ui-'));
 try{
  await build({stdin:{resolveDir:root,loader:'ts',contents:`import {ScreenRecorderPlugin} from './src/renderer/plugins/screenRecorder';import {bindRecorderPanel,recorderExpandButtonHtml,recorderSectionHtml} from './src/renderer/plugins/screenRecorder/panel';import {refreshRecorder} from './src/renderer/plugins/screenRecorder/runtime';window.refreshRecorder=refreshRecorder;document.getElementById('settings').innerHTML='<div class="dion-plugin"><div>'+recorderExpandButtonHtml()+'</div>'+recorderSectionHtml()+'</div>';window.disposePanel=bindRecorderPanel(document.getElementById('settings'));ScreenRecorderPlugin.start(window.ctx);`},bundle:true,platform:'browser',format:'iife',outfile:path.join(dir,'fixture.js'),logLevel:'warning',plugins:[{name:'fixture',setup(b){
   b.onResolve({filter:/api\/plugin$/},()=>({path:'plugin',namespace:'fixture'}));b.onResolve({filter:/api\/settings$/},()=>({path:'settings',namespace:'fixture'}));b.onResolve({filter:/ui\/toast$/},()=>({path:'toast',namespace:'fixture'}));
   b.onLoad({filter:/.*/,namespace:'fixture'},a=>({loader:'js',contents:a.path==='plugin'?'export const definePlugin=p=>p;':a.path==='settings'?'export const settings={get:(k,f)=>window.saved.has(k)?window.saved.get(k):f,set:(k,v)=>window.saved.set(k,v)};':'export const ToastType={SUCCESS:"success",FAILURE:"failure"};export const showToast=(text,options)=>window.notices.push({text,...options});'}));
  }}]});
  writeFileSync(path.join(dir,'index.html'),`<!doctype html><html><head><style>body{background:#1e1f22;color:white;font:14px system-ui}.dion-plugin-details{display:none}.is-open .dion-plugin-details{display:block}.dion-setting-row{display:flex;justify-content:space-between;gap:10px;padding:8px;align-items:center}.dion-setting-copy{display:flex;flex-direction:column}.dion-setting-desc{color:#999}.dion-details-head{display:flex;justify-content:space-between}.dion-select{max-width:220px}#toolbar{display:flex}</style></head><body><div id="toolbar"><div><div id="Syncord-multichat-toolbar-btn">Canvas</div></div><div aria-label="Inbox">Inbox</div></div><div id="settings"></div><script>(${setup.toString()})();</script><script src="fixture.js"></script></body></html>`);
  writeFileSync(path.join(dir,'main.cjs'),`(${driver.toString()})(${JSON.stringify(dir)},${JSON.stringify(checks.toString())});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const run=spawnSync(electron,[path.join(dir,'main.cjs')],{env,encoding:'utf8',timeout:15_000});assert.equal(run.status,0,`${run.error??''}\n${run.stdout}\n${run.stderr}`);
  const line=run.stdout.split('\n').find(l=>l.startsWith('RECORDER_UI:'));assert.ok(line,run.stdout);const v=JSON.parse(line.slice('RECORDER_UI:'.length));
  for(const k of ['nextToCanvas','idleNotRed','expanded','resolutionSaved','noDeviceUI','noAudioPrompt','changedInput','defaultInput','noWrongMicFallback','missingStoreNoWrongMic','cleanFailure','disabledMicDoesNotResolveInput','sourceChoosing','notRedBeforeStarted','redWhileRecording','notRedAfterStop','topLayer','safeTitle','play','inlinePreview','reveal','libraryResponsive','cleaned','staysStopped'])assert.equal(v[k],true,k);
  assert.equal(v.options.resolution,720);assert.equal(v.options.output,true);assert.equal(v.options.outputDevice,'');assert.equal(v.options.microphoneDevice,'label:Discord microphone');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
