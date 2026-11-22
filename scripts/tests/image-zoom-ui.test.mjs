import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
const root=process.cwd(),electron=['Electron.app/Contents/MacOS/Electron','electron.exe','electron'].map(p=>path.join(root,'node_modules/electron/dist',p)).find(existsSync);
function setup(){
 window.preferences=new Map([['plugins.image-zoom.data.gifAutoplay',false]]);window.disposers=[];window.warnings=[];window.flux=new Map();window.fetches=[];window.abortedFetches=0;window.decodedFrames=0;window.closedFrames=0;window.decoderCount=0;window.decoderClosed=0;
 const nativeFetch=window.fetch.bind(window);window.fetch=(url,options)=>{fetches.push({url:String(url),credentials:options?.credentials});options?.signal?.addEventListener('abort',()=>abortedFetches++,{once:true});return nativeFetch(url,options);};
 const Decoder=window.ImageDecoder;window.RealDecoder=Decoder;
 if(Decoder)window.ImageDecoder=class {
  static isTypeSupported(type){return Decoder.isTypeSupported(type);}
  constructor(options){decoderCount++;const native=new Decoder(options);let closed=false;return {tracks:native.tracks,async decode(options){const result=await native.decode(options);decodedFrames++;const close=result.image.close.bind(result.image);let released=false;result.image.close=()=>{if(!released){released=true;closedFrames++;close();}};return result;},close(){if(!closed){closed=true;decoderClosed++;native.close();}}};}
 };
 window.ctx={css:{inject(css){const style=document.createElement('style');style.textContent=css;document.head.append(style);disposers.push(()=>style.remove());}},log:{warn(...args){warnings.push(args.map(String));}},disposable(fn){disposers.push(fn);}};
}
async function checks(){
 const wait=ms=>new Promise(r=>setTimeout(r,ms)),until=async(fn,label)=>{const start=Date.now();while(!fn()){if(Date.now()-start>4000)throw Error('Timeout: '+label);await wait(10);}},ok=(condition,label)=>{if(!condition)throw Error(label);};
 const hover=el=>{const r=el.getBoundingClientRect();el.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse',clientX:r.left+r.width/2,clientY:r.top+r.height/2}));};
 const key=(key,code,target=document)=>target.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key,code}));
 const wheel=(el,delta,modifier)=>el.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:delta,[modifier+'Key']:true}));
 const preview=()=>document.getElementById('Syncord-image-zoom');
 const setting=(key,value)=>{preferences.set('plugins.image-zoom.data.'+key,value);window.dispatchEvent(new Event('Syncord-image-zoom-settings'));};
 await api.ImageZoomPlugin.start(ctx);
 const results={},image=document.getElementById('static'),gif=document.getElementById('gif'),host=image.closest('.imageWrapper');
 await until(()=>image.complete&&image.naturalWidth>0,'native thumbnail');
 const initial={src:image.getAttribute('src'),srcset:image.getAttribute('srcset'),style:image.style.cssText,hostStyle:host.style.cssText,width:host.offsetWidth,height:host.offsetHeight,next:document.getElementById('after-static').getBoundingClientRect().top};
 const count=document.images.length;
 hover(image);results.immediate=!!preview();
 await until(()=>image.naturalWidth===1200,'original image upgrade');
 results.original=image.src.includes('ex=signed')&&image.src.includes('is=keep')&&image.src.includes('hm=keep')&&!image.src.includes('width=')&&!image.srcset;
 results.inPlace=document.getElementById('static')===image&&preview().parentElement===host&&document.images.length===count&&!preview().hasAttribute('popover')&&!document.querySelector('dialog');
 results.nativeLayout=host.offsetWidth===initial.width&&host.offsetHeight===initial.height&&document.getElementById('after-static').getBoundingClientRect().top===initial.next;
 const before=image.style.transform;for(let i=0;i<7;i++)wheel(document.getElementById('native-overlay'),-100,'alt');results.zoom=image.style.transform!==before;
 const rect=host.getBoundingClientRect();
 host.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:rect.left+1,clientY:rect.top+1}));await wait(140);const left=image.style.transform;
 host.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:rect.right-1,clientY:rect.bottom-1}));await wait(140);results.pan=image.style.transform!==left&&image.getBoundingClientRect().left<host.getBoundingClientRect().left;
 results.clipped=getComputedStyle(host).overflow==='hidden'&&host.offsetWidth===initial.width;
 wheel(image,-100,'shift');results.resize=host.offsetWidth>initial.width&&image.offsetWidth===host.offsetWidth;
 key('p','KeyP');results.pixels=image.dataset.izPixel==='true'&&getComputedStyle(image).imageRendering==='pixelated';
 key('r','KeyR');results.reset=image.style.transform.includes('scale(1)');
 preview().querySelector('[data-iz=actual]').click();results.actualPixels=Math.abs(Number(image.style.transform.match(/scale\(([^)]+)\)/)[1])*image.offsetWidth-image.naturalWidth)<1;
 const composer=document.getElementById('composer');composer.focus();const pixel=image.dataset.izPixel;key('p','KeyP',composer);results.typingSafe=image.dataset.izPixel===pixel;
 key('Escape','Escape');results.escape=!preview()&&document.activeElement===composer;
 results.restored=image.getAttribute('src')===initial.src&&image.getAttribute('srcset')===initial.srcset&&image.style.cssText===initial.style&&host.style.cssText===initial.hostStyle&&host.offsetWidth===initial.width&&!image.hasAttribute('data-iz-media');composer.blur();
 hover(document.getElementById('native-overlay'));await until(()=>image.src.includes('/original.png')&&image.complete&&image.naturalWidth===1200,'native sibling overlay');const consumed=wheel(document.getElementById('native-overlay'),-100,'alt');results.nativeOverlay=!!preview()&&consumed===false;
 let nativeClicks=0;host.addEventListener('click',()=>nativeClicks++);
 document.getElementById('native-overlay').addEventListener('click',event=>event.preventDefault());document.getElementById('native-overlay').click();results.nativeClick=nativeClicks===1&&!preview()&&image.getAttribute('src')===initial.src;
 hover(image);await until(()=>!!preview(),'leave session');image.dispatchEvent(new PointerEvent('pointerout',{bubbles:true,relatedTarget:document.body}));await wait(230);results.leaveRestored=!preview()&&image.getAttribute('src')===initial.src;
 const progressive=document.getElementById('progressive'),progressiveSrc=progressive.getAttribute('src');hover(progressive);
 results.progressiveThumbnail=!!preview()&&progressive.getAttribute('src')===progressiveSrc;
 key('Escape','Escape');await wait(240);results.noLateUpdate=!preview()&&progressive.getAttribute('src')===progressiveSrc;
 // A native rerender while the original is still loading must win over the
 // asynchronous upgrade, including restoration of the coupled srcset attribute.
 hover(progressive);progressive.setAttribute('src','https://media.discordapp.net/attachments/1/2/native-change.png?width=96');await wait(240);
 results.nativeRerender=!preview()&&progressive.src.includes('native-change.png')&&!progressive.hasAttribute('data-iz-media');
 hover(document.getElementById('spoiler'));await wait(30);results.spoilerHidden=!preview();
 hover(document.getElementById('emoji'));await wait(30);results.emojiExcluded=!preview();
 hover(document.getElementById('avatar'));await wait(30);results.avatarDefaultExcluded=!preview();
 hover(gif);await until(()=>preview()?.querySelector('canvas').hidden===false,'real inline GIF decode');
 const canvas=preview().querySelector('canvas'),pixelColor=()=>Array.from(canvas.getContext('2d').getImageData(0,0,1,1).data);
 for(let i=0;i<4;i++)wheel(gif,-100,'alt');
 const gifBounds=gif.closest('.imageWrapper').getBoundingClientRect();
 gif.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:gifBounds.right-1,clientY:gifBounds.bottom-1}));await wait(140);
 results.gifAlignment=Math.abs(canvas.getBoundingClientRect().left-gif.getBoundingClientRect().left)<1&&Math.abs(canvas.getBoundingClientRect().top-gif.getBoundingClientRect().top)<1;
 results.nativeDecoder=!!window.RealDecoder;results.gifInline=canvas.closest('.imageWrapper')===gif.closest('.imageWrapper')&&gif.style.opacity==='0'&&gif.getAttribute('src')?.includes('sample.gif');
 results.gifFirst=pixelColor()[0]===255&&pixelColor()[2]===0&&preview().querySelector('.iz-frame').textContent==='1 / 2';
 key('ArrowRight','ArrowRight');await until(()=>preview()?.querySelector('.iz-frame').textContent==='2 / 2','next GIF frame');results.gifNext=pixelColor()[2]===255&&pixelColor()[0]===0;
 key('ArrowLeft','ArrowLeft');await until(()=>preview()?.querySelector('.iz-frame').textContent==='1 / 2','previous GIF frame');results.gifPrevious=pixelColor()[0]===255;
 key(' ','Space');results.gifResume=preview().querySelector('[data-iz=play]').textContent==='Pause';await until(()=>preview()?.querySelector('.iz-frame').textContent==='2 / 2','GIF autoplay');key(' ','Space');const stopped=preview().querySelector('.iz-frame').textContent;await wait(160);results.gifPause=preview().querySelector('.iz-frame').textContent===stopped&&preview().querySelector('[data-iz=play]').textContent==='Play';
 results.oneFrameReleased=decodedFrames===closedFrames;key('Escape','Escape');results.decoderReleased=decoderCount===decoderClosed&&!gif.style.opacity&&!gif.hasAttribute('data-iz-media');
 const panel=document.createElement('section');panel.innerHTML='<div class="dion-plugin">'+api.imageZoomExpandButtonHtml()+api.imageZoomSectionHtml()+'</div>';document.body.append(panel);const disposePanel=api.bindImageZoomPanel(panel);
 panel.querySelector('[data-iz-expand]').click();results.settingsExpand=panel.firstElementChild.classList.contains('is-open');
 results.noFloatingSettings=!panel.querySelector('[data-iz-option=followCursor],[data-iz-option=width],[data-iz-option=height]');
 const field=panel.querySelector('[data-iz-option=pixelKey]');field.value='Q';field.dispatchEvent(new Event('change',{bubbles:true}));
 hover(image);await until(()=>!!preview(),'custom key image');const was=image.dataset.izPixel;key('p','KeyP');const ignored=image.dataset.izPixel===was;key('q','KeyQ');results.customKeys=ignored&&image.dataset.izPixel!==was;key('Escape','Escape');
 const size=panel.querySelector('[data-iz-option=maxZoom]');size.value='99999';size.dispatchEvent(new Event('change',{bubbles:true}));results.settingsClamped=preferences.get('plugins.image-zoom.data.maxZoom')===64;
 const avatars=panel.querySelector('[data-iz-option=avatars]');avatars.click();hover(document.getElementById('avatar'));await until(()=>document.getElementById('avatar').src.includes('size=4096'),'avatar option');results.avatarOption=!!preview();key('Escape','Escape');
 disposePanel();panel.remove();
 const decoder=window.ImageDecoder;window.ImageDecoder=undefined;hover(gif);await until(()=>preview()?.querySelector('.iz-status').textContent.includes('unavailable'),'unsupported decoder');await wait(40);
 results.fallback=!gif.style.opacity&&preview().querySelector('.iz-gif').hidden&&preview().querySelector('canvas').hidden;key('Escape','Escape');window.ImageDecoder=decoder;
 setting('hoverDelay',60);hover(image);results.delay=!preview();image.dispatchEvent(new PointerEvent('pointerout',{bubbles:true,relatedTarget:document.body}));await wait(90);results.pendingCanceled=!preview();
 setting('hoverDelay',0);hover(image);await until(()=>!!preview(),'resize image');window.dispatchEvent(new Event('resize'));flux.get('CHANNEL_SELECT')?.forEach(fn=>fn());results.routeClose=!preview()&&image.style.cssText===initial.style;
 hover(image);await until(()=>image.naturalWidth===1200,'rerender current image');image.style.width='210px';image.setAttribute('src','https://media.discordapp.net/attachments/1/2/new.png?width=96');await wait(30);
 results.nativeEditsPreserved=!preview()&&image.style.width==='210px'&&image.src.includes('/new.png')&&!image.hasAttribute('srcset');
 hover(image);await until(()=>!!preview(),'detach source');image.replaceWith(image.cloneNode(true));await wait(30);results.detachClose=!preview();
 hover(gif);await until(()=>preview()?.querySelector('canvas').hidden===false,'cleanup GIF');
 const fetchCount=fetches.length;disposers.splice(0).reverse().forEach(fn=>fn());await wait(80);results.cleanup=!preview()&&decoderCount===decoderClosed&&decodedFrames===closedFrames&&!gif.hasAttribute('data-iz-media')&&[...flux.values()].every(set=>!set.size);
 hover(gif);await wait(40);results.stoppedInactive=!preview()&&fetches.length===fetchCount;
 results.credentialsOmitted=fetches.every(row=>row.credentials==='omit');results.warnings=warnings;
 return results;
}
function driver(dir,gifBase64){
 const {app,BrowserWindow,session}=require('electron'),fs=require('node:fs'),path=require('node:path');
 app.disableHardwareAcceleration();app.setPath('userData',path.join(dir,'profile'));app.whenReady().then(async()=>{
  session.defaultSession.protocol.handle('https',async request=>{
   const url=new URL(request.url);let body,type='image/png';if(url.pathname.endsWith('/slow-original.png'))await new Promise(resolve=>setTimeout(resolve,200));
   if(url.pathname==='/fixture.html'){body=fs.readFileSync(path.join(dir,'fixture.html'));type='text/html';}
   else if(url.pathname==='/fixture.js'){body=fs.readFileSync(path.join(dir,'fixture.js'));type='application/javascript';}
   else if(url.pathname.endsWith('.gif')){body=Buffer.from(gifBase64,'base64');type='image/gif';}
   else body=fs.readFileSync(path.join(dir,url.searchParams.has('width')?'thumb.png':'full.png'));
   return new Response(body,{headers:{'content-type':type,'access-control-allow-origin':'*','cache-control':'no-store'}});
  });
  const w=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{backgroundThrottling:false}});
  try{await w.loadURL('https://discord.com/fixture.html');const result=await w.webContents.executeJavaScript('('+checks.toString()+')()');
   if(process.env.SYNCORD_IMAGE_ZOOM_SCREENSHOTS){
    await w.webContents.executeJavaScript(`(async()=>{await api.ImageZoomPlugin.start(ctx);const image=document.getElementById('static'),r=image.getBoundingClientRect();image.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse',clientX:r.left+30,clientY:r.top+30}));await new Promise(r=>setTimeout(r,100));image.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,altKey:true,deltaY:-300}));})()`);
    fs.writeFileSync('/tmp/syncord-image-zoom-desktop.png',(await w.webContents.capturePage()).toPNG());w.setContentSize(360,300);await new Promise(resolve=>setTimeout(resolve,150));
    fs.writeFileSync('/tmp/syncord-image-zoom-narrow.png',(await w.webContents.capturePage()).toPNG());
    await w.webContents.executeJavaScript('disposers.splice(0).reverse().forEach(fn=>fn())');
   }
   console.log('IMAGE_ZOOM_UI '+JSON.stringify(result));w.destroy();app.exit(0);}catch(error){console.error(error.stack);app.exit(1);}
 });
}
test('ImageZoom real Electron: in-place image identity, native layout/clicks, restoration/rerenders, inline zoom/pan/GIF frames, settings and cleanup',{skip:!electron&&'Electron missing',timeout:40000},async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'syncord-image-zoom-ui-'));
 try{
  await build({stdin:{resolveDir:root,contents:`import {ImageZoomPlugin} from './src/renderer/plugins/imageZoom';import * as panel from './src/renderer/plugins/imageZoom/panel';window.api={ImageZoomPlugin,...panel};`},outfile:path.join(dir,'fixture.js'),bundle:true,platform:'browser',format:'iife',logLevel:'silent',plugins:[{name:'fixture',setup(b){
   b.onResolve({filter:/api\/plugin$/},()=>({path:'plugin',namespace:'fixture'}));b.onResolve({filter:/api\/discordEvents$/},()=>({path:'events',namespace:'fixture'}));
   b.onResolve({filter:/^\.\.\/settings$/},a=>a.importer.includes('/api/plugin/')?{path:'settings',namespace:'fixture'}:undefined);
   b.onResolve({filter:/ui\/tooltip$/},()=>({path:'tooltip',namespace:'fixture'}));
   b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path==='plugin'?'export const definePlugin=p=>p;':a.path==='settings'?'export const settings={get:(k,f)=>window.preferences.get(k)??f,set:(k,v)=>window.preferences.set(k,v)};':a.path==='events'?`export function sharedDispatcher(){return {subscribe(type,fn){if(!window.flux.has(type))window.flux.set(type,new Set());window.flux.get(type).add(fn);},unsubscribe(type,fn){window.flux.get(type)?.delete(fn);}};}`:'export function hideTooltip(){}'}));
  }}]});
  const {PNG}=createRequire(import.meta.url)('pngjs');
  for(const [name,width,height] of [['full',1200,800],['thumb',96,64]]){const png=new PNG({width,height});for(let y=0;y<height;y++)for(let x=0;x<width;x++){const offset=(y*width+x)*4;png.data[offset]=Math.floor(x/width*255);png.data[offset+1]=Math.floor(y/height*255);png.data[offset+2]=100;png.data[offset+3]=255;}writeFileSync(path.join(dir,name+'.png'),PNG.sync.write(png));}
  const gif=Buffer.from([71,73,70,56,57,97,1,0,1,0,128,0,0,255,0,0,0,0,255,33,255,11,...Buffer.from('NETSCAPE2.0'),3,1,0,0,0,33,249,4,8,6,0,0,0,44,0,0,0,0,1,0,1,0,0,2,2,68,1,0,33,249,4,8,6,0,0,0,44,0,0,0,0,1,0,1,0,0,2,2,76,1,0,59]);
  writeFileSync(path.join(dir,'fixture.html'),`<!doctype html><html><head><style>
  body{margin:20px;background:#17181c;color:white;font-family:system-ui}.imageWrapper{position:relative;width:240px;height:160px;margin-bottom:12px}.native-clickable{width:100%;height:100%}.imageWrapper img{display:block;object-fit:cover;width:100%;height:100%}#native-overlay{position:absolute;inset:0;z-index:1}.avatarWrap{width:32px;height:32px}.avatarWrap img{display:block;width:32px;height:32px}
  </style></head><body><div class="imageWrapper imageWrapper_fixture"><a id="native-overlay" aria-hidden="true" data-role="img" href="https://cdn.discordapp.com/attachments/1/2/original.png?ex=signed&is=keep&hm=keep"></a><div class="native-clickable" role="button" tabindex="0"><img id="static" alt="Original test image" src="https://media.discordapp.net/attachments/1/2/thumbnail.png?width=96&height=64&ex=signed" srcset="https://media.discordapp.net/attachments/1/2/thumbnail.png?width=96&height=64&ex=signed 1x" width="240" height="160" style="object-fit:cover"></div></div><div id="after-static"></div><div class="imageWrapper imageWrapper_fixture"><img id="gif" alt="sample.gif" src="https://media.discordapp.net/attachments/1/2/sample.gif?width=100" width="240" height="160"></div><div class="spoilerContent_fixture hidden_fixture"><img id="spoiler" src="https://cdn.discordapp.com/attachments/1/2/secret.png" width="40" height="40"></div><img id="emoji" class="emoji_fixture" src="https://cdn.discordapp.com/emojis/x.png" width="20" height="20"><div class="avatarWrap"><img id="avatar" class="avatar_fixture" src="https://cdn.discordapp.com/avatars/1/hash.png?size=64" width="32" height="32"></div><div class="imageWrapper"><a href="https://cdn.discordapp.com/attachments/1/2/slow-original.png"><img id="progressive" src="https://media.discordapp.net/attachments/1/2/progressive.png?width=96" width="240" height="160"></a></div><input id="composer" aria-label="Message"><script>(${setup.toString()})();</script><script src="/fixture.js"></script></body></html>`);
  writeFileSync(path.join(dir,'main.cjs'),`const checks=${checks.toString()};(${driver.toString()})(${JSON.stringify(dir)},${JSON.stringify(gif.toString('base64'))});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const result=spawnSync(electron,[path.join(dir,'main.cjs')],{env,encoding:'utf8',timeout:35000,maxBuffer:2*1024*1024});
  assert.equal(result.status,0,`${result.error??''}\n${result.stdout}\n${result.stderr}`);const line=result.stdout.split('\n').find(line=>line.startsWith('IMAGE_ZOOM_UI '));assert.ok(line,result.stdout);const values=JSON.parse(line.slice('IMAGE_ZOOM_UI '.length));assert.deepEqual(values.warnings,[]);for(const [key,value]of Object.entries(values))if(key!=='warnings')assert.equal(value,true,key+' '+JSON.stringify(values));
 }finally{if(process.env.SYNCORD_KEEP_IMAGE_ZOOM_FIXTURE)console.log('IMAGE_ZOOM_FIXTURE '+dir);else rmSync(dir,{recursive:true,force:true});}
});
