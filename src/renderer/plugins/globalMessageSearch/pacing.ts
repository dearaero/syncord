import {header,recoveryWait,type RestResponse} from '../messageCleaner/engine';
export type WaitKind='quota'|'rate'|'pacing'|'indexing'|'retry';
export type Deadline={at:number;kind:WaitKind};
type Resource={until:number;kind:WaitKind;bucket?:string};
const GRACE=50,INITIAL_INTERVAL=1000;
function object(value:unknown):Record<string,unknown>{return value!==null&&typeof value==='object'?value as Record<string,unknown>:{};}
function number(value:string|undefined):number|undefined{if(value===undefined||!value.trim())return;const n=Number(value);return Number.isFinite(n)&&n>=0?n:undefined;}
/** Relative resets avoid local clock skew. Absolute resets use Discord's Date. */
export function resetAfter(r:RestResponse,now:number):number|undefined{
 const relative=number(header(r.headers,'x-ratelimit-reset-after'));if(relative!==undefined&&Number.isFinite(relative*1000))return relative*1000;
 const epoch=number(header(r.headers,'x-ratelimit-reset'));if(epoch===undefined||!Number.isFinite(epoch*1000))return;
 const date=Date.parse(header(r.headers,'date')??'');return Math.max(0,epoch*1000-(Number.isFinite(date)?date:now));
}
export class SearchPacing{
 private globalUntil=0;private accountUntil=0;private accountKind:WaitKind='rate';
 private resources=new Map<string,Resource>();private resourceBuckets=new Map<string,string>();private lastStart:number|undefined;
 private quota?:{spacing:number};private learned=0;private successes:number[]=[];private recoverySample?:{first:number;count:number};
 interval(_now:number):number{return Math.max(200,this.learned,this.quota?this.quota.spacing:INITIAL_INTERVAL);}
 ready(guildId:string,now:number):Deadline{
  const budget=!!this.quota&&this.learned<=this.quota.spacing;let result:Deadline={at:this.lastStart===undefined?now:this.lastStart+this.interval(now),kind:budget?'quota':'pacing'};
  if(this.accountUntil>result.at)result={at:this.accountUntil,kind:this.accountKind};
  if(this.globalUntil>result.at)result={at:this.globalUntil,kind:'rate'};
  const resource=this.resources.get(guildId);if(resource&&resource.until>result.at)result={at:resource.until,kind:resource.kind};return result;
 }
 launched(now:number):void{
  // User think-time and a completely idle search are not evidence of a slow API.
  if(this.lastStart!==undefined&&now-this.lastStart>Math.max(10000,this.interval(now)*3)&&now>Math.max(this.accountUntil,this.globalUntil)+Math.max(1000,this.interval(now))){this.successes=[];this.recoverySample=undefined;}
  this.lastStart=now;
 }
 hold(guildId:string,until:number,kind:WaitKind):void{
  const resource=this.resources.get(guildId);if(!resource||until>resource.until)this.resources.set(guildId,{...resource,until,kind});
 }
 observe(guildId:string,r:RestResponse,now:number,streak:number):{rateLimited:boolean;resourceOnly:boolean}{
  const scope=header(r.headers,'x-ratelimit-scope')?.toLowerCase(),bucket=header(r.headers,'x-ratelimit-bucket'),body=object(r.body);
  const global=body.global===true||header(r.headers,'x-ratelimit-global')?.toLowerCase()==='true'||scope==='global';
  if(global||scope!==undefined&&scope!=='shared')this.resourceBuckets.delete(guildId);
  const shared=!global&&(scope==='shared'||scope===undefined&&!!bucket&&this.resourceBuckets.get(guildId)===bucket);
  if(shared&&bucket){this.resourceBuckets.delete(guildId);this.resourceBuckets.set(guildId,bucket);if(this.resourceBuckets.size>1024)this.resourceBuckets.delete(this.resourceBuckets.keys().next().value!);}
  const reset=resetAfter(r,now),remaining=number(header(r.headers,'x-ratelimit-remaining'));
  if(r.status===429){
   const delay=recoveryWait(r,streak,now).delay,until=now+delay;
   if(global){this.globalUntil=Math.max(this.globalUntil,until);this.successes=[];this.recoverySample=undefined;}
   else if(shared){this.successes=[];this.recoverySample=undefined;this.hold(guildId,until,'rate');const res=this.resources.get(guildId);if(res)res.bucket=bucket;}
   else{
    if(until>=this.accountUntil){this.accountUntil=until;this.accountKind='rate';}
    // Estimate successful work per observed window, not a multiplicative penalty
    // per error. An isolated first-request/global/resource 429 cannot poison pace.
    if(this.successes.length>=2)this.recoverySample={first:this.successes[0]!,count:this.successes.length};
    if(this.recoverySample){const candidate=(until-this.recoverySample.first)/this.recoverySample.count;if(Number.isFinite(candidate))this.learned=Math.max(this.learned,candidate);}
    this.successes=[];
   }
   return{rateLimited:true,resourceOnly:shared};
  }
  if(r.status!==undefined&&r.status>=200&&r.status<300){
   this.recoverySample=undefined;
   if(this.lastStart!==undefined)this.successes.push(this.lastStart);if(this.successes.length>64)this.successes.shift();
   if(!shared&&(reset===undefined||remaining===undefined))this.quota=undefined;
   if(reset!==undefined&&remaining!==undefined&&Number.isSafeInteger(remaining)){
    if(shared){if(remaining===0)this.hold(guildId,now+reset+GRACE,'quota');}
    else{
     // Spread the remaining permitted requests over the rest of this window.
     // Keep one slot of timing headroom at the end, instead of running it dry.
     this.quota={spacing:Math.max(200,reset/(remaining+1))};
     if(remaining===0&&now+reset+GRACE>=this.accountUntil){this.accountUntil=now+reset+GRACE;this.accountKind='quota';}
    }
   }
  }
  // Discard expired resource holds. Keep only active native cooldowns; no cache
  // of query contents or per-message data is retained by this scheduler.
  for(const[id,value]of this.resources)if(value.until<=now)this.resources.delete(id);
  return{rateLimited:false,resourceOnly:shared};
 }
}
