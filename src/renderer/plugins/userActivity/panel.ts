import { type Params, productHtml, productAttribute, h, messageHtml as i18nHtml, setLocalizedHtml, setLocalizedText, t as i18nText } from "../../i18n";
import { settings } from "../../api/settings";
import { choice, searchUsers, type UserChoice } from "./discord";
import {openActivityLog} from "./logView";
import { activityStatus, activityStatusMessage } from "./runtime";
import { ACTIVITY_PLUGIN_ID, ACTIVITY_SETTINGS_EVENT, ACTIVITY_STATUS_EVENT, EVENT_KINDS, MAX_ACTIVITY_USERS, readConfig, userId } from "./types";

let expanded = false;
export function isActivityExpanded(): boolean { return expanded; }
const key = (name:string):string => `plugins.${ACTIVITY_PLUGIN_ID}.data.${name}`;
function config() { return readConfig((name,fallback)=>settings.get(key(name),fallback)); }
function escape(value:string):string {
  return value.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
const labels:Record<string,string> = {get presence(){return i18nText("ui.presence_changes");},get messages(){return i18nText("ui.new_messages");},get typing(){return i18nText("ui.typing");},get avatar(){return i18nText("ui.profile_photos");},
  get profile(){return i18nText("ui.username_display_name");},get activities(){return i18nText("ui.activity_custom_status");},get voice(){return i18nText("ui.voice_camera_stream");},get paused(){return i18nText("ui.pause_notifications");}};
function avatar(user:UserChoice|undefined):string {
  return user?.avatar ? `<img class="dion-ua-avatar" src="${escape(user.avatar)}" alt="" width="32" height="32" loading="lazy" decoding="async" data-dion-ua-avatar-fallback="${escape(user.name.slice(0,1) || "?")}">`
    : `<span class="dion-ua-avatar dion-ua-initial" aria-hidden="true">${escape(user?.name.slice(0,1) || "?")}</span>`;
}
function selected():string {
  const ids = config().userIds;
  if (!ids.length) return `<p class="dion-setting-desc">${i18nHtml("ui.no_users_selected_search_a_user_or_add_their_discord_user_id")}</p>`;
  return ids.map(id=>{
    const user = choice(id), name = user?.name || id;
    return `<div class="dion-ua-selected" role="listitem" data-dion-ua-tracked="${escape(id)}">
      ${avatar(user)}<span class="dion-ua-user-copy"><strong>${escape(name)}</strong>
      <small>${escape(user ? `${user.username} · ${id}` : i18nText("ui.waiting_for_discord_to_receive_this_user"))}</small></span>
      <button type="button" class="dion-icon-btn" data-dion-ua-log="${escape(id)}" aria-label="${escape(i18nText("ui.open_log_for_value", {v0: name}))}" title="${h("ui.activity_log")}" data-si18n-title="ui.activity_log">
        <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm8 2v4h4l-4-4ZM8 12h8v2H8v-2Zm0 4h8v2H8v-2Z"/></svg>
      </button>
      <button type="button" class="dion-icon-btn" data-dion-ua-remove="${escape(id)}" aria-label="${escape(i18nText("ui.remove_value", {v0: name}))}" title="${h("ui.remove_user")}" data-si18n-title="ui.remove_user">×</button>
    </div>`;
  }).join("");
}
export function activityExpandButtonHtml():string {
  return `<button type="button" class="dion-icon-btn dion-expand" data-dion-ua-expand aria-expanded="${expanded}" aria-label="${h("ui.user_activity_options")}" data-si18n-aria-label="ui.user_activity_options">
    <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m7.41 8.59 4.59 4.58 4.59-4.58L18 10l-6 6-6-6 1.41-1.41Z"/></svg></button>`;
}
export function activitySectionHtml():string {
  const cfg = config();
  const toggles = [...EVENT_KINDS,"paused"].map(name=>`<label class="dion-setting-row">
    <span class="dion-setting-copy"><span class="dion-setting-title">${productHtml(labels[name])}</span></span>
    <span class="dion-switch"><input type="checkbox" role="switch" data-dion-ua-flag="${name}" ${productAttribute("aria-label",labels[name])}
      ${cfg[name as keyof typeof cfg] === true ? "checked" : ""}><span class="dion-track" aria-hidden="true"></span></span></label>`).join("");
  return `<div class="dion-plugin-details dion-ua-options">
    <div class="dion-details-head"><div><span class="dion-eyebrow">${i18nHtml("ui.user_activity")}</span><h4>${i18nHtml("ui.activity_notifications")}</h4></div></div>
    <p class="dion-setting-desc">${i18nHtml("ui.only_events_discord_sends_to_this_client_are_available_private_chats_y")}</p>
    <div class="dion-ua-list-head"><span class="dion-setting-title" data-dion-ua-count>${i18nHtml("ui.tracking_value_value_users",{v0:cfg.userIds.length,v1:MAX_ACTIVITY_USERS})}</span>
      <button type="button" class="dion-icon-btn" data-dion-ua-clear aria-label="${h("ui.clear_all_selected_users")}" ${cfg.userIds.length ? "" : "hidden"} data-si18n-aria-label="ui.clear_all_selected_users">${i18nHtml("ui.clear_all")}</button></div>
    <div class="dion-ua-selected-list" data-dion-ua-selected role="list" aria-label="${h("ui.tracked_users")}" data-si18n-aria-label="ui.tracked_users">${selected()}</div>
    <div class="dion-ua-picker"><label for="dion-ua-search" class="dion-setting-title">${i18nHtml("ui.add_users")}</label>
      <div class="dion-ua-search-row"><input id="dion-ua-search" type="text" data-dion-ua-search maxlength="100" autocomplete="off"
        placeholder="${h("ui.username_or_user_id")}" aria-label="${h("ui.search_users")}" aria-controls="dion-ua-results" aria-expanded="false" data-si18n-placeholder="ui.username_or_user_id" data-si18n-aria-label="ui.search_users">
        <button type="button" class="dion-primary-btn" data-dion-ua-use-id>${i18nHtml("ui.add_id")}</button></div>
      <div id="dion-ua-results" class="dion-ua-results" data-dion-ua-results hidden></div>
      <p class="dion-setting-desc" data-dion-ua-error role="status" aria-live="polite"></p>
    </div>
    <p class="dion-setting-desc" data-dion-ua-status role="status">${escape(activityStatus())}</p>
    <div class="dion-settings-group">${toggles}</div>
    <div class="dion-field-row"><label for="dion-ua-typing">${i18nHtml("ui.typing_cooldown_seconds")}</label>
      <input id="dion-ua-typing" type="number" min="5" max="300" value="${cfg.typingCooldown}" data-dion-ua-number="typingCooldown"></div>
    <div class="dion-field-row"><label for="dion-ua-interval">${i18nHtml("ui.notification_interval_seconds")}</label>
      <input id="dion-ua-interval" type="number" min="5" max="60" value="${cfg.notificationInterval}" data-dion-ua-number="notificationInterval"></div>
    <p class="dion-setting-desc">${i18nHtml("ui.repeated_events_are_grouped_typing_repeats_are_limited_per_user_and_ch")}</p>
  </div>`;
}

/** Delegation survives settings list redraws; nothing is attached per user row. */
export function bindActivityPanel(root:HTMLElement):()=>void {
  let searchTimer:ReturnType<typeof setTimeout>|undefined;
  const input = ():HTMLInputElement|null => root.querySelector("[data-dion-ua-search]");
  const results = ():HTMLElement|null => root.querySelector("[data-dion-ua-results]");
  const closeResults = ():void => { if (searchTimer !== undefined) clearTimeout(searchTimer);searchTimer = undefined;
    const list = results(); if (list) {list.hidden = true;list.replaceChildren();} input()?.setAttribute("aria-expanded","false"); };
  const error = (key:string,params:Params={}):void => {const el=root.querySelector("[data-dion-ua-error]");if(el){if(key)setLocalizedText(el,key,params);else el.textContent="";}};
  const paint = ():void => { const el=root.querySelector("[data-dion-ua-status]");if(el){const message=activityStatusMessage();setLocalizedText(el,message.key,message.params);} };
  const changed = ():void => {window.dispatchEvent(new Event(ACTIVITY_SETTINGS_EVENT));paint();};
  const paintUsers = ():void => {
    const cfg=config(), el=root.querySelector("[data-dion-ua-selected]");if(el) setLocalizedHtml(el, selected());
    const count=root.querySelector("[data-dion-ua-count]");if(count) setLocalizedText(count, "ui.tracking_value_value_users", {v0: cfg.userIds.length, v1: MAX_ACTIVITY_USERS});
    const clear=root.querySelector<HTMLButtonElement>("[data-dion-ua-clear]");if(clear) clear.hidden=!cfg.userIds.length;
  };
  const saveUsers = (ids:string[]):void => {
    settings.set(key("userIds"),ids);
    settings.set(key("userId"),ids[0] ?? "");
    changed();closeResults();error("");paintUsers();
  };
  const pick = (id:string):void => {
    const validated = userId(id);if (!validated) {error("ui.enter_valid_discord_user_id");return;}
    const ids=config().userIds;
    if(ids.includes(validated)) {error("ui.already_tracking_this_user");return;}
    if(ids.length>=MAX_ACTIVITY_USERS) {error("ui.tracking_limit_remove_user",{max:MAX_ACTIVITY_USERS});return;}
    saveUsers([...ids,validated]);
    const search=input();if(search) {search.value="";search.focus();closeResults();}
  };
  const search = ():void => {
    const field=input(), list=results(); if(!field || !list || !field.isConnected) return;
    const ids=new Set(config().userIds), users=searchUsers(field.value,ids);
    setLocalizedHtml(list, users.length ? users.map(user=>`<button type="button" class="dion-ua-choice" data-dion-ua-user="${escape(user.id)}">
      ${avatar(user)}<span class="dion-ua-user-copy"><strong>${escape(user.name)}</strong><small>${escape(user.username)} · ${escape(user.id)}</small></span></button>`).join("")
      : `<p class="dion-setting-desc">${i18nHtml("ui.no_new_cached_user_found_add_a_valid_user_id_with_add_id")}</p>`);
    list.hidden=false;field.setAttribute("aria-expanded","true");
  };
  const click=(event:Event):void => {
    const target=event.target instanceof Element ? event.target : null;if(!target) return;
    const expand=target.closest("[data-dion-ua-expand]");
    if(expand) {expanded=!expanded;expand.setAttribute("aria-expanded",String(expanded));expand.closest(".dion-plugin")?.classList.toggle("is-open",expanded);
      if(!expanded) closeResults();return;}
    if(target.closest("[data-dion-ua-search]")) {search();return;}
    const row=target.closest("[data-dion-ua-user]");if(row) {pick(row.getAttribute("data-dion-ua-user") ?? "");return;}
    if(target.closest("[data-dion-ua-use-id]")) {pick(input()?.value ?? "");return;}
    const log=target.closest("[data-dion-ua-log]");
    if(log) {closeResults();openActivityLog(log.getAttribute("data-dion-ua-log") ?? "");return;}
    const remove=target.closest("[data-dion-ua-remove]");
    if(remove) {saveUsers(config().userIds.filter(id=>id!==remove.getAttribute("data-dion-ua-remove")));input()?.focus();closeResults();return;}
    if(target.closest("[data-dion-ua-clear]")) {saveUsers([]);input()?.focus();closeResults();return;}
    if(!target.closest(".dion-ua-picker")) closeResults();
  };
  const onInput=(event:Event):void => {
    if(!(event.target instanceof HTMLInputElement) || !event.target.hasAttribute("data-dion-ua-search")) return;
    if(searchTimer !== undefined) clearTimeout(searchTimer);
    searchTimer=setTimeout(()=>{searchTimer=undefined;search();},120);
  };
  const focus=(event:Event):void => {if(event.target instanceof HTMLInputElement && event.target.hasAttribute("data-dion-ua-search")) search();};
  const onChange=(event:Event):void => {
    const field=event.target;if(!(field instanceof HTMLInputElement)) return;
    const flag=field.getAttribute("data-dion-ua-flag");
    if(flag && ([...EVENT_KINDS,"paused"] as readonly string[]).includes(flag)) {settings.set(key(flag),field.checked);changed();return;}
    const name=field.getAttribute("data-dion-ua-number");if(name !== "typingCooldown" && name !== "notificationInterval") return;
    const value=Number(field.value), max=name === "typingCooldown" ? 300 : 60;
    if(field.value.trim()==="" || !Number.isInteger(value) || value<5 || value>max) {field.value=String(config()[name]);error("ui.choose_value_from_five",{max});return;}
    error("");settings.set(key(name),value);changed();
  };
  const onKey=(event:KeyboardEvent):void => {
    if(!(event.target instanceof HTMLElement) || !event.target.closest(".dion-ua-picker")) return;
    if(event.key==="Escape" && results()?.hidden === false) {event.preventDefault();event.stopPropagation();closeResults();input()?.focus();closeResults();}
    else if(event.key==="Enter" && event.target===input()) {event.preventDefault();
      if(userId(input()?.value)) pick(input()?.value ?? "");else results()?.querySelector<HTMLButtonElement>("[data-dion-ua-user]")?.click();}
    else if(event.key==="ArrowDown" || event.key==="ArrowUp") {
      const rows=[...root.querySelectorAll<HTMLButtonElement>("[data-dion-ua-user]")];if(!rows.length) return;
      event.preventDefault();const index=rows.indexOf(event.target as HTMLButtonElement), step=event.key==="ArrowDown" ? 1 : -1;
      const next=index<0 ? (step>0 ? 0 : rows.length-1) : (index+step+rows.length)%rows.length;
      rows[next]?.focus();
    }
  };
  const imageError=(event:Event):void => {
    const image=event.target;if(!(image instanceof HTMLImageElement) || !image.hasAttribute("data-dion-ua-avatar-fallback")) return;
    const fallback=document.createElement("span");fallback.className="dion-ua-avatar dion-ua-initial";
    fallback.setAttribute("aria-hidden","true");fallback.textContent=image.getAttribute("data-dion-ua-avatar-fallback") || "?";
    image.replaceWith(fallback);
  };
  root.addEventListener("click",click);root.addEventListener("input",onInput);root.addEventListener("change",onChange);
  root.addEventListener("focusin",focus);root.addEventListener("keydown",onKey,true);
  root.addEventListener("error",imageError,true);
  window.addEventListener(ACTIVITY_STATUS_EVENT,paint);paint();
  return ()=>{closeResults();root.removeEventListener("click",click);root.removeEventListener("input",onInput);
    root.removeEventListener("change",onChange);root.removeEventListener("focusin",focus);root.removeEventListener("keydown",onKey,true);
    root.removeEventListener("error",imageError,true);
    window.removeEventListener(ACTIVITY_STATUS_EVENT,paint);};
}
