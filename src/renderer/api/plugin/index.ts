export type {
  Disposable,
  PluginContext,
  PluginDefinition,
  PluginMeta,
  PluginPublicInfo,
} from "./types";
export { assertPluginId } from "./types";
export {
  definePlugin,
  startAll,
  stopAll,
  enable,
  disable,
  get,
  list,
  scheduleStartAll,
  registerSecurityManifest,
  setSafeMode,
  isSafeModeActive,
  armLockdown,
  isLockdownActive,
  stopNonCore,
} from "./manager";
export {
  definePluginSettings,
  type SettingDef,
  type SettingsSchema,
  type PluginSettingsHandle,
} from "./settingsDef";

import {
  definePlugin,
  startAll,
  stopAll,
  enable,
  disable,
  get,
  list,
  scheduleStartAll,
  registerSecurityManifest,
  setSafeMode,
  isSafeModeActive,
  armLockdown,
  isLockdownActive,
  stopNonCore,
} from "./manager";
import { definePluginSettings } from "./settingsDef";

export const plugins = {
  definePlugin,
  definePluginSettings,
  startAll,
  stopAll,
  enable,
  disable,
  get,
  list,
  scheduleStartAll,
  registerSecurityManifest,
  setSafeMode,
  isSafeModeActive,
  armLockdown,
  isLockdownActive,
  stopNonCore,
};
