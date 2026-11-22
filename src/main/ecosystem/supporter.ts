import {ecoAccount,ecoKey,ecoActive,ecoBadgeImage} from '../../shared/ecosystem';
import {SUPPORTER_IPC,CUSTOM_BADGE_STATES,supporterTier,badgeRevision,customBadgeId,badgeInput,badgeBytes,badgeText,type CustomBadge,type SupporterStatus} from '../../shared/supporter';
type Transport={invalidate:(id:string)=>void;user:(id:string,path:string,method?:string,body?:unknown,headers?:Record<string,string>,image?:boolean)=>Promise<unknown>};
const obj=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('supporter.invalid');return v as Record<string,unknown>;};
const bool=(v:unknown):boolean=>{if(typeof v!=='boolean')throw Error('supporter.invalid');return v;};
const integer=(v:unknown,min=0):number=>{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<min||v>Number.MAX_SAFE_INTEGER)throw Error('supporter.invalid');return v;};
function readBadge(value:unknown):CustomBadge{const r=obj(value),input=badgeInput({name:r.name,description:r.description});if(!CUSTOM_BADGE_STATES.includes(r.status as CustomBadge['status']))throw Error('supporter.invalid');const image=ecoBadgeImage(r.image);if(image&&!image.startsWith('png:'))throw Error('supporter.invalid');return{id:customBadgeId(r.id),accountId:ecoAccount(r.accountId),...input,status:r.status as CustomBadge['status'],active:bool(r.active),...(image?{image}:{}),revision:badgeRevision(r.revision),createdAt:integer(r.createdAt),submittedAt:r.submittedAt===null?null:integer(r.submittedAt),reason:badgeText(r.reason,160)};}
export function readSupporterStatus(value:unknown,owner?:string):SupporterStatus{
 const r=obj(value);if(!Array.isArray(r.badges)||r.badges.length>3)throw Error('supporter.invalid');const badges=r.badges.map(readBadge);if(owner&&badges.some(b=>b.accountId!==owner))throw Error('supporter.invalid');
 const slotsUsed=integer(r.slotsUsed);if(slotsUsed!==badges.length)throw Error('supporter.invalid');return{tier:supporterTier(r.tier),suspended:bool(r.suspended),revision:integer(r.revision),slotsUsed,uploadConfigured:bool(r.uploadConfigured),badges};
}
export function createSupporterScope(t:Transport):{handlers:Record<string,(...args:unknown[])=>unknown>;dispose:()=>void}{
 let uploading=false;
 const mutation=(v:unknown):{id:string;revision:number;key:string}=>{const r=obj(v);return{id:customBadgeId(r.id),revision:badgeRevision(r.revision),key:ecoKey(r.key)};};
 const status=async(account:unknown):Promise<SupporterStatus>=>{const id=ecoAccount(account);return readSupporterStatus(await t.user(id,'/v1/me/supporter'),id);};
 const change=async(account:unknown,value:unknown,operation:'edit'|'submit'|'delete',input?:unknown):Promise<SupporterStatus>=>{const id=ecoAccount(account),m=mutation(value);const result=await t.user(id,'/v1/me/custom-badges/'+m.id+(operation==='submit'?'/submit':''),operation==='delete'?'DELETE':operation==='edit'?'PUT':'POST',{revision:m.revision,key:m.key,...(operation==='edit'?{input:badgeInput(input)}:{})});t.invalidate(id);return readSupporterStatus(result,id);};
 const handlers:Record<string,(...args:unknown[])=>unknown>={
  [SUPPORTER_IPC.STATUS]:status,
  [SUPPORTER_IPC.CREATE]:async(account,input,key)=>{const id=ecoAccount(account);return readSupporterStatus(await t.user(id,'/v1/me/custom-badges','POST',{input:badgeInput(input),key:ecoKey(key)}),id);},
  [SUPPORTER_IPC.EDIT]:(account,m,input)=>change(account,m,'edit',input),
  [SUPPORTER_IPC.SUBMIT]:(account,m)=>change(account,m,'submit'),
  [SUPPORTER_IPC.DELETE]:(account,m)=>change(account,m,'delete'),
  [SUPPORTER_IPC.UPLOAD]:async(account,value,input)=>{const id=ecoAccount(account),m=mutation(value),bytes=badgeBytes(input);if(uploading)throw Error('supporter.rate');uploading=true;try{const result=await t.user(id,'/v1/me/custom-badges/'+m.id+'/image','POST',bytes,{'idempotency-key':m.key,'x-badge-revision':String(m.revision)});t.invalidate(id);return readSupporterStatus(result,id);}finally{uploading=false;}},
  [SUPPORTER_IPC.ACTIVE]:async(account,value,key)=>{const id=ecoAccount(account),ids=ecoActive(value);ids.forEach(customBadgeId);const result=await t.user(id,'/v1/me/custom-badges/active','PUT',{ids,key:ecoKey(key)});t.invalidate(id);return readSupporterStatus(result,id);},
  [SUPPORTER_IPC.PREVIEW]:async(account,id)=>t.user(ecoAccount(account),'/v1/me/custom-badges/'+customBadgeId(id)+'/image','GET',undefined,undefined,true),
 };
 return{handlers,dispose:()=>{}};
}
