import {dropCatalog} from '../../../src/shared/dropMessages';
import {normalizeLocale} from '../../../src/shared/i18nLocale';
import {supporterRoutes,publicSupporterBadges} from './supporter';
import {publicSupporterArt} from './supporter/assets';
import {dropRoutes} from './drop';
import {updateRoutes} from './updates';
import {ecoAccount,ecoBadgeId,ecoActive,ecoIds,ecoKey,ecoPrice,type EcoProfile,type EcoBadge} from '../../../src/shared/ecosystem';
import {ApiError,type Env,type Database} from './types';
import {hash,secretEqual,random} from './crypto';
import {oauthRoutes} from './oauth';
import {body,fields} from './http';
import {adminRoutes,adminOAuthCallback} from './admin';
const DAY=86400000,SESSION_DAYS=90;
const json=(value:unknown,status=200):Response=>Response.json(value,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
const token=(value:unknown):string=>{if(typeof value!=='string'||!/^\w{64}$/.test(value)||!/^[a-f0-9]+$/.test(value))throw new ApiError(400,'invalid_secret');return value;};
async function limit(db:Database,request:Request,path:string,now:number):Promise<void>{
 const ip=request.headers.get('cf-connecting-ip')??'local',minute=Math.floor(now/60000),group=path.startsWith('/v1/auth')?'auth':path.includes('lookup')?'lookup':(path.startsWith('/v1/badge-art/')||path.startsWith('/v1/custom-badge-art/'))?'art':'api';
 const key=await hash(ip+':'+group+':'+minute),ceiling=group==='auth'?30:group==='lookup'?60:group==='art'?600:120;
 const r=await db.prepare('INSERT INTO request_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(key,now+120000).first<{count:number}>();
 if(!r||r.count>ceiling)throw new ApiError(429,'rate_limited');
}
async function account(db:Database,request:Request,now:number):Promise<{id:string;hash:string}>{
 const authorization=request.headers.get('authorization')??'';if(!/^Bearer [a-f0-9]{64}$/.test(authorization))throw new ApiError(401,'authentication_required');
 const digest=await hash(authorization.slice(7)),s=await db.prepare('SELECT account_id FROM sessions WHERE hash=? AND revoked=0 AND expires_at>?').bind(digest,now).first<{account_id:string}>();
 if(!s)throw new ApiError(401,'session_expired');
 await db.prepare('UPDATE sessions SET expires_at=? WHERE hash=? AND expires_at<? AND revoked=0').bind(now+SESSION_DAYS*DAY,digest,now+60*DAY).run();return{id:s.account_id,hash:digest};
}
async function profile(db:Database,id:string,png=false):Promise<EcoProfile>{
 const user=await db.prepare('SELECT a.id,a.username,a.avatar,w.balance FROM accounts a JOIN wallets w ON w.account_id=a.id WHERE a.id=?').bind(id).first<Omit<EcoProfile,'badges'>>();if(!user)throw new ApiError(404,'account_not_found');
 const rows=await db.prepare('SELECT b.id,b.name,b.description,b.art,b.price,COALESCE(\'png:\'||b.png_image,b.image) image,o.active FROM owned_badges o JOIN badges b ON b.id=o.badge_id WHERE o.account_id=? AND b.is_deleted=0 ORDER BY b.price,b.id').bind(id).all<EcoBadge&{active:number}>();return{...user,badges:rows.results.map(r=>({...r,...(!png&&r.image?.startsWith('png:')?{image:undefined}:{}),active:r.active===1}))};
}
async function grant(db:Database,id:string,rule:string,event:string,now:number):Promise<void>{
 await db.prepare(`INSERT INTO reward_grants(id,account_id,rule_id,event_id,amount,created_at)
 SELECT ?,?,?,?,amount,? FROM reward_rules r WHERE r.id=? AND r.enabled=1
 AND NOT EXISTS(SELECT 1 FROM reward_grants WHERE rule_id=? AND event_id=?)
 AND (r.once_per_account=0 OR NOT EXISTS(SELECT 1 FROM reward_grants WHERE account_id=? AND rule_id=r.id))`).bind(crypto.randomUUID(),id,rule,event,now,rule,rule,event,id).run();
}
export async function handle(request:Request,env:Env,now=Date.now()):Promise<Response>{
 const db=env.DB.withSession?.('first-primary')??env.DB,url=new URL(request.url),path=url.pathname,pngSupport=request.headers.get('x-syncord-badge-formats')==='png';
 try{
  if(path==='/admin'||path.startsWith('/admin/'))return await adminRoutes(request,env,db,now);
  if(path==='/oauth/callback'){const response=await adminOAuthCallback(request,env,db,now);if(response)return response;}
  if(path.startsWith('/oauth/')){await limit(db,request,path,now);return await oauthRoutes(request,env,db,now);}
  if(/^\/drop\/[a-f0-9-]{36}$/.test(path)&&request.method==='GET')return new Response('Syncord Drop\n\n'+dropCatalog(normalizeLocale(request.headers.get('accept-language')?.split(',')[0]?.split(';')[0]))['drop.requires'],{headers:{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'}});
  if(path==='/health'&&request.method==='GET')return json({service:'syncord-ecosystem',version:1,features:{drop:1,dropInbox:1,dropPresence:1,supporter:1},verificationConfigured:!!env.DISCORD_CLIENT_SECRET&&/^\d{17,20}$/.test(env.DISCORD_CLIENT_ID)&&env.PUBLIC_ORIGIN==='https://api.syncord.pro'});
  if(path==='/internal/rewards'&&request.method==='POST'){
   if(!env.REWARD_API_KEY||env.REWARD_API_KEY.length<32||!await secretEqual(request.headers.get('authorization')??'','Bearer '+env.REWARD_API_KEY))throw new ApiError(401,'server_authorization_required');
   const b=await body(request);fields(b,['userId','ruleId','eventId']);const id=ecoAccount(b.userId),rule=ecoBadgeId(b.ruleId);if(rule==='verified-welcome'||typeof b.eventId!=='string'||!/^[a-zA-Z0-9:_-]{1,128}$/.test(b.eventId))throw new ApiError(400,'invalid_reward_event');
   if(!await db.prepare('SELECT id FROM reward_rules WHERE id=? AND enabled=1').bind(rule).first())throw new ApiError(404,'reward_not_found');
   if(!await db.prepare('SELECT id FROM accounts WHERE id=?').bind(id).first())throw new ApiError(404,'account_not_found');
   await grant(db,id,rule,b.eventId,now);
   const event=await db.prepare('SELECT account_id FROM reward_grants WHERE rule_id=? AND event_id=?').bind(rule,b.eventId).first<{account_id:string}>();if(event&&event.account_id!==id)throw new ApiError(409,'idempotency_conflict');return json({accepted:true});
  }
  if(path==='/internal/profile'&&request.method==='POST'){
   // Read-only key for the Discord bot, separate from REWARD_API_KEY so a leak cannot grant SP.
   if(!env.BOT_API_KEY||env.BOT_API_KEY.length<32||!await secretEqual(request.headers.get('authorization')??'','Bearer '+env.BOT_API_KEY))throw new ApiError(401,'server_authorization_required');
   const b=await body(request);fields(b,['userId']);const id=ecoAccount(b.userId),supporter=await publicSupporterBadges(db,[id]);
   return json({...await profile(db,id),supporter:supporter[id]??[]});
  }
  // Before the D1 limiter: a boot-time update check must not cost a database write.
  const update=await updateRoutes(request,env);if(update)return update;
  if(path.startsWith('/v1/supporter-admin/'))throw new ApiError(410,'supporter.adminWebOnly');
  await limit(db,request,path,now);
  const supporterArt=await publicSupporterArt(request,env,db);if(supporterArt)return supporterArt;
  const art=path.match(/^\/v1\/badge-art\/([a-f0-9]{64})\.svg$/);
  if(art&&request.method==='GET'){
   const row=await db.prepare('SELECT svg FROM badge_art WHERE id=?').bind(art[1]).first<{svg:string}>();if(!row)throw new ApiError(404,'badge_art_not_found');
   return new Response(row.svg,{headers:{'content-type':'image/svg+xml; charset=utf-8','cache-control':'public, max-age=31536000, immutable','content-security-policy':"default-src 'none'; sandbox; frame-ancestors 'none'",'x-content-type-options':'nosniff','referrer-policy':'no-referrer','cross-origin-resource-policy':'cross-origin','access-control-allow-origin':'*'}});
  }
  if(path==='/v1/auth/challenge'&&request.method==='POST'){
   if(!env.DISCORD_CLIENT_SECRET||!/^\d{17,20}$/.test(env.DISCORD_CLIENT_ID)||env.PUBLIC_ORIGIN!=='https://api.syncord.pro')throw new ApiError(503,'verification_unconfigured');
   const b=await body(request);fields(b,['accountId','pollToken','sessionHash']);const id=ecoAccount(b.accountId),poll=token(b.pollToken),sessionHash=token(b.sessionHash),state=random();
   await db.prepare('INSERT INTO challenges(poll_hash,state_hash,session_hash,expected_id,verifier,expires_at,created_at) VALUES(?,?,?,?,?,?,?)').bind(await hash(poll),await hash(state),sessionHash,id,random(),now+10*60000,now).run();return json({state,expiresAt:now+10*60000},201);
  }
  if(path==='/v1/auth/poll'&&request.method==='POST'){
   const b=await body(request);fields(b,['pollToken']);const pollHash=await hash(token(b.pollToken)),row=await db.prepare("SELECT * FROM challenges WHERE poll_hash=? AND expires_at>? AND purpose='user'").bind(pollHash,now).first<{verified_id:string|null;expected_id:string;session_hash:string;failure:string|null}>();
   if(!row)throw new ApiError(410,'link_expired');if(row.failure)throw new ApiError(403,'verification_failed');if(!row.verified_id)return json({linked:false});if(row.verified_id!==row.expected_id)throw new ApiError(401,'account_mismatch');
   await db.prepare('INSERT INTO sessions(hash,account_id,created_at,expires_at) VALUES(?,?,?,?) ON CONFLICT(hash) DO NOTHING').bind(row.session_hash,row.verified_id,now,now+SESSION_DAYS*DAY).run();
   const session=await db.prepare('SELECT revoked,account_id FROM sessions WHERE hash=?').bind(row.session_hash).first<{revoked:number;account_id:string}>();if(session?.revoked!==0||session.account_id!==row.verified_id)throw new ApiError(410,'session_revoked');return json({linked:true,accountId:row.verified_id});
  }
  if(path==='/v1/catalog'&&request.method==='GET')return json((await db.prepare('SELECT id,name,description,art,price,COALESCE(\'png:\'||png_image,image) image FROM badges WHERE available=1 AND is_deleted=0 ORDER BY price,id').all<EcoBadge>()).results.map(b=>!pngSupport&&b.image?.startsWith('png:')?{...b,image:undefined}:b));
  if(path==='/v1/badges/lookup'&&request.method==='POST'){
   const b=await body(request);fields(b,['ids','supporter']);if(b.supporter!==undefined&&typeof b.supporter!=='boolean')throw new ApiError(400,'invalid_input');const ids=ecoIds(b.ids),result:Record<string,unknown[]>={};for(const id of ids)result[id]=[];
   if(ids.length){const placeholders=ids.map(()=>'?').join(',');const rows=await db.prepare(`SELECT o.account_id,b.id,b.name,b.description,b.art,b.price,COALESCE('png:'||b.png_image,b.image) image FROM owned_badges o JOIN badges b ON b.id=o.badge_id WHERE o.active=1 AND b.is_deleted=0 AND o.account_id IN (${placeholders}) ORDER BY b.id`).bind(...ids).all<Record<string,unknown>>();for(const row of rows.results){const {account_id,...badge}=row;if(!pngSupport&&b.supporter!==true&&typeof badge.image==='string'&&badge.image.startsWith('png:'))delete badge.image;result[String(account_id)]?.push(badge);}}
   if(b.supporter===true){const supporter=await publicSupporterBadges(db,ids);for(const id of ids)result[id].push(...(supporter[id]??[]));}return json(result);
  }
  const user=await account(db,request,now);
  if(path==='/v1/me/supporter'||path.startsWith('/v1/me/custom-badges'))return await supporterRoutes(request,env,db,user.id,now);
  if(path.startsWith('/v1/drop/'))return await dropRoutes(request,db,user.id,now,user.hash);
  if(path==='/v1/me'&&request.method==='GET')return json(await profile(db,user.id,pngSupport));
  if(path==='/v1/me/session'&&request.method==='DELETE'){await db.prepare('UPDATE sessions SET revoked=1 WHERE hash=?').bind(user.hash).run();return json({revoked:true});}
  if(path==='/v1/me/purchases'&&request.method==='POST'){
   const b=await body(request);fields(b,['badgeId','idempotencyKey','expectedPrice']);const badge=ecoBadgeId(b.badgeId),key=ecoKey(b.idempotencyKey),price=ecoPrice(b.expectedPrice);
   const previous=await db.prepare('SELECT badge_id,price FROM purchases WHERE account_id=? AND request_key=?').bind(user.id,key).first<{badge_id:string;price:number}>();
   if(previous){if(previous.badge_id!==badge||previous.price!==price)throw new ApiError(409,'idempotency_conflict');return json(await profile(db,user.id,pngSupport));}
   await db.prepare(`INSERT INTO purchases(id,account_id,badge_id,price,request_key,created_at) SELECT ?,?,id,price,?,? FROM badges WHERE id=? AND available=1 AND is_deleted=0 AND price=? AND NOT EXISTS(SELECT 1 FROM purchases WHERE account_id=? AND request_key=?)`).bind(crypto.randomUUID(),user.id,key,now,badge,price,user.id,key).run();
   const purchase=await db.prepare('SELECT badge_id,price FROM purchases WHERE account_id=? AND request_key=?').bind(user.id,key).first<{badge_id:string;price:number}>();if(!purchase){const item=await db.prepare('SELECT price FROM badges WHERE id=? AND available=1 AND is_deleted=0').bind(badge).first<{price:number}>();throw new ApiError(item?409:404,item?'price_changed':'badge_unavailable');}if(purchase.badge_id!==badge||purchase.price!==price)throw new ApiError(409,'idempotency_conflict');return json(await profile(db,user.id,pngSupport));
  }
  if(path==='/v1/me/badges'&&request.method==='PUT'){
   const b=await body(request);fields(b,['ids']);const ids=ecoActive(b.ids);for(const id of ids)if(!await db.prepare('SELECT o.badge_id FROM owned_badges o JOIN badges b ON b.id=o.badge_id WHERE o.account_id=? AND o.badge_id=? AND b.is_deleted=0').bind(user.id,id).first())throw new ApiError(403,'badge_not_owned');
   await db.batch([db.prepare('UPDATE owned_badges SET active=0 WHERE account_id=?').bind(user.id),...ids.map(id=>db.prepare('UPDATE owned_badges SET active=1 WHERE account_id=? AND badge_id=?').bind(user.id,id))]);return json(await profile(db,user.id,pngSupport));
  }
  if(path==='/v1/me/transactions'&&request.method==='GET'){
   const before=Number(url.searchParams.get('before')??Number.MAX_SAFE_INTEGER);if(!Number.isSafeInteger(before)||before<1)throw new ApiError(400,'invalid_cursor');
   const rows=(await db.prepare('SELECT id,delta,balance_after,reason,created_at FROM ledger WHERE account_id=? AND id<? ORDER BY id DESC LIMIT 51').bind(user.id,before).all<{id:number}>()).results;return json({entries:rows.slice(0,50),next:rows.length>50?rows[49]!.id:null});
  }
  throw new ApiError(404,'not_found');
 }catch(error){
  if(error instanceof ApiError)return json({error:error.code},error.status);
  const message=error instanceof Error?error.message:'';
  for(const code of ['insufficient_points','already_owned','badge_unavailable','active_badge_limit','invalid_reward','reward_already_granted'])if(message.includes(code))return json({error:code},409);
  if(/^supporter\.[A-Za-z]+$/.test(message))return json({error:message},400);
  if(message.startsWith('Invalid ')||message.startsWith('Too many ')||message.startsWith('Choose ')||message.startsWith('Duplicate '))return json({error:'invalid_input'},400);
  // No SQL, credentials, interaction body or user data in error responses/logs.
  return json({error:'service_unavailable'},503);
 }
}
export default {fetch:(request:Request,env:Env)=>handle(request,env),async scheduled(_event:unknown,env:Env):Promise<void>{const now=Date.now();await env.DB.batch([env.DB.prepare('DELETE FROM supporter_admin_sessions WHERE expires_at<?').bind(now),...(env.ADMIN_DISCORD_IDS?[env.DB.prepare('DELETE FROM admin_challenges WHERE expires_at<?').bind(now),env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at<?').bind(now)]:[]),env.DB.prepare('DELETE FROM drop_presence WHERE expires<?').bind(now),env.DB.prepare('DELETE FROM drop_invites WHERE expires<?').bind(now-3600000),env.DB.prepare('DELETE FROM challenges WHERE expires_at<?').bind(now),env.DB.prepare('DELETE FROM request_limits WHERE expires_at<?').bind(now),env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(now-7*DAY)]);}};
