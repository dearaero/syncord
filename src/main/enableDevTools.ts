import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

import { LOG_PREFIX } from "../shared/constants";
import { securityLog } from "./security/core";

export const DEVTOOLS_KEY =
  "DANGEROUS_ENABLE_DEVTOOLS_ONLY_ENABLE_IF_YOU_KNOW_WHAT_YOURE_DOING";

type AppSettings = {
  set: (key: string, value: unknown) => void;
  get?: (key: string) => unknown;
};

function settingsFile(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

function onceDefined(
  target: object,
  property: string,
  callback: (value: unknown) => void,
): void {
  if (Object.prototype.hasOwnProperty.call(target, property)) {
    callback(Reflect.get(target, property));
    return;
  }

  Object.defineProperty(target, property, {
    configurable: true,
    enumerable: false,
    set(value: unknown) {
      delete (target as Record<string, unknown>)[property];
      Reflect.set(target, property, value);
      callback(value);
    },
  });
}

/**
 * DevTools is intentionally enabled for Syncord development/debugging.
 *
 * Discord Stable hides the shortcut behind this setting, so we force the flag
 * both on disk and through Discord's runtime appSettings object. The previous
 * security hardening tied this to Syncord Developer Mode; that made normal
 * debugging impossible and is intentionally removed.
 */
export function devToolsAllowed(): boolean {
  return true;
}

function patchSettingsFile(): void {
  const file = settingsFile();

  try {
    let data: Record<string, unknown> = {};
    if (fs.existsSync(file)) {
      data = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<
        string,
        unknown
      >;
    }

    if (data[DEVTOOLS_KEY] === true) {
      console.log(`${LOG_PREFIX} DevTools opt-in already present`);
      return;
    }

    data[DEVTOOLS_KEY] = true;
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    console.log(`${LOG_PREFIX} DevTools enabled in settings.json`);
    securityLog().record({
      type: "DEVTOOLS_TOGGLED",
      reason: "devtools enabled for Syncord debugging",
    });
  } catch (err) {
    console.warn(`${LOG_PREFIX} Could not patch settings.json:`, err);
  }
}

function forceAppSettingsFlag(settings: AppSettings): void {
  try {
    settings.set(DEVTOOLS_KEY, true);
    console.log(`${LOG_PREFIX} DevTools enabled via appSettings`);
  } catch (err) {
    console.warn(`${LOG_PREFIX} appSettings.set failed:`, err);
  }
}

/**
 * Stable hides DevTools behind a settings flag. Enable it in both places Discord
 * reads from:
 * 1) settings.json on disk
 * 2) global appSettings when Discord creates it
 *
 * The keyboard shortcut itself is bound in patchBrowserWindow.ts.
 */
export function enableDevTools(): void {
  patchSettingsFile();

  const root = global as typeof global & { appSettings?: AppSettings };

  onceDefined(root, "appSettings", (value) => {
    forceAppSettingsFlag(value as AppSettings);
  });
}
