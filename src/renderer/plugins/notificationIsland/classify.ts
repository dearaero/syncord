import type {Kind,Options} from './settings';
export type User={id?:string;username?:string;global_name?:string|null;globalName?:string|null;avatar?:string|null};
export type Message={id?:string;channel_id?:string;guild_id?:string;author?:User;content?:string;mentions?:unknown[];referenced_message?:{author?:User}|null;attachments?:unknown[]};
export type VoiceSnapshot={channelId:string|null;stream:boolean};
export const displayName=(user:User|undefined,fallback=''):string=>(user?.globalName??user?.global_name??user?.username??fallback).slice(0,80);
export function avatarUrl(user:User|undefined):string|undefined{
  return user?.id&&typeof user.avatar==='string'&&/^(a_)?[0-9a-f]{32}$/.test(user.avatar)?`https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.webp?size=64`:undefined;
}
export const firstLine=(content:string):string=>content.split('\n').find(line=>line.trim())?.trim().slice(0,140)??'';
const mentionId=(entry:unknown):unknown=>typeof entry==='string'?entry:(entry as {id?:unknown}|null)?.id;

/**
 * The first keyword found in what people actually read. Links and mention/emoji markup are not searched
 * (a CDN link's random hash used to match short keywords), and a keyword must be a whole word: "31" hits
 * "31 çekti"/"31'i" but not "31qwe" or "2031".
 */
export function matchedKeyword(content:string,keywords:readonly string[]):string|undefined{
  const text=content.replace(/<a?:\w+:\d+>|<(?:@[!&]?|#)\d+>|<?https?:\/\/\S+/gi,' ').toLowerCase();
  const escape=(word:string):string=>word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return keywords.find(word=>new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escape(word)}(?![\\p{L}\\p{N}_])`,'u').test(text));
}
/** Which kind a new message is, or undefined when it should not notify. `@everyone`/`@here` never count. */
export function classifyMessage(message:Message,me:string,cfg:Pick<Options,'enabled'|'keywords'>,channelType:number|undefined):Kind|undefined{
  if(!me||!message.author?.id||message.author.id===me)return undefined;
  if(channelType===1||channelType===3)return cfg.enabled.dm?'dm':undefined;
  // Like Discord: a reply only notifies when it pings (the replied author is then listed in `mentions`); bots usually reply silently.
  const pinged=(message.mentions??[]).some(entry=>mentionId(entry)===me);
  if(cfg.enabled.reply&&pinged&&message.referenced_message?.author?.id===me)return 'reply';
  if(cfg.enabled.mention&&pinged)return 'mention';
  if(cfg.enabled.keyword&&matchedKeyword(message.content??'',cfg.keywords))return 'keyword';
  return undefined;
}
/**
 * Mirrors Discord's own silence: message requests and spam never notify, and a muted channel/server
 * only lets through what pings you (mentions, pinged replies).
 */
export const silencedByDiscord=(kind:Kind,f:{request:boolean;spam:boolean;muted:boolean}):boolean=>f.request||f.spam||(f.muted&&(kind==='dm'||kind==='keyword'));
/** A voice state change, given the previous snapshot (undefined: unknown). */
export function voiceChange(previous:VoiceSnapshot|undefined,next:VoiceSnapshot):'voiceJoin'|'voiceLeave'|'stream'|undefined{
  const was=previous?.channelId??null;
  if(next.channelId&&next.channelId!==was)return 'voiceJoin';
  if(!next.channelId&&was)return 'voiceLeave';
  if(next.channelId&&next.stream&&previous&&!previous.stream)return 'stream';
  return undefined;
}
export type RichPart={type:'text';value:string}|{type:'user'|'channel';id:string};
/** Splits Discord markup into plain text plus user/channel mention tokens; custom emoji become `:name:`. */
export function richParts(text:string):RichPart[]{
  const parts:RichPart[]=[],pattern=/<(@!?|#)(\d{17,20})>|<a?:(\w{1,32}):\d{17,20}>/g;let at=0;
  const push=(value:string):void=>{if(!value)return;const last=parts[parts.length-1];if(last?.type==='text')last.value+=value;else parts.push({type:'text',value});};
  for(const match of text.matchAll(pattern)){
    push(text.slice(at,match.index));at=(match.index??0)+match[0].length;
    if(match[3])push(`:${match[3]}:`);else parts.push({type:match[1]==='#'?'channel':'user',id:match[2]});
  }
  push(text.slice(at));return parts;
}
