import { t as i18nText } from "../../i18n";
/** Platform snapshots come from Discord's own presence store, never another connection or request. */
export type PresenceStatus='online'|'idle'|'dnd';
export type PlatformIcon='desktop'|'mobile'|'web'|'vr'|'console'|'other';
export type PlatformIndicator={id:string;icon:PlatformIcon;label:string;status:PresenceStatus;source:'session'|'activity'};
export type PlatformPresenceStore={getStatus:(id:string)=>unknown;getClientStatus:(id:string)=>unknown;getActivities?:(id:string)=>unknown};
const active=(value:unknown):value is PresenceStatus=>value==='online'||value==='idle'||value==='dnd';
const record=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
const clients:readonly [string,PlatformIcon,()=>string][]=[['desktop','desktop',()=>i18nText("ui.desktop")],['mobile','mobile',()=>i18nText("ui.mobile")],['web','web',()=>i18nText("ui.browser")],['vr','vr',()=>'VR'],
  ['embedded','console',()=>i18nText("ui.console_embedded")],['console','console',()=>i18nText("ui.console")],['xbox','console',()=>i18nText("ui.xbox")],['playstation','console',()=>'PlayStation'],['ps4','console',()=>'PlayStation 4'],['ps5','console',()=>'PlayStation 5']];
const activityPlatforms:Readonly<Record<string,string>>={get xbox(){return i18nText("ui.xbox");},ps4:'PlayStation 4',ps5:'PlayStation 5',get meta_quest(){return i18nText("ui.meta_quest");}};
export function platformIndicators(status:unknown,clientStatus:unknown,activities:unknown,showActivities=true):PlatformIndicator[] {
  // Stale client/activity data must not expose an offline/invisible presence.
  if(status!==undefined&&!active(status))return [];
  const state=record(clientStatus),result:PlatformIndicator[]=[];
  for(const [id,icon,label] of clients){const value=state?.[id];if(active(value))result.push({id,icon,get label(){return label();},status:value,source:'session'});}
  if(state&&Object.keys(state).some(key=>!clients.some(([id])=>id===key)&&active(state[key])))
    result.push({id:'other',icon:'other',get label() { return i18nText("ui.other_discord_client"); },status:active(status)?status:'online',source:'session'});
  // A game platform is not proof that Discord itself is logged in on that device.
  // Only explicit reported platforms are accepted; game names/assets never infer hardware.
  if(showActivities&&(active(status)||result.length)&&Array.isArray(activities)){
    const seen=new Set<string>();
    for(const raw of activities.slice(0,32)){
      const activity=record(raw),platform=activity?.platform;
      if(typeof platform!=='string'||!Object.hasOwn(activityPlatforms,platform)||seen.has(platform)||![0,1,5].includes(activity?.type as number))continue;
      seen.add(platform);
      const icon=platform==='meta_quest'?'vr':'console';
      if(result.some(row=>row.source==='session'&&(row.id===platform||(icon==='vr'&&row.icon==='vr')||(icon==='console'&&row.icon==='console'))))continue;
      result.push({id:`activity-${platform}`,icon,get label(){return activityPlatforms[platform];},status:active(status)?status:result[0].status,source:'activity'});
    }
  }
  return result;
}
export function readPlatforms(store:PlatformPresenceStore|undefined,id:string,showActivities:boolean):PlatformIndicator[] {
  if(!store||!/^\d{17,20}$/.test(id))return [];
  try{return platformIndicators(store.getStatus(id),store.getClientStatus(id),showActivities?store.getActivities?.(id):undefined,showActivities);}catch{return [];}
}
export function isPlatformPresenceStore(value:unknown):value is PlatformPresenceStore {
  const candidate=record(value);return typeof candidate?.getStatus==='function'&&typeof candidate?.getClientStatus==='function';
}
export function platformLabel(row:PlatformIndicator):string {
  return row.source==='activity'?i18nText("ui.value_activity_reported_by_discord_not_a_confirmed_discord_login", {v0: row.label}):
    `${row.label} · ${row.status==='dnd'?i18nText("ui.do_not_disturb"):row.status==='idle'?i18nText("ui.idle"):i18nText("ui.online")}`;
}
