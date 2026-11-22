import { t as i18nText } from "../../i18n";
import { definePlugin } from "../../api/plugin";
import { startActivity } from "./runtime";

export const UserActivityPlugin = definePlugin({
  id: "user-activity",
  name: i18nText("ui.user_activity"),
  get description() { return i18nText("ui.keep_a_local_history_of_selected_users_visible_discord_activity_and_sh"); },
  author: i18nText("ui.syncord"),
  enabledByDefault: false,
  permissions: {
    discordStores: ["user", "profile", "channel", "guild", "message", "typing", "voice-state", "presence", "permission", "relationship"],
    userData: true,
    media: true,
    webpackPatch: true,
    discordActions: ["guild-subscriptions"],
  },
  start: startActivity,
});
