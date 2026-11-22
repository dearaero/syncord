export type CleanupMetrics = { elapsedMs:number; messagesPerSecond:number; recentMessagesPerSecond?:number; averageRequestMs:number;
  requests:number; peakConcurrency:number; rateLimitResponses:number; rateWaitMs:number; cooldownWaitMs:number; pacingWaitMs:number };
/** Aggregate timings only. Never stores message bodies, IDs, URLs or headers. */
export class CleanupMeter {
  private started:number;
  private ended?:number;
  private requests=0;
  private duration=0;
  private active=0;
  private peak=0;
  private limits=0;
  private rateWait=0;
  private cooldownWait=0;
  private pacingWait=0;
  private lastSample:number;
  private speedWindow=0;
  private confirmedInWindow=0;
  private recentSpeed?:number;
  private waits=new Map<symbol,{until:number;rateUntil:number;cooldownUntil:number}>();
  constructor(private now:()=>number){this.started=this.lastSample=now();}
  private sample():number{
    const t=Math.max(this.lastSample,this.ended??this.now());
    let until=this.lastSample,rateUntil=this.lastSample,cooldownUntil=this.lastSample;
    for(const wait of this.waits.values()){until=Math.max(until,wait.until);rateUntil=Math.max(rateUntil,Math.min(wait.until,wait.rateUntil));cooldownUntil=Math.max(cooldownUntil,Math.min(wait.until,wait.cooldownUntil));}
    this.rateWait+=Math.max(0,Math.min(t,rateUntil)-this.lastSample);
    this.cooldownWait+=Math.max(0,Math.min(t,cooldownUntil)-Math.max(this.lastSample,rateUntil));
    this.pacingWait+=Math.max(0,Math.min(t,until)-Math.max(this.lastSample,rateUntil,cooldownUntil));
    const speedWindow=Math.floor((t-this.started)/10_000);
    if(speedWindow>this.speedWindow){
      this.recentSpeed=speedWindow===this.speedWindow+1?this.confirmedInWindow/10:0;
      this.confirmedInWindow=0;this.speedWindow=speedWindow;
    }
    this.lastSample=t;return t;
  }
  request():()=>void{
    const at=this.now();this.requests++;this.active++;this.peak=Math.max(this.peak,this.active);let ended=false;
    return()=>{if(ended)return;ended=true;this.active--;this.duration+=Math.max(0,this.now()-at);};
  }
  rateDeadline(until:number):void{
    // A peer can reveal a server block while another worker is already pacing.
    // Reclassify only future waiting time, without changing elapsed time.
    this.sample();for(const wait of this.waits.values())wait.rateUntil=Math.max(wait.rateUntil,until);
  }
  confirmed():void{this.sample();this.confirmedInWindow++;}
  limited():void{this.limits++;}
  wait(until:number,rateUntil:number,cooldownUntil=until):()=>void{
    this.sample();const key=Symbol();this.waits.set(key,{until,rateUntil,cooldownUntil});
    return()=>{this.sample();this.waits.delete(key);};
  }
  finish():void{this.sample();this.ended=this.lastSample;}
  snapshot(deletedIndividually:number):CleanupMetrics{
    const t=this.sample();const elapsedMs=Math.max(0,t-this.started);
    return{elapsedMs,recentMessagesPerSecond:this.recentSpeed,messagesPerSecond:elapsedMs>0?deletedIndividually*1000/elapsedMs:0,
      averageRequestMs:this.requests>this.active?this.duration/(this.requests-this.active):0,
      requests:this.requests,peakConcurrency:this.peak,rateLimitResponses:this.limits,
      rateWaitMs:this.rateWait,cooldownWaitMs:this.cooldownWait,pacingWaitMs:this.pacingWait};
  }
}
