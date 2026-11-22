/**
 * Navigation, window-open and external-link guard (Phase 7).
 *
 * Syncord inherits Electron's defaults here, which are permissive: a window
 * can navigate anywhere, `window.open` hands a new `BrowserWindow` to page code
 * with the same webPreferences, and Discord's external-link handling can hand a
 * URL to the OS handler. Each of those is a way out of the trusted origin.
 *
 * Three guards, three different risks:
 *
 *  1. `will-navigate` — the main window must stay on a trusted Discord origin.
 *     A `window.location` assignment (or a compromised dependency) cannot walk
 *     the user's session to a phishing page that looks like Discord.
 *  2. `setWindowOpenHandler` — **default deny**. `window.open`, `target=_blank`
 *     and `<a target>` are how Discord's popouts and lightboxes are created, so
 *     this cannot simply refuse everything; it allows the popout URL shapes
 *     Discord actually uses and refuses the rest.
 *  3. `openExternal` protocol allowlist — handing an arbitrary URL to the OS
 *     runs it in another application, outside every other control here. Only
 *     `http:` and `https:` are ever forwarded. `file:`, `javascript:`, `data:`,
 *     `vbscript:` and app-registration schemes (`steam:`, `spotify:`, custom
 *     protocol handlers) are refused, because a protocol handler can be pointed
 *     at a malicious application.
 *
 * The failure mode is chosen per case. Navigation and window-open failures are
 * silent (a refused popup is invisible to the user; a visible error is noise).
 * `openExternal` failures are logged, because the user just clicked a link and
 * deserves to know why nothing happened.
 */
import {installLocalPopupDispatcher} from "./localPopups";
import { shell, type BrowserWindow, type WebContents } from "electron";

import { isTrustedDiscordHostname, isTrustedDiscordOrigin, TRUSTED_DISCORD_HOSTNAMES } from "../../security/origins";
import { parseUrl } from "../../security/url";
import { securityLog } from "./core";

/**
 * Protocols we will hand to the OS.
 *
 * `http:` and `https:` only. Discord deep-links to Spotify/Steam exist in the
 * wild, but forwarding them means letting the page choose which application
 * handles an attacker-supplied string on the machine; that is a much larger
 * decision than a security patch should make on the user's behalf. Adding one
 * is a reviewed, deliberate change to this list.
 */
const EXTERNAL_PROTOCOLS = new Set(["https:", "http:"]);

/** Schemes that must never be opened, named explicitly for the log. */
const NEVER_EXTERNAL = new Set([
  "javascript:",
  "data:",
  "file:",
  "vbscript:",
  "blob:",
  "about:",
  "chrome:",
  "chrome-extension:",
]);

/**
 * Popout/utility window shapes Discord legitimately opens.
 *
 * Kept as path prefixes on trusted origins rather than as a general "Discord
 * may open Discord" rule, so a crafted `https://discord.com/<anything>` cannot
 * inherit window privileges just by being on the right host.
 */
const ALLOWED_POPOUT_PATHS = [
  "/popout",
  "/popout/",
  "/popup",
  "/modal",
  "/oauth2",
  "/invite",
  "/login",
  "/channels",
  "/activity",
  "/library",
  "/store",
  "/quest",
  "/parties",
] as const;

const guarded = new WeakSet<WebContents>();

/** Attach every navigation guard to a window (ours, or a child we keep). Idempotent. */
export function installWindowGuards(window: Pick<BrowserWindow, "webContents">): void {
  const contents: WebContents = window.webContents;
  if (guarded.has(contents)) return;
  guarded.add(contents);

  // ── 1. will-navigate ─────────────────────────────────────────────────────
  contents.on("will-navigate", (event, url) => {
    if (isTrustedDiscordOrigin(url)) return;
    // Same-document navigation and hash changes never reach here, so anything
    // that does is a real attempt to leave.
    event.preventDefault();
    securityLog().record({
      type: "NAVIGATION_BLOCKED",
      origin: safeOrigin(url),
      webContentsId: contents.id,
      reason: "main window may not navigate off a trusted Discord origin",
    });
  });

  // A `webContents`-level redirect (server-side 302 to a login page, for
  // example) must be checked too, or `will-navigate` alone is bypassable.
  contents.on("will-redirect", (event, url) => {
    if (isTrustedDiscordOrigin(url)) return;
    event.preventDefault();
    securityLog().record({
      type: "NAVIGATION_BLOCKED",
      origin: safeOrigin(url),
      webContentsId: contents.id,
      reason: "redirect off a trusted Discord origin",
    });
  });

  // ── 2. window open: default deny ─────────────────────────────────────────
  installLocalPopupDispatcher(contents);
  contents.setWindowOpenHandler((details) => {
    const url = details.url;
    const verdict = judgePopup(url, details.frameName);
    if (verdict.allow) {
      return { action: "allow" };
    }
    securityLog().record({
      type: "WINDOW_OPEN_BLOCKED",
      origin: safeOrigin(url),
      webContentsId: contents.id,
      reason: verdict.reason,
    });
    return { action: "deny" };
  });

  // ── 3. new-window requests that bypassed the handler ─────────────────────
  // Defence in depth: if a future Electron or Discord change routes around
  // `setWindowOpenHandler`, this is the second net.
  contents.on("did-create-window", (child, details) => {
    // Decide on the requested URL: the guest has not committed it yet, so
    // getURL() is "" or about:blank even when an outside site was requested.
    // A blank popup is written by its trusted opener (Discord popouts/overlay).
    const requested = typeof details?.url === "string" ? details.url : "";
    const current = child.webContents.getURL();
    const allowed = (u: string): boolean => u === "about:blank" || isTrustedDiscordOrigin(u);
    const url = requested || current;
    // Kept children get the main window's full guard set: navigation,
    // redirects and nested window.open.
    if (allowed(requested) && (current === "" || allowed(current))) {
      installWindowGuards(child);
      return;
    }
    securityLog().record({
      type: "WINDOW_OPEN_BLOCKED",
      origin: safeOrigin(url),
      webContentsId: child.webContents.id,
      reason: "created window is not on a trusted Discord origin",
    });
    // Destroying inside emit() crashes Discord's own later did-create-window
    // listener ("Object has been destroyed"). Stop and hide now, destroy after.
    child.webContents.stop();
    child.hide();
    setImmediate(() => { if (!child.isDestroyed()) child.destroy(); });
  });
}

