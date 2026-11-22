import type {Game,RunningGames,GameDispatcher} from '../../api/gameSimulation';
import {isDiscordRestApi} from '../../webpack/common/rest';
import {gameValue,gameId} from './settings';
export function gameRuntime():{store:RunningGames;dispatcher:GameDispatcher}|undefined{
 const wp=window.Syncord?.webpack,store=window.Syncord?.common?.stores.RunningGameStore??wp?.findByStoreName?.('RunningGameStore');
 const dispatcher=(window.Syncord?.common?.flux?.FluxDispatcher??wp?.findByProps?.('dispatch','subscribe','flushWaitQueue')) as GameDispatcher|undefined;
 const s=store as RunningGames|undefined;if(typeof s?.getRunningGames!=='function'||typeof s.getGameForPID!=='function'||typeof dispatcher?.dispatch!=='function'||typeof dispatcher.subscribe!=='function'||typeof dispatcher.unsubscribe!=='function')return;
 return{store:s,dispatcher};
}
/** Read already-loaded stores without requiring Discord factories. */
export function cachedGames():Game[]{
 const wp=window.Syncord?.webpack,all=new Map<string,Game>();
 for(const name of ['DetectableApplicationsStore','ApplicationStore']){
  const store=(wp?.findByStoreName?.(name)??(name==='ApplicationStore'?window.Syncord?.common?.stores.ApplicationStore:undefined)) as {getDetectableApplications?:()=>unknown;getApplications?:()=>unknown}|undefined;
  try{const raw=store?.getDetectableApplications?.()??store?.getApplications?.();const values=raw instanceof Map?[...raw.values()]:Array.isArray(raw)?raw:raw&&typeof raw==='object'?Object.values(raw):[];
   for(const value of values.slice(0,50000)){const game=gameValue(value);if(game)all.set(game.id,game);}
  }catch{/* Optional catalog store changed; manual verified IDs remain available. */}
 }
 return[...all.values()];
}
type AppResponse={status?:number;body?:unknown};
// Public game metadata is shared across accounts, never persisted. Native REST
// owns the request; cancelling a panel detaches only its bounded local wait.
let catalog:readonly Game[]|undefined,catalogTime=0,catalogRetry=0,catalogWork:Promise<readonly Game[]>|undefined;
export async function loadGames(signal:AbortSignal):Promise<readonly Game[]>{
 if(signal.aborted)throw Error('game.cancelled');
 if(catalog&&Date.now()-catalogTime<30*60*1000)return catalog;
 if(!catalogWork){
  if(Date.now()<catalogRetry)throw Error('game.catalog_failed');
  const api=window.Syncord?.webpack?.find?.(isDiscordRestApi) as {get:(args:{url:string})=>Promise<AppResponse>}|undefined;
  if(!api)throw Error('game.catalog_failed');
  catalogWork=Promise.resolve().then(()=>api.get({url:'/applications/detectable'})).then(response=>{
   if(response.status&&!(response.status>=200&&response.status<300)||!Array.isArray(response.body)||response.body.length>50000)throw Error('game.catalog_failed');
   const result=new Map<string,Game>();for(const value of response.body){const game=gameValue(value);if(game)result.set(game.id,game);}
   if(!result.size)throw Error('game.catalog_failed');
   catalog=Object.freeze([...result.values()]);catalogTime=Date.now();return catalog;
  });
  const clear=():void=>{catalogWork=undefined;};
  void catalogWork.then(clear,()=>{catalogRetry=Date.now()+30000;clear();});
 }
 try{return await lookupResult(catalogWork,signal);}catch{throw Error(signal.aborted?'game.cancelled':'game.catalog_failed');}
}
const verified=new Map<string,Game>();let pending:{id:string;work:Promise<AppResponse>}|undefined;
function lookupResult<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
 return new Promise((resolve,reject)=>{
  const stop=():void=>{cleanup();reject(Error('game.cancelled'));};
  const timer=setTimeout(()=>{cleanup();reject(Error('game.lookup_failed'));},15000);
  const cleanup=():void=>{clearTimeout(timer);signal.removeEventListener('abort',stop);};
  if(signal.aborted){stop();return;}signal.addEventListener('abort',stop,{once:true});
  work.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
 });
}
export async function resolveGame(id:string,signal:AbortSignal):Promise<Game>{
 if(!gameId(id))throw Error('game.invalid_id');if(signal.aborted)throw Error('game.cancelled');
 const known=verified.get(id);if(known)return known;
 const api=window.Syncord?.webpack?.find?.(isDiscordRestApi) as {get:(args:{url:string})=>Promise<AppResponse>}|undefined;if(!api)throw Error('game.unavailable');
 // Discord owns the native request. Abort releases our wait/timer immediately;
 // keep its one in-flight slot until it settles rather than issuing a burst.
 if(pending&&pending.id!==id)await lookupResult(pending.work.catch(()=>undefined),signal);
 if(signal.aborted)throw Error('game.cancelled');
 if(!pending){
  const entry={id,work:api.get({url:'/applications/public?application_ids='+encodeURIComponent(id)})};pending=entry;
  const clear=():void=>{if(pending===entry)pending=undefined;};void entry.work.then(clear,clear);
 }
 if(pending.id!==id)throw Error('game.busy');
 const response=await lookupResult(pending.work,signal);if(signal.aborted)throw Error('game.cancelled');
 if(response.status&&!(response.status>=200&&response.status<300))throw Error('game.lookup_failed');
 const game=Array.isArray(response.body)?gameValue(response.body[0]):undefined;if(!game||game.id!==id)throw Error('game.lookup_failed');
 verified.set(id,game);while(verified.size>64)verified.delete(verified.keys().next().value!);return game;
}
export function iconUrl(game:Game):string{return gameId(game.id)&&typeof game.icon==='string'&&/^(?:a_)?[a-f0-9]{32}$/.test(game.icon)?'https://cdn.discordapp.com/app-icons/'+game.id+'/'+game.icon+'.png?size=64':'';}
