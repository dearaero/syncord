import {isDiscordRestApi} from '../../webpack/common/rest';
import {validId,record,text,type Person,type Group,type Guild,type Relationship,type Input,type Delta,type Entry} from './types';
export function store<T>(name:string):T|undefined {
 const common=window.Syncord?.common?.stores as unknown as Record<string,unknown>|undefined;
 return (common?.[name]??window.Syncord?.webpack?.findByStoreName?.(name)) as T|undefined;
}
const safely=<T>(fn:()=>T,fallback:T):T=>{try{return fn();}catch{return fallback;}};
type Users={getCurrentUser?():{id?:string};getUser?(id:string):unknown};
export function accountId():string {return safely(()=>{const id=store<Users>('UserStore')?.getCurrentUser?.()?.id;return validId(id)?id:'';},'');}
export function connected():boolean {return safely(()=>store<{isConnected?():boolean}>('GatewayConnectionStore')?.isConnected?.()===true,false);}
export function person(id:string,raw?:unknown):Person {
 const supplied=record(raw),cached=record(safely(()=>store<Users>('UserStore')?.getUser?.(id),undefined));
 const username=text(supplied.username||cached.username,80)||id;
 return{id,username,name:text(supplied.globalName||supplied.global_name||cached.globalName||cached.global_name||supplied.username||cached.username,80)||id};
}
export function group(raw:unknown):Group|undefined {
 const c=record(raw);if(!validId(c.id)||c.type!==3||c.guild_id||c.guildId)return;
 const members:Record<string,Person>={};
 if(Array.isArray(c.recipients))for(const value of c.recipients){const id=typeof value==='string'?value:record(value).id;if(validId(id))members[id]=person(id,typeof value==='object'?value:undefined);}
 return{id:c.id,name:text(c.name)||Object.values(members).map(p=>p.name).slice(0,4).join(', ')||c.id,members,membersComplete:Array.isArray(c.recipients)};
}
function guild(raw:unknown):Guild|undefined {
 const g=record(raw);if(!validId(g.id))return;
 const cached=safely(()=>store<{getGuild?(id:string):{name?:string}}>('GuildStore')?.getGuild?.(g.id as string),undefined);
 return{id:g.id,name:text(g.name||record(g.properties).name||cached?.name)||g.id,...(g.unavailable===true||g.geo_restricted===true?{unavailable:true}:{})};
}
export function partialReady(action:unknown):boolean {
 const failed=record(action).failedStates;
 return Array.isArray(failed)?failed.length>0:failed!==undefined&&failed!==null&&failed!==false&&failed!==0&&(typeof failed!=='object'||Object.keys(failed).length>0);
}
function relationship(raw:unknown):Relationship|undefined {const r=record(raw);if(!validId(r.id)||!Number.isInteger(r.type)||Number(r.type)<0||Number(r.type)>6)return;return{...person(r.id,r.user),type:Number(r.type)};}
export function relationshipType(id:string):number|undefined {return safely(()=>store<{getRelationshipType?(id:string):number}>('RelationshipStore')?.getRelationshipType?.(id),undefined);}
export function cachedInput(groupsComplete=false):Input {
 const result:Input={complete:{}};
 const relations=safely(()=>store<{getMutableRelationships?():unknown;getRelationships?():unknown}>('RelationshipStore'),undefined);
 const values=safely(()=>relations?.getMutableRelationships?.()??relations?.getRelationships?.(),undefined);
 if(values instanceof Map||values&&typeof values==='object'&&!Array.isArray(values)){
  const rows=values instanceof Map?[...values.entries()]:Object.entries(values as Record<string,unknown>);const map:Record<string,Relationship>={};let valid=true;
  for(const [id,type]of rows){if(!validId(id)||!Number.isInteger(type)){valid=false;break;}const r=relationship({id,type});if(!r){valid=false;break;}if(r.type)map[id]=r;}
  if(valid){result.relationships=map;result.complete!.relationships=true;}
 }
 const channels=safely(()=>store<{getMutablePrivateChannels?():Record<string,unknown>}>('ChannelStore')?.getMutablePrivateChannels?.(),undefined);
 if(channels&&typeof channels==='object'){
  result.groups={};let valid=true;for(const raw of Object.values(channels)){const c=record(raw),g=group(raw);if(!validId(c.id)||(c.type!==1&&c.type!==3)||c.type===3&&!g)valid=false;if(g)result.groups[g.id]=g;}result.complete!.groups=groupsComplete&&valid;
 }
 const guilds=safely(()=>store<{getGuilds?():Record<string,unknown>}>('GuildStore')?.getGuilds?.(),undefined);
 const availability=store<{unavailableGuilds?:string[];isUnavailable?(id:string):boolean}>('GuildAvailabilityStore');
 const unavailable=safely(()=>availability?.unavailableGuilds,undefined);
 if(guilds&&typeof guilds==='object'&&availability&&Array.isArray(unavailable)){
  result.guilds={};for(const raw of Object.values(guilds)){const g=guild(raw);if(g)result.guilds[g.id]={...g,unavailable:g.unavailable||safely(()=>availability.isUnavailable?.(g.id)===true,false)};}
  for(const id of unavailable)if(validId(id)&&!result.guilds[id])result.guilds[id]={id,name:id,unavailable:true};
  const restricted=safely(()=>store<{getGeoRestrictedGuilds?():unknown[]}>('GeoRestrictedGuildStore')?.getGeoRestrictedGuilds?.(),[]);
  if(Array.isArray(restricted))for(const raw of restricted){const row=guild(raw);if(row)result.guilds[row.id]={...row,unavailable:true};}
  result.complete!.guilds=true;
 }
 return result;
}
export function connectionInput(action:unknown):Input {
 const e=record(action),result:Input={complete:{}},complete=!partialReady(action);
 if(Array.isArray(e.relationships)){result.relationships={};let valid=true;for(const value of e.relationships){const r=relationship(value);if(!r)valid=false;else if(r.type)result.relationships[r.id]=r;}result.complete!.relationships=complete&&valid;}
 if(Array.isArray(e.guilds)&&Array.isArray(e.unavailableGuilds)){
  result.guilds={};for(const value of e.guilds){const g=guild(value);if(g)result.guilds[g.id]=g;}
  for(const id of e.unavailableGuilds)if(validId(id))result.guilds[id]={id,name:id,unavailable:true};result.complete!.guilds=complete;
  if(Array.isArray(e.geoRestrictedGuilds))for(const raw of e.geoRestrictedGuilds){const row=guild(raw);if(row)result.guilds[row.id]={...row,unavailable:true};}
 }
 if(Array.isArray(e.initialPrivateChannels)){result.groups={};for(const c of e.initialPrivateChannels){const g=group(c);if(g)result.groups[g.id]=g;}}
 return result;
}
export function deltas(action:unknown):Delta[] {
 const e=record(action),value=record(e.relationship),c=record(e.channel),g=record(e.guild),u=record(e.user);
 switch(e.type){
  case'RELATIONSHIP_ADD':case'RELATIONSHIP_UPDATE':{const r=relationship(value);return r?[{scope:'relationship',id:r.id,...(r.type?{value:r}:{})}]:[];}
  case'RELATIONSHIP_REMOVE':return validId(value.id)?[{scope:'relationship',id:value.id}]:[];
  case'CHANNEL_CREATE':{const row=group(c);return row?[{scope:'group',id:row.id,value:row}]:[];}
  case'CHANNEL_UPDATES':return Array.isArray(e.channels)?e.channels.flatMap(raw=>{const row=group(raw);return row?[{scope:'group' as const,id:row.id,value:row}]:[];}):[];
  case'CHANNEL_DELETE':return validId(c.id)&&!c.guild_id&&!c.guildId&&(c.type===undefined||c.type===3)?[{scope:'group',id:c.id}]:[];
  case'CHANNEL_RECIPIENT_ADD':case'CHANNEL_RECIPIENT_REMOVE':return validId(e.channelId)&&validId(u.id)?[{scope:'member',id:e.channelId,user:person(u.id,u),added:e.type==='CHANNEL_RECIPIENT_ADD'}]:[];
  case'GUILD_CREATE':case'GUILD_UPDATE':{const row=guild(g);return row?[{scope:'guild',id:row.id,value:row}]:[];}
  case'GUILD_UNAVAILABLE':return validId(e.guildId)?[{scope:'guild',id:e.guildId,value:{id:e.guildId,name:e.guildId,unavailable:true}}]:[];
  case'GUILD_DELETE':if(g.unavailable!==undefined&&typeof g.unavailable!=='boolean'||g.geo_restricted!==undefined&&typeof g.geo_restricted!=='boolean')return[];return validId(g.id)?[{scope:'guild',id:g.id,...(g.unavailable===true||g.geo_restricted===true?{value:{id:g.id,name:text(g.name)||g.id,unavailable:true}}:{})}]:[];
  case'GUILD_MEMBER_REMOVE':return u.id===accountId()&&validId(e.guildId)?[{scope:'guild',id:e.guildId}]:[];
 }return[];
}
export const deltaKey=(d:Delta):string=>d.scope==='member'?`member:${d.id}:${d.user.id}:${d.added?'add':'remove'}`
 :d.scope==='relationship'?`relationship:${d.id}:${d.value?.type??0}`:`${d.scope}:${d.id}:${d.value?'present':'removed'}`;
