import {createDropBridge} from './drop';
import {POPOUT_ARGUMENT,POPOUT_BASE_URL,POPOUT_IPC,type PopoutBridge,type ChatEvent} from "../shared/popoutChats";
import {bootstrapPopoutChats} from "./popoutChats";
import {supporterBridge} from "./supporter";
import {ECO_IPC,type EcosystemBridge} from "../shared/ecosystem";
import { contextBridge, ipcRenderer, webFrame } from "electron";
import {rendererMemory} from "./statistics";
import { RECORDING_ARGUMENT, RECORDING_IPC, RECORDING_ORIGIN, type RecordingBridge } from "../shared/recording";
import { CAPTCHA_IPC, type CaptchaBridge } from "../shared/captcha";
import { SNAPSHOT_IPC, type SnapshotBridge } from "../shared/snapshot";
import { bootstrapRecordingWindow } from "./recording";
import fs from "node:fs";
import path from "node:path";

import { IPC, LOG_PREFIX, ORIGINAL_PRELOAD_ENV, PRELOAD_BASES_ENV, VERSION } from "../shared/constants";
import { BOOT_LOG_NAME, bootLog, initBootLog } from "../shared/bootLog";
import { isTrustedDiscordOrigin } from "../security/origins";
import { canonicalizeWithRealpath, validateDiscordPreloadPath } from "../security/paths";
import type {
  SyncordBrokerPolicy,
  SyncordEgressReport,
  SyncordNativeApi,
  SyncordNetworkRequest,
  SyncordNetworkResponse,
  SyncordPermissionGrant,
  SyncordPermissionRequest,
  SyncordPermissionResult,
  SyncordPluginManifestEntry,
  SyncordSecurityEvent,
  SyncordSecurityStatus,
  SyncordInjectorLocation,
  SyncordUpdateStatus,
} from "../shared/native";

// The preload is a separate realm from main, so it needs its own writer. Same
// paths, so one file tells the whole story in order. This is the only place the
// chain can be observed from the renderer side at all: the browser's devtools
// console is not visible from a terminal, and Discord's container is unreadable
// under macOS TCC.
initBootLog([
  path.join(__dirname, BOOT_LOG_NAME),
  path.join(require("node:os").tmpdir(), BOOT_LOG_NAME),
]);

console.log(`${LOG_PREFIX} Preload loaded`);
bootLog(
  `preload loaded; location=${location.protocol}//${location.host || "?"} ` +
    `originalPreloadEnv=${process.env[ORIGINAL_PRELOAD_ENV] ?? "(unset)"} ` +
    `resourcesPath=${String(process.resourcesPath)}`,
);

/**
 * Whether this preload is running in a page we are willing to privilege.
 *
 * Evaluated once, from `location`, before anything is exposed. Every privileged
 * effect below is behind this single boolean:
 *
 *  - `contextBridge.exposeInMainWorld("SyncordNative", …)`
 *  - `webFrame.executeJavaScript(rendererCode)` (the whole plugin system)
 *  - loading Discord's original preload
 *
 * The gate is the trusted-origin predicate from `src/security/origins`, which is
 * an exact/suffix hostname match on `https://discord.com` and
 * `https://discordapp.com` — never a substring test. `data:`, `file:`, `blob:`,
 * plain `http:`, and any third-party https origin all fail it.
 *
 * Why it matters: Discord opens `data:`-URL popouts (Monaco, the popout view
 * template, screen-share pickers) and, on some flows, third-party embedded
 * frames. Preload scripts run in *every* frame of a webContents, so without this
 * gate any of those would receive the full main-process bridge.
 */
const isTrustedPage = isTrustedDiscordOrigin(location);
bootLog(
  `origin gate: trusted=${isTrustedPage} href=${location.href.slice(0, 200)}`,
);

