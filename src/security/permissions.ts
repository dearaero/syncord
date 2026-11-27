/**
 * Plugin permission model.
 *
 * Design rules baked into the types and enforced by `validatePluginPermissions`:
 *
 *  - Default deny. An absent permission is a denial, not a fallback.
 *  - No wildcard. `network: ["*"]` is a *parse error*, not a feature, because a
 *    single wildcard in one plugin collapses the whole policy.
 *  - Script execution is not expressible. There is no `script` permission; remote
 *    JS is blocked in Phase 10 and there is no field that could re-enable it.
 *  - Filesystem is a closed list of capability names, never raw paths.
 */

export const NETWORK_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;
export type NetworkMethod = (typeof NETWORK_METHODS)[number];

export function isNetworkMethod(value: string): value is NetworkMethod {
  return (NETWORK_METHODS as readonly string[]).includes(value.toUpperCase());
}

/** One host (+ optional method set) a plugin may talk to. */
export type NetworkPermission = {
  /**
   * Exact hostname (`api.example.com`) or an explicit subdomain wildcard
   * (`*.discord.com`).
   *
   * A bare hostname is **exact**: it does not cover subdomains. That is not the
   * same rule as the trusted-origin check, where `discord.com` legitimately
   * covers the whole domain because one organisation owns it — the two are
   * separate helpers on purpose (see `permissionHostMatches`). `"*"`, bare
   * `"*.<tld>"` and public-suffix wildcards like `"*.co.uk"` are rejected.
   */
  host: string;
  /** Uppercase methods. Omitted ⇒ all methods the policy allows. */
  methods?: NetworkMethod[];
  /**
   * Optional path allowlist. A leading `/` is required; exact prefix match.
   * `/api/webhooks/` is what Phase 6 keys off for the webhook guard.
   */
  paths?: string[];
};

/** Capability names exposed on `ctx.native`. Anything else is rejected. */
export const NATIVE_CAPABILITIES = [
  "syncord-drop",
  "popout-chats",
  "screen-recording",
  "ecosystem-badges",
  /**
   * Notification Island: read the signed-in user's own ecosystem profile (SP
   * balance, owned badges) and look up which friends use Syncord. Read-only;
   * the context gates it to the `notification-island` identity.
   */
  "ecosystem-profile",
  /** Time Machine: copy a rectangle of the calling Discord page to the clipboard. */
  "chat-snapshot",
  /**
   * Ask the main process to solve one hCaptcha challenge for a Discord page.
   *
   * A capability rather than a `network` permission because the solver call
   * carries a paid credential the plugin does not hold: the broker forbids
   * plugin-supplied `Authorization` headers and blocks `api_key`-shaped fields
   * in an outbound body, which is the correct answer to a plugin asking for a
   * third-party credential, not an obstacle to route around.
   */
  "captcha-solve",
  "app-version",
  "clipboard-write",
  "open-external",
  "show-in-folder",
] as const;
export type NativeCapability = (typeof NATIVE_CAPABILITIES)[number];

/** Discord data classes a plugin declares it needs. Informational + audited. */
export const DISCORD_STORES = [
  "message",
  "channel",
  "guild",
  "user",
  "voice-state",
  "typing",
  "quest",
  "profile",
  "read-state",
] as const;

export const DISCORD_ACTIONS = [
  "message-send",
  "message-edit",
  "message-delete",
  /** Acknowledging read state for channels, DMs and whole guilds. */
  "read-ack",
  "voice-join",
  "voice-mute",
  "voice-deafen",
  "camera",
  "screen-share",
] as const;

export type PluginPermissions = {
  /**
   * Outbound HTTP through the Network Broker. Default: `[]` (nothing).
   * There is intentionally no way to express "any host".
   */
  network?: NetworkPermission[];
  /**
   * Separate, opt-in permission for `POST/PUT/PATCH /api/webhooks/…` on a
   * Discord-owned host (Phase 6). Never granted by default to any plugin.
   */
  webhookSend?: boolean;
  /** Subset of `SyncordNative` a plugin may reach through `ctx.native`. */
  native?: NativeCapability[];
  /** Read access to Discord's Flux stores. */
  discordStores?: string[];
  /** Mutating Discord actions. */
  discordActions?: string[];
  /** Monkeypatch Discord internals via `ctx.patch`. */
  webpackPatch?: boolean;
  /** Load remote stylesheets / images. Does NOT imply script execution. */
  media?: boolean;
  /** Write to the system clipboard. */
  clipboard?: boolean;
  /** Read/write user data under the Syncord profile. No raw paths. */
  userData?: boolean;
};

export const EMPTY_PERMISSIONS: PluginPermissions = Object.freeze({});


