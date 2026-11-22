import {abortableSleep,header,recoveryWait,type RestResponse} from '../messageCleaner/engine';
import {CloneError,object,type Snapshot,type Issue,type Overwrite} from './model';
import {createdId,type ClonePort} from './actions';
import {verify,type Result} from './verify';
export type Phase='ready'|'running'|'waiting'|'stopping'|'verifying'|'partial'|'failed'|'cancelled';
export type Progress={phase:Phase;roles:number;categories:number;channels:number;item:string;issues:Issue[];result?:Result};
let leased=false;
const response=(v:unknown):RestResponse=>{const e=object(v)?v:{},r=object(e.response)?e.response:{};return{status:Number(e.status??e.statusCode??e.httpStatus??r.status)||undefined,body:e.body??r.body,headers:e.headers??r.headers,retryAfter:e.retryAfter??r.retryAfter};};
const VIEW=1024n;
function privateRows(rows:readonly Overwrite[],everyone:string):Overwrite[]{
 const existing=rows.find(r=>r.id===everyone&&r.type===0),rest=rows.filter(r=>r.id!==everyone||r.type!==0);
 return [...rest,{id:everyone,type:0,allow:(BigInt(existing?.allow??'0')&~VIEW).toString(),deny:(BigInt(existing?.deny??'0')|VIEW).toString()}];
}
export class CloneEngine {
 private controller:AbortController|undefined;
 private until=0;
 private interval=500;
 private state:Progress={phase:'ready',roles:0,categories:0,channels:0,item:'',issues:[]};
 constructor(private source:Snapshot,private target:string,private port:ClonePort,private changed:(state:Progress)=>void,private sleep=abortableSleep,private now=Date.now){}
 snapshot():Progress{return{...this.state,issues:[...this.state.issues]};}
 active():boolean{return!!this.controller;}
 stop():void{if(this.controller){this.controller.abort();this.emit({phase:'stopping'});}}
 private emit(patch:Partial<Progress>):void{Object.assign(this.state,patch);this.changed(this.snapshot());}
 async run():Promise<void>{
  if(this.controller||leased)throw new CloneError('busy');this.port.check();leased=true;
  const controller=new AbortController();this.controller=controller;
  const roleIds=new Map<string,string>([[this.source.id,this.target]]),channelIds=new Map<string,string>();
  const check=():void=>{if(controller.signal.aborted)throw new DOMException('Stopped','AbortError');this.port.check();};
  const issue=(code:Issue['code'],item:string):void=>{this.state.issues.push({code,item});};
  const request=async(call:()=>Promise<unknown>):Promise<unknown>=>{
   for(let attempt=0;;attempt++){
    check();const until=Math.max(this.until,this.port.cooldown?.until??0);if(until>this.now()){this.emit({phase:'waiting'});await this.sleep(until-this.now(),controller.signal);check();}
    this.emit({phase:'running'});let value:unknown;const started=this.now();
    try{value=await call();const r=response(value);if(r.status!==undefined&&r.status>=400)throw value;
     // Pace request starts, rather than adding an idle delay after network time.
     // Native Discord actions retain their own route queue. When headers are
     // available, spread the remaining bucket budget instead of bursting it.
     this.until=started+this.interval;
     const remaining=header(r.headers,'x-ratelimit-remaining'),reset=header(r.headers,'x-ratelimit-reset-after');
     if(remaining?.trim()&&reset?.trim()){
      const budget=Number(remaining),seconds=Number(reset);
      if(Number.isSafeInteger(budget)&&budget>0&&Number.isFinite(seconds)&&seconds>0)this.until=Math.max(this.until,this.now()+Math.ceil(seconds*1000/budget)+50);
     }
     if(header(r.headers,'x-ratelimit-remaining')==='0'){this.until=Math.max(this.until,this.now()+recoveryWait(r,1,this.now()).delay);if(this.port.cooldown)this.port.cooldown.until=Math.max(this.port.cooldown.until,this.until);}
     return value;
    }catch(error){const r=response(error);if(r.status!==429)throw error;this.interval=Math.min(2000,this.interval+250);
     this.until=Math.max(this.until,this.now()+recoveryWait(r,attempt+1,this.now()).delay);if(this.port.cooldown)this.port.cooldown.until=Math.max(this.port.cooldown.until,this.until);if(attempt>=2)throw error;
    }
   }
  };
  try{
   const baseline=this.port.snapshot(),sourceEveryone=this.source.roles.find(r=>r.id===this.source.id),targetEveryone=baseline.roles.find(r=>r.id===this.target);
   if(!sourceEveryone||!targetEveryone)throw new CloneError('invalid');
   const baseDiffers=sourceEveryone.permissions!==targetEveryone.permissions;
   if(baseDiffers)issue('permissions','@everyone');
   this.emit({phase:'running'});
   const roles=[...this.source.roles].filter(r=>r.id!==this.source.id).sort((a,b)=>a.position-b.position||a.id.localeCompare(b.id));
   for(const role of roles){check();this.emit({item:role.name});if(role.managed){issue('managed',role.name);continue;}
    const id=createdId(await request(()=>this.port.createRole(role)));roleIds.set(role.id,id);this.emit({roles:this.state.roles+1});
    check();await request(()=>this.port.updateRole(id,role));if(role.icon)issue('fields',role.name);
   }
   const ordered=roles.filter(r=>roleIds.has(r.id)).map((r,index)=>({id:roleIds.get(r.id)!,position:index+1}));
   if(ordered.length)await request(()=>this.port.orderRoles(ordered));
   const desired=[...this.source.channels].sort((a,b)=>(a.type===4?0:1)-(b.type===4?0:1)||a.position-b.position||a.id.localeCompare(b.id));
   const positions=new Map<number,number>();for(const c of baseline.channels)if(c.parent===null)positions.set(c.type,Math.max(positions.get(c.type)??0,c.position+1));
   const orderedChannels:{id:string;position:number}[]=[];
   for(const channel of desired){
    check();this.emit({item:channel.name});if(!this.port.supports(channel.type)){issue('unsupported',channel.name);continue;}
    const parent=channel.parent===null?null:channelIds.get(channel.parent);
    if(parent===undefined){issue('mapping',channel.name);continue;}
    let locked=baseDiffers,missing=false;const rows:Overwrite[]=[];
    for(const row of channel.overwrites){if(row.type===1){locked=true;issue('member',channel.name);continue;}
     const mapped=roleIds.get(row.id);if(!mapped){missing=true;break;}rows.push({...row,id:mapped});
    }
    if(missing){issue('mapping',channel.name);continue;}
    const finalRows=locked?privateRows(rows,this.target):rows;
    if(locked)issue('permissions',channel.name);
    // All newly created channels start hidden. Settings (including NSFW) and
    // the complete final overwrite list are applied together before release.
    const staging:Overwrite[]=[{id:this.target,type:0,allow:'0',deny:VIEW.toString()}];
    const id=createdId(await request(()=>this.port.createChannel(channel,parent,staging)));channelIds.set(channel.id,id);
    this.emit(channel.type===4?{categories:this.state.categories+1}:{channels:this.state.channels+1});
    check();await request(()=>this.port.updateChannel(id,channel,finalRows));
    const position=parent===null?(positions.get(channel.type)??0):channel.position;
    if(parent===null)positions.set(channel.type,position+1);orderedChannels.push({id,position});
   }
   if(orderedChannels.length)await request(()=>this.port.orderChannels(orderedChannels));
   this.emit({phase:'verifying',item:''});
   let target=this.port.snapshot();
   // Gateway/store acknowledgements may trail HTTP responses. Only read while
   // waiting; never repeat a creation because its store entry arrived late.
   for(let i=0;i<50;i++){
    check();const rolesReady=[...roleIds.values()].every(id=>target.roles.some(r=>r.id===id)),channelsReady=[...channelIds.values()].every(id=>target.channels.some(c=>c.id===id));
    if(rolesReady&&channelsReady)break;await this.sleep(100,controller.signal);target=this.port.snapshot();
   }
   check();const imported={...target,roles:target.roles.filter(r=>r.id===this.target||[...roleIds.values()].includes(r.id)),channels:target.channels.filter(c=>[...channelIds.values()].includes(c.id))};
   const result=verify(this.source,imported,{roleIds,channelIds});result.issues.push(...this.state.issues);
   this.emit({phase:'partial',result});
  }catch(error){if(!controller.signal.aborted)issue('fields',this.state.item);this.emit({phase:controller.signal.aborted?'cancelled':'failed'});if(!controller.signal.aborted&&error instanceof CloneError)throw error;}
  finally{this.controller=undefined;leased=false;this.emit({});}
 }
}
