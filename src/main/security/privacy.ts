import { classifyPrivacyRequest } from "../../security/privacy";
import type { SyncordPrivacyStatus } from "../../shared/native";

const blocked = { analytics: 0, metrics: 0, crashReports: 0, sentryScript: 0 };
let nativeCrashGuard = false;
let discordCrashStartupDisabled = false;

/** Before Discord is required; no session API and no recurring watcher. */
export function installCrashPrivacy(): void {
  // Discord's own main-process reporter checks this flag before initializing
  // Sentry (including its Node transport, which bypasses Electron webRequest).
  // Set at runtime, not in the OS environment or Discord's settings file.
  process.env.ELECTRON_ENABLE_STACK_DUMPING = "true";
  discordCrashStartupDisabled = true;
  if (nativeCrashGuard) return;
  try {
    const { crashReporter } = require("electron") as typeof import("electron");
    if (!crashReporter) throw new Error("Electron crashReporter unavailable");
    // setUploadToServer(false) alone has no effect before start(), and some
    // Electron versions ignore later consent changes. Never start Crashpad.
    const noStart = (): void => {};
    const noUpload = (): void => {};
    crashReporter.start = noStart;
    crashReporter.setUploadToServer = noUpload;
    nativeCrashGuard = crashReporter.start === noStart && crashReporter.setUploadToServer === noUpload;
    if (!nativeCrashGuard) throw new Error("Electron crashReporter methods are read-only");
  } catch (error) {
    console.warn("[Syncord:privacy] Native crash startup guard unavailable:", String(error));
  }
}

/** Called inside the existing session callback; never records payloads/URLs. */
export function blockPrivacyRequest(url: string): boolean {
  const kind = classifyPrivacyRequest(url);
  if (kind === undefined) return false;
  blocked[kind] = Math.min(Number.MAX_SAFE_INTEGER, blocked[kind] + 1);
  return true;
}

export function privacyStatus(requestFilterInstalled: boolean): SyncordPrivacyStatus {
  return { requestFilterInstalled, nativeCrashGuard, discordCrashStartupDisabled, blocked: { ...blocked } };
}
