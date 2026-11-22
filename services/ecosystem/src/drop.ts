import {ecoAccount} from '../../../src/shared/ecosystem';
import {dropFile,dropId,dropSdp,type DropInvite} from '../../../src/shared/drop';
import {ApiError,type Database} from './types';
import {body,fields} from './http';
type Row={id:string;sender:string;receiver:string;name:string;size:number;state:DropInvite['state'];expires:number;offer:string|null;answer:string|null;senderName:string;receiverName:string};
async function view(db:Database,id:string,actor:string,now:number):Promise<Row>{
 const row=await db.prepare('SELECT d.*,a.username AS senderName,b.username AS receiverName FROM drop_invites d JOIN accounts a ON a.id=d.sender JOIN accounts b ON b.id=d.receiver WHERE d.id=? AND (d.sender=? OR d.receiver=?) AND d.expires>?').bind(id,actor,actor,now).first<Row>();
 if(!row)throw new ApiError(404,'drop.expired');return row;
}
const data=(r:Row):DropInvite=>({id:r.id,sender:r.sender,receiver:r.receiver,name:r.name,size:r.size,state:r.state,expires:r.expires,senderName:r.senderName,receiverName:r.receiverName,...(r.state==='accepted'?{offer:r.offer??undefined,answer:r.answer??undefined}:{})});
const json=(r:Row,status=200):Response=>Response.json(data(r),{status,headers:{'cache-control':'no-store'}});
const available=`EXISTS(SELECT 1 FROM drop_presence p JOIN sessions s ON s.hash=p.session_hash AND s.account_id=p.account_id WHERE p.account_id=? AND p.expires>? AND s.revoked=0 AND s.expires_at>?)`;
async function receiving(db:Database,actor:string,now:number):Promise<boolean>{return !!await db.prepare('SELECT 1 WHERE '+available).bind(actor,now,now).first();}
/** All identity comes from the existing verified bearer session, not a body ID. */
export async function dropRoutes(request:Request,db:Database,actor:string,now:number,session:string):Promise<Response>{
 const path=new URL(request.url).pathname;
 try{
  if(path==='/v1/drop/inbox'&&request.method==='POST'){
   const b=await body(request);fields(b,['lease','available']);const lease=dropId(b.lease);
   if(typeof b.available!=='boolean')throw new ApiError(400,'drop.invalid');
   if(!b.available){
    await db.prepare('DELETE FROM drop_presence WHERE account_id=? AND session_hash=? AND lease=?').bind(actor,session,lease).run();
    return Response.json([],{headers:{'cache-control':'no-store'}});
   }
   // Bound live documents per account; refreshing a known lease remains allowed.
   const renewed=await db.prepare(`INSERT INTO drop_presence(account_id,session_hash,lease,expires)
    SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM drop_presence WHERE account_id=? AND expires>?)<8 OR EXISTS(SELECT 1 FROM drop_presence WHERE account_id=? AND session_hash=? AND lease=? AND expires>?)
    ON CONFLICT(account_id,session_hash,lease) DO UPDATE SET expires=excluded.expires`).bind(actor,session,lease,now+75000,actor,now,actor,session,lease,now).run();
   if(!renewed.meta.changes)throw new ApiError(429,'drop.rate');
  }
  if(path==='/v1/drop/inbox'&&(request.method==='GET'||request.method==='POST')){
   const rows=await db.prepare("SELECT d.*,a.username AS senderName,b.username AS receiverName FROM drop_invites d JOIN accounts a ON a.id=d.sender JOIN accounts b ON b.id=d.receiver WHERE d.receiver=? AND d.state='pending' AND d.expires>? ORDER BY d.created_at,d.id LIMIT 8").bind(actor,now).all<Row>();
   return Response.json(rows.results.map(data),{headers:{'cache-control':'no-store'}});
  }
  if(path==='/v1/drop/invites'&&request.method==='POST'){
   const b=await body(request);fields(b,['receiver','name','size']);const file=dropFile(b),receiver=ecoAccount(b.receiver);
   if(receiver===actor)throw new ApiError(400,'drop.dm_only');
   if(!await receiving(db,receiver,now))throw new ApiError(409,'drop.recipient_unavailable');
   const id=crypto.randomUUID();
   // The INSERT predicates serialize quotas with creation; racing requests cannot
   // each observe the same free slot and exceed the per-account invitation budget.
   await db.prepare(`INSERT INTO drop_invites(id,sender,receiver,name,size,created_at,expires)
    SELECT ?,?,?,?,?,?,? WHERE
    (SELECT COUNT(*) FROM drop_invites WHERE sender=? AND created_at>?)<10 AND
    (SELECT COUNT(*) FROM drop_invites WHERE sender=? AND state IN ('pending','accepted') AND expires>?)<4 AND
    (SELECT COUNT(*) FROM drop_invites WHERE receiver=? AND state IN ('pending','accepted') AND expires>?)<8 AND ${available}`)
    .bind(id,actor,receiver,file.name,file.size,now,now+600000,actor,now-3600000,actor,now,receiver,now,receiver,now,now).run();
   const row=await db.prepare('SELECT id FROM drop_invites WHERE id=?').bind(id).first();if(!row){if(!await receiving(db,receiver,now))throw new ApiError(409,'drop.recipient_unavailable');throw new ApiError(429,'drop.rate');}return json(await view(db,id,actor,now),201);
  }
  const match=path.match(/^\/v1\/drop\/([a-f0-9-]{36})(?:\/(accept|decline|cancel|offer|answer|connected))?$/);if(!match)throw new ApiError(404,'not_found');
  const id=dropId(match[1]),action=match[2],r=await view(db,id,actor,now);
  if(!action&&request.method==='GET'){
   if(r.sender===actor&&r.state==='pending'){
    const cancelled=await db.prepare(`UPDATE drop_invites SET state='cancelled' WHERE id=? AND state='pending' AND NOT ${available}`).bind(id,r.receiver,now,now).run();
    if(cancelled.meta.changes)throw new ApiError(409,'drop.recipient_unavailable');
    return json(await view(db,id,actor,now));
   }
   return json(r);
  }
  if(request.method!=='POST')throw new ApiError(405,'drop.invalid');
  const b=await body(request,70000);fields(b,action==='offer'||action==='answer'?['sdp']:[]);
  if(action==='offer'||action==='answer'){
   if(r.state!=='accepted'||(action==='offer'?r.sender:r.receiver)!==actor)throw new ApiError(409,'drop.state');
   const sdp=dropSdp(b.sdp);
   if(r[action]&&r[action]!==sdp)throw new ApiError(409,'drop.state');
   await db.prepare(`UPDATE drop_invites SET ${action}=? WHERE id=? AND state='accepted' AND (${action} IS NULL OR ${action}=?)`).bind(sdp,id,sdp).run();
  }else{
   if(!action)throw new ApiError(400,'drop.invalid');
   if((action==='accept'||action==='decline')&&r.receiver!==actor)throw new ApiError(403,'drop.denied');
   const next=action==='accept'?'accepted':action==='decline'?'declined':action==='cancel'?'cancelled':'connected';
   const allowed=action==='accept'||action==='decline'?['pending']:action==='connected'?['accepted']:['pending','accepted','connected'];
   if(r.state!==next&&!allowed.includes(r.state))throw new ApiError(409,'drop.state');
   if(action==='connected'&&(!r.offer||!r.answer)&&r.state!=='connected')throw new ApiError(409,'drop.state');
   const terminal=next!=='accepted';
   await db.prepare(`UPDATE drop_invites SET state=?,expires=CASE WHEN state='pending' AND ?='accepted' THEN ? ELSE expires END,offer=CASE WHEN ? THEN NULL ELSE offer END,answer=CASE WHEN ? THEN NULL ELSE answer END WHERE id=? AND state=?`).bind(next,next,now+120000,terminal?1:0,terminal?1:0,id,r.state).run();
  }
  const result=await view(db,id,actor,now);
  const expected=({accept:'accepted',decline:'declined',cancel:'cancelled',connected:'connected'} as Record<string,string>)[action??''];if(expected&&result.state!==expected)throw new ApiError(409,'drop.state');
  if((action==='offer'||action==='answer')&&result[action]!==b.sdp)throw new ApiError(409,'drop.state');
  return json(result);
 }catch(error){if(error instanceof ApiError)throw error;if(error instanceof Error&&error.message==='drop.invalid')throw new ApiError(400,'drop.invalid');throw error;}
}
