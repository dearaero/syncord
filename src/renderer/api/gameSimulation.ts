import {after} from './patcher';
import type {PluginContext} from './plugin/types';
export type Game={id:string;name:string;icon?:string};
export type VirtualGame=Game&{pid:number;pidPath:number[];start:number;processName:string;exeName:string;exePath:string;cmdLine:string;hidden:boolean;isLauncher:boolean;executables:Array<{os:string;name:string;is_launcher:boolean}>;windowHandle:number;fullscreenType:number;overlay:boolean;sandboxed:boolean};
export type RunningGames={getRunningGames:()=>unknown[];getGameForPID:(pid:number)=>unknown;getVisibleGame?:()=>unknown;getVisibleRunningGames?:()=>unknown[];getCandidateGames?:()=>unknown[];getRunningDiscordApplicationIds?:()=>Set<string>|string[]};
export type GameDispatcher={dispatch:(event:Record<string,unknown>)=>void;subscribe:(name:string,fn:(event:unknown)=>void)=>void;unsubscribe:(name:string,fn:(event:unknown)=>void)=>void};
type Lease={kind:'quest'|'custom';fake:VirtualGame;realPriority:boolean;changed?:(active:boolean,reason:'quest'|'real'|'active'|'unavailable')=>void};
type Hub={store:RunningGames;dispatcher:GameDispatcher;leases:Set<Lease>;active?:Lease;real:unknown[];emitting:boolean;queued:boolean;off:()=>void};
let hub:Hub|undefined;
const owners=new WeakMap<PluginContext,{release?:()=>void}>();
const record=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'?v as Record<string,unknown>:{};
const pidOf=(v:unknown):unknown=>record(v).pid;
function clean(h:Hub,values:unknown):unknown[]{return (Array.isArray(values)?values:[]).filter(v=>![...h.leases].some(l=>l.fake.pid===pidOf(v)));}
function update(h:Hub):void{
 if(hub!==h)return;
 h.real=clean(h,h.store.getRunningGames());
 const quest=[...h.leases].find(l=>l.kind==='quest'),custom=[...h.leases].find(l=>l.kind==='custom');
 const next=quest??(custom&&(!custom.realPriority||!h.real.length)?custom:undefined),previous=h.active;
 h.active=next;
 if(previous!==next){
  h.emitting=true;
  try{
   if(previous)h.dispatcher.dispatch({type:'LOCAL_ACTIVITY_UPDATE',socketId:'Syncord-game-'+previous.kind,pid:previous.fake.pid,activity:null});
   h.dispatcher.dispatch({type:'RUNNING_GAMES_CHANGE',removed:previous?[previous.fake]:[],added:next?[next.fake]:[],games:[...h.real,...(next?[next.fake]:[])]});
   if(next)h.dispatcher.dispatch({type:'LOCAL_ACTIVITY_UPDATE',socketId:'Syncord-game-'+next.kind,pid:next.fake.pid,activity:{application_id:next.fake.id,name:next.fake.name,type:0,details:null,state:null,icon:next.fake.icon,timestamps:{start:next.fake.start},assets:null}});
  }finally{h.emitting=false;}
 }
 for(const lease of h.leases)lease.changed?.(lease===next,quest&&lease!==quest?'quest':next===lease?'active':'real');
}
/** Shared arbitration, with each lease's hooks/disposal owned by its actual plugin.
 * One context disposer owns replaceable hooks from the existing patcher. Using
 * ctx.patch per switch would retain every historical undo until plugin stop.
 * The explicit permission check above and owning disposer remain mandatory.
 * No hook captures a stale list, removes a real game or clears another RPC socket. */
