import { messageRef as i18nMessage, sameMessageRef, type MessageRef, t as i18nText } from "../../i18n";
import {acquireGuildCoverage,interceptDiscordEvents} from "../../api/discordEvents";
import type { PluginContext } from "../../api/plugin/types";
import { showToast } from "../../ui/toast";
import { ActivityEngine } from "./engine";
import {ActivityRecorder} from "./recorder";
import {MessageActivity} from "./messages";
import {closeActivityLog} from "./logView";
import { NoticeBuffer } from "./notifications";
import {formatActivityText} from './text';
import { baseline, canViewChannel, channelName, dispatcher, userName, type Dispatcher } from "./discord";
import { ACTIVITY_SETTINGS_EVENT, ACTIVITY_STATUS_EVENT, EVENT_KINDS, readConfig, record, cleanText } from "./types";

const EVENTS = ["PRESENCE_UPDATES","PRESENCE_UPDATE","USER_UPDATE","CURRENT_USER_UPDATE","GUILD_MEMBER_UPDATE",
  "MESSAGE_CREATE","TYPING_START","USER_PROFILE_FETCH_SUCCESS","VOICE_STATE_UPDATES","VOICE_STATE_UPDATE"];
let state = i18nMessage("ui.disabled");
export function activityStatus(): string { return i18nText(state.key,state.params); }
export const activityStatusMessage=():MessageRef=>state;
function status(next:MessageRef): void {
  if (sameMessageRef(next,state)) return;
  state = next; window.dispatchEvent(new Event(ACTIVITY_STATUS_EVENT));
}

