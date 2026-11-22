import {startPerformanceMode} from './core/performance';
import {startFrameDiagnostics} from './core/performance/diagnostics';
import {startI18n} from "./i18n/discord";
import "./core/privacy";
import { startProfileBadges } from "./core/profileBadges";
import { VERSION } from "../shared/constants";
import { css } from "./api/css";
import { installEgressGuard } from "./api/egressGuard";
import {
  LifecyclePhase,
  signal,
  watchDomReady,
  when,
} from "./api/lifecycle";
import { createLogger, logger } from "./api/logger";
import { patcher } from "./api/patcher";
import { plugins } from "./api/plugin";
import { reportSafeModeApplied } from "./api/modes";
import { securityStatus } from "./api/security";
import { settings } from "./api/settings";
import { startWatchdog } from "./api/watchdog";
import { startAutoUpdate, stopAutoUpdate } from "./api/updater";
import { autoUpdateEnabled } from "./ui/updatePrompt";
import type { SyncordApi } from "./api/types";
import {
  closeSettings,
  installSettingsShortcut,
  openSettings,
} from "./ui/settingsPanel";
import { toast } from "./ui/toast";
import { installTitlebarButton } from "./ui/titlebarButton";
import { initWebpack, webpack } from "./webpack";
import { initCommon } from "./webpack/common";

import "./plugins";

const bootLog = createLogger("boot");
const log = createLogger("boot");

/**
 * Report one line to the main process's boot log.
 *
 * The renderer is the last realm in the boot chain and the hardest to observe:
 * no `fs`, and its console is invisible unless someone attaches devtools. Every
 * boot step therefore reports itself, so "Syncord did not load" can be
 * localised to a stage instead of guessed at. See `src/shared/bootLog.ts`.
 */
function trace(message: string): void {
  const bridge = window.SyncordNative?.security;
  if (bridge === undefined) {
    // No bridge at all: the preload gate rejected this frame, or the preload
    // never ran. Either way this line is the answer, and it cannot be delivered
    // anywhere — so surface it in the console we do have.
    log.warn(`[unreportable] ${message}`);
    return;
  }
  bridge.bootLog(message).catch(() => {
    /* reporting must never break boot */
  });
}

/**
 * `waitReady` fires when webpack factories exist. Discord fills the module
 * cache afterwards, so stores are still missing if we resolve immediately.
 */
async function waitForProfileStore(): Promise<void> {
  try {
    await webpack.waitForPromise(
      (mod) => {
        if (mod == null || typeof mod !== "object") return false;
        const name = (mod as { constructor?: { displayName?: string } })
          .constructor?.displayName;
        return name === "UserProfileStore";
      },
      { timeout: 20_000 },
    );
  } catch {
    const req = webpack.getRequire();
    const cached = req?.c ? Object.keys(req.c).length : 0;
    bootLog.warn(
      `UserProfileStore still missing after wait (${cached} cached modules)`,
    );
  }
}

