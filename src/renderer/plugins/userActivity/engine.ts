import { canonicalMessage as i18nText } from "../../i18n";
import { type Action, type ActivityConfig, type ActivityNotice, type Baseline, cleanText, messageContent, record } from "./types";

const LIMIT = 128;
const STATUS: Record<string, string> = {online:i18nText("ui.online"), idle:i18nText("ui.idle"), dnd:i18nText("ui.do_not_disturb_d0b47b1"), offline:i18nText("ui.offline")};
function status(value: unknown): string | undefined {
  if (value === "invisible") return "offline";
  return typeof value === "string" && Object.hasOwn(STATUS,value) ? value : undefined;
}
function idOf(value: Action): unknown { return value.userId ?? value.user_id ?? record(value.user)?.id; }
function channelOf(value: Action): string | undefined {
  const channel = value.channelId ?? value.channel_id;
  return typeof channel === "string" && channel.length > 0 && channel.length <= 64 ? channel : undefined;
}
function activityKey(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  // Timestamps, progress and asset changes do not indicate a new activity.
  return value.slice(0, 8).map(item => {
    const a = record(item);
    return a ? [a.type,cleanText(a.name,80),cleanText(a.state,80),cleanText(a.details,80)].join("|") : "";
  }).sort().join(";");
}
function remember<K,V>(map: Map<K,V>, key: K, value: V): void {
  map.delete(key); map.set(key,value);
  if (map.size > LIMIT) { const first = map.keys().next(); if (!first.done) map.delete(first.value); }
}

/** Keeps bounded scalar state for one target; message bodies go straight to local history. */
export class ActivityEngine {
  private fields = new Map<string, string | null>();
  private lastStatus: string | undefined;
  private lastActivities: string | undefined;
  private voiceChannel: string | null | undefined;
  private voiceKey: string | undefined;
  private voiceFlags: Record<string,boolean> = {};
  private recentMessages = new Map<string, number>();
  private typingAt = new Map<string, number>();
  private suspended = false;

  constructor(private config: ActivityConfig,
    private readonly notify: (notice: ActivityNotice) => void,
    private readonly canView: (channelId: string) => boolean,
    private readonly now: () => number = Date.now,
    private readonly capture?: (notice:ActivityNotice) => void) {}

