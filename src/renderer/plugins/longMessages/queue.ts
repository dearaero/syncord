import {splitMessage,type Part} from './splitter';
import type {LongRequest} from '../../chat/longMessage';
export type Status='confirm'|'sending'|'cancelling'|'cancelled'|'failed'|'uncertain'|'done';
export type Job={key:string;request:LongRequest;parts:Part[];sent:number;status:Status;remaining:string;cancel:()=>void;confirm:()=>void};
export type QueueOptions={numbers:boolean;confirmLarge:boolean;maxParts:number};
export function confirmed(value:unknown,channelId:string):boolean {
  if(!value||typeof value!=='object')return false;
  const r=value as {ok?:boolean;status?:number;body?:{id?:unknown;channel_id?:unknown}};
  return r.ok!==false&&(r.status==null||r.status>=200&&r.status<300)&&typeof r.body?.id==='string'&&/^\d{17,20}$/.test(r.body.id)&&(r.body.channel_id==null||r.body.channel_id===channelId);
}
function nonce():string{const random=new Uint32Array(1);crypto.getRandomValues(random);return ((BigInt(Date.now()-1420070400000)<<22n)|BigInt(random[0]!&0x3fffff)).toString();}
export class LongQueue {
  readonly jobs=new Map<string,Job>();
  private stopped=false;
  constructor(private options:()=>QueueOptions,private changed:(job:Job)=>void,private deadline=45_000){}
  offer(request:LongRequest):Promise<void>|undefined{
    const cfg=this.options(),limit=request.limit??2000;
    if(request.text.length<=limit)return;
    const key=request.accountId+':'+request.channelId;
    if(this.stopped||!request.valid())return Promise.reject(Error('long.unavailable'));
    if(this.jobs.has(key)||this.jobs.size>=4)return Promise.reject(Error('long.busy'));
    let parts:Part[];try{parts=splitMessage(request.text,{limit,maxParts:cfg.maxParts,numbers:cfg.numbers});}catch(error){return Promise.reject(error);}
    let release:((yes:boolean)=>void)|undefined,cancelled=false,wake:(()=>void)|undefined;
    const job:Job={key,request,parts,sent:0,status:cfg.confirmLarge&&parts.length>5?'confirm':'sending',remaining:request.text,cancel:()=>{cancelled=true;release?.(false);wake?.();if(job.status==='sending')job.status='cancelling';this.changed(job);},confirm:()=>release?.(true)};
    this.jobs.set(key,job);
    return (async()=>{
      try{
        if(job.status==='confirm'){
          const yes=await new Promise<boolean>(resolve=>{release=resolve;this.changed(job);});release=undefined;
          if(!yes)cancelled=true;
        }
        for(const part of parts){
          if(cancelled||this.stopped||!request.valid()){job.status='cancelled';break;}
          job.status='sending';this.changed(job);
          let timer:ReturnType<typeof setTimeout>|undefined;
          try{
            const result=await Promise.race([request.send(part.content,job.sent,nonce()),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('long.uncertain')),this.deadline);})]);
            if(!confirmed(result,request.channelId)){job.status='uncertain';break;}
          }catch(error){job.status=error instanceof Error&&['long.unavailable','long.partial'].includes(error.message)?'failed':'uncertain';break;}
          finally{clearTimeout(timer);}
          job.sent++;job.remaining=request.text.slice(part.end);
          try{if(!this.stopped&&request.valid())request.delivered?.(job.remaining,job.sent);}catch{job.status='failed';break;}
          // Yield to the native controlled editor between acknowledgements, not a polling loop.
          if(job.sent<parts.length&&!cancelled&&!this.stopped)await new Promise<void>(resolve=>{const timer=setTimeout(()=>{wake=undefined;resolve();},50);wake=()=>{clearTimeout(timer);wake=undefined;resolve();};});
        }
        if(job.sent===parts.length)job.status='done';
        else if(cancelled||this.stopped||!request.valid())job.status='cancelled';
      }finally{
        // Recovery is independent of delivery. A controlled editor refusing a
        // replacement must never turn a confirmed message into a send failure.
        if(job.status!=='done'&&!this.stopped&&request.valid()){
          try{request.settled?.(job.remaining,job.sent);}catch{/* The recovery card retains the complete suffix. */}
        }
        if(job.status==='done'&&this.jobs.get(key)===job)this.jobs.delete(key);
        this.changed(job);
      }
      if(job.status!=='done')throw Error(job.status==='uncertain'?'long.uncertain':job.status==='cancelled'?'long.cancelled':'long.partial');
    })();
  }
  dismiss(job:Job):void{if(!['confirm','sending','cancelling'].includes(job.status)){if(this.jobs.get(job.key)===job)this.jobs.delete(job.key);job.parts=[];job.remaining='';}}
  cancelOtherAccounts(accountId:string|undefined):void{for(const [key,job] of this.jobs)if(job.request.accountId!==accountId){job.cancel();this.jobs.delete(key);}}
  stop():void{this.stopped=true;for(const job of this.jobs.values())job.cancel();this.jobs.clear();}
}
