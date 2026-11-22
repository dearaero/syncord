import {assertAccount,accountId,assertTarget,guilds,isAdministrator,readSnapshot} from './discord';
import {CloneError,type Snapshot} from './model';
import {nativePort} from './actions';
import {CloneEngine,type Progress} from './engine';
export class CloneSession {
 readonly account:string;
 readonly source:Snapshot;
 private alive=true;
 private engine:CloneEngine|undefined;
 private listeners=new Set<()=>void>();
 targetId:string|undefined;
 constructor(id:string){const account=accountId();if(!account)throw new CloneError('account');this.account=account;this.source=readSnapshot(id);}
 guard():void{if(!this.alive)throw new CloneError('account');assertAccount(this.account);}
 active():boolean{return this.engine?.active()??false;}
 started():boolean{return this.engine!==undefined;}
 progress():Progress{return this.engine?.snapshot()??{phase:'ready',roles:0,categories:0,channels:0,item:'',issues:[]};}
 subscribe(listener:()=>void):()=>void{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
 targets():{id:string;name:string}[]{
  this.guard();return Object.values(guilds()).filter(g=>{
   if(g.id===this.source.id||g.unavailable)return false;
   try{return isAdministrator(g.id);}catch{return false;}
  }).map(g=>({id:g.id,name:g.name}));
 }
 async run(id:string):Promise<void>{
  this.guard();if(this.engine)throw new CloneError('busy');assertTarget(id,this.source.id);
  const canonical=(s:Snapshot):string=>JSON.stringify([s.roles,[...s.channels].sort((a,b)=>a.id.localeCompare(b.id))]);
  if(canonical(readSnapshot(this.source.id))!==canonical(this.source))throw new CloneError('stale');
  const port=nativePort(this.source.id,id,()=>this.guard());this.targetId=id;
  this.engine=new CloneEngine(this.source,id,port,()=>{for(const listener of [...this.listeners]){try{listener();}catch{/* An unmounted dialog cannot interrupt a request. */}}});
  await this.engine.run();
 }
 stop():void{this.engine?.stop();}
 dispose():void{this.alive=false;this.engine?.stop();this.listeners.clear();}
}
