import {sharedDispatcher} from '../../api/discordEvents';
import {canViewChannel} from '../../api/discordEvents/access';
import {onUpdate,updateState} from '../../api/updater';
import {PLUGIN_START_FAILED} from '../../api/plugin/manager';
import type {PluginContext} from '../../api/plugin';
import {t} from '../../i18n';
import {ISLAND_ID,ids,options,readRaw,setOption,type Kind,type Options} from './settings';
import type {IslandItem} from './core';
import {avatarUrl,classifyMessage,displayName,firstLine,voiceChange,type Message,type User,type VoiceSnapshot} from './classify';

type Channel={id?:string;name?:string;type?:number;guild_id?:string;guildId?:string;recipients?:unknown[];rawRecipients?:User[]};

const safe=<T>(fn:()=>T,fallback:T):T=>{try{return fn();}catch{return fallback;}};
const stores=()=>window.Syncord?.common?.stores;
export const currentUserId=():string=>safe(()=>{const id=(stores()?.UserStore as {getCurrentUser?:()=>User|undefined}|undefined)?.getCurrentUser?.()?.id;return typeof id==='string'?id:'';},'');
const getUser=(id:string):User|undefined=>safe(()=>(stores()?.UserStore as {getUser?:(id:string)=>User|undefined}|undefined)?.getUser?.(id),undefined);
const getChannel=(id:string):Channel|undefined=>safe(()=>(stores()?.ChannelStore as {getChannel?:(id:string)=>Channel|undefined}|undefined)?.getChannel?.(id),undefined);
const guildName=(id:string):string=>safe(()=>String((stores()?.GuildStore as {getGuild?:(id:string)=>{name?:string}|undefined}|undefined)?.getGuild?.(id)?.name??''),'');
const isFriend=(id:string):boolean=>safe(()=>(stores()?.RelationshipStore as {isFriend?:(id:string)=>boolean}|undefined)?.isFriend?.(id)===true,false);
const friendIds=():string[]=>safe(()=>{const list=(stores()?.RelationshipStore as {getFriendIDs?:()=>unknown}|undefined)?.getFriendIDs?.();return Array.isArray(list)?list.filter((id):id is string=>typeof id==='string'):[];},[]);
const VOICE_TYPES=new Set([2,13]);
/** How a `<@id>` mention reads: guild nickname, then display name. */
export const userLabel=(id:string,guildId?:string):string=>{
  const nick=guildId?safe(()=>(stores()?.GuildMemberStore as {getNick?:(guild:string,user:string)=>string|null|undefined}|undefined)?.getNick?.(guildId,id),undefined):undefined;
  return (typeof nick==='string'&&nick?nick.slice(0,80):'')||displayName(getUser(id),'unknown-user');
};
/** How a `<#id>` mention reads; voice channels get a speaker instead of `#`. */
export const channelLabel=(id:string):string=>{const channel=getChannel(id);return channel?.name?`${VOICE_TYPES.has(channel.type??-1)?'🔊 ':'#'}${channel.name.slice(0,80)}`:'#?';};
function place(channel:Channel|undefined):string{
  if(!channel)return '';
  const guild=channel.guild_id??channel.guildId;
  if(!guild)return channel.type===3?(channel.name||t('island.direct')):t('island.direct');
  return `${guildName(guild)||'?'} · ${VOICE_TYPES.has(channel.type??-1)?'🔊 ':'#'}${channel.name??''}`.slice(0,120);
}
let sequence=0;
const itemId=():string=>`${Date.now().toString(36)}-${(sequence++).toString(36)}`;

