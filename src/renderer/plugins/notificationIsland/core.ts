import type {Kind} from './settings';
export type IslandItem={id:string;kind:Kind;title:string;body:string;place?:string;avatar?:string;at:number;channelId?:string;guildId?:string;messageId?:string};
export const HISTORY_LIMIT=50;
const text=(value:unknown,max:number):string=>typeof value==='string'?value.slice(0,max):'';
const snowflake=(value:unknown):string|undefined=>typeof value==='string'&&/^\d{17,20}$/.test(value)?value:undefined;
/** Persisted history is user-editable settings data, so it is re-validated on load. */
export function parseHistory(raw:string):IslandItem[]{
  let list:unknown;try{list=JSON.parse(raw);}catch{return [];}
  if(!Array.isArray(list))return [];
  const out:IslandItem[]=[];
  for(const entry of list.slice(0,HISTORY_LIMIT)){
    if(!entry||typeof entry!=='object')continue;const e=entry as Record<string,unknown>;
    if(typeof e.kind!=='string'||typeof e.at!=='number'||typeof e.id!=='string')continue;
    const avatar=text(e.avatar,300);
    out.push({id:text(e.id,64),kind:e.kind as Kind,title:text(e.title,120),body:text(e.body,200),place:text(e.place,120)||undefined,avatar:avatar.startsWith('https://cdn.discordapp.com/')?avatar:undefined,at:e.at,channelId:snowflake(e.channelId),guildId:snowflake(e.guildId),messageId:snowflake(e.messageId)});
  }
  return out;
}
/** Queue (shown one at a time) plus history (shown in the list). Pure; the view drives it. */
export function createIslandCore(save:(history:IslandItem[])=>void,initial:IslandItem[]=[]){
  let history=initial.slice(0,HISTORY_LIMIT),queue:IslandItem[]=[],unread=0;
  return {
    /** `show` false (silent mode) still records the event and counts it as unread. */
    push(item:IslandItem,show:boolean):void{history=[item,...history.filter(old=>old.id!==item.id)].slice(0,HISTORY_LIMIT);unread++;if(show)queue.push(item);save(history);},
    current:():IslandItem|undefined=>queue[0],
    /** Drops the shown item and returns the next one. */
    advance():IslandItem|undefined{queue.shift();return queue[0];},
    pending:():number=>queue.length,
    /** Empties the queue (shown item included) and returns what was in it. */
    drain():IslandItem[]{const all=queue;queue=[];return all;},
    history:():IslandItem[]=>history,
    unread:():number=>unread,
    markSeen():void{unread=0;},
    remove(id:string):void{history=history.filter(item=>item.id!==id);queue=queue.filter(item=>item.id!==id);save(history);},
    clear():void{history=[];queue=[];unread=0;save(history);},
  };
}
export type IslandCore=ReturnType<typeof createIslandCore>;
