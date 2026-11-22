/**
 * Electron permission handlers (Phase 8).
 *
 * Electron's default is to grant most permission requests. That is a poor
 * default for a client that renders third-party embeds and user-supplied links:
 * a compromised plugin could silently turn on the microphone or camera, or read
 * geolocation, and the user would see a prompt they did not understand.
 *
 * Policy, in order:
 *
 *  1. Unknown origin ⇒ deny. Only trusted Discord origins may ask for anything.
 *     A permission prompt from an embedded frame is always a red flag.
 *  2. Unknown permission ⇒ deny. The list below is closed. An Electron release
 *     that adds a new permission must be reviewed here rather than inherited
 *     by default — that is the whole reason this is an allowlist.
 *  3. Known permission + trusted origin ⇒ granted, because Discord genuinely
 *     uses these. Voice, camera and screen share are core product features;
 *     denying them would break the client rather than protect it.
 *
 * What is granted, and why each is needed:
 *   - `media` / `audioCapture` / `videoCapture` — voice, camera, screen share.
 *   - `display-capture` — screen share, which is a distinct permission from
 *     camera in Electron and is requested separately.
 *   - `notifications` — Discord's notification system.
 *   - `clipboard-read` / `clipboard-sanitized-write` — copy message, paste,
 *     copy avatar (the Copy Avatar plugin). `clipboard-read` is a real
 *     capability, so it is granted only to a trusted origin and is recorded as
 *     an event rather than silently allowed.
 *   - `fullscreen` — Discord's fullscreen and focus-mode layouts.
 *   - `pointerLock` — pointer lock in some game/stream integrations.
 *   - `midi` — Discord's MIDI piano. Harmless, but explicitly listed so it is a
 *     decision rather than an accident.
 *
 * Explicitly denied, and the reason each matters in a Discord client:
 *   - `geolocation` — Discord does not use it; it is a location beacon.
 *   - `hid` / `serial` / `usb` — direct hardware access from a chat client is
 *     never legitimate and is a known target for USB-keylogger-style abuse.
 *   - `midiSysex` — raw MIDI I/O with no legitimate use here.
 *   - `window-management` — screen/window enumeration; a fingerprinting vector
 *     with no product reason.
 *   - `idle-detection` — user-activity tracking with no product reason.
 *   - `storage-access` — would let a third-party frame read Discord's storage.
 */
import { session, type WebContents } from "electron";

import { isTrustedDiscordOrigin } from "../../security/origins";
import { securityLog } from "./core";

/** Permissions Discord legitimately needs. Anything not here is denied. */
const ALLOWED_PERMISSIONS = new Set([
  "media",
  "audioCapture",
  "videoCapture",
  "display-capture",
  "notifications",
  "clipboard-read",
  "clipboard-sanitized-write",
  "fullscreen",
  "pointerLock",
  "midi",
]);

/**
 * Permissions that are refused even on a trusted origin, with the reason kept
 * next to the name so the list stays reviewable and cannot quietly grow.
 */
const DENIED_WITH_REASON: Record<string, string> = {
  geolocation: "location tracking has no use in a chat client",
  hid: "direct hardware access is never legitimate here",
  serial: "direct hardware access is never legitimate here",
  usb: "direct hardware access is never legitimate here",
  "midiSysex": "raw MIDI I/O has no use here",
  "window-management": "window enumeration is a fingerprinting vector",
  "idle-detection": "user-activity tracking has no product reason",
  "storage-access": "would let a third-party frame read Discord storage",
  "unknown": "unrecognised permission",
};

export type PermissionDecision = { granted: boolean; reason: string };

/**
 * Pure decision function so the policy is unit-testable without Electron.
 */
export function decidePermission(
  permission: unknown,
  requestingUrl: unknown,
  details?: { mediaTypes?: unknown },
): PermissionDecision {
  if (typeof permission !== "string" || permission.length === 0) {
    return { granted: false, reason: "missing permission name" };
  }
  // A non-string URL is not a location we can trust, so it is treated as
  // untrusted rather than coerced.
  const url = typeof requestingUrl === "string" ? requestingUrl : "";
  if (!isTrustedDiscordOrigin(url)) {
    // Checked before the allowlist so the *reason* recorded for an untrusted
    // origin is the origin, not the permission name — that is the more useful
    // signal in the log.
    return { granted: false, reason: "untrusted origin" };
  }

  const denial = DENIED_WITH_REASON[permission];
  if (denial !== undefined) {
    return { granted: false, reason: denial };
  }
  if (!ALLOWED_PERMISSIONS.has(permission)) {
    // Reached for a permission this Electron build knows about but we have not
    // reviewed. Denying is the point: an unreviewed capability is not granted.
    return { granted: false, reason: `permission "${permission}" has not been reviewed` };
  }

  // Voice/video are only granted for the media types Discord asks for. A request
  // for an unexpected media type is not automatically a problem, but it is
  // worth being able to see in the log.
  const mediaTypes = Array.isArray(details?.mediaTypes)
    ? details?.mediaTypes.filter((t): t is string => typeof t === "string")
    : [];
  if ((permission === "audioCapture" || permission === "videoCapture") && mediaTypes.length > 0) {
    const expected = permission === "audioCapture" ? /^audio\// : /^video\//;
    if (!mediaTypes.some((type) => expected.test(type))) {
      return { granted: false, reason: "media type does not match the requested permission" };
    }
  }

  return { granted: true, reason: "trusted origin, reviewed permission" };
}

