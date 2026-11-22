import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import fs from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';import {pathToFileURL} from 'node:url';
const dir=await fs.mkdtemp(path.join(tmpdir(),'syncord-statistics-'));
await build({stdin:{resolveDir:process.cwd(),contents:`export * from './src/main/statistics/traffic';export * from './src/main/statistics/resources';export * from './src/main/statistics/storage';`},outfile:path.join(dir,'model.mjs'),platform:'node',format:'esm',bundle:true,logLevel:'silent'});
const M=await import(pathToFileURL(path.join(dir,'model.mjs')));test.after(()=>fs.rm(dir,{recursive:true,force:true}));
const event=(ledger,method,params)=>ledger.event('Network.'+method,{requestId:'1',...params});
test('statistics traffic: encoded HTTP bytes reconcile with final totals without double counting',()=>{
 const l=new M.TrafficLedger();event(l,'requestWillBeSent',{request:{url:'https://sensitive.test/private',headers:{Authorization:'secret'}}});event(l,'dataReceived',{dataLength:1000,encodedDataLength:100});event(l,'dataReceived',{dataLength:2000,encodedDataLength:200});event(l,'loadingFinished',{encodedDataLength:350});assert.equal(l.totals.httpReceived,350);assert.equal(l.activeRequests,0);assert.equal(l.totals.requests,1);assert.ok(!JSON.stringify(l).includes('secret'));assert.ok(!JSON.stringify(l).includes('sensitive'));
});
test('statistics traffic: redirects, failed partial reads and cached responses retain correct byte totals',()=>{
 const l=new M.TrafficLedger();event(l,'requestWillBeSent',{});event(l,'dataReceived',{encodedDataLength:30});event(l,'requestWillBeSent',{redirectResponse:{encodedDataLength:50}});event(l,'dataReceived',{encodedDataLength:20});event(l,'loadingFailed',{});assert.equal(l.totals.httpReceived,70);assert.equal(l.totals.failed,1);assert.equal(l.totals.requests,2);
 event(l,'requestWillBeSent',{});event(l,'dataReceived',{encodedDataLength:100});event(l,'responseReceived',{response:{fromDiskCache:true}});event(l,'loadingFinished',{encodedDataLength:100});assert.equal(l.totals.httpReceived,70);assert.equal(l.totals.cached,1);
});
test('statistics traffic: UTF-8 text and base64 WebSocket frames count payload bytes without decoding',()=>{
 const l=new M.TrafficLedger();event(l,'webSocketCreated',{});event(l,'webSocketFrameReceived',{response:{opcode:1,payloadData:'hi🙂'}});event(l,'webSocketFrameSent',{response:{opcode:2,payloadData:'AQIDBA=='}});assert.equal(l.totals.wsReceived,6);assert.equal(l.totals.wsSent,4);assert.equal(l.activeSockets,1);event(l,'webSocketClosed',{});assert.equal(l.activeSockets,0);
});
test('statistics traffic: malformed values, bounded in-flight work and missing uploads remain visible',()=>{
 const l=new M.TrafficLedger(2);for(let i=0;i<4;i++)event(l,'requestWillBeSent',{requestId:String(i)});assert.equal(l.activeRequests,2);assert.equal(l.totals.droppedRequests,2);event(l,'dataReceived',{requestId:'3',encodedDataLength:-10});event(l,'dataReceived',{requestId:'3',encodedDataLength:Infinity});l.upload(123,1);const s=M.sumTraffic([l],10,1,0,2);assert.equal(s.httpReceived,0);assert.equal(s.httpSubmitted,123);assert.equal(s.unknownUploads,1);assert.equal(s.gaps,2);assert.ok(Object.values(s).every(v=>typeof v==='number'&&Number.isFinite(v)));l.clearPending();assert.equal(l.activeRequests,0);
});
const metric=(pid,cpu,memory=10,creationTime=0)=>({pid,type:'Tab',creationTime,cpu:{cumulativeCPUUsage:cpu,percentCPUUsage:15},memory:{workingSetSize:memory,peakWorkingSetSize:memory*2}});
test('statistics resources: cumulative CPU deltas, logical CPU normalization and KB-to-byte memory are correct',()=>{
 const sampler=new M.ResourceSampler();assert.equal(sampler.sample([metric(1,10),metric(2,20)],1000,8).cpuPercent,null);const s=sampler.sample([metric(1,11),metric(2,21)],3000,8);assert.equal(s.cpuPercent,100);assert.equal(s.cpuCapacityPercent,12.5);assert.equal(s.memoryBytes,20*1024);assert.equal(s.peakObservedBytes,s.memoryBytes);assert.equal(s.processes[0].privateBytes,null);
});
test('statistics resources: PID reuse and resets cannot cause a CPU spike; the displayed peak is an observed aggregate',()=>{
 const sampler=new M.ResourceSampler();sampler.sample([metric(1,100,100)],1000,4);const s=sampler.sample([metric(1,1,50,2000)],3000,4);assert.equal(s.cpuPercent,null);assert.equal(s.peakObservedBytes,100*1024);assert.equal(sampler.sample([],4000,4).available,false);
});
test('statistics resources: fallback samples remain warmed on consecutive reads and process rows are bounded',()=>{
 const sampler=new M.ResourceSampler(),row=metric(1,undefined);sampler.sample([row],1000,4);assert.equal(sampler.sample([row],2000,4).cpuPercent,15);assert.equal(sampler.sample([row],3000,4).cpuPercent,15);const all=sampler.sample(Array.from({length:300},(_,i)=>metric(i,1)),4000,4);assert.equal(all.processes.length,256);assert.equal(all.truncated,true);
});
test('statistics storage: metadata scans count nested files, skip symlinks and mark partial results',async()=>{
 const root=path.join(dir,'tree'),outside=path.join(dir,'outside');await fs.mkdir(path.join(root,'nested'),{recursive:true});await fs.mkdir(outside);await fs.writeFile(path.join(root,'a'),'1234');await fs.writeFile(path.join(root,'nested/b'),'123456');await fs.writeFile(path.join(outside,'private'),'secret');await fs.symlink(outside,path.join(root,'link'),process.platform==='win32'?'junction':'dir');const size=await M.directorySize(root);assert.equal(size.bytes,10);assert.equal(size.files,2);assert.equal(size.complete,false);assert.equal(size.available,true);const empty=await M.directorySize(path.join(dir,'missing'));assert.equal(empty.bytes,0);assert.equal(empty.complete,true);
});
test('statistics storage: entry budgets stop scans; bundle allowlist ignores unrelated files',async()=>{
 const root=path.join(dir,'limited');await fs.mkdir(root);for(let i=0;i<6;i++)await fs.writeFile(path.join(root,'f'+i),'abc');const s=await M.directorySize(root,{entries:2,ms:1000});assert.equal(s.complete,false);assert.ok(s.files<=2);
 const bundles=path.join(dir,'bundles');await fs.mkdir(bundles);for(const f of ['main.js','preload.js','renderer.js','integrity.manifest.json','syncord-version.json'])await fs.writeFile(path.join(bundles,f),'123');await fs.writeFile(path.join(bundles,'secret.key'),'not a bundle');const result=await M.measureStorage(root,path.join(dir,'no-syncord'),path.join(dir,'no-videos'),bundles);assert.equal(result.bundles.bytes,15);assert.equal(result.bundles.files,5);assert.equal(result.syncord.bytes,0);assert.ok(!JSON.stringify(result).includes(dir));
});
