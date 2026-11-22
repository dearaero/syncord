import {mountPerformancePanel} from './performancePanel';
import {spooferExpandHtml,spooferSectionHtml,bindSpooferPanel,isSpooferExpanded,revealSpooferPanel,SPOOFER_CSS} from '../plugins/platformSpoofer/panel';
import {virtualExpandHtml,virtualSectionHtml,bindVirtualPanel,isVirtualExpanded,VIRTUAL_PANEL_CSS} from '../plugins/virtualServers/panel';
import {longExpandHtml,longSectionHtml,bindLongPanel,isLongExpanded} from '../plugins/longMessages/panel';
import {gameExpandHtml,gameSectionHtml,bindGamePanel,isGameExpanded,GAME_CSS} from '../plugins/customGamePresence/panel';
import {isDropExpanded,dropExpandHtml,dropSectionHtml,bindDropPanel} from '../plugins/syncordDrop/panel';
import {bindSettingsControls,SETTINGS_CONTROLS_CSS,type SettingsControls} from './settingsControls';
import {experimentsExpandHtml,experimentsSectionHtml,bindExperimentsPanel,isExperimentsExpanded} from '../plugins/experiments/panel';
import {spotifyExpandHtml,spotifySectionHtml,bindSpotifyPanel,isSpotifyExpanded} from "../plugins/spotifyControls/panel";
import {SPOTIFY_ID} from "../plugins/spotifyControls/settings";
import { canonicalMessage, getLocale, messageKeyForLabel, h, localizeError, messageHtml as i18nHtml, onLocaleChange, preserveInputs, productAttribute, productHtml, setLocalizedHtml, setLocalizedText, t as i18nText } from "../i18n";
import {mountEcosystem,unmountEcosystem} from "./ecosystem";
import {mountStatistics,unmountStatistics} from "./statistics";
import {relationshipExpandButtonHtml,relationshipSectionHtml,bindRelationshipPanel,isRelationshipExpanded} from "../plugins/relationshipNotifier/panel";
import {RN_ID} from "../plugins/relationshipNotifier/types";
import {imageZoomExpandButtonHtml,imageZoomSectionHtml,bindImageZoomPanel,isImageZoomExpanded} from "../plugins/imageZoom/panel";
import {IMAGE_ZOOM_ID} from "../plugins/imageZoom/settings";
import {smartUploadExpandButtonHtml,smartUploadSectionHtml,bindSmartUploadPanel,isSmartUploadExpanded} from "../plugins/smartUpload/panel";
import {SMART_ID} from "../plugins/smartUpload/settings";
import {hiddenItemsExpandButtonHtml,hiddenItemsSectionHtml,bindHiddenItemsPanel,isHiddenItemsExpanded} from "../plugins/hiddenItems/panel";
import {HIDDEN_ID} from "../plugins/hiddenItems/settings";
import {platformsExpandButtonHtml,platformsSectionHtml,bindPlatformsPanel,isPlatformsExpanded} from "../plugins/platformIndicators/panel";
import {PLATFORM_ID} from "../plugins/platformIndicators/settings";
import logoUrl from "../../../public/assets/syncord.png";
import { VERSION } from "../../shared/constants";
import { createLogger } from "../api/logger";
import { list } from "../api/plugin/manager";
import {pluginOperationBusy,setPluginEnabled} from '../api/plugin/bulk';
import {mountPluginBulkActions} from './pluginBulkActions';
import type { PluginPublicInfo } from "../api/plugin/types";
import { settings } from "../api/settings";
import { bindRecorderPanel, isRecorderExpanded, recorderExpandButtonHtml, recorderSectionHtml } from "../plugins/screenRecorder/panel";
import { RECORDER_ID, RECORDER_EVENT } from "../plugins/screenRecorder/settings";
import {badgesExpandButtonHtml,badgesSectionHtml,bindBadgesPanel,isBadgesExpanded} from "../plugins/showBadges/panel";
import { hideTypingChangeEvent } from "../plugins/hideTyping";
import {
  SCHEDULED_PLUGIN_ID,
  isEditing as isScheduledEditing,
  isScheduledExpanded,
  scheduledActionHandler,
  scheduledExpandButtonHtml,
  scheduledSectionHtml,
  setScheduledExpanded,
} from "../plugins/scheduledMessages/panel";
import {
  activeStore as activeScheduledStore,
  scheduledChangeEvent,
} from "../plugins/scheduledMessages/store";
import { activityExpandButtonHtml, activitySectionHtml, bindActivityPanel, isActivityExpanded } from "../plugins/userActivity/panel";
import { ACTIVITY_PLUGIN_ID } from "../plugins/userActivity/types";
import { openMessageLog } from "../plugins/messageLogger/logModal";
import { clearLog, logCount, setLogLimit } from "../plugins/messageLogger/log";
import { questRunnerChangeEvent, questRunnerState, toggleQuestRunner } from "../plugins/autoQuests";
import {
  claimChangeEvent,
  claimState,
  requestClaimRefresh,
} from "../plugins/autoQuests/claim";
import {
  autoClaimEnabled,
  autoClaimSectionHtml,
  captureAutoClaimDraft,
  restoreAutoClaimDraft,
  setAutoClaimEnabled,
} from "../plugins/autoQuests/panel";
import { hcaptchaBridgePatched } from "../plugins/autoQuests/hcaptcha";
import { bindTooltip, hideTooltip } from "./tooltip";
import { showToast, ToastType } from "./toast";
import { mountSecurityCenter, unmountSecurityCenter } from "./securityCenter";
import { bindUpdateUi, disposeUpdateUi, updateButtonHtml, updateSettingsRowHtml } from "./updatePrompt";

const log = createLogger("settings-ui");

const ROOT_ID = "Syncord-settings-root";
const STYLE_ID = "Syncord-settings-css";

let open = false;
let disposeLocale: (()=>void) | undefined;
let root: HTMLDivElement | undefined;
let bulkActions:ReturnType<typeof mountPluginBulkActions>|undefined;
let disposeQuestUi:(()=>void)|undefined;
let query = "";
let loggerOpen = false;
let sessionRestoreOpen = false;
let hideTypingOpen = false;
let autoQuestsOpen = false;
let disposeRecorderPanel: (() => void) | undefined;
let disposeRelationshipPanel:(()=>void)|undefined;
let disposeImageZoomPanel:(()=>void)|undefined;
let disposeSmartUploadPanel:(()=>void)|undefined;
let settingsControls:SettingsControls|undefined;
let disposeSpooferPanel:(()=>void)|undefined;
let disposeVirtualPanel:(()=>void)|undefined;
let disposeLongPanel:(()=>void)|undefined;
let disposeGamePanel:(()=>void)|undefined;
let disposeDropPanel:(()=>void)|undefined;
let disposeScheduledPanelChange:(()=>void)|undefined;
let disposeExperimentsPanel:(()=>void)|undefined;
let disposeSpotifyPanel:(()=>void)|undefined;
let disposeHiddenItemsPanel:(()=>void)|undefined;
let disposePlatformsPanel:(()=>void)|undefined;
let disposeBadgesPanel:(()=>void)|undefined;
let disposeActivityPanel: (() => void) | undefined;

const LOG_LIMIT_KEY = "plugins.message-logger.data.limit";
const OPENED_KEY = "plugins.message-logger.data.onlyOpened";
const ULTIMATE_KEY = "plugins.message-logger.data.ultimate";
const BOTS_KEY = "plugins.message-logger.data.ignoreBots";
const SELF_KEY = "plugins.message-logger.data.ignoreSelf";
const USERS_KEY = "plugins.message-logger.data.ignoreUsers";
const CHANNELS_KEY = "plugins.message-logger.data.ignoreChannels";
const GUILDS_KEY = "plugins.message-logger.data.ignoreGuilds";
const SESSION_DONT_ASK_KEY = "plugins.session-restore.data.dontAsk";
const HIDE_TYPING_EASY_KEY = "plugins.hide-typing.data.easyChange";
const HIDE_TYPING_MODE_KEY = "plugins.hide-typing.data.typingMode";
const HIDE_TYPING_MODES = ["hide", "always", "default"] as const;

const FLAG_KEYS: Record<string, string> = {
  bots: BOTS_KEY,
  self: SELF_KEY,
};

