/**
 * Network request policy — pure, shared by the main-process broker (enforcement)
 * and the renderer (pre-flight feedback only).
 *
 * Everything here is default-deny. A request is only describable as allowed if
 * a `NetworkPermission` matched it, and even then the SSRF/limits/header checks
 * below can veto it. A permission is a *necessary* condition, never sufficient.
 */
import type { NetworkMethod, NetworkPermission } from "./permissions";
import { isNetworkMethod } from "./permissions";
import { hostnameMatches, isPrivateOrReservedHost, normalizeHostname, parseUrl, type CheckedUrl } from "./url";

export const NETWORK_LIMITS = {
  /** Longest URL we will even look at. */
  maxUrlLength: 2048,
  maxHeaderCount: 24,
  maxHeaderNameLength: 128,
  maxHeaderValueLength: 2048,
  maxHeadersTotalLength: 8192,
  maxBodyLength: 256 * 1024,
  /** Wall-clock budget for one request including redirects. */
  timeoutMs: 15_000,
  maxRedirects: 3,
  /** Response bytes read into memory before we abort the transfer. */
  maxResponseBytes: 2 * 1024 * 1024,
  /** Only https. Plain http is a downgrade an attacker can observe. */
  allowedProtocols: ["https:"] as const,
} as const;

/**
 * Headers a plugin may never set, regardless of permission.
 *
 * The first block is credential/exfiltration plumbing: allowing a plugin to
 * attach `Authorization` or `Cookie` is how a secret leaves the machine. The
 * second block is request-smuggling / connection-reuse surface.
 */
const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "cookie2",
  "origin",
  "referer",
  "host",
  "connection",
  "upgrade",
  "transfer-encoding",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "expect",
  "content-length",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded",
  // Discord's own client-fingerprint headers.
  //
  // These are in the session guard's credential list (`CREDENTIAL_HEADERS` in
  // src/main/security/session.ts) but were missing here, so a plugin holding a
  // broad host permission could attach them to a request to a third party. They
  // are not the token, so this is not the `Authorization` case — but they are
  // Discord client identity data, a plugin has no legitimate reason to send them
  // through the broker, and the two layers should not disagree about what counts
  // as credential plumbing. No built-in plugin sets either header.
  "x-super-properties",
  "x-fingerprint",
]);

/** `Sec-*` and our own control plane. Matched by prefix, case-insensitively. */
const FORBIDDEN_HEADER_PREFIXES = [
  "sec-",
  "proxy-",
  "x-forwarded-",
  "x-syncord-",
  "x-dion-",
].map((prefix) => prefix.toLowerCase());

/**
 * Headers Syncord itself sets. A plugin cannot override or remove them, and
 * it cannot set them itself.
 */
export const BROKER_CONTROL_HEADERS = {
  /** Marks a request as broker-originated so the session egress guard ignores it. */
  marker: "X-Syncord-Network",
  markerValue: "broker",
  contentType: "content-type",
  accept: "accept",
  userAgent: "user-agent",
} as const;

export type NetworkRequestPlan = {
  url: CheckedUrl;
  method: NetworkMethod;
  /** Headers after filtering. Never contains anything from the forbidden list. */
  headers: Record<string, string>;
  body: string | undefined;
};

export type NetworkDecision =
  | { allowed: true; plan: NetworkRequestPlan }
  | { allowed: false; reason: string; code: NetworkDenyCode };

export type NetworkDenyCode =
  | "malformed"
  | "protocol"
  | "url-too-long"
  | "private-host"
  | "no-permission"
  | "method-not-allowed"
  | "path-not-allowed"
  | "header-forbidden"
  | "header-limit"
  | "body-too-large"
  | "webhook-forbidden"
  | "lockdown"
  | "rate-limited";

/** Discord webhook endpoint prefix (Phase 6). */
export const DISCORD_WEBHOOK_PATH = "/api/webhooks/";
const WEBHOOK_METHODS = new Set<NetworkMethod>(["POST", "PUT", "PATCH"]);

/** Hosts Discord itself serves API/webhook traffic from. */
const DISCORD_API_HOSTS = ["discord.com", "discordapp.com"] as const;

