import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
const root=process.cwd();const electron=['Electron.app/Contents/MacOS/Electron','electron.exe','electron'].map(n=>path.join(root,'node_modules/electron/dist',n)).find(existsSync);
function setup(){
 window.calls=[];window.events=[];window.notices=[];window.disposers=[];window.saved=new Map();window.listeners=new Set();window.selected='200000000000000001';
 window.rateOnce=false;window.rateIssued=false;
 window.own='100000000000000001';window.other='100000000000000002';window.held=false;
 const make=(n,author)=>({id:String(300000000000000000n+BigInt(n)),channel_id:'200000000000000001',author:{id:author},type:0});
 window.historyMessages=Array.from({length:26},(_,i)=>make(26-i,i%2?other:own));
 window.select=next=>{selected=next;for(const fn of listeners)fn();};
 window.Syncord={common:{stores:{UserStore:{getCurrentUser:()=>({id:own}),getUser:()=>({username:'<img src=x onerror=alert(1)>'})},
 ChannelStore:{getChannel:id=>({id,type:1,recipients:[other]})},SelectedChannelStore:{getChannelId:()=>selected,addChangeListener:fn=>listeners.add(fn),removeChangeListener:fn=>listeners.delete(fn)}},
 utils:{RestAPI:{post(){},put(){},patch(){},async get(o){calls.push(['get',o]);return{status:200,body:historyMessages.filter(m=>BigInt(m.id)<BigInt(o.query.before)).slice(0,100)};},async del(o){calls.push(['del',o]);if(rateOnce&&!rateIssued){window.rateIssued=true;return{status:429};}if(held)await new Promise(resolve=>{window.releaseDelete=resolve;});return{status:204};}}},
 flux:{FluxDispatcher:{dispatch:e=>{events.push(e);return Promise.resolve();}}}}};
 window.cachedRest=Syncord.common.utils.RestAPI;Syncord.common.utils.RestAPI=undefined;Syncord.webpack={find:predicate=>[{Bo:cachedRest},cachedRest].find(predicate)};
 window.ctx={css:{inject(css){const s=document.createElement('style');s.textContent=css;document.head.append(s);disposers.push(()=>s.remove());}},settings:{get:(key,f)=>saved.get(key)??f,set:(key,v)=>saved.set(key,v)},log:{warn(){}},disposable:fn=>disposers.push(fn)};
}
async function checks(){
 const wait=ms=>new Promise(r=>setTimeout(r,ms));const until=async fn=>{for(let i=0;i<1000;i++){if(fn())return;await wait(10);}throw new Error('Cleaner UI timed out: '+JSON.stringify({calls:calls.map(c=>c[0]),status:document.querySelector('[role=status]')?.textContent}));};const result={};
 const button=()=>document.getElementById('Syncord-message-cleaner-toolbar-btn');const dialog=()=>document.querySelector('dialog');
 result.adjacent=button().parentElement.previousElementSibling.querySelector('#Syncord-recording-toolbar-btn')!==null;
 button().click();result.options=Array.from(dialog().querySelector('[data-limit]').options).map(o=>o.value);result.noImmediateDeletion=calls.length===0;
 result.nativeTopLayer=dialog().open;result.safeName=dialog().querySelector('[data-target]').textContent.includes('<img')&&!dialog().querySelector('img');
 result.styledButton=getComputedStyle(dialog().querySelector('[data-start]')).backgroundColor==='rgb(218, 55, 60)';
 result.defaultSteady=dialog().querySelector('[data-speed]').value==='steady';
 dialog().querySelector('[data-speed]').value='adaptive';
 result.responsive=dialog().getBoundingClientRect().width<=innerWidth;
 dialog().querySelector('[data-start]').click();await until(()=>dialog().querySelector('[role=status]').textContent.includes('Cleanup complete.'));
 result.realMetricsVisible=!dialog().querySelector('[data-performance]').hidden&&dialog().querySelector('[data-performance]').textContent.includes('individual deletions, overall average)')&&dialog().querySelector('[data-performance]').textContent.includes('Recent speed:')&&dialog().querySelector('[data-performance]').textContent.includes('API/queue average')&&dialog().querySelector('[data-performance]').textContent.includes('rate-limit waits')&&dialog().querySelector('[data-performance]').textContent.includes('Automatic start interval');
 result.modeSaved=saved.get('speedMode')==='adaptive';
 result.deletedTen=calls.filter(c=>c[0]==='del').length===10&&events.length===10;
 result.ownOnly=events.every(e=>historyMessages.find(m=>m.id===e.id)?.author.id===own);
 dialog().querySelector('[data-close]').click();calls.length=0;events.length=0;window.rateOnce=true;button().click();dialog().querySelector('[data-start]').click();
 await until(()=>dialog().querySelector('[role=status]').textContent.includes('resume automatically'));
 result.automaticRecoveryVisible=!dialog().querySelector('[data-stop]').hidden&&dialog().querySelector('[data-start]').hidden&&button().dataset.active==='true';
 await until(()=>dialog().querySelector('[role=status]').textContent.includes('Cleanup complete.'));
 result.resumedAfterRate=calls.filter(c=>c[0]==='del').length===11&&events.length===10&&dialog().querySelector('[data-performance]').textContent.includes('429 responses 1')&&dialog().querySelector('[data-performance]').textContent.includes('Missing retry time; recovery backoff');
 window.rateOnce=false;dialog().querySelector('[data-close]').click();
 window.held=true;calls.length=0;events.length=0;button().click();dialog().querySelector('[data-limit]').value='all';dialog().querySelector('[data-limit]').dispatchEvent(new Event('change'));
 dialog().querySelector('[data-cooldown]').value='0.1';dialog().querySelector('[data-start]').click();await until(()=>window.releaseDelete);
 result.runningRed=button().dataset.active==='true';result.savedCooldown=saved.get('cooldown')==='0.1';
 dialog().querySelector('[data-close]').click();window.select('200000000000000002');button().click();
 result.targetPinned=dialog().querySelector('[data-target]').textContent.includes('200000000000000001');
 result.optionsLocked=dialog().querySelector('[data-speed]').disabled&&dialog().querySelector('[data-speed]').value==='adaptive'&&dialog().querySelector('[data-limit]').value==='all'&&dialog().querySelector('[data-limit]').disabled&&dialog().querySelector('[data-cooldown]').disabled;
 dialog().querySelector('[data-stop]').click();window.releaseDelete();await until(()=>dialog().querySelector('[role=status]').textContent.includes('Cleanup stopped.'));
 result.cancelledAfterOne=calls.filter(c=>c[0]==='del').length===1&&events.length===1;
 dialog().querySelector('[data-close]').click();await wait(20);
 window.select(undefined);result.visibleOutsideChat=!button().hidden;button().click();result.noChatExplained=!dialog()&&notices.at(-1)?.text==='Open a DM or a text channel first.';
 window.select('200000000000000001');result.visibleInChat=!button().hidden;
 const toolbar=document.getElementById('toolbar');toolbar.innerHTML='<div><button id="Syncord-multichat-toolbar-btn">Canvas</button></div><div><button id="Syncord-recording-toolbar-btn">Record</button></div>';await until(()=>button());
 result.remountedOnce=document.querySelectorAll('#Syncord-message-cleaner-toolbar-btn').length===1;
 button().click();dialog().querySelector('[data-cooldown]').value='';dialog().querySelector('[data-start]').click();await until(()=>calls.filter(c=>c[0]==='del').length===2);
 disposers.reverse().forEach(fn=>fn());window.held=false;window.releaseDelete();await wait(30);
 result.cleaned=!button()&&!dialog()&&listeners.size===0;
 result.noContinueAfterDisable=calls.filter(c=>c[0]==='del').length===2;
 toolbar.append(document.createElement('span'));await wait(30);result.staysClean=!button();
 return result;
}
function driver(dir,checks){const {app,BrowserWindow}=require('electron');app.disableHardwareAcceleration();app.setPath('userData',require('node:path').join(dir,'profile'));app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:430,height:730,webPreferences:{backgroundThrottling:false}});try{await w.loadFile(require('node:path').join(dir,'index.html'));if(process.env.CLEANER_SCREENSHOT_PATH){await w.webContents.executeJavaScript("document.getElementById('Syncord-message-cleaner-toolbar-btn').click()");await new Promise(resolve=>setTimeout(resolve,150));require('node:fs').writeFileSync(process.env.CLEANER_SCREENSHOT_PATH,(await w.webContents.capturePage()).toPNG());}const r=await w.webContents.executeJavaScript('('+checks+')()');console.log('CLEANER_UI:'+JSON.stringify(r));w.destroy();app.exit(0);}catch(e){console.error(e.stack);app.exit(1);}});}
test('Message Cleaner UI: toolbar placement, explicit deletion options, pinned target, progress/stop, responsive safe dialog and cleanup',{skip:!electron&&'Electron missing',timeout:20000},async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'syncord-cleaner-ui-'));
 try{
 await build({stdin:{resolveDir:root,loader:'ts',contents:`import {MessageCleanerPlugin} from './src/renderer/plugins/messageCleaner';MessageCleanerPlugin.start(window.ctx);`},bundle:true,platform:'browser',format:'iife',outfile:path.join(dir,'fixture.js'),logLevel:'warning',plugins:[{name:'fixture',setup(b){
 b.onResolve({filter:/api\/plugin$/},()=>({path:'plugin',namespace:'fixture'}));b.onResolve({filter:/ui\/toast$/},()=>({path:'toast',namespace:'fixture'}));b.onResolve({filter:/ui\/tooltip$/},()=>({path:'tooltip',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>({loader:'js',contents:a.path==='plugin'?'export const definePlugin=p=>p;':a.path==='tooltip'?'export const bindTooltip=()=>()=>{};':'export const ToastType={SUCCESS:"success",FAILURE:"failure"};export const showToast=(text,options)=>window.notices.push({text,...options});'}));}}]});
 writeFileSync(path.join(dir,'index.html'),`<!doctype html><html><head><style>body{background:#1e1f22;color:white;font:14px system-ui}#toolbar{display:flex}</style></head><body><div id="toolbar"><div><button id="Syncord-multichat-toolbar-btn">Canvas</button></div><div><button id="Syncord-recording-toolbar-btn">Record</button></div></div><script>(${setup.toString()})();</script><script src="fixture.js"></script></body></html>`);
 writeFileSync(path.join(dir,'main.cjs'),`(${driver.toString()})(${JSON.stringify(dir)},${JSON.stringify(checks.toString())});`);
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const run=spawnSync(electron,[path.join(dir,'main.cjs')],{env,encoding:'utf8',timeout:15000});assert.equal(run.status,0,`${run.error??''}\n${run.stdout}\n${run.stderr}`);
 const line=run.stdout.split('\n').find(l=>l.startsWith('CLEANER_UI:'));assert.ok(line,run.stdout);const v=JSON.parse(line.slice('CLEANER_UI:'.length));assert.deepEqual(v.options,['10','100','all']);
 for(const key of ['defaultSteady','modeSaved','adjacent','noImmediateDeletion','nativeTopLayer','safeName','styledButton','responsive','deletedTen','realMetricsVisible','ownOnly','automaticRecoveryVisible','resumedAfterRate','runningRed','savedCooldown','targetPinned','optionsLocked','cancelledAfterOne','visibleOutsideChat','noChatExplained','visibleInChat','remountedOnce','cleaned','noContinueAfterDisable','staysClean'])assert.equal(v[key],true,key);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