/**
 * Two-label public suffixes: a wildcard anchored on one of these is a grant over
 * an entire country's (or a whole TLD's) registration space.
 *
 * ## Why a short list rather than a real public-suffix list
 *
 * The correct instrument is the Public Suffix List, and shipping a 300 KB
 * dependency plus a periodic update path to tighten one validator is not a
 * proportionate change. This is the small, safe substitute:
 *
 *  - the list is **deny-shaped and conservative** — anything not named is
 *    accepted, which is the status quo, so nothing that worked stops working;
 *  - `*.co.uk` and friends are the case that actually bit, because a
 *    "must contain a dot" rule accepts `co.uk` exactly as readily as
 *    `discord.com`;
 *  - a plugin that wants `*.example.co.uk` can list its hosts explicitly, and
 *    no built-in plugin needs a wildcard at all (no built-in integration makes
 *    a request, and every plugin names its hosts outright).
 *
 * The honest framing: this closes the known-bad case cheaply and is **not** a
 * complete public-suffix implementation. A plugin author can still name a
 * suffix that is not listed here. That residual is recorded in
 * `SECURITY_ARCHITECTURE.md` rather than papered over.
 */
const PUBLIC_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp",
  "co.nz", "net.nz", "org.nz", "govt.nz",
  "com.br", "net.br", "org.br", "gov.br",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
  "co.in", "net.in", "org.in", "gen.in", "firm.in",
  "co.za", "org.za", "net.za", "gov.za",
  "com.mx", "org.mx", "com.ar", "com.tr", "com.sg", "com.hk", "com.tw",
  "com.ua", "com.pl", "com.my", "co.id", "co.th", "com.ph", "com.vn",
  "co.ke", "co.il", "com.sa", "com.eg",
]);

/**
 * The single host rule, shared by every path that grants network reach.
 *
 * ## Why one function and not two
 *
 * There are three places a host can enter the policy — a declared plugin
 * permission, a user-approved grant, and a grant restored from disk — and they
 * are all the *same decision*: may this string be used as a reach target? They
 * had two implementations, and they disagreed: the declared path rejected
 * `*.co.uk` while the grant path accepted it, so a plugin that could not declare
 * the wildcard could be handed it through the grant flow. Two validators for one
 * concept is how a policy drifts, and the test suite had grown to encode the
 * disagreement.
 *
 * `src/security/permissions.ts` rather than the main-process store, because
 * `src/security/` is dependency-free and is what every realm already bundles.
 *
 * Returns a reason, not a boolean: the caller writes the rejection into a log or
 * an error message, and "invalid network host" is not something a user can act on.
 */
export type HostVerdict = { ok: true; host: string } | { ok: false; reason: string };

export function validateNetworkHost(raw: unknown): HostVerdict {
  if (typeof raw !== "string") return { ok: false, reason: "host must be a string" };
  const host = raw.toLowerCase().trim();
  if (host.length === 0) return { ok: false, reason: "host is empty" };
  if (host.length > 253) return { ok: false, reason: "host is longer than 253 characters" };
  if (host === "*" || host === "*.*") {
    return { ok: false, reason: "a bare wildcard host is not allowed — list explicit hosts" };
  }
  if (host.includes("..")) return { ok: false, reason: "host contains a traversal segment" };
  // A scheme, path, query, fragment or userinfo section in a host is never a
  // host. Rejecting rather than stripping: silently "fixing" a malformed value
  // is how a surprising grant becomes a real one.
  if (/[:/?#@]/.test(host)) return { ok: false, reason: "host is not a bare hostname" };

  if (host.startsWith("*.")) {
    const base = host.slice(2);
    if (!base.includes(".")) {
      return {
        ok: false,
        reason: `"${host}" covers a whole top-level domain — use an explicit host or "*.example.com"`,
      };
    }
    if (PUBLIC_SUFFIXES.has(base)) {
      return {
        ok: false,
        reason: `"${host}" is a public suffix — it covers an entire registration space`,
      };
    }
    if (base.split(".").length < 2) {
      return { ok: false, reason: `"${host}" is too broad to be a wildcard target` };
    }
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(base)) {
      return { ok: false, reason: `"${host}" is not a well-formed wildcard host` };
    }
    return { ok: true, host };
  }

  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) {
    return { ok: false, reason: `"${host}" is not a well-formed hostname` };
  }
  return { ok: true, host };
}

/**
 * Reject anything that could widen a permission beyond an explicit allowlist.
 * Throws with a precise message: a malformed declaration is a programming error
 * and must be loud, not silently coerced to "deny everything later".
 */