export type PopupVerdict = { allow: boolean; reason: string };

/**
 * Is this a popout Discord is entitled to open?
 *
 * Exported for tests. Three conditions, all required:
 *   - trusted Discord origin (https + Discord-owned host, no odd port),
 *   - a path Discord actually uses for popouts, or the window is unnamed
 *     (`window.open(url)` with no `target`), which is how Discord's own
 *     lightboxes and cookie-notice frames are created,
 *   - no `javascript:`/`data:` payload, which would run in the new window.
 */
export function judgePopup(url: unknown, frameName?: string): PopupVerdict {
  const parsed = parseUrl(url);
  if (parsed === null) {
    return { allow: false, reason: "window.open url could not be parsed" };
  }
  if (parsed.protocol === "data:" || parsed.protocol === "blob:") {
    // Discord does open `data:`-URL windows for a few internal tools. Allowing
    // them would hand a new BrowserWindow to an attacker-supplied document, so
    // they are refused and the paths that need them use the trusted origin.
    return { allow: false, reason: `${parsed.protocol} windows are not allowed` };
  }
  if (!isTrustedDiscordOrigin(parsed.href)) {
    return { allow: false, reason: "window.open target is not a trusted Discord origin" };
  }

  const named = typeof frameName === "string" && frameName.length > 0;
  if (!named) return { allow: true, reason: "unnamed window on a trusted origin" };

  const path = parsed.pathname;
  const allowed = (ALLOWED_POPOUT_PATHS as readonly string[]).some(
    (prefix) => path === prefix || path.startsWith(prefix),
  );
  if (!allowed) {
    return { allow: false, reason: `"${frameName}" is not a known Discord popout` };
  }
  return { allow: true, reason: "known Discord popout" };
}

/**
 * Hand a URL to the OS handler, if and only if the protocol is allowed.
 * Returns whether it was opened, so the caller can log a refusal.
 */
export async function openExternal(raw: unknown): Promise<boolean> {
  const parsed = parseUrl(raw);
  if (parsed === null) {
    securityLog().record({ type: "NAVIGATION_BLOCKED", reason: "external url could not be parsed", origin: "invalid" });
    return false;
  }
  if (NEVER_EXTERNAL.has(parsed.protocol)) {
    securityLog().record({
      type: "NAVIGATION_BLOCKED",
      reason: `refusing to hand ${parsed.protocol} to the OS`,
      origin: `${parsed.protocol}//`,
    });
    return false;
  }
  if (!EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    securityLog().record({
      type: "NAVIGATION_BLOCKED",
      reason: `protocol ${parsed.protocol} is not in the external allowlist`,
      origin: `${parsed.protocol}//`,
    });
    return false;
  }
  try {
    await shell.openExternal(parsed.href);
    return true;
  } catch (err) {
    console.warn("[Syncord][security] openExternal failed:", err);
    return false;
  }
}

function safeOrigin(url: unknown): string {
  const parsed = parseUrl(url);
  if (parsed === null) return "invalid";
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * Summary for the Security Center. Exported so the UI can show what the
 * allowlists actually contain rather than asserting "ON".
 */
export function describeWindowPolicy(): {
  trustedHostnames: readonly string[];
  popoutPaths: readonly string[];
  externalProtocols: string[];
} {
  return {
    trustedHostnames: TRUSTED_DISCORD_HOSTNAMES,
    popoutPaths: ALLOWED_POPOUT_PATHS,
    externalProtocols: [...EXTERNAL_PROTOCOLS],
  };
}

export { isTrustedDiscordHostname };