export function startActivity(ctx:PluginContext): void {
  let config = readConfig((key,fallback)=>ctx.settings.get(key,fallback));
  let flux: Dispatcher|undefined;
  let coverage:ReturnType<typeof acquireGuildCoverage>|undefined;
  let retries = 0, timeout = 0;
  let stopped = false, connected = true;
  let undoMessages:(()=>void)|undefined;
  const engines = new Map<string, ActivityEngine>();
  const recorder=new ActivityRecorder(error=>ctx.log.warn("Activity history could not be saved",error));
  const messageActivity=new MessageActivity(recorder,id=>engines.has(id),(type,message)=>{
    const id=record(message.author)?.id;if(typeof id==="string")engines.get(id)?.handle(type,{message});
  });
  const subscriptions = new Map<string,(action:unknown)=>void>();
  const buffer = new NoticeBuffer({now:Date.now,set:(fn,delay)=>window.setTimeout(fn,delay),clear:id=>window.clearTimeout(id)},
    ()=>config.notificationInterval,
    notice=>`${userName(notice.userId ?? "")}: ${formatActivityText(notice)}${notice.content?`: ${cleanText(notice.content,120)}`:""}${notice.channelId ? ` — ${channelName(notice.channelId)}` : ""}`,
    text=>{try {showToast(text,{duration:4000,position:"top"});} catch (error) {ctx.log.warn("Activity notification unavailable",error);}});
  const syncEngines = (): void => {
    const wanted = new Set(config.userIds);
    for (const [id, engine] of engines) if (!wanted.has(id)) {engine.dispose();engines.delete(id);}
    for (const id of wanted) {
      const target = {...config, userId:id};
      let engine = engines.get(id);
      if (engine) engine.configure(target,baseline(id));
      else {
        engine = new ActivityEngine(target,notice=>buffer.add({...notice,userId:id}),canViewChannel,Date.now,notice=>recorder.record({...notice,userId:id}));
        engine.resume(baseline(id));engines.set(id,engine);
      }
      if (!connected) engine.suspend();
    }
  };
  const clearEngines = (): void => {for (const engine of engines.values()) engine.dispose();engines.clear();};
  const targetId = (action:Record<string,unknown>): unknown => action.userId ?? action.user_id ?? record(action.user)?.id;
  const deliver = (type:string,action:unknown,id:unknown): void => {
    if (typeof id === "string") engines.get(id)?.handle(type,action);
  };
  // Route directly by user ID. Unrelated traffic never traverses every selected user.
  const route = (type:string,value:unknown): void => {
    const action = record(value);if (!action) return;
    if (type === "PRESENCE_UPDATES" || type === "VOICE_STATE_UPDATES") {
      const rows = type === "PRESENCE_UPDATES" ? action.updates : action.voiceStates;
      if (Array.isArray(rows)) for (const item of rows) {
        const row = record(item);if (row) deliver(type === "PRESENCE_UPDATES" ? "PRESENCE_UPDATE" : "VOICE_STATE_UPDATE",row,targetId(row));
      }
      return;
    }
    if (type === "PRESENCE_UPDATE" || type === "TYPING_START") {deliver(type,action,targetId(action));return;}
    const user = type === "MESSAGE_CREATE" ? record(record(action.message)?.author)
      : type === "USER_PROFILE_FETCH_SUCCESS" ? record(record(action.userProfile)?.user) ?? record(action.user)
      : record(action.user);
    const id = type === "VOICE_STATE_UPDATE" ? targetId(record(action.voiceState) ?? action) : user?.id ?? targetId(action);
    deliver(type,action,id);
  };
  const clearRetry = (): void => {
    window.clearInterval(retries); window.clearTimeout(timeout); retries = 0;timeout = 0;
  };
  const unbind = (): void => {
    undoMessages?.();undoMessages=undefined;
    if (flux) for (const [event,handler] of subscriptions) {
      try {flux.unsubscribe(event,handler);} catch { /* finish cleaning the other subscriptions */ }
    }
    coverage?.release();coverage=undefined;
    subscriptions.clear();flux = undefined;
  };
  const subscribe = (event:string,handler:(action:unknown)=>void): void => {
    if (!flux) return;
    const safe = (action:unknown): void => { try {handler(action);} catch (error) {ctx.log.warn("Activity event could not be processed",error);} };
    // Track before calling into Flux so a partially failed subscribe is undone.
    subscriptions.set(event,safe); flux.subscribe(event,safe);
  };
  const listeningStatus=():MessageRef=>config.paused?i18nMessage("ui.notifications_paused_logging_events")
    :!EVENT_KINDS.some(kind=>config[kind])?i18nMessage("ui.notifications_off_logging_events"):i18nMessage("ui.listening_to_discord_events");
  const bind = (): boolean => {
    if (stopped || !config.userIds.length) return true;
    const live = dispatcher(); if (!live) return false;
    if (flux === live) {coverage?.update({typing:true,activities:true,userIds:config.userIds});if(connected)status(listeningStatus());return true;}
    unbind();flux = live;
    connected = true;for (const [id,engine] of engines) engine.resume(baseline(id));
    try {
      for (const event of EVENTS) subscribe(event,action=>route(event,action));
      subscribe("CONNECTION_CLOSED",()=>{connected=false;for (const engine of engines.values()) engine.suspend();buffer.clear();status(i18nMessage("ui.waiting_for_discord_to_reconnect"));});
      const reconnect = (): void => {buffer.clear();connected=true;for (const [id,engine] of engines) engine.resume(baseline(id));status(listeningStatus());};
      subscribe("CONNECTION_OPEN",reconnect);
      subscribe("CONNECTION_OPEN_SUPPLEMENTAL",reconnect);
      subscribe("CONNECTION_RESUMED",reconnect);
      subscribe("LOGOUT",()=>{connected=false;for (const engine of engines.values()) engine.suspend();buffer.clear();closeActivityLog();status(i18nMessage("ui.waiting_for_discord_login"));});
      undoMessages=interceptDiscordEvents((action,next)=>{if(connected&&!stopped)messageActivity.observe(action);return next(action);});
      coverage=acquireGuildCoverage({typing:true,activities:true,userIds:config.userIds});
      status(listeningStatus());return true;
    } catch (error) {unbind();ctx.log.warn("Discord event subscription failed",error);return false;}
  };
  const apply = (): void => {
    clearRetry();buffer.clear();
    config = readConfig((key,fallback)=>ctx.settings.get(key,fallback));
    if (!config.userIds.length) {
      unbind();clearEngines();status(i18nMessage("ui.choose_a_user_to_start"));return;
    }
    syncEngines();
    if (bind()) return;
    status(i18nMessage("ui.waiting_for_discord_event_dispatcher"));
    retries = window.setInterval(()=>{if (bind()) clearRetry();},500);
    timeout = window.setTimeout(()=>{clearRetry();status(i18nMessage("ui.discord_events_unavailable_toggle_the_plugin_to_retry"));},20_000);
  };
  ctx.disposable(()=>{
    stopped = true;clearRetry();unbind();buffer.dispose();closeActivityLog();
    // Finish already observed message lookups before disposing their engines/recorder.
    void messageActivity.drain().finally(()=>{clearEngines();recorder.stop();});
    window.removeEventListener(ACTIVITY_SETTINGS_EVENT,apply);status(i18nMessage("ui.disabled"));
  });
  window.addEventListener(ACTIVITY_SETTINGS_EVENT,apply);
  apply();
}
