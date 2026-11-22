import {badgeText,type CustomBadge,type SupporterStatus,type SupporterTier} from '../../../../src/shared/supporter';
import {ApiError,type Database,type Env} from '../types';
import {hash} from '../crypto';
import {imageConfigured} from './images';
export type BadgeRow={id:string;account_id:string;name:string;description:string;status:CustomBadge['status'];active:number;image:string|null;revision:number;created_at:number;submitted_at:number|null;reason:string;lease:string|null;updated_at:number};
export const publicBadge=(b:BadgeRow):CustomBadge=>({id:b.id,accountId:b.account_id,name:b.name,description:b.description,status:b.status,active:b.active===1,...(b.image?{image:'png:'+b.image}:{}),revision:b.revision,createdAt:b.created_at,submittedAt:b.submitted_at,reason:b.reason});
export async function command(db:Database,actor:string,owner:string,action:string,id:string,revision:number,key:string,payload:unknown,now:number):Promise<{replayed:boolean;id:string}> {
 const requestHash=await hash(JSON.stringify([owner,action,id,revision,payload]));
 const previous=await db.prepare('SELECT request_hash,target_id FROM supporter_commands WHERE actor_id=? AND request_key=?').bind(actor,key).first<{request_hash:string;target_id:string}>();
 if(previous){if(previous.request_hash!==requestHash)throw new ApiError(409,'supporter.conflict');return{replayed:true,id:previous.target_id};}
 try{await db.prepare('INSERT INTO supporter_commands(actor_id,owner_id,request_key,action,target_id,expected_revision,request_hash,payload,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(actor_id,request_key) DO NOTHING').bind(actor,owner,key,action,id,revision,requestHash,JSON.stringify(payload),now).run();}
 catch(error){const code=/supporter\.[A-Za-z]+/.exec(error instanceof Error?error.message:'')?.[0];if(code)throw new ApiError(409,code);throw error;}
 const receipt=await db.prepare('SELECT request_hash,target_id FROM supporter_commands WHERE actor_id=? AND request_key=?').bind(actor,key).first<{request_hash:string;target_id:string}>();
 if(!receipt||receipt.request_hash!==requestHash)throw new ApiError(409,'supporter.conflict');return{replayed:false,id:receipt.target_id};
}
export async function badgeRow(db:Database,id:string,owner?:string):Promise<BadgeRow>{const row=await db.prepare('SELECT * FROM custom_badges WHERE id=? AND deleted_at IS NULL'+(owner?' AND account_id=?':'')).bind(id,...(owner?[owner]:[])).first<BadgeRow>();if(!row)throw new ApiError(404,'supporter.notFound');return row;}
export async function supporterStatus(db:Database,env:Env,owner:string):Promise<SupporterStatus & {adminEligible:false}>{
 const stale=(await db.prepare("SELECT id,revision,lease FROM custom_badges WHERE account_id=? AND deleted_at IS NULL AND status='PROCESSING' AND updated_at<? LIMIT 3").bind(owner,Date.now()-120000).all<{id:string;revision:number;lease:string}>()).results;
 for(const badge of stale)await command(db,owner,owner,'fail',badge.id,badge.revision,crypto.randomUUID(),{lease:badge.lease},Date.now()).catch(error=>{if(!(error instanceof ApiError&&error.status===409))throw error;});
 const e=await db.prepare('SELECT tier,suspended,revision FROM supporter_entitlements WHERE account_id=?').bind(owner).first<{tier:SupporterTier;suspended:number;revision:number}>();
 const rows=await db.prepare('SELECT * FROM custom_badges WHERE account_id=? AND deleted_at IS NULL ORDER BY created_at,id LIMIT 3').bind(owner).all<BadgeRow>();
 // Older installed clients must also hide their now-removed administration UI.
 return{tier:e?.tier??0,suspended:e?.suspended===1,revision:e?.revision??0,slotsUsed:rows.results.length,uploadConfigured:imageConfigured(env),adminEligible:false,badges:rows.results.map(publicBadge)};
}
export async function supporterQuota(db:Database,actor:string,group:string,now:number,max:number,window=60000):Promise<void>{
 const key=await hash('supporter:'+group+':'+actor+':'+Math.floor(now/window));const row=await db.prepare('INSERT INTO request_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(key,now+window*2).first<{count:number}>();
 if(!row||row.count>max)throw new ApiError(429,'supporter.rate');
}
export const reviewReason=(value:unknown):string=>badgeText(value,160);
