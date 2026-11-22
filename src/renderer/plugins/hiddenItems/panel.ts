import { h, messageHtml as i18nHtml } from "../../i18n";
import {hideTooltip} from '../../ui/tooltip';
import {CSS,mountManager} from './ui';
import {hideItem} from './actions';
import {quickAccessEnabled,setQuickAccessEnabled,HIDDEN_EVENT} from './settings';
let expanded=false;
export function isHiddenItemsExpanded():boolean{return expanded;}
export function hiddenItemsExpandButtonHtml():string{return `<button type="button" class="dion-icon-btn dion-expand" data-dion-hidden-expand aria-expanded="${expanded}" aria-label="${h("ui.hidden_items_options")}" data-si18n-aria-label="ui.hidden_items_options"><svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m7.41 8.59 4.59 4.58 4.59-4.58L18 10l-6 6-6-6 1.41-1.41Z"/></svg></button>`;}
export function hiddenItemsSectionHtml():string{return `<div class="dion-plugin-details"><div class="dion-details-head"><div><span class="dion-eyebrow">${i18nHtml("ui.hidden_items")}</span><h4>${i18nHtml("ui.manage_hidden_servers_dms_and_groups")}</h4></div></div><label class="dion-setting-row"><span class="dion-setting-copy"><span class="dion-setting-title">${i18nHtml("ui.quick_access")}</span><span class="dion-setting-desc">${i18nHtml("ui.show_the_eye_shortcut_when_hovering_over_the_direct_messages_heading_o")}</span></span><span class="dion-switch"><input type="checkbox" role="switch" data-dion-hidden-quick-access aria-label="${h("ui.quick_access")}" ${quickAccessEnabled()?'checked':''} data-si18n-aria-label="ui.quick_access"><span class="dion-track" aria-hidden="true"></span></span></label><div data-syncord-hidden-manager></div></div>`;}
export function bindHiddenItemsPanel(root:HTMLElement):()=>void {
  const host=root.querySelector<HTMLElement>('[data-syncord-hidden-manager]');if(!host)return()=>{};
  const style=document.createElement('style');style.textContent=CSS;host.parentElement?.append(style);
  const dispose=mountManager(host,hideItem);
  const click=(event:Event):void=>{const button=(event.target as Element|null)?.closest('[data-dion-hidden-expand]');if(!(button instanceof HTMLButtonElement))return;event.preventDefault();event.stopPropagation();hideTooltip();expanded=!expanded;button.closest('.dion-plugin')?.classList.toggle('is-open',expanded);button.setAttribute('aria-expanded',String(expanded));};
  const sync=():void=>{const input=root.querySelector<HTMLInputElement>('[data-dion-hidden-quick-access]');if(input)input.checked=quickAccessEnabled();};
  const change=(event:Event):void=>{const input=event.target;if(input instanceof HTMLInputElement&&input.matches('[data-dion-hidden-quick-access]'))setQuickAccessEnabled(input.checked);};
  root.addEventListener('click',click);root.addEventListener('change',change);window.addEventListener(HIDDEN_EVENT,sync);
  return()=>{root.removeEventListener('click',click);root.removeEventListener('change',change);window.removeEventListener(HIDDEN_EVENT,sync);dispose();style.remove();};
}
