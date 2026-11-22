import type {ChatBounds} from '../../../shared/popoutChats';
export type SavedChat={draft:string;bounds?:ChatBounds;reopen:boolean;updated:number};
function record(raw:unknown):raw is Record<string,unknown>{return raw!==null&&typeof raw==='object'&&!Array.isArray(raw);}
/** Bound saved data before it can consume the shared settings budget. File bytes are never persisted. */
export function readChatHistory(raw:unknown):Record<string,SavedChat>{
  if(!record(raw))return {};
  const items:Array<[string,SavedChat]>=[];
  for(const [id,value] of Object.entries(raw).slice(0,64)){
    if(!/^\d{5,22}$/.test(id)||!record(value)||typeof value.draft!=='string')continue;
    let bounds:ChatBounds|undefined;
    const b=value.bounds;
    if(record(b)&&['x','y','width','height'].every(key=>typeof b[key]==='number'&&Number.isFinite(b[key])))bounds={x:Number(b.x),y:Number(b.y),width:Number(b.width),height:Number(b.height)};
    items.push([id,{draft:value.draft.slice(0,4000),bounds,reopen:value.reopen===true,updated:typeof value.updated==='number'&&Number.isFinite(value.updated)?value.updated:0}]);
  }
  return Object.fromEntries(items.sort(([,a],[,b])=>b.updated-a.updated).slice(0,16));
}
export function retainChatAccounts(raw:unknown,account:string,current:Record<string,SavedChat>):Record<string,Record<string,SavedChat>>{
  const other=record(raw)?Object.entries(raw).filter(([id])=>/^\d{5,22}$/.test(id)&&id!==account).slice(0,16).map(([id,data])=>[id,readChatHistory(data)] as const):[];
  other.sort(([,a],[,b])=>Math.max(0,...Object.values(b).map(x=>x.updated))-Math.max(0,...Object.values(a).map(x=>x.updated)));
  return Object.fromEntries([...other.slice(0,2),[account,readChatHistory(current)]]);
}
