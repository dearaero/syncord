import {listChannelChoices,channelTitle,channelAvatarUrl} from '../multiChatCanvas/discord';
import {t} from '../../i18n';
import {snowflake,type ChannelRef,type Location} from './model';
export type FluxStore={addChangeListener?:(listener:()=>void)=>void;removeChangeListener?:(listener:()=>void)=>void};
export type Channel={id:string;guild_id?:string|null;parent_id?:string|null;type:number;name?:string;recipients?:string[];};
export function store<T>(name:string):T|undefined {
 const common=window.Syncord?.common?.stores as unknown as Record<string,unknown>|undefined;
 return (common?.[name]??window.Syncord?.webpack?.findByStoreName?.(name)) as T|undefined;
}
export function accountId():string|undefined {try{const id=store<{getCurrentUser?:()=>{id?:unknown}|null}>('UserStore')?.getCurrentUser?.()?.id;return snowflake(id)?id:undefined;}catch{return;}}
export function channelFor(ref:ChannelRef):Channel|undefined {
 try{
  const channel=store<{getChannel?:(id:string)=>Channel|undefined}>('ChannelStore')?.getChannel?.(ref.channelId);
  if(ref.guildId==='@me')return accountId()&&channel?.id===ref.channelId&&channel.guild_id==null&&[1,3].includes(channel.type)?channel:undefined;
  const guild=store<{getGuild?:(id:string)=>unknown}>('GuildStore')?.getGuild?.(ref.guildId);
  const permissions=store<{can?:(permission:bigint,channel:Channel)=>boolean}>('PermissionStore');
  if(guild&&channel?.id===ref.channelId&&channel.guild_id===ref.guildId&&[0,5].includes(channel.type)&&permissions?.can?.(1024n,channel)===true)return channel;
 }catch{/* Unknown membership/permissions never grant access. */}
 return;
}
export function resolveChannel(id:string):ChannelRef|undefined {
 if(!snowflake(id))return;try{const raw=store<{getChannel?:(id:string)=>Channel|undefined}>('ChannelStore')?.getChannel?.(id);const ref={channelId:id,guildId:raw&&[1,3].includes(raw.type)?'@me':raw?.guild_id??''};return channelFor(ref)?ref:undefined;}catch{return;}
}
export function guildName(id:string):string {if(id==='@me')return t('ui.direct_messages');try{return store<{getGuild?:(id:string)=>{name?:string}|undefined}>('GuildStore')?.getGuild?.(id)?.name??id;}catch{return id;}}
export function unread(ref:ChannelRef):{unread:boolean;mentions:number} {
 if(!channelFor(ref))return{unread:false,mentions:0};
 try{const state=store<{hasUnread?:(id:string)=>boolean;getMentionCount?:(id:string)=>number}>('ReadStateStore');const count=state?.getMentionCount?.(ref.channelId);return{unread:state?.hasUnread?.(ref.channelId)===true,mentions:typeof count==='number'&&Number.isSafeInteger(count)?Math.max(0,count):0};}catch{return{unread:false,mentions:0};}
}
export type RouteManager={addRouteChangeListener:(listener:(location:{pathname:string;key?:string},action:unknown)=>void)=>()=>void;getHistory:()=>{location:{pathname:string;key?:string}}};
export type Router={transitionTo:(path:string)=>unknown};
/** Current Routing/Utils logs this semantic marker even when export names are minified.
 * Inspect already-loaded functions only; never require factories or guess export keys. */
export function isNativeTransition(value:unknown):value is (path:string)=>unknown {
 if(typeof value!=='function')return false;
 try{const source=Function.prototype.toString.call(value);return source.includes('transitionTo - Transitioning to')&&source.includes('new URL(')&&source.includes('.pathname')&&source.includes('.push(')&&source.includes('.replace(')&&! /\bthis\b/.test(source);}catch{return false;}
}
export function routing():{router:Router;manager?:RouteManager}|undefined {
 const webpack=window.Syncord?.webpack;
 const common=window.Syncord?.common?.utils?.NavigationRouter as Partial<Router>|undefined;
 let router=(typeof common?.transitionTo==='function'?common:undefined)??(webpack?.findByProps?.('transitionTo','back','forward')??webpack?.findByProps?.('transitionTo')) as Partial<Router>|undefined;
 if(typeof router?.transitionTo!=='function'){
  const transition=webpack?.find?.(isNativeTransition);
  if(isNativeTransition(transition))router={transitionTo:path=>transition(path)};
 }
 if(typeof router?.transitionTo!=='function')return;
 const candidate=webpack?.findByProps?.('addRouteChangeListener','getHistory') as Partial<RouteManager>|undefined;
 const manager=typeof candidate?.addRouteChangeListener==='function'&&typeof candidate.getHistory==='function'?candidate as RouteManager:undefined;
 return{router:router as Router,manager};
}
/** Observe Discord's real history, without performing a synthetic browser navigation. */
export function routeLocation(manager?:RouteManager):Location {
 try{const location=manager?.getHistory().location;if(typeof location?.pathname==='string')return{pathname:location.pathname,key:typeof location.key==='string'?location.key:undefined};}catch{/* A stale observer cannot block the native navigation action. */}
 const state:unknown=window.history.state;
 const key=state&&typeof state==='object'?(state as {key?:unknown}).key:undefined;
 return{pathname:window.location.pathname,key:typeof key==='string'?key:undefined};
}

export function channelLabel(ref:ChannelRef):string {return channelFor(ref)?channelTitle(ref.channelId).title:t('virtual.unavailable');}
export function channelIcon(ref:ChannelRef):string|undefined {return ref.guildId==='@me'&&channelFor(ref)?channelAvatarUrl(ref.channelId):undefined;}
export function channelChoices():{ref:ChannelRef;name:string;guild:string}[] {return listChannelChoices().flatMap(item=>{const ref=resolveChannel(item.id);return ref?[{ref,name:item.label,guild:ref.guildId==='@me'?item.sublabel:guildName(ref.guildId)}]:[];}).slice(0,10000);}
