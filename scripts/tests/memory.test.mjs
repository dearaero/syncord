import test from 'node:test';import assert from 'node:assert/strict';
import {build} from 'esbuild';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(path.join(tmpdir(),'syncord-memory-model-'));
await build({stdin:{resolveDir:process.cwd(),contents:`export {RowHeights} from './src/renderer/ui/windowedList';export * from './src/renderer/plugins/messageLogger/files';`},outfile:path.join(dir,'model.mjs'),bundle:true,format:'esm',platform:'node',logLevel:'silent',plugins:[{name:'file-db',setup(b){b.onResolve({filter:/^\.\/db$/},a=>a.importer.endsWith('/messageLogger/files.ts')?{path:'db',namespace:'fixture'}:undefined);b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const clearStoredFiles=async()=>globalThis.fileRows.clear();export const deleteStoredKeys=async keys=>{for(const key of keys)globalThis.fileRows.delete(key);};export const hasStoredFile=async key=>globalThis.fileRows.has(key);export const readStoredFile=async key=>globalThis.fileRows.get(key);export const writeStoredFile=async(key,value)=>globalThis.fileRows.set(key,value);`}));}}]});
const M=await import(pathToFileURL(path.join(dir,'model.mjs')));test.after(()=>rmSync(dir,{recursive:true,force:true}));
test('row offsets preserve variable heights, exact boundaries and randomized prefix sums',()=>{
 const h=new M.RowHeights(200),values=Array(200).fill(96);for(let i=0;i<200;i++){const n=20+(i*71)%700;h.set(i,n);values[i]=n;}
 for(let end=0;end<=200;end++)assert.equal(h.prefix(end),values.slice(0,end).reduce((a,b)=>a+b,0));
 let position=0;for(let i=0;i<200;i++){assert.equal(h.at(position),i);assert.equal(h.at(position+values[i]-.5),i);position+=values[i];}
 assert.equal(h.at(-1),0);assert.equal(h.at(Infinity),199);assert.equal(h.set(0,NaN),false);h.reset();assert.equal(h.total,200*96);
});
test('row offsets for large histories allocate numeric indexes without one DOM item per record',()=>{
 const h=new M.RowHeights(100000);assert.equal(h.total,9600000);assert.equal(h.at(4800000),50000);h.set(0,1000);assert.equal(h.at(4800904),50000);
});
const settle=async()=>{for(let i=0;i<100;i++){if(Object.values(M.attachmentMemoryStats()).every(n=>n===0))return;await new Promise(r=>setTimeout(r,5));}assert.fail(JSON.stringify(M.attachmentMemoryStats()));};
const link='https://cdn.discordapp.com/attachments/1/2/file.bin';
test('attachment queue releases all completed IDs and skips saved Blobs with a key-only lookup',async()=>{
 globalThis.fileRows=new Map();const original=globalThis.fetch;let fetched=0;
 globalThis.fetch=async()=>{fetched++;return new Response(new Uint8Array([1,2,3]));};
 try{for(let i=0;i<1000;i++)M.queueMessageFiles({id:String(i),attachments:[{url:link}]});await settle();assert.equal(fetched,1000);assert.equal(fileRows.size,1000);
 M.queueMessageFiles({id:'0',attachments:[{url:link}]});await settle();assert.equal(fetched,1000);for(let i=0;i<1000;i++)M.forgetMessageFiles(String(i));await settle();assert.equal(fileRows.size,0);
 }finally{globalThis.fetch=original;M.invalidateDownloads();}
});
test('automatic downloads cancel unknown-length responses at the existing 8 MB limit',async()=>{
 globalThis.fileRows=new Map();const original=globalThis.fetch;let canceled=false,pulls=0;
 globalThis.fetch=async()=>new Response(new ReadableStream({pull(c){pulls++;c.enqueue(new Uint8Array(1024*1024));},cancel(){canceled=true;}}));
 try{M.queueMessageFiles({id:'overflow',attachments:[{url:link}]});await settle();assert.equal(canceled,true);assert.ok(pulls<=11);assert.equal(fileRows.size,0);}finally{globalThis.fetch=original;M.invalidateDownloads();}
});
test('invalidating pending downloads aborts the active request and releases queued closures',async()=>{
 globalThis.fileRows=new Map();const original=globalThis.fetch;let entered=false,aborted=false,calls=0;
 globalThis.fetch=async(_url,{signal})=>{calls++;entered=true;return new Promise((_r,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new DOMException('Aborted','AbortError'));},{once:true}));};
 try{for(let i=0;i<100;i++)M.queueMessageFiles({id:String(i),attachments:[{url:link}]});while(!entered)await new Promise(r=>setTimeout(r,1));M.invalidateDownloads();await settle();assert.equal(aborted,true);assert.equal(calls,1);assert.equal(fileRows.size,0);}finally{globalThis.fetch=original;M.invalidateDownloads();}
});

test('failed attachment downloads can retry without growing a session-wide attempted-ID set',async()=>{
 globalThis.fileRows=new Map();const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;if(calls===1)throw new Error('Offline');return new Response(new Uint8Array([5]));};
 try{M.queueMessageFiles({id:'retry',attachments:[{url:link}]});await settle();assert.equal(fileRows.size,0);M.queueMessageFiles({id:'retry',attachments:[{url:link}]});await settle();assert.equal(calls,2);assert.equal(fileRows.size,1);}finally{globalThis.fetch=original;M.invalidateDownloads();}
});