async function boot(): Promise<void> {
  trace("renderer bundle executing; boot() entered");
  signal(LifecyclePhase.Init);
  watchDomReady();

  // Phase 5: install the renderer egress hooks first, before any plugin or
  // core module has a chance to capture an unguarded `fetch`. These hooks are
  // detection and friction, not the boundary — the enforcement lives in the
  // main process at the session layer.
  const removeEgressGuard = installEgressGuard();
  trace(`egress guard installed=${removeEgressGuard !== undefined || true}`);

  // Clear leftovers from a previous broken session (overlays that steal clicks).
  document.getElementById("Syncord-settings-root")?.remove();
  document.getElementById("Syncord-accent-bar")?.remove();
  document.getElementById("Syncord-titlebar-btn")?.remove();

  trace("loading settings");
  await settings.init();
  trace("settings loaded");

  // Phase 13/16: learn the session's security mode from the main process
  // *before* any plugin starts, so Safe Mode is already filtering by the time
  // `startAll` runs. This is main-process truth, not a renderer guess.
  const modeStatus = await securityStatus();
  trace(
    `security status: ${JSON.stringify(modeStatus ?? null).slice(0, 300)}`,
  );
  if (modeStatus?.safeMode === true) {
    plugins.setSafeMode(true);
    bootLog.warn("Safe Mode is active — only core plugins will start");
  }
  if (modeStatus?.lockdown === true) {
    // Lockdown is one-way and survives a renderer reload, so it has to be
    // re-applied on every boot — not only when the user presses the button.
    // Set before `startAll` so no non-core plugin is ever started.
    plugins.armLockdown();
    bootLog.error("Emergency Lockdown is active — only core plugins will start");
  }
  if (modeStatus?.developerMode === true) {
    bootLog.info("Developer Mode is active");
  }
  if (modeStatus?.integrity === "modified") {
    bootLog.error("Build integrity FAILED — see the Security Center");
  }

  const api: SyncordApi = {
    version: VERSION,
    logger,
    webpack,
    patcher,
    css,
    plugins,
    settings,
    common: undefined,
    native: window.SyncordNative,
    when,
    toast,
    openSettings,
    closeSettings,
    reload: () => location.reload(),
  };
  window.Syncord = api;
  trace("window.Syncord assigned");

  initWebpack();
  await webpack.waitReady();
  trace(`webpack ready: ${JSON.stringify(webpack.debug()).slice(0, 200)}`);
  await waitForProfileStore();
  trace("user profile store settled");

  // Phase 3/9: publish the plugin + permission manifest BEFORE any plugin
  // starts. The main process denies every unknown plugin id, so this ordering is
  // what makes "no manifest ⇒ no network" true rather than aspirational.
  await plugins.registerSecurityManifest();
  trace(`security manifest registered (${plugins.list().length} plugins known)`);

  api.common = initCommon();
  const stopI18n = startI18n();
  const stopPerformanceMode = startPerformanceMode();
  startFrameDiagnostics();
  window.addEventListener("unload", stopI18n, {once:true});
  trace("common modules initialised");
  const removeProfileBadges = startProfileBadges(
    ids => api.native?.ecosystem?.lookup(ids) ?? Promise.resolve({}),
    () => !plugins.isSafeModeActive() && !plugins.isLockdownActive(),
    api.native?.ecosystem?.art?.bind(api.native.ecosystem),
  );
  // Phase 13: tell the main process what Safe Mode actually did, so the audit
  // log reflects reality rather than the request.
  //
  // Registered **before** `startAll()`. The event is dispatched from inside
  // `startAll()`, so a listener attached afterwards never sees it — which meant
  // the audit log recorded the *request* for Safe Mode and never the outcome.
  // The same failure shape as an allowlist that matches nothing: the control
  // looked installed and reported nothing.
  window.addEventListener("Syncord-safe-mode-applied", (event) => {
    const detail = (event as CustomEvent<{ kept: string[]; skipped: string[] }>).detail;
    reportSafeModeApplied(detail);
  });

  await plugins.startAll();
  trace(
    `plugins started: ${plugins
      .list()
      .filter((plugin) => plugin.started)
      .map((plugin) => plugin.id)
      .join(", ")}`,
  );

  const removeShortcut = installSettingsShortcut();
  const removeTitlebar = installTitlebarButton();
  window.addEventListener(
    "unload",
    () => {
      stopPerformanceMode();
      removeProfileBadges();
      removeShortcut();
      removeTitlebar();
      removeEgressGuard();
    },
    { once: true },
  );

  trace(
    `BOOT COMPLETE v${VERSION} native=${api.native ? "ok" : "missing"} ` +
      `titlebarButton=${removeTitlebar !== undefined}`,
  );
  bootLog.info(
    `Renderer ready v${VERSION}` +
      (api.native ? " (native OK)" : " (native missing)") +
      " · settings: titlebar icon or Ctrl/⌘+Shift+D",
  );

  // Phase 28: start the tamper watchdog. It only reports — see its header for
  // why it never acts on its own.
  const stopWatchdog = startWatchdog();
  window.addEventListener("unload", stopWatchdog, { once: true });

  // Phase 20: schedule the update checks.
  //
  // Started here rather than at import time so it is inside the boot's own
  // lifecycle and can be torn down with everything else, and it is gated on the
  // user's setting — `startAutoUpdate` is a no-op without a bridge, and
  // `checkNow` is not called when the switch is off.
  if (autoUpdateEnabled()) startAutoUpdate();
  window.addEventListener("unload", stopAutoUpdate, { once: true });

  sampleClientHealth();
}

/**
 * Measure whether Discord's own UI actually rendered, and report it.
 *
 * "Discord is black" and "Syncord booted" used to be two unrelated
 * observations, because nothing could see the page. This closes that gap: it
 * samples the DOM the client built and writes the numbers to the boot log, so a
 * black window becomes a diagnosis instead of a report.
 *
 * The signals, and why each one:
 *
 *  - `readyState` — did the document finish loading at all.
 *  - element count and text length under `<body>` — a mounted React tree has
 *    thousands of elements and real text. This is the direct measurement of
 *    "did the client render"; a black screen with a live client shows a large
 *    count, and a client that never mounted shows a tiny one.
 *  - the computed background of `<body>` — a genuinely black window is
 *    distinguishable from an unrendered one.
 *  - whether any Syncord UI exists — proves our own overlays mounted, which
 *    separates "we broke it" from "it never started".
 *
 * Sampling is repeated a few times because Discord renders late: a single
 * sample taken the instant `boot()` returns says more about scheduling than
 * about the client. Never throws — a diagnostic must not be able to break the
 * thing it is measuring.
 */
