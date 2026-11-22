import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(path.join(tmpdir(),'syncord-image-zoom-'));
await build({stdin:{resolveDir:process.cwd(),contents:"export * from './src/renderer/plugins/imageZoom/model';export * from './src/renderer/plugins/imageZoom/settings';export * from './src/renderer/plugins/imageZoom/gif';"},bundle:true,platform:'node',format:'esm',outfile:path.join(dir,'model.mjs'),logLevel:'silent'});
const T=await import(pathToFileURL(path.join(dir,'model.mjs')));
test.after(()=>rmSync(dir,{recursive:true,force:true}));
const base='https://discord.com/channels/@me/1';
test('ImageZoom: original resolution retains all signed attachment parameters and only removes image transforms',()=>{
 const url=T.originalUrl('https://media.discordapp.net/attachments/1/2/x.gif?width=128&height=128&quality=lossless&format=webp&ex=123&is=456&hm=ABC',undefined,base),parsed=new URL(url);
 assert.equal(parsed.hostname,'cdn.discordapp.com');assert.equal(parsed.pathname,'/attachments/1/2/x.gif');assert.equal(parsed.search,'?ex=123&is=456&hm=ABC');
 const original='https://cdn.discordapp.com/attachments/1/2/full.png?ex=789&hm=XYZ';assert.equal(T.originalUrl('https://media.discordapp.net/attachments/1/2/full.png?width=10',original,base),original);
 assert.equal(new URL(T.originalUrl('https://cdn.discordapp.com/avatars/1/hash.webp?size=64',undefined,base)).searchParams.get('size'),'4096');
 assert.equal(new URL(T.originalUrl('https://images-ext-1.discordapp.net/external/hash/https/example.com/photo.jpg?width=32',undefined,base)).hostname,'images-ext-1.discordapp.net');
});
test('ImageZoom: source URL validation never follows arbitrary links, credentials, executable schemes or host suffix spoofs',()=>{
 for(const url of ['https://cdn.discordapp.com.evil.test/attachments/1/x.png','https://user:pass@cdn.discordapp.com/x.png','https://cdn.discordapp.com:123/x.png','javascript:alert(1)','file:///etc/passwd','http://127.0.0.1/x.gif','data:image/svg+xml,<svg></svg>','blob:https://other.example/id'])assert.equal(T.mediaUrl(url,base),undefined,url);
 const safe='https://cdn.discordapp.com/attachments/1/x.png';assert.equal(T.originalUrl(safe,'https://evil.example/track.png',base),safe);
 assert.equal(T.mediaUrl('blob:https://discord.com/id',base),'blob:https://discord.com/id');
});
test('ImageZoom: settings normalize corrupt values, keep feature switches and cap memory and dimensions',()=>{
 const cfg=T.normalizeOptions({hoverDelay:Infinity,closeDelay:-1,hover:'false',gifMaxMB:5000,gifMaxMP:0,gifSpeed:999,zoomModifier:'bogus',pauseKey:'',smooth:false});
 assert.equal(cfg.hoverDelay,0);assert.equal(cfg.closeDelay,0);assert.equal(cfg.hover,true);assert.equal(cfg.gifMaxMB,64);assert.equal(cfg.gifMaxMP,1);assert.equal(cfg.gifSpeed,4);assert.equal(cfg.zoomModifier,'alt');assert.equal(cfg.pauseKey,'');assert.equal(cfg.smooth,false);
 for(const key of T.imageZoomSettings.keys)assert.ok(Object.hasOwn(cfg,key),key);
});
test('ImageZoom: native image transforms preserve the original box and clamp pan at both edges',()=>{
 assert.deepEqual(T.inlineTransform(480,320,1,.5,.5),{x:0,y:0});
 assert.equal(Math.abs(T.inlineTransform(480,320,5,-2,-1).x),0);
 assert.deepEqual(T.inlineTransform(480,320,5,4,2),{x:-1920,y:-1280});
 assert.deepEqual(T.inlineTransform(80,80,1/80,.5,.5),{x:39.5,y:39.5});
});
test('ImageZoom: custom shortcut lists, space, modifier exclusivity and high-resolution trackpad deltas',()=>{
 assert.ok(T.keyMatches('ArrowLeft,ArrowUp','ArrowUp','ArrowUp'));assert.ok(T.keyMatches('P','p','KeyP'));assert.ok(T.keyMatches('Space',' ','Space'));assert.equal(T.keyMatches('','p','KeyP'),false);
 const event={altKey:true,shiftKey:false,ctrlKey:false,metaKey:false};assert.equal(T.modifierMatches('alt',event),true);assert.equal(T.modifierMatches('shift',event),false);assert.equal(T.modifierMatches('alt',{...event,ctrlKey:true}),false);
 assert.equal(T.wheelSteps(1,0),.01);assert.equal(T.wheelSteps(-10000,0),-4);
});
function header(width=1,height=1){const bytes=new Uint8Array(13);bytes.set([...Buffer.from('GIF89a')]);new DataView(bytes.buffer).setUint16(6,width,true);new DataView(bytes.buffer).setUint16(8,height,true);return bytes.buffer;}
test('ImageZoom: malformed GIFs and decompression bombs are rejected before allocating a decoder',async()=>{
 assert.throws(()=>T.gifDimensions(new ArrayBuffer(3)),/original GIF/);assert.deepEqual(T.gifDimensions(header(32,48)),{width:32,height:48});
 let constructed=0;globalThis.ImageDecoder=class {static async isTypeSupported(){return true;}constructor(){constructed++;}};
 await assert.rejects(T.GifPlayback.create(header(65535,65535),{}, {autoplay:false,loop:true,speed:1,maxPixels:16_000_000},new AbortController().signal,()=>{},()=>{}),/budget/);assert.equal(constructed,0);delete globalThis.ImageDecoder;
});
test('ImageZoom: streamed GIF downloads omit credentials and cancel bodies at both declared and actual byte limits',async()=>{
 const original=globalThis.fetch;let canceled=0,options;
 try{
  globalThis.fetch=async(_url,opt)=>{options=opt;return new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(8));},cancel(){canceled++;}}));};
  await assert.rejects(T.readGif('https://cdn.discordapp.com/x.gif',10,new AbortController().signal),/budget/);assert.equal(canceled,1);assert.equal(options.credentials,'omit');assert.equal(options.referrerPolicy,'no-referrer');
  globalThis.fetch=async()=>new Response(new ReadableStream({cancel(){canceled++;}}),{headers:{'content-length':'100'}});
  await assert.rejects(T.readGif('https://cdn.discordapp.com/x.gif',10,new AbortController().signal),/budget/);assert.equal(canceled,2);
 }finally{globalThis.fetch=original;}
});
test('ImageZoom: rapid seeks coalesce, every stale/closed frame is released, and no playback survives disposal',async()=>{
 const old=globalThis.ImageDecoder;let framesClosed=0,decodersClosed=0,active=0,peak=0,decodes=0,pendingResolve;
 const pixels=[],canvas={width:0,height:0,getContext(){return {canvas:this,clearRect(){},drawImage(frame){pixels.push(frame.index);}};}};
 const frame=index=>({index,displayWidth:1,displayHeight:1,duration:50000,close(){framesClosed++;}});
 globalThis.ImageDecoder=class {static async isTypeSupported(){return true;}tracks={ready:Promise.resolve(),selectedTrack:{frameCount:5}};async decode({frameIndex}){decodes++;active++;peak=Math.max(active,peak);try{if(decodes>1)await new Promise(resolve=>pendingResolve=resolve);return {image:frame(frameIndex)};}finally{active--;}}close(){decodersClosed++;}};
 try{
  const updates=[],controller=new AbortController(),player=await T.GifPlayback.create(header(),canvas,{autoplay:false,loop:true,speed:1,maxPixels:1},controller.signal,s=>updates.push(s),e=>assert.fail(String(e)));
  player.step(1);player.step(1);player.step(1);assert.equal(peak,1);pendingResolve();await new Promise(setImmediate);pendingResolve();await new Promise(setImmediate);
  assert.deepEqual(pixels,[0,3]);assert.equal(player.snapshot().frame,3);assert.equal(peak,1);assert.equal(framesClosed,3);
  player.step(1);controller.abort();pendingResolve();await new Promise(setImmediate);assert.equal(decodersClosed,1);assert.equal(framesClosed,4);assert.equal(canvas.width,0);const count=decodes;await new Promise(r=>setTimeout(r,70));assert.equal(decodes,count);
 }finally{globalThis.ImageDecoder=old;}
});
test('ImageZoom: registration is unique and the full settings panel is wired into expansion and cleanup',()=>{
 const index=readFileSync('src/renderer/plugins/index.ts','utf8'),panel=readFileSync('src/renderer/ui/settingsPanel.ts','utf8');assert.equal(index.match(/import "\.\/imageZoom"/g)?.length,1);
 for(const hook of ['imageZoomSectionHtml()','imageZoomExpandButtonHtml()','isImageZoomExpanded()','bindImageZoomPanel(root)','disposeImageZoomPanel=undefined'])assert.ok(panel.includes(hook),hook);
});
