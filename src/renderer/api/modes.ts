/**
 * Renderer-side mode control.
 *
 * Safe Mode's *enforcement* lives in the main process (it blocks the broker
 * there), so this module is only the user-facing half: leaving Safe Mode, and
 * reporting what the current mode is. Starting in Safe Mode is a startup switch
 * or a settings flag — never an IPC call, so page code cannot put the client
 * into a state the user did not ask for.
 */
import { createLogger } from "./logger";
import { securityBridge } from "./security";
import type { SyncordSecurityStatus } from "../../shared/native";

const log = createLogger("modes");

/** Ask the main process to leave Safe Mode, then reload. */
export async function exitSafeMode(): Promise<boolean> {
  const bridge = securityBridge();
  if (bridge === undefined) {
    log.warn("security bridge unavailable; cannot leave Safe Mode");
    return false;
  }
  try {
    const result = await bridge.setSafeMode(false);
    return result.safeMode === false;
  } catch (err) {
    log.error("could not leave Safe Mode:", err);
    return false;
  }
}

export async function currentStatus(): Promise<SyncordSecurityStatus | undefined> {
  return securityBridge()?.status();
}

/**
 * Log which plugins Safe Mode actually kept and skipped.
 *
 * Renderer-side only. Deliberately *not* an IPC call: the obvious channel for
 * "report what you did" would be `setSafeMode`, and calling that here would
 * silently exit Safe Mode — turning a diagnostic into the thing that disables
 * the protection. The main process records its own `SAFE_MODE_ENABLED` event
 * when the mode is armed, which is the authoritative record.
 */
export function reportSafeModeApplied(details: { kept: string[]; skipped: string[] }): void {
  log.warn(
    `Safe Mode applied: ${details.kept.length} core plugin(s) kept ` +
      `(${details.kept.join(", ") || "none"}), ${details.skipped.length} disabled`,
  );
}

/** True when the session is in a restricted mode; used to label the UI. */
export function isRestricted(status: SyncordSecurityStatus | undefined): boolean {
  return status?.safeMode === true || status?.lockdown === true;
}
