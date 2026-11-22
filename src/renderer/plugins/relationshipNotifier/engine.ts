import {emptySnapshot,type Snapshot,type Input,type Delta,type Entry,type Backup,type Change,type Config,type Relationship,type Person,type Cause} from './types';
const person=(r:Relationship):Person=>({id:r.id,username:r.username,name:r.name});
/** Pure state transitions. Missing cache data is never interpreted as a deletion. */
export function reconcile(previous:Snapshot|undefined,accountId:string,input:Input,cfg:Config,now:number,offline:boolean,cause:Cause='unknown'):Change {
 const old=previous??emptySnapshot(accountId);if(old.accountId!==accountId)throw Error("Relationship snapshot account mismatch.");
 const next:Snapshot={...old,ready:{...old.ready},relationships:{...old.relationships},groups:{...old.groups},guilds:{...old.guilds},revision:old.revision+1,seenAt:now};
 const entries:Entry[]=[],backup:Backup[]=[];
 const add=(row:Omit<Entry,'accountId'|'detectedAt'|'previousSeenAt'|'offline'|'cause'>,ready:boolean,enabled:boolean,own=cause):void=>{
  if(!ready||!enabled||(offline&&!cfg.offline))return;
  entries.push({...row,accountId,detectedAt:now,previousSeenAt:old.seenAt||undefined,offline,cause:own});
 };
 if(input.relationships){
  const full=input.complete?.relationships===true;
  const values=full?{...input.relationships}:{...old.relationships,...input.relationships};
  for(const [id,row]of Object.entries(values)){
   const before=old.relationships[id];if(before&&row.name===id)values[id]={...row,name:before.name,username:row.username===id?before.username:row.username};
  }
  for(const id of new Set([...Object.keys(old.relationships),...Object.keys(values)])){
   const before=old.relationships[id],after=values[id],from=before?.type??0,to=after?.type??0,user=after?person(after):before?person(before):undefined;
   if(!user)continue;
   const own=to===2?'local':cause;
   if(from!==to){
    if(from===1&&to!==1)add({kind:'friend-removed',subjectId:id,name:user.name,user},old.ready.relationships,cfg.friends,own);
    if(to===1)add({kind:'friend-added',subjectId:id,name:user.name,user},old.ready.relationships,cfg.friends,own);
    else if(to===3)add({kind:'request-received',subjectId:id,name:user.name,user},old.ready.relationships,cfg.requests,own);
    if(from===3&&to!==1&&to!==3)add({kind:'incoming-request-ended',subjectId:id,name:user.name,user},old.ready.relationships,cfg.requests,own);
    if(from===4&&to!==1&&to!==4)add({kind:'outgoing-request-ended',subjectId:id,name:user.name,user},old.ready.relationships,cfg.requests,own);
   }
   if(cfg.backup&&(to===1||from===1))backup.push({...user,accountId,firstSeenAt:now,lastSeenAt:now,isFriend:to===1});
  }
  next.relationships=values;if(full)next.ready.relationships=true;
 }
 if(input.groups){
  const full=input.complete?.groups===true,values=full?{...input.groups}:{...old.groups,...input.groups};
  for(const [id,row]of Object.entries(values)){
   const before=old.groups[id];if(before)values[id]={...row,name:row.name===id?before.name:row.name,...(!row.membersComplete?{members:before.members,membersComplete:before.membersComplete}:{})};
  }
  for(const [id,before]of Object.entries(old.groups)){
   const after=values[id];
   if(!after){add({kind:'group-removed',subjectId:id,name:before.name},old.ready.groups,cfg.groups);continue;}
   if(cfg.members&&before.membersComplete&&after.membersComplete){
    for(const [member,user]of Object.entries(before.members))if(member!==accountId&&!after.members[member])add({kind:'group-member-removed',subjectId:id,name:user.name,user,context:before.name},old.ready.groups,true);
    for(const [member,user]of Object.entries(after.members))if(member!==accountId&&!before.members[member])add({kind:'group-member-added',subjectId:id,name:user.name,user,context:after.name},old.ready.groups,true);
   }
  }
  next.groups=values;if(full||Object.keys(values).length)next.ready.groups=true;
 }
 if(input.guilds){
  const full=input.complete?.guilds===true,values=full?{...input.guilds}:{...old.guilds,...input.guilds};
  for(const [id,row]of Object.entries(values))if(old.guilds[id]&&row.name===id)values[id]={...row,name:old.guilds[id]!.name};
  for(const [id,before]of Object.entries(old.guilds))if(!values[id])add({kind:'server-removed',subjectId:id,name:before.name},old.ready.guilds,cfg.servers);
  next.guilds=values;if(full)next.ready.guilds=true;
 }
 if(cfg.backup&&backup.length)next.backupAt=now;
 return{snapshot:next,entries,backup};
}
export function transition(previous:Snapshot|undefined,accountId:string,delta:Delta,cfg:Config,now:number,cause:Cause|'pending'):Change {
 const old=previous??emptySnapshot(accountId);
 if(cause==='pending')return{snapshot:old,entries:[],backup:[]};
 let input:Input={};
 if(delta.scope==='relationship'){
  const values={...old.relationships};if(delta.value)values[delta.id]=delta.value;else delete values[delta.id];
  input={relationships:values,complete:{relationships:true}};
 }else if(delta.scope==='group'){
  const values={...old.groups};if(delta.value)values[delta.id]=delta.value;else delete values[delta.id];
  input={groups:values,complete:{groups:true}};
 }else if(delta.scope==='guild'){
  const values={...old.guilds};
  // A temporary unavailable guild remains a membership, including across READY.
  if(delta.value?.unavailable)values[delta.id]={...values[delta.id],...delta.value,name:values[delta.id]?.name??delta.value.name};
  else if(delta.value)values[delta.id]=delta.value;else delete values[delta.id];
  input={guilds:values,complete:{guilds:true}};
 }else{
  const group=old.groups[delta.id];if(!group)return{snapshot:old,entries:[],backup:[]};
  if(delta.user.id===accountId&&!delta.added)return transition(old,accountId,{scope:'group',id:delta.id},cfg,now,cause);
  const members={...group.members};if(delta.added)members[delta.user.id]=delta.user;else delete members[delta.user.id];
  input={groups:{...old.groups,[delta.id]:{...group,members}},complete:{groups:true}};
 }
 return reconcile(old,accountId,input,cfg,now,false,cause);
}
export class IntentLedger {
 private items=new Map<string,{token:number;expires:number;confirmed:boolean}>();private sequence=0;
 mark(key:string,now:number):number {this.prune(now);const token=++this.sequence;this.items.set(key,{token,expires:now+60_000,confirmed:false});return token;}
 confirm(key:string,token:number,now:number):boolean {const entry=this.items.get(key);if(!entry||entry.token!==token)return false;entry.confirmed=true;entry.expires=now+60_000;return true;}
 cancel(key:string,token:number):boolean {if(this.items.get(key)?.token!==token)return false;this.items.delete(key);return true;}
 consume(key:string,now:number):Cause|'pending' {const result=this.cause(key,now);if(result==='local')this.items.delete(key);return result;}
 cause(key:string,now:number):Cause|'pending' {this.prune(now);const item=this.items.get(key);return item?item.confirmed?'local':'pending':'unknown';}
 clear():void {this.items.clear();}
 private prune(now:number):void {for(const [key,row]of this.items)if(row.expires<=now)this.items.delete(key);}
}
