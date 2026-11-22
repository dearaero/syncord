/**
 * Trusted Discord origins — the single source of truth for "is this page ours?".
 *
 * Why this is an exact/suffix match and never `includes()`:
 *   "https://discord.com.evil.com".includes("discord.com") === true
 * A single substring test is the most common way a client ends up handing its
 * privileged bridge to an attacker who owns a lookalike domain, so substring
 * matching is banned project-wide. `hostnameMatches()` in ./url is the only
 * comparison primitive and it understands exactly `host` and `*.host`.
 */
import { hostnameMatches, normalizeHostname, parseUrl } from "./url";

/**
 * Registrable domains owned by Discord. Anything under these is trusted.
 *
 * `discordapp.com` is the legacy CDN/API domain and is still referenced by
 * older Discord builds and by `media.discordapp.net`. `discord.co` is Discord
 * Co (the mobile spin-off) and is *not* part of the desktop client, so it is
 * intentionally absent.
 */
export const TRUSTED_DISCORD_DOMAINS = [
  "discord.com",
  "discordapp.com",
] as const;

/**
 * Hosts the desktop client is actually served from. Used for documentation,
 * for the Security Center UI, and as the initial set of window-open
 * allowances. Trust checking for the *privileged bridge* uses only
 * TRUSTED_DISCORD_DOMAINS, so CDN asset hosts never get the bridge.
 */
export const TRUSTED_DISCORD_HOSTNAMES = [
  "discord.com",
  "canary.discord.com",
  "ptb.discord.com",
  "discordapp.com",
] as const;

/**
 * Subresource hosts Discord legitimately loads from (images, media, fonts).
 * These are *not* origins: no page here ever receives `SyncordNative`, and
 * allowing one as a window-open target would let any file in the media bucket
 * open a privileged window. Used only by the egress/CSP guidance in Phase 5.
 */
export const DISCORD_ASSET_HOSTS = [
  "cdn.discordapp.com",
  "media.discordapp.net",
  "images-ext-1.discordapp.net",
  "fonts.discord.com",
] as const;

export function isAssetHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  for (const asset of DISCORD_ASSET_HOSTS) {
    if (host === asset || hostnameMatches(host, asset)) return true;
  }
  return false;
}

/** The only scheme a trusted Discord page may use. */
export const TRUSTED_SCHEME = "https:";

/** Shape accepted by `isTrustedDiscordOrigin` — matches `Location` closely. */
export type OriginLike = {
  protocol: string;
  hostname: string;
  port?: string;
};

/**
 * Hostname is under a Discord-owned domain.
 *
 * Test contract (Phase 0):
 *   discord.com ✓   canary.discord.com ✓   ptb.discord.com ✓   foo.discord.com ✓
 *   discord.com.evil.com ✗   evil-discord.com ✗   notdiscord.com ✗
 */
export function isTrustedDiscordHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (host.length === 0) return false;
  // Subdomain matching would otherwise sweep the CDN and media buckets in with
  // the app origins. Those serve user-uploaded bytes, so a page loaded from one
  // must never receive the privileged bridge.
  if (isAssetHost(host)) return false;
  for (const domain of TRUSTED_DISCORD_DOMAINS) {
    if (hostnameMatches(host, domain)) return true;
  }
  return false;
}

/**
 * Full origin check: https scheme + Discord-owned hostname + no odd port.
 *
 * A non-default port means the request went to an attacker-controlled listener
 * on a name we trust (e.g. a local HTTPS proxy squatting on `discord.com:8443`),
 * so only the scheme default is accepted. Popout/utility windows inherit the
 * same rule.
 */
export function isTrustedDiscordOrigin(origin: OriginLike | string | null | undefined): boolean {
  if (origin === null || origin === undefined) return false;

  if (typeof origin === "string") {
    const parsed = parseUrl(origin);
    if (parsed === null) return false;
    if (parsed.protocol !== TRUSTED_SCHEME) return false;
    if (parsed.port.length > 0) return false;
    return isTrustedDiscordHostname(parsed.hostname);
  }

  if (typeof origin !== "object") return false;
  if (origin.protocol !== TRUSTED_SCHEME) return false;
  if (typeof origin.hostname !== "string") return false;
  if (typeof origin.port === "string" && origin.port.length > 0) return false;
  return isTrustedDiscordHostname(origin.hostname);
}

/**
 * Same-origin check used to stop a trusted page from being navigated sideways.
 * Compared against the main Discord document's own URL.
 */
export function isSameOrigin(a: string, b: string): boolean {
  const left = parseUrl(a);
  const right = parseUrl(b);
  if (left === null || right === null) return false;
  return (
    left.protocol === right.protocol &&
    left.hostname === right.hostname &&
    left.port === right.port
  );
}

/** Short, log-safe origin string. Never includes credentials or path. */
export function describeOrigin(raw: unknown): string {
  const parsed = parseUrl(raw);
  if (parsed === null) return "invalid";
  return `${parsed.protocol}//${parsed.host}${parsed.port.length > 0 ? `:${parsed.port}` : ""}`;
}