export function isDiscordOwnedHost(hostname: string): boolean {
  for (const domain of DISCORD_API_HOSTS) {
    if (hostnameMatches(hostname, domain)) return true;
  }
  return false;
}

/**
 * Reduce a path to the form a server would actually route.
 *
 * The WHATWG URL parser resolves `.` and `..` segments but deliberately leaves
 * percent-encoding and duplicate slashes alone — those are meaningful to the
 * server, not to the client. That gap is the whole problem here: a `startsWith`
 * test on `url.pathname` sees `/api/%77ebhooks/…` as an ordinary path, while
 * Discord's edge decodes `%77` to `w` and routes it to the webhook handler.
 *
 * Measured bypasses of the previous literal-prefix test, all of which reached
 * the webhook endpoint while reporting `webhook-forbidden: false`:
 *
 *     /api/%77ebhooks/1/tok
 *     /api/%77%65%62%68%6f%6f%6b%73/1/tok      (fully encoded)
 *     /%61pi/webhooks/1/tok
 *     /api/webhooks%2f1/tok
 *     //api/webhooks/1/tok
 *     /api/WEBHOOKS/1/tok
 *
 * So: decode repeatedly (bounded, to catch double-encoding), collapse repeated
 * slashes, and compare case-insensitively. The last one is a superset of what
 * Discord currently routes, which is the safe direction: a path that only looks
 * like a webhook under case folding is refused, and a path that Discord does not
 * serve was never usable for exfiltration anyway.
 *
 * Decoding is bounded in both rounds and output length. This runs on untrusted
 * input from the renderer, and an unbounded `decodeURIComponent` loop is a cheap
 * DoS.
 */
export function normalizePathForMatching(pathname: string): string {
  let text = pathname;
  for (let round = 0; round < 3; round += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(text);
    } catch {
      // A malformed escape is not a webhook; leave it as it is. `decodeURIComponent`
      // throws on a lone `%`, and an exception here would be an availability bug
      // in a function that runs on the request path.
      break;
    }
    if (decoded === text) break;
    text = decoded;
  }
  // `/ /api/…` and `/api//webhooks/…` both route to the same handler on most
  // edge stacks, and both defeat a literal prefix test.
  text = text.replace(/\/{2,}/g, "/");
  return text.length > 4096 ? text.slice(0, 4096) : text;
}

export function isDiscordWebhookUrl(url: CheckedUrl): boolean {
  if (!isDiscordOwnedHost(url.hostname)) return false;
  return normalizePathForMatching(url.pathname).toLowerCase().startsWith(DISCORD_WEBHOOK_PATH);
}

/**
 * A JSON Web Token or `Authorization`-looking value in a header name we did not
 * forbid. Catches plugins trying to smuggle credentials through a custom header.
 * Detection only — the primary control is the host allowlist (see
 * `src/security/dlp.ts` for the payload side).
 */
export function looksLikeCredentialHeader(name: string, value: string): boolean {
  const lower = name.toLowerCase();
  if (lower.includes("token") || lower.includes("auth") || lower.includes("secret") || lower.includes("api-key")) {
    return true;
  }
  return /^bearer\s+\S{6,}/i.test(value) || /^eyJ[\w-]{8,}\./.test(value);
}

/** Does `rule` authorize this exact host/method/path triple? */
export function matchesNetworkPermission(
  rule: NetworkPermission,
  url: CheckedUrl,
  method: NetworkMethod,
): boolean {
  // `permissionHostMatches`, not `hostnameMatches` — see the note there. The
  // trusted-origin helper must keep its suffix semantics; a plugin grant must
  // not inherit them.
  if (!permissionHostMatches(url.hostname, rule.host)) return false;

  if (rule.methods !== undefined) {
    const allowed = rule.methods.some((candidate) => candidate.toUpperCase() === method);
    if (!allowed) return false;
  }

  if (rule.paths !== undefined && rule.paths.length > 0) {
    const pathOk = rule.paths.some((prefix) => url.pathname.startsWith(prefix));
    if (!pathOk) return false;
  }

  return true;
}