/** Subscribes every event source; returns its cleanup. */
export function startSources(ctx:PluginContext,push:(item:IslandItem)=>void):()=>void{
  const cleanups:Array<()=>void>=[];
  const emit=(kind:Kind,item:Omit<IslandItem,'id'|'kind'|'at'>):void=>{if(options().enabled[kind])push({id:itemId(),kind,at:Date.now(),...item});};
  const dispatcher=sharedDispatcher();
  const listen=(type:string,fn:(action:unknown)=>void):void=>{if(!dispatcher)return;const guarded=(action:unknown):void=>{try{fn(action);}catch(err){ctx.log.warn(`${type} handler failed`,err);}};dispatcher.subscribe(type,guarded);cleanups.push(()=>dispatcher.unsubscribe(type,guarded));};
  if(!dispatcher)ctx.log.warn('Discord dispatcher unavailable; message and voice events are off');

  listen('MESSAGE_CREATE',raw=>{
    const action=raw as {channelId?:string;message?:Message;optimistic?:boolean};const message=action.message,channelId=action.channelId??message?.channel_id;
    if(action.optimistic||!message||!channelId)return;
    const channel=getChannel(channelId);
    const kind=classifyMessage(message,currentUserId(),options(),channel?.type);if(!kind||!canViewChannel(channelId))return;
    const focused=safe(()=>(stores()?.SelectedChannelStore as {getChannelId?:()=>string|undefined}|undefined)?.getChannelId?.(),undefined)===channelId&&document.hasFocus();
    if(focused)return;
    const body=firstLine(message.content??'')||(message.attachments?.length?t('island.attachment'):'');
    emit(kind,{title:displayName(message.author,'?'),body,place:place(channel),avatar:avatarUrl(message.author),channelId,guildId:channel?.guild_id??channel?.guildId??message.guild_id,messageId:message.id});
  });

  // Voice: Flux listeners run after the store updated, so the previous state is kept here.
  const voice=new Map<string,VoiceSnapshot>();
  let seeded=false,quietUntil=0;
  /** Re-reads who is in voice right now, silently. Bulk loads (gateway connect, lazy guilds) fill the store without VOICE_STATE_UPDATES. */
  const snapshot=():void=>{
    const all=safe(()=>(stores()?.VoiceStateStore as {getAllVoiceStates?:()=>Record<string,Record<string,{channelId?:string|null;selfStream?:boolean}>>}|undefined)?.getAllVoiceStates?.(),undefined);
    if(!all||typeof all!=='object')return;
    seeded=true;voice.clear();
    for(const guild of Object.values(all))for(const [userId,state]of Object.entries(guild??{}))voice.set(userId,{channelId:state?.channelId??null,stream:state?.selfStream===true});
  };
  // Right after (re)connecting Discord replays everyone already in voice; those are not fresh joins.
  const settle=():void=>{snapshot();quietUntil=Date.now()+10_000;};
  settle();
  for(const type of ['CONNECTION_OPEN','CONNECTION_OPEN_SUPPLEMENTAL','GUILD_CREATE','PASSIVE_UPDATE_V1','PASSIVE_UPDATE_V2'])listen(type,type.startsWith('CONNECTION')?settle:snapshot);
  const followed=(id:string,cfg:Options):boolean=>cfg.voiceMode==='selected'?cfg.voiceUsers.includes(id):isFriend(id);
  const onVoice=(state:{userId?:string;channelId?:string|null;selfStream?:boolean}):void=>{
    const userId=state.userId;if(typeof userId!=='string'||userId===currentUserId())return;
    const next={channelId:state.channelId??null,stream:state.selfStream===true},previous=voice.get(userId);voice.set(userId,next);
    // shortcut: without a seed, a first-seen user is recorded silently, so a mute toggle is not reported as a join.
    const cfg=options();if(Date.now()<quietUntil||!followed(userId,cfg)||(!previous&&!seeded))return;
    const kind=voiceChange(previous,next);if(!kind)return;
    const channelId=kind==='voiceLeave'?previous?.channelId??undefined:next.channelId??undefined,channel=channelId?getChannel(channelId):undefined,user=getUser(userId);
    emit(kind,{title:displayName(user,userId),body:t(kind==='voiceJoin'?'island.joined':kind==='voiceLeave'?'island.left':'island.streaming',{v0:channelId?`<#${channelId}>`:'?'}),place:place(channel),avatar:avatarUrl(user),channelId,guildId:channel?.guild_id??channel?.guildId});
  };
  listen('VOICE_STATE_UPDATES',raw=>{const list=(raw as {voiceStates?:unknown}).voiceStates;if(Array.isArray(list))for(const state of list)if(state&&typeof state==='object')onVoice(state as never);});

  const ringing=new Set<string>();
  const onCall=(raw:unknown):void=>{
    const action=raw as {channelId?:string;ringing?:unknown};const channelId=action.channelId;if(typeof channelId!=='string')return;
    const me=currentUserId(),rings=Array.isArray(action.ringing)&&action.ringing.includes(me);
    if(!rings){ringing.delete(channelId);return;}if(ringing.has(channelId))return;ringing.add(channelId);
    const channel=getChannel(channelId),otherId=safe(()=>(channel?.recipients??[]).find(id=>typeof id==='string'&&id!==me) as string|undefined,undefined),user=otherId?getUser(otherId):undefined;
    emit('call',{title:channel?.type===3&&channel.name?channel.name:displayName(user,'?'),body:t('island.calling'),place:place(channel),avatar:avatarUrl(user),channelId});
  };
  listen('CALL_CREATE',onCall);listen('CALL_UPDATE',onCall);
  listen('CALL_DELETE',raw=>{const id=(raw as {channelId?:string}).channelId;if(id)ringing.delete(id);});

  let announced=updateState().latest??'';
  cleanups.push(onUpdate(status=>{if((status.phase==='available'||status.phase==='ready')&&status.latest&&status.latest!==announced){announced=status.latest;emit('update',{title:'Syncord',body:t('island.updateBody',{v0:status.latest})});}}));

  const failed=(event:Event):void=>{const detail=(event as CustomEvent<{id?:unknown;name?:unknown}>).detail;if(!detail||detail.id===ISLAND_ID)return;emit('pluginError',{title:'Syncord',body:t('island.pluginBody',{v0:String(detail.name??detail.id).slice(0,80)})});};
  window.addEventListener(PLUGIN_START_FAILED,failed);cleanups.push(()=>window.removeEventListener(PLUGIN_START_FAILED,failed));

  // SP and badges: the bridge only answers for a linked account; anything else stays quiet.
  let balance:number|undefined,owned:Set<string>|undefined;
  const pollProfile=async():Promise<void>=>{
    const me=currentUserId(),cfg=options();if(!me||!ctx.ecosystemSelf||(!cfg.enabled.sp&&!cfg.enabled.badge))return;
    const profile=await ctx.ecosystemSelf.profile(me).catch(()=>undefined);if(!profile||typeof profile.balance!=='number')return;
    if(balance!==undefined&&profile.balance>balance)emit('sp',{title:'Syncord',body:t('island.spBody',{v0:profile.balance-balance,v1:profile.balance})});
    const next=new Set(profile.badges.map(badge=>badge.id));
    if(owned)for(const badge of profile.badges)if(!owned.has(badge.id))emit('badge',{title:'Syncord',body:t('island.badgeBody',{v0:badge.name.slice(0,60)})});
    balance=profile.balance;owned=next;
  };
  // shortcut: at most 500 friends (10 lookups of 50) per round; raise if users have more.
  const pollFriends=async():Promise<void>=>{
    if(!ctx.ecosystemSelf||!options().enabled.friendSyncord)return;
    const friends=friendIds().slice(0,500),found:string[]=[];
    for(let i=0;i<friends.length;i+=50){const result=await ctx.ecosystemSelf.lookup(friends.slice(i,i+50)).catch(()=>undefined);if(!result)return;for(const [id,badges]of Object.entries(result))if(Array.isArray(badges)&&badges.length)found.push(id);}
    const raw=readRaw('knownSyncord'),known=new Set(ids(raw));
    // The first round only records who already uses Syncord.
    if(raw)for(const id of found.filter(id=>!known.has(id)).slice(0,3)){const user=getUser(id);emit('friendSyncord',{title:displayName(user,id),body:t('island.friendBody',{v0:displayName(user,id)}),avatar:avatarUrl(user)});}
    setOption('knownSyncord',JSON.stringify([...new Set([...known,...found])].slice(-2000)));
  };
  const timers=[window.setTimeout(()=>void pollProfile(),15_000),window.setTimeout(()=>void pollFriends(),60_000)];
  const intervals=[window.setInterval(()=>void pollProfile(),5*60_000),window.setInterval(()=>void pollFriends(),30*60_000)];
  cleanups.push(()=>{timers.forEach(clearTimeout);intervals.forEach(clearInterval);});
  return ()=>{for(const cleanup of cleanups.splice(0))try{cleanup();}catch{/* keep cleaning */}};
}
