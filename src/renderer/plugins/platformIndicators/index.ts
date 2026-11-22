import {BodyMutationObserver} from "../../ui/bodyObserver";
import {decorationScheduler} from '../../core/performance/decorations';
import { onLocaleChange, t as i18nText } from "../../i18n";
import {usernameMutationRelevant} from "../../ui/userNames";
import {definePlugin} from '../../api/plugin';
import {sharedDispatcher,type Action} from '../../api/discordEvents';
import {isPlatformPresenceStore,type PlatformPresenceStore} from '../../api/discordEvents/presence';
import {platformSettings,PLATFORM_ID,PLATFORM_SETTINGS_EVENT} from './settings';
import {platformAnchors} from './anchors';
import {PlatformRenderer} from './render';
function record(value:unknown):Record<string,unknown>|undefined {return value!==null&&typeof value==='object'?value as Record<string,unknown>:undefined;}
function eventUser(action:Action):string|undefined {
  const id=record(action.user)?.id??action.userId??action.user_id;return typeof id==='string'?id:undefined;
}
export const PlatformIndicatorsPlugin=definePlugin({
  id:PLATFORM_ID,name:i18nText("ui.platform_indicators"),author:i18nText("ui.syncord"),enabledByDefault:true,
  get description() { return i18nText("ui.show_reported_desktop_mobile_browser_console_and_vr_platforms_beside_u"); },
  permissions:{media:true,userData:true,discordStores:['presence','user','channel','PresenceStore','ChannelStore']},
  start(ctx){
    const cfg=platformSettings.bind(PLATFORM_ID),renderer=new PlatformRenderer();
    let stopped=false,suspended=false,rescan=true,retry=0,retryEnd=0;
    let flux:ReturnType<typeof sharedDispatcher>,cachedStore:PlatformPresenceStore|undefined;
    const changed=new Set<string>();
    ctx.css.inject(`
      [data-syncord-platforms]{display:inline-flex;align-items:center;gap:3px;margin-inline-start:5px;margin-inline-end:4px;vertical-align:middle;flex:0 0 auto;max-width:100%;line-height:1;}
      .syncord-platform-icon{display:inline-flex;align-items:center;justify-content:center;width:14px;height:16px;flex:0 0 14px;color:var(--text-muted,#a0a1ab);}
      .syncord-platform-icon>svg{display:block;width:14px;height:14px;flex:none;pointer-events:none;}
      .syncord-platform-icon[data-source=session][data-status=online]{color:var(--status-positive,#43a56d);}
      .syncord-platform-icon[data-source=session][data-status=idle]{color:var(--status-warning,#f0b232);}
      .syncord-platform-icon[data-source=session][data-status=dnd]{color:var(--status-danger,#f23f43);}
    `);
    const store=():PlatformPresenceStore|undefined=>{
      const common=window.Syncord?.common?.stores.PresenceStore;
      if(isPlatformPresenceStore(common))return cachedStore=common;
      if(cachedStore)return cachedStore;
      try{const found=window.Syncord?.webpack?.findByStoreName('PresenceStore');if(isPlatformPresenceStore(found))cachedStore=found;}catch{/* Lazy native store: retry on a later render. */}
      return cachedStore;
    };
    const deferred=decorationScheduler(()=>{
      if(stopped||suspended)return;
      if(!flux)bind();
      try {
        if(rescan)renderer.targets(platformAnchors(document,cfg.snapshot()));
        renderer.refresh(store(),cfg.get('activityPlatforms')===true,rescan?undefined:changed);
      }catch(error){ctx.log.warn('Platform indicator render unavailable',error);}
      rescan=false;changed.clear();
    });
    const schedule=(scan=true):void=>{if(stopped||suspended)return;rescan ||= scan;deferred.schedule();};
    const presence=(action:Action):void=>{
      const mark=(row:Action):void=>{const id=eventUser(row);if(id&&renderer.visible(id))changed.add(id);};
      if(Array.isArray(action.updates)){for(const row of action.updates){const value=record(row);if(value)mark(value);}}else mark(action);
      if(changed.size)schedule(false);
    };
    const reset=():void=>{suspended=false;cachedStore=undefined;renderer.clear();schedule();};
    const clear=():void=>{suspended=true;deferred.cancel();changed.clear();renderer.clear();cachedStore=undefined;rescan=true;};
    const events=new Map<string,(action:Action)=>void>([
      ['PRESENCE_UPDATE',presence],['PRESENCE_UPDATES',presence],['CHANNEL_SELECT',()=>schedule()],
      ['CONNECTION_OPEN',reset],['CONNECTION_OPEN_SUPPLEMENTAL',reset],['CONNECTION_RESUMED',reset],['CACHE_LOADED_LAZY',reset],
      ['LOGOUT',clear],['CONNECTION_CLOSED',clear],['CONNECTION_LOST',clear],
    ]);
    const unbind=():void=>{for(const [type,handler] of events)flux?.unsubscribe(type,handler);flux=undefined;};
    const bind=():boolean=>{
      const live=sharedDispatcher();if(!live)return false;
      try{flux=live;for(const [type,handler] of events)flux.subscribe(type,handler);window.clearInterval(retry);window.clearTimeout(retryEnd);retry=retryEnd=0;return true;}
      catch(error){unbind();ctx.log.warn('Platform presence events unavailable',error);return false;}
    };
    const observer=new BodyMutationObserver(mutations=>{
      if(usernameMutationRelevant(mutations))schedule();
    });
    const structural=():void=>schedule();
    ctx.disposable(onLocaleChange(structural));
    ctx.disposable(()=>{
      stopped=true;observer.disconnect();deferred.dispose();window.clearInterval(retry);window.clearTimeout(retryEnd);
      document.removeEventListener('scroll',structural,true);window.removeEventListener('resize',structural);window.removeEventListener(PLATFORM_SETTINGS_EVENT,structural);
      changed.clear();renderer.clear();cachedStore=undefined;unbind();
    });
    if(!bind()){
      retry=window.setInterval(()=>{if(!bind())return;window.clearInterval(retry);window.clearTimeout(retryEnd);retry=retryEnd=0;schedule();},500);
      retryEnd=window.setTimeout(()=>{window.clearInterval(retry);retry=retryEnd=0;},30_000);
    }
    observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['id','href','data-user-id','data-list-item-id']});
    document.addEventListener('scroll',structural,true);window.addEventListener('resize',structural);window.addEventListener(PLATFORM_SETTINGS_EVENT,structural);schedule();
  },
});
