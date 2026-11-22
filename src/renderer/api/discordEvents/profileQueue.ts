export type ProfileTarget={userId:string;guildId?:string;channelId:string};
export type ProfileQueueDeps={
  now:()=>number;set:(fn:()=>void,delay:number)=>number;clear:(id:number)=>void;
  ready:(target:ProfileTarget)=>boolean;fetching:(target:ProfileTarget)=>boolean;
  fetch:(target:ProfileTarget,signal:AbortSignal)=>Promise<unknown>;allowed:(target:ProfileTarget)=>boolean;
};
function rateLimitDelay(error:unknown,now:number):number|undefined {
  const rec=error&&typeof error==='object'?error as Record<string,unknown>:undefined;
  const response=rec?.response&&typeof rec.response==='object'?rec.response as Record<string,unknown>:undefined;
  if(Number(rec?.status??rec?.statusCode??response?.status)!==429)return undefined;
  const body=rec?.body??response?.body;
  const retry=body&&typeof body==='object'?(body as {retry_after?:unknown}).retry_after:undefined;
  const headers=rec?.headers??response?.headers;
  let value:unknown;
  if(headers&&typeof headers==='object'){
    const h=headers as Record<string,unknown>;
    try {value=typeof h.get==='function'?(h.get as (key:string)=>unknown).call(headers,'retry-after'):h['retry-after']??h['Retry-After'];}catch{/* fallback below */}
  }
  const header=typeof value==='string'?(/^[0-9]+(?:\.[0-9]+)?$/.test(value)?Number(value)*1000:Date.parse(value)-now):undefined;
  const delays=[typeof retry==='number'?retry*1000:undefined,header].filter((n):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>0);
  // Cloudflare can return plain text with a long Retry-After. Never cap that to ten minutes.
  return Math.max(60_000,...(delays.length?delays:[10*60_000]));
}
const key=(target:ProfileTarget):string=>`${target.userId}:${target.guildId??''}`;
const MAX_VISIBLE=100,MAX_PENDING=128,MAX_RECENT=256,GAP=1500;

