import {createLogger} from '../logger';
import {EventHub,type Action,type Listener,type Interceptor,type Flux} from './hub';
import {GuildCoverage,type CoverageRequest} from './coverage';
export type {CoverageRequest} from './coverage';
export type {Action,Interceptor} from './hub';
export const COVERAGE_STATUS_EVENT='Syncord-event-coverage-status';
const log=createLogger('discord-events');
const hub=new EventHub(error=>log.warn('Discord event consumer failed',error));
let refs=0;
let boundFlux:Flux|undefined;
type SubscriptionStore={isSubscribedToThreads?:(id:string)=>boolean;isSubscribedToAnyMember?:(id:string)=>boolean};
let subscriptionsStore:SubscriptionStore|undefined;
const handlers=new Map<string,Map<Listener,()=>void>>();
function common(){return window.Syncord?.common;}
function nativeFlux():Flux|undefined {
  const value=common()?.flux.FluxDispatcher as Partial<Flux>|undefined;
  return typeof value?.dispatch==='function'?value as Flux:undefined;
}
function safe<T>(read:()=>T,fallback:T):T {try{return read();}catch{return fallback;}}
function guildIds():string[] {
  const store=common()?.stores.GuildStore as {getGuildIds?:()=>string[];getGuilds?:()=>Record<string,unknown>}|undefined;
  return safe(()=>store?.getGuildIds?.()??Object.keys(store?.getGuilds?.()??{}),[]).filter(id=>/^\d{17,20}$/.test(id));
}
function retainedGuilds():Set<string> {
  const set=new Set<string>();
  const selected=common()?.stores.SelectedGuildStore as {getGuildId?:()=>string}|undefined;
  const channels=common()?.stores.ChannelStore as {getChannel?:(id:string)=>{guild_id?:string;guildId?:string}}|undefined;
  const channel=common()?.stores.SelectedChannelStore as {getChannelId?:()=>string;getVoiceChannelId?:()=>string}|undefined;
  const direct=safe(()=>selected?.getGuildId?.(),undefined);if(direct)set.add(direct);
  for(const id of [safe(()=>channel?.getChannelId?.(),undefined),safe(()=>channel?.getVoiceChannelId?.(),undefined)]) {
    const record=id?safe(()=>channels?.getChannel?.(id),undefined):undefined;
    const guild=record?.guild_id??record?.guildId;if(guild)set.add(guild);
  }
  return set;
}
const coverage=new GuildCoverage({guildIds,retainedGuilds,
  membersRetained:id=>typeof subscriptionsStore?.isSubscribedToAnyMember==='function'
    ? safe(()=>subscriptionsStore!.isSubscribedToAnyMember!(id),retainedGuilds().has(id)) : retainedGuilds().has(id),
  nativeFeatures:id=>{
    const store=subscriptionsStore;
    // Native visited-guild subscriptions enable these together. Later native flushes refine the snapshot.
    const native=retainedGuilds().has(id)||safe(()=>store?.isSubscribedToThreads?.(id)===true,false);
    return {typing:native,activities:native,threads:native};
  },dispatch:action=>{if(!boundFlux)throw new Error('Discord dispatcher unavailable');return boundFlux.dispatch(action);},
  set:(fn,delay)=>window.setTimeout(fn,delay),clear:id=>window.clearTimeout(id),
  report:error=>log.warn('Guild coverage update failed',error),
  changed:()=>window.dispatchEvent(new Event(COVERAGE_STATUS_EVENT))});
function retain():void {
  if(!refs) {
    const live=nativeFlux();if(!live||!hub.attach(live,action=>coverage.before(action),action=>coverage.after(action)))throw new Error('Discord dispatcher unavailable');
    boundFlux=live;
    subscriptionsStore=safe(()=>window.Syncord?.webpack?.findByStoreName('GuildSubscriptionsStore'),undefined) as SubscriptionStore|undefined;
  }
  refs++;
}
function release():void {refs--;if(!refs){hub.detach();boundFlux=undefined;subscriptionsStore=undefined;}}
const dispatcher={
  dispatch:(action:Action):unknown=>nativeFlux()?.dispatch(action),
  subscribe:(type:string,listener:Listener):void=>{
    let group=handlers.get(type);if(group?.has(listener))return;
    retain();const undo=hub.listen(type,listener);if(!group){group=new Map();handlers.set(type,group);}group.set(listener,undo);
  },
  unsubscribe:(type:string,listener:Listener):void=>{
    const group=handlers.get(type),undo=group?.get(listener);if(!undo)return;
    undo();group!.delete(listener);if(!group!.size)handlers.delete(type);release();
  }
};
export function sharedDispatcher():typeof dispatcher|undefined {return nativeFlux()?dispatcher:undefined;}
export function interceptDiscordEvents(handler:Interceptor):()=>void {
  retain();const undo=hub.intercept(handler);let done=false;
  return ()=>{if(done)return;done=true;undo();release();};
}
export function acquireGuildCoverage(request:CoverageRequest):{update:(next:CoverageRequest)=>void;release:()=>void} {
  retain();const lease=coverage.acquire(request);let done=false;
  return {update:next=>{if(!done)lease.update(next);},release:()=>{if(done)return;done=true;try{lease.release();}finally{release();}}};
}
export function guildCoverageStatus():ReturnType<GuildCoverage['status']>{return coverage.status();}
export function discordEventStats():ReturnType<EventHub['counts']>{return hub.counts();}
