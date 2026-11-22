import { t as i18nText } from "../i18n";
/**
 * Auto-update, renderer side (Phase 20).
 *
 * The renderer is not a security boundary and this module does not try to be
 * one. It polls, compares, and draws. Every decision that matters — which host
 * to talk to, whether a descriptor is authentic, whether a digest matches —
 * already happened in `src/main/security/updater.ts` before a value reached
 * here. What arrives over the bridge is a verdict, not a document.
 *
 * Two consequences worth stating, because they are the whole design:
 *
 *   - **No `ctx.network`.** A built-in plugin declaring a `network` permission
 *     fails `scripts/tests/plugin-policy.test.mjs`, and rightly so. The updater
 *     is not a plugin for the same reason Emergency Lockdown is not: it must
 *     still work when every plugin has been stopped.
 *   - **No `fetch`, no `XMLHttpRequest`, no `<script>`.** All three would be
 *     flagged by the policy test and, more to the point, would be a direct
 *     egress path out of the trusted origin for any script that found the
 *     renderer's globals.
 */
import { createLogger } from "./logger";
import { settings } from "./settings";
import type { SyncordInjectorLocation, SyncordUpdateStatus } from "../../shared/native";

const log = createLogger("updater");

/** Settings keys. Namespaced under `updates.` rather than `plugins.*`, because
 *  the reserved-key rule in `src/main/security/settings.ts` owns `security*`
 *  and everything else is a free key — `updates` is a top-level client concern,
 *  not a plugin's data. */
export const AUTO_UPDATE_KEY = "updates.autoCheck";
export const UPDATE_CHANNEL_KEY = "updates.channel";
export const INJECTOR_PATH_KEY = "updates.injectorPath";
export const LAST_SEEN_KEY = "updates.lastSeenVersion";

/**
 * How often to look, and the delay before the first look.
 *
 * Check 20 seconds after startup, then every six hours while enabled. Read
 * the current settings at each tick so the saved channel and opt-out apply.
 */
export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const FIRST_CHECK_DELAY_MS = 20_000;

type Listener = (status: SyncordUpdateStatus) => void;

const listeners = new Set<Listener>();

let current: SyncordUpdateStatus = {
  phase: "idle",
  detail: "",
  build: "",
  current: "",
  latest: null,
  channel: "stable",
  platform: null,
  progress: null,
  stagedVersion: null,
  lastError: null,
};

let timer: ReturnType<typeof setTimeout> | undefined;
let pollHandle: ReturnType<typeof setInterval> | undefined;
let started = false;
let inFlight: Promise<SyncordUpdateStatus> | undefined;
let queuedChannel: string | undefined;
let updateEpoch = 0;

function bridge() {
  return window.SyncordNative?.updates;
}

function emit(): void {
  for (const listener of listeners) {
    // A listener throwing is a bug in that listener, not a reason to stop
    // telling the others. The panel, the sidebar button and the toast all
    // subscribe, and one of them failing must not silence the other two.
    try {
      listener(current);
    } catch (err) {
      log.warn("an update listener threw:", err);
    }
  }
}

function adopt(status: SyncordUpdateStatus | undefined): SyncordUpdateStatus {
  if (!status || typeof status.phase !== "string") return current;
  // `detail` is rendered as text, never as markup. It is still sliced here so
  // a main-process regression cannot put an unbounded string in the DOM.
  current = { ...status, detail: String(status.detail ?? "").slice(0, 300) };
  emit();
  return current;
}

export function updateState(): SyncordUpdateStatus {
  return { ...current };
}

