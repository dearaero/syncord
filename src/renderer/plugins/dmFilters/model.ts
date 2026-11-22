import { t as i18nText } from "../../i18n";
export type DmFilter='all'|'groups'|'dm';
export const DM_FILTERS:readonly {id:DmFilter;label:string}[]=[{id:'all',get label() { return i18nText("ui.all"); }},{id:'groups',get label() { return i18nText("ui.groups"); }},{id:'dm',get label(){return i18nText('ui.dm');}}];
export function parseFilter(value:unknown):DmFilter {return value==='groups'||value==='dm'?value:'all';}
export function filterPrivateIds(ids:readonly string[],channels:Record<string,unknown>,mode:DmFilter,lookup?:(id:string)=>unknown):readonly string[] {
  if(mode==='all')return ids;
  const type=mode==='groups'?3:1;
  return ids.filter(id=>{
    try{const channel=channels[id]??lookup?.(id);return channel!==null&&typeof channel==='object'&&(channel as {type?:unknown}).type===type;}catch{return false;}
  });
}
