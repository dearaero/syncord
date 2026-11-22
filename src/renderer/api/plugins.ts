/** @deprecated Import from `./plugin` instead. */
export {
  definePlugin,
  definePluginSettings,
  startAll,
  stopAll,
  enable,
  disable,
  get,
  list,
  scheduleStartAll,
  plugins,
} from "./plugin";
export type {
  PluginDefinition,
  PluginContext,
  PluginMeta,
  PluginPublicInfo,
  Disposable,
  SettingDef,
  SettingsSchema,
} from "./plugin";
