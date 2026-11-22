import { messageRef as i18nMessage, sameMessageRef, type MessageRef, t as i18nText } from "../../i18n";
import {definePlugin} from '../../api/plugin';
import {RELATIONSHIP_CSS} from './styles';
import type {PluginContext} from '../../api/plugin/types';
import {sharedDispatcher,type Action} from '../../api/discordEvents';
import {config} from './settings';
import {reconcile,transition,IntentLedger} from './engine';
import {relationshipStorage} from './storage';
import {accountId,connected,cachedInput,connectionInput,deltas,deltaKey,nativeRest,findActions,relationshipType,partialReady} from './discord';
import {RN_ID,RN_CHANGED,RN_STATUS,RN_DATA,record,validId,type Delta,type Input} from './types';
import {RelationshipNotices} from './notices';
import {closeRelationshipHistory} from './view';
let status=i18nMessage("ui.enable_relationship_tracker_to_monitor_changes");
export const relationshipStatus=():string=>i18nText(status.key,status.params);
export const relationshipStatusMessage=():MessageRef=>status;
const EVENTS=['CONNECTION_OPEN','POST_CONNECTION_OPEN','CONNECTION_OPEN_SUPPLEMENTAL','CONNECTION_RESUMED','CONNECTION_CLOSED','LOGOUT','CURRENT_USER_UPDATE','RELATIONSHIP_ADD','RELATIONSHIP_REMOVE','RELATIONSHIP_UPDATE','CHANNEL_CREATE','CHANNEL_DELETE','CHANNEL_UPDATES','CHANNEL_RECIPIENT_ADD','CHANNEL_RECIPIENT_REMOVE','GUILD_CREATE','GUILD_UPDATE','GUILD_DELETE','GUILD_UNAVAILABLE','GUILD_MEMBER_REMOVE'];
export function startRelationships(ctx:PluginContext):void {
 const dispatcher=sharedDispatcher();if(!dispatcher)throw Error("Discord’s shared event dispatcher is not ready.");
 let stopped=false,generation=0,active=accountId(),online=connected(),fullGroups=false,healthy=true,queue=Promise.resolve();
 const intents=new IntentLedger(),notices=new RelationshipNotices(),pending=new Map<string,Delta>();const patched=new WeakSet<object>();
 const setStatus=(value:MessageRef):void=>{if(sameMessageRef(status,value))return;status=value;window.dispatchEvent(new Event(RN_STATUS));};
 const switchAccount=(id:string):void=>{if(id===active)return;generation++;active=id;online=false;fullGroups=false;healthy=true;intents.clear();pending.clear();notices.clear();closeRelationshipHistory();};
 const save=(input:Input|Delta,offline:boolean,cause:'local'|'unknown'|'pending'='unknown'):void=>{
  const account=active,epoch=generation,at=Date.now(),cfg=config();if(!validId(account))return;
  const valid=():boolean=>!stopped&&epoch===generation&&active===account&&accountId()===account;
  queue=queue.then(async()=>{
   if(!valid())return;
   try{
    const rows=await relationshipStorage.update(account,previous=>'scope'in input?transition(previous,account,input,cfg,at,cause):reconcile(previous,account,input,cfg,at,offline),cfg.history,valid);
    if(!valid())return;notices.add(rows,cfg);window.dispatchEvent(new CustomEvent(RN_DATA,{detail:{accountId:account}}));
    setStatus(online?healthy?i18nMessage("ui.monitoring_relationship_changes_local_history_is_account_specific"):i18nMessage("ui.discord_reported_partial_startup_data_removal_comparisons_are_deferred"):i18nMessage("ui.disconnected_waiting_for_discord_to_reconnect"));
   }catch(error){if(valid()){ctx.log.warn('Relationship data could not be saved',error);setStatus(i18nMessage("ui.relationship_storage_failed"));}}
  });
 };
 const sessionInput=(groups=false):Input=>{const input=cachedInput(groups&&healthy);if(!healthy)input.complete={relationships:false,groups:false,guilds:false};return input;};
 const confirm=(delta:Delta,key:string,token:number,account:string,epoch:number):void=>{
  if(stopped||generation!==epoch||active!==account||accountId()!==account||!intents.confirm(key,token,Date.now()))return;
  pending.delete(key);intents.consume(key,Date.now());save(delta,false,'local');
 };
 const failed=(change:{key:string;token:number},account:string,epoch:number):void=>{
  if(!intents.cancel(change.key,change.token))return;
  if(stopped||generation!==epoch||active!==account||accountId()!==account)return;
  const observed=pending.get(change.key);pending.delete(change.key);if(observed)save(observed,false,'unknown');
 };
 function patchNative():void {
  const rest=nativeRest();
  if(rest&&!patched.has(rest)){
   patched.add(rest);
   for(const method of ['del','put','post'])if(typeof rest[method]==='function'){
    const calls=new WeakMap<object,{account:string;epoch:number;changes:{delta:Delta;key:string;token:number;remove:boolean}[]}>();
    ctx.patch.before(rest,method,args=>{
     if(stopped||accountId()!==active)return;const options=record(args[0]);if(!options.url||typeof options.url!=='string')return;
     let path:string;try{const url=new URL(options.url,location.origin);if(url.origin!==location.origin)return;path=url.pathname.replace(/^\/api(?:\/v\d+)?/,'');}catch{return;}
     const changes:{delta:Delta;key:string;token:number;remove:boolean}[]=[],now=Date.now();
     const mark=(delta:Delta,remove:boolean):void=>{const key=deltaKey(delta);changes.push({delta,key,token:intents.mark(key,now),remove});};
     let match=path.match(/^\/users\/@me\/relationships\/(\d{17,20})$/);
     if(match&&(method==='del'||method==='put')){
      const id=match[1]!,type=record(options.body).type===2?2:relationshipType(id)===3?1:4;
      mark({scope:'relationship',id,...(method==='put'?{value:{id,username:id,name:id,type}}:{})},method==='del');
     }
     match=path.match(/^\/users\/@me\/guilds\/(\d{17,20})$/);if(match&&method==='del')mark({scope:'guild',id:match[1]!},true);
     match=path.match(/^\/channels\/(\d{17,20})$/);if(match&&method==='del')mark({scope:'group',id:match[1]!},true);
     match=path.match(/^\/channels\/(\d{17,20})\/recipients\/(\d{17,20})$/);
     if(match&&(method==='put'||method==='del')){
      const id=match[2]!;mark({scope:'member',id:match[1]!,user:{id,username:id,name:id},added:method==='put'},false);
     }
     if(method==='post'&&path==='/users/@me/channels/bulk-leave')for(const id of Array.isArray(record(options.body).channel_ids)?record(options.body).channel_ids as unknown[]:[])if(validId(id))mark({scope:'group',id},true);
     if(method==='del'&&path==='/users/@me/relationships'&&record(options.query).relationship_type===3){
      for(const row of Object.values(cachedInput().relationships??{}))if(row.type===3)mark({scope:'relationship',id:row.id},true);
     }
     if(changes.length)calls.set(options,{account:active,epoch:generation,changes});
    });
    ctx.patch.after(rest,method,(args,result)=>{
     const options=record(args[0]),call=calls.get(options);if(!call)return;calls.delete(options);
     void Promise.resolve(result).then(response=>{
      const code=record(response).status;
      for(const change of call.changes){
       if(typeof code!=='number'||code<200||code>=300){failed(change,call.account,call.epoch);continue;}
       if(change.remove)confirm(change.delta,change.key,change.token,call.account,call.epoch);
       else if(!stopped&&generation===call.epoch&&active===call.account&&intents.confirm(change.key,change.token,Date.now())){
        const observed=pending.get(change.key);if(observed){pending.delete(change.key);intents.consume(change.key,Date.now());save(observed,false,'local');}
       }
      }
     },()=>{for(const row of call.changes)failed(row,call.account,call.epoch);});
    });
   }
  }
  // Native closePrivateChannel dispatches an optimistic delete before HTTP.
  // Mark it before dispatch; only the successful HTTP acknowledgement is saved.
  const channels=findActions('closePrivateChannel','openPrivateChannel');
  if(channels&&!patched.has(channels)&&typeof channels.closePrivateChannel==='function'){
   patched.add(channels);ctx.patch.before(channels,'closePrivateChannel',args=>{if(!stopped&&active===accountId()&&validId(args[0]))intents.mark(deltaKey({scope:'group',id:args[0]}),Date.now());});
  }
 }
 const observed=(action:Action):void=>{
  if(stopped)return;
  if(action.type==='LOGOUT'){generation++;active='';online=false;fullGroups=false;healthy=true;intents.clear();pending.clear();notices.clear();closeRelationshipHistory();setStatus(i18nMessage("ui.signed_out_relationship_monitoring_is_paused"));return;}
  switchAccount(accountId());
  if(action.type==='CONNECTION_CLOSED'){online=false;notices.clear();setStatus(i18nMessage("ui.disconnected_waiting_for_discord_to_reconnect"));return;}
  if(action.type==='CONNECTION_OPEN'){
   const user=record(action.user);if(validId(user.id)&&user.id===accountId())switchAccount(user.id);
   online=true;fullGroups=false;healthy=!partialReady(action);patchNative();save(connectionInput(action),true);return;
  }
  if(action.type==='CONNECTION_RESUMED'){online=true;patchNative();save(sessionInput(fullGroups),true);setStatus(i18nMessage("ui.reconnected_monitoring_relationship_changes"));return;}
  if(action.type==='POST_CONNECTION_OPEN'){if(online&&connected()){fullGroups=true;save(sessionInput(true),true);}return;}
  if(action.type==='CONNECTION_OPEN_SUPPLEMENTAL'){if(online)save(sessionInput(false),true);return;}
  if(action.type==='CURRENT_USER_UPDATE'){if(online&&connected())save(sessionInput(fullGroups),false);return;}
  if(!online)return;
  // Native group close is optimistic and has no channel type. Only an HTTP
  // acknowledgement or the full gateway channel can establish membership loss.
  if(action.type==='CHANNEL_DELETE'&&record(action.channel).type===undefined&&'silent'in action)return;
  for(const delta of deltas(action)){
   const key=deltaKey(delta),cause=intents.consume(key,Date.now());
   if(cause==='pending'){if(pending.size<1000)pending.set(key,delta);continue;}
   save(delta,false,cause);
  }
 };
 const changed=():void=>{notices.clear();};window.addEventListener(RN_CHANGED,changed);
 ctx.disposable(()=>{
  stopped=true;generation++;intents.clear();pending.clear();notices.dispose();closeRelationshipHistory();window.removeEventListener(RN_CHANGED,changed);
  for(const event of EVENTS)dispatcher.unsubscribe(event,observed);
  void queue.finally(()=>relationshipStorage.close()).catch(()=>{});setStatus(i18nMessage("ui.relationship_tracker_is_disabled_saved_history_and_backups_remain_loca"));
 });
 for(const event of EVENTS)dispatcher.subscribe(event,observed);
 patchNative();if(online)save(sessionInput(false),true);
 setStatus(online?i18nMessage("ui.initializing_account_specific_relationship_history"):i18nMessage("ui.waiting_for_discord_s_connection_to_become_ready"));

}

export const RelationshipNotifier=definePlugin({
 id:RN_ID,name:i18nText("ui.relationship_tracker"),author:i18nText("ui.syncord"),enabledByDefault:false,
 get description() { return i18nText("ui.account_specific_relationship_history_interactive_notifications_offlin"); },
 permissions:{userData:true,media:true,webpackPatch:true,discordStores:['relationship','user','channel','guild','GatewayConnectionStore','GuildAvailabilityStore'],discordActions:['profile-open','dm-open','friend-request']},
 start(ctx){ctx.css.inject(RELATIONSHIP_CSS);startRelationships(ctx);},
});
