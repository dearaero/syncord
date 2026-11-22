import {ApiError} from './types';
const obj=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new ApiError(400,'invalid_body');return value as Record<string,unknown>;};
export function fields(value:Record<string,unknown>,allowed:string[]):void{if(Object.keys(value).some(k=>!allowed.includes(k)))throw new ApiError(400,'unexpected_field');}
async function text(request:Request,max:number):Promise<string>{
 if(Number(request.headers.get('content-length'))>max)throw new ApiError(413,'body_too_large');
 const reader=request.body?.getReader();if(!reader)return '';const chunks:Uint8Array[]=[];let length=0;
 try{for(;;){const r=await reader.read();if(r.done)break;length+=r.value.byteLength;if(length>max){await reader.cancel();throw new ApiError(413,'body_too_large');}chunks.push(r.value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(length);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.byteLength;}return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
export async function body(request:Request,max=16384):Promise<Record<string,unknown>>{if(request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()!=='application/json')throw new ApiError(415,'json_required');try{return obj(JSON.parse(await text(request,max)));}catch(error){if(error instanceof ApiError)throw error;throw new ApiError(400,'invalid_body');}}
