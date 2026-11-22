import {validId,KINDS,type Snapshot,type Change,type Entry,type Backup} from './types';
const DB='Syncord.plugins.relationship-notifier',PAGE=50,MAX=Number.MAX_SAFE_INTEGER;
const complete=(tx:IDBTransaction):Promise<void>=>new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(tx.error??Error("Could not save relationship data."));});
export class RelationshipStorage {
 private opening:Promise<IDBDatabase>|undefined;
 private db():Promise<IDBDatabase>{return this.opening??=new Promise<IDBDatabase>((resolve,reject)=>{
  const req=indexedDB.open(DB,1);req.onupgradeneeded=()=>{
   req.result.createObjectStore('accounts',{keyPath:'accountId'});
   const history=req.result.createObjectStore('history',{keyPath:'id',autoIncrement:true});history.createIndex('account',['accountId','id'],{unique:true});
   const friends=req.result.createObjectStore('friends',{keyPath:['accountId','id']});friends.createIndex('account','accountId');
  };
  req.onerror=()=>reject(req.error??Error("Local relationship storage unavailable."));req.onblocked=()=>reject(Error("Close other Syncord windows and try again."));
  req.onsuccess=()=>{const db=req.result;db.onversionchange=()=>{db.close();this.opening=undefined;};resolve(db);};
 }).catch(error=>{this.opening=undefined;throw error;});}
 /** Serialize baseline + history + backup in one transaction, including across windows. */
 async update(accountId:string,reduce:(previous:Snapshot|undefined)=>Change,saveHistory:boolean,valid:()=>boolean):Promise<Entry[]>{
  if(!validId(accountId))throw Error("Invalid relationship account.");const db=await this.db();if(!valid())return[];
  const tx=db.transaction(['accounts','history','friends'],'readwrite'),done=complete(tx),accounts=tx.objectStore('accounts'),req=accounts.get(accountId);let rows:Entry[]=[];
  req.onsuccess=()=>{
   if(!valid()){tx.abort();return;}
   try{
    const change=reduce(req.result as Snapshot|undefined);if(change.snapshot.accountId!==accountId)throw Error("Relationship account mismatch.");
    rows=change.entries;
    for(const row of rows)if(row.accountId!==accountId||!KINDS.includes(row.kind)||!validId(row.subjectId)||!Number.isFinite(row.detectedAt))throw Error("Invalid relationship history.");
    const snapshot={...change.snapshot,historyCount:(req.result?.historyCount??0)+(saveHistory?rows.length:0)};
    accounts.put(snapshot);if(saveHistory)for(const row of rows)tx.objectStore('history').add(row);
    for(const row of change.backup){
     if(row.accountId!==accountId||!validId(row.id))throw Error("Invalid friend backup.");
     const store=tx.objectStore('friends'),previous=store.get([accountId,row.id]);
     previous.onsuccess=()=>store.put({...row,firstSeenAt:previous.result?.firstSeenAt??row.firstSeenAt});
    }
   }catch{tx.abort();}
  };
  try{await done;}catch(error){if(!valid())return[];throw error;}return valid()?rows:[];
 }
 async page(accountId:string,before=MAX):Promise<{entries:Entry[];more:boolean;total:number}>{
  if(!validId(accountId))throw Error("Sign in to view relationship history.");const db=await this.db(),tx=db.transaction(['accounts','history']),done=complete(tx);
  const entries:Entry[]=[];let more=false,total=0;
  const meta=tx.objectStore('accounts').get(accountId);meta.onsuccess=()=>{total=meta.result?.historyCount??0;};
  const req=tx.objectStore('history').index('account').openCursor(IDBKeyRange.bound([accountId,0],[accountId,before],false,true),'prev');
  req.onsuccess=()=>{const cursor=req.result;if(!cursor)return;if(entries.length===PAGE){more=true;return;}entries.push(cursor.value as Entry);cursor.continue();};
  await done;return{entries,more,total};
 }
 async backup(accountId:string):Promise<{friends:Backup[];updatedAt?:number}>{
  if(!validId(accountId))throw Error("Sign in to view your friend backup.");const db=await this.db(),tx=db.transaction(['accounts','friends']),done=complete(tx);let friends:Backup[]=[],updatedAt:number|undefined;
  const req=tx.objectStore('friends').index('account').getAll(accountId);req.onsuccess=()=>{friends=req.result as Backup[];};
  const meta=tx.objectStore('accounts').get(accountId);meta.onsuccess=()=>{updatedAt=meta.result?.backupAt;};await done;return{friends,updatedAt};
 }
 async close():Promise<void>{const pending=this.opening;this.opening=undefined;if(pending)(await pending).close();}
}
export const relationshipStorage=new RelationshipStorage();
