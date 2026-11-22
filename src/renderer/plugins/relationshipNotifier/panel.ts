import { setLocalizedText, productHtml, productAttribute, h, messageHtml as i18nHtml } from "../../i18n";
import {relationshipSettings,config} from './settings';
import {RN_ID,RN_CHANGED,RN_STATUS} from './types';
import {relationshipStatus,relationshipStatusMessage} from './runtime';
import {openRelationshipHistory} from './view';
import {hideTooltip} from '../../ui/tooltip';
let expanded=false;
export const isRelationshipExpanded=():boolean=>expanded;
export const relationshipExpandButtonHtml=():string=>`<button type="button" class="dion-icon-btn dion-expand-btn" data-rn-expand aria-expanded="${expanded}" aria-label="${h("ui.relationship_tracker_options")}" data-si18n-aria-label="ui.relationship_tracker_options"><svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m7.41 8.59 4.59 4.58 4.59-4.58L18 10l-6 6-6-6 1.41-1.41Z"/></svg></button>`;
const escape=(value:string):string=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]??c));
export function relationshipSectionHtml():string {
 const cfg=config();
 const field=(key:keyof typeof relationshipSettings.schema):string=>{
  const def=relationshipSettings.schema[key];if(def.type==='number')return `<label class="dion-field-row"><span class="dion-setting-title">${productHtml(def.title)}</span><input type="number" min="4" max="60" data-rn-option="${key}" ${productAttribute("aria-label",def.title)} value="${cfg[key]}"></label>`;
  return `<label class="dion-setting-row"><span class="dion-setting-title">${productHtml(def.title)}</span><span class="dion-switch"><input type="checkbox" role="switch" data-rn-option="${key}" ${productAttribute("aria-label",def.title)} ${cfg[key]?'checked':''}><span class="dion-track" aria-hidden="true"></span></span></label>`;
 };
 return `<div class="dion-plugin-details"><div class="dion-details-head"><div><span class="dion-eyebrow">${i18nHtml("ui.relationship_tracker")}</span><h4>${i18nHtml("ui.relationships_history_and_friend_backup")}</h4></div><button type="button" class="dion-primary-btn" data-rn-history>${i18nHtml("ui.history_backup")}</button></div><p class="dion-setting-desc" data-rn-status role="status">${escape(relationshipStatus())}</p><p class="dion-setting-desc">${i18nHtml("ui.stored_locally_and_separated_by_discord_account_syncord_never_reports_")}</p><details open><summary class="dion-setting-title">${i18nHtml("ui.monitor")}</summary>${(['friends','requests','groups','servers','members'] as const).map(field).join('')}</details><details><summary class="dion-setting-title">${i18nHtml("ui.local_data_and_offline_changes")}</summary>${(['history','backup','offline'] as const).map(field).join('')}<p class="dion-setting-desc">${i18nHtml("ui.first_run_establishes_a_baseline_offline_changes_use_complete_discord_")}</p></details><details><summary class="dion-setting-title">${i18nHtml("ui.notifications")}</summary><p class="dion-setting-desc">${i18nHtml("ui.notifications_require_the_corresponding_monitor_option_notify_about_of")}</p>${(['notifyFriendAdded','notifyFriendRemoved','notifyRequestReceived','notifyIncomingRequestEnded','notifyOutgoingRequestEnded','notifyGroupRemoved','notifyServerRemoved','notifyMemberAdded','notifyMemberRemoved','notifySelf','notifyOffline','duration'] as const).map(field).join('')}</details></div>`;
}
export function bindRelationshipPanel(root:HTMLElement):()=>void {
 const click=(event:Event):void=>{
  const target=event.target instanceof Element?event.target:null;if(!target)return;
  const expand=target.closest('[data-rn-expand]');if(expand){event.preventDefault();event.stopPropagation();hideTooltip();expanded=!expanded;expand.setAttribute('aria-expanded',String(expanded));expand.closest('.dion-plugin')?.classList.toggle('is-open',expanded);}
  if(target.closest('[data-rn-history]')){event.preventDefault();openRelationshipHistory();}
 };
 const change=(event:Event):void=>{
  const input=event.target;if(!(input instanceof HTMLInputElement))return;const key=input.dataset.rnOption;
  const settings=relationshipSettings.bind(RN_ID);if(!relationshipSettings.keys.some(name=>name===key))return;
  const name=key as keyof typeof relationshipSettings.schema;
  if(name==='duration'){if(!input.value.trim()||!Number.isFinite(Number(input.value)))return;settings.set(name,Math.max(4,Math.min(60,Number(input.value))));input.value=String(config().duration);}
  else settings.set(name,input.checked);window.dispatchEvent(new Event(RN_CHANGED));
 };
 const paint=():void=>{const el=root.querySelector('[data-rn-status]');if(el){const message=relationshipStatusMessage();setLocalizedText(el,message.key,message.params);}};
 root.addEventListener('click',click);root.addEventListener('change',change);window.addEventListener(RN_STATUS,paint);paint();
 return()=>{root.removeEventListener('click',click);root.removeEventListener('change',change);window.removeEventListener(RN_STATUS,paint);};
}
