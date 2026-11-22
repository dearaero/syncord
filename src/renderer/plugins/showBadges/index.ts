import {BodyMutationObserver} from "../../ui/bodyObserver";
import {decorationScheduler} from '../../core/performance/decorations';
import { onLocaleChange, t as i18nText } from "../../i18n";
import {watchOfficialBadges} from "../../api/ecosystem/badges";
import {isPopoutContext,usernameMutationRelevant} from "../../ui/userNames";
import { definePlugin } from "../../api/plugin";
import {showBadgesSettings as settings,SHOW_BADGES_SETTINGS_EVENT} from "./settings";
import {
  clearBadgeCache,
  unlockUserDecorations,
} from "./badges";
import { scan, uninstallDecorations } from "./inject";
import {sharedDispatcher} from "../../api/discordEvents";
import {acquireUserProfiles} from "../../api/discordEvents/profiles";
function asRecord(value:unknown):Record<string,unknown>|undefined {return value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:undefined;}


/**
 * Shows Discord profile / Nitro badges as icons beside chat usernames.
 * Strategy: shared Discord event hub + demand-driven native profile loading.
 */
export const ShowBadgesPlugin = definePlugin({
  id: "show-badges",
  name: i18nText("ui.show_badges"),
  get description() { return i18nText("ui.show_user_badges_as_icons_next_to_names_in_chat"); },
  author: i18nText("ui.syncord"),
  enabledByDefault: true,

  permissions: {
    discordStores: ["user", "guild", "profile", "message", "channel", "permission"],
    discordActions: ["profile-fetch"],
    media: true,
    native:["ecosystem-badges"],
  },

  start(ctx) {
    const cfg = settings.bind(ctx.plugin.id);
    const size = () => {
      const n = cfg.store.size;
      return typeof n === "number" && n > 8 && n < 32 ? n : 14;
    };

    ctx.css.inject(`
      .dion-badges {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        margin-left: 4px;
        vertical-align: middle;
        pointer-events: none;
      }
      .dion-member-badges {min-width:0;max-width:50%;overflow:hidden;flex-shrink:1;}
      .dion-badge {
        display: block;
        object-fit: contain;
        flex-shrink: 0;
      }
    `);

    let stopped=false;
    let bindTimer=0,bindTimeout=0;
    let flux:ReturnType<typeof sharedDispatcher>;
    let profiles:ReturnType<typeof acquireUserProfiles>|undefined;
    const renderedUsers=new Set<string>();
    let resetPending=false;
    const deferred=decorationScheduler(()=>{
      if(stopped)return;
      try {
        if(resetPending){resetPending=false;uninstallDecorations();clearBadgeCache();}
        const targets=scan(document,size(),cfg.store.memberList===true,ctx.ecosystemBadges?.art);
        renderedUsers.clear();
        for(const node of document.querySelectorAll<HTMLElement>('[data-dion-badge-user]')){
          const id=node.dataset.dionBadgeUser;if(id)renderedUsers.add(id);
        }
        profiles?.update(targets);
        official.update(targets.map(t=>t.userId));
      }catch(error){ctx.log.error("Badge scan failed",error);}
    });
    const schedule=deferred.schedule;
    const official=watchOfficialBadges(ctx.ecosystemBadges?.lookup,ids=>{for(const id of ids)unlockUserDecorations(id);schedule();});
    const onUser=(action:Record<string,unknown>):void=>{
      const profile=asRecord(action.userProfile),member=asRecord(action.guildMember),user=asRecord(profile?.user)??asRecord(action.user)??asRecord(member?.user)??asRecord(asRecord(action.message)?.author);
      const id=user?.id??profile?.user_id??action.userId??action.user_id??member?.userId??member?.user_id;
      if(typeof id!=="string"||!renderedUsers.has(id))return;
      unlockUserDecorations(id);schedule();
    };
    const onPresence=(action:Record<string,unknown>):void=>{
      if(Array.isArray(action.updates))for(const row of action.updates){const rec=asRecord(row);if(rec)onUser(rec);}
      else onUser(action);
    };
    // Drop obsolete requests immediately, but coalesce decorative DOM cleanup
    // with the next scan rather than blocking Discord's CHANNEL_SELECT dispatch.
    const reset=():void=>{resetPending=true;renderedUsers.clear();profiles?.update([]);official.update([]);schedule();};
    const logout=():void=>{resetPending=false;deferred.cancel();uninstallDecorations();clearBadgeCache();renderedUsers.clear();profiles?.update([]);official.update([]);};
    const events=new Map<string,(action:Record<string,unknown>)=>void>([
      ["USER_PROFILE_FETCH_SUCCESS",onUser],["USER_UPDATE",onUser],["CURRENT_USER_UPDATE",onUser],
      ["GUILD_MEMBER_UPDATE",onUser],["GUILD_MEMBER_PROFILE_UPDATE",onUser],["MESSAGE_CREATE",onUser],
      ["PRESENCE_UPDATE",onPresence],["PRESENCE_UPDATES",onPresence],
      ["CHANNEL_SELECT",reset],["CACHE_LOADED_LAZY",reset],["CONNECTION_OPEN",reset],["LOGOUT",logout],
    ]);
    const unbind=():void=>{
      profiles?.release();profiles=undefined;
      for(const [event,handler] of events)flux?.unsubscribe(event,handler);flux=undefined;
    };
    const bind=():boolean=>{
      const live=sharedDispatcher();if(!live)return false;
      try {
        flux=live;for(const [event,handler] of events)flux.subscribe(event,handler);
        profiles=acquireUserProfiles();schedule();return true;
      }catch(error){unbind();ctx.log.warn("Badge event binding unavailable",error);return false;}
    };
    if(!bind()){
      bindTimer=window.setInterval(()=>{if(bind()){window.clearInterval(bindTimer);window.clearTimeout(bindTimeout);bindTimer=bindTimeout=0;}},500);
      bindTimeout=window.setTimeout(()=>{window.clearInterval(bindTimer);bindTimer=bindTimeout=0;},30_000);
    }
    const observer=new BodyMutationObserver(mutations=>{
      if(usernameMutationRelevant(mutations,true))schedule();
    });
    observer.observe(document.body,{childList:true,subtree:true});
    const onScroll=(event:Event):void=>{
      if(event.target instanceof Element&&isPopoutContext(event.target))return;
      schedule();
    };
    document.addEventListener('scroll',onScroll,true);
    window.addEventListener('resize',schedule);
    window.addEventListener(SHOW_BADGES_SETTINGS_EVENT,schedule);
    schedule();
    ctx.disposable(onLocaleChange(schedule));
    ctx.disposable(()=>{
      stopped=true;official.release();observer.disconnect();document.removeEventListener('scroll',onScroll,true);window.removeEventListener('resize',schedule);window.removeEventListener(SHOW_BADGES_SETTINGS_EVENT,schedule);
      window.clearInterval(bindTimer);window.clearTimeout(bindTimeout);
      unbind();deferred.dispose();renderedUsers.clear();uninstallDecorations();clearBadgeCache();
    });

    ctx.log.info("show-badges active");
  },
});

export { settings as showBadgesSettings };
