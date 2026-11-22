import { canonicalMessage as i18nText } from "../../i18n";
import {canViewChannel} from "../../api/discordEvents/access";
export {canViewChannel};
import {sharedDispatcher} from "../../api/discordEvents";
import { type Baseline, type Action, cleanText, record, userId } from "./types";

type User = { id:string; username?:string; globalName?:string|null; global_name?:string|null; avatar?:string|null;
  getAvatarURL?:(guildId?:string|null,size?:number)=>string };
type UserStore = {getUser?:(id:string)=>User|undefined; getUsers?:()=>Record<string,User>};
type PresenceStore = {getStatus?:(id:string)=>string;getActivities?:(id:string)=>unknown};
type VoiceStore = {getVoiceStateForUser?:(id:string)=>Action|undefined};
type Channel = {id:string;name?:string;guild_id?:string;guildId?:string;type?:number};

export type Dispatcher = {subscribe:(type:string,fn:(action:unknown)=>void)=>void;unsubscribe:(type:string,fn:(action:unknown)=>void)=>void};
function common() { return window.Syncord?.common; }
export function activityAccount():string {
  const store=common()?.stores.UserStore as {getCurrentUser?:()=>{id?:string}|undefined}|undefined;
  try{return userId(store?.getCurrentUser?.()?.id);}catch{return "";}
}
function users() { return common()?.stores.UserStore as UserStore|undefined; }
export function dispatcher(): Dispatcher | undefined { return sharedDispatcher(); }

function safely<T>(fn:()=>T,fallback:T): T { try {return fn();} catch {return fallback;} }
export function baseline(id:string): Baseline {
  if (!id) return {};
  const user = safely(()=>users()?.getUser?.(id),undefined);
  const presence = common()?.stores.PresenceStore as PresenceStore|undefined;
  const voice = common()?.stores.VoiceStateStore as VoiceStore|undefined;
  return {
    user:user ? {id:user.id,avatar:user.avatar,username:user.username,global_name:user.globalName !== undefined ? user.globalName : user.global_name} : undefined,
    status:safely(()=>presence?.getStatus?.(id),undefined),
    activities:safely(()=>presence?.getActivities?.(id),undefined),
    voice:typeof voice?.getVoiceStateForUser === "function"
      ? safely(()=>voice.getVoiceStateForUser?.(id) ?? {userId:id,channelId:null},undefined) : undefined,
  };
}
function getChannel(id:string): Channel|undefined {
  const store = common()?.stores.ChannelStore as {getChannel?:(id:string)=>Channel|undefined}|undefined;
  return safely(()=>store?.getChannel?.(id),undefined);
}

export function userName(id:string): string {
  const user = safely(()=>users()?.getUser?.(id),undefined);
  return cleanText(user?.globalName ?? user?.global_name ?? user?.username,80) || id;
}
export function channelName(id:string): string {
  if (!canViewChannel(id)) return i18nText("ui.an_unavailable_channel");
  const channel = getChannel(id);
  const guild = channel?.guild_id ?? channel?.guildId;
  if (!guild) return i18nText("ui.a_direct_message");
  const store = common()?.stores.GuildStore as {getGuild?:(id:string)=>{name?:string}|undefined}|undefined;
  const name = safely(()=>store?.getGuild?.(guild)?.name,undefined);
  return `${cleanText(name,50) || i18nText("ui.server")} / #${cleanText(channel?.name,60) || id}`;
}
export type UserChoice = {id:string;name:string;username:string;avatar:string};
export function choice(id:string): UserChoice|undefined {
  const user = safely(()=>users()?.getUser?.(id),undefined); if (!user) return undefined;
  const raw = safely(()=>user.getAvatarURL?.(null,40),undefined);
  // Image URLs come from Discord's User model, restricted to its media hosts.
  const avatar = typeof raw === "string" && /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\//.test(raw) ? raw : "";
  return {id:user.id,name:userName(id),username:cleanText(user.username,80),avatar};
}
export function searchUsers(query:string, excluded?:ReadonlySet<string>): UserChoice[] {
  const q = query.trim().toLocaleLowerCase().slice(0,100), exact = userId(q);
  if (exact) { if(excluded?.has(exact)) return [];const user = choice(exact); return user ? [user] : []; }
  const result:UserChoice[] = [], seen = new Set<string>();
  const consider = (user:User|undefined): void => {
    if (!user || seen.has(user.id) || excluded?.has(user.id)) return;
    const name = user.globalName ?? user.global_name ?? user.username ?? "";
    if (q && !`${name} ${user.username ?? ""} ${user.id}`.toLocaleLowerCase().includes(q)) return;
    const next = choice(user.id); if (next) { result.push(next);seen.add(user.id); }
  };
  const relationships = common()?.stores.RelationshipStore as {getFriendIDs?:()=>string[]}|undefined;
  for (const id of safely(()=>relationships?.getFriendIDs?.() ?? [],[])) {
    consider(safely(()=>users()?.getUser?.(id),undefined)); if (result.length >= 20) return result;
  }
  const cached = safely(()=>users()?.getUsers?.(),undefined);
  if (cached) for (const id in cached) { if (Object.hasOwn(cached,id)) consider(cached[id]); if (result.length >= 20) break; }
  return result;
}
