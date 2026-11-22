import {settings} from '../../api/settings';
import {normalize,change,validId,type HiddenData,type HiddenKind} from './model';
export const HIDDEN_ID='hidden-items';
export const HIDDEN_EVENT='Syncord-hidden-items-change';
const QUICK_ACCESS_KEY=`plugins.${HIDDEN_ID}.data.quickAccess`;
export function quickAccessEnabled():boolean{return settings.get<boolean>(QUICK_ACCESS_KEY,true)!==false;}
export function setQuickAccessEnabled(enabled:boolean):void{settings.set(QUICK_ACCESS_KEY,enabled);notify();}
export function nativeStore<T>(name:string):T|undefined {
  const stores=window.Syncord?.common?.stores as unknown as Record<string,unknown>|undefined;
  return (stores?.[name]??window.Syncord?.webpack?.findByStoreName?.(name)) as T|undefined;
}
export function accountId():string|undefined {
  try{const id=nativeStore<{getCurrentUser?:()=>{id?:unknown}|undefined}>('UserStore')?.getCurrentUser?.()?.id;return validId(id)?id:undefined;}catch{return undefined;}
}
const key=(account:string):string=>`plugins.${HIDDEN_ID}.data.account.${account}`;
let lastAccount:string|undefined,lastRaw:unknown,data:HiddenData=normalize(null),sets={guild:new Set<string>(),dm:new Set<string>(),group:new Set<string>()};
function read():HiddenData {
  const account=accountId(),raw=account?settings.get(key(account)):undefined;
  if(account!==lastAccount||raw!==lastRaw){lastAccount=account;lastRaw=raw;data=normalize(raw);sets={guild:new Set(data.guild),dm:new Set(data.dm),group:new Set(data.group)};}
  return data;
}
export function hiddenData():HiddenData{const v=read();return{guild:[...v.guild],dm:[...v.dm],group:[...v.group]};}
export function hiddenSet(kind:HiddenKind):ReadonlySet<string>{read();return sets[kind];}
export function isHidden(kind:HiddenKind,id:string):boolean{read();return sets[kind].has(id);}
export function setHidden(kind:HiddenKind,id:string,hide:boolean,expectedAccount:string|undefined):boolean {
  if(!expectedAccount||expectedAccount!==accountId()||!validId(expectedAccount)||!validId(id))return false;
  settings.set(key(expectedAccount),change(read(),kind,id,hide));notify();return true;
}
export function restoreAll(expectedAccount:string|undefined):boolean {
  if(!expectedAccount||expectedAccount!==accountId())return false;
  settings.set(key(expectedAccount),normalize(null));notify();return true;
}
export function notify():void{window.dispatchEvent(new Event(HIDDEN_EVENT));}
export type HiddenEntry={kind:HiddenKind;id:string;name:string};
export function hiddenEntries():HiddenEntry[] {
  const raw=hiddenData(),out:HiddenEntry[]=[];
  const guilds=nativeStore<{getGuild?:(id:string)=>{name?:string}|undefined}>('GuildStore');
  const channels=nativeStore<{getChannel?:(id:string)=>{name?:string;recipients?:string[]}|undefined}>('ChannelStore');
  const users=nativeStore<{getUser?:(id:string)=>{globalName?:string;global_name?:string;username?:string}|undefined}>('UserStore');
  for(const kind of ['guild','dm','group'] as const)for(const id of raw[kind]){
    let name=id;try{if(kind==='guild')name=guilds?.getGuild?.(id)?.name||id;
      else {const c=channels?.getChannel?.(id);const u=kind==='dm'&&c?.recipients?.[0]?users?.getUser?.(c.recipients[0]):undefined;name=c?.name||u?.globalName||u?.global_name||u?.username||id;}}
    catch{/* Unavailable/deleted entries remain restorable by ID. */}
    out.push({kind,id,name});
  }
  return out;
}