// This local realm gets no Discord bridge or plugin injection. Worker IPC is
// authorized by exact main-owned webContents identity, never by this marker.
if (process.argv.includes(POPOUT_ARGUMENT) && location.href === POPOUT_BASE_URL+"/chat" && window.top === window) {
  bootstrapPopoutChats();
} else if (process.argv.includes(RECORDING_ARGUMENT) && location.origin === RECORDING_ORIGIN) {
  bootstrapRecordingWindow();
} else if (!isTrustedPage) {
  // Fail closed and stay quiet. An untrusted frame gets no bridge, no injection
  // and no plugin system; there is nothing for it to attack.
  console.log(
    `${LOG_PREFIX} Preload skipped for untrusted frame (${location.protocol}//${location.host || "?"})`,
  );
  bootLog(
    `preload skipped for untrusted frame (${location.protocol}//${location.host || "?"})`,
  );
} else {
  bootstrapTrustedPage();
}

function bootstrapTrustedPage(): void {
  /**
   * The privileged surface. Each function is a thin, named IPC call — there is
   * no generic "send to channel X" and no generic "fetch this URL". Adding a
   * capability means adding a function here *and* a validated handler in
   * `src/main/ipc.ts`, which is the review point.
   */
  const security = {
    /** Register the plugin/permission manifest. Called once, at renderer boot. */
    registerManifest: (entries: SyncordPluginManifestEntry[]): Promise<{ accepted: number }> =>
      ipcRenderer.invoke(IPC.SECURITY_MANIFEST, entries) as Promise<{ accepted: number }>,

    /** Permissioned, SSRF-checked, rate-limited, size-bounded network request. */
    requestNetwork: (req: SyncordNetworkRequest): Promise<SyncordNetworkResponse> =>
      ipcRenderer.invoke(IPC.NETWORK_REQUEST, req) as Promise<SyncordNetworkResponse>,

    status: (): Promise<SyncordSecurityStatus> =>
      ipcRenderer.invoke(IPC.SECURITY_STATUS) as Promise<SyncordSecurityStatus>,

    events: (limit: number): Promise<SyncordSecurityEvent[]> =>
      ipcRenderer.invoke(IPC.SECURITY_EVENTS, limit) as Promise<SyncordSecurityEvent[]>,

    policy: (): Promise<SyncordBrokerPolicy> =>
      ipcRenderer.invoke(IPC.SECURITY_POLICY) as Promise<SyncordBrokerPolicy>,

    permissions: (): Promise<SyncordPermissionGrant[]> =>
      ipcRenderer.invoke(IPC.SECURITY_PERMISSIONS) as Promise<SyncordPermissionGrant[]>,

    grant: (req: SyncordPermissionRequest): Promise<SyncordPermissionResult> =>
      ipcRenderer.invoke(IPC.SECURITY_GRANT, req) as Promise<SyncordPermissionResult>,

    revoke: (key: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.SECURITY_REVOKE, key) as Promise<boolean>,

    /**
     * Report a refused direct-egress attempt.
     *
     * Fixed shape, no free-form payload: the main process slices every field
     * and records only a transport name, a hostname and a short reason. A
     * compromised page can fabricate events — that is a noisy log, not an
     * exfiltration path.
     */
    reportEgress: (report: SyncordEgressReport): Promise<void> =>
      ipcRenderer.invoke(IPC.REPORT_EGRESS, report) as Promise<void>,

    /** One-way for the session: once armed, page code cannot disarm it. */
    lockdown: (): Promise<{ locked: boolean }> =>
      ipcRenderer.invoke(IPC.SECURITY_LOCKDOWN) as Promise<{ locked: boolean }>,

    /** Leave Safe Mode. Turning Safe Mode *on* is a startup switch, not IPC. */
    setSafeMode: (enabled: boolean): Promise<{ safeMode: boolean }> =>
      ipcRenderer.invoke(IPC.SECURITY_SAFE_MODE, enabled) as Promise<{ safeMode: boolean }>,

    /**
     * Append one line to the boot log, via the main process.
     *
     * The renderer is a browser realm: no `fs`, and a console nobody can read
     * from a terminal. This is the only way its part of the boot chain becomes
     * observable. One short string, sliced and redacted in main.
     */
    bootLog: (line: string): Promise<void> =>
      ipcRenderer.invoke(IPC.BOOT_LOG, String(line).slice(0, 500)) as Promise<void>,
  };

  /**
   * Auto-update. A sibling of `security`, not a member of it, and gated by the
   * same trusted-origin boolean that gates this whole function.
   *
   * Nothing here accepts a URL or a destination path. `handOff` takes the
   * absolute path of the installer the *user* configured; main validates that it
   * is an existing regular file and spawns it with `shell: false`. The
   * renderer therefore cannot name a host to fetch from, and cannot name a
   * process to run.
   */
  const updates = {
    check: (channel: string): Promise<SyncordUpdateStatus> =>
      ipcRenderer.invoke(IPC.UPDATE_CHECK, String(channel).slice(0, 16)) as Promise<SyncordUpdateStatus>,

    status: (): Promise<SyncordUpdateStatus> =>
      ipcRenderer.invoke(IPC.UPDATE_STATUS) as Promise<SyncordUpdateStatus>,

    restart: (): Promise<boolean> => ipcRenderer.invoke(IPC.UPDATE_RESTART) as Promise<boolean>,
    stage: (): Promise<SyncordUpdateStatus> =>
      ipcRenderer.invoke(IPC.UPDATE_STAGE) as Promise<SyncordUpdateStatus>,

    // The path is optional. When it is absent, main discovers the installer
    // itself from a fixed list of read-only candidates, so a renderer that
    // passes nothing still gets a working hand-off. A value that *is* passed
    // is only ever the user's own configured path: main validates it is an
    // existing regular file, and it is spawned with `shell: false` and an
    // argument vector. The renderer therefore still cannot name a process to
    // run, and cannot name a host to fetch from.
    handOff: (injectorPath?: string): Promise<SyncordUpdateStatus> =>
      ipcRenderer.invoke(
        IPC.UPDATE_HANDOFF,
        typeof injectorPath === "string" ? injectorPath.slice(0, 4096) : "",
      ) as Promise<SyncordUpdateStatus>,

    reset: (): Promise<SyncordUpdateStatus> =>
      ipcRenderer.invoke(IPC.UPDATE_RESET) as Promise<SyncordUpdateStatus>,

    injector: (): Promise<SyncordInjectorLocation> =>
      ipcRenderer.invoke(IPC.UPDATE_INJECTOR) as Promise<SyncordInjectorLocation>,
  };

  const recording: RecordingBridge = {
    setLocale: locale => ipcRenderer.invoke(RECORDING_IPC.LOCALE, locale),
    devices: () => ipcRenderer.invoke(RECORDING_IPC.DEVICES),
    start: options => ipcRenderer.invoke(RECORDING_IPC.START, options),
    stop: release => ipcRenderer.invoke(RECORDING_IPC.STOP, release === true),
    status: () => ipcRenderer.invoke(RECORDING_IPC.STATUS),
    list: before => ipcRenderer.invoke(RECORDING_IPC.LIST, before),
    play: id => ipcRenderer.invoke(RECORDING_IPC.PLAY, id),
    readPlayback: (token, offset) => ipcRenderer.invoke(RECORDING_IPC.PLAYBACK_READ, token, offset),
    closePlayback: token => ipcRenderer.invoke(RECORDING_IPC.PLAYBACK_CLOSE, token),
    reveal: id => ipcRenderer.invoke(RECORDING_IPC.REVEAL, id),
  };

  /**
   * Captcha solving.
   *
   * Five named operations, no URL, no headers, no method list — the shape of
   * the request is decided in main. `setKey` forwards a secret to main, which is
   * the whole point of the channel existing in the privileged realm at all: the
   * key is never stored in the page.
   */
  const captcha: CaptchaBridge = {
    status: () => ipcRenderer.invoke(CAPTCHA_IPC.STATUS),
    setKey: key => ipcRenderer.invoke(CAPTCHA_IPC.SET_KEY, String(key ?? "").slice(0, 256)),
    clearKey: () => ipcRenderer.invoke(CAPTCHA_IPC.CLEAR_KEY),
    solve: input => ipcRenderer.invoke(CAPTCHA_IPC.SOLVE, input),
    feedback: input => ipcRenderer.invoke(CAPTCHA_IPC.FEEDBACK, input),
  };

  const ecosystem:EcosystemBridge={supporter:supporterBridge((channel,...args)=>ipcRenderer.invoke(channel,...args)),status:account=>ipcRenderer.invoke(ECO_IPC.STATUS,account),link:account=>ipcRenderer.invoke(ECO_IPC.LINK,account),poll:account=>ipcRenderer.invoke(ECO_IPC.POLL,account),profile:account=>ipcRenderer.invoke(ECO_IPC.PROFILE,account),catalog:()=>ipcRenderer.invoke(ECO_IPC.CATALOG),art:image=>ipcRenderer.invoke(ECO_IPC.ART,image),buy:(account,badge,key,price)=>ipcRenderer.invoke(ECO_IPC.BUY,account,badge,key,price),activate:(account,ids)=>ipcRenderer.invoke(ECO_IPC.ACTIVE,account,ids),history:(account,before)=>ipcRenderer.invoke(ECO_IPC.HISTORY,account,before),lookup:ids=>ipcRenderer.invoke(ECO_IPC.LOOKUP,ids),disconnect:account=>ipcRenderer.invoke(ECO_IPC.DISCONNECT,account)};
  const popoutChats:PopoutBridge={
    connect:account=>ipcRenderer.invoke(POPOUT_IPC.CONNECT,account),
    open:(session,id,bounds)=>ipcRenderer.invoke(POPOUT_IPC.OPEN,session,id,bounds),
    stop:session=>ipcRenderer.invoke(POPOUT_IPC.STOP,session),
    publish:(session,id,state)=>ipcRenderer.invoke(POPOUT_IPC.PUBLISH,session,id,state),
    subscribe:listener=>{const callback=(_event:unknown,value:ChatEvent)=>listener(value);ipcRenderer.on(POPOUT_IPC.EVENT,callback);return()=>ipcRenderer.removeListener(POPOUT_IPC.EVENT,callback);},
  };
  const snapshot: SnapshotBridge = { copy: rect => ipcRenderer.invoke(SNAPSHOT_IPC.COPY, rect) };
  const nativeApi: SyncordNativeApi = {
    popoutChats,
    snapshot,
    drop: createDropBridge(),
    ecosystem,
    statistics: {
      rendererMemory,
      snapshot: () => ipcRenderer.invoke(IPC.STATISTICS_SNAPSHOT),
      storage: () => ipcRenderer.invoke(IPC.STATISTICS_STORAGE),
    },
    recording,
    captcha,
    ping: () => ipcRenderer.invoke(IPC.PING) as Promise<"pong">,
    getVersion: () =>
      ipcRenderer.invoke(IPC.GET_VERSION) as Promise<string>,
    getSettings: () =>
      ipcRenderer.invoke(IPC.GET_SETTINGS) as Promise<Record<string, unknown>>,
    setSettings: (data: Record<string, unknown>) =>
      ipcRenderer.invoke(IPC.SET_SETTINGS, data) as Promise<void>,
    security,
    updates,
  };

  try {
    contextBridge.exposeInMainWorld("SyncordNative", nativeApi);
    console.log(`${LOG_PREFIX} SyncordNative exposed (v${VERSION})`);
    bootLog(`SyncordNative exposed (v${VERSION})`);
  } catch (err) {
    console.warn(`${LOG_PREFIX} contextBridge expose failed:`, err);
    bootLog(`contextBridge expose failed: ${String(err)}`);
  }

  // Read once at module load — not on every call.
  let rendererCode: string;
  try {
    rendererCode = fs.readFileSync(path.join(__dirname, "renderer.js"), "utf-8");
    bootLog(`renderer.js read (${rendererCode.length} bytes)`);
  } catch (err) {
    console.error(`${LOG_PREFIX} renderer.js missing:`, err);
    bootLog(`renderer.js missing: ${String(err)}`);
    return;
  }

  bootLog("injecting renderer bundle via webFrame.executeJavaScript");
  webFrame.executeJavaScript(rendererCode).then(
    () => {
      bootLog("renderer bundle executed");
    },
    (err: unknown) => {
      console.error(`${LOG_PREFIX} Failed to inject renderer:`, err);
      bootLog(`renderer bundle FAILED to execute: ${String(err)}`);
    },
  );

  loadOriginalPreload();
}

