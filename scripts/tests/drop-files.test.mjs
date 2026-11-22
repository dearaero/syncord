import {monitorEventLoopDelay} from 'node:perf_hooks';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';import {build} from 'esbuild';import {pathToFileURL} from 'node:url';
const root=await fs.mkdtemp(path.join(tmpdir(),'syncord-drop-files-'));await build({stdin:{resolveDir:process.cwd(),contents:"export * from './src/main/drop/files';export * from './src/shared/drop';"},bundle:true,platform:'node',format:'esm',outfile:root+'/test.mjs',logLevel:'silent'});const T=await import(pathToFileURL(root+'/test.mjs').href);process.on('exit',()=>{});
const hash=b=>createHash('sha256').update(b).digest('hex');
test('Drop disk capabilities: safe sequential streaming, exact size/hash, no overwrite or symlink, cancellation and mutable sources',async t=>{
 const sourceFile=root+'/özel 名前.bin',data=Buffer.alloc(T.DROP_BLOCK+51,7);await fs.writeFile(sourceFile,data);const source=await T.DropSource.open(sourceFile);assert.equal(source.file.name,'özel 名前.bin');const sink=await T.DropSink.open(root+'/received.bin',source.file);
 const pieces=[];for(let n=0;n<data.length;){const block=await source.read();assert.ok(block.byteLength<=T.DROP_BLOCK);pieces.push(block);n+=block.byteLength;await sink.write(block);}await sink.finish(await source.digest());assert.deepEqual(await fs.readFile(sink.savedPath()),data);await source.close();await sink.close();
 await assert.rejects(T.DropSink.open(root+'/received.bin',source.file),/drop.exists/);
 const bad=await T.DropSink.open(root+'/bad.bin',{name:'bad.bin',size:2});await bad.write(new Uint8Array([1,2]));await assert.rejects(bad.finish(hash(Buffer.from([3,4]))),/drop.integrity/);await bad.close();await assert.rejects(fs.stat(root+'/bad.bin'),{code:'ENOENT'});
 const incomplete=await T.DropSink.open(root+'/short.bin',{name:'short.bin',size:2});await incomplete.write(new Uint8Array([1]));await assert.rejects(incomplete.finish(hash(Buffer.from([1]))),/drop.integrity/);await incomplete.close();
 const empty=await T.DropSink.open(root+'/empty.bin',{name:'empty.bin',size:0});await empty.finish(hash(Buffer.alloc(0)));assert.equal((await fs.stat(empty.savedPath())).size,0);await empty.close();
 const cancelled=await T.DropSink.open(root+'/cancel.bin',{name:'cancel.bin',size:10});await assert.rejects(cancelled.write(new Uint8Array(T.DROP_BLOCK+1)),/drop.state/);await cancelled.close();assert.equal((await fs.readdir(root)).some(n=>n.endsWith('.part')),false);
 await fs.symlink(sourceFile,root+'/link.bin');await assert.rejects(T.DropSource.open(root+'/link.bin'),/drop.file_error/);await assert.rejects(T.DropSink.open(root+'/link.bin',source.file),/drop.exists/);assert.deepEqual(await fs.readFile(sourceFile),data);
 const modified=await T.DropSource.open(sourceFile);while((await modified.read()).length===T.DROP_BLOCK){}await fs.appendFile(sourceFile,'x');await assert.rejects(modified.digest(),/drop.file_error/);await modified.close();
 const full=await T.DropSink.open(root+'/full.bin',{name:'full.bin',size:2});full.handle.write=async()=>{throw Object.assign(Error('disk full'),{code:'ENOSPC'});};await assert.rejects(full.write(new Uint8Array([1,2])),/drop.disk_full/);await full.close();
 for(const name of ['../x','a/b','a\\b','\0x','..'])assert.throws(()=>T.dropFile({name,size:2}),/drop.invalid/);assert.ok(!T.saveName('CON.txt').startsWith('CON.'));assert.ok(!T.saveName('x:y?.zip').includes(':'));
 const id='12345678-1234-4123-8123-123456789abc';assert.equal(T.parseDropLink(T.dropLink(id)),id);for(const url of ['https://api.syncord.pro/other/'+id,'https://api.syncord.pro.evil/drop/'+id,'https://user@api.syncord.pro/drop/'+id,T.dropLink(id)+'?x=1'])assert.equal(T.parseDropLink(url),undefined);
});
test('Drop streams a real 2 GiB+ file with bounded buffers and a matching incremental SHA-256',{timeout:180000},async t=>{
 const bytes=2*1024**3+37,stat=await fs.statfs(root);if(stat.bavail*stat.bsize<bytes+1024**3){t.skip('At least 3 GiB of temporary free disk is required');return;}
 const from=root+'/large-source.bin',to=root+'/large-received.bin';const fd=await fs.open(from,'wx');await fd.truncate(bytes);await fd.close();
 const source=await T.DropSource.open(from),sink=await T.DropSink.open(to,source.file);const latency=monitorEventLoopDelay({resolution:10});latency.enable();const baseline=process.memoryUsage().rss;let peak=baseline,total=0,largest=0;
 try{while(total<bytes){const block=await source.read();largest=Math.max(largest,block.byteLength);total+=block.byteLength;await sink.write(block);if(total%(16*1024**2)===0)peak=Math.max(peak,process.memoryUsage().rss);}
  await sink.finish(await source.digest());assert.equal((await fs.stat(sink.savedPath())).size,bytes);assert.equal(total,bytes);assert.ok(largest<=T.DROP_BLOCK);assert.ok(peak-baseline<192*1024**2,'RAM must not grow with the file size');t.diagnostic(JSON.stringify({bytes,largestBlock:largest,peakRssIncrease:peak-baseline,eventLoopP99Ms:latency.percentile(99)/1e6,eventLoopMaxMs:latency.max/1e6}));
 }finally{latency.disable();await source.close();await sink.close();await fs.unlink(from).catch(()=>{});await fs.unlink(to).catch(()=>{});}
});
test.after(async()=>{await fs.rm(root,{recursive:true,force:true});});
