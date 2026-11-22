import { h, messageHtml as i18nHtml } from "../../i18n";
import {showBadgesSettings,SHOW_BADGES_SETTINGS_EVENT} from "./settings";
import {hideTooltip} from "../../ui/tooltip";
let expanded=false;
export function isBadgesExpanded():boolean {return expanded;}
export function badgesExpandButtonHtml():string {
  return `<button type="button" class="dion-icon-btn dion-expand-btn" data-dion-badges-expand aria-expanded="${expanded}" aria-label="${h("ui.show_badges_options")}" data-si18n-aria-label="ui.show_badges_options">
    <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m7.41 8.59 4.59 4.58 4.59-4.58L18 10l-6 6-6-6 1.41-1.41Z"/></svg></button>`;
}
export function badgesSectionHtml():string {
  const enabled=showBadgesSettings.bind('show-badges').get('memberList')===true;
  return `<div class="dion-plugin-details"><div class="dion-details-head"><div><span class="dion-eyebrow">${i18nHtml("ui.show_badges")}</span><h4>${i18nHtml("ui.badge_display")}</h4></div></div>
    <label class="dion-setting-row"><span class="dion-setting-copy"><span class="dion-setting-title">${i18nHtml("ui.show_badges_in_member_list")}</span>
      <span class="dion-setting-desc">${i18nHtml("ui.show_badges_beside_names_in_the_right_hand_member_list_shares_profile_")}</span></span>
      <span class="dion-switch"><input type="checkbox" role="switch" data-dion-badges-members aria-label="${h("ui.show_badges_in_member_list")}" ${enabled?'checked':''} data-si18n-aria-label="ui.show_badges_in_member_list">
      <span class="dion-track" aria-hidden="true"></span></span></label></div>`;
}
export function bindBadgesPanel(root:HTMLElement):()=>void {
  const click=(event:Event):void=>{
    const button=(event.target as Element|null)?.closest('[data-dion-badges-expand]');if(!(button instanceof HTMLButtonElement))return;
    event.preventDefault();event.stopPropagation();hideTooltip();expanded=!expanded;
    button.closest('.dion-plugin')?.classList.toggle('is-open',expanded);button.setAttribute('aria-expanded',String(expanded));
  };
  const change=(event:Event):void=>{
    const input=event.target;if(!(input instanceof HTMLInputElement)||!input.matches('[data-dion-badges-members]'))return;
    showBadgesSettings.bind('show-badges').set('memberList',input.checked);
    window.dispatchEvent(new Event(SHOW_BADGES_SETTINGS_EVENT));
  };
  root.addEventListener('click',click);root.addEventListener('change',change);
  return ()=>{root.removeEventListener('click',click);root.removeEventListener('change',change);};
}
