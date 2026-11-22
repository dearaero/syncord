import { isDiscordRestApi } from "./rest";
import {
  type ModuleRef,
  resolveFilter,
  resolveProps,
} from "./resolve";

export type CommonUtils = {
  RestAPI: ModuleRef;
  SnowflakeUtils: ModuleRef;
  Parser: ModuleRef;
  Alerts: ModuleRef;
  IconUtils: ModuleRef;
  NavigationRouter: ModuleRef;
  SettingsRouter: ModuleRef;
  MessageCache: ModuleRef;
  UsernameUtils: ModuleRef;
  PermissionsBits: ModuleRef;
  DraftType: ModuleRef;
  MessageTypeSets: ModuleRef;
  lodash: ModuleRef;
  moment: ModuleRef;
};

export function resolveUtils(): CommonUtils {
  return {
    // The API base-URL helper is a separate export in current Discord builds.
    RestAPI: resolveFilter("utils.RestAPI", isDiscordRestApi),
    SnowflakeUtils: resolveProps(
      "utils.SnowflakeUtils",
      "fromTimestamp",
      "extractTimestamp",
    ),
    Parser: resolveProps("utils.Parser", "parseTopic"),
    Alerts: resolveProps("utils.Alerts", "show", "close"),
    IconUtils: resolveProps(
      "utils.IconUtils",
      "getGuildBannerURL",
      "getUserAvatarURL",
    ),
    NavigationRouter: resolveProps(
      "utils.NavigationRouter",
      "transitionTo",
      "back",
      "forward",
    ),
    SettingsRouter: resolveProps(
      "utils.SettingsRouter",
      "openUserSettings",
      "USER_SETTINGS_MODAL_KEY",
    ),
    MessageCache: resolveProps(
      "utils.MessageCache",
      "clearCache",
      "_channelMessages",
    ),
    UsernameUtils: resolveProps(
      "utils.UsernameUtils",
      "useName",
      "getGlobalName",
    ),
    PermissionsBits: resolveFilter(
      "utils.PermissionsBits",
      (m) =>
        typeof m === "object" &&
        m != null &&
        typeof (m as { ADMINISTRATOR?: unknown }).ADMINISTRATOR === "bigint",
    ),
    DraftType: resolveProps(
      "utils.DraftType",
      "ChannelMessage",
      "SlashCommand",
    ),
    MessageTypeSets: resolveProps(
      "utils.MessageTypeSets",
      "REPLYABLE",
      "FORWARDABLE",
    ),
    lodash: resolveProps("utils.lodash", "debounce", "cloneDeep"),
    moment: resolveProps("utils.moment", "parseTwoDigitYear"),
  };
}
