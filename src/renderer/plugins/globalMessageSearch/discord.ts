import { canonicalMessage as i18nText } from "../../i18n";
import {isDiscordRestApi} from '../../webpack/common/rest';
import {validId,type RestResponse} from '../messageCleaner/engine';
import {queryFor,type Guild,type Hit} from './model';
import type {Port} from './engine';
type GuildStore={getGuilds?():Record<string,{id:string;name?:string;unavailable?:boolean}>;getGuild?(id:string):{id:string;unavailable?:boolean}|undefined};
function store<T>(name:string):T|undefined{return ((window.Syncord?.common?.stores as unknown as Record<string,unknown>|undefined)?.[name]??window.Syncord?.webpack?.findByStoreName?.(name)) as T|undefined;}
export function accountId():string|undefined{const id=store<{getCurrentUser?():{id?:string}|undefined}>('UserStore')?.getCurrentUser?.()?.id;return validId(id)?id:undefined;}
export function assertAccount(id:string):void{if(!validId(id)||accountId()!==id)throw Error("Your Discord account changed or is unavailable. Reopen Global Message Search.");}
export function assertGuild(id:string):void{const guild=store<GuildStore>('GuildStore')?.getGuild?.(id);if(!validId(id)||!guild||guild.id!==id||guild.unavailable)throw Error("This server is no longer available.");}
export function availableGuilds():Guild[]{
 const guilds=store<GuildStore>('GuildStore')?.getGuilds?.();if(!guilds||typeof guilds!=='object')throw Error("Discord’s server list is not ready. Try again after it loads.");
 return Object.values(guilds).filter(g=>g&&validId(g.id)&&!g.unavailable).map(g=>({id:g.id,name:(g.name||'Unnamed server').slice(0,200)})).sort((a,b)=>a.name.localeCompare(b.name));
}
export function currentGuild():string|undefined{return store<{getGuildId?():string}>('SelectedGuildStore')?.getGuildId?.();}
export function channelName(id:string):string{const c=store<{getChannel?(id:string):{name?:string}|undefined}>('ChannelStore')?.getChannel?.(id);return c?.name?'#'+c.name:'Channel '+id;}
export function discordPort(account:string):Port{
 const preferred=window.Syncord?.common?.utils?.RestAPI,candidate=isDiscordRestApi(preferred)?preferred:window.Syncord?.webpack?.find?.(isDiscordRestApi);
 if(!isDiscordRestApi(candidate))throw Error("Discord’s search API is not ready. Open a chat and try again.");
 const rest=candidate as unknown as {get(options:Record<string,unknown>):Promise<RestResponse>};
 return{assertAccount,assertGuild,request(guildId,criteria,offset,signal){
  assertAccount(account);assertGuild(guildId);const query=queryFor(criteria,offset);
  // Let the native shared queue wait for its existing cooldown. Its immediate
  // failure mode manufactures another 429 without sending an HTTP request,
  // which would falsely grow our own recovery backoff a second time.
  return new Promise<RestResponse>((resolve,reject)=>{
   // Native HTTP retains an abort handler until the request is collected. A
   // child signal prevents completed requests accumulating on the whole-search signal.
   const requestController=new AbortController();
   const aborted=():void=>{signal?.removeEventListener('abort',aborted);requestController.abort();reject(new DOMException('Stopped','AbortError'));};
   if(signal?.aborted){aborted();return;}signal?.addEventListener('abort',aborted,{once:true});
   const done=():void=>signal?.removeEventListener('abort',aborted);
   try{Promise.resolve(rest.get({url:`/guilds/${guildId}/messages/search`,query,retries:0,oldFormErrors:true,rejectWithError:true,failImmediatelyWhenRateLimited:false,signal:requestController.signal})).then(r=>{done();resolve(r);},e=>{done();reject(e);});}catch(e){done();reject(e);}
  });
 }};
}
export async function jumpToHit(hit:Hit,account:string):Promise<void>{
 assertAccount(account);assertGuild(hit.guildId);if(!validId(hit.channelId)||!validId(hit.id))throw Error("Invalid message reference.");
 const cached=store<{getChannel?(id:string):{guild_id?:string;guildId?:string}|undefined}>('ChannelStore')?.getChannel?.(hit.channelId);
 if(cached&&(cached.guild_id??cached.guildId)!==hit.guildId)throw Error("This message’s channel no longer belongs to the selected server.");
 const webpack=window.Syncord?.webpack,router=(webpack?.findByProps?.('transitionTo','back','forward')??webpack?.findByProps?.('transitionTo')) as {transitionTo?(path:string):unknown}|undefined;
 const route=`/channels/${hit.guildId}/${hit.channelId}/${hit.id}`;
 if(router?.transitionTo)await router.transitionTo(route);else{history.pushState(null,'',route);window.dispatchEvent(new PopStateEvent('popstate'));}
 assertAccount(account);
 const preferred=window.Syncord?.common?.actions.MessageActions,actions=(preferred&&typeof preferred.jumpToMessage==='function'?preferred:webpack?.findByProps?.('jumpToMessage','fetchMessages')) as {jumpToMessage?(options:Record<string,unknown>):unknown}|undefined;
 if(actions?.jumpToMessage)await actions.jumpToMessage({channelId:hit.channelId,messageId:hit.id,flash:true,context:i18nText("ui.syncord_global_message_search")});
}
export function watchAccount(changed:()=>void):()=>void{const users=store<{addChangeListener?(fn:()=>void):void;removeChangeListener?(fn:()=>void):void}>('UserStore');if(!users?.addChangeListener||!users.removeChangeListener)return()=>{};users.addChangeListener(changed);return()=>users.removeChangeListener!(changed);}
