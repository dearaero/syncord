import {ecoAccount,ecoKey,MAX_BADGE_SVG_BYTES} from '../../../../src/shared/ecosystem';
import {supporterTier,customBadgeId,badgeRevision} from '../../../../src/shared/supporter';
import {ApiError,type Database,type Env} from '../types';
import {body,fields} from '../http';
import {command,supporterStatus,badgeRow,publicBadge,reviewReason,type BadgeRow} from '../supporter/data';
import {adminApi} from './api';
import {response,type Session} from './security';
import {assetResponse} from '../supporter/assets';

async function reviewPage(db:Database,before=Number.MAX_SAFE_INTEGER):Promise<unknown>{
 const rows=(await db.prepare("SELECT b.*,b.rowid queue_id,COALESCE(e.tier,0) tier FROM custom_badges b LEFT JOIN supporter_entitlements e ON e.account_id=b.account_id WHERE b.rowid<? AND b.deleted_at IS NULL AND b.status IN('PENDING_REVIEW','APPROVED','REJECTED','REVOKED') ORDER BY b.rowid DESC LIMIT 51").bind(before).all<BadgeRow&{queue_id:number;tier:number}>()).results;
 const page=rows.slice(0,50),ids=page.map(b=>b.id);
 const history=ids.length?(await db.prepare(`SELECT actor_id actor,target_id badgeId,action,expected_revision revision,json_extract(payload,'$.reason') reason,created_at at FROM supporter_commands WHERE target_id IN (${ids.map(()=>'?').join(',')}) AND action IN('approve','reject','revoke') ORDER BY id DESC LIMIT 100`).bind(...ids).all()).results:[];
 return{entries:page.map(b=>({...publicBadge(b),tier:b.tier})),next:rows.length>50?page[49].queue_id:null,history};
}
function cursor(url:URL):number{const n=Number(url.searchParams.get('before')??Number.MAX_SAFE_INTEGER);if(!Number.isSafeInteger(n)||n<1)throw new ApiError(400,'supporter.invalid');return n;}
/** Called only after the existing web admin session, allowlist, origin, CSRF and quotas. */
export async function supporterAdminApi(request:Request,env:Env,db:Database,s:Session,now:number):Promise<Response>{
 const url=new URL(request.url),path=url.pathname;
 const official=async():Promise<Response>=>response((await db.prepare('SELECT id,name,description,art,price,COALESCE(\'png:\'||png_image,image) image,revision FROM badges WHERE supporter_tier>0 AND is_deleted=0 ORDER BY supporter_tier').all()).results);
 if(path==='/admin/api/supporter/official'&&request.method==='GET')return official();
 const officialTier=path.match(/^\/admin\/api\/supporter\/official\/([1-3])$/);
 if(officialTier&&request.method==='PUT'){
  const b=await body(request,MAX_BADGE_SVG_BYTES*2+4096);fields(b,['key','revision','name','description','art','image','svg']);
  const forwarded=new Request(env.PUBLIC_ORIGIN+'/admin/api/badges/supporter-tier-'+officialTier[1],{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({...b,available:false,price:1})});
  const result=await adminApi(forwarded,db,s,now);if(!result.ok)return result;return official();
 }
 if(path==='/admin/api/supporter/reviews'&&request.method==='GET')return response(await reviewPage(db,cursor(url)));
 if(path==='/admin/api/supporter/activity'&&request.method==='GET'){
  const rows=(await db.prepare("SELECT c.id,c.actor_id,c.owner_id,c.action,c.target_id,c.expected_revision,c.payload,c.created_at,h.old_tier,h.new_tier,h.old_suspended,h.new_suspended FROM supporter_commands c LEFT JOIN supporter_tier_history h ON h.command_id=c.id WHERE c.id<? AND c.action IN('tier','approve','reject','revoke') ORDER BY c.id DESC LIMIT 51").bind(cursor(url)).all<{id:number}>()).results;
  return response({entries:rows.slice(0,50),next:rows.length>50?rows[49].id:null});
 }
 const target=path.match(/^\/admin\/api\/supporter\/accounts\/(\d{17,20})$/);
 if(target){
  const id=ecoAccount(target[1]),account=await db.prepare('SELECT id,username FROM accounts WHERE id=?').bind(id).first();if(!account)throw new ApiError(404,'supporter.notFound');
  if(request.method==='GET')return response({...await supporterStatus(db,env,id),account});
  if(request.method==='PUT'){
   const b=await body(request);fields(b,['tier','suspended','revision','key']);const tier=supporterTier(b.tier);
   if(typeof b.suspended!=='boolean'||typeof b.revision!=='number'||!Number.isSafeInteger(b.revision)||b.revision<0)throw new ApiError(400,'supporter.invalid');
   await command(db,s.account_id,id,'tier',id,b.revision,ecoKey(b.key),{tier,suspended:b.suspended?1:0},now);
   return response({...await supporterStatus(db,env,id),account});
  }
 }
 const badge=path.match(/^\/admin\/api\/supporter\/badges\/(custom-[a-f0-9]{32})\/(approve|reject|revoke|image)$/);
 if(badge){
  const id=customBadgeId(badge[1]),row=await badgeRow(db,id);
  if(badge[2]==='image'&&request.method==='GET')return assetResponse(env,db,row.image);
  if(['approve','reject','revoke'].includes(badge[2])&&request.method==='POST'){
   // The web-admin gate authenticates the actor; owning this badge does not
   // remove that authority. The command still records both actor and owner.
   const b=await body(request);fields(b,['revision','key','reason']);const reason=reviewReason(b.reason);if(badge[2]!=='approve'&&!reason)throw new ApiError(400,'supporter.invalid');
   await command(db,s.account_id,row.account_id,badge[2],id,badgeRevision(b.revision),ecoKey(b.key),{reason},now);
   return response(await reviewPage(db));
  }
 }
 throw new ApiError(404,'not_found');
}
