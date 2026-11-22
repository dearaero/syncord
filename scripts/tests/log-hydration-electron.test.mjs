import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';import {spawnSync} from 'node:child_process';import path from 'node:path';import {tmpdir} from 'node:os';
const root=process.cwd(),electron=['Electron.app/Contents/MacOS/Electron','electron.exe','electron'].map(p=>path.join(root,'node_modules/electron/dist',p)).find(existsSync);
async function checks(){
 const complete=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(tx.error);});
 const open=()=>new Promise((resolve,reject)=>{const r=indexedDB.open('Syncord',3);r.onupgradeneeded=()=>{for(const name of ['message-logger','message-logger-files','message-logger-rows'])r.result.createObjectStore(name);};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 const db=await open(),n=4000;let tx=db.transaction('message-logger-rows','readwrite'),done=complete(tx);
 for(let i=0;i<n;i++)tx.objectStore('message-logger-rows').put({id:String(10000+i),channelId:'channel',authorId:'person',author:'Test',timestamp:i*17%n,content:'message '+i+' '+String(i).padStart(4,'0').repeat(1024),deleted:1,edits:[{at:1,content:'older version '+i}]},String(10000+i));
 await done;
 tx=db.transaction('message-logger-files','readwrite');done=complete(tx);tx.objectStore('message-logger-files').put({name:'kept.png',blob:new Blob(['saved'])},'kept');await done;db.close();
 globalThis.gc?.();const before=performance.memory.usedJSHeapSize;
 const getAll=IDBObjectStore.prototype.getAll,openCursor=IDBObjectStore.prototype.openCursor;let reads=0,peakCount=0,getAllCalls=0;
 IDBObjectStore.prototype.getAll=function(...args){if(this.name==='message-logger-rows'){getAllCalls++;if(!window.baseline)throw Error('Whole-history startup read is forbidden');}return getAll.apply(this,args);};
 IDBObjectStore.prototype.openCursor=function(...args){const request=openCursor.apply(this,args);if(this.name==='message-logger-rows')request.addEventListener('success',()=>{const row=request.result;if(!row)return;reads++;peakCount=Math.max(peakCount,logger.logCount());if(row.key==='10010')logger.rememberDelete({id:'13999',channel_id:'channel',content:'new live body',author:{id:'person',username:'Live'},timestamp:99999});});return request;};
 logger.setLogLimit(800);const start=performance.now();logger.loadLog();await logger.whenLogReady();const duration=performance.now()-start,after=performance.memory.usedJSHeapSize;
 const rows=logger.listLog(),live=logger.entry('channel','13999');
 const streamed=!window.baseline&&reads===n&&getAllCalls===0&&peakCount<=800;
 const expected=new Set(Array.from({length:n},(_,i)=>i).filter(i=>i!==3999).sort((a,b)=>(b*17%n)-(a*17%n)).slice(0,799).map(i=>String(10000+i)));const latest=rows.filter(r=>r.id!=='13999').every(r=>expected.has(r.id)),versions=rows.filter(r=>r.id!=='13999').every(r=>r.edits[0].content.startsWith('older version'));
 const liveWins=live?.content==='new live body';
 const blob=await database.readStoredFile('kept');
 IDBObjectStore.prototype.getAll=getAll;IDBObjectStore.prototype.openCursor=openCursor;
 let stopped=0;await database.visitLogRows(()=>{stopped++;return false;});
 let rejected=false;try{await database.visitLogRows(()=>{throw Error('visitor failed');});}catch(error){rejected=error.message==='visitor failed';}
 let stillReadable=0;await database.visitLogRows(()=>{stillReadable++;return false;});
 return{streamed,latest,versions,liveWins,count:rows.length,files:blob?.blob.size===5,stopped:stopped===1,rejected,stillReadable:stillReadable===1,duration,heapTransient:after-before,reads,getAllCalls};
}
test('log startup in real Electron: streaming bounded history, newest timestamps, live-event races, files and cancellation',{skip:!electron,timeout:45000},async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'syncord-log-hydration-')),baseline=process.env.SYNCORD_LOG_HYDRATION_BASELINE;
 try{
  await build({stdin:{resolveDir:root,contents:`import * as logger from './src/renderer/plugins/messageLogger/log';import * as database from './src/renderer/plugins/messageLogger/db';window.logger=logger;window.database=database;window.baseline=${!!baseline};`},outfile:path.join(dir,'fixture.js'),bundle:true,platform:'browser',format:'iife',logLevel:'silent',plugins:[{name:'fixture',setup(b){
   if(baseline)b.onLoad({filter:/messageLogger\/log\.ts$/},()=>({contents:readFileSync(baseline,'utf8'),loader:'ts'}));
   b.onResolve({filter:/^\.\/files$/},a=>a.importer.endsWith('/messageLogger/log.ts')?{path:'files',namespace:'fixture'}:undefined);
   b.onResolve({filter:/ui\/toast$/},()=>({path:'toast',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path==='files'?'export const forgetMessageFiles=()=>{},queueMessageFiles=()=>{},wipeSavedFiles=async()=>{};':'export const showToast=()=>{};'}));
  }}]});
  writeFileSync(path.join(dir,'index.html'),'<!doctype html><script src="fixture.js"></script>');
  writeFileSync(path.join(dir,'main.cjs'),`const {app,BrowserWindow}=require('electron');const path=require('node:path');app.disableHardwareAcceleration();app.commandLine.appendSwitch('js-flags','--expose-gc');app.commandLine.appendSwitch('enable-precise-memory-info');app.setPath('userData',path.join(__dirname,'profile'));app.whenReady().then(async()=>{const w=new BrowserWindow({show:false});try{await w.loadFile(path.join(__dirname,'index.html'));console.log('HYDRATION '+JSON.stringify(await w.webContents.executeJavaScript('('+${JSON.stringify(checks.toString())}+')()')));app.exit(0);}catch(e){console.error(e);app.exit(1);}});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const run=spawnSync(electron,[path.join(dir,'main.cjs')],{env,encoding:'utf8',timeout:35000,maxBuffer:1024*1024});assert.equal(run.status,0,run.stdout+run.stderr);const line=run.stdout.split('\n').find(l=>l.startsWith('HYDRATION '));assert.ok(line,run.stdout+run.stderr);const r=JSON.parse(line.slice(10));console.log(JSON.stringify({mode:baseline?'previous':'streamed',...r}));
  assert.equal(r.count,800);for(const key of ['latest','versions','liveWins','files','stopped','rejected','stillReadable'])assert.equal(r[key],true,key);if(!baseline)assert.equal(r.streamed,true);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
