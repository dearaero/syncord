import type { SyncordNativeApi } from "../../shared/native";
import type { css } from "./css";
import type { when } from "./lifecycle";
import type { logger } from "./logger";
import type { patcher } from "./patcher";
import type { plugins } from "./plugin";
import type { settings } from "./settings";
import type { webpack } from "../webpack";
import type { toast } from "../ui/toast";
import type { CommonModules } from "../webpack/common";

export type SyncordApi = {
  version: string;
  logger: typeof logger;
  webpack: typeof webpack;
  patcher: typeof patcher;
  css: typeof css;
  plugins: typeof plugins;
  settings: typeof settings;
  /** Populated after webpack ready via initCommon(). */
  common: CommonModules | undefined;
  native: SyncordNativeApi | undefined;
  when: typeof when;
  /** Discord's toast. `toast.show("Copied")` from any plugin. */
  toast: typeof toast;
  /** Open the Syncord settings overlay. */
  openSettings: () => void;
  closeSettings: () => void;
  /** Full page reload (picks up synced dist after rebuild). */
  reload: () => void;
};
