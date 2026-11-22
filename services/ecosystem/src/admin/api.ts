import {BADGE_ART,MAX_BADGE_SVG_BYTES,ecoBadgeImage,ecoBadgeId,ecoKey,ecoPrice,ecoAccount,type EcoBadge} from '../../../../src/shared/ecosystem';
import {ApiError,type Database} from '../types';
import {body,fields} from '../http';
import {hash} from '../crypto';
import {response,type Session} from './security';
import {sanitizeBadgeSvg} from '../svg';
type Badge=Omit<EcoBadge,'image'>&{image:string|null;available:number;revision:number;is_deleted?:0|1;svg?:string};
type Audit={id:number;request_hash:string;after_json:string|null};
function integer(value:unknown,min=1):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>2147483647)throw new ApiError(400,'admin_invalid_input');return value;}
function text(value:unknown,max:number,empty=false):string{if(typeof value!=='string'||value.length>max||(!empty&&!value.trim())||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))throw new ApiError(400,'admin_invalid_input');return value.trim();}
async function badge(input:Record<string,unknown>,id:string,revision:number):Promise<Badge>{
 if(!BADGE_ART.includes(input.art as EcoBadge['art'])||typeof input.available!=='boolean')throw new ApiError(400,'admin_invalid_input');
 const svg=input.svg===undefined?undefined:sanitizeBadgeSvg(input.svg),image=svg?await hash(svg):ecoBadgeImage(input.image)??null;
 if(svg&&input.image!=null&&input.image!==image)throw new ApiError(400,'admin_invalid_input');
 return{id,name:text(input.name,80),description:text(input.description,500,true),art:input.art as EcoBadge['art'],price:ecoPrice(input.price),available:input.available?1:0,revision,image,...(svg?{svg}:{})};
}
function cursor(url:URL):number{const n=Number(url.searchParams.get('before')??Number.MAX_SAFE_INTEGER);if(!Number.isSafeInteger(n)||n<1)throw new ApiError(400,'admin_invalid_cursor');return n;}
const result=(entry:Audit,replayed:boolean):Response=>{const item=entry.after_json?JSON.parse(entry.after_json):null;if(item)delete item.svg;return response({ok:true,auditId:entry.id,replayed,item});};
export async function adminApi(request:Request,db:Database,s:Session,now:number):Promise<Response>{
 const url=new URL(request.url),path=url.pathname;
 if(path==='/admin/api/me'&&request.method==='GET')return response({id:s.account_id,username:s.username,csrf:s.csrf,expiresAt:s.expires_at});
 if(path==='/admin/api/overview'&&request.method==='GET')return response(await db.prepare('SELECT (SELECT COUNT(*) FROM accounts) accounts,(SELECT COUNT(*) FROM badges WHERE is_deleted=0 AND supporter_tier=0) badges,(SELECT COUNT(*) FROM badges WHERE available=1 AND is_deleted=0) available,(SELECT COUNT(*) FROM purchases) purchases').first());
 if(path==='/admin/api/badges'&&request.method==='GET')return response((await db.prepare('SELECT b.id,b.name,b.description,b.art,b.price,b.available,b.revision,COALESCE(\'png:\'||b.png_image,b.image) image,b.is_deleted,(SELECT COUNT(*) FROM purchases p WHERE p.badge_id=b.id) owners FROM badges b WHERE b.is_deleted=0 AND b.supporter_tier=0 ORDER BY b.price,b.id LIMIT 512').all()).results);
 if(path==='/admin/api/audit'&&request.method==='GET'){
  const rows=(await db.prepare('SELECT id,actor_id,action,target_id,before_json,after_json,created_at FROM admin_audit WHERE id<? ORDER BY id DESC LIMIT 51').bind(cursor(url)).all<{id:number}>()).results;
  return response({entries:rows.slice(0,50),next:rows.length>50?rows[49]!.id:null});
 }
 if(path==='/admin/api/accounts'&&request.method==='GET'){
  const after=url.searchParams.get('after')??'',query=text(url.searchParams.get('q')??'',80,true);if(after)ecoAccount(after);
  const rows=(await db.prepare('SELECT a.id,a.username,a.created_at,w.balance,(SELECT COUNT(*) FROM owned_badges o JOIN badges b ON b.id=o.badge_id WHERE o.account_id=a.id AND b.is_deleted=0) badges FROM accounts a JOIN wallets w ON w.account_id=a.id WHERE a.id>? AND (?=\'\' OR a.id=? OR instr(lower(a.username),lower(?))>0) ORDER BY a.id LIMIT 51').bind(after,query,query,query).all<{id:string}>()).results;
  return response({entries:rows.slice(0,50),next:rows.length>50?rows[49]!.id:null});
 }
 const ledger=path.match(/^\/admin\/api\/accounts\/(\d{17,20})\/transactions$/);
 if(ledger&&request.method==='GET'){
  const id=ecoAccount(ledger[1]),rows=(await db.prepare('SELECT id,delta,balance_after,reason,created_at FROM ledger WHERE account_id=? AND id<? ORDER BY id DESC LIMIT 51').bind(id,cursor(url)).all<{id:number}>()).results;
  return response({entries:rows.slice(0,50),next:rows.length>50?rows[49]!.id:null});
 }
 const edit=path.match(/^\/admin\/api\/badges\/([a-z][a-z0-9-]{0,47})$/),create=path==='/admin/api/badges'&&request.method==='POST';
 if(!create&&!(edit&&['PUT','DELETE'].includes(request.method)))throw new ApiError(404,'not_found');
 const input=await body(request,MAX_BADGE_SVG_BYTES*2+4096),action=create?'badge.create':request.method==='DELETE'?'badge.delete':'badge.update';
 fields(input,action==='badge.delete'?['key','revision']:create?['key','id','name','description','art','price','available','image','svg']:['key','revision','name','description','art','price','available','image','svg']);
 const key=ecoKey(input.key),id=ecoBadgeId(create?input.id:edit![1]),expected=create?0:integer(input.revision),after=action==='badge.delete'?null:await badge(input,id,expected+1);
 const requestHash=await hash(JSON.stringify([action,id,expected,after]));
 const previous=await db.prepare('SELECT id,request_hash,after_json FROM admin_audit WHERE actor_id=? AND request_key=?').bind(s.account_id,key).first<Audit>();
 if(previous){if(previous.request_hash!==requestHash)throw new ApiError(409,'admin_idempotency_conflict');return result(previous,true);}
 const before=create?null:await db.prepare('SELECT * FROM badges WHERE id=? AND is_deleted=0').bind(id).first<Badge&{png_image:string|null}>();
 if(before?.png_image)before.image='png:'+before.png_image;
 if(!create&&!before){
  // A concurrent identical delete can commit between the replay lookup and
  // this read. Acknowledge its immutable receipt before reporting a missing ID.
  const receipt=await db.prepare('SELECT id,request_hash,after_json FROM admin_audit WHERE actor_id=? AND request_key=?').bind(s.account_id,key).first<Audit>();
  if(receipt){if(receipt.request_hash!==requestHash)throw new ApiError(409,'admin_idempotency_conflict');return result(receipt,true);}
  throw new ApiError(404,'admin_badge_not_found');
 }
 // Keep the request digest stable for existing retries; the delete receipt records its terminal state.
 const recordedAfter=action==='badge.delete'?{...before!,is_deleted:1,available:0,revision:expected+1}:after;
 await db.prepare('INSERT INTO admin_audit(actor_id,request_key,action,target_id,expected_revision,request_hash,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(actor_id,request_key) DO NOTHING').bind(s.account_id,key,action,id,expected,requestHash,before?JSON.stringify(before):null,recordedAfter?JSON.stringify(recordedAfter):null,now).run();
 const entry=await db.prepare('SELECT id,request_hash,after_json FROM admin_audit WHERE actor_id=? AND request_key=?').bind(s.account_id,key).first<Audit>();
 if(!entry||entry.request_hash!==requestHash)throw new ApiError(409,'admin_idempotency_conflict');return result(entry,false);
}
