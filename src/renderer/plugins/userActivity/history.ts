import {EVENT_KINDS,cleanText,messageContent,userId,type EventKind,type MessageEvent} from './types';

export type ActivityLogInput = {
  accountId:string;userId:string;userName:string;kind:EventKind;text:string;
  timestamp:number;channelId?:string;channelName?:string;messageId?:string;messageEvent?:MessageEvent;content?:string;
};
export type ActivityLogEntry = ActivityLogInput & {id:number};
export type ActivityLogPage = {entries:ActivityLogEntry[];total:number;hasOlder:boolean;hasNewer:boolean};
export const ACTIVITY_LOG_FAILED = 'Syncord-user-activity-log-failed';
export const ACTIVITY_LOG_CHANGED = 'Syncord-user-activity-log-changed';
export const LOG_PAGE_SIZE = 50;
const STORE='events', COUNTS='counts', INDEX='account-user-id', MESSAGE_INDEX='account-message-id', MAX_KEY=Number.MAX_SAFE_INTEGER;

function validate(row:ActivityLogInput):ActivityLogInput {
  if(userId(row.accountId)!==row.accountId||userId(row.userId)!==row.userId||!row.userId||!row.accountId||!EVENT_KINDS.includes(row.kind)||!Number.isFinite(row.timestamp)||row.timestamp<0)
    throw new Error('Invalid activity history entry.');
  return {accountId:row.accountId,userId:row.userId,userName:cleanText(row.userName,80),kind:row.kind,
    text:cleanText(row.text,400),timestamp:row.timestamp,
    ...(row.channelId?{channelId:cleanText(row.channelId,64),channelName:cleanText(row.channelName,160)}:{}),
    ...(row.kind==='messages'&&typeof row.messageId==='string'&&row.messageId.length>0&&row.messageId.length<=32&&
      ['sent','edited','deleted'].includes(row.messageEvent??'')
      ?{messageId:row.messageId,messageEvent:row.messageEvent,content:messageContent(row.content)}:{})};
}
function complete(tx:IDBTransaction):Promise<void> {
  return new Promise((resolve,reject)=>{
    tx.oncomplete=()=>resolve();
    tx.onabort=tx.onerror=()=>reject(tx.error??new Error('Could not save local activity history.'));
  });
}

