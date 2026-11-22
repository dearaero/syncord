import type {PluginContext} from '../../api/plugin';
import {settings} from '../../api/settings';
import {LIMITS,load,validate,compare,type LocalRecord,type Database} from './model';
export class LocalStore{
 private data:Database;private listeners=new Set<()=>void>();
 constructor(private ctx:Pick<PluginContext,'settings'>,private account:()=>string|undefined,private capacity:(next:Database)=>boolean=withinSettings){this.data=load(ctx.settings.get('records'));}
 rows(channel:string):readonly LocalRecord[]{const id=this.account();return id?this.data.accounts[id]?.[channel]??[]:[];}
 subscribe(fn:()=>void):()=>void{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
 update(channel:string,value:unknown,participants:readonly string[]):LocalRecord{
  const account=this.account();if(!account)throw Error('fd.unavailable');const row=validate(value,account,channel);
  if(!row||!participants.includes(row.authorId)||(row.kind==='call'&&!participants.includes(row.receiverId??'')))throw Error('fd.invalid');
  const rows=this.rows(channel),old=rows.find(r=>r.id===row.id),exists=!!old;
  if(old&&row.createdAt!==old.createdAt)throw Error('fd.invalid');
  if(!exists)for(const [owner,channels]of Object.entries(this.data.accounts))for(const [id,records]of Object.entries(channels)){
   if((owner!==account||id!==channel)&&records.some(r=>r.id===row.id))throw Error('fd.invalid');
  }
  if(!exists&&(rows.length>=LIMITS.channel||Object.values(this.data.accounts[account]??{}).reduce((n,v)=>n+v.length,0)>=LIMITS.account))throw Error('fd.limit');
  this.commit(account,channel,[...rows.filter(r=>r.id!==row.id),row].sort(compare));return row;
 }
 remove(channel:string,id?:string):void{const account=this.account();if(!account)throw Error('fd.unavailable');this.commit(account,channel,id?this.rows(channel).filter(r=>r.id!==id):[]);}
 private commit(account:string,channel:string,rows:readonly LocalRecord[]):void{
  if(this.account()!==account)throw Error('fd.unavailable');
  const channels={...this.data.accounts[account]};if(rows.length)channels[channel]=[...rows];else delete channels[channel];
  const accounts={...this.data.accounts};if(Object.keys(channels).length)accounts[account]=channels;else delete accounts[account];
  const next:Database={version:1,accounts};
  if(new TextEncoder().encode(JSON.stringify(next)).byteLength>LIMITS.bytes||!this.capacity(next))throw Error('fd.limit');
  // The shared settings layer already batches disk writes; only this DM array is copied.
  this.ctx.settings.set('records',next);this.data=next;
  for(const fn of [...this.listeners])try{fn();}catch{/* Closed local views do not invalidate the saved data. */}
 }
 dispose():void{this.listeners.clear();}
}
function withinSettings(next:Database):boolean{
 try{return new TextEncoder().encode(JSON.stringify({...settings.getAll(),'plugins.fake-dm.data.records':next},null,2)).byteLength<=480*1024;}catch{return false;}
}
