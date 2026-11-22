import type {IdentitySnapshot} from '../../api/platformIdentity';
import {platformIndicators,type PresenceStatus} from '../../api/discordEvents/presence';
export const SPOOFER_ID='platform-spoofer';
export const PLATFORMS=['desktop','mobile','web','vr','console'] as const;
export type Platform=typeof PLATFORMS[number];
export type Evidence={status:PresenceStatus;source:'presence'|'session'};
export type Observation={visibility:string;available:boolean;evidence:Partial<Record<Platform,Evidence>>};
export type Snapshot=Observation&{running:boolean;account?:string;selected:Platform[];saving:boolean;result:''|'saved'|'restored'|'failed';identity?:IdentitySnapshot};
export const accountId=(v:unknown):v is string=>typeof v==='string'&&/^\d{17,20}$/.test(v);
export const record=(v:unknown):Record<string,unknown>|undefined=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:undefined;
export const active=(v:unknown):v is PresenceStatus=>v==='online'||v==='idle'||v==='dnd';
export function selection(value:unknown):Platform[]{
 if(!Array.isArray(value)||value.length>32||value.some(v=>!PLATFORMS.includes(v)))throw Error('ps.invalid');
 return PLATFORMS.filter(v=>value.includes(v));
}
export function preferences(value:unknown,account:string):Platform[]{
 try{return selection(record(record(value)?.[account])?.selectedPlatforms??[]);}catch{return [];}
}
/** Never infer a login from a game's platform, OS name, or a local requested choice. */
export function observe(status:unknown,clients:unknown,sessions:unknown):Observation{
 const visibility=typeof status==='string'&&['online','idle','dnd','offline','invisible'].includes(status)?status:'unknown';
 const evidence:Observation['evidence']={};
 if(visibility==='offline'||visibility==='invisible')return{visibility,available:true,evidence};
 const native=record(clients);
 for(const row of platformIndicators(undefined,native,undefined,false)){
  if(row.icon==='other'||!PLATFORMS.includes(row.icon))continue;
  evidence[row.icon]={status:row.status,source:'presence'};
 }
 const sessionRows=Array.isArray(sessions)?Object.fromEntries(sessions.slice(0,64).map((v,i)=>[String(i),v])):record(sessions);
 if(sessionRows)for(const key of Object.keys(sessionRows).slice(0,64)){
  try{
   const row=record(sessionRows[key]),client=record(row?.clientInfo)?.client;
   // Invisible session metadata must never turn into an online claim.
   if(row?.status==='invisible')return{visibility:'invisible',available:true,evidence:{}};
   const platform=client==='embedded'?'console':client;
   if(typeof platform!=='string'||!PLATFORMS.includes(platform as Platform)||!active(row?.status))continue;
   const p=platform as Platform,old=evidence[p];
   if(old?.source==='presence')continue;
   const rank={online:3,dnd:2,idle:1};
   if(!old||rank[row.status]>rank[old.status])evidence[p]={status:row.status,source:'session'};
  }catch{/* A changed or throwing session entry grants no evidence. */}
 }
 return{visibility,available:!!native||!!sessionRows,evidence};
}
export function rowState(observation:Observation,platform:Platform):'reported'|'verification'|'requiresSession'|'unsupported'{
 const value=observation.evidence[platform];
 if(value)return value.source==='presence'&&active(observation.visibility)?'reported':'verification';
 return platform==='vr'||platform==='console'?'unsupported':'requiresSession';
}