/** Every rule that authorizes this request. Empty ⇒ deny. */
export function findMatchingPermissions(
  permissions: readonly NetworkPermission[],
  url: CheckedUrl,
  method: NetworkMethod,
): NetworkPermission[] {
  return permissions.filter((rule) => matchesNetworkPermission(rule, url, method));
}

function checkHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): { ok: true; headers: Record<string, string> } | { ok: false; reason: string; code: NetworkDenyCode } {
  const out: Record<string, string> = {};
  if (headers === undefined) return { ok: true, headers: out };

  const entries = Object.entries(headers);
  if (entries.length > NETWORK_LIMITS.maxHeaderCount) {
    return { ok: false, reason: "too many headers", code: "header-limit" };
  }

  let total = 0;
  for (const [rawName, rawValue] of entries) {
    if (typeof rawName !== "string" || typeof rawValue !== "string") {
      return { ok: false, reason: "header name/value must be strings", code: "header-forbidden" };
    }
    const name = rawName.trim();
    const lower = name.toLowerCase();
    if (name.length === 0 || name.length > NETWORK_LIMITS.maxHeaderNameLength) {
      return { ok: false, reason: "invalid header name", code: "header-forbidden" };
    }
    if (rawValue.length > NETWORK_LIMITS.maxHeaderValueLength) {
      return { ok: false, reason: "header value too long", code: "header-limit" };
    }
    // eslint-disable-next-line no-control-regex
    if (/[\r\n\u0000]/.test(name) || /[\r\n\u0000]/.test(rawValue)) {
      return { ok: false, reason: "header contains control characters", code: "header-forbidden" };
    }
    total += name.length + rawValue.length;
    if (total > NETWORK_LIMITS.maxHeadersTotalLength) {
      return { ok: false, reason: "headers exceed total size limit", code: "header-limit" };
    }

    if (FORBIDDEN_HEADERS.has(lower)) {
      return { ok: false, reason: `header "${lower}" is not permitted`, code: "header-forbidden" };
    }
    if (FORBIDDEN_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
      return { ok: false, reason: `header "${lower}" is not permitted`, code: "header-forbidden" };
    }
    // Reject anything else that smells like a credential carrier, unless the
    // plugin explicitly registered a value-free placeholder.
    if (looksLikeCredentialHeader(name, rawValue) && rawValue !== "") {
      return { ok: false, reason: `header "${lower}" may carry credentials`, code: "header-forbidden" };
    }

    out[name] = rawValue;
  }

  return { ok: true, headers: out };
}

export type NetworkPolicyOptions = {
  /** Declared permissions for the calling plugin. */
  permissions: readonly NetworkPermission[];
  /** Separate opt-in for POST/PUT/PATCH to /api/webhooks/. */
  webhookSend: boolean;
  /** Emergency Lockdown / Safe Mode hard-stop (Phases 13–14). */
  networkBlocked?: boolean;
  /** Pre-computed method; only used for the error message when absent. */
  method?: string;
};

/**
 * Full pre-flight decision. Pure and synchronous so it can be unit tested
 * exhaustively and reused by the broker before it touches the network.
 */