/** Append-only local history. Reads use a user/account index, never load the entire log. */
export class ActivityHistory {
  private opening:Promise<IDBDatabase>|undefined;
  private db():Promise<IDBDatabase> {
    return this.opening??=new Promise<IDBDatabase>((resolve,reject)=>{
      if(typeof indexedDB==='undefined'){reject(new Error('Local activity storage is unavailable.'));return;}
      const req=indexedDB.open('Syncord.plugins.user-activity.history',3);
      req.onupgradeneeded=event=>{
        if(event.oldVersion===0){
          const store=req.result.createObjectStore(STORE,{keyPath:'id',autoIncrement:true});
          store.createIndex(INDEX,['accountId','userId','id'],{unique:true});
        }
        const counts=event.oldVersion<2?req.result.createObjectStore(COUNTS,{keyPath:['accountId','userId']}):req.transaction!.objectStore(COUNTS);
        req.transaction!.objectStore(STORE).createIndex(MESSAGE_INDEX,['accountId','channelId','messageId','id'],{unique:true});
        if(event.oldVersion===1){
          // Upgrade older local logs in-place with a cursor, without loading history into RAM.
          const cursor=req.transaction!.objectStore(STORE).openCursor();
          cursor.onsuccess=()=>{
            const row=cursor.result;if(!row)return;
            const {accountId,userId}=row.value as ActivityLogEntry;
            const previous=counts.get([accountId,userId]);
            previous.onsuccess=()=>{counts.put({accountId,userId,count:(previous.result?.count??0)+1});row.continue();};
          };
        }
      };
      req.onsuccess=()=>{
        const db=req.result;db.onversionchange=()=>{db.close();this.opening=undefined;};resolve(db);
      };
      req.onerror=()=>reject(req.error??new Error('Could not open local activity history.'));
      req.onblocked=()=>reject(new Error('Close other Syncord windows and try opening activity history again.'));
    }).catch(error=>{this.opening=undefined;throw error;});
  }
  async appendMany(rows:readonly ActivityLogInput[]):Promise<void> {
    if(!rows.length)return;
    const entries=rows.map(validate),db=await this.db();
    const tx=db.transaction([STORE,COUNTS],'readwrite'),done=complete(tx),store=tx.objectStore(STORE),counts=tx.objectStore(COUNTS);
    const increments=new Map<string,{accountId:string;userId:string;count:number}>();
    try {
      for(const row of entries){
        store.add(row);const key=`${row.accountId}:${row.userId}`,previous=increments.get(key);
        if(previous)previous.count++;else increments.set(key,{accountId:row.accountId,userId:row.userId,count:1});
      }
      for(const row of increments.values()){
        const previous=counts.get([row.accountId,row.userId]);
        previous.onsuccess=()=>counts.put({...row,count:(previous.result?.count??0)+row.count});
      }
    } catch(error){tx.abort();await done.catch(()=>{});throw error;}
    await done;
  }
  async page(accountId:string,id:string,direction:'older'|'newer'='older',anchor?:number):Promise<ActivityLogPage> {
    if(!userId(accountId)||!userId(id)||(anchor!==undefined&&(!Number.isSafeInteger(anchor)||anchor<1)))throw new Error('Invalid activity history query.');
    const db=await this.db(),tx=db.transaction([STORE,COUNTS]),done=complete(tx),index=tx.objectStore(STORE).index(INDEX);
    const key=(value:number):IDBValidKey=>[accountId,id,value];
    const range=direction==='newer'?IDBKeyRange.bound(key(anchor??0),key(MAX_KEY),true)
      :IDBKeyRange.bound(key(0),key(anchor??MAX_KEY),false,anchor!==undefined);
    const entries:ActivityLogEntry[]=[];
    let total=0,hasOlder=false,hasNewer=false;
    const count=tx.objectStore(COUNTS).get([accountId,id]);count.onsuccess=()=>{total=count.result?.count??0;};
    const req=index.openCursor(range,direction==='newer'?'next':'prev');
    const edges=():void=>{
      if(!entries.length)return;
      if(direction==='newer')entries.reverse();
      const oldest=entries[entries.length-1]!.id,newest=entries[0]!.id;
      const older=index.openKeyCursor(IDBKeyRange.bound(key(0),key(oldest),false,true),'prev');
      const newer=index.openKeyCursor(IDBKeyRange.bound(key(newest),key(MAX_KEY),true),'next');
      older.onsuccess=()=>{hasOlder=older.result!==null;};newer.onsuccess=()=>{hasNewer=newer.result!==null;};
    };
    req.onsuccess=()=>{
      const cursor=req.result;
      if(cursor&&entries.length<LOG_PAGE_SIZE){entries.push(cursor.value as ActivityLogEntry);cursor.continue();}
      else edges();
    };
    await done;return {entries,total,hasOlder,hasNewer};
  }
  async message(accountId:string,channelId:string,messageId:string):Promise<ActivityLogEntry|undefined> {
    if(!userId(accountId)||!channelId||!messageId)return undefined;
    const db=await this.db(),tx=db.transaction(STORE),done=complete(tx);
    const index=tx.objectStore(STORE).index(MESSAGE_INDEX);
    const req=index.openCursor(IDBKeyRange.bound([accountId,channelId,messageId,0],[accountId,channelId,messageId,MAX_KEY]),'prev');
    let result:ActivityLogEntry|undefined;
    req.onsuccess=()=>{result=req.result?.value as ActivityLogEntry|undefined;};
    await done;return result;
  }
  async close():Promise<void> {const opened=this.opening;this.opening=undefined;if(opened)(await opened).close();}
}
export const activityHistory=new ActivityHistory();
