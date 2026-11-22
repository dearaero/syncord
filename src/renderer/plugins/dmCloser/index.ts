import {BodyMutationObserver} from "../../ui/bodyObserver";
import { h, localizeMessage, messageHtml as i18nHtml, setLocalizedAttribute, setLocalizedHtml, setLocalizedText, t as i18nText } from "../../i18n";
import {definePlugin} from '../../api/plugin';
import {bindTooltip} from '../../ui/tooltip';
import {showToast,ToastType} from '../../ui/toast';
import {DmCloser,type Plan,type State} from './engine';
import {assertAccount,closingPlan,discordPort} from './discord';
const ID='Syncord-dm-closer-toolbar-btn';
const activePhase=(state?:State):boolean=>!!state&&['running','waiting','stopping'].includes(state.phase);
const summary=(s:State):string=>i18nText("ui.value_dms_closed_value_groups_left_value_servers_left_value_skipped_va", {v0: s.closed, v1: s.groups, v2: s.guilds, v3: s.skipped, v4: s.failed});
const CSS=`
#${ID}{display:flex;align-items:center;justify-content:center;width:32px;height:32px;padding:4px;border:0;border-radius:6px;background:transparent;color:var(--interactive-normal,#b5bac1);cursor:pointer}
#${ID}:hover{background:var(--background-modifier-hover,#35373c);color:var(--interactive-hover,#fff)}
#${ID}[data-active=true]{color:var(--text-danger,#fa777c);background:#f23f4218}
#${ID}:focus-visible,.Syncord-dm-closer :focus-visible{outline:2px solid var(--focus-primary,#00a8fc);outline-offset:2px}
.Syncord-dm-closer{box-sizing:border-box;width:min(540px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto;padding:22px;border:1px solid var(--border-subtle,#404249);border-radius:12px;background:var(--background-primary,#1e1f22);color:var(--text-normal,#f2f3f5);font:14px/1.5 var(--font-primary,system-ui);box-shadow:0 20px 80px #0008}
.Syncord-dm-closer::backdrop{background:#000a}.Syncord-dm-closer *{box-sizing:border-box}
.Syncord-dm-closer header,.Syncord-dm-closer footer{display:flex;align-items:center;justify-content:space-between;gap:12px}
.Syncord-dm-closer h2{font-size:20px;margin:0}.Syncord-dm-closer p{margin:12px 0;overflow-wrap:anywhere;color:var(--text-muted,#949ba4)}
.Syncord-dm-closer label{display:flex;align-items:flex-start;gap:10px;padding:12px 0;cursor:pointer}
.Syncord-dm-closer input[type=checkbox]{appearance:auto;flex:0 0 auto;width:18px;height:18px;margin:2px 0;accent-color:var(--brand-500,#5865f2)}
.Syncord-dm-closer label span{min-width:0}.Syncord-dm-closer small{display:block;font-weight:400;color:var(--text-muted,#949ba4)}
.Syncord-dm-closer button{font:inherit;border:0;border-radius:7px;padding:9px 14px;background:var(--background-secondary,#2b2d31);color:inherit;cursor:pointer}
.Syncord-dm-closer button:hover{filter:brightness(1.15)}.Syncord-dm-closer button:disabled{opacity:.5;cursor:default}
.Syncord-dm-closer [data-start]{background:var(--button-danger-background,#da373c);color:#fff}.Syncord-dm-closer [data-close]{padding:3px 10px;font-size:22px}
.Syncord-dm-closer [data-scope]{background:var(--background-secondary,#2b2d31);padding:12px;border-radius:8px;color:inherit;white-space:pre-line}
.Syncord-dm-closer [role=status]{padding:12px;border-radius:8px;background:var(--background-secondary,#2b2d31);overflow-wrap:anywhere;white-space:pre-line}
.Syncord-dm-closer [data-error=true]{color:var(--text-danger,#fa777c)}
.Syncord-dm-closer progress{width:100%;height:10px;accent-color:var(--brand-500,#5865f2)}
.Syncord-dm-closer details{margin:12px 0}.Syncord-dm-closer details>summary{cursor:pointer;color:var(--text-muted,#949ba4)}
.Syncord-dm-closer ul{max-height:160px;overflow:auto;padding-left:20px;overflow-wrap:anywhere}.Syncord-dm-closer footer{justify-content:flex-end;flex-wrap:wrap;margin-top:18px}
.Syncord-dm-closer [data-issues]{font-size:12px;white-space:pre-line;overflow-wrap:anywhere}
`;
export const DmCloserPlugin=definePlugin({
  id:'dm-closer',name:i18nText("ui.dm_closer"),author:i18nText("ui.syncord"),enabledByDefault:true,
  get description() { return i18nText("ui.close_all_current_dms_and_leave_group_chats_optionally_leave_servers_y"); },
  permissions:{media:true,discordStores:['user','channel','guild','UserStore','ChannelStore','GuildStore'],discordActions:['dm-close','group-leave','guild-leave']},
  start(ctx){
    ctx.css.inject(CSS);
    let runner:DmCloser|undefined,disposed=false,frame=0,wrapper:HTMLElement|undefined,tooltip:(()=>void)|undefined;
    let closeDialog:(()=>void)|undefined,renderDialog:((state:State)=>void)|undefined;
    const paint=(state?:State):void=>{
      const button=document.getElementById(ID);if(!button)return;
      const active=state?activePhase(state):!!runner?.active();button.dataset.active=String(active);
      button.setAttribute('aria-label',active?i18nText("ui.show_dm_closing_progress"):i18nText("ui.close_dms_and_leave_groups"));button.setAttribute('aria-pressed',String(active));
    };
    const changed=(state:State):void=>{
      if(disposed)return;renderDialog?.(state);paint(state);
      if(['completed','stopped','error'].includes(state.phase))showToast(`${localizeMessage(state.detail)} ${summary(state)}`,{type:state.phase==='error'||state.failed?ToastType.FAILURE:ToastType.SUCCESS});
    };
    const open=():void=>{
      if(disposed)return;closeDialog?.();
      let plan:Plan|undefined=runner?.active()?runner.currentPlan():undefined;
      let state:State|undefined=runner?.active()?runner.snapshot():undefined;
      let problem='';const previous=document.activeElement;
      const dialog=document.createElement('dialog');dialog.className='Syncord-dm-closer';setLocalizedAttribute(dialog, 'aria-label', "ui.close_dms_and_leave_groups");
      setLocalizedHtml(dialog, `<header><h2>${i18nHtml("ui.close_dms_and_leave_groups")}</h2><button type="button" data-close aria-label="${h("ui.close_dialog")}" data-si18n-aria-label="ui.close_dialog">×</button></header><p>${i18nHtml("ui.close_every_dm_in_your_current_list_and_leave_every_group_chat_closing")}</p><label><input type="checkbox" data-servers><span>${i18nHtml("ui.also_leave_servers")}<small>${i18nHtml("ui.servers_you_own_are_always_kept_servers_with_unknown_ownership_are_als")}</small></span></label><p data-scope></p><details><summary>${i18nHtml("ui.review_targets")}</summary><ul data-targets></ul></details><p>${i18nHtml("ui.only_the_reviewed_list_is_processed_new_conversations_and_servers_are_")}</p><progress max="1" value="0" aria-label="${h("ui.closing_progress")}" hidden data-si18n-aria-label="ui.closing_progress"></progress><div role="status" aria-live="polite"></div><details data-problems hidden><summary>${i18nHtml("ui.skipped_targets_and_errors_latest_20")}</summary><p data-issues></p></details><footer><button type="button" data-refresh>${i18nHtml("ui.refresh_list")}</button><button type="button" data-stop hidden>${i18nHtml("ui.stop")}</button><button type="button" data-start>${i18nHtml("ui.start")}</button></footer>`);
      const servers=dialog.querySelector<HTMLInputElement>('[data-servers]')!;
      const start=dialog.querySelector<HTMLButtonElement>('[data-start]')!;
      const stop=dialog.querySelector<HTMLButtonElement>('[data-stop]')!;
      const refresh=dialog.querySelector<HTMLButtonElement>('[data-refresh]')!;
      const status=dialog.querySelector<HTMLElement>('[role=status]')!;
      servers.checked=plan?.includeGuilds??false;
      let countdown=0;
      const targets=():void=>{
        const list=dialog.querySelector('[data-targets]')!;list.replaceChildren();
        for(const target of plan?.targets.slice(0,60)??[]){const li=document.createElement('li');li.textContent=`${target.kind==='dm'?'DM':target.kind==='group'?i18nText("ui.group"):i18nText("ui.server")} · ${target.name} · ${target.id}`;list.append(li);}
        if((plan?.targets.length??0)>60){const li=document.createElement('li');setLocalizedText(li, "ui.and_value_more_targets", {v0: plan!.targets.length-60});list.append(li);}
      };
      const render=():void=>{
        window.clearTimeout(countdown);countdown=0;const active=activePhase(state);
        servers.disabled=active;refresh.disabled=active;start.hidden=active;start.disabled=!plan||!plan.targets.length||!!problem;
        stop.hidden=!active;stop.disabled=state?.phase==='stopping';
        dialog.querySelector('[data-scope]')!.textContent=plan?`Account: ${plan.userId}\n${plan.targets.filter(t=>t.kind==='dm').length} DMs to close · ${plan.targets.filter(t=>t.kind==='group').length} groups to leave\n${plan.includeGuilds?i18nText("ui.value_servers_to_leave_value_owned_servers_kept_value_with_unknown_own", {v0: plan.targets.filter(t=>t.kind==='guild').length, v1: plan.owned, v2: plan.unknown}):i18nText("ui.servers_will_be_kept")}`:i18nText("ui.list_unavailable_refresh_after_discord_finishes_loading");
        status.dataset.error=String(!!problem||state?.phase==='error'||!!state?.failed);
        status.textContent=problem||(state?`${localizeMessage(state.detail)}\n${summary(state)}${state.waitUntil>Date.now()?`\n${Math.ceil((state.waitUntil-Date.now())/1000)}s remaining`:''}`:plan?.targets.length?i18nText("ui.ready_review_the_scope_then_press_start"):i18nText("ui.nothing_to_close"));
        const progress=dialog.querySelector('progress')!;progress.hidden=!state;progress.max=Math.max(1,state?.total??1);progress.value=state?.processed??0;
        dialog.querySelector<HTMLElement>('[data-problems]')!.hidden=!state?.issues.length;
        dialog.querySelector('[data-issues]')!.textContent=state?.issues.join('\n')??'';
        if(active)countdown=window.setTimeout(render,1000);
      };
      const load=():void=>{
        state=undefined;problem='';plan=undefined;
        try{plan=closingPlan(servers.checked);}catch(error){problem=error instanceof Error?error.message:i18nText("ui.the_list_could_not_be_loaded");}
        targets();render();
      };
      const close=():void=>{
        window.clearTimeout(countdown);dialog.close();dialog.remove();closeDialog=undefined;renderDialog=undefined;
        if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();
      };
      closeDialog=close;renderDialog=s=>{state=s;render();};
      dialog.querySelector('[data-close]')!.addEventListener('click',close);
      dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
      servers.addEventListener('change',load);refresh.addEventListener('click',load);stop.addEventListener('click',()=>runner?.stop());
      start.addEventListener('click',()=>{
        if(disposed||runner?.active()||!plan)return;
        try{
          assertAccount(plan.userId);problem='';runner??=new DmCloser(discordPort(ctx.log),changed);
          void runner.run(plan).catch(error=>{problem=error instanceof Error?error.message:i18nText("ui.closing_could_not_start");render();}).finally(()=>{if(!disposed)paint();});
        }catch(error){problem=error instanceof Error?error.message:i18nText("ui.closing_could_not_start");render();}
      });
      document.body.append(dialog);if(plan){targets();render();}else load();dialog.showModal();
    };
    const mount=():void=>{
      if(disposed||document.getElementById(ID))return;
      const anchor=document.getElementById('Syncord-message-cleaner-toolbar-btn')??document.getElementById('Syncord-recording-toolbar-btn')??document.getElementById('Syncord-multichat-toolbar-btn');
      const inbox=document.querySelector<HTMLElement>('[aria-label="Inbox"],[aria-label="Gelen Kutusu"]');
      const slot=anchor?.parentElement??inbox?.closest<HTMLElement>('[class*="iconWrapper"]')??inbox?.parentElement;
      if(!slot?.parentElement)return;
      tooltip?.();wrapper?.remove();wrapper=document.createElement('div');wrapper.className=slot.className;
      const button=document.createElement('button');button.id=ID;button.type='button';button.setAttribute('aria-haspopup','dialog');
      setLocalizedHtml(button, '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h8v-2H4V4h8V2H4Zm12.3 4.3-1.4 1.4 3.3 3.3H8v2h10.2l-3.3 3.3 1.4 1.4L22 12l-5.7-5.7Z"/></svg>');
      button.addEventListener('click',open);wrapper.append(button);if(anchor)slot.after(wrapper);else slot.before(wrapper);
      tooltip=bindTooltip(button,()=>button.getAttribute('aria-label')??i18nText("ui.close_dms_and_leave_groups"),{position:'bottom'});paint();
    };
    const observer=new BodyMutationObserver(()=>{if(disposed||document.getElementById(ID)||frame)return;frame=requestAnimationFrame(()=>{frame=0;mount();});});
    observer.observe(document.body,{childList:true,subtree:true});mount();
    ctx.disposable(()=>{disposed=true;runner?.stop();closeDialog?.();observer.disconnect();if(frame)cancelAnimationFrame(frame);tooltip?.();wrapper?.remove();});
  },
});
