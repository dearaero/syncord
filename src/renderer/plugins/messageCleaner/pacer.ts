type Costs={rateWaitMs:number;pacingWaitMs:number};
type Profile = {interval:number;latency:number;next:number;lastStart:number;limitedUntil:number;successes:number;sinceLimit:number;
  sampledRate:number;sampledPace:number;rateCost:number;paceCost:number};
/** Session-local feedback, bounded to eight account/channel pairs. No assumed API quota. */
export class DeletePacer {
  private profiles=new Map<string,Profile>();
  private current?:Profile;
  begin(key:string):void {
    let p=this.profiles.get(key);
    if(!p)p={interval:0,latency:0,next:0,lastStart:0,limitedUntil:0,successes:0,sinceLimit:0,sampledRate:0,sampledPace:0,rateCost:0,paceCost:0};
    // Meter totals restart per job; learned cost averages and intervals do not.
    p.sampledRate=p.sampledPace=0;p.successes=0;
    this.profiles.delete(key);this.profiles.set(key,p);
    if(this.profiles.size>8)this.profiles.delete(this.profiles.keys().next().value!);
    this.current=p;
  }
  until():number{return this.current?.next??0;}
  interval():number{return this.current?.interval??0;}
  started(now:number,baselineSpacing:number):void {
    const p=this.current;if(!p)return;
    p.lastStart=now;p.next=now+Math.max(p.interval,baselineSpacing);
  }
  completed(duration:number,success:boolean,_now:number,costs?:Costs):void {
    const p=this.current;if(!p)return;
    if(Number.isFinite(duration)&&duration>0)p.latency=p.latency?p.latency*.8+duration*.2:duration;
    if(!success)return;
    p.sinceLimit=Math.min(1000,p.sinceLimit+1);
    if(costs){
      const rate=Math.max(0,costs.rateWaitMs-p.sampledRate),pace=Math.max(0,costs.pacingWaitMs-p.sampledPace);
      p.sampledRate=costs.rateWaitMs;p.sampledPace=costs.pacingWaitMs;
      // Retain a decaying memory of real throttling; one clean response must
      // not erase a penalty and send us straight back into the same limit.
      p.rateCost=p.rateCost*.9+rate*.1;p.paceCost=p.paceCost*.9+pace*.1;
    }
    if(!p.interval||++p.successes<8)return;
    p.successes=0;
    if(!costs)return;
    // Only reclaim measured excess overhead. No permanent percentage floor:
    // isolated 429s must not leave every later message waiting two seconds.
    const excess=Math.max(0,p.paceCost-4*p.rateCost);
    const reduction=Math.min(p.interval*.2,excess*.5);
    p.interval=Math.max(Math.min(p.interval,p.latency),p.interval-reduction);
    p.next=Math.min(p.next,p.lastStart+p.interval);
  }
  limited(startedAt:number,until:number,now:number):void {
    const p=this.current;if(!p)return;
    // Already-started peers are one feedback event. A retry with no
    // acknowledged deletion provides no new throughput evidence.
    if(startedAt>=p.limitedUntil&&(p.interval===0||p.sinceLimit>0)){
      const base=Math.max(p.interval,p.latency);
      // Amortize a short retry over the successful work before it, rather than
      // applying a 50% slowdown to the entire remaining history on every 429.
      const bump=p.sinceLimit>0?Math.min(Math.max(25,p.latency*.5),Math.max(0,until-now)/(2*p.sinceLimit)):Math.max(25,base*.5);
      p.interval=Math.min(300_000,Math.max(100,base+bump));p.successes=0;p.sinceLimit=0;
    }
    p.limitedUntil=Math.max(p.limitedUntil,until);
    // This is an interval between starts; RTT is included, not added again.
    p.next=Math.max(p.next,p.lastStart+p.interval);
  }
}