export function validatePluginPermissions(id: string, perms: unknown): PluginPermissions {
  // A plugin that declares nothing gets the fully-normalized empty object, not
  // `undefined`, so downstream code can rely on the shape.
  if (perms === undefined || perms === null) return normalizePermissions({});
  if (typeof perms !== "object" || Array.isArray(perms)) {
    throw new Error(`Plugin "${id}": permissions must be a plain object`);
  }
  const input = perms as Record<string, unknown>;

  const network: NetworkPermission[] = [];
  const rawNetwork = input.network;
  if (rawNetwork !== undefined) {
    if (!Array.isArray(rawNetwork)) {
      throw new Error(`Plugin "${id}": permissions.network must be an array`);
    }
    if (rawNetwork.length > 32) {
      throw new Error(`Plugin "${id}": at most 32 network permissions`);
    }
    for (const entry of rawNetwork) {
      network.push(validateNetworkPermission(id, entry));
    }
  }

  const native: NativeCapability[] = [];
  if (input.native !== undefined) {
    if (!Array.isArray(input.native)) {
      throw new Error(`Plugin "${id}": permissions.native must be an array`);
    }
    for (const cap of input.native) {
      if (typeof cap !== "string" || !(NATIVE_CAPABILITIES as readonly string[]).includes(cap)) {
        throw new Error(`Plugin "${id}": unknown native capability "${String(cap)}"`);
      }
      native.push(cap as NativeCapability);
    }
  }

  for (const key of ["discordStores", "discordActions"] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      throw new Error(`Plugin "${id}": permissions.${key} must be an array of strings`);
    }
  }

  for (const key of ["webhookSend", "webpackPatch", "media", "clipboard", "userData"] as const) {
    const value = input[key];
    if (value !== undefined && typeof value !== "boolean") {
      throw new Error(`Plugin "${id}": permissions.${key} must be a boolean`);
    }
  }

  return normalizePermissions(input, network, native);
}

/**
 * Produce the canonical, fully-populated permission object.
 *
 * Everything absent collapses to an empty list, never to a permissive default.
 * Callers therefore never have to write `perms.network?.[0]` defensively, and
 * a missing key can never be mistaken for "allowed".
 */
function normalizePermissions(
  input: Record<string, unknown>,
  network: NetworkPermission[] = [],
  native: NativeCapability[] = [],
): PluginPermissions {
  return {
    network,
    ...(input.webhookSend === true ? { webhookSend: true } : {}),
    native,
    discordStores: (input.discordStores as string[] | undefined) ?? [],
    discordActions: (input.discordActions as string[] | undefined) ?? [],
    ...(input.webpackPatch === true ? { webpackPatch: true } : {}),
    ...(input.media === true ? { media: true } : {}),
    ...(input.clipboard === true ? { clipboard: true } : {}),
    ...(input.userData === true ? { userData: true } : {}),
  };
}

function validateNetworkPermission(id: string, entry: unknown): NetworkPermission {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`Plugin "${id}": network permission must be an object`);
  }
  const raw = entry as Record<string, unknown>;
  if (typeof raw.host !== "string" || raw.host.length === 0) {
    throw new Error(`Plugin "${id}": network permission requires a host`);
  }
  // The single shared host rule. This used to be a chain of local regexes here
  // plus a second, looser copy in the grant store, and the two disagreed about
  // `*.co.uk`.
  const hostVerdict = validateNetworkHost(raw.host);
  if (!hostVerdict.ok) {
    throw new Error(`Plugin "${id}": ${hostVerdict.reason} (got "${String(raw.host)}")`);
  }
  const host = hostVerdict.host;

  const methods: NetworkMethod[] = [];
  if (raw.methods !== undefined) {
    if (!Array.isArray(raw.methods)) {
      throw new Error(`Plugin "${id}": network permission methods must be an array`);
    }
    for (const method of raw.methods) {
      if (typeof method !== "string" || !isNetworkMethod(method)) {
        throw new Error(`Plugin "${id}": unsupported HTTP method "${String(method)}"`);
      }
      const upper = method.toUpperCase() as NetworkMethod;
      if (!methods.includes(upper)) methods.push(upper);
    }
    if (methods.length === 0) {
      throw new Error(`Plugin "${id}": network permission methods must not be empty`);
    }
  }

  const paths: string[] = [];
  if (raw.paths !== undefined) {
    if (!Array.isArray(raw.paths)) {
      throw new Error(`Plugin "${id}": network permission paths must be an array`);
    }
    for (const entryPath of raw.paths) {
      if (typeof entryPath !== "string" || !entryPath.startsWith("/")) {
        throw new Error(`Plugin "${id}": network permission path must start with "/"`);
      }
      if (entryPath.includes("..")) {
        throw new Error(`Plugin "${id}": network permission path must not contain ".."`);
      }
      paths.push(entryPath);
    }
  }

  return { host, ...(methods.length > 0 ? { methods } : {}), ...(paths.length > 0 ? { paths } : {}) };
}

/** Human-readable one-liner for the Security Center. */
export function summarizePermissions(perms: PluginPermissions): string {
  const parts: string[] = [];
  const hosts = new Set((perms.network ?? []).map((entry) => entry.host));
  if (hosts.size > 0) parts.push(`network:${[...hosts].join(", ")}`);
  if (perms.webhookSend) parts.push("discord:webhook-send");
  if (perms.webpackPatch) parts.push("webpack-patch");
  if (perms.media) parts.push("media");
  if (perms.clipboard) parts.push("clipboard");
  if (perms.userData) parts.push("user-data");
  if ((perms.native ?? []).length > 0) parts.push(`native:${(perms.native ?? []).join(",")}`);
  if ((perms.discordStores ?? []).length > 0) parts.push(`stores:${(perms.discordStores ?? []).length}`);
  if ((perms.discordActions ?? []).length > 0) parts.push(`actions:${(perms.discordActions ?? []).length}`);
  return parts.length > 0 ? parts.join(" · ") : "no extra permissions";
}
