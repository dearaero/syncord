import electron, {
  type BrowserWindowConstructorOptions,
} from "electron";
import fs from "node:fs";
import path from "node:path";

import { ORIGINAL_PRELOAD_ENV, PRELOAD_BASES_ENV, LOG_PREFIX } from "../shared/constants";
import { bootLog } from "../shared/bootLog";
import { devToolsAllowed } from "./enableDevTools";
import { SyncordUserDataPath } from "./security/core";
import { allowedPreloadBases, reportPreloadRejection, reportUnknownPreloadName, validateOriginalPreload } from "./security/originalPreload";
import { installWindowGuards } from "./security/navigation";

/**
 * What happened to the injection, written to disk as well as the console.
 *
 * This exists because the failure mode of an injection that does not engage is
 * *invisible*: Discord starts normally and Syncord simply is not there. On
 * 0.0.413 that is exactly what happened, and it was invisible for as long as it
 * took to go looking. A one-line "did the patch engage?" file turns that class
 * of bug into a five-second check.
 */
type InjectionReport = {
  patchedWindows: number;
  skippedWindows: number;
  preloadRejections: number;
  windows: Array<{
    index: number;
    title: string | null;
    preload: string | null;
    action: "patched" | "skipped-no-preload" | "skipped-native-splash" | "rejected" | "already-ours";
  }>;
};

const report: InjectionReport = {
  patchedWindows: 0,
  skippedWindows: 0,
  preloadRejections: 0,
  windows: [],
};

let patchInstalledVia: string | null = null;

function writeReport(extra: Record<string, unknown> = {}): void {
  try {
    const file = path.join(SyncordUserDataPath(), "injection.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${JSON.stringify({ ...report, patchInstalledVia, ...extra }, null, 2)}\n`,
      "utf-8",
    );
  } catch {
    // Never let diagnostics be the reason the client misbehaves.
  }
}

/**
 * Intercept Discord window creation so our preload runs first,
 * then Discord's original preload (via env) can still load.
 *
 * Match windows by their validated preload rather than their title: Discord's
 * main window may have no title. The native splash is an exception; it loads
 * a local file and must retain its own preload to signal that startup is ready.
 * Our preload deliberately refuses file: origins, so replacing the splash's
 * preload would stop that handshake and prevent the main window from opening.
 */
