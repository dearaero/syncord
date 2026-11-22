import { number as i18nNumber, t as i18nText, type Params } from "../../i18n";
import {prepareWebmHeader} from '../../../shared/webm';
import {budget,fit,filename,kind,type Options,type MediaKind} from './model';
type ProgressMessage={key:string;params:Params};
export type Progress=(percent:number,detail:string,message?:ProgressMessage)=>void;
function notify(progress:Progress,percent:number,key:string,params:Params={}):void{progress(percent,i18nText(key,params),{key,params});}
// These closures retain only the output file and scalar display metadata, never
// the encoder's canvas, streams, signal or original processing context.
function imageResult(file:File,width:number,height:number,quality:number):Result{return{file,kind:'image',get description(){return i18nText('ui.value_value_webp_encoder_quality_value',{v0:i18nNumber(width,{useGrouping:false}),v1:i18nNumber(height,{useGrouping:false}),v2:quality});}};}
function mediaResult(file:File,video:boolean,width:number,height:number,fps:number,kbps:number,duration:number):Result{return{file,kind:video?'video':'audio',get description(){return i18nText('ui.value_value_kbps_values',{v0:video?i18nText('ui.value_value_vp8_up_to_value_fps',{v0:i18nNumber(width,{useGrouping:false}),v1:i18nNumber(height,{useGrouping:false}),v2:fps}):i18nText('ui.opus_audio'),v1:kbps,v2:i18nNumber(duration,{minimumFractionDigits:1,maximumFractionDigits:1,useGrouping:false})});}};}
export type Result={file:File;description:string;kind:MediaKind};
const abort=(signal:AbortSignal):void=>signal.throwIfAborted();
function wait(target:EventTarget,event:string,signal:AbortSignal,ms=15000):Promise<void>{
 return new Promise((resolve,reject)=>{const clear=()=>{clearTimeout(timer);target.removeEventListener(event,done);target.removeEventListener('error',error);signal.removeEventListener('abort',cancel);};const done=()=>{clear();resolve();},error=()=>{clear();reject(Error("This file could not be decoded locally. The original is unchanged."));},cancel=()=>{clear();reject(signal.reason??new DOMException('Cancelled','AbortError'));};const timer=setTimeout(()=>{clear();reject(Error("Media decoder timed out. Try another format."));},ms);target.addEventListener(event,done,{once:true});target.addEventListener('error',error,{once:true});signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();});
}
/** Reads a bounded header, rejects animation instead of quietly turning it into one still frame. */
export async function imageInfo(file:Blob):Promise<{width:number;height:number}>{
 const b=new Uint8Array(await file.slice(0,1024*1024).arrayBuffer()),v=new DataView(b.buffer);const text=(i:number,n:number)=>String.fromCharCode(...b.subarray(i,i+n));
 if(b.length>24&&text(1,3)==='PNG'){
  let p=8,staticImage=false;while(p+12<=b.length){const length=v.getUint32(p),type=text(p+4,4);if(type==='acTL')throw Error("Animated PNGs are kept unchanged. Use a video to preserve animation.");if(type==='IDAT'){staticImage=true;break;}if(length>b.length-p-12)break;p+=12+length;}
  if(!staticImage)throw Error("This PNG header cannot be verified safely.");return{width:v.getUint32(16),height:v.getUint32(20)};
 }
 if(b.length>30&&text(0,4)==='RIFF'&&text(8,4)==='WEBP'){
  if(text(12,4)==='VP8X'){if(b[20]&2)throw Error("Animated WebP is kept unchanged. Use a video to preserve animation.");return{width:1+b[24]+(b[25]<<8)+(b[26]<<16),height:1+b[27]+(b[28]<<8)+(b[29]<<16)};}
  if(text(12,4)==='VP8 '&&b[23]===0x9d&&b[24]===1&&b[25]===0x2a)return{width:v.getUint16(26,true)&0x3fff,height:v.getUint16(28,true)&0x3fff};
  if(text(12,4)==='VP8L'&&b[20]===0x2f)return{width:1+(((b[22]&63)<<8)|b[21]),height:1+(((b[24]&15)<<10)|(b[23]<<2)|((b[22]&192)>>6))};
 }
 if(b[0]===255&&b[1]===216){let p=2;while(p+8<b.length){if(b[p++]!==255)break;while(b[p]===255)p++;const marker=b[p++];if(marker===0xda||marker===0xd9)break;const length=v.getUint16(p);if(length<2||p+length>b.length)break;if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker))return{width:v.getUint16(p+5),height:v.getUint16(p+3)};p+=length;}}
 throw Error("Only verified static JPEG, PNG and WebP images can be optimized.");
}
async function image(file:File,target:number,signal:AbortSignal,progress:Progress):Promise<Result>{
 const info=await imageInfo(file);fit(info.width,info.height,2048);abort(signal);
 const bitmap=await createImageBitmap(file),canvas=document.createElement('canvas');
 try{
  abort(signal);let edge=Math.min(2048,Math.max(bitmap.width,bitmap.height));
  for(let pass=0;pass<4;pass++,edge=Math.floor(edge*.7)){
   const dims=fit(bitmap.width,bitmap.height,edge);canvas.width=dims.width;canvas.height=dims.height;const ctx=canvas.getContext('2d');if(!ctx)throw Error("Canvas encoding is unavailable.");ctx.drawImage(bitmap,0,0,dims.width,dims.height);
   for(const quality of [.9,.72,.5]){abort(signal);const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('Image encoding failed.')),'image/webp',quality));abort(signal);if(blob.type!=='image/webp')throw Error("The local WebP encoder is unavailable.");notify(progress,Math.min(95,(pass*3+1)*8),"ui.optimizing_image_locally");if(blob.size<=target&&blob.size<file.size)return imageResult(new File([blob],filename(file.name,'webp'),{type:'image/webp'}),dims.width,dims.height,Math.round(quality*100));}
  }
  throw Error("This image cannot fit the limit at the supported quality. The original is unchanged.");
 }finally{bitmap.close();canvas.width=canvas.height=0;}
}
export async function withDuration(blob:Blob,seconds:number):Promise<Blob>{
 const head=new Uint8Array(await blob.slice(0,256*1024).arrayBuffer()),prepared=prepareWebmHeader(head);if(!prepared.duration)return blob;
 const {offset,length,scale}=prepared.duration,view=new DataView(prepared.bytes.buffer,prepared.bytes.byteOffset,prepared.bytes.byteLength);if(length===8)view.setFloat64(offset,seconds*1e9/scale);else view.setFloat32(offset,seconds*1e9/scale);
 return new Blob([prepared.bytes as Uint8Array<ArrayBuffer>,blob.slice(head.length)],{type:blob.type});
}
/** Reject playlists and remote-reference formats before creating a media element. */
export async function validateMedia(file:Blob,video:boolean):Promise<void>{
 const bytes=new Uint8Array(await file.slice(0,32).arrayBuffer()),text=(p:number,n:number)=>String.fromCharCode(...bytes.subarray(p,p+n));
 const mp4=text(4,4)==='ftyp',webm=bytes[0]===0x1a&&bytes[1]===0x45&&bytes[2]===0xdf&&bytes[3]===0xa3;
 const audio=text(0,4)==='OggS'||text(0,4)==='fLaC'||(text(0,4)==='RIFF'&&text(8,4)==='WAVE')||text(0,3)==='ID3'||(bytes[0]===255&&(bytes[1]&224)===224);
 if(!(mp4||webm||(!video&&audio)))throw Error("Unsupported media container. Choose MP4/MOV, WebM, WAV, MP3, AAC, Ogg or FLAC. Playlists are never opened.");
}
async function media(file:File,target:number,config:Options,signal:AbortSignal,progress:Progress,video:boolean):Promise<Result>{
 await validateMedia(file,video);abort(signal);
 const element=document.createElement(video?'video':'audio');element.preload='auto';element.style.cssText='position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';element.setAttribute('aria-hidden','true');element.tabIndex=-1;
 const url=URL.createObjectURL(file);let stream:MediaStream|undefined,context:AudioContext|undefined,recorder:MediaRecorder|undefined,source:MediaElementAudioSourceNode|undefined,destination:MediaStreamAudioDestinationNode|undefined;const canvas=document.createElement('canvas');let draw=0,watchdog=0;
 try{
  const ready=wait(element,'loadedmetadata',signal);element.src=url;document.body.append(element);element.load();await ready;abort(signal);
  let duration=element.duration;if(!Number.isFinite(duration)){const seek=wait(element,'seeked',signal);element.currentTime=1e9;await seek;duration=Number.isFinite(element.duration)?element.duration:element.currentTime;const reset=wait(element,'seeked',signal);element.currentTime=0;await reset;}
  budget(duration,target,video);let dims={width:0,height:0};if(video){const e=element as HTMLVideoElement;dims=fit(e.videoWidth,e.videoHeight,config.maxHeight);canvas.width=dims.width;canvas.height=dims.height;}
  const mime=video?'video/webm;codecs=vp8,opus':'audio/webm;codecs=opus';if(!MediaRecorder.isTypeSupported(mime))throw Error("The local WebM encoder is unavailable on this device.");
  context=new AudioContext();source=context.createMediaElementSource(element);const output=context.createMediaStreamDestination();destination=output;source.connect(output);await new Promise<void>((resolve,reject)=>{
   const clear=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);};const cancel=()=>{clear();reject(signal.reason??new DOMException('Cancelled','AbortError'));};const timer=setTimeout(()=>{clear();reject(Error("Press Retry to allow local audio processing."));},2500);
   signal.addEventListener('abort',cancel,{once:true});context!.resume().then(()=>{clear();resolve();},error=>{clear();reject(error);});if(signal.aborted)cancel();
  });abort(signal);
  if(context.state!=='running')throw Error("Press Retry to allow local audio processing.");
  for(let pass=0;pass<2;pass++){
   if(pass){const reset=wait(element,'seeked',signal);element.currentTime=0;await reset;}
   if(video&&pass){dims=fit((element as HTMLVideoElement).videoWidth,(element as HTMLVideoElement).videoHeight,Math.max(96,Math.floor(Math.max(dims.width,dims.height)*.6)));canvas.width=dims.width;canvas.height=dims.height;}
   const fps=pass?24:30;const rates=budget(duration,target,video,pass?.6:1);stream=video?canvas.captureStream(fps):new MediaStream();for(const track of output.stream.getAudioTracks())stream.addTrack(track.clone());
   const chunks:Blob[]=[];let bytes=0;let overflow=false;recorder=new MediaRecorder(stream,{mimeType:mime,audioBitsPerSecond:rates.audio,...(video?{videoBitsPerSecond:rates.video}:{})});const activeRecorder=recorder;
   const result=await new Promise<Blob>((resolve,reject)=>{
    let finished=false,activeMillis=0,lastWatch=performance.now();const finish=(error?:unknown)=>{if(finished)return;finished=true;clearInterval(draw);clearInterval(watchdog);element.pause();element.removeEventListener('ended',ended);document.removeEventListener('visibilitychange',visibility);signal.removeEventListener('abort',cancel);activeRecorder.ondataavailable=null;activeRecorder.onerror=null;activeRecorder.onstop=null;if(activeRecorder.state!=='inactive')activeRecorder.stop();error?reject(error):resolve(new Blob(chunks,{type:mime}));};
    const cancel=()=>finish(signal.reason??new DOMException('Cancelled','AbortError'));
    const ended=()=>{if(activeRecorder.state!=='inactive')activeRecorder.stop();};
    const visibility=()=>{lastWatch=performance.now();if(document.hidden&&activeRecorder.state==='recording'){element.pause();activeRecorder.pause();notify(progress,element.currentTime/duration*95,"ui.paused_while_discord_is_hidden_return_to_resume");}else if(!document.hidden&&activeRecorder.state==='paused'){activeRecorder.resume();void element.play().catch(finish);}};
    activeRecorder.ondataavailable=e=>{if(e.data.size){chunks.push(e.data);bytes+=e.data.size;}if(bytes>target*1.1){overflow=true;ended();}};
    activeRecorder.onerror=()=>finish(Error("Local media encoding failed. The original is unchanged."));
    activeRecorder.onstop=()=>{if(!overflow&&element.currentTime<duration-.25)return finish(Error("Encoding ended before the whole file was processed."));finish();};
    element.addEventListener('ended',ended);document.addEventListener('visibilitychange',visibility);signal.addEventListener('abort',cancel,{once:true});
    const ctx=video?canvas.getContext('2d'):undefined;if(video&&!ctx)return finish(Error("Canvas capture is unavailable."));
    draw=window.setInterval(()=>{if(signal.aborted)return cancel();if(document.hidden)return;try{if(video&&(element as HTMLVideoElement).readyState>=2)ctx?.drawImage(element as HTMLVideoElement,0,0,dims.width,dims.height);notify(progress,element.currentTime/duration*95,video?'ui.optimizing_video_locally':'ui.optimizing_audio_locally',{pass:pass+1});}catch(error){finish(error);}},video?1000/fps:250);
    watchdog=window.setInterval(()=>{const now=performance.now();if(!document.hidden)activeMillis+=now-lastWatch;lastWatch=now;if(activeMillis>duration*1500+30000)finish(Error("Local encoding timed out. The original is unchanged."));},1000);
    try{abort(signal);activeRecorder.start(500);if(document.hidden){activeRecorder.pause();notify(progress,0,"ui.paused_while_discord_is_hidden_return_to_resume");}else void element.play().catch(finish);}catch(error){finish(error);}
   });
   for(const track of stream.getTracks())track.stop();stream=undefined;recorder=undefined;abort(signal);
   if(!overflow){const blob=await withDuration(result,duration);if(blob.size&&blob.size<=target&&blob.size<file.size){const actual=Math.round(blob.size*8/duration/1000);return mediaResult(new File([blob],filename(file.name,'webm'),{type:video?'video/webm':'audio/webm'}),video,dims.width,dims.height,fps,actual,duration);}}
  }
  throw Error("The complete file could not fit the limit after two passes. Trim it or choose another format.");
 }finally{
  clearInterval(draw);clearInterval(watchdog);if(recorder&&recorder.state!=='inactive')try{recorder.stop();}catch{/* Encoder already ended. */}for(const track of stream?.getTracks()??[])track.stop();for(const track of destination?.stream.getTracks()??[])track.stop();source?.disconnect();await context?.close().catch(()=>{});element.pause();element.removeAttribute('src');element.load();element.remove();URL.revokeObjectURL(url);canvas.width=canvas.height=0;
 }
}
export async function optimize(file:File,target:number,config:Options,signal:AbortSignal,progress:Progress):Promise<Result>{
 abort(signal);if(!file.size||file.size>2*1024**3)throw Error("Choose a non-empty file of at most 2 GiB.");const type=kind(file);
 if(type==='image')return image(file,target,signal,progress);if(type==='video'||type==='audio')return media(file,target,config,signal,progress,type==='video');throw Error("This format cannot be optimized locally.");
}
