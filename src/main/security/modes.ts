/**
 * Safe Mode (Phase 13) and Emergency Lockdown (Phase 14).
 *
 * Two different failure responses, deliberately not merged:
 *
 *  - **Safe Mode** answers "something in my plugins is misbehaving". Non-core
 *    plugins are skipped, plugin network access is refused, and the security
 *    subsystem stays fully on. Discord keeps working, because a client you
 *    cannot log into is not a recovery path.
 *  - **Emergency Lockdown** answers "I think I am being exfiltrated from". Plugin
 *    network is cut, non-core plugins are disabled, remote content is refused,
 *    and Syncord's own in-memory credentials are dropped. The Discord account
 *    token is *never* read, written, invalidated, or logged — a security feature
 *    that could destroy a user's session is not one we ship.
 *
 * Neither ever forces a logout.
 */
import { app } from "electron";

import { clearCredentials } from "./credentials";
import { CORE_PLUGIN_IDS as CORE_PLUGIN_IDS_LIST } from "../../security/corePlugins";
import { securityLog } from "./core";
import { blockPluginNetwork, registeredPluginIds, setNetworkLockdown } from "./networkBroker";
import { clearSessionGrants } from "./permissionStore";

/**
 * Plugin ids that stay enabled in Safe Mode.
 *
 * The test is "would a user lose a Discord feature if this were off?" These
 * plugins only *present* information that Discord already has (message history,
 * guild/channel state, voice state); none of them owns a data path. Everything
 * that writes, sends, or patches is excluded by default.
 *
 * Setting a flag/env var is a matter of course: `Syncord_SAFE_MODE=1`, or
 * `app.commandLine` containing `--Syncord-safe-mode`. A hold-Shift shortcut
 * was considered and rejected — a gesture that must work on the very first
 * frames of launch is exactly the kind of thing that silently stops working, and
 * a user who cannot boot into safe mode has no recovery path.
 */
// The single definition lives in src/security/corePlugins.ts, which is bundled
// into main, preload and renderer alike. It used to be a literal here *and* a
// literal in the renderer's plugin manager, and the two could drift into
// disagreeing about whether a plugin is core.
const CORE_PLUGIN_IDS = new Set<string>(CORE_PLUGIN_IDS_LIST);

export type SecurityMode = {
  safeMode: boolean;
  lockdown: boolean;
  developerMode: boolean;
  /** Why the current mode is active, for the Security Center. */
  reason: string;
};

let safeMode = false;
let lockdown = false;
let developerMode = false;
let safeModeReason = "";

function envFlag(name: string): boolean {
  return process.env[name] === "1" || process.env[name] === "true";
}

function cliFlag(name: string): boolean {
  try {
    return app.commandLine.hasSwitch(name);
  } catch {
    return false;
  }
}

/**
 * Read the startup switches. Called once, before the renderer boots, so a
 * Safe Mode session never registers a plugin at all.
 */
export function evaluateStartupMode(): SecurityMode {
  developerMode = envFlag("Syncord_DEVELOPER_MODE") || cliFlag("Syncord-developer-mode");

  const forced = envFlag("Syncord_SAFE_MODE") || cliFlag("Syncord-safe-mode");
  if (forced) {
    enableSafeMode("startup flag");
  } else {
    safeMode = false;
    safeModeReason = "";
  }

  if (envFlag("Syncord_LOCKDOWN") || cliFlag("Syncord-lockdown")) {
    enableLockdown("startup flag");
  }

  return { safeMode, lockdown, developerMode, reason: safeModeReason };
}

const restrictedListeners=new Set<()=>void>();
export function onModeRestricted(listener:()=>void):()=>void{restrictedListeners.add(listener);return()=>restrictedListeners.delete(listener);}
const notifyRestricted=():void=>{for(const listener of restrictedListeners)try{listener();}catch{/* One cleanup must not block security enforcement. */}};

export function isSafeMode(): boolean {
  return safeMode;
}

export function isLockdown(): boolean {
  return lockdown;
}

export function isDeveloperMode(): boolean {
  return developerMode;
}

/**
 * Enable Safe Mode for this session.
 *
 * Plugin network is refused at the *broker*, which is main-process policy, not
 * a renderer flag — so a plugin cannot observe Safe Mode and route around it by
 * using `fetch` instead. The renderer also skips non-core plugins entirely,
 * which is what keeps a misbehaving plugin from running its start hook at all.
 */
export function enableSafeMode(reason: string): void {
  if (safeMode) return;
  safeMode = true;
  notifyRestricted();
  safeModeReason = reason;
  safeModeLogged = false;

  // Session grants are dropped: a grant the user approved outside safe mode
  // should not silently apply inside it.
  clearSessionGrants();
  for (const pluginId of registeredPluginIds()) {
    blockPluginNetwork(pluginId, true);
  }

  securityLog().record({ type: "SAFE_MODE_ENABLED", reason });
  console.log(`[Syncord][security] Safe Mode active (${reason}) — non-core plugins disabled`);
}

let safeModeLogged = false;

/** Called by the renderer after it has skipped non-core plugins, so the log
 * reflects what actually happened rather than what was requested. */
export function reportSafeModeApplied(details: { skipped: number; kept: string[] }): void {
  if (safeModeLogged) return;
  safeModeLogged = true;
  securityLog().record({
    type: "SAFE_MODE_ENABLED",
    reason: `applied: ${details.kept.length} core plugin(s) kept, ${details.skipped} disabled`,
    permission: `kept:${details.kept.join(",") || "none"}`,
  });
}

export function exitSafeMode(): void {
  if (!safeMode) return;
  safeMode = false;
  safeModeReason = "";
  for (const pluginId of registeredPluginIds()) {
    blockPluginNetwork(pluginId, false);
  }
  console.log("[Syncord][security] Safe Mode cleared");
}

export function isCorePlugin(pluginId: string): boolean {
  return CORE_PLUGIN_IDS.has(pluginId);
}

export function corePluginIds(): string[] {
  return [...CORE_PLUGIN_IDS];
}

/**
 * Arm Emergency Lockdown (Phase 14).
 *
 * What it does, in order, so that even a crash mid-way leaves the session in
 * the safer state:
 *   1. `setNetworkLockdown(true)` — the broker refuses every plugin request,
 *      including ones for hosts the user previously approved.
 *   2. Per-plugin network block, for plugins registered after this call.
 *   3. Drops Syncord's own credentials from memory.
 *   4. Records a `LOCKDOWN_ENABLED` event.
 *
 * What it deliberately does **not** do:
 *   - Touch the Discord account token. Syncord has never read it and does not
 *     start now. Logging the user out would destroy a session over a suspicion,
 *     and a "log out everyone" button in a security panel is a phishing target.
 *   - Kill Discord's own traffic. Only plugin traffic is cut, so the user can
 *     still see what is happening and decide what to do.
 *
 * The renderer is expected to disable non-core plugins and prompt for a restart;
 * the network half of lockdown is effective immediately and survives a crash
 * because it lives in the main process.
 */
export function enableLockdown(reason: string): void {
  lockdown = true;
  notifyRestricted();
  setNetworkLockdown(true, reason);
  for (const pluginId of registeredPluginIds()) {
    blockPluginNetwork(pluginId, true);
  }
  clearCredentials();
  securityLog().record({ type: "LOCKDOWN_ENABLED", reason });
  console.error(
    "[Syncord][security] EMERGENCY LOCKDOWN engaged. Plugin network access is disabled " +
      "for this session. Restart Discord when you are ready.",
  );
}
