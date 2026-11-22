import { productHtml, productAttribute, h, messageHtml as i18nHtml } from "../../i18n";
import {platformSettings,PLATFORM_ID,PLATFORM_SETTINGS_EVENT} from './settings';
import {hideTooltip} from '../../ui/tooltip';
let expanded=false;
export function isPlatformsExpanded():boolean{return expanded;}
export function platformsExpandButtonHtml():string {
  return `<button type="button" class="dion-icon-btn dion-expand-btn" data-dion-platforms-expand aria-expanded="${expanded}" aria-label="${h("ui.platform_indicators_options")}" data-si18n-aria-label="ui.platform_indicators_options"><svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m7.41 8.59 4.59 4.58 4.59-4.58L18 10l-6 6-6-6 1.41-1.41Z"/></svg></button>`;
}
export function platformsSectionHtml():string {
  const cfg=platformSettings.bind(PLATFORM_ID);
  return `<div class="dion-plugin-details"><div class="dion-details-head"><div><span class="dion-eyebrow">${i18nHtml("ui.platform_indicators")}</span><h4>${i18nHtml("ui.where_to_show_platform_icons")}</h4></div></div>${platformSettings.keys.map(key=>{
    const def=platformSettings.schema[key];
    return `<label class="dion-setting-row"><span class="dion-setting-copy"><span class="dion-setting-title">${productHtml(def.title)}</span><span class="dion-setting-desc">${productHtml(def.description)}</span></span><span class="dion-switch"><input type="checkbox" role="switch" data-dion-platform-option="${key}" ${productAttribute("aria-label",def.title)} ${cfg.get(key)===true?'checked':''}><span class="dion-track" aria-hidden="true"></span></span></label>`;
  }).join('')}<p class="dion-note">${i18nHtml("ui.uses_discord_s_reported_presence_offline_invisible_users_and_unavailab")}</p></div>`;
}
export function bindPlatformsPanel(root:HTMLElement):()=>void {
  const click=(event:Event):void=>{
    const button=(event.target as Element|null)?.closest('[data-dion-platforms-expand]');if(!(button instanceof HTMLButtonElement))return;
    event.preventDefault();event.stopPropagation();hideTooltip();expanded=!expanded;
    button.closest('.dion-plugin')?.classList.toggle('is-open',expanded);button.setAttribute('aria-expanded',String(expanded));
  };
  const change=(event:Event):void=>{
    const input=event.target;if(!(input instanceof HTMLInputElement))return;
    const key=input.dataset.dionPlatformOption;if(!platformSettings.keys.some(k=>k===key))return;
    platformSettings.bind(PLATFORM_ID).set(key as typeof platformSettings.keys[number],input.checked);
    window.dispatchEvent(new Event(PLATFORM_SETTINGS_EVENT));
  };
  root.addEventListener('click',click);root.addEventListener('change',change);
  return ()=>{root.removeEventListener('click',click);root.removeEventListener('change',change);};
}
