import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from "node:fs";
import path from "node:path";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";
const root=process.cwd();const electron=["Electron.app/Contents/MacOS/Electron","electron.exe","electron"].map(n=>path.join(root,"node_modules/electron/dist",n)).find(existsSync);
const dir=mkdtempSync(path.join(tmpdir(),"syncord-recorder-unit-"));
await build({stdin:{resolveDir:root,contents:'export * from "./src/shared/recording";export * from "./src/main/recording/webm";',loader:"ts"},bundle:true,platform:"node",format:"esm",outfile:path.join(dir,"pure.mjs"),logLevel:"warning"});
const pure=await import(path.join(dir,"pure.mjs"));
test.after(()=>rmSync(dir,{recursive:true,force:true}));
test("recorder options and identities reject arbitrary paths, device payloads and oversized capture settings",()=>{
 assert.deepEqual(pure.parseRecordingOptions(pure.DEFAULT_RECORDING_OPTIONS),pure.DEFAULT_RECORDING_OPTIONS);
 for(const patch of [{resolution:9999},{fps:120},{output:"true"},{microphoneDevice:"x".repeat(257)},{outputDevice:null}])assert.throws(()=>pure.parseRecordingOptions({...pure.DEFAULT_RECORDING_OPTIONS,...patch}));
 const id="1792010101000-"+"a".repeat(32);assert.equal(pure.recordingId(id),id);
 for(const value of ["../private","file:///tmp/a",id+"/../b",id+".webm",null,{},"x".repeat(1000)])assert.throws(()=>pure.recordingId(value));
});
test("recording player supports bounded single ranges and rejects invalid/unsatisfiable reads",()=>{
 assert.deepEqual(pure.recordingRange(null,100),{start:0,end:99,partial:false});
 assert.deepEqual(pure.recordingRange("bytes=10-29",100),{start:10,end:29,partial:true});
 assert.deepEqual(pure.recordingRange("bytes=90-",100),{start:90,end:99,partial:true});
 assert.deepEqual(pure.recordingRange("bytes=-12",100),{start:88,end:99,partial:true});
 for(const h of ["bytes=100-","bytes=20-10","bytes=1-2,3-4","bytes=--1","bytes=-0","bytes=999999999999999999999999-"])assert.equal(pure.recordingRange(h,100),null);
});
test("WebM duration insertion updates only the header, retaining every encoded cluster byte",()=>{
 const info=Buffer.from([0x15,0x49,0xa9,0x66,0x87,0x2a,0xd7,0xb1,0x83,0x0f,0x42,0x40]);
 const segment=Buffer.from([0x18,0x53,0x80,0x67,0xff]);const cluster=Buffer.from([0x1f,0x43,0xb6,0x75,0x83,1,2,3]);
 const input=Buffer.concat([segment,info,cluster]);const result=pure.prepareWebmHeader(input);
 assert.equal(result.bytes.length,input.length+11);assert.equal(result.duration.length,8);assert.equal(result.duration.scale,1000000);
 assert.equal(result.bytes[9],0x92);assert.deepEqual(Buffer.from(result.bytes).subarray(-cluster.length),cluster);
 assert.deepEqual(pure.prepareWebmHeader(result.bytes).duration,result.duration);
 const finite=Buffer.from(input);finite[4]=0x94;assert.equal(pure.prepareWebmHeader(finite).duration,undefined);
 assert.deepEqual(Buffer.from(pure.prepareWebmHeader(Buffer.from([1,2,3])).bytes),Buffer.from([1,2,3]));
});
function fakeMedia(){
 window.audioRequests=0;
 Object.defineProperty(navigator,"mediaDevices",{configurable:true,value:{
   getDisplayMedia:async options=>{window.displayAudioConstraints=options.audio;const canvas=document.createElement("canvas");canvas.width=640;canvas.height=360;const ctx=canvas.getContext("2d");let n=0;
     const timer=setInterval(()=>{ctx.fillStyle=`hsl(${n++%360} 50% 40%)`;ctx.fillRect(0,0,640,360);ctx.fillStyle="white";ctx.fillText("Synthetic recording "+n,30,30);},30);
     const stream=canvas.captureStream(30);stream.getVideoTracks()[0].addEventListener("ended",()=>clearInterval(timer));window.addEventListener("beforeunload",()=>clearInterval(timer));
     if(options.audio){const audio=new AudioContext();const osc=audio.createOscillator();const dest=audio.createMediaStreamDestination();osc.connect(dest);osc.start();stream.addTrack(dest.stream.getAudioTracks()[0]);window.addEventListener("beforeunload",()=>{osc.stop();void audio.close();});}return stream;},
   getUserMedia:async()=>{window.audioRequests++;const audio=new AudioContext();const oscillator=audio.createOscillator();const dest=audio.createMediaStreamDestination();oscillator.connect(dest);oscillator.start();const track=dest.stream.getAudioTracks()[0];track.addEventListener("ended",()=>{oscillator.stop();void audio.close();});return dest.stream;},
   enumerateDevices:async()=>[{kind:"audioinput",label:"Test microphone",deviceId:"capture-mic"},{kind:"audioinput",label:"Test loopback",deviceId:"capture-loopback"}],
 }});
}
function driver(dir){
 const E=require("electron"),fs=require("node:fs"),path=require("node:path");const {app,BrowserWindow,session,ipcMain}=E;
 app.setPath("userData",path.join(dir,"profile"));app.setPath("videos",path.join(dir,"videos"));app.disableHardwareAcceleration();
 fs.mkdirSync(path.join(dir,"videos"),{recursive:true});
 const result={};const wait=ms=>new Promise(r=>setTimeout(r,ms));const until=async fn=>{for(let n=0;n<150;n++){if(await fn())return;await wait(100);}throw new Error("Timed out waiting for recorder state");};
 app.whenReady().then(async()=>{
   let owner;
   try{
     const R=require(path.join(dir,"main.js"));const C=require(path.join(dir,"contract.js"));
     R.registerIpc();
     const s=session.fromPartition("recorder-test-owner");s.protocol.handle("https",()=>new Response("<html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; media-src blob:; style-src 'unsafe-inline'; frame-src 'self'\"></head><body>Discord test owner</body></html>",{headers:{"Content-Type":"text/html"}}));
     let nativeScreenShareCalls=0;s.setDisplayMediaRequestHandler((_req,cb)=>{nativeScreenShareCalls++;cb({});});
     owner=new BrowserWindow({show:false,webPreferences:{session:s,preload:path.join(dir,"owner-preload.js"),sandbox:false,contextIsolation:true}});
     await owner.loadURL("https://discord.com/channels/@me");
     const devicePromise=R.recordingDevices(owner.webContents);
     await until(()=>BrowserWindow.getAllWindows().some(w=>w!==owner));
     const deviceWindow=BrowserWindow.getAllWindows().find(w=>w!==owner);
     await until(()=>deviceWindow.webContents.executeJavaScript("!!document.querySelector(\"#recording-app button\")"));
     await deviceWindow.webContents.executeJavaScript("window.localeButton=document.querySelector('#recording-app button')");
     for(const locale of ['en-US','es-ES','de','ja','fr','pt-BR','ru','it','nl','pl','tr','zh-CN','id','fa','cs','vi','ko','uk']){
       await owner.webContents.executeJavaScript("testRecording.setLocale("+JSON.stringify(locale)+")");
       await until(()=>deviceWindow.webContents.executeJavaScript("document.documentElement.lang==="+JSON.stringify(locale)));
       assert(await deviceWindow.webContents.executeJavaScript("document.querySelector('#recording-app button')===window.localeButton"),'locale change replaced the device button');
     }
     result.workerLocales=18;
     R.setRecordingLocale({id:owner.webContents.id},'ja');
     result.localeOwnerBound=await deviceWindow.webContents.executeJavaScript("document.documentElement.lang==='uk'");
     let rejected=0;for(const invalid of ['ar','tr-TR','<script>',null,{},42]){try{R.setRecordingLocale(owner.webContents,invalid);}catch{rejected++;}}
     result.invalidLocalesRejected=rejected===6;
     deviceWindow.webContents.send(C.RECORDING_IPC.LOCALE,{locale:'en-US',revision:0});await wait(20);
     result.staleLocaleIgnored=await deviceWindow.webContents.executeJavaScript("document.documentElement.lang==='uk'");
     await owner.webContents.executeJavaScript("testRecording.setLocale('en-US')");
     await until(()=>deviceWindow.webContents.executeJavaScript("document.documentElement.lang==='en-US'"));
     await deviceWindow.webContents.executeJavaScript("document.querySelector(\"#recording-app button\").click()",true);
     result.devices=await devicePromise;
     const navigationListeners=owner.webContents.listenerCount("did-start-navigation");
     const start=await R.startRecording(owner.webContents,{resolution:720,fps:15,microphone:true,microphoneDevice:"label:Test microphone",output:true,outputDevice:"label:Test loopback"});assert(start.phase==="choosing","source picker should open");
     const capture=BrowserWindow.getAllWindows().find(w=>w!==owner);assert(capture,"capture window exists");
     await until(()=>capture.webContents.executeJavaScript("!!document.querySelector('#sources button')"));
     await owner.webContents.executeJavaScript("history.pushState({},'', '/channels/@me/111');history.replaceState({},'', '/channels/@me/222')");
     await wait(100);
     assert(R.recordingStatus().phase==="choosing"&&!capture.isDestroyed(),"Chat navigation must preserve the source chooser");
     result.chooserSurvivesChatChange=true;
     result.noDiscordBridge=await capture.webContents.executeJavaScript("typeof window.SyncordNative === 'undefined'");
     result.sourceVisible=await capture.webContents.executeJavaScript("document.querySelector('#sources button span').textContent");
     result.remoteBlocked=await capture.webContents.executeJavaScript("fetch('https://example.com').then(()=>false,()=>true)");
     const invalid=await owner.webContents.executeJavaScript("window.probeWorker()");result.workerForgeryDenied=invalid;
     await capture.webContents.executeJavaScript("document.querySelector('#sources button').click()",true);
     await until(()=>R.recordingStatus().phase==="recording");
     result.captureHidden=!capture.isVisible();result.actual=R.recordingStatus();
     const startedAt=R.recordingStatus().startedAt;
     await wait(1200);const bytesBeforeNavigation=R.recordingStatus().bytes;
     await owner.webContents.executeJavaScript("history.pushState({},'', '/channels/@me/333');history.pushState({},'', '/channels/444/555');history.replaceState({},'', '/channels/444/666');location.hash='recording';");
     await wait(100);
     assert(R.recordingStatus().phase==="recording","Chat/channel navigation must not stop recording");
     await owner.webContents.executeJavaScript("history.back()");
     await until(()=>owner.webContents.getURL().endsWith('/channels/444/666'));
     await owner.webContents.executeJavaScript("history.forward()");
     await until(()=>owner.webContents.getURL().endsWith('#recording'));
     await owner.webContents.executeJavaScript("new Promise(resolve=>{const frame=document.createElement('iframe');frame.onload=()=>resolve();frame.src='/embedded';document.body.append(frame);})");
     // Older Electron versions report navigation flags only as positional arguments.
     owner.webContents.emit('did-start-navigation',{},owner.webContents.getURL(),true,true,0,0);
     owner.webContents.emit('did-start-navigation',{},'https://discord.com/embedded',false,false,0,0);
     await wait(1200);
     assert(R.recordingStatus().phase==="recording"&&R.recordingStatus().startedAt===startedAt&&!capture.isDestroyed(),"History/subframe changes must preserve the same recording");
     assert(R.recordingStatus().bytes>bytesBeforeNavigation,"Video chunks must keep arriving after navigation");
     result.recordingSurvivesNavigation=true;
     await wait(8000);await R.stopRecording(owner.webContents);await until(()=>R.recordingStatus().phase==="idle");
     result.navigationListenerCleaned=owner.webContents.listenerCount("did-start-navigation")===navigationListeners;
     const page=await R.listRecordings();assert(page.items.length===1,"one video should be saved");const item=page.items[0];
     result.item=item;result.noPartFiles=!fs.readdirSync(page.directory).some(n=>n.endsWith(".part"));
     const file=path.join(page.directory,item.id+".webm");const data=fs.readFileSync(file);result.header=data.subarray(0,4).toString("hex");
     result.traversalDenied=await R.listRecordings("../").then(()=>false,()=>true);
     result.defaultSharingUnchanged=nativeScreenShareCalls===0;
     const opened=await R.playRecording(owner.webContents,item.id);
     result.descriptor={mime:opened.mimeType,header:opened.header.byteLength,points:opened.points.length};
     const first=R.readRecordingPlayback(owner.webContents,opened.token,0);
     result.concurrentReadDenied=await R.readRecordingPlayback(owner.webContents,opened.token,0).then(()=>false,()=>true);
     result.originalBytes=Buffer.from(await first).equals(data);
     result.wrongTokenDenied=await R.readRecordingPlayback(owner.webContents,"wrong",0).then(()=>false,()=>true);
     result.wrongOwnerDenied=await R.readRecordingPlayback({id:owner.webContents.id},opened.token,0).then(()=>false,()=>true);
     result.offsetDenied=await R.readRecordingPlayback(owner.webContents,opened.token,-1).then(()=>false,()=>true);
     await R.closeRecordingPlayback(owner.webContents,opened.token);
     result.pathPlaybackDenied=await R.playRecording(owner.webContents,"../private").then(()=>false,()=>true);
     const raced=await Promise.allSettled([R.playRecording(owner.webContents,item.id),R.playRecording(owner.webContents,item.id)]);
     result.latestPreviewWins=raced.filter(r=>r.status==='fulfilled').length===1;
     const survivor=raced.find(r=>r.status==='fulfilled');await R.closeRecordingPlayback(owner.webContents,survivor.value.token);

     result.closedTokenDenied=await R.readRecordingPlayback(owner.webContents,opened.token,0).then(()=>false,()=>true);
     await owner.webContents.executeJavaScript(fs.readFileSync(path.join(dir,"player-renderer.js"),"utf8"));
     await owner.webContents.executeJavaScript("window.openTestPreview("+JSON.stringify(item)+")");
     await until(()=>owner.webContents.executeJavaScript("!!document.querySelector('.Syncord-recording-player video') && document.querySelector('video').readyState>=2"));
     result.noExtraPlayerWindow=BrowserWindow.getAllWindows().length===1;
     result.playback=await owner.webContents.executeJavaScript("({duration:document.querySelector('video').duration,width:document.querySelector('video').videoWidth,height:document.querySelector('video').videoHeight})");
     result.overlayAboveLibrary=await owner.webContents.executeJavaScript("(()=>{const r=document.querySelector('.Syncord-recording-player video').getBoundingClientRect();return !!document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('.Syncord-recording-player');})()");
     result.inline=await owner.webContents.executeJavaScript("document.querySelector('.Syncord-recording-player').open && document.querySelector('video').src.startsWith('blob:')");
     await owner.webContents.executeJavaScript("document.querySelector('video').currentTime=9");
     await until(()=>owner.webContents.executeJavaScript("!document.querySelector('video').seeking && document.querySelector('video').readyState>=2"));
     result.seekWorks=true;
     // Force a backwards seek outside retained data, then a forwards seek to a keyframe cluster.
     await owner.webContents.executeJavaScript("new Promise((r,j)=>{window.testBuffer.addEventListener('updateend',r,{once:true});window.testBuffer.remove(0,7);})");
     await owner.webContents.executeJavaScript("document.querySelector('video').currentTime=.5");
     await until(()=>owner.webContents.executeJavaScript("!document.querySelector('video').seeking && document.querySelector('video').readyState>=2 && document.querySelector('video').currentTime<1"));
     result.backwardSeekWorks=true;
     await owner.webContents.executeJavaScript("new Promise((r,j)=>{window.testBuffer.addEventListener('updateend',r,{once:true});window.testBuffer.remove(2,document.querySelector('video').duration);})");
     await owner.webContents.executeJavaScript("document.querySelector('video').currentTime=9");
     await until(()=>owner.webContents.executeJavaScript("!document.querySelector('video').seeking && document.querySelector('video').readyState>=2 && document.querySelector('video').currentTime>8"));
     result.forwardSeekWorks=true;
     const playbackTime=await owner.webContents.executeJavaScript("document.querySelector('video').currentTime");
     await owner.webContents.executeJavaScript("document.querySelector('video').muted=true;document.querySelector('video').play()",true);
     await until(()=>owner.webContents.executeJavaScript("document.querySelector('video').currentTime>"+(playbackTime+.2)));
     result.videoAdvances=true;
     owner.setSize(430,650);
     result.responsive=await owner.webContents.executeJavaScript("document.querySelector('.Syncord-recording-player').getBoundingClientRect().width<=window.innerWidth");


     result.readOffsets=await owner.webContents.executeJavaScript("window.testReadOffsets()");
     await owner.webContents.executeJavaScript("window.closeTestPreview()");
     result.inlineCleaned=await owner.webContents.executeJavaScript("!document.querySelector('.Syncord-recording-player')");
     await R.stopRecording(owner.webContents,true);result.releaseClosesPlayer=true;
     await R.startRecording(owner.webContents,{resolution:720,fps:15,microphone:false,microphoneDevice:"label:Test microphone",output:false,outputDevice:"label:Test loopback"});
     const silent=BrowserWindow.getAllWindows().find(w=>w!==owner);
     await until(()=>silent.webContents.executeJavaScript("!!document.querySelector('#sources button')"));
     await silent.webContents.executeJavaScript("document.querySelector('#sources button').click()",true);
     await until(()=>R.recordingStatus().phase==="recording");result.disabledAudioDoesNotRequestMic=await silent.webContents.executeJavaScript("window.probeAudioRequests()===0");
     await wait(300);await owner.loadURL("https://discord.com/channels/@me");await until(()=>R.recordingStatus().phase==="idle");
     result.documentNavigationStopsRecording=silent.isDestroyed()&&owner.webContents.listenerCount("did-start-navigation")===navigationListeners;
     result.silentFinal=R.recordingStatus();result.repeatedCaptureSaved=(await R.listRecordings()).items.length===2;
     if(R.recordingStatus().systemAudio){
       await R.startRecording(owner.webContents,{resolution:720,fps:15,microphone:false,microphoneDevice:'',output:true,outputDevice:''});
       const native=BrowserWindow.getAllWindows().find(w=>w!==owner);
       await until(()=>native.webContents.executeJavaScript("!!document.querySelector('#sources button')"));await native.webContents.executeJavaScript("document.querySelector('#sources button').click()",true);await until(()=>R.recordingStatus().phase==='recording');
       result.nativeLoopback=await native.webContents.executeJavaScript("window.probeAudioRequests()===0 && window.probeDisplayAudio().restrictOwnAudio===false && window.probeDisplayAudio().suppressLocalAudioPlayback===false");
       await wait(300);await R.stopRecording(owner.webContents);await until(()=>R.recordingStatus().phase==='idle');
       const nativeItem=(await R.listRecordings()).items[0];result.nativeOutputSaved=nativeItem.output&&!nativeItem.microphone&&nativeItem.bytes>1000;
     }else{result.nativeLoopback=result.nativeOutputSaved=true;}
     owner.destroy();console.log("RECORDER_RESULT:"+JSON.stringify(result));app.exit(0);
   }catch(error){console.error(error.stack);app.exit(1);}
 });
 function assert(value,message){if(!value)throw new Error(message);}
}
test("real Electron: isolated source chooser, mixed audio, bounded in-client playback/seek, no extra window, and sender-bound authorization",{skip:!electron&&"Electron is not installed",timeout:45_000},async()=>{
 const temp=mkdtempSync(path.join(tmpdir(),"syncord-recorder-electron-"));
 try{
  const fixture={name:"recorder-fixture",setup(b){
   b.onResolve({filter:/^electron$/},args=>args.namespace==="fixture"?{path:"electron",external:true}:{path:"electron",namespace:"fixture"});
   b.onResolve({filter:/security\/modes$/},()=>({path:"modes",namespace:"fixture"}));
   b.onLoad({filter:/.*/,namespace:"fixture"},args=>({loader:"js",contents:args.path==="modes"?"export const isSafeMode=()=>false,isLockdown=()=>false,exitSafeMode=()=>{},enableLockdown=()=>{},isDeveloperMode=()=>false,onModeRestricted=()=>()=>{};":`const E=require('electron');export const app=E.app,BrowserWindow=E.BrowserWindow,webContents=E.webContents,session=E.session,screen=E.screen,ipcMain=E.ipcMain,shell=E.shell,safeStorage=E.safeStorage,dialog=E.dialog,clipboard=E.clipboard,ClipboardItem=E.ClipboardItem;export const desktopCapturer={getSources:async()=>[{id:'screen:synthetic:0',name:'Synthetic screen',thumbnail:E.nativeImage.createEmpty()}]};`}));
  }};
  await build({stdin:{resolveDir:root,loader:"ts",contents:'export * from "./src/main/recording";export {registerIpc} from "./src/main/ipc";export * from "./src/main/recording/playback";'},bundle:true,platform:"node",format:"cjs",outfile:path.join(temp,"main.js"),plugins:[fixture],logLevel:"warning"});
  await build({stdin:{resolveDir:root,loader:"ts",contents:`import {contextBridge} from 'electron';import {bootstrapRecordingWindow} from './src/preload/recording';(${fakeMedia.toString()})();contextBridge.exposeInMainWorld('probeAudioRequests',()=>window.audioRequests);contextBridge.exposeInMainWorld('probeDisplayAudio',()=>window.displayAudioConstraints);bootstrapRecordingWindow();`},bundle:true,platform:"node",format:"cjs",external:["electron"],outfile:path.join(temp,"preload.js"),logLevel:"warning"});
  await build({entryPoints:[path.join(root,"src/shared/recording.ts")],bundle:true,platform:"node",format:"cjs",outfile:path.join(temp,"contract.js"),logLevel:"warning"});
  const playerCss=readFileSync(path.join(root,"src/renderer/plugins/screenRecorder/index.ts"),"utf8").split("const PLAYER_CSS = `")[1].split("`;\nconst CSS")[0];
  await build({stdin:{resolveDir:root,loader:"ts",contents:`const style=document.createElement("style");style.textContent=${JSON.stringify(playerCss)};document.head.append(style);document.body.style.cssText="background:#1e1f22;color:#fff;font:14px system-ui";const library=document.createElement("dialog");library.textContent="Recordings library underneath the preview";document.body.append(library);library.showModal();import {openRecordingPlayer,closeRecordingPlayer} from './src/renderer/plugins/screenRecorder/player';const add=MediaSource.prototype.addSourceBuffer;MediaSource.prototype.addSourceBuffer=function(...args){const buffer=add.apply(this,args);window.testBuffer=buffer;return buffer;};window.openTestPreview=item=>openRecordingPlayer(item,window.testRecording);window.closeTestPreview=closeRecordingPlayer;`},bundle:true,platform:"browser",format:"iife",outfile:path.join(temp,"player-renderer.js"),logLevel:"warning"});
  writeFileSync(path.join(temp,"owner-preload.js"),`const {contextBridge,ipcRenderer}=require('electron');const offsets=[];contextBridge.exposeInMainWorld('testReadOffsets',()=>offsets);contextBridge.exposeInMainWorld('testRecording',{setLocale:locale=>ipcRenderer.invoke('Syncord_RECORDING_LOCALE',locale),play:id=>ipcRenderer.invoke('Syncord_RECORDING_PLAY',id),readPlayback:(token,offset)=>{offsets.push(offset);return ipcRenderer.invoke('Syncord_RECORDING_PLAYBACK_READ',token,offset);},closePlayback:token=>ipcRenderer.invoke('Syncord_RECORDING_PLAYBACK_CLOSE',token),reveal:async()=>{}});contextBridge.exposeInMainWorld('probeWorker',async()=>{try{await ipcRenderer.invoke('Syncord_RECORDING_WORKER_INIT');return false;}catch{return true;}});`);
  writeFileSync(path.join(temp,"app.cjs"),`(${driver.toString()})(${JSON.stringify(temp)});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const run=spawnSync(electron,[path.join(temp,"app.cjs")],{env,encoding:"utf8",timeout:40_000});
  assert.equal(run.status,0,`${run.error??""}\n${run.stdout}\n${run.stderr}`);
  const line=run.stdout.split("\n").find(line=>line.startsWith("RECORDER_RESULT:"));assert.ok(line,run.stdout);
  const v=JSON.parse(line.slice("RECORDER_RESULT:".length));
  assert.deepEqual(v.devices,[{id:"label:Test microphone",label:"Test microphone"},{id:"label:Test loopback",label:"Test loopback"}]);
  assert.equal(v.workerLocales,18);assert.equal(v.localeOwnerBound,true);assert.equal(v.invalidLocalesRejected,true);assert.equal(v.staleLocaleIgnored,true);
  assert.equal(v.noDiscordBridge,true);assert.equal(v.sourceVisible,"Synthetic screen");assert.equal(v.remoteBlocked,true);assert.equal(v.workerForgeryDenied,true);assert.equal(v.captureHidden,true);
  assert.ok(v.item.bytes>1000);assert.equal(v.item.microphone,true);assert.equal(v.item.output,true);assert.equal(v.item.recovered,false);assert.equal(v.header,"1a45dfa3");assert.equal(v.noPartFiles,true);assert.equal(v.traversalDenied,true);assert.equal(v.defaultSharingUnchanged,true);
  assert.ok(v.playback.duration>9&&v.playback.duration<15);assert.equal(v.playback.width,640);assert.equal(v.playback.height,360);assert.equal(v.noExtraPlayerWindow,true);assert.equal(v.inline,true);assert.equal(v.inlineCleaned,true);assert.equal(v.originalBytes,true);assert.ok(v.descriptor.points>=2);for(const key of ["chooserSurvivesChatChange","recordingSurvivesNavigation","navigationListenerCleaned","documentNavigationStopsRecording","overlayAboveLibrary","responsive","latestPreviewWins","videoAdvances","pathPlaybackDenied","concurrentReadDenied","wrongTokenDenied","wrongOwnerDenied","offsetDenied","closedTokenDenied","backwardSeekWorks","forwardSeekWorks"])assert.equal(v[key],true,key);assert.ok(v.readOffsets.some(offset=>offset>v.descriptor.header));assert.equal(v.seekWorks,true);assert.equal(v.releaseClosesPlayer,true);assert.equal(v.disabledAudioDoesNotRequestMic,true,"Disabled audio must not open a microphone");assert.equal(v.repeatedCaptureSaved,true,JSON.stringify(v.silentFinal));assert.equal(v.nativeLoopback,true);assert.equal(v.nativeOutputSaved,true);
 }finally{rmSync(temp,{recursive:true,force:true});}
});
