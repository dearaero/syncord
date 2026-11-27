import {isDiscordRestApi} from '../../webpack/common/rest';
import type {IslandItem} from './core';
const webpack=()=>window.Syncord?.webpack;
const safe=<T>(fn:()=>T,fallback:T):T=>{try{return fn();}catch{return fallback;}};

/** Same route + jump pair Global Message Search uses. */
export async function openItem(item:IslandItem):Promise<void>{
  if(!item.channelId)return;
  const router=(webpack()?.findByProps?.('transitionTo','back','forward')??webpack()?.findByProps?.('transitionTo')) as {transitionTo?(path:string):unknown}|undefined;
  const route=`/channels/${item.guildId??'@me'}/${item.channelId}${item.messageId?'/'+item.messageId:''}`;
  if(router?.transitionTo)await router.transitionTo(route);else{history.pushState(null,'',route);window.dispatchEvent(new PopStateEvent('popstate'));}
}

/** Discord's own BULK_ACK action, as Mark All as Read dispatches it. */
export function markRead(item:IslandItem):boolean{
  if(!item.channelId)return false;
  const store=window.Syncord?.common?.stores.ReadStateStore as {lastMessageId?:(id:string)=>unknown}|undefined;
  const messageId=safe(()=>store?.lastMessageId?.(item.channelId!),undefined)??item.messageId;
  const flux=window.Syncord?.common?.flux.FluxDispatcher as {dispatch?:(action:unknown)=>unknown}|undefined;
  if(typeof messageId!=='string'||typeof flux?.dispatch!=='function')return false;
  flux.dispatch({type:'BULK_ACK',context:'APP',channels:[{channelId:item.channelId,messageId,readStateType:0}]});
  return true;
}

type Rest={post(options:Record<string,unknown>):Promise<unknown>;put(options:Record<string,unknown>):Promise<unknown>};
/** Discord's own REST client (it adds the session itself), as DM Closer uses it. Rejects on any HTTP error. */
function rest():Rest{
  const preferred=window.Syncord?.common?.utils?.RestAPI,candidate=isDiscordRestApi(preferred)?preferred:webpack()?.find?.(isDiscordRestApi);
  if(!isDiscordRestApi(candidate))throw new Error('Discord REST client unavailable');
  return candidate as unknown as Rest;
}
const flags={retries:0,oldFormErrors:true,rejectWithError:true,failImmediatelyWhenRateLimited:true};

/** Replies to the notified message; the gateway echo then shows it in the chat. */
export async function reply(item:IslandItem,content:string):Promise<void>{
  const text=content.trim().slice(0,2000);if(!text||!item.channelId)return;
  const body:Record<string,unknown>={content:text,tts:false,flags:0,nonce:String(BigInt(Date.now()-1420070400000)<<22n)};
  if(item.messageId){
    body.message_reference={message_id:item.messageId,channel_id:item.channelId,...(item.guildId?{guild_id:item.guildId}:{}),fail_if_not_exists:false};
    body.allowed_mentions={parse:['users','roles','everyone'],replied_user:true};
  }
  await rest().post({url:`/channels/${item.channelId}/messages`,body,...flags});
}

export const QUICK_REACTIONS=['👍','❤️','😂','🔥'] as const;
export async function react(item:IslandItem,emoji:string):Promise<void>{
  if(!item.channelId||!item.messageId||!(QUICK_REACTIONS as readonly string[]).includes(emoji))return;
  await rest().put({url:`/channels/${item.channelId}/messages/${item.messageId}/reactions/${encodeURIComponent(emoji)}/@me`,query:{location:'Message',type:0},...flags});
}
