import {MAX_CUSTOM_BADGE_INPUT,MAX_CUSTOM_BADGE_OUTPUT} from '../../../../src/shared/supporter';
import {ApiError,type Env} from '../types';
export const imageConfigured=(env:Env):boolean=>!!env.BADGE_ASSETS&&!!env.BADGE_IMAGES&&env.SUPPORTER_UPLOAD_ENABLED==='true';
export async function boundedBytes(stream:ReadableStream<Uint8Array>|null,max:number):Promise<Uint8Array> {
 if(!stream)throw new ApiError(400,'supporter.invalidImage');const reader=stream.getReader(),parts:Uint8Array[]=[];let length=0;
 try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>max){await reader.cancel();throw new ApiError(413,'supporter.invalidImage');}parts.push(part.value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(length);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}return bytes;
}
const view=(b:Uint8Array):DataView=>new DataView(b.buffer,b.byteOffset,b.byteLength);
const ascii=(b:Uint8Array,start:number,n:number):string=>String.fromCharCode(...b.subarray(start,start+n));
/** Structural signatures, not MIME/extension trust. Decoding remains the image service's job. */
export function rasterSignature(bytes:Uint8Array):'png'|'jpeg'|'webp' {
 if(!bytes.length||bytes.length>MAX_CUSTOM_BADGE_INPUT)throw new ApiError(413,'supporter.invalidImage');
 const v=view(bytes);
 if(bytes.length>=33&&v.getUint32(0)===0x89504e47&&v.getUint32(4)===0x0d0a1a0a){
  let end=8,ihdr=false,iend=false;
  while(end+12<=bytes.length){const n=v.getUint32(end),tag=ascii(bytes,end+4,4);if(n>bytes.length-end-12||tag==='acTL'||tag==='fcTL'||tag==='fdAT')throw new ApiError(400,'supporter.invalidImage');if(!ihdr){if(tag!=='IHDR'||n!==13)throw new ApiError(400,'supporter.invalidImage');const w=v.getUint32(end+8),h=v.getUint32(end+12);if(w<1||h<1||w>2048||h>2048)throw new ApiError(400,'supporter.invalidImage');ihdr=true;}end+=n+12;if(tag==='IEND'){iend=true;break;}}
  if(!iend||end!==bytes.length)throw new ApiError(400,'supporter.invalidImage');return 'png';
 }
 if(bytes.length>4&&bytes[0]===255&&bytes[1]===216&&bytes[bytes.length-2]===255&&bytes[bytes.length-1]===217)return 'jpeg';
 if(bytes.length>=20&&ascii(bytes,0,4)==='RIFF'&&ascii(bytes,8,4)==='WEBP'&&v.getUint32(4,true)+8===bytes.length){
  let offset=12;while(offset+8<=bytes.length){const tag=ascii(bytes,offset,4),size=v.getUint32(offset+4,true);if(size>bytes.length-offset-8||tag==='ANIM'||tag==='ANMF'||tag==='VP8X'&&(bytes[offset+8]&2)!==0)throw new ApiError(400,'supporter.invalidImage');offset+=8+size+(size%2);}
  if(offset!==bytes.length)throw new ApiError(400,'supporter.invalidImage');return 'webp';
 }
 throw new ApiError(415,'supporter.invalidImage');
}
/** Strip all ancillary metadata after a real decode/re-encode. PLTE/tRNS preserve indexed alpha. */
export function cleanBadgePng(bytes:Uint8Array):Uint8Array {
 if(bytes.length>MAX_CUSTOM_BADGE_OUTPUT||rasterSignature(bytes)!=='png'||view(bytes).getUint32(16)!==128||view(bytes).getUint32(20)!==128)throw new ApiError(400,'supporter.processingFailed');
 const keep=[bytes.slice(0,8)];let offset=8,idat=false;
 while(offset+12<=bytes.length){const n=view(bytes).getUint32(offset),tag=ascii(bytes,offset+4,4);if(['IHDR','PLTE','tRNS','IDAT','IEND'].includes(tag))keep.push(bytes.slice(offset,offset+n+12));if(tag==='IDAT')idat=true;offset+=n+12;}
 if(!idat)throw new ApiError(400,'supporter.processingFailed');const size=keep.reduce((n,p)=>n+p.length,0),result=new Uint8Array(size);let at=0;for(const p of keep){result.set(p,at);at+=p.length;}return result;
}
async function decodeBadge(env:Env,bytes:Uint8Array):Promise<Uint8Array> {
 if(!imageConfigured(env))throw new ApiError(503,'supporter.unconfigured');rasterSignature(bytes);
 const stream=():ReadableStream<Uint8Array>=>new Blob([bytes.slice().buffer]).stream();
 try{
  const info=await env.BADGE_IMAGES!.info(stream());if(!Number.isInteger(info.width)||!Number.isInteger(info.height)||info.width!<1||info.height!<1||info.width!>2048||info.height!>2048)throw new ApiError(400,'supporter.invalidImage');
  const output=await env.BADGE_IMAGES!.input(stream()).transform({width:128,height:128,fit:'pad',background:'rgba(0,0,0,0)',metadata:'none'}).output({format:'image/png',anim:false});
  const response=output.response();if(!response.ok||response.headers.get('content-type')?.split(';')[0]!=='image/png')throw new ApiError(400,'supporter.processingFailed');return cleanBadgePng(await boundedBytes(response.body,MAX_CUSTOM_BADGE_OUTPUT));
 }catch(error){if(error instanceof ApiError)throw error;throw new ApiError(400,'supporter.processingFailed');}
}

/** A stalled processor never leaves the request waiting indefinitely or publishes late output. */
export async function processBadge(env:Env,bytes:Uint8Array):Promise<Uint8Array>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([decodeBadge(env,bytes),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new ApiError(503,'supporter.processingFailed')),12000);})]);}
 finally{if(timer!==undefined)clearTimeout(timer);}
}
