import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, after } from 'node:test';
import { build } from 'esbuild';
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'syncord-attachments-'));
await build({stdin:{contents:`export {attachmentUrl,readAttachmentBlob} from './src/renderer/plugins/messageLogger/files';export {isImageFile} from './src/renderer/plugins/messageLogger/imagePreview';`,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',outfile:scratch+'/attachments.mjs',logLevel:'silent'});
const api=await import(pathToFileURL(scratch+'/attachments.mjs'));
after(()=>fs.rmSync(scratch,{recursive:true,force:true}));
const url='https://cdn.discordapp.com/attachments/1/2/image.png?ex=abc&hm=signature';
test('logged attachments: only HTTPS Discord CDN links, preserving signed query',()=>{
 assert.equal(api.attachmentUrl(url),url);
 for(const unsafe of ['javascript:alert(1)','data:text/html,hi','file:///tmp/image.png','http://cdn.discordapp.com/a','https://cdn.discordapp.com.evil.test/a','https://evil.test/a','https://user:pass@cdn.discordapp.com/a','https://cdn.discordapp.com:444/a'])assert.equal(api.attachmentUrl(unsafe),undefined,unsafe);
});
test('logged attachments: saved MIME and image filenames classify without treating documents as images',()=>{
 assert.equal(api.isImageFile('file','image/webp'),true);assert.equal(api.isImageFile('photo.GIF'),true);assert.equal(api.isImageFile('notes.txt','text/plain'),false);assert.equal(api.isImageFile('image.png.exe'),false);
});
test('logged attachments: manual remote download uses no credentials or redirects and assembles stream',async()=>{
 const original=globalThis.fetch;let options;
 globalThis.fetch=async(target,opts)=>{assert.equal(target,url);options=opts;return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1,2]));c.enqueue(new Uint8Array([3]));c.close();}}),{headers:{'content-type':'image/png'}});};
 try{const blob=await api.readAttachmentBlob(url,new AbortController().signal);assert.equal(blob.type,'image/png');assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())],[1,2,3]);assert.equal(options.credentials,'omit');assert.equal(options.referrerPolicy,'no-referrer');assert.equal(options.redirect,'error');}finally{globalThis.fetch=original;}
});
test('logged attachments: forged links never reach fetch',async()=>{
 const original=globalThis.fetch;globalThis.fetch=()=>{assert.fail('unexpected request');};try{await assert.rejects(api.readAttachmentBlob('https://evil.test/image.png',new AbortController().signal));}finally{globalThis.fetch=original;}
});
test('logged attachments: expired responses produce a recoverable failure',async()=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>new Response('',{status:404});try{await assert.rejects(api.readAttachmentBlob(url,new AbortController().signal),/unavailable/);}finally{globalThis.fetch=original;}
});
test('logged attachments: stream without Content-Length is bounded and canceled on overflow',async()=>{
 const original=globalThis.fetch;let canceled=false;
 globalThis.fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(32*1024*1024+1));},cancel(){canceled=true;}}));
 try{await assert.rejects(api.readAttachmentBlob(url,new AbortController().signal),/too large/);assert.equal(canceled,true);}finally{globalThis.fetch=original;}
});
test('logged attachments: closing preview aborts the pending network request',async()=>{
 const original=globalThis.fetch;const controller=new AbortController();
 globalThis.fetch=(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
 try{const pending=api.readAttachmentBlob(url,controller.signal);controller.abort();await assert.rejects(pending,{name:'AbortError'});}finally{globalThis.fetch=original;}
});
