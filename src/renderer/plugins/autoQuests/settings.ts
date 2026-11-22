import { t as i18nText } from "../../i18n";
import { definePluginSettings } from "../../api/plugin/settingsDef";

/**
 * Auto-claim settings.
 *
 * Only the switch lives here. The NoneCap API key is **not** a plugin setting:
 * plugin settings are plain JSON in the world-readable profile directory, and a
 * paid credential does not belong there. The key is stored in the OS keychain
 * by the main process and the renderer only ever learns whether one exists.
 */
export const AUTO_QUEST_SETTINGS_EVENT = "Syncord-auto-quests-settings";

export const autoQuestSettings = definePluginSettings({
  autoClaim: {
    type: "boolean",
    default: false,
    get title() { return i18nText("ui.automatically_claim_rewards"); },
    get description() { return i18nText("ui.claim_rewards_for_completed_quests_in_the_background_using_your_accoun"); },
  },
});