export function simulateGame(ctx:PluginContext,store:RunningGames,dispatcher:GameDispatcher,game:Game&{exeName?:string},start:number,kind:'quest'|'custom',realPriority=false,changed?:Lease['changed']):()=>void{
 if(!ctx.permissions.webpackPatch)throw Error('game.unavailable');
 let owner=owners.get(ctx);if(!owner){owner={};owners.set(ctx,owner);const entry=owner;ctx.disposable(()=>{entry.release?.();owners.delete(ctx);});}
 owner.release?.();
 if(!/^\d{17,20}$/.test(game.id)||!game.name.trim()||!Number.isSafeInteger(start)||start<0||start>Date.now())throw Error('game.invalid');
 if(hub&&(hub.store!==store||hub.dispatcher!==dispatcher))throw Error('game.unavailable');
 if(hub&&[...hub.leases].some(l=>l.kind===kind))throw Error('game.unavailable');
 if(!hub){
  const h:Hub={store,dispatcher,leases:new Set(),real:[],emitting:false,queued:false,off:()=>{}};
  const onGames=():void=>{if(h.emitting||h.queued)return;h.queued=true;queueMicrotask(()=>{h.queued=false;if(hub===h)try{update(h);}catch{for(const lease of h.leases)lease.changed?.(false,'unavailable');}});};
  dispatcher.subscribe('RUNNING_GAMES_CHANGE',onGames);h.off=()=>dispatcher.unsubscribe('RUNNING_GAMES_CHANGE',onGames);hub=h;
 }
 const h=hub,used=new Set(h.store.getRunningGames().map(pidOf));for(const l of h.leases)used.add(l.fake.pid);
 let pid=1000000000+Math.floor(Math.random()*100000000);while(used.has(pid))pid++;
 const exeName=typeof game.exeName==='string'&&/^[^\\/\x00-\x1f]{1,128}$/.test(game.exeName)?game.exeName:(game.name.replace(/[^a-z0-9]/gi,'').slice(0,64)||'SyncordVirtualGame')+'.exe';
 const lease:Lease={kind,realPriority,changed,fake:{...game,pid,pidPath:[pid],start,processName:game.name,exeName,exePath:'C:/Syncord/'+exeName,cmdLine:'C:/Syncord/'+exeName,hidden:false,isLauncher:false,executables:[{os:'win32',name:exeName,is_launcher:false}],windowHandle:0,fullscreenType:0,overlay:true,sandboxed:false}};
 const undo:Array<()=>void>=[];let released=false;
 const release=():void=>{
  if(released)return;released=true;if(owner?.release===release)owner.release=undefined;
  // Keep the PID identifiable until the removal event has reached the real store.
  if(h.active===lease){
   h.active=undefined;h.emitting=true;
   for(const event of [{type:'LOCAL_ACTIVITY_UPDATE',socketId:'Syncord-game-'+kind,pid,activity:null},{type:'RUNNING_GAMES_CHANGE',removed:[lease.fake],added:[],games:clean(h,store.getRunningGames())}]){
    try{dispatcher.dispatch(event);}catch{ctx.log.warn('Game activity cleanup dispatch failed');}
   }
   h.emitting=false;
  }
  for(const fn of undo.reverse())fn();h.leases.delete(lease);
  if(!h.leases.size){h.off();if(hub===h)hub=undefined;}else try{update(h);}catch{ctx.log.warn('Game activity resume dispatch failed');}
 };
 h.leases.add(lease);
 try{
  for(const method of ['getRunningGames','getVisibleRunningGames','getCandidateGames'] as const){if(typeof store[method]==='function')undo.push(after(store,method,(_args,result)=>[...clean(h,result),...(h.active?[h.active.fake]:[])]));}
  undo.push(after(store,'getGameForPID',(args,result)=>{const active=h.active;return active&&active.fake.pid===args[0]?active.fake:[...h.leases].some(l=>l.fake.pid===args[0])?null:result;}));
  if(store.getVisibleGame)undo.push(after(store,'getVisibleGame',(_args,result)=>h.active?.fake??([...h.leases].some(l=>l.fake.pid===pidOf(result))?h.real[0]??null:result)));
  if(store.getRunningDiscordApplicationIds)undo.push(after(store,'getRunningDiscordApplicationIds',(_args,result)=>{const raw=result instanceof Set?[...result]:Array.isArray(result)?result:[];const ids=raw.filter(id=>![...h.leases].some(l=>l.fake.id===id)||h.real.some(g=>record(g).id===id));if(h.active&&!ids.includes(h.active.fake.id))ids.push(h.active.fake.id);return result instanceof Set?new Set(ids):ids;}));
  update(h);owner.release=release;return release;
 }catch(error){release();throw error;}
}
