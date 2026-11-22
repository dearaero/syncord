import {createSupporterScope} from './supporter';
import {openExternal} from "../security/navigation";
import crypto from 'node:crypto';
import {safeStorage} from 'electron';
import {ECO_IPC,OFFICIAL_BADGE_REFRESH_MS,MAX_BADGE_SVG_BYTES,badgeImagePath,ecoImage,ecoBadgeImage,ecoAccount,ecoActive,ecoBadgeId,ecoIds,ecoKey,ecoPrice,BADGE_ART,type EcoBadge,type EcoProfile,type EcoLookup,type EcoHistory,type EcoStatus,type EcoLink} from '../../shared/ecosystem';
import {loadSecret,storeSecret,deleteSecret,encryptionAvailable} from '../security/safeStorage';
import {isSafeMode,isLockdown} from '../security/modes';
import {isNetworkLockedDown} from '../security/networkBroker';
declare const __SYNCORD_ECOSYSTEM_ORIGIN__:string;
const origin=typeof __SYNCORD_ECOSYSTEM_ORIGIN__==='string'?__SYNCORD_ECOSYSTEM_ORIGIN__:'';
const pending=new Map<string,{poll:string;session:string;expires:number}>();
let publicRevision=0;
const publicCache=new Map<string,{until:number;badges:EcoBadge[]}>();
const secureStorage=():boolean=>encryptionAvailable()&&(process.platform!=='linux'||['gnome_libsecret','kwallet','kwallet5','kwallet6'].includes(safeStorage.getSelectedStorageBackend?.()??''));
const secretName=(id:string):string=>'ecosystem-'+id;
const hash=(s:string):string=>crypto.createHash('sha256').update(s).digest('hex');
const secret=():string=>crypto.randomBytes(32).toString('hex');
function configured():boolean{try{const u=new URL(origin);return u.protocol==='https:'&&u.origin===origin&&!u.username&&!u.password&&u.port===''&&/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(u.hostname)&&!/(?:^|\.)(localhost|local|internal|test|invalid)$/.test(u.hostname);}catch{return false;}}
function allowed():void{if(!configured())throw Error('Syncord Ecosystem is not connected to an official API yet.');if(isSafeMode()||isLockdown()||isNetworkLockedDown())throw Error('Ecosystem network access is disabled by Security settings.');}
const record=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Invalid Ecosystem response.');return v as Record<string,unknown>;};
const string=(v:unknown,max:number):string=>{if(typeof v!=='string'||v.length>max)throw Error('Invalid Ecosystem response.');return v;};
const integer=(v:unknown,max=9000000000000):number=>{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0||v>max)throw Error('Invalid Ecosystem response.');return v;};
function badge(value:unknown):EcoBadge{const r=record(value);if(!BADGE_ART.includes(r.art as EcoBadge['art']))throw Error('Invalid Ecosystem badge.');return{id:ecoBadgeId(r.id),name:string(r.name,80),description:string(r.description,500),art:r.art as EcoBadge['art'],price:integer(r.price,1000000),...(ecoBadgeImage(r.image)?{image:ecoBadgeImage(r.image)}:{})};}
function readProfile(value:unknown,expected:string):EcoProfile{const r=record(value);if(r.id!==expected||!Array.isArray(r.badges)||r.badges.length>512)throw Error('Ecosystem account mismatch.');return{id:expected,username:string(r.username,80),avatar:r.avatar===null?null:string(r.avatar,40),balance:integer(r.balance),badges:r.badges.map(v=>{const b=record(v);if(typeof b.active!=='boolean')throw Error('Invalid badge state.');return{...badge(v),active:b.active};})};}
async function request(path:string,method='GET',body?:unknown,credential?:string,extraHeaders?:Record<string,string>,asImage=false):Promise<unknown>{
 allowed();const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
 try{
  const response=await fetch(origin+path,{method,redirect:'error',credentials:'omit',signal:controller.signal,headers:{accept:'application/json','x-syncord-badge-formats':'png',...(body===undefined?{}:{'content-type':body instanceof Uint8Array?'application/octet-stream':'application/json'}),...(credential?{authorization:'Bearer '+credential}:{}),...extraHeaders},...(body===undefined?{}:{body:body instanceof Uint8Array?body.slice():JSON.stringify(body)})});
  const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
  if(reader)try{for(;;){const row=await reader.read();if(row.done)break;size+=row.value.byteLength;if(size>(asImage?65536:path==='/v1/badges/lookup'?524288:262144)){await reader.cancel();throw Error('Ecosystem response is too large.');}chunks.push(row.value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  if(asImage&&response.ok){if(response.headers.get('content-type')?.split(';')[0]!=='image/png'||size>65536||size<33||new DataView(bytes.buffer).getUint32(0)!==0x89504e47||!/^([a-f0-9]{64})$/.test(response.headers.get('x-syncord-badge-hash')??'')||crypto.createHash('sha256').update(bytes).digest('hex')!==response.headers.get('x-syncord-badge-hash'))throw Error('supporter.invalidImage');allowed();return 'data:image/png;base64,'+Buffer.from(bytes).toString('base64');}
  let result:unknown;try{result=JSON.parse(new TextDecoder().decode(bytes));}catch{throw Error('Ecosystem returned an invalid response.');}
  if(!response.ok){const code=typeof record(result).error==='string'?String(record(result).error):'';const error=new Error((/^(?:drop\.[a-z_]+|supporter\.[A-Za-z]+)$/.test(code)?code:undefined)??({insufficient_points:'Not enough Syncord Points.',already_owned:'You already own this badge.',badge_not_owned:'You do not own this badge.',idempotency_conflict:'This purchase request was already used for a different badge.',price_changed:'The badge price changed. Refresh the store and confirm again.',verification_unconfigured:'Discord verification is not configured on the Ecosystem service yet.',verification_failed:'Discord verification failed. Start again and authorize the matching account.',rate_limited:'Ecosystem is busy. Wait a moment and try again.',link_expired:'The link code expired. Generate a new one.',authentication_required:'Link this Discord account first.',session_expired:'Your Ecosystem session expired. Link this Discord account again.'} as Record<string,string>)[code]??'The Ecosystem request failed. Please retry.');Object.assign(error,{status:response.status});throw error;}
  allowed();return result;
 }finally{clearTimeout(timer);}
}
async function authenticated(id:string,path:string,method='GET',body?:unknown,headers?:Record<string,string>,asImage=false):Promise<unknown>{
 const credential=loadSecret(secretName(id));if(!credential||!/^[a-f0-9]{64}$/.test(credential))throw Error('Link this Discord account first.');
 try{return await request(path,method,body,credential,headers,asImage);}catch(error){if((error as {status?:number}).status===401&&loadSecret(secretName(id))===credential)deleteSecret(secretName(id));throw error;}
}
export function ecosystemStatus(account:unknown):EcoStatus{const id=ecoAccount(account),entry=pending.get(id);if(entry&&entry.expires<=Date.now())pending.delete(id);return{configured:configured(),encryptedStorage:secureStorage(),linked:/^[a-f0-9]{64}$/.test(loadSecret(secretName(id))??''),...(entry&&entry.expires>Date.now()?{pendingUntil:entry.expires}:{})};}
export async function ecosystemLink(account:unknown):Promise<EcoLink>{
 const id=ecoAccount(account);allowed();if(!secureStorage())throw Error('Secure OS storage is unavailable. Ecosystem cannot save a session in plaintext.');
 const now=Date.now();for(const [key,value]of pending)if(value.expires<=now)pending.delete(key);
 if(pending.size>=8&&!pending.has(id))throw Error('Too many pending account links.');
 const entry={poll:secret(),session:secret(),expires:now+600000};
 pending.set(id,entry);
 try{const response=record(await request('/v1/auth/challenge','POST',{accountId:id,pollToken:entry.poll,sessionHash:hash(entry.session)}));
 if(pending.get(id)!==entry)throw Error('Account verification was superseded.');entry.expires=integer(response.expiresAt,Number.MAX_SAFE_INTEGER);if(entry.expires<=now||entry.expires>now+610000)throw Error('Invalid authorization expiry.');if(typeof response.state!=='string'||!/^[a-f0-9]{64}$/.test(response.state))throw Error('Invalid Discord authorization state.');pending.set(id,entry);if(!await openExternal(origin+'/oauth/start?state='+response.state)){pending.delete(id);throw Error('Could not open Discord authorization in your browser.');}return{expiresAt:entry.expires};}catch(error){if(pending.get(id)===entry)pending.delete(id);throw error;}
}
export async function ecosystemPoll(account:unknown):Promise<{linked:boolean}>{
 const id=ecoAccount(account),entry=pending.get(id);if(!entry||entry.expires<Date.now())throw Error('The link code expired. Generate a new one.');
 const result=record(await request('/v1/auth/poll','POST',{pollToken:entry.poll}));if(result.linked===false)return{linked:false};if(result.linked!==true)throw Error('Invalid verification status.');
 if(result.accountId!==id||pending.get(id)!==entry)throw Error('Account changed while linking.');
 if(!storeSecret(secretName(id),entry.session))throw Error('Could not save the encrypted Ecosystem session.');pending.delete(id);return{linked:true};
}
export async function ecosystemProfile(account:unknown):Promise<EcoProfile>{const id=ecoAccount(account);return readProfile(await authenticated(id,'/v1/me'),id);}
const artworkCache=new Map<string,string>();
const artworkPending=new Map<string,Promise<string>>();
let artworkLane:Promise<unknown>=Promise.resolve();
/** Public immutable artwork only: no caller-selected URL, headers or credentials. */
export async function ecosystemArt(input:unknown):Promise<string>{
 const image=ecoBadgeImage(input);if(!image)throw Error('Invalid badge image.');allowed();
 const cached=artworkCache.get(image);if(cached)return cached;
 const pending=artworkPending.get(image);if(pending)return pending;
 if(artworkPending.size>=128)throw Error('Too many pending badge images.');
 const work=artworkLane.then(async()=>{
  allowed();const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{
   const png=image.startsWith('png:'),mime=png?'image/png':'image/svg+xml';
   const response=await fetch(origin+badgeImagePath(image),{method:'GET',credentials:'omit',redirect:'error',signal:controller.signal,headers:{accept:mime}});
   if(!response.ok||response.headers.get('content-type')?.split(';')[0]?.trim()!==mime){await response.body?.cancel();throw Error('Invalid badge image response.');}
   const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
   if(reader)try{for(;;){const row=await reader.read();if(row.done)break;size+=row.value.byteLength;if(size>(png?65536:MAX_BADGE_SVG_BYTES)){await reader.cancel();throw Error('Badge image is too large.');}chunks.push(row.value);}}finally{reader.releaseLock();}
   const bytes=Buffer.concat(chunks,size);
   if(!size||crypto.createHash('sha256').update(bytes).digest('hex')!==(png?image.slice(4):image))throw Error('Badge image hash mismatch.');
   if(!png)new TextDecoder('utf-8',{fatal:true}).decode(bytes);allowed();
   const data='data:'+mime+';base64,'+bytes.toString('base64');artworkCache.set(image,data);
   while(artworkCache.size>64){const oldest=artworkCache.keys().next();if(oldest.done)break;artworkCache.delete(oldest.value);}
   return data;
  }finally{clearTimeout(timer);}
 });
 artworkPending.set(image,work);artworkLane=work.catch(()=>{});
 try{return await work;}finally{artworkPending.delete(image);}
}
export async function ecosystemCatalog():Promise<EcoBadge[]>{const value=await request('/v1/catalog');if(!Array.isArray(value)||value.length>512)throw Error('Invalid badge catalog.');return value.map(badge);}
export async function ecosystemBuy(account:unknown,badgeId:unknown,key:unknown,expectedPrice:unknown):Promise<EcoProfile>{const id=ecoAccount(account);return readProfile(await authenticated(id,'/v1/me/purchases','POST',{badgeId:ecoBadgeId(badgeId),idempotencyKey:ecoKey(key),expectedPrice:ecoPrice(expectedPrice)}),id);}
export async function ecosystemActivate(account:unknown,ids:unknown):Promise<EcoProfile>{const id=ecoAccount(account),value=readProfile(await authenticated(id,'/v1/me/badges','PUT',{ids:ecoActive(ids)}),id);publicRevision++;publicCache.delete(id);return value;}
export async function ecosystemHistory(account:unknown,before:unknown):Promise<EcoHistory>{
 const id=ecoAccount(account);if(before!==undefined)integer(before,Number.MAX_SAFE_INTEGER);
 const r=record(await authenticated(id,'/v1/me/transactions'+(before===undefined?'':'?before='+before)));if(!Array.isArray(r.entries)||r.entries.length>50)throw Error('Invalid transaction history.');
 return{entries:r.entries.map(value=>{const e=record(value);if(typeof e.delta!=='number'||!Number.isSafeInteger(e.delta)||!e.delta)throw Error('Invalid transaction amount.');return{id:integer(e.id,Number.MAX_SAFE_INTEGER),delta:e.delta,balance_after:integer(e.balance_after),reason:string(e.reason,200),created_at:integer(e.created_at,Number.MAX_SAFE_INTEGER)};}),next:r.next===null?null:integer(r.next,Number.MAX_SAFE_INTEGER)};
}
export async function ecosystemLookup(input:unknown):Promise<EcoLookup>{
 const ids=ecoIds(input),result:EcoLookup={},missing:string[]=[];if(!configured())return result;
 for(const id of ids){const entry=publicCache.get(id);if(entry&&entry.until>Date.now())result[id]=entry.badges;else missing.push(id);}
 if(missing.length){const revision=publicRevision,response=record(await request('/v1/badges/lookup','POST',{ids:missing,supporter:true}));for(const id of missing){const raw=response[id];if(!Array.isArray(raw)||raw.length>7)throw Error('Invalid official badges.');const badges=raw.map(badge);result[id]=badges;publicCache.delete(id);if(revision===publicRevision)publicCache.set(id,{until:Date.now()+OFFICIAL_BADGE_REFRESH_MS,badges});}while(publicCache.size>512){const oldest=publicCache.keys().next();if(oldest.done)break;publicCache.delete(oldest.value);}}
 return result;
}
export async function ecosystemDisconnect(account:unknown):Promise<void>{const id=ecoAccount(account);pending.delete(id);try{if(loadSecret(secretName(id)))await authenticated(id,'/v1/me/session','DELETE');}finally{deleteSecret(secretName(id));publicRevision++;publicCache.delete(id);}}
export const ecosystemHandlers:Record<string,(...args:unknown[])=>unknown>={
 [ECO_IPC.STATUS]:ecosystemStatus,[ECO_IPC.LINK]:ecosystemLink,[ECO_IPC.POLL]:ecosystemPoll,[ECO_IPC.PROFILE]:ecosystemProfile,[ECO_IPC.CATALOG]:ecosystemCatalog,[ECO_IPC.ART]:ecosystemArt,[ECO_IPC.BUY]:ecosystemBuy,[ECO_IPC.ACTIVE]:ecosystemActivate,[ECO_IPC.HISTORY]:ecosystemHistory,[ECO_IPC.LOOKUP]:ecosystemLookup,[ECO_IPC.DISCONNECT]:ecosystemDisconnect
};

/** Feature-specific authenticated signaling, not a generic renderer HTTP path. */
export async function ecosystemDrop(account:string,id:string|undefined,action:'invite'|'inbox'|'view'|'accept'|'decline'|'cancel'|'offer'|'answer'|'connected',body?:unknown):Promise<unknown>{
 const {dropId}=await import('../../shared/drop');
 const actor=ecoAccount(account);
 const route=action==='inbox'?'/v1/drop/inbox':action==='invite'?'/v1/drop/invites':'/v1/drop/'+dropId(id)+(action==='view'?'':'/'+action);
 if(!/^[a-f0-9]{64}$/.test(loadSecret(secretName(actor))??''))throw Error('drop.link_required');
 try{
  // One public preflight per invitation, never per file block or setup poll.
  // Older Workers can verify Ecosystem accounts but have no Drop endpoints.
  // Do not submit filenames/recipient metadata to an unready deployment.
  if(action==='invite'){
   const health=record(await request('/health'));
   const features=health.features;
   if(!features||typeof features!=='object'||Array.isArray(features)||(features as Record<string,unknown>).drop!==1||(features as Record<string,unknown>).dropInbox!==1||(features as Record<string,unknown>).dropPresence!==1)throw Error('drop.unavailable');
  }
  return await authenticated(actor,route,action==='view'||action==='inbox'&&body===undefined?'GET':'POST',body);
 }catch(error){
  if(error instanceof Error&&/^drop\.[a-z_]+$/.test(error.message))throw error;
  const status=(error as {status?:number}|null)?.status;
  if(status===401)throw Error('drop.link_required');
  if(status===429)throw Error('drop.rate');
  if(status===404||typeof status==='number'&&status>=500)throw Error('drop.unavailable');
  throw error;
 }
}

/** Owner-only Supporter operations; administrators use the authenticated web panel. */
export function createEcosystemSupporterScope():ReturnType<typeof createSupporterScope>{return createSupporterScope({user:authenticated,invalidate:id=>{publicRevision++;if(id)publicCache.delete(id);else publicCache.clear();}});}
