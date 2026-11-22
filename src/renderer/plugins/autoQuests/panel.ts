import { canonicalMessage, localizeError, localizeMessage, h, messageHtml as i18nHtml, t as i18nText } from "../../i18n";
/**
 * The auto-claim part of the Auto Quests settings row.
 *
 * Lives beside the plugin rather than inside `settingsPanel.ts` for one
 * concrete reason: this is the only place in Syncord where a paid third-party
 * credential is typed into the client, and it needs to be readable — and
 * testable — on its own.
 *
 * ## What the markup deliberately does not do
 *
 * It never renders the stored key. `masked` is what the main process is willing
 * to say, and that is what appears: an input pre-filled with the key would put
 * a live credential back into the page, where the plugin that just asked for a
 * solve could read it out of the DOM.
 */
import { autoQuestSettings } from "./settings";

/** Read the switch without the caller having to know the plugin id. */
export function autoClaimEnabled(): boolean {
  return autoQuestSettings.bind("auto-quests").get("autoClaim") === true;
}

/** Write the switch. Used by the settings panel's change handler. */
export function setAutoClaimEnabled(enabled: boolean): void {
  autoQuestSettings.bind("auto-quests").set("autoClaim", enabled === true);
}

export type AutoClaimView = {
  /**
   * Whether the switch is on, as the caller knows it.
   *
   * Passed in rather than read from the settings store inside the renderer:
   * this markup is produced right after a toggle, and a store read here can
   * disagree with the control the user just used.
   */
  enabled: boolean;
  configured: boolean;
  masked: string | null;
  encryptionAvailable: boolean;
  lockedDown: boolean;
  status: string;
  claimed: number;
  skipped: number;
  solves: number;
  /**
   * Why the last attempt failed, or null.
   *
   * Shown because the alternative was a counter going up with no explanation:
   * "1 skipped" tells the user nothing about whether the feature is working,
   * and a silent skip is indistinguishable from a broken one.
   */
  lastError?: string | null;
  /**
   * Whether Discord's own hCaptcha widget has been found and patched.
   *
   * Shown because "nothing happened" is ambiguous: either every captcha is
   * being solved without a click, or we never found the surface Discord uses.
   * Those look identical from the outside unless one of them is written down.
   */
  widgetPatched?: boolean;
};

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Why automatic claiming is or is not able to run, in the user's language. */
function readiness(view: AutoClaimView): string {
  if (view.lockedDown) {
    return i18nText("ui.captcha_solving_is_disabled_during_lockdown");
  }
  if (!view.encryptionAvailable) {
    return i18nText("ui.encrypted_key_storage_is_unavailable_on_this_system_so_the_api_key_can");
  }
  if (!view.configured) {
    return i18nText("ui.no_api_key_is_saved_automatic_claiming_is_disabled_until_a_key_is_adde");
  }
  return view.configured && view.masked !== null ? i18nText("ui.stored_key_value", {v0: view.masked}) : "";
}

/**
 * Whether Discord's own captcha flow is covered.
 *
 * A separate line from the key status: the key can be perfectly configured
 * while the bridge has not found the surface Discord uses, and then Discord's
 * captcha still needs a click. Saying which half is missing is the difference
 * between a user who waits and a user who reports a bug.
 */
export function widgetLine(view: AutoClaimView): string {
  if (!view.enabled || !view.configured) return "";
  return view.widgetPatched === true
    ? i18nText("ui.discord_s_captcha_dialog_is_also_solved_automatically")
    : i18nText("ui.discord_s_captcha_dialog_has_not_been_found_yet_you_may_need_to_comple");
}

/** What was in the key field before the block was replaced. */
export type AutoClaimDraft = { value: string; focused: boolean };

/**
 * Read the key field before replacing it.
 *
 * The block is re-rendered on every watcher state change, and a claim can land
 * while someone is halfway through pasting a key. Without this the field would
 * silently empty itself and the user would paste it again.
 */