const ID_KEYS: Record<string, string> = {
  users: USERS_KEY,
  channels: CHANNELS_KEY,
  guilds: GUILDS_KEY,
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function matches(plugin: PluginPublicInfo, q: string): boolean {
  if (!q) return true;

  const values=[plugin.name,plugin.description,plugin.id,plugin.author].filter((part):part is string=>Boolean(part));
  const canonical=values.map(value=>{const key=messageKeyForLabel(value);return key?canonicalMessage(key):value;}).join('\n');
  return values.join('\n').toLocaleLowerCase(getLocale()).includes(q.toLocaleLowerCase(getLocale())) || canonical.toLowerCase().includes(q.toLowerCase());
}

function statusOf(plugin: PluginPublicInfo): { kind: string; label: string } {
  if (plugin.started) return { kind: "on", get label() { return i18nText("ui.running"); } };
  if (plugin.enabled) return { kind: "idle", get label() { return i18nText("ui.enabled"); } };
  return { kind: "off", get label() { return i18nText("ui.disabled"); } };
}

function savedLimit(): number {
  const raw = settings.get<number>(LOG_LIMIT_KEY, 800);
  return typeof raw === "number" && Number.isFinite(raw)
    ? Math.max(0, Math.floor(raw))
    : 800;
}

function savedUltimate(): boolean {
  return settings.get<boolean>(ULTIMATE_KEY, true) === true;
}

function savedFlag(key: string): boolean {
  return settings.get<boolean>(key, false) === true;
}

function savedText(key: string): string {
  const raw = settings.get<string>(key, "");
  return typeof raw === "string" ? raw : "";
}

function shortcutMod(): string {
  return /Mac|iPhone|iPad/i.test(navigator.platform) ? "⌘" : i18nText("ui.ctrl");
}

function pluginGlyph(): string {
  return `
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M8.5 3a2.5 2.5 0 0 1 2.45 2h2.1a2.5 2.5 0 1 1 0 1.5h-2.1A2.5 2.5 0 0 1 6 6.5V9H3.5A2.5 2.5 0 1 0 3.5 14H6v3.5A3.5 3.5 0 0 0 9.5 21H13v-2.5a2.5 2.5 0 1 1 5 0V21h.5a3.5 3.5 0 0 0 3.5-3.5V14h-2.5a2.5 2.5 0 1 1 0-5H22V6.5A3.5 3.5 0 0 0 18.5 3H15v2.5a2.5 2.5 0 1 1-5 0V3H8.5Z"/>
    </svg>`;
}

function flagHtml(flag: string, title: string, description: string): string {
  return `
    <label class="dion-setting-row">
      <span class="dion-setting-copy">
        <span class="dion-setting-title">${title}</span>
        <span class="dion-setting-desc">${description}</span>
      </span>
      <span class="dion-switch">
        <input
          type="checkbox"
          role="switch"
          data-dion-ml-flag="${flag}"
          aria-label="${title}"
          ${savedFlag(FLAG_KEYS[flag] ?? "") ? "checked" : ""}
        />
        <span class="dion-track" aria-hidden="true"></span>
      </span>
    </label>`;
}

function idsHtml(kind: string, title: string): string {
  return `
    <label class="dion-field-row">
      <span class="dion-field-copy">
        <span class="dion-setting-title">${title}</span>
        <span class="dion-setting-desc">${i18nHtml("ui.separate_multiple_ids_with_spaces_or_commas")}</span>
      </span>
      <input
        type="text"
        data-dion-ml-ids="${kind}"
        value="${esc(savedText(ID_KEYS[kind] ?? ""))}"
        placeholder="123…, 456…"
        spellcheck="false"
        autocomplete="off"
      />
    </label>`;
}

function limitStatus(limit: number, count: number): string {
  if (limit <= 0) return i18nText("ui.unlimited_value_saved", {v0: count});
  return i18nText("ui.value_value_saved", {v0: count, v1: limit});
}

function limitHtml(): string {
  const limit = savedLimit();

  return `
    <div class="dion-plugin-details">
      <div class="dion-details-head">
        <div>
          <span class="dion-eyebrow">${i18nHtml("ui.message_logger")}</span>
          <h4>${i18nHtml("ui.advanced_options")}</h4>
        </div>
        <span class="dion-details-note">${i18nHtml("ui.changes_are_saved_instantly")}</span>
      </div>

      <div class="dion-settings-group">
        <div class="dion-field-row dion-limit-row">
          <span class="dion-field-copy">
            <label class="dion-setting-title" for="dion-ml-limit">${i18nHtml("ui.log_limit")}</label>
            <span class="dion-setting-desc" id="dion-ml-left" data-dion-ml-left>${esc(limitStatus(limit, logCount()))}</span>
          </span>

          <div class="dion-limit-controls">
            <input
              id="dion-ml-limit"
              type="number"
              min="0"
              step="1"
              inputmode="numeric"
              data-dion-ml-limit
              value="${limit}"
              aria-describedby="dion-ml-left"
            />
            <button type="button" class="dion-icon-btn" data-dion-ml-reset aria-label="${h("ui.reset_log")}" data-si18n-aria-label="ui.reset_log">
              <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M17.65 6.35A7.96 7.96 0 0 0 12 4C7.58 4 4.01 7.58 4.01 12S7.58 20 12 20c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35Z"/>
              </svg>
            </button>
          </div>
        </div>

        <label class="dion-setting-row">
          <span class="dion-setting-copy">
            <span class="dion-setting-title">${i18nHtml("ui.monitor_unopened_servers")}</span>
            <span class="dion-setting-desc">${i18nHtml("ui.share_background_server_subscriptions_with_other_plugins_no_channel_hi")}</span>
            <span class="dion-setting-status" data-dion-ml-ultimate-status></span>
          </span>
          <span class="dion-switch">
            <input
              type="checkbox"
              role="switch"
              data-dion-ml-ultimate
              aria-label="${h("ui.monitor_unopened_servers")}"
              ${savedUltimate() ? "checked" : ""} data-si18n-aria-label="ui.monitor_unopened_servers"
            />
            <span class="dion-track" aria-hidden="true"></span>
          </span>
        </label>

        ${flagHtml("bots", i18nText("ui.ignore_bots"), i18nText("ui.do_not_store_messages_sent_by_bot_accounts"))}
        ${flagHtml("self", i18nText("ui.ignore_yourself"), i18nText("ui.do_not_store_your_own_messages"))}
      </div>

      <div class="dion-subsection-label">${i18nHtml("ui.ignore_lists")}</div>
      <div class="dion-settings-group dion-field-group">
        ${idsHtml("users", i18nText("ui.user_ids"))}
        ${idsHtml("channels", i18nText("ui.channel_ids"))}
        ${idsHtml("guilds", i18nText("ui.server_ids"))}
      </div>
    </div>`;
}

function expandButtonHtml(): string {
  const expanded = loggerOpen ? "true" : "false";

  return `
    <button
      type="button"
      class="dion-icon-btn dion-expand"
      data-dion-ml-expand
      aria-expanded="${expanded}"
      aria-label="${h("ui.message_logger_options")}" data-si18n-aria-label="ui.message_logger_options"
    >
      <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="m7.41 8.59 4.59 4.58 4.59-4.58L18 10l-6 6-6-6 1.41-1.41Z"/>
      </svg>
    </button>`;
}

function hideTypingOptionsHtml(): string {
  const easyChange =
    settings.get<boolean>(HIDE_TYPING_EASY_KEY, false) === true;
  const mode = savedText(HIDE_TYPING_MODE_KEY) || "hide";
  const active = (HIDE_TYPING_MODES as readonly string[]).includes(mode)
    ? mode
    : "hide";

  const modeField = `
        <label class="dion-field-row">
          <span class="dion-field-copy">
            <span class="dion-setting-title">${i18nHtml("ui.typing_mode")}</span>
            <span class="dion-setting-desc">
              ${i18nHtml("ui.how_your_typing_indicator_behaves_the_chat_input_button_changes_this_t")}
            </span>
          </span>
          <span class="dion-select-wrap">
            <select class="dion-select" data-dion-hide-typing-mode aria-label="${h("ui.typing_mode")}" data-si18n-aria-label="ui.typing_mode">
              <option value="hide"${active === "hide" ? " selected" : ""}>${i18nHtml("ui.hide_typing")}</option>
              <option value="always"${active === "always" ? " selected" : ""}>${i18nHtml("ui.always_typing")}</option>
              <option value="default"${active === "default" ? " selected" : ""}>${i18nHtml("ui.no_select")}</option>
            </select>
            <svg class="dion-select-chevron" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="m7.41 8.59 4.59 4.58 4.59-4.58L18 10l-6 6-6-6 1.41-1.41Z"/>
            </svg>
          </span>
        </label>`;

  return `
    <div class="dion-plugin-details dion-hide-typing-options">
      <div class="dion-details-head">
        <div>
          <span class="dion-eyebrow">${i18nHtml("ui.hide_typing")}</span>
          <h4>${i18nHtml("ui.typing_visibility")}</h4>
        </div>
        <span class="dion-details-note">${i18nHtml("ui.changes_are_saved_instantly")}</span>
      </div>

      <div class="dion-settings-group">
        <label class="dion-setting-row">
          <span class="dion-setting-copy">
            <span class="dion-setting-title">${i18nHtml("ui.easy_change")}</span>
            <span class="dion-setting-desc">
              ${i18nHtml("ui.adds_a_button_to_the_chat_input_for_switching_the_mode_so_you_never_ha")}
            </span>
          </span>
          <span class="dion-switch">
            <input
              type="checkbox"
              role="switch"
              data-dion-hide-typing-easy
              aria-label="${h("ui.easy_change")}"
              ${easyChange ? "checked" : ""} data-si18n-aria-label="ui.easy_change"
            />
            <span class="dion-track" aria-hidden="true"></span>
          </span>
        </label>
      </div>

      <div class="dion-subsection-label">${i18nHtml("ui.behaviour")}</div>
      <div class="dion-settings-group dion-field-group">
        ${modeField}
      </div>
    </div>`;
}

function hideTypingExpandButtonHtml(): string {
  const expanded = hideTypingOpen ? "true" : "false";

  return `
    <button
      type="button"
      class="dion-icon-btn dion-expand"
      data-dion-hide-typing-expand
      aria-expanded="${expanded}"
      aria-label="${h("ui.hide_typing_options")}" data-si18n-aria-label="ui.hide_typing_options"
    >
      <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="m7.41 8.59 4.59 4.58 4.59-4.58L18 10l-6 6-6-6 1.41-1.41Z"/>
      </svg>
    </button>`;
}

function sessionRestoreExpandButtonHtml(): string {
  const expanded = sessionRestoreOpen ? "true" : "false";

  return `
    <button
      type="button"
      class="dion-icon-btn dion-expand"
      data-dion-session-expand
      aria-expanded="${expanded}"
      aria-label="${h("ui.session_restore_options")}" data-si18n-aria-label="ui.session_restore_options"
    >
      <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="m7.41 8.59 4.59 4.58 4.59-4.58L18 10l-6 6-6-6 1.41-1.41Z"/>
      </svg>
    </button>`;
}

function logButtonHtml(): string {
  return `
    <button
      type="button"
      class="dion-icon-btn"
      data-dion-ml-open
      aria-label="${h("ui.open_message_log")}" data-si18n-aria-label="ui.open_message_log"
    >
      <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M6 2h9l5 5v15a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm8 1.5V8h4.5L14 3.5ZM8 12h8v1.5H8V12Zm0 4h8v1.5H8V16Z"/>
      </svg>
    </button>`;
}


function sessionRestoreOptionsHtml(): string {
  const checked =
    settings.get<boolean>(
      SESSION_DONT_ASK_KEY,
      false,
    ) === true
      ? "checked"
      : "";

  return `
    <div class="dion-plugin-details dion-session-restore-options">
      <div class="dion-details-head">
        <div>
          <span class="dion-eyebrow">${i18nHtml("ui.session_restore")}</span>
          <h4>${i18nHtml("ui.restore_behavior")}</h4>
        </div>

        <span class="dion-details-note">
          ${i18nHtml("ui.changes_are_saved_instantly")}
        </span>
      </div>

      <div class="dion-settings-group">
        <label class="dion-setting-row">
          <span class="dion-setting-copy">
            <span class="dion-setting-title">${i18nHtml("ui.don_t_ask")}</span>
            <span class="dion-setting-desc">
              ${i18nHtml("ui.automatically_restore_the_previous_session_without_showing_the_confirm")}
            </span>
          </span>

          <span class="dion-switch">
            <input
              type="checkbox"
              role="switch"
              data-dion-session-dont-ask
              aria-label="Don't ask before restoring a session"
              ${checked}
            />
            <span class="dion-track" aria-hidden="true"></span>
          </span>
        </label>
      </div>
    </div>`;
}

function autoQuestsExpandButtonHtml(): string {
  return `
    <button
      type="button"
      class="dion-icon-btn dion-expand"
      data-dion-quest-expand
      aria-expanded="${autoQuestsOpen ? "true" : "false"}"
      aria-controls="dion-auto-quests-options"
      aria-label="${h("ui.auto_quests_options")}" data-si18n-aria-label="ui.auto_quests_options"
    >
      <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="m7.41 8.59 4.59 4.58 4.59-4.58L18 10l-6 6-6-6 1.41-1.41Z"/>
      </svg>
    </button>`;
}

function questActionsHtml(plugin: PluginPublicInfo): string {
  const state = questRunnerState();

  return `
    <div class="dion-plugin-details" id="dion-auto-quests-options">
      <div class="dion-inline-panel dion-quest-actions">
        <div class="dion-inline-copy">
          <span class="dion-setting-title">${i18nHtml("ui.quest_runner")}</span>
          <span data-dion-quest-status>${esc(plugin.started ? state.status : i18nText("ui.enable_the_plugin_first"))}</span>
        </div>

        <button
          type="button"
          class="dion-primary-btn"
          data-dion-quest-toggle
          ${!plugin.started || (state.running && state.stopping) ? "disabled" : ""}
        >
          ${state.running ? i18nHtml("ui.stop") : i18nHtml("ui.start")}
        </button>
      </div>

      ${autoClaimViewHtml()}
    </div>`;
}

/**
 * The auto-claim block, rebuilt from the live watcher state.
 *
 * Rendered as part of the plugin's own details block rather than lazily, so it
 * inherits the panel's styling and — more importantly — disappears with the
 * plugin when the plugin is switched off.
 *
 * The key's status comes from the main process, which is the only realm that can
 * read the keychain, and it is fetched asynchronously. Until the first answer
 * lands the block says the key is not stored — the safe direction, since that
 * is the state in which nothing is spent.
 */
function autoClaimViewHtml(): string {
  const view = claimState();
  const status = captchaStatus ?? {
    configured: false,
    masked: null,
    encryptionAvailable: true,
    lockedDown: false,
  };
  return autoClaimSectionHtml({
    enabled: autoClaimEnabled(),
    configured: status.configured,
    masked: status.masked,
    encryptionAvailable: status.encryptionAvailable,
    lockedDown: status.lockedDown,
    status: view.detail,
    claimed: view.claimed,
    skipped: view.skipped,
    solves: view.solves,
    lastError: view.lastError,
    widgetPatched: hcaptchaBridgePatched(),
  });
}

/** Last answer from the main process about the stored solver key. */
let captchaStatus: { configured: boolean; masked: string | null; encryptionAvailable: boolean; lockedDown: boolean } | undefined;

function refreshCaptchaStatus(): void {
  const bridge = window.SyncordNative?.captcha;
  if (!bridge) return;
  void bridge
    .status()
    .then((status) => {
      captchaStatus = status;
      paintQuestActions();
    }, () => undefined);
}

/**
 * Repaint the auto-claim block without rebuilding the list.
 *
 * The block is replaced wholesale rather than patched field by field: it is a
 * handful of strings that are all derived from the same three sources, so a
 * partial update is three chances to leave one of them stale.
 */
function paintAutoClaim(): void {
  const holder = root?.querySelector<HTMLElement>(".dion-autoclaim");
  if (!holder) return;
  // Carry a half-typed key across the repaint. A claim can land while the user
  // is still pasting, and losing the field would make the feature look broken
  // in exactly the moment someone is trying to set it up.
  const draft = captureAutoClaimDraft(
    root?.querySelector<HTMLInputElement>("[data-dion-quest-key]"),
  );
  holder.outerHTML = autoClaimViewHtml();
  restoreAutoClaimDraft(root?.querySelector<HTMLInputElement>("[data-dion-quest-key]"), draft);
  bindAutoClaimInputs();
}

function paintQuestActions(): void {
  const plugin = list().find((item) => item.id === "auto-quests");
  const scope = root?.querySelector<HTMLElement>(".dion-quest-actions");
  if (!scope || !plugin) return;

  const state = questRunnerState();
  const button = scope.querySelector<HTMLButtonElement>("[data-dion-quest-toggle]");
  const label = scope.querySelector<HTMLElement>("[data-dion-quest-status]");

  if (button) {
    button.textContent = state.running ? i18nText("ui.stop") : i18nText("ui.start");
    button.disabled = !plugin.started || state.stopping;
  }

  if (label) {
    label.textContent = plugin.started ? state.status : i18nText("ui.enable_the_plugin_first");
  }

  paintAutoClaim();
}


/**
 * Wire the switch and the two key buttons.
 *
 * Re-bound after every repaint, because the block is replaced rather than
 * patched; the previous nodes are gone, so their listeners went with them.
 */
function bindAutoClaimInputs(): void {
  const toggle = root?.querySelector<HTMLInputElement>("[data-dion-quest-autoclaim]");
  toggle?.addEventListener("change", () => {
    setAutoClaimEnabled(toggle.checked);
    requestClaimRefresh();
  });

  const save = root?.querySelector<HTMLButtonElement>("[data-dion-quest-key-save]");
  save?.addEventListener("click", () => {
    const field = root?.querySelector<HTMLInputElement>("[data-dion-quest-key]");
    const key = field?.value ?? "";
    const bridge = window.SyncordNative?.captcha;
    if (!bridge) {
      showToast(i18nText("ui.this_syncord_version_does_not_support_captcha_solving"), { type: ToastType.FAILURE });
      return;
    }
    void bridge
      .setKey(key)
      .then((result) => {
        if (result.ok) {
          // The field is cleared on success: the value has been handed to the
          // main process and has no reason to stay in the DOM.
          if (field) field.value = "";
          showToast(i18nText("ui.api_key_saved"), { type: ToastType.SUCCESS });
        } else {
          showToast(result.reason ?? i18nText("ui.could_not_save_the_api_key"), { type: ToastType.FAILURE });
        }
        refreshCaptchaStatus();
      }, (error: unknown) => {
        showToast(error instanceof Error ? localizeError(error) : i18nText("ui.could_not_save_the_api_key"), { type: ToastType.FAILURE });
      });
  });

  const clear = root?.querySelector<HTMLButtonElement>("[data-dion-quest-key-clear]");
  clear?.addEventListener("click", () => {
    void window.SyncordNative?.captcha?.clearKey().then(() => {
      refreshCaptchaStatus();
    }, () => undefined);
  });
}

function rowHtml(plugin: PluginPublicInfo): string {
  const status = statusOf(plugin);
  const checked = plugin.enabled ? "checked" : "";
  const special = plugin.id === "platform-spoofer" || plugin.id === "virtual-servers" || plugin.id === "long-messages" || plugin.id === "custom-game-presence" || plugin.id === "syncord-drop" || plugin.id === "experiments" || plugin.id === SPOTIFY_ID || plugin.id === RN_ID || plugin.id === IMAGE_ZOOM_ID || plugin.id === SMART_ID || plugin.id === HIDDEN_ID ||
    plugin.id === "message-logger" ||
    plugin.id === "auto-quests" ||
    plugin.id === "show-badges" || plugin.id === PLATFORM_ID ||
    plugin.id === "session-restore" ||
    plugin.id === "hide-typing" ||
    plugin.id === SCHEDULED_PLUGIN_ID || plugin.id === ACTIVITY_PLUGIN_ID || plugin.id === RECORDER_ID;
  const shell = special ? "div" : "label";
  const details = plugin.id === "platform-spoofer" ? spooferSectionHtml() : plugin.id === "virtual-servers" ? virtualSectionHtml() : plugin.id === "long-messages" ? longSectionHtml() : plugin.id === "custom-game-presence" ? gameSectionHtml() : plugin.id === "syncord-drop" ? dropSectionHtml() : plugin.id === "experiments" ? experimentsSectionHtml() : plugin.id === SPOTIFY_ID ? spotifySectionHtml() : plugin.id === RN_ID ? relationshipSectionHtml() : plugin.id === IMAGE_ZOOM_ID ? imageZoomSectionHtml() : plugin.id === SMART_ID ? smartUploadSectionHtml() : plugin.id === HIDDEN_ID ? hiddenItemsSectionHtml() :
    plugin.id === PLATFORM_ID ? platformsSectionHtml() :
    plugin.id === RECORDER_ID ? recorderSectionHtml() :
    plugin.id === "message-logger"
      ? limitHtml()
      : plugin.id === "show-badges"
        ? badgesSectionHtml()
      : plugin.id === "auto-quests"
        ? questActionsHtml(plugin)
        : plugin.id === "session-restore"
          ? sessionRestoreOptionsHtml()
          : plugin.id === "hide-typing"
            ? hideTypingOptionsHtml()
            : plugin.id === SCHEDULED_PLUGIN_ID
              ? scheduledSectionHtml()
              : plugin.id === ACTIVITY_PLUGIN_ID
                ? activitySectionHtml()
                : "";

  const actions = plugin.id === "platform-spoofer" ? spooferExpandHtml() : plugin.id === "virtual-servers" ? virtualExpandHtml() : plugin.id === "long-messages" ? longExpandHtml() : plugin.id === "custom-game-presence" ? gameExpandHtml() : plugin.id === "syncord-drop" ? dropExpandHtml() : plugin.id === "experiments" ? experimentsExpandHtml() : plugin.id === SPOTIFY_ID ? spotifyExpandHtml() : plugin.id === RN_ID ? relationshipExpandButtonHtml() : plugin.id === IMAGE_ZOOM_ID ? imageZoomExpandButtonHtml() : plugin.id === SMART_ID ? smartUploadExpandButtonHtml() : plugin.id === HIDDEN_ID ? hiddenItemsExpandButtonHtml() :
    plugin.id === PLATFORM_ID ? platformsExpandButtonHtml() :
    plugin.id === RECORDER_ID ? recorderExpandButtonHtml() :
    plugin.id === "message-logger"
      ? `${logButtonHtml()}${expandButtonHtml()}`
      : plugin.id === "show-badges"
        ? badgesExpandButtonHtml()
      : plugin.id === "auto-quests"
        ? autoQuestsExpandButtonHtml()
        : plugin.id === "session-restore"
          ? sessionRestoreExpandButtonHtml()
          : plugin.id === "hide-typing"
            ? hideTypingExpandButtonHtml()
            : plugin.id === SCHEDULED_PLUGIN_ID
              ? scheduledExpandButtonHtml()
              : plugin.id === ACTIVITY_PLUGIN_ID
                ? activityExpandButtonHtml()
                : "";

  const author = plugin.author
    ? `<span class="dion-author">${i18nHtml("ui.plugin_author",{author:plugin.author})}</span>`
    : "";

  return `
    <div class="dion-plugin${
      (plugin.id === "platform-spoofer" && isSpooferExpanded()) ||
      (plugin.id === "virtual-servers" && isVirtualExpanded()) ||
      (plugin.id === "long-messages" && isLongExpanded()) ||
      (plugin.id === "custom-game-presence" && isGameExpanded()) ||
      (plugin.id === "syncord-drop" && isDropExpanded()) ||
      (plugin.id === "experiments" && isExperimentsExpanded()) ||
      (plugin.id === SPOTIFY_ID && isSpotifyExpanded()) ||
      (plugin.id === RN_ID && isRelationshipExpanded()) ||
      (plugin.id === IMAGE_ZOOM_ID && isImageZoomExpanded()) ||
      (plugin.id === SMART_ID && isSmartUploadExpanded()) ||
      (plugin.id === HIDDEN_ID && isHiddenItemsExpanded()) ||
      (plugin.id === PLATFORM_ID && isPlatformsExpanded()) ||
      (plugin.id === RECORDER_ID && isRecorderExpanded()) ||
      (plugin.id === "message-logger" && loggerOpen) ||
      (plugin.id === "show-badges" && isBadgesExpanded()) ||
      (plugin.id === "auto-quests" && autoQuestsOpen) ||
      (plugin.id === "session-restore" && sessionRestoreOpen) ||
      (plugin.id === SCHEDULED_PLUGIN_ID && isScheduledExpanded()) ||
      (plugin.id === ACTIVITY_PLUGIN_ID && isActivityExpanded())
        ? " is-open"
        : ""
    }">
      <${shell} class="dion-row">
        <span class="dion-plugin-glyph">${pluginGlyph()}</span>

        <span class="dion-meta">
          <span class="dion-name-line">
            <span class="dion-name">${productHtml(plugin.name)}</span>
            <span class="dion-pill is-${status.kind}">${productHtml(status.label)}</span>
          </span>

          <span class="dion-desc">${productHtml(plugin.description ?? plugin.id)}</span>
          ${author}
        </span>

        <span class="dion-row-actions">
          ${actions}
          <span class="dion-switch">
            <input
              type="checkbox"
              role="switch"
              data-dion-plugin="${esc(plugin.id)}"
              ${productAttribute("aria-label",plugin.name)}
              ${checked}
            />
            <span class="dion-track" aria-hidden="true"></span>
          </span>
        </span>
      </${shell}>

      ${details}
    </div>`;
}

function countText(shown: number, total: number, q: string): string {
  if (total === 0) return i18nText("ui.no_plugins");
  if (!q) return i18nText("count.plugins", {count: total});
  return i18nText("ui.value_of_value", {v0: shown, v1: total});
}

function emptyHtml(total: number, q: string): string {
  if (total === 0) {
    return `
      <div class="dion-empty">
        <div class="dion-empty-icon">${pluginGlyph()}</div>
        <p class="dion-empty-title">${i18nHtml("ui.no_plugins_yet")}</p>
        <p class="dion-empty-sub">${i18nHtml("ui.installed_syncord_plugins_will_appear_here")}</p>
      </div>`;
  }

  return `
    <div class="dion-empty">
      <div class="dion-empty-icon">
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M10.5 3a7.5 7.5 0 1 0 4.73 13.32L20.9 22 22 20.9l-5.68-5.67A7.5 7.5 0 0 0 10.5 3Zm0 2a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Z"/>
        </svg>
      </div>
      <p class="dion-empty-title">${i18nHtml("ui.nothing_found")}</p>
      <p class="dion-empty-sub">${i18nHtml("ui.no_plugin_matches_query",{query:q})}</p>
    </div>`;
}

function renderList(): void {
  const restoreControlFocus=settingsControls?.captureFocus();
  if (!root) return;

  const listEl = root.querySelector<HTMLElement>("[data-dion-list]");
  const countEl = root.querySelector<HTMLElement>("[data-dion-count]");
  const summaryEl = root.querySelector<HTMLElement>("[data-dion-summary]");
  const clearBtn = root.querySelector<HTMLButtonElement>("[data-dion-clear]");

  if (!listEl || !countEl) return;

  const q = query.trim();
  const all = list();
  const shown = q ? all.filter((plugin) => matches(plugin, q)) : all;
  const running = all.filter((plugin) => plugin.started).length;

  hideTooltip();

  // Hidden Items owns DOM and account listeners inside the rendered list.
  // Dispose before replacing that DOM and bind only after its host exists.
  disposeSpooferPanel?.();disposeSpooferPanel=undefined;
  disposeVirtualPanel?.();disposeVirtualPanel=undefined;
  disposeLongPanel?.();disposeLongPanel=undefined;
  disposeGamePanel?.();disposeGamePanel=undefined;
  disposeExperimentsPanel?.();disposeExperimentsPanel=undefined;
  disposeSpotifyPanel?.();disposeSpotifyPanel=undefined;
  disposeHiddenItemsPanel?.();
  disposeHiddenItemsPanel=undefined;
  setLocalizedHtml(listEl, shown.length
    ? `<div class="dion-plugin-surface">${shown.map(rowHtml).join("")}</div>`
    : emptyHtml(all.length, query.trim()));
  disposeHiddenItemsPanel=bindHiddenItemsPanel(root);
  disposeSpotifyPanel=bindSpotifyPanel(root);
  if(activeTab==='plugins'){disposeSpooferPanel=bindSpooferPanel(root);disposeVirtualPanel=bindVirtualPanel(root,closeSettings);disposeLongPanel=bindLongPanel(root);disposeExperimentsPanel=bindExperimentsPanel(root);disposeGamePanel=bindGamePanel(root);}

  countEl.textContent = countText(shown.length, all.length, q);
  if (summaryEl) setLocalizedText(summaryEl, "ui.value_running_value_installed", {v0: running, v1: all.length});
  if (clearBtn) clearBtn.hidden = query.trim() === "";

  const reset = listEl.querySelector<HTMLButtonElement>("[data-dion-ml-reset]");
  if (reset) bindTooltip(reset, () => i18nText("ui.reset_log_limit"));

  const logBtn = listEl.querySelector<HTMLButtonElement>("[data-dion-ml-open]");
  if (logBtn) bindTooltip(logBtn, () => i18nText("ui.message_log"));

  // Opened or merely rendered: the key status is a main-process answer, so it
  // is fetched once here rather than polled.
  if (autoQuestsOpen) {
    bindAutoClaimInputs();
    refreshCaptchaStatus();
  }

  settingsControls?.refresh();restoreControlFocus?.();bulkActions?.refresh();
  window.dispatchEvent(new Event(RECORDER_EVENT));
  window.dispatchEvent(new Event("Syncord-ml-ultimate-status"));
}

function paintStatus(input: HTMLInputElement, plugin: PluginPublicInfo): void {
  const pill = input.closest(".dion-row")?.querySelector(".dion-pill");
  if (!pill) return;

  const status = statusOf(plugin);
  pill.className = `dion-pill is-${status.kind}`;
  pill.textContent = status.label;
}

function bindShell(): void {
  disposeQuestUi?.();
  window.addEventListener(questRunnerChangeEvent,paintQuestActions);
  window.addEventListener(claimChangeEvent,paintQuestActions);
  disposeQuestUi=()=>{window.removeEventListener(questRunnerChangeEvent,paintQuestActions);window.removeEventListener(claimChangeEvent,paintQuestActions);};
  if(root){disposeDropPanel?.();disposeDropPanel=bindDropPanel(root);}
  if (root) {
    disposeRelationshipPanel?.();disposeRelationshipPanel=bindRelationshipPanel(root);
    disposeImageZoomPanel?.();disposeImageZoomPanel=bindImageZoomPanel(root);
    disposeSmartUploadPanel?.();disposeSmartUploadPanel=bindSmartUploadPanel(root);
    disposeRecorderPanel?.();
    disposeRecorderPanel = bindRecorderPanel(root);
    disposeActivityPanel?.();
    disposeActivityPanel = bindActivityPanel(root);
    disposeBadgesPanel?.();disposeBadgesPanel=bindBadgesPanel(root);
    disposePlatformsPanel?.();disposePlatformsPanel=bindPlatformsPanel(root);
  }
  if (!root) return;

  root.querySelectorAll("[data-dion-close]").forEach((el) => {
    el.addEventListener("click", () => closeSettings());
  });

  root.querySelector("[data-dion-reload]")?.addEventListener("click", () => {
    location.reload();
  });

  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    closeSettings();
  });

  const search = root.querySelector<HTMLInputElement>("[data-dion-search]");

  search?.addEventListener("input", () => {
    query = search.value;
    renderList();
  });

  root.querySelector("[data-dion-clear]")?.addEventListener("click", () => {
    query = "";
    if (search) {
      search.value = "";
      search.focus();
    }
    renderList();
  });

  root.querySelector("[data-dion-list]")?.addEventListener("input", (event) => {
    const input = (event.target as HTMLElement | null)?.closest?.("input[data-dion-ml-limit]");
    if (!(input instanceof HTMLInputElement)) return;

    const raw = input.value.trim();
    if (raw === "") return;

    const next = Number(raw);
    if (!Number.isInteger(next) || next < 0) return;

    settings.set(LOG_LIMIT_KEY, next);
    setLogLimit(next);

    const hint = input.closest(".dion-limit-row")?.querySelector("[data-dion-ml-left]");
    if (hint) hint.textContent = limitStatus(next, logCount());
  });

  root.querySelector("[data-dion-list]")?.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest?.("[data-dion-ml-reset]");
    if (!(button instanceof HTMLButtonElement)) return;

    event.preventDefault();
    clearLog();
    showToast(i18nText("ui.log_successfully_reset"), { type: ToastType.SUCCESS });

    const scope = button.closest(".dion-limit-row");
    const hint = scope?.querySelector("[data-dion-ml-left]");
    const field = scope?.querySelector("input[data-dion-ml-limit]");
    const typed = field instanceof HTMLInputElement ? Number(field.value) : savedLimit();
    const limit = Number.isInteger(typed) && typed >= 0 ? typed : savedLimit();

    if (hint) hint.textContent = limitStatus(limit, logCount());
  });

  root.querySelector("[data-dion-list]")?.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest?.("[data-dion-ml-expand]");
    if (!(button instanceof HTMLButtonElement)) return;

    event.preventDefault();
    event.stopPropagation();
    hideTooltip();

    loggerOpen = !loggerOpen;
    button.closest(".dion-plugin")?.classList.toggle("is-open", loggerOpen);
    button.setAttribute("aria-expanded", loggerOpen ? "true" : "false");
  });

  root.querySelector("[data-dion-list]")?.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest?.(
      "[data-dion-hide-typing-expand]",
    );

    if (!(button instanceof HTMLButtonElement)) return;

    event.preventDefault();
    event.stopPropagation();
    hideTooltip();

    hideTypingOpen = !hideTypingOpen;

    button
      .closest(".dion-plugin")
      ?.classList.toggle("is-open", hideTypingOpen);

    button.setAttribute(
      "aria-expanded",
      hideTypingOpen ? "true" : "false",
    );
  });

  // ── Scheduled Messages ────────────────────────────────────────────────
  root.querySelector("[data-dion-list]")?.addEventListener("click", (event) => {
    const expand = (event.target as Element | null)?.closest?.(
      "[data-dion-sm-expand]",
    );

    if (expand instanceof HTMLButtonElement) {
      event.preventDefault();
      event.stopPropagation();
      hideTooltip();

      const next = !isScheduledExpanded();
      setScheduledExpanded(next);
      expand
        .closest(".dion-plugin")
        ?.classList.toggle("is-open", next);
      expand.setAttribute("aria-expanded", next ? "true" : "false");
      if (next) renderList();
      return;
    }

    const button = (event.target as Element | null)?.closest?.(
      "[data-dion-sm-action]",
    );
    if (!(button instanceof HTMLButtonElement)) return;

    event.preventDefault();
    event.stopPropagation();

    const card = button.closest<HTMLElement>("[data-dion-sm-card]");
    const id = card?.getAttribute("data-dion-sm-card");
    if (!card || !id) return;

    const store = activeScheduledStore();
    const message = store?.byId(id);
    if (!store || !message) return;

    // The card handles its own sub-forms, so nothing is re-rendered here and
    // nothing the user is typing gets thrown away.
    scheduledActionHandler()?.(button.getAttribute("data-dion-sm-action") ?? "", message, card);
  });

  // A long message opens in place rather than in a tooltip, so the full text is
  // readable without a hover and works on a touch screen.
  root.querySelector("[data-dion-list]")?.addEventListener("click", (event) => {
    const body = (event.target as Element | null)?.closest?.(".dion-sm-body");
    if (!(body instanceof HTMLElement)) return;
    const open = body.getAttribute("aria-expanded") === "true";
    body.setAttribute("aria-expanded", open ? "false" : "true");
  });

  // The store is the source of truth; anything that changes it redraws the list
  // so the section never shows a state that has already moved on.
  disposeScheduledPanelChange?.();
  const onScheduledPanelChange=():void=>{
    if (!root) return;
    // Not while a card is open for editing: the redraw would discard the text
    // being typed. The change is picked up on the next one.
    if (isScheduledEditing(root)) return;
    renderList();
  };
  window.addEventListener(scheduledChangeEvent,onScheduledPanelChange);
  disposeScheduledPanelChange=()=>window.removeEventListener(scheduledChangeEvent,onScheduledPanelChange);

  root.querySelector("[data-dion-list]")?.addEventListener("change", (event) => {
    const input = (event.target as HTMLElement | null)?.closest?.(
      "input[data-dion-hide-typing-easy]",
    );

    if (!(input instanceof HTMLInputElement)) return;

    settings.set(HIDE_TYPING_EASY_KEY, input.checked);
    // Applied at once rather than on the plugin's next tick, so the button
    // appears without a restart.
    window.dispatchEvent(new Event(hideTypingChangeEvent));
    // The hint text depends on this, so the row is redrawn.
    renderList();
  });

  root.querySelector("[data-dion-list]")?.addEventListener("change", (event) => {
    const input = (event.target as HTMLElement | null)?.closest?.(
      "select[data-dion-hide-typing-mode]",
    );

    if (!(input instanceof HTMLSelectElement)) return;
    if (!(HIDE_TYPING_MODES as readonly string[]).includes(input.value)) return;

    settings.set(HIDE_TYPING_MODE_KEY, input.value);
    window.dispatchEvent(new Event(hideTypingChangeEvent));
  });

  root.querySelector("[data-dion-list]")?.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest?.(
      "[data-dion-session-expand]",
    );

    if (!(button instanceof HTMLButtonElement)) return;

    event.preventDefault();
    event.stopPropagation();
    hideTooltip();

    sessionRestoreOpen = !sessionRestoreOpen;

    button
      .closest(".dion-plugin")
      ?.classList.toggle(
        "is-open",
        sessionRestoreOpen,
      );

    button.setAttribute(
      "aria-expanded",
      sessionRestoreOpen
        ? "true"
        : "false",
    );
  });

  root.querySelector("[data-dion-list]")?.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest?.("[data-dion-ml-open]");
    if (!(button instanceof HTMLButtonElement)) return;

    event.preventDefault();
    event.stopPropagation();
    openMessageLog();
  });

  root.querySelector("[data-dion-list]")?.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest?.("[data-dion-quest-expand]");
    if (!(button instanceof HTMLButtonElement)) return;

    event.preventDefault();
    event.stopPropagation();
    hideTooltip();

    autoQuestsOpen = !autoQuestsOpen;
    button.closest(".dion-plugin")?.classList.toggle("is-open", autoQuestsOpen);
    button.setAttribute("aria-expanded", autoQuestsOpen ? "true" : "false");
    if (autoQuestsOpen) {
      bindAutoClaimInputs();
      refreshCaptchaStatus();
    }
  });

  root.querySelector("[data-dion-list]")?.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest?.("[data-dion-quest-toggle]");
    if (!(button instanceof HTMLButtonElement)) return;

    event.preventDefault();
    event.stopPropagation();
    toggleQuestRunner();
    paintQuestActions();
  });

  root.querySelector("[data-dion-list]")?.addEventListener("input", (event) => {
    const input = (event.target as HTMLElement | null)?.closest?.("input[data-dion-ml-ids]");
    if (!(input instanceof HTMLInputElement)) return;

    const key = ID_KEYS[input.getAttribute("data-dion-ml-ids") ?? ""];
    if (!key) return;

    settings.set(key, input.value);
  });

  root.querySelector("[data-dion-list]")?.addEventListener("change", (event) => {
    const input = (event.target as HTMLElement | null)?.closest?.("input[data-dion-ml-flag]");
    if (!(input instanceof HTMLInputElement)) return;

    const key = FLAG_KEYS[input.getAttribute("data-dion-ml-flag") ?? ""];
    if (!key) return;

    settings.set(key, input.checked);
  });

  root.querySelector("[data-dion-list]")?.addEventListener("change", (event) => {
    const input = (event.target as HTMLElement | null)?.closest?.("input[data-dion-ml-ultimate]");
    if (!(input instanceof HTMLInputElement)) return;

    settings.set(ULTIMATE_KEY, input.checked);
    settings.set(OPENED_KEY, !input.checked);
    window.dispatchEvent(new Event("Syncord-ml-ultimate"));
  });

  root.querySelector("[data-dion-list]")?.addEventListener("change", (event) => {
    const input = (event.target as HTMLElement | null)?.closest?.(
      "input[data-dion-session-dont-ask]",
    );

    if (!(input instanceof HTMLInputElement)) return;

    settings.set(
      SESSION_DONT_ASK_KEY,
      input.checked,
    );
  });

  root.querySelector("[data-dion-list]")?.addEventListener("change", (event) => {
    const input = (event.target as HTMLElement | null)?.closest?.("input[data-dion-plugin]");
    if (!(input instanceof HTMLInputElement)) return;

    const id = input.getAttribute("data-dion-plugin");
    if (!id) return;
    if(pluginOperationBusy()){input.checked=list().find(p=>p.id===id)?.enabled===true;return;}

    void (async () => {
      try {
        if(input.checked&&id==='platform-spoofer'){const row=input.closest('.dion-plugin');if(row)revealSpooferPanel(row);}
        await setPluginEnabled(id,input.checked);

        const plugin = list().find((item) => item.id === id);
        if (plugin) paintStatus(input, plugin);
        if (id === "auto-quests") {
          // Enabling the plugin is what starts the watcher, so the key status has
          // to be re-read afterwards: a key saved while the plugin was off was
          // never fetched, and the block would otherwise claim "not stored".
          requestClaimRefresh();
          refreshCaptchaStatus();
          paintQuestActions();
        }

        const all = list();
        const summary = root?.querySelector<HTMLElement>("[data-dion-summary]");
        if (summary) {
          setLocalizedText(summary, "ui.value_running_value_installed", {v0: all.filter((item) => item.started).length, v1: all.length});
        }
      } catch (err) {
        log.error("toggle failed:", err);
        input.checked = !input.checked;
      }
    })();
  });
}

