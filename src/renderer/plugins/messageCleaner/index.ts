import {BodyMutationObserver} from "../../ui/bodyObserver";
import {number as i18nNumber} from "../../i18n";
import { h, localizeError, localizeMessage, messageHtml as i18nHtml, setLocalizedAttribute, setLocalizedHtml, setLocalizedText, t as i18nText } from "../../i18n";
import { definePlugin } from "../../api/plugin";
import { bindTooltip } from "../../ui/tooltip";
import { showToast, ToastType } from "../../ui/toast";
import { MessageCleanup, parseCooldown, type CleanupMode, type CleanupLimit, type CleanupState, type CleanupTarget } from "./engine";
import { assertTarget, discordPort, selectedTarget } from "./discord";

const ID = "Syncord-message-cleaner-toolbar-btn";
const ACTIVE = new Set(["running","waiting","stopping"]);
const CSS = `
#${ID}{display:flex;align-items:center;justify-content:center;width:32px;height:32px;padding:4px;border:0;border-radius:6px;background:transparent;color:var(--interactive-normal,#b5bac1);cursor:pointer}
#${ID}:hover{background:var(--background-modifier-hover,#35373c);color:var(--interactive-hover,#fff)}
#${ID}[data-active=true]{color:var(--text-danger,#fa777c);background:#f23f4218}#${ID}[hidden]{display:none}
#${ID}:focus-visible,.Syncord-message-cleaner :focus-visible{outline:2px solid var(--focus-primary,#00a8fc);outline-offset:2px}
.Syncord-message-cleaner{box-sizing:border-box;width:min(500px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto;padding:22px;border:1px solid var(--border-subtle,#404249);border-radius:12px;background:var(--background-primary,#1e1f22);color:var(--text-normal,#f2f3f5);font:14px/1.5 var(--font-primary,system-ui);box-shadow:0 20px 80px #0008}
.Syncord-message-cleaner::backdrop{background:#000a}.Syncord-message-cleaner *{box-sizing:border-box}
.Syncord-message-cleaner header,.Syncord-message-cleaner footer{display:flex;align-items:center;justify-content:space-between;gap:12px}.Syncord-message-cleaner h2{font-size:20px;margin:0}
.Syncord-message-cleaner p{margin:12px 0;color:var(--text-muted,#949ba4);overflow-wrap:anywhere}
.Syncord-message-cleaner label{display:flex;flex-direction:column;gap:6px;margin:16px 0;font-weight:600}
.Syncord-message-cleaner select,.Syncord-message-cleaner input{width:100%;min-width:0;background:var(--background-secondary-alt,#232428);border:1px solid var(--border-subtle,#404249);border-radius:7px;color:inherit;font:inherit;padding:10px 12px}
.Syncord-message-cleaner small{font-weight:400;color:var(--text-muted,#949ba4)}
.Syncord-message-cleaner button{font:inherit;border:0;border-radius:7px;padding:9px 14px;background:var(--background-secondary,#2b2d31);color:inherit;cursor:pointer}
.Syncord-message-cleaner button:hover{filter:brightness(1.15)}.Syncord-message-cleaner button:disabled{opacity:.5;cursor:default}
.Syncord-message-cleaner [data-start]{background:var(--button-danger-background,#da373c);color:#fff}.Syncord-message-cleaner [data-close]{padding:3px 10px;font-size:22px}
.Syncord-message-cleaner [role=status]{min-height:3em;padding:12px;border-radius:8px;background:var(--background-secondary,#2b2d31);overflow-wrap:anywhere}
.Syncord-message-cleaner [role=status][data-error=true]{color:var(--text-danger,#fa777c)}
.Syncord-message-cleaner [data-performance]{font-size:12px;white-space:pre-line;overflow-wrap:anywhere}
.Syncord-message-cleaner footer{justify-content:flex-end;flex-wrap:wrap;margin-top:18px}
`;
function deletionText(state: CleanupState): string {
  return state.bulkProcessed ? i18nText("ui.value_deleted_individually_value_processed_in_bulk", {v0: state.deleted-state.bulkProcessed, v1: state.bulkProcessed}) : i18nText("ui.value_deleted", {v0: state.deleted});
}
export const MessageCleanerPlugin = definePlugin({
  id:"message-cleaner",name:i18nText("ui.message_cleaner"),author:i18nText("ui.syncord"),enabledByDefault:true,
  get description() { return i18nText("ui.delete_your_own_messages_in_the_current_dm_or_channel_with_optional_co"); },
  permissions:{media:true,userData:true,discordStores:["user","channel","message","UserStore","SelectedChannelStore","ChannelStore","PermissionStore"],discordActions:["message-delete"]},
  start(ctx) {
    ctx.css.inject(CSS);
    let runner: MessageCleanup | undefined;
    let closeDialog: (()=>void) | undefined;
    let renderDialog: (()=>void) | undefined;
    let disposed = false;
    let wrapper: HTMLElement | undefined;
    let disposeTooltip: (()=>void) | undefined;
    let raf = 0;
    let unsubscribe: (()=>void) | undefined;
    const paint = (): void => {
      const button=document.getElementById(ID); if (!button) return;
      const running=!!runner?.active();
      button.dataset.active=String(running);
      button.setAttribute("aria-label",running?i18nText("ui.show_message_cleanup_progress"):selectedTarget()?i18nText("ui.clean_my_messages"):i18nText("ui.clean_my_messages_open_a_dm_or_text_channel_first"));
      button.setAttribute("aria-pressed",String(running));
    };
    const changed = (state: CleanupState): void => {
      if (disposed) return;
      renderDialog?.();
      // Terminal state is published before the runner releases its in-flight guard.
      const button=document.getElementById(ID);if(button)button.dataset.active=String(ACTIVE.has(state.phase));
      if (["completed","stopped","error"].includes(state.phase)) {
        showToast(`${localizeMessage(state.detail)} ${deletionText(state)}${state.missing?i18nText("ui.value_already_removed", {v0: state.missing}):""}.`,{type:state.phase==="error"?ToastType.FAILURE:ToastType.SUCCESS});
      }
    };
    const open = (): void => {
      if (disposed) return;
      closeDialog?.();
      let target: CleanupTarget | undefined = runner?.active() ? runner.snapshot().target : selectedTarget();
      if (!target) { showToast(i18nText("ui.open_a_dm_or_a_text_channel_first"),{type:ToastType.FAILURE}); return; }
      const previous=document.activeElement;
      const dialog=document.createElement("dialog");dialog.className="Syncord-message-cleaner";setLocalizedAttribute(dialog, "aria-label", "ui.clean_my_messages");
      setLocalizedHtml(dialog, `<header><h2>${i18nHtml("ui.clean_my_messages")}</h2><button type="button" data-close aria-label="${h("ui.close_message_cleaner")}" data-si18n-aria-label="ui.close_message_cleaner">×</button></header><p data-target></p><label>${i18nHtml("ui.messages")}<select data-limit><option value="10">${i18nHtml("ui.my_last_10_messages")}</option><option value="100">${i18nHtml("ui.my_last_100_messages")}</option><option value="all">${i18nHtml("ui.all_my_messages")}</option></select></label><label>${i18nHtml("ui.speed")}<select data-speed><option value="steady">${i18nHtml("ui.steady_1_4_messages_s_target")}</option><option value="adaptive">${i18nHtml("ui.adaptive_quota_based_speed")}</option></select><small>${i18nHtml("ui.steady_spaces_request_starts_evenly_actual_speed_depends_on_discord_li")}</small></label><label>${i18nHtml("ui.cooldown_seconds_optional")}<input data-cooldown type="number" min="0" max="86400" step="0.1" placeholder="${h("ui.automatic")}" data-si18n-placeholder="ui.automatic"><small>${i18nHtml("ui.leave_empty_to_use_the_selected_speed_mode_a_cooldown_keeps_deletions_")}</small></label><p>${i18nHtml("ui.only_your_own_messages_in_this_chat_are_deleted_newest_first_deletion_")}</p><div role="status" aria-live="polite"></div><p data-performance hidden></p><footer><button type="button" data-stop hidden>${i18nHtml("ui.stop_cleanup")}</button><button type="button" data-start>${i18nHtml("ui.delete_my_last_10_messages")}</button></footer>`);
      const limit=dialog.querySelector<HTMLSelectElement>('[data-limit]')!;
      const speed=dialog.querySelector<HTMLSelectElement>('[data-speed]')!;
      const speedSetting=ctx.settings.get<string>("speedMode","steady");speed.value=speedSetting==="adaptive"?"adaptive":"steady";
      const cooldown=dialog.querySelector<HTMLInputElement>('[data-cooldown]')!;
      const start=dialog.querySelector<HTMLButtonElement>('[data-start]')!;
      const stop=dialog.querySelector<HTMLButtonElement>('[data-stop]')!;
      const status=dialog.querySelector<HTMLElement>('[role=status]')!;
      const stored=ctx.settings.get<string>("cooldown","");cooldown.value=typeof stored==="string"?stored:"";
      let countdown=0;
      const render = (): void => {
        clearTimeout(countdown);countdown=0;
        const state=runner?.snapshot();const active=state&&ACTIVE.has(state.phase);
        if(active&&state.target){target=state.target;speed.value=state.mode??"adaptive";limit.value=state.limit===null?"all":String(state.limit);}
        dialog.querySelector('[data-target]')!.textContent=i18nText("ui.target_value_value", {v0: target!.name, v1: target!.channelId});
        limit.disabled=!!active;speed.disabled=!!active;cooldown.disabled=!!active;start.hidden=!!active;stop.hidden=!active;stop.disabled=state?.phase==="stopping";
        start.textContent=limit.value==="all"?i18nText("ui.delete_all_my_messages"):i18nText("ui.delete_my_last_value_messages", {v0: limit.value});
        status.dataset.error=String(state?.phase==="error");
        status.textContent=state?.target?.channelId===target!.channelId?i18nText("ui.value_value_value_scannedvaluevaluevalue", {v0: localizeMessage(state.detail), v1: deletionText(state), v2: state.scanned, v3: state.missing?i18nText("ui.value_already_removed_c6bf836", {v0: state.missing}):"", v4: state.skipped?i18nText("ui.value_unsupported_messages_skipped", {v0: state.skipped}):"", v5: state.waitUntil>Date.now()?i18nText("ui.values_remaining_ffc6e92", {v0: Math.ceil((state.waitUntil-Date.now())/1000)}):""}):i18nText("ui.ready_check_the_target_and_choose_how_many_of_your_messages_to_delete");
        const performance=dialog.querySelector<HTMLElement>('[data-performance]')!;
        const metrics=state?.metrics;
        performance.hidden=!metrics||state?.target?.channelId!==target!.channelId;
        if(metrics)setLocalizedText(performance, "ui.values_elapsed_value_messages_s_individual_deletions_overall_average_rec", {v0: i18nNumber((metrics.elapsedMs/1000),{useGrouping:false,minimumFractionDigits:1,maximumFractionDigits:1}), v1: i18nNumber(metrics.messagesPerSecond,{useGrouping:false,minimumFractionDigits:2,maximumFractionDigits:2}), v2: metrics.recentMessagesPerSecond===undefined?i18nText("ui.measuring_first_10s"):i18nText("ui.value_messages_s_last_completed_10s_window", {v0: i18nNumber(metrics.recentMessagesPerSecond,{useGrouping:false,minimumFractionDigits:2,maximumFractionDigits:2})}), v3: state!.pacing, v4: metrics.peakConcurrency, v5: Math.round(metrics.averageRequestMs), v6: i18nNumber((metrics.rateWaitMs/1000),{useGrouping:false,minimumFractionDigits:1,maximumFractionDigits:1}), v7: i18nNumber((metrics.cooldownWaitMs/1000),{useGrouping:false,minimumFractionDigits:1,maximumFractionDigits:1}), v8: i18nNumber((metrics.pacingWaitMs/1000),{useGrouping:false,minimumFractionDigits:1,maximumFractionDigits:1}), v9: metrics.rateLimitResponses, v10: Math.round(state!.automaticIntervalMs??0), v11: state!.lastRetryMs?i18nText("ui.last_retry_values_value", {v0: i18nNumber((state!.lastRetryMs/1000),{useGrouping:false,minimumFractionDigits:2,maximumFractionDigits:2}), v1: state!.retrySource}):""});
        if(active)countdown=window.setTimeout(render,1000);
      };
      const close = (): void => { clearTimeout(countdown);dialog.close();dialog.remove();renderDialog=undefined;closeDialog=undefined;if(previous instanceof HTMLElement&&previous.isConnected)previous.focus(); };
      closeDialog=close;renderDialog=render;
      dialog.querySelector('[data-close]')!.addEventListener("click",close);
      dialog.addEventListener("cancel",event=>{event.preventDefault();close();});
      limit.addEventListener("change",render);
      stop.addEventListener("click",()=>runner?.stop());
      start.addEventListener("click",()=>{
        if(runner?.active())return;
        try {
          const ms=parseCooldown(cooldown.value);
          assertTarget(target!);
          const count:CleanupLimit=limit.value==="all"?null:limit.value==="100"?100:10;
          ctx.settings.set("cooldown",cooldown.value);
          const mode:CleanupMode=speed.value==="adaptive"?"adaptive":"steady";ctx.settings.set("speedMode",mode);
          runner??=new MessageCleanup(discordPort(ctx.log),changed);
          void runner.run(target!,count,ms,mode).catch(error=>{status.dataset.error="true";status.textContent=error instanceof Error?localizeError(error):i18nText("ui.cleanup_could_not_start");}).finally(paint);
        } catch(error) {status.dataset.error="true";status.textContent=error instanceof Error?localizeError(error):i18nText("ui.cleanup_could_not_start");}
      });
      document.body.append(dialog);render();dialog.showModal();
    };
    const mount = (): void => {
      if(disposed)return;
      if(!unsubscribe){
        const s=(window.Syncord?.common?.stores?.SelectedChannelStore ?? window.Syncord?.webpack?.findByStoreName?.("SelectedChannelStore")) as {addChangeListener?(fn:()=>void):void;removeChangeListener?(fn:()=>void):void}|undefined;
        if(s?.addChangeListener&&s.removeChangeListener){s.addChangeListener(paint);unsubscribe=()=>s.removeChangeListener?.(paint);}
      }
      if(document.getElementById(ID))return;
      const recorder=document.getElementById("Syncord-recording-toolbar-btn");
      const canvas=document.getElementById("Syncord-multichat-toolbar-btn");
      const inbox=document.querySelector<HTMLElement>('[aria-label="Inbox"],[aria-label="Gelen Kutusu"]');
      const anchor=recorder??canvas;
      const slot=anchor?.parentElement??inbox?.closest<HTMLElement>('[class*="iconWrapper"]')??inbox?.parentElement;
      if(!slot?.parentElement)return;
      disposeTooltip?.();wrapper?.remove();wrapper=document.createElement("div");wrapper.className=slot.className;
      const button=document.createElement("button");button.id=ID;button.type="button";button.setAttribute("aria-haspopup","dialog");
      setLocalizedHtml(button, '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9 3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1h4a1 1 0 1 1 0 2h-1l-1 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 6H5a1 1 0 0 1 0-2h4V3Zm2 1h2V3h-2v1Zm-1 5v9h2V9h-2Zm4 0v9h2V9h-2Z"/></svg>');
      button.addEventListener("click",open);wrapper.append(button);if(anchor)slot.after(wrapper);else slot.before(wrapper);
      disposeTooltip=bindTooltip(button,()=>button.getAttribute("aria-label")??i18nText("ui.clean_my_messages"),{position:"bottom"});paint();
    };
    const observer=new BodyMutationObserver(()=>{if((document.getElementById(ID)&&unsubscribe)||raf)return;raf=requestAnimationFrame(()=>{raf=0;mount();});});
    observer.observe(document.body,{childList:true,subtree:true});mount();
    ctx.disposable(()=>{disposed=true;runner?.stop();closeDialog?.();unsubscribe?.();observer.disconnect();if(raf)cancelAnimationFrame(raf);disposeTooltip?.();wrapper?.remove();});
  },
});
