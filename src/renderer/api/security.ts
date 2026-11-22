/**
 * Renderer-side access to the security control plane.
 *
 * Thin wrapper over the preload bridge. Exists so the Security Center and the
 * permission prompt have one place to degrade when the preload gate rejected
 * the page (in which case `window.SyncordNative.security` is simply absent).
 */
import { createLogger } from "./logger";
import type {
  SyncordBrokerPolicy,
  SyncordPermissionCategory,
  SyncordPermissionGrant,
  SyncordPermissionResult,
  SyncordSecurityBridge,
  SyncordSecurityEvent,
  SyncordSecurityStatus,
} from "../../shared/native";

export function securityBridge(): SyncordSecurityBridge | undefined {
  return window.SyncordNative?.security;
}

export async function securityStatus(): Promise<SyncordSecurityStatus | undefined> {
  return securityBridge()?.status();
}

export async function securityEvents(limit = 100): Promise<SyncordSecurityEvent[]> {
  try {
    return (await securityBridge()?.events(limit)) ?? [];
  } catch {
    return [];
  }
}

export async function securityPolicy(): Promise<SyncordBrokerPolicy | undefined> {
  return securityBridge()?.policy();
}

export async function listPermissions(): Promise<SyncordPermissionGrant[]> {
  try {
    return (await securityBridge()?.permissions()) ?? [];
  } catch {
    return [];
  }
}

const log = createLogger("security");

export async function requestGrant(input: {
  pluginId: string;
  category: SyncordPermissionCategory;
  host: string;
  methods?: string[];
  trusted?: boolean;
}): Promise<SyncordPermissionResult> {
  const bridge = securityBridge();
  if (bridge === undefined) {
    return { ok: false, reason: "security bridge unavailable" };
  }
  try {
    return await bridge.grant(input);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "grant failed" };
  }
}

export async function revokeGrant(key: string): Promise<boolean> {
  try {
    return (await securityBridge()?.revoke(key)) ?? false;
  } catch {
    return false;
  }
}

/**
 * Arm Emergency Lockdown.
 *
 * Main does the authoritative half — network cut, credentials dropped, per-plugin
 * broker blocking. This does the half main cannot: stop the plugins that are
 * already running in the page, because a plugin that patched a store method or
 * injected CSS was still changing Discord's UI after lockdown was armed.
 *
 * Order matters. `plugins` is imported lazily so this module has no cycle
 * through the plugin manager (which reaches back into the security client), and
 * the flag is set *before* the stop so nothing can be started in between.
 */
export async function armLockdown(): Promise<boolean> {
  try {
    const result = await securityBridge()?.lockdown();
    if (result?.locked !== true) return false;
    const mgr = await import("./plugin/manager");
    mgr.armLockdown();
    const { stopped } = await mgr.stopNonCore();
    log.error(
      `Emergency Lockdown armed — ${stopped.length} non-core plugin(s) stopped ` +
        `(${stopped.join(", ") || "none running"}). Core plugins and the Security Center stay available.`,
    );
    return true;
  } catch (err) {
    log.error("lockdown request failed:", err);
    return false;
  }
}

export const security = {
  bridge: securityBridge,
  status: securityStatus,
  events: securityEvents,
  policy: securityPolicy,
  permissions: listPermissions,
  grant: requestGrant,
  revoke: revokeGrant,
  lockdown: armLockdown,
};
