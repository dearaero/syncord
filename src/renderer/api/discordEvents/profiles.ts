import {sharedDispatcher} from './index';
import {canViewChannel} from './access';
import {ProfileQueue,type ProfileTarget} from './profileQueue';
export type {ProfileTarget} from './profileQueue';

type Store={getUserProfile?:(id:string)=>unknown;getGuildMemberProfile?:(id:string,guild:string)=>unknown;isFetchingProfile?:(id:string,guild?:string)=>boolean};
type FetchProfile=(id:string,options:{guildId?:string;withMutualGuilds:boolean;withMutualFriends:boolean;withMutualFriendsCount:boolean;abortSignal:AbortSignal})=>Promise<unknown>;
let fetchProfile:FetchProfile|undefined,lookupAt=0;
function store():Store|undefined {
  return (window.Syncord?.common?.stores.UserProfileStore??window.Syncord?.webpack?.findByStoreName('UserProfileStore')) as Store|undefined;
}
function safely<T>(read:()=>T,fallback:T):T {try{return read();}catch{return fallback;}}
function resolveFetch():FetchProfile|undefined {
  if(fetchProfile)return fetchProfile;
  if(Date.now()<lookupAt)return undefined;lookupAt=Date.now()+2000;
  const native=window.Syncord?.common?.actions.UserProfileActions as {fetchProfile?:FetchProfile}|undefined;
  if(typeof native?.fetchProfile==='function')return fetchProfile=native.fetchProfile.bind(native);
  // Semantic signals verified against Discord's own native loader; search loaded exports only.
  const found=window.Syncord?.webpack?.find(value=>{
    if(typeof value!=='function')return false;
    const source=Function.prototype.toString.call(value);
    return source.includes('USER_PROFILE_FETCH_START')&&source.includes('USER_PROFILE_FETCH_SUCCESS')&&source.includes('withMutualGuilds');
  });
  if(typeof found==='function')fetchProfile=found as FetchProfile;
  return fetchProfile;
}
const queue=new ProfileQueue({now:Date.now,set:(fn,delay)=>window.setTimeout(fn,delay),clear:id=>window.clearTimeout(id),
  ready:target=>safely(()=>!!store()?.getUserProfile?.(target.userId)&&(!target.guildId||!!store()?.getGuildMemberProfile?.(target.userId,target.guildId)),false),
  fetching:target=>safely(()=>store()?.isFetchingProfile?.(target.userId,target.guildId)===true,false),
  allowed:target=>safely(()=>!!(window.Syncord?.common?.stores.UserStore as {getCurrentUser?:()=>unknown}|undefined)?.getCurrentUser?.()&&canViewChannel(target.channelId),false),
  fetch:(target,abortSignal)=>{
    const fn=resolveFetch();if(!fn)return Promise.reject(new Error('Native profile loader is unavailable'));
    return fn(target.userId,{guildId:target.guildId,withMutualGuilds:false,withMutualFriends:false,withMutualFriendsCount:false,abortSignal});
  }});
let refs=0,flux:ReturnType<typeof sharedDispatcher>;
const EVENTS=['USER_PROFILE_FETCH_START','USER_PROFILE_FETCH_SUCCESS','USER_PROFILE_FETCH_FAILURE','LOGOUT'];
function changed(action:Record<string,unknown>):void {if(action.type==='LOGOUT'){queue.reset();fetchProfile=undefined;lookupAt=0;}else {
  const profile=action.userProfile as {user?:{id?:string};user_id?:string}|undefined;
  const id=profile?.user?.id??profile?.user_id??action.userId;
  if(action.type==='USER_PROFILE_FETCH_SUCCESS'&&typeof id==='string')queue.completed(id,typeof action.guildId==='string'?action.guildId:undefined);
  else if(action.type==='USER_PROFILE_FETCH_FAILURE'&&typeof id==='string')queue.failed(id,typeof action.guildId==='string'?action.guildId:undefined,action.error??action.apiError??action);
  else queue.wake();
}}
export function acquireUserProfiles():ReturnType<ProfileQueue['acquire']>{
  if(!refs){
    flux=sharedDispatcher();if(!flux)throw new Error('Discord event dispatcher unavailable');
    try{for(const type of EVENTS)flux.subscribe(type,changed);}catch(error){for(const type of EVENTS)flux.unsubscribe(type,changed);flux=undefined;throw error;}
  }
  refs++;const lease=queue.acquire();let done=false;
  return {update:(targets:readonly ProfileTarget[])=>{if(!done)lease.update(targets);},release:()=>{
    if(done)return;done=true;lease.release();refs--;
    if(!refs){for(const type of EVENTS)flux?.unsubscribe(type,changed);flux=undefined;fetchProfile=undefined;lookupAt=0;}
  }};
}
export function profileRequestStats():ReturnType<ProfileQueue['stats']>{return queue.stats();}
