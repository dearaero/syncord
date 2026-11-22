import {installStatistics} from "./statistics";
import { app } from "electron";
import { installCrashPrivacy, privacyStatus } from "./security/privacy";
import fs from "node:fs";
import path from "node:path";

import { LOG_PREFIX, ORIGINAL_PRELOAD_ENV } from "../shared/constants";
import { BOOT_LOG_NAME, bootLog, initBootLog } from "../shared/bootLog";
import { enableDevTools } from "./enableDevTools";
import { registerIpc } from "./ipc";
import { patchBrowserWindow, injectionReport } from "./patchBrowserWindow";
import { loadCredentials } from "./security/credentials";
import { attachAuditFile } from "./security/auditLog";
import { verifyIntegrity } from "./security/integrity";
import { securityLog } from "./security/core";
import { evaluateStartupMode } from "./security/modes";
import { installSessionGuards, watchForNewContents } from "./security/session";

// A trace of the boot chain, on disk, before anything else can fail.
//
// Discord launched from Finder has no stdout, Electron's renderer console is
// invisible from a shell, and macOS TCC stops a terminal from reading Discord's
// own container. Without a file next to the injected bundle, "Syncord did not
// load" has no evidence attached to it at all.
const bootLogPaths = [
  path.join(__dirname, BOOT_LOG_NAME),
  path.join(require("node:os").tmpdir(), BOOT_LOG_NAME),
];
initBootLog(bootLogPaths);

console.log(`${LOG_PREFIX} Main process starting`);
bootLog("main process starting");

// Phase 12/13: evaluate Safe Mode / Lockdown / Developer Mode *before* anything
// else reads them. These flags gate window creation, the DevTools opt-in and
// the plugin list, so they have to be settled before Discord is required.
installCrashPrivacy();
bootLog(`core privacy startup: ${JSON.stringify(privacyStatus(false))}`);

const startupMode = evaluateStartupMode();

// Phase 12: attach the rotating file sink to the in-memory event log. Security
// events should survive a restart; "the client was attacked last night" is not
// a question to answer from memory.
attachAuditFile(securityLog());

// Phase 18: verify our own bundles before we run any of them. Pure fs + crypto,
// so it is safe here — unlike anything touching `session`.
verifyIntegrity();

// Phase 15: read Syncord's own credentials into the main process. They are
// never written to disk, never sent over IPC, and never enter the renderer
// bundle — the broker attaches them per request.
loadCredentials();

// Where we are running from. This is the load-bearing assumption of the whole
// injection: Syncord's `main.js` is Electron's app entry, and Discord's
// `app.asar` / `_app.asar` live in the directory that contains it.
//
// `app.getAppPath()` is the primary source because Electron guarantees it.
// `require.main.filename` looks equivalent and is not: measured on Electron 44 it
// is the **string** `"electron"`, not a path, so deriving the resources directory
// from it silently produces `.` and a useless search. It is kept only as a
// fallback for a hypothetical launcher that sets neither.
const appPathReported = (() => {
  try {
    return app.getAppPath();
  } catch {
    return "";
  }
})();

const injectorDir =
  appPathReported.length > 0
    ? appPathReported
    : path.dirname(require.main?.filename ?? __filename);
const resourcesDir = path.dirname(path.resolve(injectorDir));

const asarPath = ["_app.asar", "app.asar"]
  .map((name) => path.join(resourcesDir, name))
  .find((candidate) => fs.existsSync(candidate));

if (!asarPath) {
  console.error(
    `${LOG_PREFIX} Discord asar not found.\n` +
      `                app.getAppPath():       ${appPathReported}\n` +
      `                require.main.filename: ${require.main?.filename}\n` +
      `                __dirname:              ${__dirname}\n` +
      `                resources dir searched: ${resourcesDir}\n` +
      `                expected one of:        ${path.join(resourcesDir, "_app.asar")}, ${path.join(resourcesDir, "app.asar")}\n` +
      `                Run: pnpm inject`,
  );
  app.exit(1);
  process.exit(1);
}

