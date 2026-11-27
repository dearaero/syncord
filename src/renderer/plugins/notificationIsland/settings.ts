import {definePluginSettings} from '../../api/plugin/settingsDef';
export const ISLAND_ID='notification-island',ISLAND_SETTINGS='Syncord-notification-island-settings';
/** Event kinds; each has its own on/off switch under the same key. */
export const KINDS=['mention','dm','reply','keyword','voiceJoin','voiceLeave','stream','call','update','sp','badge','pluginError','friendSyncord'] as const;
export type Kind=typeof KINDS[number];
const toggles=Object.fromEntries(KINDS.map(kind=>[kind,{type:'boolean' as const,default:true}])) as Record<Kind,{type:'boolean';default:boolean}>;
export const islandSettings=definePluginSettings({
  ...toggles,
  duration:{type:'number',default:6},
  silent:{type:'boolean',default:false},
  /** `friends` or `selected`. */
  voiceMode:{type:'string',default:'friends'},
  /** JSON array of user ids followed in `selected` mode. */
  voiceUsers:{type:'string',default:'[]'},
  /** Comma separated, case-insensitive. */
  keywords:{type:'string',default:''},
  /** `session` or `persistent`. */
  historyMode:{type:'string',default:'session'},
  history:{type:'string',default:'[]'},
  /** JSON array of friend ids already known to use Syncord. */
  knownSyncord:{type:'string',default:''},
});
const handle=()=>islandSettings.bind(ISLAND_ID);
export type Options={enabled:Record<Kind,boolean>;duration:number;silent:boolean;voiceMode:'friends'|'selected';voiceUsers:string[];keywords:string[];historyMode:'session'|'persistent'};
export function ids(raw:unknown):string[]{try{const list=JSON.parse(String(raw));return Array.isArray(list)?list.filter((id):id is string=>typeof id==='string'&&/^\d{17,20}$/.test(id)):[];}catch{return [];}}
export function options():Options{
  const raw=handle().snapshot();
  const enabled=Object.fromEntries(KINDS.map(kind=>[kind,raw[kind]!==false])) as Record<Kind,boolean>;
  const duration=typeof raw.duration==='number'&&Number.isFinite(raw.duration)?Math.max(3,Math.min(30,raw.duration)):6;
  const keywords=String(raw.keywords??'').split(',').map(word=>word.trim().toLowerCase()).filter(Boolean).slice(0,30);
  return {enabled,duration,silent:raw.silent===true,voiceMode:raw.voiceMode==='selected'?'selected':'friends',voiceUsers:ids(raw.voiceUsers),keywords,historyMode:raw.historyMode==='persistent'?'persistent':'session'};
}
type Writable=Kind|'duration'|'silent'|'voiceMode'|'voiceUsers'|'keywords'|'historyMode'|'history'|'knownSyncord';
export function setOption(key:Writable,value:boolean|number|string):void{
  const def=islandSettings.schema[key];if(def.type!==typeof value)return;
  if(key==='duration')handle().set(key,Math.max(3,Math.min(30,Number(value))));
  else if(key==='voiceMode')handle().set(key,value==='selected'?'selected':'friends');
  else if(key==='historyMode')handle().set(key,value==='persistent'?'persistent':'session');
  else handle().set(key,value as never);
  // Stored state, not a preference: repainting the panel on every event is pointless.
  if(key!=='history'&&key!=='knownSyncord')window.dispatchEvent(new Event(ISLAND_SETTINGS));
}
export const readRaw=(key:'history'|'knownSyncord'):string=>String(handle().get(key)??'');