export function onUpdate(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Is there an update the user has not been offered yet? */
export function hasPendingUpdate(): boolean {
  return current.phase === "available" || current.phase === "ready" || current.phase === "handed-off" || current.phase === "awaiting-restart";
}

/**
 * Ask for a check. Returns the new status, or the current one when the bridge
 * is missing or a check is already running.
 *
 * The bridge being absent is normal, not an error: an untrusted frame never
 * receives it, and a client running outside an injected Discord has none.
 */
export async function checkNow(channel: string): Promise<SyncordUpdateStatus> {
  const api = bridge();
  if (api === undefined || current.phase === "awaiting-restart") return current;
  const requested = channel === "beta" ? "beta" : "stable";
  if (inFlight) {
    queuedChannel = requested;
    return inFlight;
  }

  const requestEpoch = updateEpoch;
  inFlight = Promise.resolve().then(async () => {
    if (requestEpoch !== updateEpoch) return current;
    let next = queuedChannel ?? requested;
    while (true) {
      queuedChannel = undefined;
      const epoch = updateEpoch;
      adopt({ ...current, phase: "checking", channel: next, latest: null, stagedVersion: null,
        progress: null, lastError: null, detail: i18nText("ui.checking_for_updates") });
      try {
        const result = await api.check(next);
        if (epoch === updateEpoch && (!queuedChannel || queuedChannel === next)) adopt(result);
      } catch (err) {
        log.error("update check failed:", err);
        if (epoch === updateEpoch && (!queuedChannel || queuedChannel === next)) adopt({ ...current, phase: "error", latest: null,
          detail: i18nText("ui.the_update_check_could_not_be_completed_please_try_again"), lastError: "bridge-check" });
      }
      if (!queuedChannel || (queuedChannel === next && epoch === updateEpoch)) break;
      next = queuedChannel;
    }
    return current;
  }).finally(() => { inFlight = undefined; });
  return inFlight;
}

/** Download and verify. The button's first half. */
export async function stageNow(): Promise<SyncordUpdateStatus> {
  const api = bridge();
  if (api === undefined) return current;

  // Progress arrives by polling, because the bridge is request/response and
  // there is no event channel. `onUpdateStatus` in main keeps the state fresh;
  // the renderer asks for a copy every 400 ms while a transfer is running.
  const poller = setInterval(() => {
    void refreshStatus();
  }, 400);

  try {
    return adopt(await api.stage());
  } catch (err) {
    log.error("update download failed:", err);
    return current;
  } finally {
    clearInterval(poller);
  }
}

/**
 * Run the installer against the staged bundle, and wait for it to finish.
 *
 * The button's second half. `injectorPath` is optional: an empty value means
 * "let main find it", which is the common case now that discovery exists.
 *
 * This resolves only when the installer has exited, so the caller can show what
 * actually happened rather than that something was started. It also means a
 * button that looks stuck is a button that is genuinely working, so the UI has
 * to say so — see the phase handling in `updatePrompt.ts`.
 */
export async function handOffNow(injectorPath?: string): Promise<SyncordUpdateStatus> {
  const api = bridge();
  if (api === undefined) return current;
  try {
    return adopt(await api.handOff(injectorPath ?? ""));
  } catch (err) {
    log.error("installer hand-off failed:", err);
    return current;
  }
}

/**
 * Forget the accepted release.
 *
 * Called when the user turns automatic updates off. Without it, main keeps the
 * accepted descriptor and the renderer keeps showing a Download button for a
 * release the user has stopped checking for — the switch would turn the
 * *scheduling* off and nothing else, which is not what "off" means.
 */
export async function resetUpdate(): Promise<SyncordUpdateStatus> {
  ++updateEpoch;
  queuedChannel = undefined;
  const api = bridge();
  if (api === undefined) return current;
  try {
    return adopt(await api.reset());
  } catch (err) {
    log.error("update reset failed:", err);
    return current;
  }
}

/** Where the installer is, so the UI can say before the user presses anything. */
export async function injectorLocation(): Promise<SyncordInjectorLocation> {
  const api = bridge();
  if (api === undefined) return { found: null, searched: [] };
  try {
    const location = await api.injector();
    return {
      found: typeof location?.found === "string" ? location.found : null,
      searched: Array.isArray(location?.searched) ? location.searched.slice(0, 8) : [],
    };
  } catch (err) {
    log.error("injector lookup failed:", err);
    return { found: null, searched: [] };
  }
}

export async function refreshStatus(): Promise<SyncordUpdateStatus> {
  const api = bridge();
  if (api === undefined) return current;
  try {
    return adopt(await api.status());
  } catch {
    // A failed poll is not worth a log line every 400 ms; the phase simply
    // stops moving and the UI keeps showing the last known state.
    return current;
  }
}

/**
 * Start the background schedule. Idempotent, and the only thing that owns a
 * timer in this module.
 */
export function startAutoUpdate(): void {
  if (started) return;
  if (bridge() === undefined) {
    log.info("no update bridge — auto update stays off");
    return;
  }
  started = true;

  const tick = () => {
    if (settings.get<boolean>(AUTO_UPDATE_KEY, true) !== true) return;
    if (["downloading", "ready", "handing-off", "handed-off", "awaiting-restart"].includes(current.phase)) return;
    const channel = settings.get<string>(UPDATE_CHANNEL_KEY, "stable") === "beta" ? "beta" : "stable";
    void checkNow(channel);
  };
  timer = setTimeout(() => {
    tick();
    pollHandle = setInterval(tick, UPDATE_INTERVAL_MS);
  }, FIRST_CHECK_DELAY_MS);
}

/**
 * Stop everything. Registered as a boot-phase disposable, so a renderer
 * reload cannot leave a second schedule running behind the first.
 */
export function pauseAutoUpdate(): void {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  if (pollHandle !== undefined) {
    clearInterval(pollHandle);
    pollHandle = undefined;
  }
  started = false;
}

export function stopAutoUpdate(): void {
  pauseAutoUpdate();
  ++updateEpoch;
  queuedChannel = undefined;
  listeners.clear();
}

/** The bridge can close Discord only after main verified a live update worker. */
export async function restartNow(): Promise<boolean> {
  return await bridge()?.restart() ?? false;
}