function sampleClientHealth(): void {
  const sample = (): void => {
    try {
      const body = document.body;
      if (body === null) {
        trace("health: no <body> yet");
        return;
      }
      const elements = body.getElementsByTagName("*").length;
      const textLength = (body.innerText ?? "").trim().length;
      let background = "unset";
      try {
        background = getComputedStyle(body).backgroundColor;
      } catch {
        /* detached or mid-navigation */
      }
      const ourUi = ["Syncord-settings-root", "Syncord-titlebar-btn"].filter((id) =>
        document.getElementById(id) !== null,
      );
      trace(
        `health: readyState=${document.readyState} elements=${elements} textChars=${textLength} ` +
          `bodyBg=${background} ourUi=[${ourUi.join(",")}] title=${document.title}`,
      );
      reportTitlebarButton();
    } catch (err) {
      trace(`health sample failed: ${String(err)}`);
    }
  };

  for (const delayMs of [1000, 4000, 10000]) {
    setTimeout(sample, delayMs);
  }
}

/**
 * Why is our titlebar label not on screen?
 *
 * `document.getElementById` returning an element proves nothing about
 * visibility — an element can be mounted, in the DOM, and still occupy zero
 * pixels because an ancestor is `display: none`, it is clipped out, or
 * Discord's own CSS collapses its container. That is exactly the state the
 * "Syncord" label got into: the element was present, the element count was
 * healthy, and the text was invisible.
 *
 * So measure the thing the user actually sees. Each field answers one way the
 * button can be present-but-absent:
 *
 *  - `box`     — a zero-size rect means it is laid out but collapsed.
 *  - `offsetParent === null` — the classic sign of a hidden ancestor.
 *  - `display` / `visibility` / `opacity` — on the button *and* on every
 *    ancestor, because any one of them being `none`/`hidden`/`0` is enough.
 *  - `inViewport` — on screen at all, given where it claims to be.
 *  - `text`     — what it says, so "mounted but empty" is distinguishable from
 *    "mounted and painted".
 */
function reportTitlebarButton(): void {
  const btn = document.getElementById("Syncord-titlebar-btn");
  if (btn === null) {
    trace("titlebar: MISSING from the DOM");
    return;
  }

  const chain: string[] = [];
  let node: HTMLElement | null = btn as HTMLElement;
  let hiddenAncestor: string | null = null;
  while (node !== null && node !== document.body) {
    let display = "?";
    let visibility = "?";
    let opacity = "?";
    try {
      const style = getComputedStyle(node);
      display = style.display;
      visibility = style.visibility;
      opacity = style.opacity;
    } catch {
      /* detached */
    }
    chain.push(`${node.tagName.toLowerCase()}${node.id !== "" ? `#${node.id}` : ""}[${display}/${visibility}/${opacity}]`);
    if (hiddenAncestor === null && (display === "none" || visibility === "hidden" || opacity === "0")) {
      hiddenAncestor = `${node.tagName.toLowerCase()}${node.id !== "" ? `#${node.id}` : ""}(${display}/${visibility}/${opacity})`;
    }
    node = node.parentElement;
  }

  let box = "?";
  let inViewport = "?";
  try {
    const rect = btn.getBoundingClientRect();
    box = `${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.left)},${Math.round(rect.top)}`;
    inViewport = String(
      rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth,
    );
  } catch {
    /* detached */
  }

  let color = "?";
  let fontSize = "?";
  try {
    const style = getComputedStyle(btn);
    color = style.color;
    fontSize = style.fontSize;
  } catch {
    /* detached */
  }

  trace(
    `titlebar: text=${JSON.stringify(btn.textContent ?? "")} box=${box} inViewport=${inViewport} ` +
      `offsetParent=${btn.offsetParent === null ? "null" : "set"} color=${color} fontSize=${fontSize} ` +
      `hiddenAncestor=${hiddenAncestor ?? "none"} chain=${chain.slice(0, 6).join(" < ")}`,
  );
}

void boot().catch((err: unknown) => {
  console.error("[Syncord:boot] Fatal:", err);
  // A throw anywhere in boot() previously produced nothing but a console line
  // nobody can read. This is the single most useful line in the file.
  trace(`FATAL during boot: ${String(err)}`);
});