export function captureAutoClaimDraft(field: { value?: string; focused?: boolean } | null | undefined): AutoClaimDraft {
  if (!field || typeof field.value !== "string") return { value: "", focused: false };
  return { value: field.value, focused: field.focused === true };
}

/**
 * Put a captured draft back into a freshly rendered field.
 *
 * A draft is only ever taken from the field the user typed into, so there is no
 * path by which a *stored* key is written back into the page.
 */
export function restoreAutoClaimDraft(field: HTMLInputElement | null | undefined, draft: AutoClaimDraft): void {
  if (!field) return;
  field.value = draft.value;
  if (draft.focused) field.focus();
}

export function autoClaimSectionHtml(view: AutoClaimView): string {
  // The switch follows `view.enabled`, not the settings store. The caller
  // re-renders this section right after a toggle, and reading the store again
  // here would let a stale render disagree with the control the user just used.
  const checked = view.enabled ? "checked" : "";
  const counts = i18nText("ui.claimed_value_skipped_value_captchas_solved_value", {v0: view.claimed, v1: view.skipped, v2: view.solves});
  const widget = widgetLine(view);

  return `
    <div class="dion-settings-group dion-autoclaim">
      <label class="dion-setting-row">
        <span class="dion-setting-copy">
          <span class="dion-setting-title">${i18nHtml("ui.automatically_claim_rewards")}</span>
          <span class="dion-setting-desc">
            ${i18nHtml("ui.claim_rewards_for_completed_quests_in_the_background_using_your_accoun_72b4182")}
          </span>
          <span class="dion-setting-status" data-dion-quest-autoclaim-status>${escapeHtml(readiness(view))}</span>
        </span>

        <span class="dion-switch">
          <input
            type="checkbox"
            role="switch"
            data-dion-quest-autoclaim
            aria-label="${h("ui.automatically_claim_rewards")}"
            ${checked}
            ${view.lockedDown ? "disabled" : ""} data-si18n-aria-label="ui.automatically_claim_rewards"
          />
          <span class="dion-track" aria-hidden="true"></span>
        </span>
      </label>

      <div class="dion-quest-key-block">
        <span class="dion-field-copy">
          <span class="dion-setting-title">${i18nHtml("ui.nonecap_api_key")}</span>
          <span class="dion-setting-desc">
            ${i18nHtml("ui.stored_in_the_system_keychain_and_never_returned_to_this_page_automati")}
          </span>
        </span>

        <div class="dion-quest-key-controls">
          <input
            id="dion-quest-key"
            type="password"
            data-dion-quest-key
            placeholder="${escapeHtml(view.configured && view.masked ? view.masked : "nc_live_…")}"
            spellcheck="false"
            autocomplete="off"
            aria-describedby="dion-quest-key-note"
          />
          <button type="button" class="dion-quest-key-btn" data-dion-quest-key-save>${i18nHtml("ui.save")}</button>
          <button type="button" class="dion-quest-key-btn" data-dion-quest-key-clear>${i18nHtml("ui.clear")}</button>
        </div>
      </div>

      <span class="dion-eyebrow" id="dion-quest-key-note" data-dion-quest-autoclaim-counts>${escapeHtml(counts)}</span>
      <span class="dion-setting-status" data-dion-quest-autoclaim-live>${escapeHtml(view.lastError&&view.status===canonicalMessage("ui.error_value",{v0:view.lastError})?i18nText("ui.error_value",{v0:localizeError(view.lastError)}):localizeMessage(view.status))}</span>
      ${widget === "" ? "" : `<span class="dion-setting-status" data-dion-quest-autoclaim-widget">${escapeHtml(widget)}</span>`}
      ${view.lastError
          ? `<span class="dion-setting-status is-error" data-dion-quest-autoclaim-error>${i18nHtml("ui.last_error")}: ${escapeHtml(localizeError(view.lastError))}</span>`
          : ""}
    </div>`;
}