function mount(): void {
  if (!root) return;

  setLocalizedHtml(root, `
    <div class="dion-backdrop" data-dion-close></div>

    <section
      class="dion-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dion-settings-title"
    >
      <aside class="dion-sidebar">
        <div class="dion-sidebar-head">
          <div class="dion-brand-lockup">
            <div class="dion-logo-shell">
              <img src="${esc(logoUrl)}" alt="" width="34" height="34" />
            </div>

            <div class="dion-brand-copy">
              <div class="dion-brand-line">
                <strong>${i18nHtml("ui.syncord")}</strong>
                <span>v${esc(VERSION)}</span>
              </div>
              <small>${i18nHtml("ui.client_settings")}</small>
            </div>
          </div>
        </div>

        <div class="dion-update-slot" data-dion-update-slot>${updateButtonHtml()}</div>

        <div class="dion-sidebar-search">
          <div class="dion-search">
            <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="M10.5 3a7.5 7.5 0 1 0 4.73 13.32L20.9 22 22 20.9l-5.68-5.67A7.5 7.5 0 0 0 10.5 3Zm0 2a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Z"/>
            </svg>

            <input
              type="search"
              data-dion-search
              placeholder="${h("ui.search_settings")}"
              aria-label="${h("ui.search_plugins")}"
              autocomplete="off"
              spellcheck="false" data-si18n-placeholder="ui.search_settings" data-si18n-aria-label="ui.search_plugins"
            />

            <button type="button" data-dion-clear aria-label="${h("ui.clear_search")}" hidden data-si18n-aria-label="ui.clear_search">
              <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="m7.05 5.64 4.95 4.95 4.95-4.95 1.41 1.41L13.41 12l4.95 4.95-1.41 1.41L12 13.41l-4.95 4.95-1.41-1.41L10.59 12 5.64 7.05l1.41-1.41Z"/>
              </svg>
            </button>
          </div>
        </div>

        <nav class="dion-nav" aria-label="${h("ui.syncord_settings")}" data-si18n-aria-label="ui.syncord_settings">
          <span class="dion-nav-heading">${i18nHtml("ui.syncord")}</span>

          <button type="button" class="dion-nav-item is-active" data-dion-tab="plugins" aria-current="page">
            <span class="dion-nav-icon">${pluginGlyph()}</span>
            <span class="dion-nav-copy">
              <strong>${i18nHtml("ui.plugins")}</strong>
              <small data-dion-summary></small>
            </span>
          </button>

          <button type="button" class="dion-nav-item" data-dion-tab="ecosystem"><span class="dion-nav-icon"><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Z"/></svg></span><span class="dion-nav-copy"><strong>${i18nHtml("ui.syncord_ecosystem")}</strong><small>${i18nHtml("ui.points_badges_community")}</small></span></button>
          <button type="button" class="dion-nav-item" data-dion-tab="performance"><span class="dion-nav-icon"><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z"/></svg></span><span class="dion-nav-copy"><strong>${i18nHtml("pm.name")}</strong><small>${i18nHtml("pm.mode")}</small></span></button>
          <button type="button" class="dion-nav-item" data-dion-tab="statistics">
            <span class="dion-nav-icon"><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 3h2v16h16v2H3V3Zm5 8h3v6H8v-6Zm5-6h3v12h-3V5Zm5 3h3v9h-3V8Z"/></svg></span>
            <span class="dion-nav-copy"><strong>${i18nHtml("ui.statistics")}</strong><small>${i18nHtml("ui.session_resource_usage")}</small></span>
          </button>

          <button type="button" class="dion-nav-item" data-dion-tab="security">
            <span class="dion-nav-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M12 2 4 5v6.1c0 4.9 3.4 9.4 8 10.9 4.6-1.5 8-6 8-10.9V5l-8-3Zm0 2.1 6 2.25V11c0 3.9-2.5 7.5-6 8.9-3.5-1.4-6-5-6-8.9V6.35L12 4.1Zm-.75 3.4v5.5h1.5V7.5h-1.5Zm0 6.75v1.5h1.5v-1.5h-1.5Z"/>
              </svg>
            </span>
            <span class="dion-nav-copy">
              <strong>${i18nHtml("ui.security")}</strong>
              <small data-dion-security-summary>${i18nHtml("ui.guards_permissions")}</small>
            </span>
          </button>
        </nav>

        <div class="dion-sidebar-spacer"></div>

        <div class="dion-sidebar-footer">
          <button type="button" class="dion-reload" data-dion-reload>
            <span class="dion-reload-icon">
              <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M17.65 6.35A7.96 7.96 0 0 0 12 4C7.58 4 4.01 7.58 4.01 12S7.58 20 12 20c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35Z"/>
              </svg>
            </span>
            <span>
              <strong>${i18nHtml("ui.reload_discord")}</strong>
              <small>${i18nHtml("ui.apply_client_side_changes")}</small>
            </span>
          </button>

          <div class="dion-shortcut">
            <span>${i18nHtml("ui.open_settings")}</span>
            <kbd>${esc(shortcutMod())}</kbd><span>+</span><kbd>${i18nHtml("ui.shift")}</kbd><span>+</span><kbd>D</kbd>
          </div>
        </div>
      </aside>

      <main class="dion-main">
        <header class="dion-main-head">
          <div class="dion-page-heading">
            <span class="dion-eyebrow">${i18nHtml("ui.syncord")}</span>
            <h2 id="dion-settings-title" data-dion-page-title>${i18nHtml("ui.plugins")}</h2>
            <p data-dion-page-sub>${i18nHtml("ui.control_installed_plugins_and_configure_advanced_options")}</p>
          </div>

          <div class="dion-head-actions">
            <span class="dion-count" data-dion-count aria-live="polite"></span>

            <button type="button" class="dion-close" data-dion-close aria-label="${h("ui.close_settings")}" data-si18n-aria-label="ui.close_settings">
              <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="m7.05 5.64 4.95 4.95 4.95-4.95 1.41 1.41L13.41 12l4.95 4.95-1.41 1.41L12 13.41l-4.95 4.95-1.41-1.41L10.59 12 5.64 7.05l1.41-1.41Z"/>
              </svg>
            </button>
          </div>
        </header>

        <div class="dion-main-divider"></div>

        <div class="dion-content-scroll">
          <div data-dion-plugin-bulk></div>
          <section class="dion-section-intro">
            <div>
              <h3>${i18nHtml("ui.installed_plugins")}</h3>
              <p>${i18nHtml("ui.enable_disable_and_fine_tune_extensions_without_leaving_discord")}</p>
            </div>

            <span class="dion-section-badge">${i18nHtml("ui.local")}</span>
          </section>

          ${updateSettingsRowHtml()}

          <div class="dion-body" data-dion-list></div>
          <div class="dion-body" data-dion-security hidden></div>
          <div class="dion-body" data-dion-ecosystem hidden></div>
          <div class="dion-body" data-dion-statistics hidden></div>
          <div class="dion-body" data-dion-performance hidden></div>
        </div>
      </main>
    </section>
  `);

  const search = root.querySelector<HTMLInputElement>("[data-dion-search]");
  if (search) search.value = query;

  const bulkHost=root.querySelector<HTMLElement>('[data-dion-plugin-bulk]');
  if(bulkHost)bulkActions=mountPluginBulkActions(bulkHost,root,()=>{if(open&&activeTab==='plugins')renderList();});
  bindShell();
  bindTabs();
  bindUpdateUi(root);
  showTab(activeTab);
  if (activeTab === "plugins") search?.focus();
}

