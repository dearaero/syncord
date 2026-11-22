import {MAX_BADGE_PNG_BYTES} from '../../../../src/shared/ecosystem';
import {ApiError,type Env,type Database} from '../types';
import {boundedBytes,rasterSignature,processBadge} from '../supporter/images';
import {response,type Session} from './security';

/** Only invoked after the existing browser admin session, origin, CSRF and quotas. */
export async function uploadAdminPng(request:Request,env:Env,db:Database,s:Session,now:number):Promise<Response>{
 if(request.headers.get('content-type')!=='application/octet-stream')throw new ApiError(415,'admin_invalid_png');
 const length=request.headers.get('content-length');if(length&&Number(length)>MAX_BADGE_PNG_BYTES)throw new ApiError(413,'admin_png_too_large');
 let bytes:Uint8Array;try{bytes=await boundedBytes(request.body,MAX_BADGE_PNG_BYTES);}catch(error){if(error instanceof ApiError&&error.status===413)throw new ApiError(413,'admin_png_too_large');throw error;}
 if(rasterSignature(bytes)!=='png')throw new ApiError(415,'admin_invalid_png');
 const png=await processBadge(env,bytes),digest=await crypto.subtle.digest('SHA-256',png.slice().buffer),hash=Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join(''),key='processed/'+hash+'.png';
 await env.BADGE_ASSETS!.put(key,png,{httpMetadata:{contentType:'image/png'}});
 await db.batch([
  db.prepare('INSERT INTO custom_badge_assets(hash,storage_key,size_bytes,width,height,created_at) VALUES(?,?,?,128,128,?) ON CONFLICT(hash) DO NOTHING').bind(hash,key,png.length,now),
  db.prepare('INSERT INTO admin_badge_png(hash,actor_id,created_at) VALUES(?,?,?) ON CONFLICT(hash) DO NOTHING').bind(hash,s.account_id,now),
 ]);
 return response({image:'png:'+hash});
}
