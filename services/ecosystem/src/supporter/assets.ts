import {ApiError,type Database,type Env} from '../types';
import {MAX_CUSTOM_BADGE_OUTPUT} from '../../../../src/shared/supporter';
export async function assetResponse(env:Env,db:Database,image:string|null,publicAsset=false):Promise<Response>{
 if(!image||!/^[a-f0-9]{64}$/.test(image)||!env.BADGE_ASSETS)throw new ApiError(404,'supporter.notFound');
 const a=await db.prepare('SELECT storage_key,size_bytes FROM custom_badge_assets WHERE hash=?').bind(image).first<{storage_key:string;size_bytes:number}>();
 if(!a||a.size_bytes>MAX_CUSTOM_BADGE_OUTPUT)throw new ApiError(404,'supporter.notFound');const object=await env.BADGE_ASSETS.get(a.storage_key);
 if(!object||object.size!==a.size_bytes)throw new ApiError(404,'supporter.notFound');
 return new Response(object.body,{headers:{'content-type':'image/png','x-syncord-badge-hash':image,'cache-control':publicAsset?'public, max-age=60':'private, no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox; frame-ancestors 'none'",'referrer-policy':'no-referrer','cross-origin-resource-policy':'cross-origin'}});
}
export async function publicSupporterArt(request:Request,env:Env,db:Database):Promise<Response|undefined>{
 const match=new URL(request.url).pathname.match(/^\/v1\/custom-badge-art\/([a-f0-9]{64})\.png$/);if(!match||request.method!=='GET')return;
 const row=await db.prepare("SELECT b.image FROM custom_badges b JOIN supporter_entitlements e ON e.account_id=b.account_id WHERE b.image=? AND b.deleted_at IS NULL AND b.status='APPROVED' AND b.active=1 AND e.tier>0 AND e.suspended=0 LIMIT 1").bind(match[1]).first<{image:string}>();const official= !row&&await db.prepare('SELECT png_image FROM badges WHERE png_image=? AND is_deleted=0 LIMIT 1').bind(match[1]).first();if(!row&&!official)throw new ApiError(404,'supporter.notFound');return assetResponse(env,db,match[1],true);
}