/** One bounded, demand-driven native profile queue shared by all consumers. Never retains profiles. */
export class ProfileQueue {
  private consumers=new Map<symbol,ProfileTarget[]>();
  private pending=new Map<string,ProfileTarget>();
  private recent=new Map<string,number>();
  private timer=0;
  private timeout=0;
  private active:{key:string;controller:AbortController;failed?:boolean}|undefined;
  private nextAt=0;
  private blockedUntil=0;
  constructor(private readonly deps:ProfileQueueDeps){}
  acquire():{update:(targets:readonly ProfileTarget[])=>void;release:()=>void}{
    const id=Symbol();this.consumers.set(id,[]);let released=false;
    return {update:targets=>{
      if(released)return;
      const unique=new Map<string,ProfileTarget>();
      for(const target of targets){
        if(!/^\d{17,20}$/.test(target.userId)||!/^\d{17,20}$/.test(target.channelId)||(target.guildId!==undefined&&!/^\d{17,20}$/.test(target.guildId)))continue;
        if(!unique.has(key(target)))unique.set(key(target),{...target});if(unique.size===MAX_VISIBLE)break;
      }
      this.consumers.set(id,[...unique.values()]);this.wake();
    },release:()=>{
      if(released)return;released=true;this.consumers.delete(id);
      if(!this.consumers.size)this.reset();else this.wake();
    }};
  }
  wake():void {
    const now=this.deps.now();
    if(this.active&&![...this.consumers.values()].some(targets=>targets.some(target=>key(target)===this.active?.key&&this.deps.allowed(target)))){
      const active=this.active;this.active=undefined;
      this.deps.clear(this.timeout);this.timeout=0;this.nextAt=Math.max(this.nextAt,now+GAP);active.controller.abort();
    }
    this.pending.clear();
    for(const targets of this.consumers.values())for(const target of targets){
      const id=key(target);
      if(this.pending.size>=MAX_PENDING)break;
      if(this.active?.key===id||(this.recent.get(id)??0)>now||!this.deps.allowed(target)||this.deps.ready(target))continue;
      // Another native caller already requested it. Its Flux completion will wake us.
      if(this.deps.fetching(target))continue;
      this.pending.set(id,target);
    }
    if(!this.pending.size){if(this.timer)this.deps.clear(this.timer);this.timer=0;return;}
    if(!this.active&&!this.timer)this.timer=this.deps.set(()=>{this.timer=0;this.pump();},Math.min(2_147_483_647,Math.max(0,Math.max(this.nextAt,this.blockedUntil)-now)));
  }
  private pump():void {
    if(this.active)return;
    if(this.deps.now()<this.blockedUntil){this.wake();return;}
    const item=this.pending.entries().next();if(item.done)return;
    const [id,target]=item.value;this.pending.delete(id);
    if(!this.deps.allowed(target)||this.deps.ready(target)||this.deps.fetching(target)){this.wake();return;}
    const active:{key:string;controller:AbortController;failed?:boolean}={key:id,controller:new AbortController()};this.active=active;
    const expired=new Promise<never>((_,reject)=>{this.timeout=this.deps.set(()=>{active.controller.abort();reject(new Error('Profile request timed out'));},20_000);});
    let attempt:Promise<unknown>;
    try{attempt=Promise.resolve(this.deps.fetch(target,active.controller.signal));}catch(error){attempt=Promise.reject(error);}
    void Promise.race([attempt,expired]).then(()=>{if(this.active===active&&!active.failed)this.remember(id,10*60_000);},error=>{
      if(this.active===active)this.failure(id,error);
    }).finally(()=>{
      if(this.active!==active)return;
      this.deps.clear(this.timeout);this.timeout=0;this.active=undefined;this.nextAt=Math.max(this.nextAt,this.deps.now()+GAP);this.wake();
    });
  }
  private failure(id:string,error:unknown):void {
    const now=this.deps.now(),retry=rateLimitDelay(error,now);
    this.remember(id,retry??60_000);
    // A native loader may swallow its HTTP rejection and resolve. Flux failure still pauses the queue.
    this.blockedUntil=Math.max(this.blockedUntil,now+(retry??30_000));
  }
  failed(userId:string,guildId?:string,error?:unknown):void {
    const active=this.active;
    const matches=active?.key.startsWith(`${userId}:`)===true&&(guildId===undefined||active?.key===`${userId}:${guildId}`);
    if(active&&matches&&!active.controller.signal.aborted){active.failed=true;this.failure(active.key,error);}
    else if(rateLimitDelay(error,this.deps.now())!==undefined)this.failure(`${userId}:${guildId??''}`,error);
    this.wake();
  }
  private remember(id:string,delay:number):void {
    if(!this.consumers.size)return;
    this.recent.delete(id);this.recent.set(id,this.deps.now()+delay);
    if(this.recent.size>MAX_RECENT){const first=this.recent.keys().next();if(!first.done)this.recent.delete(first.value);}
  }
  completed(userId:string,guildId?:string):void {this.remember(`${userId}:${guildId??''}`,10*60_000);this.wake();}
  reset():void {
    if(this.timer)this.deps.clear(this.timer);if(this.timeout)this.deps.clear(this.timeout);
    this.timer=this.timeout=0;this.active?.controller.abort();this.active=undefined;
    this.pending.clear();this.recent.clear();this.nextAt=0;
    for(const id of this.consumers.keys())this.consumers.set(id,[]);
  }
  stats():{consumers:number;pending:number;recent:number;active:number;timers:number}{
    return {consumers:this.consumers.size,pending:this.pending.size,recent:this.recent.size,active:this.active?1:0,timers:Number(!!this.timer)+Number(!!this.timeout)};
  }
}