export function patchBrowserWindow(): void {
  // Idempotent. A second call would wrap our own wrapper and swap our preload
  // out from under ourselves.
  if (patchInstalledVia !== null) return;

  class BrowserWindow extends electron.BrowserWindow {
    constructor(options: BrowserWindowConstructorOptions) {
      const prefs = options?.webPreferences;
      const candidate = typeof prefs?.preload === "string" ? prefs.preload : null;
      const index = report.windows.length;

      const record = (action: InjectionReport["windows"][number]["action"]) => {
        report.windows.push({
          index,
          title: typeof options?.title === "string" ? options.title : null,
          preload: candidate,
          action,
        });
        // One line per window decision. This is the log a person reads when
        // "Syncord did not load" and there is no other signal.
        bootLog(
          `window#${index} title=${JSON.stringify(typeof options?.title === "string" ? options.title : null)} ` +
            `preload=${candidate ?? "(none)"} action=${action}`,
        );
        writeReport();
      };

      if (candidate === null) {
        // No preload to chain onto. Not an error: Discord creates utility
        // windows without one.
        report.skippedWindows += 1;
        record("skipped-no-preload");
        super(options);
        return;
      }

      // Our own preload, if this window is somehow being re-created. Swapping it
      // again would break the chain, so leave it exactly as it is.
      if (candidate === path.join(__dirname, "preload.js")) {
        record("already-ours");
        super(options);
        return;
      }

      // ── Phase 1: validate Discord's original preload BEFORE we intervene ──
      //
      // The path arrives from Discord's own options, and it will later be
      // `require()`d in a Node-enabled realm. We only take over the window if
      // the path is provably Discord's own preload. If it is not, we decline:
      // Discord boots exactly as it would without Syncord, and the rejection
      // is recorded and logged with the path so it is diagnosable.
      //
      // Failing open here would mean loading an unvalidated path; failing closed
      // by refusing the window would mean Discord cannot start. Neither is
      // acceptable, so the third option is the one we take: leave the window
      // untouched.
      const verdict = validateOriginalPreload(candidate);
      if (!verdict.ok) {
        report.preloadRejections += 1;
        record("rejected");
        reportPreloadRejection(verdict.reason, "window", candidate);
        super(options);
        return;
      }

      if (verdict.basename === "splashScreenPreload") {
        // Preserve Discord's local startup bridge and its sandbox options.
        // This does not grant local pages access to SyncordNative: the splash
        // never receives our preload, and our origin gate stays unchanged.
        report.skippedWindows += 1;
        record("skipped-native-splash");
        super(options);
        return;
      }

      if (!verdict.knownName) {
        // Not a refusal — Discord names its preloads per window and per release,
        // and a hardcoded name list silently breaks the client the day it goes
        // stale. Recorded so the change is visible, not used to block.
        reportUnknownPreloadName(verdict.basename, verdict.path);
      }

      prefs!.preload = path.join(__dirname, "preload.js");
      // Needed so preload can use Node APIs (fs, require original preload).
      // Discord's own preload requires Node too, so this is not a regression we
      // introduce; Phase 24 documents the fuse/ASAR implications.
      prefs!.sandbox = false;
      // Keep Discord responsive while minimized / in background.
      prefs!.backgroundThrottling = false;

      process.env[ORIGINAL_PRELOAD_ENV] = verdict.path;
      // Hand the preload the base list we just validated against. A preload
      // cannot resolve `app` — it is main-process only — and on Discord 0.0.413
      // the main screen's preload lives in the user-data directory. Without
      // this, the preload refuses Discord's own preload and the main window runs
      // without it, which breaks voice/tray/spellcheck in a way that looks like a
      // Discord bug rather than ours.
      process.env[PRELOAD_BASES_ENV] = JSON.stringify(allowedPreloadBases());

      report.patchedWindows += 1;
      record("patched");

      super(options);

      // Phase 7: navigation, window-open and external-link guards. Installed on
      // every window we take over, before Discord can create a frame in it.
      installWindowGuards(this);
      attachRendererConsole(this);

      // Keep DevTools available in normal Syncord builds for debugging.
      // Support Electron's usual Windows/Linux shortcut, the macOS shortcut,
      // and Cmd+Shift+I because that is convenient when testing the client.
      this.webContents.on("before-input-event", (event, input) => {
        if (input.type !== "keyDown" || input.code !== "KeyI") return;

        const ctrlShift = input.control && input.shift;
        const cmdAlt = input.meta && input.alt;
        const cmdShift = input.meta && input.shift;
        if (!ctrlShift && !cmdAlt && !cmdShift) return;

        event.preventDefault();
        this.webContents.toggleDevTools();
      });
    }
  }

  // Preserve static members (getAllWindows, fromId, …).
  Object.assign(BrowserWindow, electron.BrowserWindow);
  // esbuild may rename the class; Electron matches on .name === "BrowserWindow".
  Object.defineProperty(BrowserWindow, "name", {
    value: "BrowserWindow",
    configurable: true,
  });

  patchInstalledVia = installPatchedClass(BrowserWindow);
  writeReport();

  if (patchInstalledVia === null) {
    // The one failure that must never be silent.
    const message =
      `FAILED to install the BrowserWindow patch — Syncord will not load. ` +
      `See ${path.join(SyncordUserDataPath(), "injection.json")}`;
    console.error(`${LOG_PREFIX}[security] ${message}`);
    bootLog(`[security] ${message}`);
  } else {
    const message = `BrowserWindow patch installed (${patchInstalledVia})`;
    console.log(`${LOG_PREFIX} ${message}`);
    bootLog(message);
  }
}

/**
 * Make `BrowserWindow` resolve to our subclass for every consumer.
 *
 * ## Why the whole module object is replaced
 *
 * Measured against Electron 44:
 * `Object.getOwnPropertyDescriptor(require("electron"), "BrowserWindow")` is
 *
 *     { get: true, set: false, configurable: false }
 *
 * `BrowserWindow` is a **getter-only, non-configurable** property. So
 * `electron.BrowserWindow = Patched` is a silent no-op in sloppy mode and a
 * TypeError in strict mode — neither of which installs anything. An earlier
 * revision of this file treated that in-place assignment as the primary
 * mechanism and consequently reported "FAILED to install the BrowserWindow
 * patch" on every launch, which is exactly what happened.
 *
 * Swapping `require.cache["electron"].exports` for a new object does work, and
 * it is verified against real Electron rather than assumed: after the swap, a
 * module that requires electron for the first time sees the patched class.
 * Spread copies all 42 own properties (measured: none lost, none
 * non-enumerable), and `ipcRenderer` / `contextBridge` / `webFrame` are
 * legitimately `undefined` in the main process.
 *
 * Ordering matters and is already correct: this runs before Discord's entry
 * point is required. A bundled `var electron_1 = __webpack_require__(...)`
 * resolves `require("electron")` at module-init time, i.e. after the swap.
 *
 * Returns a description of what worked, for the diagnostic report.
 */