export function nativeRest():Record<string,unknown>|undefined {
 const preferred=window.Syncord?.common?.utils.RestAPI;
 const found=isDiscordRestApi(preferred)?preferred:window.Syncord?.webpack?.find?.(isDiscordRestApi);
 return isDiscordRestApi(found)?found as unknown as Record<string,unknown>:undefined;
}
export function findActions(...props:string[]):Record<string,unknown>|undefined {return window.Syncord?.webpack?.findByProps?.(...props) as Record<string,unknown>|undefined;}
export function assertAccount(account:string):void {if(!account||accountId()!==account)throw Error("Your Discord account changed. Reopen this view.");}
type ProfileActions={openUserProfileModal(options:{userId:string}):unknown};
function profileActions():ProfileActions|undefined {
 const ready=window.Syncord?.common?.actions.UserProfileActions;
 if(typeof ready?.openUserProfileModal==='function')return ready as ProfileActions;
 const cached=findActions('openUserProfileModal');
 if(typeof cached?.openUserProfileModal==='function')return cached as ProfileActions;
 // Current Discord exports only the opener. It can be lazy until the first
 // profile click. Load only its identified action module, never arbitrary factories.
 const lazy=record(window.Syncord?.webpack?.findByCode?.('openUserProfileModal','UserProfileModalActionCreators'));
 return typeof lazy.openUserProfileModal==='function'?lazy as ProfileActions:undefined;
}
function directMessage(id:unknown,user:string):boolean {
 if(!validId(id))return false;
 const c=record(store<{getChannel?(id:string):unknown}>('ChannelStore')?.getChannel?.(id));
 if(c.id!==id||c.type!==1||c.guild_id||c.guildId)return false;
 const recipients=Array.isArray(c.recipients)?c.recipients.map(value=>typeof value==='string'?value:record(value).id):[];
 if(recipients.length)return recipients.length===1&&recipients[0]===user;
 return typeof c.getRecipientId==='function'&&c.getRecipientId.call(c)===user;
}
const running=new Set<string>();
export async function quickAction(action:'profile'|'dm'|'request',row:Entry,account:string,navigate?:()=>void,active:()=>boolean=()=>true):Promise<void> {
 const check=():void=>{assertAccount(account);if(row.accountId!==account||!active())throw Error("This relationship view is no longer active. Reopen it.");};
 check();const id=row.user?.id;if(!validId(id)||id===account)throw Error("No other user is associated with this event.");
 const key=`${account}:${id}:${action}`;if(running.has(key))throw Error("This action is already in progress.");running.add(key);
 const leave=():void=>{check();navigate?.();window.Syncord?.closeSettings?.();};
 try{
  if(action==='profile'){
   const m=profileActions();if(!m)throw Error("Discord’s profile action is not ready. Try again after opening a profile.");
   leave();await m.openUserProfileModal({userId:id});return;
  }
  if(action==='dm'){
   // Current Discord's DM opener uses this selector; its underlying router
   // exports are minified, so a named transitionTo module is not required.
   const selector=findActions('selectPrivateChannel');
   const preferred=window.Syncord?.common?.utils.NavigationRouter;
   const router=typeof selector?.selectPrivateChannel==='function'?undefined
    :typeof preferred?.transitionTo==='function'?preferred:findActions('transitionTo');
   if(typeof selector?.selectPrivateChannel!=='function'&&typeof router?.transitionTo!=='function')throw Error("Discord’s direct message navigation is not ready. Open a chat and try again.");
   const channels=store<{getDMFromUserId?(id:string):unknown}>('ChannelStore');
   let channelId=channels?.getDMFromUserId?.(id);
   if(!directMessage(channelId,id)){
    const preferred=window.Syncord?.common?.actions.ChannelActionCreators;
    const m=typeof preferred?.getOrEnsurePrivateChannel==='function'||typeof preferred?.ensurePrivateChannel==='function'?preferred
     :findActions('getOrEnsurePrivateChannel')??findActions('ensurePrivateChannel');
    // These native helpers create/reuse a single DM without navigating. Do not
    // pass an ID to openPrivateChannel: current Discord destructures recipientIds
    // from an options object, and an ID becomes an empty-recipient group request.
    if(typeof m?.getOrEnsurePrivateChannel==='function')channelId=await m.getOrEnsurePrivateChannel(id);
    else if(typeof m?.ensurePrivateChannel==='function')channelId=await m.ensurePrivateChannel([id]);
    else throw Error("Discord’s direct message action is not ready. Open a chat and try again.");
   }
   check();if(!directMessage(channelId,id))throw Error("Discord did not return a one-to-one DM for this user. No chat was opened.");
   leave();
   if(typeof selector?.selectPrivateChannel==='function')await selector.selectPrivateChannel(channelId);
   else if(typeof router?.transitionTo==='function')await router.transitionTo(`/channels/@me/${channelId}`);
   return;
  }
  if(relationshipType(id)!==0)throw Error("This user is already a friend, has a pending request, or is unavailable. Open their profile.");
  const module=findActions('addRelationship','removeRelationship'),add=module?.addRelationship;
  if(typeof add!=='function')throw Error("Discord’s friend request action is not ready. Open their profile.");
  check();await add.call(module,{userId:id,context:{location:'RelationshipNotifier'}});
 }finally{running.delete(key);}
}