let installed = false;

/**
 * Install the permission handlers.
 *
 * **Must not be called before `app.whenReady()`** — `session.defaultSession`
 * throws otherwise, and that throw is fatal to the client. Use
 * `installSessionGuards()` from `./session`, which defers correctly; this
 * function is the raw primitive.
 */
export function installPermissionHandlers(): void {
  if (installed) return;

  /**
   * Which URL the decision must be made against, in strict order of preference.
   *
   * Electron passes `details.requestingUrl` — the URL of the frame that asked —
   * and `requestingOrigin` on the check handler. The old code ignored both in
   * favour of `webContents.getURL()`, which is the **top-level** document.
   * Discord embeds third-party frames (Spotify players, link previews, OAuth
   * widgets, video embeds), so a camera or microphone request from one of those
   * was judged as if it came from `https://discord.com` and granted.
   *
   * Order:
   *   1. `details.requestingUrl` — the exact frame URL, when Electron provides it.
   *   2. `requestingOrigin` — reduced to a bare origin before the decision, so a
   *      crafted value cannot smuggle a path or a userinfo section past the
   *      hostname check.
   *   3. `contents.getURL()` — the top level, only because Electron offers
   *      nothing better for some permission checks.
   *
   * Steps 1 and 2 can only make a decision stricter than the top-level URL, so
   * this cannot grant something the old code refused.
   */
  const resolvingUrl = (
    webContents: WebContents | undefined | null,
    requestingUrl: unknown,
    requestingOrigin: unknown,
    details?: { requestingUrl?: unknown },
  ): string => {
    const fromDetails =
      typeof requestingUrl === "string" && requestingUrl.length > 0
        ? requestingUrl
        : details?.requestingUrl;
    if (typeof fromDetails === "string" && fromDetails.length > 0) return fromDetails;

    if (typeof requestingOrigin === "string" && requestingOrigin.length > 0) {
      const origin = safeOrigin(requestingOrigin);
      // Presence is authoritative: if Electron supplied a frame origin but it
      // cannot be parsed, fail closed instead of falling back to the trusted
      // top-level Discord document. Falling back here would turn an opaque or
      // malformed subframe origin into an allow.
      if (origin === "invalid" || origin === "empty") return "";
      return origin;
    }

    // Only use the top-level URL when Electron supplied no frame identity at all.
    return webContents?.getURL() ?? "";
  };

  const handleRequest = (
    webContents: WebContents | undefined,
    permission: string,
    callback: (granted: boolean) => void,
    details?: { mediaTypes?: unknown; requestingUrl?: unknown; requestingOrigin?: unknown },
  ): void => {
    const url = resolvingUrl(webContents, details?.requestingUrl, details?.requestingOrigin, details);
    const decision = decidePermission(permission, url, details);
    if (!decision.granted) {
      securityLog().record({
        type: "PERMISSION_REQUESTED",
        permission,
        reason: `denied: ${decision.reason}`,
        origin: url.length > 0 ? safeOrigin(url) : "unknown",
        webContentsId: webContents?.id,
      });
    }
    // Always call back. An Electron permission request that is never answered
    // leaves the page's promise pending forever, which is a hang, not a denial.
    callback(decision.granted);
  };

  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    handleRequest(
      contents as WebContents | undefined,
      permission,
      callback,
      details as { mediaTypes?: unknown } | undefined,
    );
  });

  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    // Same three-step resolution as the request handler, because the check
    // handler had been left on `contents.getURL()` when the request handler was
    // fixed — so a cross-origin frame asking "may I?" got a correct answer while
    // the flow that decides "you may" still saw the top-level Discord origin.
    // The two paths have to agree or the stricter one is decorative.
    const url = resolvingUrl(contents, details?.requestingUrl, requestingOrigin, details);
    return decidePermission(permission, url).granted;
  });

  // Set last: both handlers are live, so a second call is a no-op rather than a
  // partially-applied duplicate.
  installed = true;
}

/** Diagnostic for the Security Center. Safe before the app is ready. */
export function permissionHandlersActive(): boolean {
  return installed;
}

function safeOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "invalid";
  }
}

/** Diagnostic for the Security Center. */
export function describePermissionPolicy(): { allowed: string[]; denied: Record<string, string> } {
  return { allowed: [...ALLOWED_PERMISSIONS].sort(), denied: { ...DENIED_WITH_REASON } };
}