  configure(config: ActivityConfig, baseline: Baseline): void {
    const changed = this.config.userId !== config.userId;
    this.config = config;
    if (changed) { this.recentMessages.clear(); this.typingAt.clear(); }
    this.seed(baseline);
  }
  seed(baseline: Baseline): void {
    this.fields.clear(); this.lastStatus = status(baseline.status);
    this.lastActivities = activityKey(baseline.activities);
    this.voiceChannel = undefined; this.voiceKey = undefined; this.voiceFlags = {};
    if (baseline.user?.id === this.config.userId) this.profile(baseline.user, false);
    if (baseline.voice) this.voice(baseline.voice, false);
  }
  dispose(): void {
    this.fields.clear(); this.typingAt.clear(); this.recentMessages.clear();
    this.voiceFlags = {}; this.voiceChannel = undefined; this.voiceKey = undefined;
    this.lastStatus = undefined; this.lastActivities = undefined;
    this.suspended = true;
  }
  sizes(): {fields:number;messages:number;typing:number} {
    return {fields:this.fields.size,messages:this.recentMessages.size,typing:this.typingAt.size};
  }
  suspend(): void { this.suspended = true; }
  resume(baseline: Baseline): void { this.seed(baseline); this.suspended = false; }
  private announce(notice:ActivityNotice):void {if(this.config[notice.kind]&&!this.config.paused)this.notify(notice);}
  private emit(notice:ActivityNotice):void {this.capture?.(notice);this.announce(notice);}
  private profile(value: Action, announce = true, guildId?: string): void {
    if (value.id !== this.config.userId) return;
    for (const field of ["avatar", "username", "global_name"] as const) {
      const next = value[field];
      if (next !== null && typeof next !== "string") continue;
      const key = `${guildId ?? ""}:${field}`;
      const bounded = next === null ? null : next.slice(0, 128);
      const previous = this.fields.get(key);
      if (this.fields.has(key) && previous !== bounded && announce) {
        this.emit({kind:field === "avatar" ? "avatar" : "profile", text: field === "avatar"
          ? `${guildId ? "Server profile photo" : "Profile photo"} changed`
          : `${field === "username" ? "Username" : "Display name"} changed to ${cleanText(next) || "default"}`});
      }
      remember(this.fields, key, bounded);
    }
  }
  private presence(value: Action): void {
    if (idOf(value) !== this.config.userId) return;
    const next = status(value.status);
    if (next !== undefined) {
      if (this.lastStatus !== undefined && next !== this.lastStatus) this.emit({kind:"presence",text:`${STATUS[this.lastStatus]} → ${STATUS[next]}`});
      this.lastStatus = next;
    }
    const activities = activityKey(value.activities);
    if (activities !== undefined) {
      if (this.lastActivities !== undefined && activities !== this.lastActivities) this.emit({kind:"activities",text:activities ? "Activity / custom status changed" : "Activity ended"});
      this.lastActivities = activities;
    }
    const user = record(value.user);
    if (user) this.profile(user);
  }
  private voice(value: Action, announce = true): void {
    if (idOf(value) !== this.config.userId) return;
    const raw = value.channelId ?? value.channel_id;
    // Null is a real leave event. Missing fields are not.
    const channel = raw === null || value.channelId === null || value.channel_id === null ? null : typeof raw === "string" && raw.length > 0 && raw.length <= 64 ? raw : undefined;
    if (channel === undefined) return;
    const flags = [["selfMute","self_mute"],["selfDeaf","self_deaf"],["selfVideo","self_video"],
      ["selfStream","self_stream"],["mute","mute"],["deaf","deaf"],["suppress","suppress"]] as const;
    for (const [camel,snake] of flags) {
      const next = value[camel] ?? value[snake];
      if (typeof next === "boolean") this.voiceFlags[camel] = next;
    }
    const key = [channel,...flags.map(([name])=>this.voiceFlags[name])].join("|");
    const context = channel ?? this.voiceChannel;
    if (announce && this.voiceKey !== undefined && key !== this.voiceKey && context && this.canView(context)) {
      this.emit({kind:"voice",channelId:context,text:channel === null ? "Left voice channel"
        : channel !== this.voiceChannel ? "Joined / moved voice channel" : "Voice, camera or stream state changed"});
    }
    this.voiceKey = key; this.voiceChannel = channel;
  }
  handle(type: string, value: unknown): void {
    if (!this.config.userId || (this.config.paused && !this.capture) || this.suspended) return;
    const action = record(value); if (!action) return;
    if (type === "PRESENCE_UPDATES") {
      if (Array.isArray(action.updates)) for (const item of action.updates) { const row = record(item); if (row) this.presence(row); }
    } else if (type === "PRESENCE_UPDATE") this.presence(action);
    else if (type === "USER_UPDATE" || type === "CURRENT_USER_UPDATE") { const user = record(action.user); if (user) this.profile(user); }
    else if (type === "USER_PROFILE_FETCH_SUCCESS") {
      const profile = record(action.userProfile);
      const user = record(profile?.user) ?? record(action.user);
      if (user) this.profile(user);
    } else if (type === "GUILD_MEMBER_UPDATE") {
      const user = record(action.user); if (!user || user.id !== this.config.userId) return;
      this.profile(user);
      const guildId = action.guildId ?? action.guild_id;
      if (typeof guildId === "string" && guildId.length <= 64) this.profile({id:user.id,avatar:action.avatar,global_name:action.nick},true,guildId);
    } else if (type === "MESSAGE_CREATE" || type === "MESSAGE_UPDATE" || type === "MESSAGE_DELETE") {
      const message = record(action.message); if (!message || record(message.author)?.id !== this.config.userId || action.optimistic === true) return;
      const channel = channelOf(message) ?? channelOf(action);
      if (!channel || !this.canView(channel) || typeof message.id !== "string" || message.id.length > 32) return;
      if (type === "MESSAGE_CREATE") {
        if (this.recentMessages.has(message.id)) return;
        remember(this.recentMessages,message.id,this.now());
      }
      this.profile(record(message.author)!);
      const messageEvent=type === "MESSAGE_DELETE" ? "deleted" : type === "MESSAGE_UPDATE" ? "edited" : "sent";
      this.emit({kind:"messages",channelId:channel,messageId:message.id,messageEvent,content:messageContent(message.content),
        ...(typeof message.observedAt === "number"?{timestamp:message.observedAt}:{}),
        text:messageEvent === "deleted" ? "Deleted a message" : messageEvent === "edited" ? "Edited a message" : "Sent a message"});
    } else if (type === "TYPING_START") {
      if ((!this.config.typing && !this.capture) || idOf(action) !== this.config.userId) return;
      const channel = channelOf(action); if (!channel || !this.canView(channel)) return;
      const notice:ActivityNotice={kind:"typing",channelId:channel,text:i18nText("ui.started_typing")};
      this.capture?.(notice);
      if(!this.config.typing||this.config.paused)return;
      const now = this.now(), previous = this.typingAt.get(channel);
      if (previous !== undefined && now - previous < this.config.typingCooldown * 1000) return;
      remember(this.typingAt,channel,now);
      this.announce(notice);
    } else if (type === "VOICE_STATE_UPDATES") {
      if (!this.config.voice && !this.capture) return;
      if (Array.isArray(action.voiceStates)) for (const item of action.voiceStates) { const row = record(item); if (row) this.voice(row); }
    } else if (type === "VOICE_STATE_UPDATE" && (this.config.voice || this.capture)) this.voice(record(action.voiceState) ?? action);
  }
}