// ── Phase 11: Settings tabs (Plugins / Security Center) ─────────────────────

type SettingsTab = "plugins" | "security" | "statistics" | "ecosystem" | "performance";
let disposePerformancePanel: (()=>void)|undefined;

let activeTab: SettingsTab = "plugins";

const TAB_COPY: Record<SettingsTab, { title: string; sub: string }> = {
  plugins: {
    get title() { return i18nText("ui.plugins"); },
    get sub(){return i18nText("ui.control_installed_plugins_and_configure_advanced_options");},
  },
  performance: {get title(){return i18nText('pm.name');},get sub(){return i18nText('pm.description');}},
  ecosystem: {get title() { return i18nText("ui.syncord_ecosystem"); },get sub(){return i18nText("ui.your_verified_identity_points_and_official_syncord_badges");}},
  statistics: {get title() { return i18nText("ui.statistics"); },get sub(){return i18nText("ui.local_session_process_storage_and_network_measurements");}},
  security: {
    get title() { return i18nText("ui.security"); },
    get sub(){return i18nText("ui.what_syncord_is_guarding_and_what_it_has_refused");},
  },
};

function showTab(tab: SettingsTab): void {
  if (root === undefined) return;
  activeTab = tab;
  disposePerformancePanel?.();disposePerformancePanel=undefined;
  disposeSpooferPanel?.();disposeSpooferPanel=undefined;
  disposeVirtualPanel?.();disposeVirtualPanel=undefined;
  disposeLongPanel?.();disposeLongPanel=undefined;
  disposeGamePanel?.();disposeGamePanel=undefined;
  disposeExperimentsPanel?.();disposeExperimentsPanel=undefined;

  const performanceEl = root.querySelector<HTMLElement>('[data-dion-performance]');
  if(performanceEl)performanceEl.hidden=tab!=='performance';
  const listEl = root.querySelector<HTMLElement>("[data-dion-list]");
  const securityEl = root.querySelector<HTMLElement>("[data-dion-security]");
  const statisticsEl = root.querySelector<HTMLElement>("[data-dion-statistics]");
  const ecosystemEl=root.querySelector<HTMLElement>("[data-dion-ecosystem]");
  const title = root.querySelector<HTMLElement>("[data-dion-page-title]");
  const sub = root.querySelector<HTMLElement>("[data-dion-page-sub]");
  const searchWrap = root.querySelector<HTMLElement>(".dion-sidebar-search");

  const isPlugins = tab === "plugins";
  if (listEl) listEl.hidden = !isPlugins;
  const bulkHost=root.querySelector<HTMLElement>('[data-dion-plugin-bulk]');if(bulkHost)bulkHost.hidden=!isPlugins;
  if (securityEl) securityEl.hidden = tab !== "security";
  if (statisticsEl) statisticsEl.hidden = tab !== "statistics";
  if(ecosystemEl)ecosystemEl.hidden=tab!=="ecosystem";
  for(const selector of [".dion-section-intro",".dion-update-card","[data-dion-count]"]){const el=root.querySelector<HTMLElement>(selector);if(el)el.hidden=!isPlugins;}
  if (searchWrap) searchWrap.hidden = !isPlugins;
  if (title) {const key=messageKeyForLabel(TAB_COPY[tab].title);if(key)setLocalizedText(title,key);else title.textContent=TAB_COPY[tab].title;}
  if (sub) {const key=messageKeyForLabel(TAB_COPY[tab].sub);if(key)setLocalizedText(sub,key);else sub.textContent=TAB_COPY[tab].sub;}

  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-dion-tab]")) {
    const active = button.dataset.dionTab === tab;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }

  unmountStatistics();
  unmountEcosystem();
  unmountSecurityCenter();
  if (isPlugins) renderList();
  else if (tab === "security" && securityEl) mountSecurityCenter(securityEl);
  else if (tab === "statistics" && statisticsEl) mountStatistics(statisticsEl);
  else if(tab==='performance'&&performanceEl)disposePerformancePanel=mountPerformancePanel(performanceEl,()=>showTab('statistics'));
  else if(tab==="ecosystem"&&ecosystemEl)mountEcosystem(ecosystemEl);
  settingsControls?.refresh();
}

