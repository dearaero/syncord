/**
 * Main-process helpers for the security subsystem.
 *
 * Nothing in this directory is imported by the renderer or the preload: these
 * modules may use `electron` and `node:*` freely. The shared *predicates* live
 * in `src/security`, which is where the renderer and preload reach them.
 */
import { app, type IpcMainInvokeEvent } from "electron";
import fs from "node:fs";
import path from "node:path";

import { LOG_PREFIX } from "../../shared/constants";
import type { SecurityEventLog } from "../../security/events";

/** Single process-wide event log. Created lazily so tests can stay pure. */
let log: SecurityEventLog | undefined;

export function securityLog(): SecurityEventLog {
  if (log === undefined) {
    // Imported here rather than at module scope to keep the dependency edge
    // obvious: the event log is the only shared mutable security state.
    const { createSecurityEventLog } = require("../../security/events") as typeof import("../../security/events");
    log = createSecurityEventLog();
  }
  return log;
}

/**
 * Run `fn` once the app is ready, or immediately if it already is.
 *
 * This exists because of a crash that broke the client on Discord 0.0.413:
 * `session.defaultSession` throws `Session can only be received when app is
 * ready` before the `ready` event, and our install path runs *before* Discord
 * is required. Two rules follow, and both are load-bearing:
 *
 *  1. Nothing in the security layer may touch `session` before `ready`. Session
 *     access is the one Electron API that is not available synchronously.
 *  2. `fn` must be idempotent. It may run from `whenReady()` *and* from a
 *     `web-contents-created` listener, because a guard that is installed "just
 *     in time" and "just in case" is the only way to be sure it is installed.
 */
export function onAppReady(fn: () => void): void {
  if (app.isReady()) {
    fn();
    return;
  }
  app.whenReady().then(fn, (err: unknown) => {
    console.warn(`${LOG_PREFIX}[security] app ready hook failed:`, err);
  });
}

/**
 * Run a security install step without ever letting it break the client.
 *
 * A security layer that stops Discord from starting is not a security layer. If
 * an Electron upgrade changes an API we depend on, the correct outcome is "this
 * one guard is off and we said so", not "the app will not boot".
 */
export function tryInstall(name: string, fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX}[security] could not install "${name}": ${message}`);
    securityLog().record({ type: "PERMISSION_REQUESTED", reason: `install failed: ${name}: ${message}` });
    return false;
  }
}

export function securityConsole(level: "info" | "warn"): (message: string) => void {
  return (message: string) => {
    if (level === "warn") console.warn(`${LOG_PREFIX}[security] ${message}`);
    else console.log(`${LOG_PREFIX}[security] ${message}`);
  };
}

/** Syncord's own profile directory. Never Discord's. */
export function SyncordUserDataPath(): string {
  return path.join(app.getPath("userData"), "Syncord");
}

export function SyncordSettingsFile(): string {
  return path.join(SyncordUserDataPath(), "settings.json");
}

/**
 * Resolve a path to its canonical form, tolerating a missing file.
 *
 * `fs.realpathSync` throws for paths that do not exist, and a *missing* file is
 * not a traversal — but a path whose parent is a symlink out of the tree is.
 * Resolving the deepest existing ancestor and re-appending the remainder keeps
 * the check meaningful in both cases.
 */
export function realpathBestEffort(target: string): string {
  let current = path.resolve(target);
  const tail: string[] = [];

  for (let i = 0; i < 64; i++) {
    try {
      const real = fs.realpathSync(current);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      tail.push(path.basename(current));
      current = parent;
    }
  }
  return path.resolve(target);
}

/** Sender shape we validate against, narrowed to what we actually read. */
export type MaybeTrustedSender = {
  senderFrame?: { url?: string } | null;
  sender?: { id?: number } | null;
} | null;

export type SenderDecision = {
  trusted: boolean;
  origin: string;
  webContentsId: number | undefined;
  channel: string | undefined;
  reason: string;
};

/**
 * Central IPC sender validation (Phase 2).
 *
 * Rules, in order:
 *  1. There must be a sender.
 *  2. There must be a *frame*. `ipcMain` events without a frame come from a
 *     webContents that has no document (devtools, service worker, or a
 *     destroyed frame) and are never the Discord page.
 *  3. The frame URL must be a trusted Discord origin.
 *  4. The frame must be the main frame of the window. A trusted page can still
 *     open a subframe (an embedded invite, a third-party widget) and that
 *     subframe's code would otherwise inherit the full privileged surface.
 *
 * Throws on rejection so a handler can never forget to check the return value.
 */
export function assertTrustedSender(event: IpcMainInvokeEvent, channel: string): void {
  const decision = describeSender(event, channel);
  if (decision.trusted) return;
  securityLog().record({
    type: "IPC_BLOCKED",
    channel,
    origin: decision.origin,
    webContentsId: decision.webContentsId,
    reason: decision.reason,
  });
  throw new Error("Untrusted IPC sender");
}

export function describeSender(event: IpcMainInvokeEvent, channel?: string): SenderDecision {
  const webContentsId = typeof event?.sender?.id === "number" ? event.sender.id : undefined;
  const frame = event?.senderFrame ?? null;
  const url = typeof frame?.url === "string" ? frame.url : "";

  const base = { webContentsId, channel, origin: safeOrigin(url) };

  if (!event?.sender) return { ...base, trusted: false, reason: "no sender" };
  if (!frame) return { ...base, trusted: false, reason: "no sender frame" };
  if (url.length === 0) return { ...base, trusted: false, reason: "empty frame url" };

  // Lazy require to avoid a cycle: origins.ts is shared, this file is not.
  const { isTrustedDiscordOrigin } = require("../../security/origins") as typeof import("../../security/origins");
  if (!isTrustedDiscordOrigin(url)) {
    return { ...base, trusted: false, reason: "untrusted frame origin" };
  }

  // Rule 4: main frame only.
  const isMainFrame = frame === event.sender.mainFrame;
  if (!isMainFrame) {
    return { ...base, trusted: false, reason: "not the main frame" };
  }

  return { ...base, trusted: true, reason: "trusted" };
}

function safeOrigin(url: string): string {
  if (url.length === 0) return "empty";
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "invalid";
  }
}