export function evaluateNetworkRequest(
  rawUrl: unknown,
  method: unknown,
  headers: Readonly<Record<string, string>> | undefined,
  body: unknown,
  options: NetworkPolicyOptions,
): NetworkDecision {
  if (options.networkBlocked === true) {
    return { allowed: false, reason: "network access is disabled (lockdown)", code: "lockdown" };
  }

  // Length is checked *before* parsing so an oversized URL is reported as such
  // rather than as a generic parse failure.
  if (typeof rawUrl === "string" && rawUrl.length > NETWORK_LIMITS.maxUrlLength) {
    return { allowed: false, reason: "url too long", code: "url-too-long" };
  }
  const url = parseUrl(rawUrl);
  if (url === null) {
    return { allowed: false, reason: "malformed url", code: "malformed" };
  }
  if (!NETWORK_LIMITS.allowedProtocols.includes(url.protocol as "https:")) {
    return { allowed: false, reason: `protocol ${url.protocol} is not allowed`, code: "protocol" };
  }
  if (url.hasCredentials) {
    return { allowed: false, reason: "url credentials are not allowed", code: "malformed" };
  }
  if (isPrivateOrReservedHost(url.hostname)) {
    return {
      allowed: false,
      reason: `host ${url.hostname} is loopback/private/reserved`,
      code: "private-host",
    };
  }

  const requestedMethod = typeof method === "string" ? method.toUpperCase() : "GET";
  if (!isNetworkMethod(requestedMethod)) {
    return { allowed: false, reason: `method ${requestedMethod} is not allowed`, code: "method-not-allowed" };
  }
  const verb = requestedMethod;

  const headerCheck = checkHeaders(headers);
  if (!headerCheck.ok) {
    return { allowed: false, reason: headerCheck.reason, code: headerCheck.code };
  }

  let payload: string | undefined;
  if (body !== undefined && body !== null) {
    if (typeof body !== "string") {
      return { allowed: false, reason: "body must be a string", code: "malformed" };
    }
    if (body.length > NETWORK_LIMITS.maxBodyLength) {
      return { allowed: false, reason: "body exceeds size limit", code: "body-too-large" };
    }
    payload = body;
  }

  const matches = findMatchingPermissions(options.permissions, url, verb);
  if (matches.length === 0) {
    return {
      allowed: false,
      reason: `no network permission for ${url.hostname} ${verb}`,
      code: "no-permission",
    };
  }

  // Phase 6: webhook exfiltration is classified separately so a broad
  // "*.discord.com" grant cannot silently become a write-only exfil channel.
  // Only *write* verbs are gated: a GET cannot move data out, and the read path
  // is the one Discord's own UI uses.
  if (isDiscordWebhookUrl(url) && WEBHOOK_METHODS.has(verb)) {
    if (options.webhookSend !== true) {
      return {
        allowed: false,
        reason: "plugin lacks the discord:webhook-send permission",
        code: "webhook-forbidden",
      };
    }
  }

  return {
    allowed: true,
    plan: {
      url,
      method: verb,
      headers: {
        ...headerCheck.headers,
        accept: headerCheck.headers.accept ?? "application/json, text/plain;q=0.5, */*;q=0.1",
        [BROKER_CONTROL_HEADERS.marker]: BROKER_CONTROL_HEADERS.markerValue,
      },
      body: payload,
    },
  };
}

/**
 * Does `rule.host` — as a *plugin network permission* — cover this hostname?
 *
 * ## Why this is not `hostnameMatches`
 *
 * `hostnameMatches` is shared with `src/security/origins.ts`, where suffix
 * matching is **correct**: Discord owns `discord.com` and every subdomain of it,
 * so `foo.discord.com` must be trusted. Changing that helper to be exact would
 * break the trusted-origin gate, which is a much more important control than the
 * one being fixed here.
 *
 * The semantics genuinely differ, so they live in different functions:
 *
 *  - **Trusted origin** — a *domain ownership* question. `discord.com` means the
 *    whole domain, because one organisation owns it.
 *  - **Plugin permission** — a *reachability* question. A plugin granted
 *    `api.example.com` was granted that host, not every host beneath it. Under
 *    the shared helper, `api.example.com` also matched
 *    `evil.api.example.com` and `attacker-controlled.api.example.com`, so a
 *    grant quietly covered hosts the author never wrote down and the user never
 *    saw. The doc comment on `NetworkPermission.host` already said "Exact
 *    hostname"; the implementation said otherwise.
 *
 * A wildcard is therefore **explicit**: `*.example.com` for subdomains, and
 * nothing else. Omitting the wildcard is no longer a silent widening.
 */
export function permissionHostMatches(hostname: string, ruleHost: string): boolean {
  const host = normalizeHostname(hostname);
  const rule = normalizeHostname(ruleHost);
  if (host.length === 0 || rule.length === 0) return false;

  if (rule.startsWith("*.")) {
    const base = rule.slice(2);
    if (base.length === 0) return false;
    return host.endsWith(`.${base}`);
  }
  return host === rule;
}