function bindTabs(): void {
  if (root === undefined) return;
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-dion-tab]")) {
    button.addEventListener("click", () => {
      const tab = button.dataset.dionTab;
      if (tab === "plugins" || tab === "security" || tab === "statistics" || tab === "ecosystem" || tab === "performance") showTab(tab);
    });
  }
}

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    /* ── Security Center (Phase 11) ─────────────────────────────────────── */

    #${ROOT_ID} .dionsec-card {
      display: grid;
      gap: 10px;

      margin-bottom: 16px;
      padding: 16px 18px;

      border: 1px solid var(--dion-border);
      border-radius: 14px;

      background: var(--dion-surface);
    }

    #${ROOT_ID} .dionsec-card.is-danger {
      border-color: color-mix(in srgb, var(--status-danger, #f23f43) 32%, transparent);
    }

    #${ROOT_ID} .dionsec-card-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    #${ROOT_ID} .dionsec-card h3 {
      margin: 0;
      font-size: 14px;
      font-weight: 650;
      color: var(--header-primary, #f2f3f5);
    }

    #${ROOT_ID} .dionsec-badge {
      padding: 2px 8px;
      border-radius: 999px;
      background: var(--dion-surface-hover);
      color: var(--text-muted, #949ba4);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    #${ROOT_ID} .dionsec-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 7px 10px;
      border-radius: 9px;
      background: var(--dion-surface-hover);
      font-size: 12.5px;
    }

    #${ROOT_ID} .dionsec-row span { color: var(--text-muted, #949ba4); }

    #${ROOT_ID} .dionsec-pill {
      padding: 2px 9px;
      border: 1px solid transparent;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.04em;
    }
    #${ROOT_ID} .dionsec-pill.is-on {
      border-color: color-mix(in srgb, var(--status-positive, #23a55a) 32%, transparent);
      background: color-mix(in srgb, var(--status-positive, #23a55a) 13%, transparent);
      color: var(--status-positive, #23a55a);
    }
    #${ROOT_ID} .dionsec-pill.is-off {
      border-color: var(--dion-border);
      background: rgba(255, 255, 255, 0.03);
      color: var(--text-muted, #949ba4);
    }
    #${ROOT_ID} .dionsec-pill.is-bad {
      border-color: color-mix(in srgb, var(--status-danger, #f23f43) 36%, transparent);
      background: color-mix(in srgb, var(--status-danger, #f23f43) 13%, transparent);
      color: var(--status-danger, #f23f43);
    }

    #${ROOT_ID} .dionsec-note {
      margin: 0;
      color: var(--text-muted, #949ba4);
      font-size: 12px;
      line-height: 18px;
    }

    #${ROOT_ID} .dionsec-list,
    #${ROOT_ID} .dionsec-events {
      display: grid;
      gap: 6px;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    #${ROOT_ID} .dionsec-plugin,
    #${ROOT_ID} .dionsec-grant,
    #${ROOT_ID} .dionsec-event {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      border-radius: 9px;
      background: var(--dion-surface-hover);
      font-size: 12px;
    }

    #${ROOT_ID} .dionsec-plugin-name { font-weight: 600; }
    #${ROOT_ID} .dionsec-plugin-id {
      padding: 1px 6px;
      border-radius: 5px;
      background: rgba(0, 0, 0, 0.25);
      color: var(--text-muted, #949ba4);
      font-size: 11px;
    }
    #${ROOT_ID} .dionsec-plugin-perms,
    #${ROOT_ID} .dionsec-grant-cat,
    #${ROOT_ID} .dionsec-grant-plugin,
    #${ROOT_ID} .dionsec-grant-scope,
    #${ROOT_ID} .dionsec-grant-host {
      color: var(--text-muted, #949ba4);
    }
    #${ROOT_ID} .dionsec-grant-host { color: var(--header-primary, #f2f3f5); font-weight: 600; }

    #${ROOT_ID} .dionsec-event { flex-wrap: wrap; }
    #${ROOT_ID} .dionsec-event-time { color: var(--text-muted, #949ba4); font-variant-numeric: tabular-nums; }
    #${ROOT_ID} .dionsec-event-type {
      padding: 1px 6px;
      border-radius: 5px;
      background: rgba(255, 255, 255, 0.05);
      font-size: 10.5px;
      font-weight: 700;
    }
    #${ROOT_ID} .dionsec-event.is-warning .dionsec-event-type { color: #f0b232; }
    #${ROOT_ID} .dionsec-event.is-critical .dionsec-event-type { color: var(--status-danger, #f23f43); }
    #${ROOT_ID} .dionsec-event-reason { color: var(--header-primary, #f2f3f5); }
    #${ROOT_ID} .dionsec-event-meta { color: var(--text-muted, #949ba4); font-size: 11px; }

    #${ROOT_ID} .dionsec-btn {
      justify-self: start;
      min-height: 34px;
      padding: 0 14px;
      border: 1px solid var(--dion-border);
      border-radius: 9px;
      background: var(--dion-surface-hover);
      color: var(--text-normal, #dbdee1);
      font: inherit;
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
    }
    #${ROOT_ID} .dionsec-btn:hover { background: var(--dion-surface); }
    #${ROOT_ID} .dionsec-btn.is-danger {
      border-color: color-mix(in srgb, var(--status-danger, #f23f43) 45%, transparent);
      background: color-mix(in srgb, var(--status-danger, #f23f43) 16%, transparent);
      color: var(--status-danger, #f23f43);
    }
    #${ROOT_ID} .dionsec-btn:disabled { opacity: 0.6; cursor: default; }

    #${ROOT_ID} .dionsec-revoke {
      margin-left: auto;
      padding: 3px 9px;
      border: 1px solid var(--dion-border);
      border-radius: 7px;
      background: transparent;
      color: var(--text-muted, #949ba4);
      font: inherit;
      font-size: 11px;
      cursor: pointer;
    }
    #${ROOT_ID} .dionsec-revoke:hover { color: var(--status-danger, #f23f43); }

    #${ROOT_ID} .dionsec-pre {
      margin: 0;
      padding: 10px 12px;
      border-radius: 9px;
      background: rgba(0, 0, 0, 0.3);
      color: var(--text-muted, #949ba4);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11.5px;
      line-height: 17px;
      white-space: pre-wrap;
    }
    #${ROOT_ID} .dion-section-intro[hidden],
    #${ROOT_ID} .dion-update-card[hidden],
    #${ROOT_ID} [data-dion-count][hidden],
    #${ROOT_ID} .dion-sidebar-search[hidden] { display: none !important; }
    #${ROOT_ID} {
      --dion-bg: var(--background-base-low, var(--background-primary, #1a1a1e));
      --dion-bg-low: var(--background-base-lower, var(--background-secondary, #151518));
      --dion-bg-high: var(--background-base-high, #242429);
      --dion-surface: color-mix(in srgb, var(--background-base-high, #242429) 88%, transparent);
      --dion-surface-hover: color-mix(in srgb, var(--background-modifier-hover, #34343a) 78%, transparent);
      --dion-border: color-mix(in srgb, var(--border-subtle, #ffffff) 9%, transparent);
      --dion-border-strong: color-mix(in srgb, var(--border-strong, #ffffff) 16%, transparent);
      --dion-text: var(--text-default, var(--text-normal, #f2f3f5));
      --dion-muted: var(--text-muted, #a6a6ad);
      --dion-brand: var(--brand-500, #5865f2);
      --dion-danger: var(--text-danger, #f23f43);

      position: fixed;
      inset: 0;
      z-index: 100000;
      display: grid;
      place-items: center;
      padding: 22px;
      box-sizing: border-box;
      color: var(--dion-text);
      font-family: "gg sans", "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
      isolation: isolate;
    }

    #${ROOT_ID} *,
    #${ROOT_ID} *::before,
    #${ROOT_ID} *::after {
      box-sizing: border-box;
    }

    #${ROOT_ID} button,
    #${ROOT_ID} input {
      font: inherit;
    }

    #${ROOT_ID} .dion-backdrop {
      position: absolute;
      inset: 0;
      z-index: -1;
      background:
        radial-gradient(circle at 50% 38%, rgba(88, 101, 242, 0.08), transparent 34%),
        rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(7px) saturate(0.9);
      animation: dion-backdrop-in 150ms ease-out;
    }

    #${ROOT_ID} .dion-panel {
      width: min(1040px, 100%);
      height: min(760px, calc(100dvh - 44px));
      min-height: 560px;
      display: grid;
      grid-template-columns: 258px minmax(0, 1fr);
      overflow: hidden;
      border: 1px solid var(--dion-border-strong);
      border-radius: 22px;
      background: var(--dion-bg);
      box-shadow:
        0 30px 80px rgba(0, 0, 0, 0.52),
        0 10px 30px rgba(0, 0, 0, 0.24),
        inset 0 1px 0 rgba(255, 255, 255, 0.025);
      animation: dion-panel-in 180ms cubic-bezier(.2,.8,.2,1);
    }

    #${ROOT_ID} .dion-sidebar {
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
      padding: 16px 12px 12px;
      border-right: 1px solid var(--dion-border);
      background:
        linear-gradient(180deg, rgba(255,255,255,.018), transparent 28%),
        var(--dion-bg-low);
    }

    #${ROOT_ID} .dion-sidebar-head {
      padding: 3px 5px 12px;
    }

    #${ROOT_ID} .dion-brand-lockup {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    #${ROOT_ID} .dion-logo-shell {
      width: 38px;
      height: 38px;
      flex: 0 0 38px;
      display: grid;
      place-items: center;
      overflow: hidden;
      border: 1px solid var(--dion-border);
      border-radius: 12px;
      background: color-mix(in srgb, var(--dion-brand) 12%, var(--dion-bg-high));
      box-shadow: inset 0 1px 0 rgba(255,255,255,.05);
    }

    #${ROOT_ID} .dion-logo-shell img {
      width: 30px;
      height: 30px;
      display: block;
      object-fit: contain;
    }

    #${ROOT_ID} .dion-brand-copy {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    #${ROOT_ID} .dion-brand-line {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    #${ROOT_ID} .dion-brand-line strong {
      overflow: hidden;
      color: var(--dion-text);
      font-size: 14px;
      font-weight: 650;
      line-height: 18px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #${ROOT_ID} .dion-brand-line span {
      flex-shrink: 0;
      padding: 1px 5px;
      border: 1px solid var(--dion-border);
      border-radius: 999px;
      color: var(--dion-muted);
      background: rgba(255,255,255,.025);
      font-size: 9px;
      font-weight: 650;
      line-height: 14px;
    }

    /* ── Auto-update (Phase 20) ───────────────────────────────────────────── */

    #${ROOT_ID} .dion-update-slot {
      min-width: 0;
      display: none;
      padding: 0 2px 12px;
    }

    #${ROOT_ID} .dion-update-slot:has(.dion-update-btn:not([hidden])) {
      display: flex;
    }

    #${ROOT_ID} .dion-update-btn {
      min-width: 0;
      width: 100%;
      min-height: 34px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;

      padding: 8px 10px;
      border: 1px solid color-mix(in srgb, var(--dion-brand) 46%, transparent);
      border-radius: 10px;

      background: color-mix(in srgb, var(--dion-brand) 15%, transparent);
      color: color-mix(in srgb, var(--dion-brand) 72%, var(--dion-text));

      font-size: 12px;
      font-weight: 650;
      line-height: 16px;
      text-align: center;

      cursor: pointer;
      white-space: normal;
      transition: background-color 120ms ease, border-color 120ms ease, filter 120ms ease;
    }

    #${ROOT_ID} .dion-update-btn svg {
      flex: 0 0 13px;
    }

    #${ROOT_ID} [data-dion-update-label] {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    #${ROOT_ID} .dion-update-btn[hidden] {
      display: none;
    }

    #${ROOT_ID} .dion-update-btn:hover {
      background: color-mix(in srgb, var(--dion-brand) 24%, transparent);
      border-color: color-mix(in srgb, var(--dion-brand) 66%, transparent);
    }

    #${ROOT_ID} .dion-update-btn:focus-visible {
      outline: 2px solid var(--dion-brand);
      outline-offset: 2px;
    }

    #${ROOT_ID} .dion-update-card {
      display: grid;
      gap: 6px;

      margin-bottom: 18px;
      padding: 12px 14px;

      border: 1px solid var(--dion-border);
      border-radius: 12px;

      background: color-mix(in srgb, var(--dion-bg-high) 55%, transparent);
    }

    #${ROOT_ID} .dion-update-card .dion-setting-row {
      padding: 0;
      border: 0;
      background: transparent;
    }

    #${ROOT_ID} .dion-update-status,
    #${ROOT_ID} .dion-update-injector {
      margin: 0;
      padding-left: 2px;
      color: var(--dion-muted);
      font-size: 11px;
      line-height: 1.4;
    }

    #${ROOT_ID} .dion-update-status:empty,
    #${ROOT_ID} .dion-update-injector:empty {
      display: none;
    }

    #${ROOT_ID} .dion-brand-copy small,
    #${ROOT_ID} .dion-nav-copy small,
    #${ROOT_ID} .dion-reload small {
      color: var(--dion-muted);
      font-size: 11px;
      line-height: 14px;
    }

    #${ROOT_ID} .dion-sidebar-search {
      padding: 0 2px 14px;
    }

    #${ROOT_ID} .dion-search {
      height: 36px;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 9px;
      border: 1px solid var(--dion-border);
      border-radius: 10px;
      background: color-mix(in srgb, var(--dion-bg-high) 74%, transparent);
      color: var(--dion-muted);
      transition: border-color 120ms ease, background-color 120ms ease, box-shadow 120ms ease;
    }

    #${ROOT_ID} .dion-search:focus-within {
      border-color: color-mix(in srgb, var(--dion-brand) 65%, transparent);
      background: var(--dion-bg-high);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--dion-brand) 14%, transparent);
    }

    #${ROOT_ID} .dion-search input {
      min-width: 0;
      width: 100%;
      height: 100%;
      padding: 0;
      border: 0;
      outline: 0;
      background: transparent;
      color: var(--dion-text);
      font-size: 13px;
    }

    #${ROOT_ID} .dion-search input::placeholder {
      color: color-mix(in srgb, var(--dion-muted) 82%, transparent);
    }

    #${ROOT_ID} .dion-search input:focus,
    #${ROOT_ID} .dion-search input:focus-visible {
      outline: none;
      outline-offset: 0;
      box-shadow: none;
    }

    #${ROOT_ID} .dion-search input::-webkit-search-cancel-button {
      display: none;
    }

    #${ROOT_ID} .dion-search button {
      width: 22px;
      height: 22px;
      flex: 0 0 22px;
      display: grid;
      place-items: center;
      padding: 0;
      border: 0;
      border-radius: 7px;
      background: rgba(255,255,255,.04);
      color: var(--dion-muted);
      cursor: pointer;
    }

    #${ROOT_ID} .dion-search button:hover {
      color: var(--dion-text);
      background: rgba(255,255,255,.08);
    }

    #${ROOT_ID} .dion-search button[hidden] {
      display: none;
    }

    #${ROOT_ID} .dion-nav {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }

    #${ROOT_ID} .dion-nav-heading,
    #${ROOT_ID} .dion-subsection-label {
      padding: 0 8px;
      color: color-mix(in srgb, var(--dion-muted) 90%, transparent);
      font-size: 10px;
      font-weight: 700;
      line-height: 18px;
      letter-spacing: .035em;
      text-transform: uppercase;
    }

    #${ROOT_ID} .dion-nav-item {
      width: 100%;
      min-height: 50px;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 7px 9px;
      border: 1px solid transparent;
      border-radius: 11px;
      background: transparent;
      color: var(--dion-muted);
      text-align: left;
      cursor: default;
    }

    #${ROOT_ID} .dion-nav-item.is-active {
      border-color: var(--dion-border);
      background:
        linear-gradient(180deg, rgba(255,255,255,.028), rgba(255,255,255,.01)),
        color-mix(in srgb, var(--dion-brand) 10%, transparent);
      color: var(--dion-text);
      box-shadow: inset 3px 0 0 color-mix(in srgb, var(--dion-brand) 88%, white 12%);
    }

    #${ROOT_ID} .dion-nav-icon,
    #${ROOT_ID} .dion-reload-icon {
      width: 30px;
      height: 30px;
      flex: 0 0 30px;
      display: grid;
      place-items: center;
      border-radius: 9px;
      color: color-mix(in srgb, var(--dion-brand) 82%, white 18%);
      background: color-mix(in srgb, var(--dion-brand) 14%, transparent);
    }

    #${ROOT_ID} .dion-nav-copy,
    #${ROOT_ID} .dion-reload > span:last-child {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    #${ROOT_ID} .dion-nav-copy strong,
    #${ROOT_ID} .dion-reload strong {
      color: var(--dion-text);
      font-size: 13px;
      font-weight: 600;
      line-height: 17px;
    }

    #${ROOT_ID} .dion-sidebar-spacer {
      flex: 1;
    }

    #${ROOT_ID} .dion-sidebar-footer {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 12px 2px 0;
      border-top: 1px solid var(--dion-border);
    }

    #${ROOT_ID} .dion-reload {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 8px;
      border: 0;
      border-radius: 10px;
      background: transparent;
      color: var(--dion-muted);
      text-align: left;
      cursor: pointer;
      transition: background-color 120ms ease;
    }

    #${ROOT_ID} .dion-reload:hover {
      background: rgba(255,255,255,.045);
    }

    #${ROOT_ID} .dion-reload-icon {
      color: var(--dion-muted);
      background: rgba(255,255,255,.045);
    }

    #${ROOT_ID} .dion-shortcut {
      display: flex;
      align-items: center;
      gap: 3px;
      padding: 0 7px 2px;
      color: color-mix(in srgb, var(--dion-muted) 80%, transparent);
      font-size: 9px;
      line-height: 14px;
      user-select: none;
    }

    #${ROOT_ID} .dion-shortcut > span:first-child {
      margin-right: auto;
    }

    #${ROOT_ID} kbd {
      min-width: 18px;
      padding: 1px 4px;
      border: 1px solid var(--dion-border);
      border-radius: 5px;
      background: rgba(255,255,255,.035);
      color: var(--dion-muted);
      font-family: inherit;
      font-size: 9px;
      font-weight: 650;
      line-height: 15px;
      text-align: center;
      box-shadow: inset 0 -1px rgba(0,0,0,.25);
    }

    #${ROOT_ID} .dion-main {
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
      background:
        radial-gradient(circle at 90% -10%, rgba(88,101,242,.055), transparent 28%),
        var(--dion-bg);
    }

    #${ROOT_ID} .dion-main-head {
      min-height: 96px;
      flex-shrink: 0;
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 20px;
      padding: 22px 26px 17px;
    }

    #${ROOT_ID} .dion-page-heading {
      min-width: 0;
    }

    #${ROOT_ID} .dion-eyebrow {
      display: inline-block;
      color: color-mix(in srgb, var(--dion-brand) 78%, white 22%);
      font-size: 10px;
      font-weight: 700;
      line-height: 14px;
      letter-spacing: .045em;
      text-transform: uppercase;
    }

    #${ROOT_ID} .dion-page-heading h2 {
      margin: 2px 0 0;
      color: var(--dion-text);
      font-size: 22px;
      font-weight: 680;
      line-height: 28px;
      letter-spacing: -.025em;
    }

    #${ROOT_ID} .dion-page-heading p {
      margin: 3px 0 0;
      color: var(--dion-muted);
      font-size: 13px;
      line-height: 18px;
    }

    #${ROOT_ID} .dion-head-actions {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    #${ROOT_ID} .dion-count,
    #${ROOT_ID} .dion-section-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 24px;
      padding: 2px 8px;
      border: 1px solid var(--dion-border);
      border-radius: 999px;
      background: rgba(255,255,255,.025);
      color: var(--dion-muted);
      font-size: 10px;
      font-weight: 600;
      line-height: 15px;
      white-space: nowrap;
    }

    #${ROOT_ID} .dion-close,
    #${ROOT_ID} .dion-icon-btn {
      display: inline-grid;
      place-items: center;
      flex-shrink: 0;
      padding: 0;
      border: 1px solid var(--dion-border);
      background: rgba(255,255,255,.025);
      color: var(--dion-muted);
      cursor: pointer;
      transition: color 120ms ease, border-color 120ms ease, background-color 120ms ease, transform 120ms ease;
    }

    #${ROOT_ID} .dion-close {
      width: 34px;
      height: 34px;
      border-radius: 11px;
    }

    #${ROOT_ID} .dion-icon-btn {
      width: 30px;
      height: 30px;
      border-radius: 9px;
    }

    #${ROOT_ID} .dion-close:hover,
    #${ROOT_ID} .dion-icon-btn:hover {
      border-color: var(--dion-border-strong);
      background: rgba(255,255,255,.06);
      color: var(--dion-text);
    }

    #${ROOT_ID} .dion-close:active,
    #${ROOT_ID} .dion-icon-btn:active {
      transform: scale(.96);
    }

    #${ROOT_ID} .dion-main-divider {
      height: 1px;
      flex-shrink: 0;
      margin: 0 26px;
      background: var(--dion-border);
    }

    #${ROOT_ID} .dion-content-scroll {
      min-height: 0;
      flex: 1;
      overflow-x: hidden;
      overflow-y: auto;
      padding: 20px 26px 28px;
      overscroll-behavior: contain;
      scrollbar-gutter: stable;
    }

    #${ROOT_ID} .dion-content-scroll::-webkit-scrollbar {
      width: 10px;
    }

    #${ROOT_ID} .dion-content-scroll::-webkit-scrollbar-track {
      background: transparent;
    }

    #${ROOT_ID} .dion-content-scroll::-webkit-scrollbar-thumb {
      min-height: 44px;
      border: 3px solid transparent;
      border-radius: 999px;
      background: color-mix(in srgb, var(--dion-muted) 42%, transparent);
      background-clip: padding-box;
    }

    #${ROOT_ID} .dion-section-intro {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 10px;
      padding: 0 2px;
    }

    #${ROOT_ID} .dion-section-intro h3,
    #${ROOT_ID} .dion-details-head h4 {
      margin: 0;
      color: var(--dion-text);
      font-size: 14px;
      font-weight: 620;
      line-height: 19px;
    }

    #${ROOT_ID} .dion-section-intro p {
      margin: 2px 0 0;
      color: var(--dion-muted);
      font-size: 12px;
      line-height: 17px;
    }

    #${ROOT_ID} .dion-plugin-surface,
    #${ROOT_ID} .dion-settings-group,
    #${ROOT_ID} .dion-inline-panel {
      overflow: hidden;
      border: 1px solid var(--dion-border);
      border-radius: 15px;
      background:
        linear-gradient(180deg, rgba(255,255,255,.018), transparent 70%),
        color-mix(in srgb, var(--dion-bg-high) 82%, transparent);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.018);
    }

    #${ROOT_ID} .dion-plugin {
      position: relative;
      border-bottom: 1px solid var(--dion-border);
    }

    #${ROOT_ID} .dion-plugin:last-child {
      border-bottom: 0;
    }

    #${ROOT_ID} .dion-row {
      position: relative;
      width: 100%;
      min-height: 74px;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 13px;
      border: 0;
      background: transparent;
      cursor: pointer;
      transition: background-color 120ms ease;
    }

    #${ROOT_ID} .dion-row:hover {
      background: var(--dion-surface-hover);
    }

    #${ROOT_ID} .dion-plugin-glyph {
      width: 38px;
      height: 38px;
      flex: 0 0 38px;
      display: grid;
      place-items: center;
      border: 1px solid var(--dion-border);
      border-radius: 12px;
      background: rgba(255,255,255,.035);
      color: color-mix(in srgb, var(--dion-text) 72%, var(--dion-muted));
      box-shadow: inset 0 1px 0 rgba(255,255,255,.025);
    }

    #${ROOT_ID} .dion-meta {
      min-width: 0;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    #${ROOT_ID} .dion-name-line {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 7px;
    }

    #${ROOT_ID} .dion-name {
      min-width: 0;
      overflow: hidden;
      color: var(--dion-text);
      font-size: 14px;
      font-weight: 610;
      line-height: 18px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #${ROOT_ID} .dion-pill {
      height: 19px;
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 0 6px;
      border-radius: 999px;
      font-size: 9px;
      font-weight: 700;
      line-height: 19px;
    }

    #${ROOT_ID} .dion-pill::before {
      content: "";
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: currentColor;
      box-shadow: 0 0 8px currentColor;
    }

    #${ROOT_ID} .dion-pill.is-on {
      color: var(--text-positive, #43b581);
      background: color-mix(in srgb, var(--text-positive, #43b581) 12%, transparent);
    }

    #${ROOT_ID} .dion-pill.is-idle {
      color: var(--text-warning, #f0b232);
      background: color-mix(in srgb, var(--text-warning, #f0b232) 11%, transparent);
    }

    #${ROOT_ID} .dion-pill.is-off {
      color: var(--dion-muted);
      background: rgba(255,255,255,.035);
    }

    #${ROOT_ID} .dion-desc {
      width: 100%;
      max-width: 650px;
      max-height: 17px;
      overflow: hidden;
      color: var(--dion-muted);
      font-size: 12px;
      line-height: 17px;
      text-overflow: ellipsis;
      white-space: nowrap;
      transition: max-height 180ms cubic-bezier(.2,.8,.2,1), color 120ms ease;
    }

    #${ROOT_ID} .dion-row:hover .dion-desc,
    #${ROOT_ID} .dion-row:focus-within .dion-desc {
      max-height: 85px;
      overflow: visible;
      color: color-mix(in srgb, var(--dion-text) 78%, var(--dion-muted));
      text-overflow: clip;
      white-space: normal;
    }

    #${ROOT_ID} .dion-author {
      color: color-mix(in srgb, var(--dion-muted) 72%, transparent);
      font-size: 10px;
      line-height: 14px;
    }

    #${ROOT_ID} .dion-row-actions {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 7px;
      padding-left: 4px;
    }

    #${ROOT_ID} .dion-switch {
      position: relative;
      width: 38px;
      height: 22px;
      flex: 0 0 38px;
    }

    #${ROOT_ID} .dion-switch input {
      position: absolute;
      inset: 0;
      z-index: 2;
      width: 100%;
      height: 100%;
      margin: 0;
      opacity: 0;
      cursor: pointer;
    }

    #${ROOT_ID} .dion-track {
      position: relative;
      display: block;
      width: 38px;
      height: 22px;
      border: 1px solid color-mix(in srgb, var(--dion-muted) 30%, transparent);
      border-radius: 999px;
      background: color-mix(in srgb, var(--dion-muted) 27%, transparent);
      pointer-events: none;
      transition: background-color 140ms ease, border-color 140ms ease;
    }

    #${ROOT_ID} .dion-track::after {
      content: "";
      position: absolute;
      top: 3px;
      left: 3px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 3px rgba(0,0,0,.35);
      transition: transform 160ms cubic-bezier(.2,.8,.2,1);
    }

    #${ROOT_ID} .dion-switch input:checked + .dion-track {
      border-color: color-mix(in srgb, var(--status-positive, #43b581) 78%, white 5%);
      background: var(--status-positive, #43b581);
    }

    #${ROOT_ID} .dion-switch input:checked + .dion-track::after {
      transform: translateX(16px);
    }

    #${ROOT_ID} .dion-switch input:focus-visible + .dion-track {
      outline: 2px solid color-mix(in srgb, var(--dion-brand) 75%, white 10%);
      outline-offset: 2px;
    }

    #${ROOT_ID} .dion-ua-selected, #${ROOT_ID} .dion-ua-choice {
      display: flex; align-items: center; gap: 10px; min-width: 0;
    }
    #${ROOT_ID} .dion-ua-list-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
    #${ROOT_ID} .dion-ua-list-head [data-dion-ua-clear] { width: auto; padding-inline: 10px; white-space: nowrap; }
    #${ROOT_ID} .dion-ua-list-head [hidden] { display: none; }
    #${ROOT_ID} .dion-ua-selected-list { max-height: 240px; overflow-y: auto; margin: 8px 0 12px; }
    #${ROOT_ID} .dion-ua-selected { margin: 6px 0; }
    #${ROOT_ID} .dion-ua-selected .dion-ua-user-copy { flex: 1; }
    #${ROOT_ID} .dion-ua-selected button { flex-shrink: 0; }
    #${ROOT_ID} .dion-ua-avatar { width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0; object-fit: cover; }
    #${ROOT_ID} .dion-ua-initial { display: grid; place-items: center; background: var(--background-modifier-accent); }
    #${ROOT_ID} .dion-ua-user-copy { display: flex; flex-direction: column; min-width: 0; }
    #${ROOT_ID} .dion-ua-user-copy strong, #${ROOT_ID} .dion-ua-user-copy small {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    #${ROOT_ID} .dion-ua-user-copy small { color: var(--text-muted); font-size: 12px; }
    #${ROOT_ID} .dion-ua-search-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
    #${ROOT_ID} .dion-ua-search-row input {
      flex: 1 1 160px; min-width: 0; border-radius: 8px; padding: 10px;
      background: var(--input-background, var(--background-secondary)); color: var(--text-normal); border: 1px solid var(--border-subtle);
    }
    #${ROOT_ID} .dion-ua-results { max-height: 240px; overflow-y: auto; margin-top: 8px; }
    #${ROOT_ID} .dion-ua-results[hidden] { display: none; }
    #${ROOT_ID} .dion-ua-choice {
      width: 100%; padding: 8px; border: 0; border-radius: 8px; text-align: left;
      background: transparent; color: var(--text-normal); cursor: pointer;
    }
    #${ROOT_ID} .dion-ua-choice:hover, #${ROOT_ID} .dion-ua-choice:focus-visible { background: var(--background-modifier-hover); }
    #${ROOT_ID} .dion-ua-options > .dion-setting-desc { margin-block: 8px; overflow-wrap: anywhere; }
    #${ROOT_ID} .dion-ua-options .dion-field-row { flex-wrap: wrap; }
    #${ROOT_ID} .dion-ua-options .dion-field-row input { width: 100px; max-width: 100%; min-width: 0; box-sizing: border-box; }


    #${ROOT_ID} .dion-plugin-details {
      display: none;
      padding: 4px 13px 15px 63px;
    }

    #${ROOT_ID} .dion-plugin.is-open .dion-plugin-details {
      display: block;
    }

    #${ROOT_ID} .dion-details-head {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 12px;
      margin: 2px 1px 9px;
    }

    #${ROOT_ID} .dion-details-head h4 {
      margin-top: 1px;
    }

    #${ROOT_ID} .dion-details-note {
      color: color-mix(in srgb, var(--dion-muted) 72%, transparent);
      font-size: 10px;
      line-height: 14px;
      white-space: nowrap;
    }

    #${ROOT_ID} .dion-settings-group {
      border-radius: 12px;
      background: color-mix(in srgb, var(--dion-bg-low) 72%, transparent);
    }

    #${ROOT_ID} .dion-setting-row,
    #${ROOT_ID} .dion-field-row {
      min-height: 54px;
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 9px 11px;
      border-bottom: 1px solid var(--dion-border);
    }

    #${ROOT_ID} .dion-setting-row {
      cursor: pointer;
    }

    #${ROOT_ID} .dion-setting-row:last-child,
    #${ROOT_ID} .dion-field-row:last-child {
      border-bottom: 0;
    }

    #${ROOT_ID} .dion-setting-copy,
    #${ROOT_ID} .dion-field-copy {
      min-width: 0;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    #${ROOT_ID} .dion-setting-title {
      color: var(--dion-text);
      font-size: 12px;
      font-weight: 590;
      line-height: 16px;
    }

    #${ROOT_ID} .dion-setting-desc,
    #${ROOT_ID} .dion-setting-status:not(:empty),
    #${ROOT_ID} .dion-inline-copy > span:last-child {
      color: var(--dion-muted);
      font-size: 11px;
      line-height: 15px;
    }

    #${ROOT_ID} .dion-field-row input,
    #${ROOT_ID} .dion-limit-controls input {
      height: 32px;
      border: 1px solid var(--dion-border);
      border-radius: 9px;
      outline: 0;
      background: color-mix(in srgb, var(--dion-bg) 80%, black 5%);
      color: var(--dion-text);
      font-size: 12px;
      transition: border-color 120ms ease, box-shadow 120ms ease;
    }

    #${ROOT_ID} .dion-field-row input {
      width: min(260px, 44%);
      padding: 0 9px;
    }

    #${ROOT_ID} .dion-limit-controls {
      display: flex;
      align-items: center;
      gap: 7px;
    }

    #${ROOT_ID} .dion-limit-controls input {
      width: 90px;
      padding: 0 8px;
    }

    /*
     * Auto-claim key field.
     *
     * Its own row, deliberately not the shared field row. That row is a flex
     * line whose input is capped at 44% beside a copy block, and a credential
     * field plus two buttons did not fit in it — the field was crushed to the
     * width of a number spinner and the buttons overlapped each other.
     */
    #${ROOT_ID} .dion-quest-key-block {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 8px;
      padding: 11px;
      border-bottom: 1px solid var(--dion-border);
    }

    #${ROOT_ID} .dion-quest-key-controls {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    #${ROOT_ID} .dion-quest-key-controls input {
      /* Width is not the shared 44% cap: the point of this row is that the
         field takes whatever is left after the two buttons. */
      flex: 1 1 220px;
      width: auto;
      min-width: 0;
      height: 32px;
      padding: 0 10px;
      border: 1px solid var(--dion-border);
      border-radius: 9px;
      outline: 0;
      background: color-mix(in srgb, var(--dion-bg) 80%, black 5%);
      color: var(--dion-text);
      font-size: 12px;
      font-family: inherit;
    }

    #${ROOT_ID} .dion-quest-key-controls input:focus {
      border-color: color-mix(in srgb, var(--dion-brand) 64%, transparent);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--dion-brand) 12%, transparent);
    }

    #${ROOT_ID} .dion-quest-key-btn {
      flex: 0 0 auto;
      height: 32px;
      padding: 0 13px;
      border: 1px solid var(--dion-border);
      border-radius: 9px;
      background: var(--dion-bg);
      color: var(--dion-text);
      font: inherit;
      font-size: 12px;
      font-weight: 590;
      cursor: pointer;
      white-space: nowrap;
    }

    #${ROOT_ID} .dion-quest-key-btn:hover {
      background: color-mix(in srgb, var(--dion-bg) 82%, white 8%);
    }

    #${ROOT_ID} .dion-quest-key-btn:focus-visible {
      outline: 2px solid var(--dion-brand);
      outline-offset: 2px;
    }

    #${ROOT_ID} .dion-setting-status.is-error {
      color: var(--dion-danger);
    }

    #${ROOT_ID} .dion-field-row input:focus,
    #${ROOT_ID} .dion-limit-controls input:focus {
      border-color: color-mix(in srgb, var(--dion-brand) 64%, transparent);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--dion-brand) 12%, transparent);
    }

    /*
     * Selects.
     *
     * A native select cannot be themed: the closed control keeps the platform's
     * own background, font and arrow, which is a bright white box in a dark
     * panel. Dropping "appearance" and drawing the arrow here makes the control
     * match the text inputs beside it. The option popup itself is drawn by the
     * OS and stays unstyled, because no page CSS can reach it.
     */
    #${ROOT_ID} .dion-select-wrap {
      position: relative;
      display: inline-flex;
      flex: 0 0 auto;
      width: min(260px, 44%);
    }

    /*
     * A select used *without* the wrapper.
     *
     * \`.dion-select\` below is \`width: 100%\` because it is meant to fill a
     * \`.dion-select-wrap\`. As a direct flex child that 100% becomes its flex
     * basis, and since the copy beside it has \`flex-basis: 0\`, the description
     * is starved to a few pixels wide and wraps one word per line while the
     * select takes the entire row. The wrapper is the supported way to use it;
     * this is the floor, so that forgetting the wrapper costs alignment rather
     * than a panel a thousand pixels tall.
     */
    #${ROOT_ID} .dion-setting-row > .dion-select,
    #${ROOT_ID} .dion-field-row > .dion-select {
      flex: 0 0 auto;
      width: min(260px, 44%);
    }

    #${ROOT_ID} .dion-select {
      width: 100%;
      text-overflow: ellipsis;
    }

    #${ROOT_ID} .dion-subsection-label {
      padding: 12px 3px 5px;
    }

    #${ROOT_ID} .dion-inline-panel {
      margin: 0 13px 14px 63px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      padding: 10px 11px;
      border-radius: 12px;
      background: color-mix(in srgb, var(--dion-bg-low) 70%, transparent);
    }

    #${ROOT_ID} .dion-plugin-details .dion-quest-actions {
      margin: 0;
    }

    #${ROOT_ID} .dion-inline-copy {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    #${ROOT_ID} .dion-inline-copy > span:last-child {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #${ROOT_ID} .dion-primary-btn {
      min-height: 31px;
      flex-shrink: 0;
      padding: 2px 13px;
      border: 0;
      border-radius: 9px;
      background: var(--dion-brand);
      color: #fff;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.12);
      transition: filter 120ms ease, transform 120ms ease;
    }

    #${ROOT_ID} .dion-primary-btn:hover:not(:disabled) {
      filter: brightness(1.08);
    }

    #${ROOT_ID} .dion-primary-btn:active:not(:disabled) {
      transform: scale(.97);
    }

    #${ROOT_ID} .dion-primary-btn:disabled {
      opacity: .45;
      cursor: not-allowed;
    }

    #${ROOT_ID} .dion-recorder-panel .dion-details-head {
      align-items: center;
      flex-wrap: wrap;
    }

    #${ROOT_ID} .dion-recorder-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 14px;
    }

    #${ROOT_ID} .dion-recorder-panel .dion-primary-btn {
      min-height: 34px;
      max-width: 100%;
      flex-shrink: 1;
      padding: 7px 12px;
      line-height: 18px;
      white-space: normal;
      overflow-wrap: anywhere;
    }

    #${ROOT_ID} .dion-recorder-panel .dion-recorder-secondary {
      border: 1px solid var(--dion-border);
      background: var(--dion-bg-high);
      color: var(--dion-text);
    }

    #${ROOT_ID} .dion-recorder-panel .dion-primary-btn:focus-visible {
      outline: 2px solid var(--focus-primary, var(--dion-brand));
      outline-offset: 2px;
    }

    #${ROOT_ID} .dion-recorder-panel [data-recorder-toggle].is-recording {
      background: var(--status-danger, #d83c3e);
      color: #fff;
    }

    #${ROOT_ID} .dion-empty {
      min-height: 280px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 30px;
      text-align: center;
    }

    #${ROOT_ID} .dion-empty-icon {
      width: 46px;
      height: 46px;
      display: grid;
      place-items: center;
      margin-bottom: 10px;
      border: 1px solid var(--dion-border);
      border-radius: 14px;
      background: rgba(255,255,255,.03);
      color: var(--dion-muted);
    }

    #${ROOT_ID} .dion-empty-title {
      margin: 0;
      color: var(--dion-text);
      font-size: 14px;
      font-weight: 620;
      line-height: 19px;
    }

    #${ROOT_ID} .dion-empty-sub {
      margin: 3px 0 0;
      color: var(--dion-muted);
      font-size: 12px;
      line-height: 17px;
    }

    #${ROOT_ID} button:focus-visible,
    #${ROOT_ID} input:focus-visible {
      outline: 2px solid color-mix(in srgb, var(--dion-brand) 75%, white 10%);
      outline-offset: 2px;
    }

    ${GAME_CSS}
    ${SPOOFER_CSS}
    ${VIRTUAL_PANEL_CSS}
    @keyframes dion-backdrop-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes dion-panel-in {
      from {
        opacity: 0;
        transform: translateY(8px) scale(.985);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    @media (max-width: 820px) {
      #${ROOT_ID} {
        padding: 12px;
      }

      #${ROOT_ID} .dion-panel {
        height: calc(100dvh - 24px);
        min-height: 0;
        grid-template-columns: 218px minmax(0, 1fr);
        border-radius: 18px;
      }

      #${ROOT_ID} .dion-main-head,
      #${ROOT_ID} .dion-content-scroll {
        padding-left: 20px;
        padding-right: 20px;
      }

      #${ROOT_ID} .dion-main-divider {
        margin-inline: 20px;
      }

      #${ROOT_ID} .dion-plugin-details {
        padding-left: 13px;
      }

      #${ROOT_ID} .dion-inline-panel {
        margin-left: 13px;
      }

      #${ROOT_ID} .dion-field-row {
        align-items: flex-start;
        flex-direction: column;
        gap: 7px;
      }

      #${ROOT_ID} .dion-field-row input {
        width: 100%;
      }

      /*
       * The update channel is a \`.dion-setting-row\`, so the stacking above did
       * not reach it: on a narrow window the channel select kept the full row
       * and pushed the description into a sliver beside it. It has to stack with
       * the field rows or the narrow layout has a hole in it exactly where the
       * new controls are.
       */
      #${ROOT_ID} .dion-update-channel {
        align-items: flex-start;
        flex-direction: column;
        gap: 7px;
      }

      #${ROOT_ID} .dion-update-channel .dion-select-wrap {
        width: 100%;
      }
    }

    @media (max-width: 650px) {
      #${ROOT_ID} {
        padding: 0;
      }

      #${ROOT_ID} .dion-panel {
        width: 100vw;
        height: 100dvh;
        grid-template-columns: 1fr;
        grid-template-rows: auto minmax(0, 1fr);
        border: 0;
        border-radius: 0;
      }

      #${ROOT_ID} .dion-sidebar {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        grid-template-areas:
          "brand nav"
          "search search";
        gap: 10px;
        padding: 11px 14px 10px;
        border-right: 0;
        border-bottom: 1px solid var(--dion-border);
      }

      /* Keep the update action out of the brand/nav row; no empty row when hidden. */
      #${ROOT_ID} .dion-sidebar:has(.dion-update-btn:not([hidden])) {
        grid-template-areas:
          "brand nav"
          "update update"
          "search search";
      }

      #${ROOT_ID} .dion-sidebar-head {
        grid-area: brand;
        padding: 0;
      }

      #${ROOT_ID} .dion-update-slot {
        grid-area: update;
        padding: 0;
      }

      #${ROOT_ID} .dion-sidebar-search {
        grid-area: search;
        padding: 0;
      }

      #${ROOT_ID} .dion-nav {
        grid-area: nav;
        justify-content: center;
      }

      #${ROOT_ID} .dion-nav-heading,
      #${ROOT_ID} .dion-nav-copy small,
      #${ROOT_ID} .dion-sidebar-spacer,
      #${ROOT_ID} .dion-sidebar-footer {
        display: none;
      }

      #${ROOT_ID} .dion-nav-item {
        width: auto;
        min-height: 38px;
        padding: 4px 8px;
      }

      #${ROOT_ID} .dion-nav-icon {
        width: 28px;
        height: 28px;
        flex-basis: 28px;
      }

      #${ROOT_ID} .dion-brand-copy small {
        display: none;
      }

      #${ROOT_ID} .dion-main-head {
        min-height: 84px;
        padding: 17px 16px 13px;
      }

      #${ROOT_ID} .dion-main-divider {
        margin-inline: 16px;
      }

      #${ROOT_ID} .dion-content-scroll {
        padding: 16px 16px 22px;
      }

      #${ROOT_ID} .dion-page-heading h2 {
        font-size: 20px;
      }

      #${ROOT_ID} .dion-page-heading p,
      #${ROOT_ID} .dion-count {
        display: none;
      }

      #${ROOT_ID} .dion-row {
        gap: 10px;
        padding-inline: 10px;
      }

      #${ROOT_ID} .dion-plugin-glyph {
        width: 34px;
        height: 34px;
        flex-basis: 34px;
      }

      #${ROOT_ID} .dion-desc {
        max-height: 34px;
        white-space: normal;
        text-overflow: clip;
      }

      #${ROOT_ID} .dion-author {
        display: none;
      }

      #${ROOT_ID} .dion-plugin-details {
        padding: 2px 10px 13px;
      }

      #${ROOT_ID} .dion-inline-panel {
        margin: 0 10px 13px;
      }

      #${ROOT_ID} .dion-details-note {
        display: none;
      }
    }

    @media (max-width: 430px) {
      #${ROOT_ID} .dion-logo-shell {
        width: 34px;
        height: 34px;
        flex-basis: 34px;
      }

      #${ROOT_ID} .dion-brand-line span,
      #${ROOT_ID} .dion-nav-copy strong {
        display: none;
      }

      #${ROOT_ID} .dion-row-actions {
        gap: 5px;
      }

      #${ROOT_ID} .dion-icon-btn {
        width: 28px;
        height: 28px;
      }

      #${ROOT_ID} .dion-setting-row {
        gap: 10px;
      }

      #${ROOT_ID} .dion-limit-row {
        align-items: flex-start;
        flex-direction: column;
      }

      #${ROOT_ID} .dion-limit-controls {
        width: 100%;
      }

      #${ROOT_ID} .dion-limit-controls input {
        flex: 1;
        width: auto;
      }
    }

    @media (hover: none) {
      #${ROOT_ID} .dion-desc {
        max-height: 51px;
        white-space: normal;
        text-overflow: clip;
      }
    }

    @media (max-height: 590px) and (min-width: 651px) {
      #${ROOT_ID} {
        padding: 10px;
      }

      #${ROOT_ID} .dion-panel {
        height: calc(100dvh - 20px);
        min-height: 0;
      }

      #${ROOT_ID} .dion-main-head {
        min-height: 76px;
        padding-top: 15px;
      }

      #${ROOT_ID} .dion-page-heading p {
        display: none;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      #${ROOT_ID} .dion-backdrop,
      #${ROOT_ID} .dion-panel,
      #${ROOT_ID} .dion-plugin-details {
        animation: none;
      }

      #${ROOT_ID} .dion-row,
      #${ROOT_ID} .dion-desc,
      #${ROOT_ID} .dion-track,
      #${ROOT_ID} .dion-track::after,
      #${ROOT_ID} .dion-expand svg,
      #${ROOT_ID} .dion-close,
      #${ROOT_ID} .dion-icon-btn,
      #${ROOT_ID} .dion-primary-btn {
        transition: none;
      }
    }
  ${SETTINGS_CONTROLS_CSS}
  `;

  document.documentElement.appendChild(style);
}

export function openSettings(tab?:SettingsTab): void {
  if (open && root) {
    if(tab){showTab(tab);return;}
    renderList();
    root.querySelector<HTMLInputElement>("[data-dion-search]")?.focus();
    return;
  }

  ensureStyles();

  root = document.createElement("div");
  root.id = ROOT_ID;
  settingsControls=bindSettingsControls(root);
  document.documentElement.appendChild(root);

  open = true;
  mount();
  if(tab)showTab(tab);
  disposeLocale = onLocaleChange(() => {
    paintQuestActions();
    if (root) {
      if(query.trim()) preserveInputs(root,renderList);
      else {const count=root.querySelector<HTMLElement>("[data-dion-count]");if(count)count.textContent=countText(list().length,list().length,"");}
    }
  });
  log.info("settings opened");
}

export function closeSettings(): void {
  disposeQuestUi?.();disposeQuestUi=undefined;
  bulkActions?.dispose();bulkActions=undefined;
  if (!open || !root) return;
  disposePerformancePanel?.();disposePerformancePanel=undefined;
  settingsControls?.dispose();settingsControls=undefined;
  disposeDropPanel?.();disposeDropPanel=undefined;
  disposeScheduledPanelChange?.();disposeScheduledPanelChange=undefined;
  disposeLocale?.(); disposeLocale = undefined;
  unmountStatistics();
  unmountEcosystem();
  unmountSecurityCenter();

  disposeActivityPanel?.();
  disposeActivityPanel = undefined;
  disposeRecorderPanel?.();
  disposeRecorderPanel = undefined;
  disposeBadgesPanel?.();disposeBadgesPanel=undefined;
  disposePlatformsPanel?.();disposePlatformsPanel=undefined;
  disposeSpooferPanel?.();disposeSpooferPanel=undefined;
  disposeVirtualPanel?.();disposeVirtualPanel=undefined;
  disposeLongPanel?.();disposeLongPanel=undefined;
  disposeGamePanel?.();disposeGamePanel=undefined;
  disposeExperimentsPanel?.();disposeExperimentsPanel=undefined;
  disposeSpotifyPanel?.();disposeSpotifyPanel=undefined;
  disposeHiddenItemsPanel?.();disposeHiddenItemsPanel=undefined;
  disposeRelationshipPanel?.();disposeRelationshipPanel=undefined;
  disposeImageZoomPanel?.();disposeImageZoomPanel=undefined;
  disposeSmartUploadPanel?.();disposeSmartUploadPanel=undefined;
  root.remove();
  root = undefined;
  open = false;
  query = "";
  loggerOpen = false;
  sessionRestoreOpen = false;
  autoQuestsOpen = false;
  // Drops the update status subscription. Without this, every open/close cycle
  // would leave one listener behind, each holding a reference to a panel that
  // no longer exists.
  disposeUpdateUi();
}

export function toggleSettings(): void {
  if (open) closeSettings();
  else openSettings();
}

/** Bind global shortcut Ctrl/⌘+Shift+D */
export function installSettingsShortcut(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.code !== "KeyD" || !e.shiftKey) return;
    if (!(e.metaKey || e.ctrlKey)) return;

    e.preventDefault();
    toggleSettings();
  };

  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}

/** Remember last-open preference (optional). */
export function wasSettingsOpen(): boolean {
  return settings.get<boolean>("ui.settingsOpen", false) === true;
}