/**
 * Load Discord's own preload, after re-validating the path ourselves.
 *
 * The main process already validated this path in `patchBrowserWindow` before
 * the window existed. We check again here, independently, because the value
 * travels through `process.env` — process-global mutable state that anything
 * able to run code in this realm could rewrite between window creation and
 * preload execution.
 *
 * The allowed bases are read from **Electron**, not from the value that reached
 * us: `process.resourcesPath` and `app.getAppPath()`. Reading our own
 * `__dirname` here looked self-sufficient but was wrong — Discord 0.0.413's
 * window preload is not under the directory our bundle lives in, so the check
 * rejected a legitimate path and Syncord silently stopped loading.
 *
 * If the check fails we deliberately do NOT require the file. Discord's page
 * then runs without its own preload, which is a visible failure — but requiring
 * an attacker-chosen path inside a Node-enabled preload realm is strictly
 * worse, so the security decision wins and it is logged loudly, with the path
 * and the allowed bases so the rule can be corrected from the log.
 */
function loadOriginalPreload(): void {
  const candidate = process.env[ORIGINAL_PRELOAD_ENV];
  if (!candidate) {
    console.warn(`${LOG_PREFIX} Original preload path missing`);
    bootLog("original preload env var is UNSET — main never recorded a path");
    return;
  }

  const bases: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0 && !bases.includes(value)) {
      bases.push(value);
    }
  };
  push(process.resourcesPath);

  // `app` is main-process only: in a preload `require("electron")` returns the
  // *renderer* API (ipcRenderer, contextBridge, webFrame) and has no `app` at all.
  // So the main process hands the preload the base list it resolved — including
  // `app.getPath("userData")`, which on Discord 0.0.413 is where the main
  // screen's preload actually lives.
  //
  // Trust relationship, stated plainly: the env channel is writable by anything
  // in the main realm, so this second check is a *consistency* check, not an
  // independent authority. It catches the case where the preload path was
  // rewritten after main approved it. Main remains the authority for the
  // decision; the preload only has to agree with it.
  //
  // Without this, the preload refuses Discord's own mainScreenPreload.js, the
  // main window runs without Discord's preload, and Discord features that depend
  // on it (voice, tray, spellcheck) break in a way that looks like a Discord bug.
  const rawBases = process.env[PRELOAD_BASES_ENV];
  if (typeof rawBases === "string" && rawBases.length > 0 && rawBases.length < 8192) {
    try {
      const parsed = JSON.parse(rawBases);
      if (Array.isArray(parsed)) for (const entry of parsed) push(entry);
    } catch {
      /* malformed: the check below simply has fewer bases and will refuse */
    }
  }

  const verdict = validateDiscordPreloadPath(candidate, {
    allowedBases: bases,
    // Same canonicalizer as the main process, for the same reason: nothing
    // inside an .asar can be realpath'd, and a resolve-only fallback makes the
    // containment comparison disagree with itself.
    realpath: canonicalizeWithRealpath((target) => fs.realpathSync(target)),
  });

  if (!verdict.ok) {
    console.error(
      `${LOG_PREFIX} [security] Refusing to load original preload: ${verdict.reason}\n` +
        `                path: ${String(candidate).slice(0, 300)}\n` +
        `                allowed: ${bases.join(", ") || "(none reported)"}`,
    );
    bootLog(
      `REFUSING original preload: ${verdict.reason} | candidate=${String(candidate).slice(0, 300)} | ` +
        `allowed=${bases.join(" , ") || "(none)"}`,
    );
    return;
  }

  bootLog(`original preload accepted: ${verdict.path} (knownName=${verdict.knownName})`);

  if (!verdict.knownName) {
    // Reported, not refused. Discord names its preloads per window and per
    // release; a hardcoded name list is a silent-failure trap. The containment,
    // realpath and extension checks above are what actually constrain this.
    console.log(
      `${LOG_PREFIX} [security] Discord's preload is named "${verdict.basename}" — not in our ` +
        `known list, accepted because it is inside the app path.`,
    );
  }

  try {
    require(verdict.path);
    bootLog(`original preload required OK: ${verdict.path}`);
  } catch (err) {
    console.error(`${LOG_PREFIX} Original preload failed:`, err);
    // Discord's page now runs without its own preload. Visible failure, and the
    // one thing worth knowing before anything else.
    bootLog(`ORIGINAL PRELOAD FAILED to require: ${String(err)}`);
  }
}