function installPatchedClass(Patched: typeof electron.BrowserWindow): string | null {
  const mechanisms: string[] = [];

  // Primary: swap the cached module object. `require("electron")` is a builtin,
  // but it *is* present in `require.cache` — verified, not assumed.
  try {
    const key = require.resolve("electron");
    const cached = require.cache[key];
    if (cached !== undefined && cached.exports !== undefined) {
      // Spread the cache's own exports rather than our imported binding: esbuild's
      // ESM interop may hand us a *copy* of the module, and the cache entry is
      // the object Discord will actually receive.
      const next = { ...(cached.exports as object), BrowserWindow: Patched };
      delete cached.exports;
      cached.exports = next;
      mechanisms.push("require-cache");
    } else {
      mechanisms.push("no require-cache entry (builtin)");
    }
  } catch (err) {
    mechanisms.push(`require-cache failed: ${err instanceof Error ? err.message : "unknown"}`);
  }

  // Secondary: in-place assignment. A guaranteed no-op on Electron's getter-only
  // exports, which is why the success check below does not trust it. Kept for a
  // future Electron that makes the property writable, where it would be the
  // stronger mechanism.
  try {
    const live = require("electron") as { BrowserWindow: unknown };
    if (live.BrowserWindow !== Patched) {
      live.BrowserWindow = Patched;
      if (live.BrowserWindow === Patched) mechanisms.push("in-place");
    }
  } catch {
    /* getter-only, as expected */
  }

  // The check that matters, and the one that was wrong before: ask the module
  // loader, exactly the way Discord's bundle will.
  let live: { BrowserWindow: unknown };
  try {
    live = require("electron") as { BrowserWindow: unknown };
  } catch (err) {
    return `could not verify: ${err instanceof Error ? err.message : "unknown"}`;
  }
  if (live.BrowserWindow !== Patched) {
    console.error(
      `${LOG_PREFIX}[security] BrowserWindow patch did NOT take effect — ` +
        `electron.BrowserWindow is still ${typeof live.BrowserWindow}.`,
    );
    return null;
  }

  return mechanisms.join(" + ");
}

/** Exposed for the boot log and for tests. */
export function injectionReport(): InjectionReport & { patchInstalledVia: string | null } {
  return { ...report, patchInstalledVia };
}

/** Cap on mirrored console lines per window, so a chatty page cannot fill the disk. */
const CONSOLE_MIRROR_LIMIT = 400;

/**
 * Mirror the renderer's own console into the boot log.
 *
 * Diagnostic only — it records, it does not act. Without it the client is
 * opaque: the boot log can say `BOOT COMPLETE` while the window is black,
 * because a renderer's errors are invisible from a terminal and Discord's log
 * directory is unreadable under macOS TCC. This is the only view of what the
 * *page* thinks is happening.
 *
 * Only warnings, errors, and anything mentioning us are kept — Discord's own
 * verbose logging would otherwise bury the one line that matters. Bounded per
 * window, and redacted by `bootLog`.
 */
function attachRendererConsole(window: Electron.BrowserWindow): void {
  const contents = window.webContents;
  let seen = 0;

  contents.on("console-message", (_event, level, message, line, sourceId) => {
    if (seen >= CONSOLE_MIRROR_LIMIT) return;
    // level: 0 verbose, 1 info, 2 warning, 3 error
    const text = String(message ?? "");
    // Anything of ours is always kept, at any level: our own `[Syncord:…]`
    // lines are the narrative of the boot, and filtering them by severity is how
    // "titlebar button mounted" stayed invisible while the button was in fact
    // never mounting. Everything else is kept from warnings up, so Discord's own
    // verbose logging cannot bury the line that matters.
    const isOurs = text.includes(LOG_PREFIX) || text.includes("Syncord");
    if (!isOurs && level < 2) return;
    seen += 1;
    const levelName = ["verbose", "info", "warning", "error"][level] ?? String(level);
    const where = String(sourceId ?? "").split("/").slice(-1)[0];
    bootLog(`console(${levelName}) ${where}:${line} ${text.slice(0, 300)}`);
  });

  contents.on("render-process-gone", (_event, details) => {
    bootLog(`RENDERER GONE: ${JSON.stringify(details).slice(0, 200)}`);
  });
  contents.on("preload-error", (_event, preloadPath, error) => {
    bootLog(`PRELOAD ERROR ${preloadPath}: ${String(error).slice(0, 300)}`);
  });
  contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    bootLog(`did-fail-load ${code} ${description} ${String(url).slice(0, 200)} mainFrame=${isMainFrame}`);
  });
  contents.on("unresponsive", () => {
    bootLog("renderer UNRESPONSIVE");
  });
  contents.on("did-finish-load", () => {
    bootLog(`did-finish-load url=${contents.getURL().slice(0, 120)}`);
  });
}
