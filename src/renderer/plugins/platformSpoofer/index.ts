import {attachIdentity,onIdentityChange} from '../../api/platformIdentity';
import {definePlugin,isSafeModeActive,isLockdownActive} from '../../api/plugin';
import {sharedDispatcher} from '../../api/discordEvents';
import {canonicalMessage,t} from '../../i18n';
import {SPOOFER_ID} from './model';
import {ownAccount,ownObservation,identityAccount} from './presence';
import {controls,publish} from './state';
import {startObserver} from './runtime';
export const PlatformSpooferPlugin=definePlugin({
 id:SPOOFER_ID,name:canonicalMessage('ps.name'),get description(){return t('ps.description');},enabledByDefault:false,
 permissions:{webpackPatch:true,userData:true,discordStores:['UserStore','PresenceStore','SessionsStore','AuthenticationStore','GatewayConnectionStore']},
 start(ctx){
  const identity=attachIdentity(ctx,identityAccount,()=>!isSafeModeActive()&&!isLockdownActive());
  ctx.disposable(identity.dispose);
  const observer=startObserver(ctx,{account:ownAccount,observe:ownObservation,allowed:()=>!isSafeModeActive()&&!isLockdownActive(),publish,identity,set:(fn,ms)=>window.setTimeout(fn,ms),clear:id=>window.clearTimeout(id)});
  ctx.disposable(onIdentityChange(()=>queueMicrotask(()=>{if(!stopped)observer.refresh();})));
  const release=controls(observer.apply,()=>{bind();observer.refresh();});
  let flux:ReturnType<typeof sharedDispatcher>,retry=0,stopped=false,attempts=0;
  const events=['PRESENCE_UPDATE','PRESENCE_UPDATES','SESSIONS_REPLACE','SESSIONS_UPDATE','SESSION_UPDATE','LOCAL_PRESENCE_UPDATE','USER_SETTINGS_UPDATE','USER_SETTINGS_PROTO_UPDATE','CURRENT_USER_UPDATE','LOGOUT','CONNECTION_OPEN','CONNECTION_OPEN_SUPPLEMENTAL','CONNECTION_RESUMED','CONNECTION_CLOSED','CONNECTION_LOST','CACHE_LOADED_LAZY'];
  function unbind():void{for(const name of events)flux?.unsubscribe(name,observer.event);flux=undefined;}
  function bind():void{
   if(stopped||flux)return;
   const candidate=sharedDispatcher();if(!candidate)return;
   flux=candidate;try{for(const name of events)flux.subscribe(name,observer.event);window.clearTimeout(retry);retry=0;}catch{unbind();}
  }
  // A bounded startup retry only; no steady-state presence polling or scans.
  function startup():void{if(stopped)return;bind();observer.refresh();if(!flux&&++attempts<8)retry=window.setTimeout(startup,500);}
  ctx.disposable(()=>{stopped=true;window.clearTimeout(retry);unbind();observer.dispose();release();});startup();
 },
});
