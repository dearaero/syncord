import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';import path from 'node:path';import {tmpdir} from 'node:os';import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(path.join(tmpdir(),'syncord-statistics-network-'));
await build({stdin:{resolveDir:process.cwd(),contents:`export * from './src/main/statistics/network';export {app,FakeContents} from 'electron';`},outfile:path.join(dir,'network.mjs'),platform:'node',format:'esm',bundle:true,logLevel:'silent',plugins:[{name:'electron',setup(b){b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`import {EventEmitter} from 'node:events';export const app=new EventEmitter();app.whenReady=()=>Promise.resolve();export const webContents={getAllWebContents:()=>[]};export class FakeContents extends EventEmitter {constructor(id,url){super();this.id=id;this.url=url;this.dead=false;this.devtools=false;this.commands=[];this.attaches=0;this.detaches=0;const dbg=this.debugger=new EventEmitter();dbg.attached=false;dbg.isAttached=()=>dbg.attached;dbg.attach=()=>{this.attaches++;dbg.attached=true;};dbg.detach=()=>{this.detaches++;dbg.attached=false;dbg.emit('detach',{},'target_closed');};dbg.sendCommand=async(method,args)=>{this.commands.push({method,args});if(this.fail)throw Error('Unavailable');};}getURL(){return this.url;}isDestroyed(){return this.dead;}isDevToolsOpened(){return this.devtools;}}` }));}}]});
const M=await import(pathToFileURL(path.join(dir,'network.mjs')));M.installStatisticsNetwork();const settled=async()=>{await Promise.resolve();await Promise.resolve();};test.after(()=>{M.app.emit('will-quit');rmSync(dir,{recursive:true,force:true});});
const spawn=(id,url='https://discord.com/channels/@me')=>{const wc=new M.FakeContents(id,url);M.app.emit('web-contents-created',{},wc);return wc;};
test('statistics network: trusted targets install once, enable metadata only and expose aggregate numbers',async()=>{
 const w=spawn(1);await settled();M.app.emit('web-contents-created',{},w);assert.equal(w.attaches,1);assert.deepEqual(w.commands.map(c=>c.method),['Network.enable']);assert.equal(w.commands[0].args.maxPostDataSize,1);
 w.debugger.emit('message',{},'Network.requestWillBeSent',{requestId:'1',request:{url:'https://sensitive.test/private'}});w.debugger.emit('message',{},'Network.loadingFinished',{requestId:'1',encodedDataLength:24});const s=M.networkStatistics();assert.equal(s.activeTargets,1);assert.equal(s.httpReceived,24);assert.ok(Object.values(s).every(v=>typeof v==='number'));assert.ok(!JSON.stringify(s).includes('sensitive'));w.dead=true;w.emit('destroyed');assert.equal(w.debugger.listenerCount('message'),0);assert.equal(M.networkStatistics().httpReceived,24);
});
test('statistics network: inspector metadata is compacted at HTTP idle without resetting traffic or WebSockets',async()=>{
 const w=spawn(60);await settled();const dbg=w.debugger,before=M.networkStatistics();
 dbg.emit('message',{},'Network.webSocketCreated',{requestId:'gateway'});
 for(let i=0;i<512;i++)dbg.emit('message',{},'Network.requestWillBeSent',{requestId:String(i)});
 assert.equal(w.commands.length,1,'do not interrupt in-flight HTTP');
 for(let i=0;i<512;i++)dbg.emit('message',{},'Network.loadingFinished',{requestId:String(i),encodedDataLength:2});
 await settled();await settled();
 assert.deepEqual(w.commands.map(c=>c.method),['Network.enable','Network.disable','Network.enable']);assert.equal(w.detaches,0);
 dbg.emit('message',{},'Network.webSocketFrameReceived',{requestId:'gateway',response:{opcode:1,payloadData:'hello'}});
 const after=M.networkStatistics();assert.equal(after.httpReceived-before.httpReceived,1024);assert.equal(after.wsReceived-before.wsReceived,5);assert.equal(after.activeSockets,1);assert.equal(after.activeTargets,1);assert.equal(after.gaps-before.gaps,1);w.emit('destroyed');
});
test('statistics network: navigation during compaction never re-enables an untrusted target',async()=>{
 const w=spawn(61);await settled();let release;
 const original=w.debugger.sendCommand;w.debugger.sendCommand=(method,args)=>method==='Network.disable'?new Promise(resolve=>{w.commands.push({method,args});release=resolve;}):original(method,args);
 for(let i=0;i<512;i++){w.debugger.emit('message',{},'Network.requestWillBeSent',{requestId:String(i)});w.debugger.emit('message',{},'Network.loadingFinished',{requestId:String(i),encodedDataLength:1});}
 await settled();w.url='https://evil.test';w.emit('did-start-navigation',{},w.url,false,true);release();await settled();await settled();assert.equal(w.commands.filter(c=>c.method==='Network.enable').length,1);assert.equal(w.debugger.attached,false);w.emit('destroyed');
});
test('statistics network: DevTools detach during compaction resets its state for a later owned session',async()=>{
 const w=spawn(62);await settled();let release;const original=w.debugger.sendCommand;
 w.debugger.sendCommand=(method,args)=>method==='Network.disable'?new Promise(resolve=>{w.commands.push({method,args});release=resolve;}):original(method,args);
 const batch=()=>{for(let i=0;i<512;i++){w.debugger.emit('message',{},'Network.requestWillBeSent',{requestId:String(i)});w.debugger.emit('message',{},'Network.loadingFinished',{requestId:String(i),encodedDataLength:1});}};
 batch();await settled();w.debugger.detach();w.debugger.sendCommand=original;release();await settled();w.emit('devtools-closed');await settled();batch();await settled();await settled();
 assert.equal(w.commands.filter(c=>c.method==='Network.disable').length,2);assert.equal(M.networkStatistics().activeTargets,1);w.emit('destroyed');
});
test('statistics network: untrusted origins and third-party ports are never attached',async()=>{
 for(const [i,url] of ['file:///tmp/test.html','https://discord.com.evil.test','https://discord.com:8443','https://cdn.discordapp.com/test'].entries()){const w=spawn(10+i,url);await settled();assert.equal(w.attaches,0);w.emit('destroyed');}
});
test('statistics network: another debugger is preserved and DevTools can suspend and resume measurement',async()=>{
 const w=new M.FakeContents(20,'https://discord.com/app');w.debugger.attached=true;M.app.emit('web-contents-created',{},w);assert.equal(w.attaches,0);assert.equal(w.detaches,0);assert.equal(M.networkStatistics().unavailableTargets,1);
 w.debugger.attached=false;w.emit('devtools-closed');await settled();assert.equal(w.attaches,1);w.debugger.detach();assert.equal(M.networkStatistics().activeTargets,0);w.emit('devtools-closed');await settled();assert.equal(w.attaches,2);w.emit('destroyed');
});
test('statistics network: top-level origin changes stop observation, trusted navigations resume and command failures are isolated',async()=>{
 const w=spawn(30);await settled();w.emit('did-start-navigation',{},'https://evil.test',false,true);assert.equal(w.debugger.attached,false);w.url='https://evil.test';w.emit('dom-ready');assert.equal(w.attaches,1);w.emit('did-start-navigation',{},'https://discord.com/app',false,true);await settled();assert.equal(w.attaches,2);w.emit('destroyed');
 const broken=new M.FakeContents(31,'https://discord.com/app');broken.fail=true;M.app.emit('web-contents-created',{},broken);await settled();assert.equal(broken.debugger.attached,false);broken.emit('destroyed');
});
test('statistics network: submitted raw/file payload sizes and unknown blobs survive window destruction without reading contents',async()=>{
 const file=path.join(dir,'upload.bin');writeFileSync(file,'123456');const w=spawn(40);await settled();const before=M.networkStatistics();M.measureSubmittedUpload(40,[{bytes:Buffer.from('abcd')},{file},{blobUUID:'opaque'}]);w.emit('destroyed');await new Promise(r=>setTimeout(r,30));const after=M.networkStatistics();assert.equal(after.httpSubmitted-before.httpSubmitted,10);assert.equal(after.unknownUploads-before.unknownUploads,1);
});


