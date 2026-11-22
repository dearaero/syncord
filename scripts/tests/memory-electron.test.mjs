import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';import {spawnSync} from 'node:child_process';import path from 'node:path';import {tmpdir} from 'node:os';
const root=process.cwd(),electron=['Electron.app/Contents/MacOS/Electron','electron.exe','electron'].map(p=>path.join(root,'node_modules/electron/dist',p)).find(existsSync);
async function checks(){
 const result={},wait=ms=>new Promise(r=>setTimeout(r,ms)),until=async(fn,label)=>{const start=Date.now();while(!await fn()){if(Date.now()-start>8000)throw Error('Timeout '+label);await wait(20);}};
 const seed=Array.from({length:1000},(_,i)=>({id:String(10000+i),channelId:'channel',authorId:'person',author:'Test',content:'original '+i,timestamp:Date.now()-i,edits:i===0?[{at:1,content:'first version'}]:undefined}));
 await new Promise((resolve,reject)=>{const r=indexedDB.open('Syncord',1);r.onupgradeneeded=()=>{r.result.createObjectStore('message-logger');r.result.createObjectStore('message-logger-files');};r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction(['message-logger','message-logger-files'],'readwrite');tx.objectStore('message-logger').put(seed,'entries');tx.objectStore('message-logger-files').put({name:'image.svg',type:'image/svg+xml',blob:new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'],{type:'image/svg+xml'})},'ui-0:0');tx.oncomplete=()=>{db.close();resolve();};};});
 logger.setLogLimit(0);logger.loadLog();await logger.whenLogReady();
 result.migrated=logger.logCount()===1000&&logger.entry('channel','10000').edits[0].content==='first version';
 const saved=await database.readStoredFile('ui-0:0');result.blobPreserved=saved.blob instanceof Blob;
 const originalPut=IDBObjectStore.prototype.put,puts=[];
 IDBObjectStore.prototype.put=function(value,key){if(this.name==='message-logger-rows')puts.push({array:Array.isArray(value),key});return originalPut.call(this,value,key);};
 logger.rememberEdit({id:'10000',channel_id:'channel',content:'original 0',author:{id:'person',username:'Test'}},'updated');
 logger.rememberDelete({id:'new',channel_id:'channel',content:'deleted body',author:{id:'person',username:'Test'}});
 await until(async()=>{const rows=await database.readLogRows();return rows.length===1001&&rows.find(r=>r.id==='10000')?.content==='updated';},'incremental write');
 result.incremental=puts.length===2&&puts.every(p=>!p.array)&&puts.some(p=>p.key==='10000')&&puts.some(p=>p.key==='new');
 const rows=await database.readLogRows();result.editsPreserved=rows.find(r=>r.id==='10000').edits.length===2;result.deletePreserved=rows.find(r=>r.id==='new').content==='deleted body';result.rawReleased=logger.liveMessage('new')===undefined;
 const native={id:'new',channel_id:'channel',content:'deleted body',hasFlag:()=>false};logger.rememberDelete(native);result.nativePreserved=logger.liveMessage('new')===native;
 try{await database.writeLogChanges([['partial',{id:'partial'}],['bad',{invalid:()=>{}}]]);result.atomic=false;}catch{result.atomic=!(await database.readLogRows()).some(r=>r.id==='partial');}
 logger.setLogLimit(2);await until(async()=> (await database.readLogRows()).length===2,'limit eviction');result.limit=logger.logCount()===2;
 // UI gets a large independent history. All rows remain reachable by scrolling.
 window.fixtureRows=Array.from({length:3000},(_,i)=>({id:'ui-'+i,channelId:'channel',author:'User '+i,content:i%25===0?'Long text '.repeat(300):'Message '+i,timestamp:Date.now()-i,deleted:1,attachments:i===0?[{name:'image.svg',url:'https://cdn.discordapp.com/attachments/1/2/image.svg'}]:undefined}));
 window.gc?.();const before=performance.memory?.usedJSHeapSize??0;
 const originalRAF=window.requestAnimationFrame.bind(window);let frames=0;window.requestAnimationFrame=fn=>{frames++;return originalRAF(fn);};
 view.openMessageLog();await wait(180);window.gc?.();const after=performance.memory?.usedJSHeapSize??0;
 const host=document.querySelector('[data-dion-log-list]'),scroller=document.querySelector('.dion-log-scroll');
 result.initialRows=host.querySelectorAll('.dion-log-row').length;result.heapDelta=after-before;const frameCount=frames;await wait(100);result.idle=frames===frameCount;
 result.count=document.querySelector('[data-dion-log-count]').textContent===new Intl.NumberFormat('en-US').format(3000)+' messages';
 const first=host.querySelector('.dion-log-file');first.click();await until(()=>document.querySelector('.dion-log-preview')?.matches(':modal'),'attachment preview');result.preview=true;document.querySelector('[data-dion-image-close]').click();
 const panel=document.querySelector('.dion-log-panel');panel.style.width='650px';await wait(120);result.resize=host.textContent.includes('User 0');
 const button=host.querySelector('.dion-log-file');button.focus();scroller.scrollTop=scroller.scrollHeight;scroller.dispatchEvent(new Event('scroll'));await wait(250);
 result.last=host.textContent.includes('User 2999');result.bounded=host.querySelectorAll('.dion-log-row').length<100;result.focus=document.activeElement===button&&button.isConnected;
 scroller.scrollTop=0;scroller.dispatchEvent(new Event('scroll'));await wait(150);result.returned=host.textContent.includes('User 0');
 document.querySelector('[data-dion-log-close]').click();result.closed=!document.getElementById('Syncord-log-root')&&host.childElementCount===0;
 logger.clearLog();await until(async()=>!(await database.readLogRows()).length,'clear');result.clear=logger.logCount()===0;
 IDBObjectStore.prototype.put=originalPut;logger.rememberDelete({id:'reload-check',channel_id:'channel',content:'persisted across reload',author:{id:'person',username:'Test'}});await until(async()=>(await database.readLogRows()).some(r=>r.id==='reload-check'),'reload preparation');
 return result;
}
function driver(dir){const{app,BrowserWindow}=require('electron'),path=require('node:path');app.disableHardwareAcceleration();process.on('uncaughtException',e=>{console.error(e);app.exit(1);});app.commandLine.appendSwitch('js-flags','--expose-gc');app.commandLine.appendSwitch('enable-precise-memory-info');app.setPath('userData',path.join(dir,'profile'));app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1050,height:850,webPreferences:{backgroundThrottling:false}});try{await w.loadFile(path.join(dir,'index.html'));const result=await w.webContents.executeJavaScript('('+checks.toString()+')()');await w.reload();await new Promise(r=>w.webContents.once('did-finish-load',r));result.reopen=await w.webContents.executeJavaScript("logger.loadLog();logger.whenLogReady().then(()=>logger.entry('channel','reload-check')?.content==='persisted across reload')");console.log('MEMORY_RESULT '+JSON.stringify(result));w.destroy();app.exit(0);}catch(error){console.error(error);app.exit(1);}});}
test('memory in real Electron: legacy log migration, incremental writes, rollback, limits, full scroll access, focused rows and attachment previews',{skip:!electron,timeout:30000},async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'syncord-memory-electron-'));
 try{
 const baseline=process.env.SYNCORD_MEMORY_BASELINE;
 await build({stdin:{resolveDir:root,contents:`import * as logger from './src/renderer/plugins/messageLogger/log';import * as database from './src/renderer/plugins/messageLogger/db';import * as view from './src/renderer/plugins/messageLogger/logModal';window.logger=logger;window.database=database;window.view=view;`},outfile:path.join(dir,'fixture.js'),bundle:true,platform:'browser',format:'iife',logLevel:'silent',plugins:[{name:'ui-fixture',setup(b){
 b.onResolve({filter:/^\.\/log$/},a=>a.importer.endsWith('/messageLogger/logModal.ts')?{path:'view-log',namespace:'fixture'}:undefined);
 b.onResolve({filter:/ui\/toast$/},()=>({path:'toast',namespace:'fixture'}));b.onResolve({filter:/ui\/tooltip$/},()=>({path:'tooltip',namespace:'fixture'}));
 if(baseline)b.onLoad({filter:/messageLogger\/logModal\.ts$/},()=>({contents:readFileSync(baseline,'utf8'),loader:'ts'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path==='view-log'?`export const listLog=()=>window.fixtureRows;export const loadLog=()=>{};export const whenLogReady=()=>Promise.resolve();export const onLogReset=()=>()=>{};`:a.path==='toast'?`export const showToast=()=>{};export const ToastType={FAILURE:2};`:`export const hideTooltip=()=>{};`}));
 }}]});
 writeFileSync(path.join(dir,'index.html'),'<!doctype html><html><body style="background:#17181b;color:white"><script src="fixture.js"></script></body></html>');writeFileSync(path.join(dir,'main.cjs'),`const checks=${checks.toString()};(${driver.toString()})(${JSON.stringify(dir)});`);
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const run=spawnSync(electron,[path.join(dir,'main.cjs')],{env,encoding:'utf8',timeout:25000,maxBuffer:2*1024*1024});assert.equal(run.status,0,run.stdout+run.stderr);const line=run.stdout.split('\n').find(l=>l.startsWith('MEMORY_RESULT '));assert.ok(line,run.stdout);const r=JSON.parse(line.slice(14));
 console.log(JSON.stringify({mode:baseline?'published-baseline':'optimized',renderedRows:r.initialRows,heapDelta:r.heapDelta}));
 for(const [k,v]of Object.entries(r)){if(['initialRows','heapDelta'].includes(k))continue;if(baseline&&['bounded','focus','closed'].includes(k))continue;assert.equal(v,true,k);}
 if(!baseline)assert.ok(r.initialRows<100);else assert.equal(r.initialRows,3000);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
