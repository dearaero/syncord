import type {ProcessStatistics,StatisticsSnapshot} from '../../shared/statistics';
export class ResourceSampler {
 private previous=new Map<string,{cpu:number;at:number}>();private peak=0;
 sample(metrics:Electron.ProcessMetric[],now:number,cores:number):StatisticsSnapshot['resources']{
  const old=this.previous,next=new Map<string,{cpu:number;at:number}>(),processes:ProcessStatistics[]=[];let memoryBytes=0,cpuPercent=0,hasCpu=false;
  const number=(n:unknown):number=>typeof n==='number'&&Number.isFinite(n)&&n>=0?n:0;
  for(const m of metrics.slice(0,256)){
   const key=`${m.pid}:${m.creationTime}`,cumulative=m.cpu?.cumulativeCPUUsage,previous=old.get(key);let cpu:number|null=null;
   if(typeof cumulative==='number'&&Number.isFinite(cumulative)&&cumulative>=0){next.set(key,{cpu:cumulative,at:now});if(previous&&now>previous.at&&cumulative>=previous.cpu)cpu=(cumulative-previous.cpu)/(now-previous.at)*100_000;}
   else {if(old.has(key))cpu=number(m.cpu?.percentCPUUsage);next.set(key,{cpu:0,at:now});}
   if(cpu!==null){hasCpu=true;cpuPercent+=cpu;}
   const memory=number(m.memory?.workingSetSize)*1024;memoryBytes+=memory;
   processes.push({pid:m.pid,kind:m.type,name:(m.name||m.serviceName||m.type).slice(0,100),cpuPercent:cpu,cpuSeconds:typeof cumulative==='number'?number(cumulative):null,memoryBytes:memory,peakBytes:number(m.memory?.peakWorkingSetSize)*1024,privateBytes:typeof m.memory?.privateBytes==='number'?number(m.memory.privateBytes)*1024:null,ageSeconds:Math.max(0,(now-m.creationTime)/1000),sandboxed:typeof m.sandboxed==='boolean'?m.sandboxed:null});
  }
  this.previous=next;this.peak=Math.max(this.peak,memoryBytes);
  return{available:metrics.length>0,cpuPercent:hasCpu?cpuPercent:null,cpuCapacityPercent:hasCpu?Math.min(100,cpuPercent/Math.max(1,cores)):null,memoryBytes,peakObservedBytes:this.peak,processes,truncated:metrics.length>256};
 }
}