test('statistics network: destroyed WebContents rejects debugger access; cleanup still archives counters and removes listeners',async()=>{
 const w=spawn(50),dbg=w.debugger;await settled();
 dbg.emit('message',{},'Network.requestWillBeSent',{requestId:'close'});dbg.emit('message',{},'Network.loadingFinished',{requestId:'close',encodedDataLength:91});
 const before=M.networkStatistics().httpReceived;
 Object.defineProperty(w,'debugger',{get(){if(w.dead)throw new TypeError('Object has been destroyed');return dbg;}});
 w.dead=true;assert.doesNotThrow(()=>w.emit('destroyed'));
 assert.equal(dbg.listenerCount('message'),0);assert.equal(dbg.listenerCount('detach'),0);
 assert.equal(w.listenerCount('dom-ready'),0);assert.equal(w.listenerCount('devtools-closed'),0);
 assert.equal(M.networkStatistics().httpReceived,before);assert.equal(M.networkStatistics().activeTargets,0);
});

test('statistics network: shutdown detach can synchronously destroy the window without double retirement',async()=>{
 const w=spawn(51),dbg=w.debugger;await settled();
 dbg.emit('message',{},'Network.requestWillBeSent',{requestId:'shutdown'});dbg.emit('message',{},'Network.loadingFinished',{requestId:'shutdown',encodedDataLength:71});
 const before=M.networkStatistics().httpReceived;
 dbg.detach=()=>{w.detaches++;dbg.attached=false;dbg.emit('detach',{},'target_closed');w.dead=true;w.emit('destroyed');};
 assert.doesNotThrow(()=>M.app.emit('will-quit'));assert.equal(M.networkStatistics().httpReceived,before);assert.equal(M.networkStatistics().activeTargets,0);assert.equal(w.detaches,1);
});
