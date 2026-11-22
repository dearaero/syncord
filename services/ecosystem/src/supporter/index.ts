import {ecoKey,ecoActive,type EcoBadge} from '../../../../src/shared/ecosystem';
import {badgeInput,badgeRevision,customBadgeId,MAX_CUSTOM_BADGE_INPUT} from '../../../../src/shared/supporter';
import {ApiError,type Env,type Database} from '../types';
import {hash} from '../crypto';
import {body,fields} from '../http';
import {command,badgeRow,supporterStatus,supporterQuota} from './data';
import {boundedBytes,processBadge,imageConfigured} from './images';
import {assetResponse} from './assets';
const json=(value:unknown):Response=>Response.json(value,{headers:{'cache-control':'no-store'}});
export async function publicSupporterBadges(db:Database,ids:string[]):Promise<Record<string,EcoBadge[]>>{
 const result:Record<string,EcoBadge[]>={};for(const id of ids)result[id]=[];if(!ids.length)return result;const q=ids.map(()=>'?').join(',');
 const official=await db.prepare(`SELECT e.account_id,b.id,b.name,b.description,b.art,b.price,COALESCE('png:'||b.png_image,b.image) image FROM supporter_entitlements e JOIN badges b ON b.supporter_tier=e.tier WHERE e.account_id IN (${q}) AND e.tier>0 AND e.suspended=0 AND b.is_deleted=0`).bind(...ids).all<EcoBadge&{account_id:string}>();
 const custom=await db.prepare(`SELECT b.account_id,b.id,b.name,b.description,'shield' art,0 price,'png:'||b.image image FROM custom_badges b JOIN supporter_entitlements e ON e.account_id=b.account_id WHERE b.account_id IN (${q}) AND e.tier>0 AND e.suspended=0 AND b.status='APPROVED' AND b.active=1 AND b.deleted_at IS NULL ORDER BY b.created_at,b.id`).bind(...ids).all<EcoBadge&{account_id:string}>();
 for(const row of [...official.results,...custom.results]){const{account_id,...badge}=row;result[account_id]?.push(badge);}return result;
}
export async function supporterRoutes(request:Request,env:Env,db:Database,owner:string,now:number):Promise<Response>{
 const path=new URL(request.url).pathname;await supporterQuota(db,owner,'user',now,60);
 if(path==='/v1/me/supporter'&&request.method==='GET')return json(await supporterStatus(db,env,owner));
 if(path==='/v1/me/custom-badges'&&request.method==='POST'){
  await supporterQuota(db,owner,'create',now,6,3600000);await supporterQuota(db,owner,'create-day',now,12,86400000);const b=await body(request);fields(b,['input','key']);const input=badgeInput(b.input),key=ecoKey(b.key);
  // Derive a stable command target so an uncertain network retry cannot allocate a second slot.
  const id='custom-'+(await hash(owner+':'+key)).slice(0,32);await command(db,owner,owner,'create',id,0,key,input,now);return json(await supporterStatus(db,env,owner));
 }
 if(path==='/v1/me/custom-badges/active'&&request.method==='PUT'){
  await supporterQuota(db,owner,'activate',now,20);const b=await body(request);fields(b,['ids','key']);const ids=ecoActive(b.ids);ids.forEach(customBadgeId);
  await command(db,owner,owner,'activate',owner,0,ecoKey(b.key),ids,now);return json(await supporterStatus(db,env,owner));
 }
 const match=path.match(/^\/v1\/me\/custom-badges\/(custom-[a-f0-9]{32})(?:\/(image|submit))?$/);if(!match)throw new ApiError(404,'not_found');
 const id=customBadgeId(match[1]),row=await badgeRow(db,id,owner);
 if(match[2]==='image'&&request.method==='GET')return assetResponse(env,db,row.image);
 if(match[2]==='image'&&request.method==='POST'){
  await supporterQuota(db,owner,'upload',now,5);await supporterQuota(db,owner,'upload-hour',now,12,3600000);await supporterQuota(db,owner,'upload-day',now,24,86400000);
  if(!imageConfigured(env))throw new ApiError(503,'supporter.unconfigured');
  const key=ecoKey(request.headers.get('idempotency-key')),revision=badgeRevision(Number(request.headers.get('x-badge-revision')));
  if(request.headers.get('content-type')!=='application/octet-stream')throw new ApiError(415,'supporter.invalidImage');
  const bytes=await boundedBytes(request.body,MAX_CUSTOM_BADGE_INPUT),sourceHash=await hashBytes(bytes);
  const claim=await command(db,owner,owner,'process',id,revision,key,{lease:key,sourceHash},now);
  if(claim.replayed){const current=await badgeRow(db,id,owner);if(current.status==='PROCESSING'&&current.lease===key)throw new ApiError(409,'supporter.processing');if(!await db.prepare("SELECT id FROM supporter_commands WHERE target_id=? AND action='image' AND json_extract(payload,'$.lease')=?").bind(id,key).first())throw new ApiError(409,'supporter.processingFailed');return json(await supporterStatus(db,env,owner));}
  try{
   const png=await processBadge(env,bytes),image=await hashBytes(png),storageKey='processed/'+image+'.png';
   await env.BADGE_ASSETS!.put(storageKey,png,{httpMetadata:{contentType:'image/png'}});
   await db.prepare('INSERT INTO custom_badge_assets(hash,storage_key,size_bytes,width,height,created_at) VALUES(?,?,?,128,128,?) ON CONFLICT(hash) DO NOTHING').bind(image,storageKey,png.length,now).run();
   await command(db,owner,owner,'image',id,revision+1,crypto.randomUUID(),{image,lease:key},now);
  }catch(error){await command(db,owner,owner,'fail',id,revision+1,crypto.randomUUID(),{lease:key},now).catch(()=>{});throw error;}
  return json(await supporterStatus(db,env,owner));
 }
 const b=await body(request);const key=ecoKey(b.key),revision=badgeRevision(b.revision);
 if(!match[2]&&request.method==='PUT'){fields(b,['key','revision','input']);await supporterQuota(db,owner,'edit',now,20);await command(db,owner,owner,'edit',id,revision,key,badgeInput(b.input),now);}
 else if(!match[2]&&request.method==='DELETE'){fields(b,['key','revision']);await command(db,owner,owner,'delete',id,revision,key,{},now);}
 else if(match[2]==='submit'&&request.method==='POST'){fields(b,['key','revision']);await supporterQuota(db,owner,'submit',now,6,3600000);await supporterQuota(db,owner,'submit-burst:'+id,now,1);await command(db,owner,owner,'submit',id,revision,key,{},now);}
 else throw new ApiError(404,'not_found');return json(await supporterStatus(db,env,owner));
}
async function hashBytes(bytes:Uint8Array):Promise<string>{const result=await crypto.subtle.digest('SHA-256',bytes.slice().buffer);return Array.from(new Uint8Array(result),n=>n.toString(16).padStart(2,'0')).join('');}