const discordPkg = require(path.join(asarPath, "package.json")) as {
  main: string;
};

require.main!.filename = path.join(asarPath, discordPkg.main);
// Untyped in recent Electron typings; still required so Discord resolves assets.
(app as Electron.App & { setAppPath(p: string): void }).setAppPath(asarPath);

patchBrowserWindow();
enableDevTools();
registerIpc();
installStatistics();

bootLog(
  `asar=${asarPath} appPath=${appPathReported} resourcesDir=${resourcesDir} ` +
    `originalPreloadEnv=${process.env[ORIGINAL_PRELOAD_ENV] ?? "(unset)"}`,
);

// The single most important thing to be able to answer after a failed launch:
// did the injection engage at all? A window that was never patched produces no
// error anywhere — Discord just starts without Syncord.
//
// This is deliberately *not* done inside `whenReady`. Our ready handler is
// registered before Discord's, so at that point Discord has not created a single
// window yet and `patchedWindows` is always 0 — a warning there is a guaranteed
// false alarm. It fires after the first `browser-window-created` instead, with a
// short settle delay so a batch of windows is counted as a batch, and a timeout
// fallback for the case where no window is ever created.
let injectionSummaryLogged = false;

function logInjectionReport(reason: string): void {
  if (injectionSummaryLogged) return;
  injectionSummaryLogged = true;

  const report = injectionReport();
  const file = path.join(app.getPath("userData"), "Syncord", "injection.json");
  const summary =
    `patch=${report.patchInstalledVia ?? "FAILED"} ` +
    `patched=${report.patchedWindows} skipped=${report.skippedWindows} ` +
    `rejected=${report.preloadRejections}`;
  console.log(`${LOG_PREFIX} Injection report (${reason}): ${summary} → ${file}`);
  bootLog(`Injection report (${reason}): ${summary}`);

  if (report.patchedWindows === 0) {
    // If the preload never reached a window, the preload's own log is the next
    // place to look — say so rather than leaving the reader to guess.
    bootLog(`no window patched; preload log: ${bootLogPaths[0]}`);
  }

  if (report.patchedWindows === 0) {
    console.error(
      `${LOG_PREFIX} No Discord window was patched — Syncord will not load.\n` +
        `                Windows seen: ${JSON.stringify(report.windows)}\n` +
        `                Full report: ${file}`,
    );
  }
}

app.on("browser-window-created", () => {
  // Let the rest of Discord's window batch land before counting.
  setTimeout(() => logInjectionReport("first window"), 1500);
});

app.whenReady().then(() => {
  setTimeout(() => logInjectionReport("no window created within 10s"), 10_000);
});

// Phase 5 + 8: the session-layer egress guard and the default-deny permission
// handlers.
//
// Both are registered through `onAppReady` because `session.defaultSession`
// throws `Session can only be received when app is ready` before the `ready`
// event — and this code runs before Discord is required, so it is *definitely*
// before ready. Calling the installers directly here is what crashed the client
// on Discord 0.0.413.
//
// `whenReady` was registered before Discord's own, so these run first. The
// `web-contents-created` hook in `watchForNewContents` covers the case where a
// Discord build creates its window before `ready`.
installSessionGuards();
watchForNewContents();

console.log(
  `${LOG_PREFIX} Loading Discord from ${asarPath}` +
    (startupMode.safeMode ? " [SAFE MODE]" : "") +
    (startupMode.lockdown ? " [LOCKDOWN]" : "") +
    (startupMode.developerMode ? " [DEV]" : ""),
);
require(require.main!.filename);

// Phase 12: a last-resort flush, so events recorded during a hard exit are not
// lost. `before-quit` is the only hook that reliably runs on quit and crash.
app.on("before-quit", () => {
  try {
    securityLog().record({ type: "INTEGRITY_OK", reason: "session shutting down" });
  } catch {
    /* nothing useful to do at this point */
  }
});
