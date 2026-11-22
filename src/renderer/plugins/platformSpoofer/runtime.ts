import type {IdentitySnapshot} from '../../api/platformIdentity';
import type {PluginContext} from '../../api/plugin';
import type {Action} from '../../api/discordEvents';
import {accountId,record,selection,preferences,type Observation,type Platform,type Snapshot} from './model';
import {empty} from './state';
export type Environment={account:()=>string|undefined;observe:(id:string)=>Observation;allowed:()=>boolean;publish:(state:Snapshot)=>void;set:(fn:()=>void,ms:number)=>number;clear:(id:number)=>void;identity?:{snapshot:()=>IdentitySnapshot;request:(selected:Platform[],id:string)=>boolean|void;clear:()=>void;restore?:(id:string)=>boolean;connected?:()=>void}};
/** Account-scoped preferences and reports; explicit Apply may arm the narrow native adapter. */
export function startObserver(ctx:Pick<PluginContext,'settings'>,env:Environment){
 let stopped=false,disconnected=false,loggedOut=false,timer=0,queued=false;
 let state:Snapshot={...empty(),running:true};
 const cancel=():void=>{env.clear(timer);timer=0;};
 function refresh():void{
  if(stopped)return;
  const account=env.allowed()&&!loggedOut?env.account():undefined;
  const same=account===state.account;
  if(!same||!env.allowed()){cancel();env.identity?.clear();state={...empty(),running:env.allowed()};}
  let selected:Platform[]=[];try{if(account)selected=preferences(ctx.settings.get('accounts'),account);}catch{state={...state,result:'failed'};}
  state={...state,account,selected,saving:!!timer};
  let observation:Observation={visibility:'unknown',available:false,evidence:{}};
  try{if(account&&!disconnected&&env.allowed())observation=env.observe(account);}catch{/* Unavailable native exports are not successful observations. */}
  state={...state,...observation,...(env.identity?{identity:env.identity.snapshot()}:{})};env.publish(state);
 }
 function schedule():void{if(queued||stopped)return;queued=true;queueMicrotask(()=>{queued=false;refresh();});}
 function apply(value:Platform[],account:string,restore=false):boolean{
  if(stopped||state.identity?.busy||!env.allowed()||loggedOut||disconnected||!accountId(account)||env.account()!==account||state.account!==account)return false;
  let selected:Platform[];try{selected=restore?[]:selection(value);}catch{return false;}
  cancel();state={...state,saving:true,result:''};env.publish(state);
  timer=env.set(()=>{
   timer=0;if(stopped)return;
   if(!env.allowed()||loggedOut||disconnected||env.account()!==account){refresh();return;}
   try{
    const accounts=record(ctx.settings.get('accounts'))??{};
    ctx.settings.set('accounts',{...accounts,[account]:{selectedPlatforms:selected}});
    let applied:boolean|void=undefined;
    if(restore){if(env.identity?.restore)applied=env.identity.restore(account);else env.identity?.clear();}else applied=env.identity?.request(selected,account);
    state={...state,saving:false,result:applied===false&&(restore||selected.length===1)?'failed':restore?'restored':'saved'};
   }catch{state={...state,saving:false,result:'failed'};}
   refresh();
  },250);
  return true;
 }
 function event(action:Action):void{
  const type=action.type;
  if(type==='LOGOUT'){loggedOut=true;cancel();refresh();return;}
  if(type==='CONNECTION_CLOSED'||type==='CONNECTION_LOST'){disconnected=true;cancel();state={...state,saving:false,result:''};refresh();return;}
  if(type==='CONNECTION_OPEN'||type==='CONNECTION_RESUMED'||type==='CONNECTION_OPEN_SUPPLEMENTAL'){loggedOut=false;disconnected=false;env.identity?.connected?.();}
  if(type==='CURRENT_USER_UPDATE'){loggedOut=false;refresh();return;}
  if(type==='PRESENCE_UPDATE'||type==='PRESENCE_UPDATES'){
   const relevant=(a:Record<string,unknown>):boolean=>{const id=record(a.user)?.id??a.userId??a.user_id;return id===state.account;};
   if(!(Array.isArray(action.updates)?action.updates.some(a=>{const r=record(a);return !!r&&relevant(r);}):relevant(action)))return;
  }
  schedule();
 }
 refresh();
 return{apply,refresh,event,dispose(){if(stopped)return;stopped=true;cancel();env.identity?.clear();env.publish(empty());}};
}
