/**
 * The Syncord Network Broker.
 *
 * This module replaces the old `HTTP_FETCH` pass-through, which handed the
 * renderer an unrestricted `fetch` in the main process: any URL, any method,
 * any headers (including `Authorization` and `Cookie`), any body, no size
 * limits, and `redirect: follow` — so an allowlisted host could bounce a request
 * to an attacker. That was the single largest exfiltration path in the client.
 *
 * What replaced it:
 *
 *  1. **Identity.** Every call names a plugin id. The id must exist in a
 *     registry the renderer registered at boot, and the permissions the renderer
 *     declared for that id are the ones enforced here. Plugins cannot invent a
 *     host, a method, or a header.
 *  2. **Dedicated session.** Broker traffic runs on its own Electron session
 *     partition, not `session.defaultSession`. That has two effects: the broker
 *     has no access to Discord's cookies, and the egress guard installed in
 *     Phase 5 sees broker traffic as broker traffic instead of having to guess
 *     whether a request came from Discord's own code.
 *  3. **Policy.** `evaluateNetworkRequest` (src/security/networkPolicy) applies
 *     protocol, SSRF, method, header, size and webhook rules *before* the
 *     socket opens.
 *  4. **Manual redirects.** `redirect: manual` plus a per-hop re-validation, so
 *     an allowed host cannot redirect us to a private address or a new domain.
 *  5. **Bounded responses.** The body is read with a byte cap; a hostile server
 *     cannot make main process allocate a gigabyte.
 *
 * Known limitation, stated plainly: the plugin registry is populated by the
 * renderer, so a plugin that has already compromised the page could declare
 * broader permissions for itself. Closing that requires the out-of-process
 * sandbox described in THIRD_PARTY_PLUGIN_SECURITY.md. What *is* enforced here
 * regardless of renderer state is the SSRF/header/limit layer, because those
 * decisions never depend on what the caller claims.
 */
import { app, session } from "electron";

import {
  evaluateNetworkRequest,
  isDiscordWebhookUrl,
  NETWORK_LIMITS,
} from "../../security/networkPolicy";
import { detectSecrets, dlpActionFor, summarizeFindings } from "../../security/dlp";
import type { NetworkMethod, NetworkPermission } from "../../security/permissions";
import { applyCredentials } from "./credentials";
import { securityLog } from "./core";
import { grantedNetworkPermissions, listGrants } from "./permissionStore";

/** Partition name for the broker's isolated session. */
const BROKER_PARTITION = "Syncord-broker";

/**
 * Per-plugin state the renderer registered at boot.
 * The broker is fail-closed: an unknown id has no entry, therefore no
 * permissions, therefore everything is denied.
 */
type PluginEntry = {
  permissions: NetworkPermission[];
  webhookSend: boolean;
  /** Set by Emergency Lockdown / Safe Mode. */
  blocked: boolean;
};

/**
 * Effective network permissions for a plugin: what it declared, plus what a
 * human explicitly approved through the Phase 4 prompt.
 *
 * Declared and granted are kept as separate lists so the Security Center can
 * show which hosts came from the plugin author and which from the user's own
 * decision. Only `network-connect` grants contribute here — a plugin granted
 * `image` for a host gets no broker permission for it, which is the category
 * separation the spec requires, enforced in code rather than in a comment.
 */
function effectivePermissions(pluginId: string, entry: PluginEntry): NetworkPermission[] {
  return [...entry.permissions, ...grantedNetworkPermissions(pluginId)];
}

const plugins = new Map<string, PluginEntry>();

/** Process-wide hard stop used by Safe Mode and Emergency Lockdown. */
let networkLockedDown = false;
const lockdownListeners=new Set<()=>void>();
export function onNetworkLockdown(listener:()=>void):()=>void{lockdownListeners.add(listener);return()=>lockdownListeners.delete(listener);}

export function setNetworkLockdown(locked: boolean, reason: string): void {
  networkLockedDown = locked;
  if(locked)for(const listener of lockdownListeners)try{listener();}catch{/* Continue enforcing the global stop. */}
  if (locked) {
    securityLog().record({ type: "LOCKDOWN_ENABLED", reason });
  }
}

export function isNetworkLockedDown(): boolean {
  return networkLockedDown;
}

/**
 * Register the plugins that exist and the permissions they declared.
 *
 * Called once with the full manifest. Replaces (rather than merges) the registry
 * so a stale permission cannot survive a plugin being removed.
 */
export function registerPluginManifest(entries: unknown): { accepted: number; rejected: string[] } {
  plugins.clear();
  const rejected: string[] = [];
  if (!Array.isArray(entries)) return { accepted: 0, rejected: ["manifest is not an array"] };

  for (const raw of entries) {
    if (!raw || typeof raw !== "object") {
      rejected.push("entry is not an object");
      continue;
    }
    const entry = raw as { id?: unknown; network?: unknown; webhookSend?: unknown };
    if (typeof entry.id !== "string" || entry.id.length === 0 || entry.id.length > 64) {
      rejected.push("entry has no usable id");
      continue;
    }
    if (!/^[a-z][a-z0-9-]*$/.test(entry.id)) {
      rejected.push(`invalid plugin id "${entry.id}"`);
      continue;
    }
    // `validatePluginPermissions` already rejects wildcards and bad hosts; we
    // re-run it here so a malformed renderer payload cannot reach the policy.
    let permissions: NetworkPermission[] = [];
    try {
      const { validatePluginPermissions } = require("../../security/permissions") as typeof import("../../security/permissions");
      permissions = validatePluginPermissions(entry.id, { network: entry.network }).network ?? [];
    } catch (err) {
      rejected.push(`${entry.id}: ${(err as Error).message}`);
      continue;
    }
    plugins.set(entry.id, {
      permissions,
      webhookSend: entry.webhookSend === true,
      blocked: false,
    });
  }
  return { accepted: plugins.size, rejected };
}

export function blockPluginNetwork(pluginId: string, blocked: boolean): void {
  const entry = plugins.get(pluginId);
  if (entry) entry.blocked = blocked;
}

/** Is this plugin's network access currently blocked? (Safe Mode / Lockdown) */
export function isNetworkBlockedFor(pluginId: string): boolean {
  return networkLockedDown || plugins.get(pluginId)?.blocked === true;
}

export function registeredPluginIds(): string[] {
  return [...plugins.keys()];
}

/**
 * Is this id a plugin the renderer actually registered?
 *
 * Exists so the IPC layer can ask the question without reaching into the
 * registry Map. The rate limiter needs the answer *before* it builds a bucket
 * key, and duplicating the check there is how the two drifted before.
 */
export function isPluginRegistered(pluginId: string): boolean {
  return plugins.has(pluginId);
}

export type BrokerRequest = {
  pluginId?: unknown;
  url?: unknown;
  method?: unknown;
  headers?: unknown;
  body?: unknown;
};

export type BrokerResponse = {
  ok: boolean;
  status: number;
  /** Truncated to NETWORK_LIMITS.maxResponseBytes. */
  text: string;
  /** True when the body hit the cap and was cut short. */
  truncated: boolean;
  /** Set when the broker refused before opening a socket. */
  blockedReason?: string;
};

let brokerSessionReady = false;
let cachedSession: Electron.Session | undefined;

/**
 * The broker's private session. Created on first use.
 *
 * `cache: false` keeps responses out of the HTTP cache, and the session has no
 * cookies and no Discord storage, so a broker request can never be authenticated
 * as the user even if a permission were somehow granted for a Discord host.
 *
 * `session.fromPartition` is only valid after `ready`, exactly like
 * `defaultSession`. This is only reached from a request handler, which is always
 * after ready, but the guard is here because a throw here would surface to the
 * user as an unexplained failed plugin request rather than as a startup fault.
 */
function brokerSession(): Electron.Session {
  if (cachedSession !== undefined) return cachedSession;

  if (!app.isReady()) {
    throw new Error("network broker is not available before the app is ready");
  }

  const partition = session.fromPartition(BROKER_PARTITION, { cache: false });
  cachedSession = partition;

  if (!brokerSessionReady) {
    brokerSessionReady = true;
    // No permissions of any kind for a session that only exists to make
    // allowlisted HTTP requests. (camera/mic/geolocation are meaningless here,
    // but a stray default-allow would be a real problem.)
    try {
      partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      partition.setPermissionCheckHandler(() => false);
    } catch (err) {
      console.warn("[Syncord][security] broker session hardening failed:", err);
    }
  }
  return partition;
}

function deny(code: string, reason: string, input: { pluginId?: string; host?: string; method?: string }): BrokerResponse {
  securityLog().record({
    type: code === "webhook-forbidden" ? "WEBHOOK_BLOCKED" : "NETWORK_BLOCKED",
    reason,
    pluginId: input.pluginId,
    host: input.host,
    method: input.method,
  });
  return { ok: false, status: 0, text: "", truncated: false, blockedReason: reason };
}

/**
 * Handle one broker request.
 *
 * The flow is: identity → per-request policy → permission → fetch → bounded read.
 * Every rejection path returns a typed denial and records an event; nothing
 * throws, because a throwing handler surfaces as an opaque renderer rejection.
 */
export async function brokerRequest(raw: unknown): Promise<BrokerResponse> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return deny("malformed", "network request must be an object", {});
  }
  const req = raw as BrokerRequest;

  const pluginId = typeof req.pluginId === "string" ? req.pluginId : "";
  if (pluginId.length === 0) {
    return deny("no-permission", "network request has no plugin identity", {});
  }

  const entry = plugins.get(pluginId);
  if (entry === undefined) {
    // Unknown plugin id. This is the fail-closed default that makes a spoofed
    // identity useless.
    return deny("no-permission", `plugin "${pluginId}" is not registered`, { pluginId });
  }

  const started = Date.now();
  const urlForLog = typeof req.url === "string" ? safeHost(req.url) : undefined;
  const methodForLog = typeof req.method === "string" ? req.method.toUpperCase() : "GET";

  const decision = evaluateNetworkRequest(req.url, req.method, req.headers as Record<string, string> | undefined, req.body, {
    permissions: effectivePermissions(pluginId, entry),
    webhookSend: entry.webhookSend,
    networkBlocked: networkLockedDown || entry.blocked,
  });

  if (!decision.allowed) {
    return deny(
      decision.code,
      decision.reason,
      { pluginId, host: urlForLog, method: methodForLog },
    );
  }

  // Phase 27: DLP backstop on the *outbound* payload. A plugin sending a Discord
  // token or a webhook URL to an approved host has no legitimate reason to do
  // so, and this is the layer that catches a permission that was granted for the
  // wrong host. It is a backstop, not the control — the host allowlist above is
  // what actually decides where data can go.
  if (decision.plan.body !== undefined) {
    // Scan the whole outbound body, not the default first-64-KB window.
    //
    // The two limits disagreed: the broker accepts bodies up to
    // `NETWORK_LIMITS.maxBodyLength` (256 KB) but `detectSecrets` defaults to a
    // 64 KB sample, so 192 KB of every request was never inspected. Padding is
    // free and entirely under the caller's control, so a raw credential placed
    // past the 64 KB mark walked straight through the DLP backstop — the padding
    // *is* the bypass.
    //
    // This does not try to make DLP encoding-proof; it cannot be. It only closes
    // the raw-pattern hole that a size mismatch created, and it is bounded by the
    // broker's own body limit, so the scan cost stays inside what the broker has
    // already agreed to receive.
    const findings = detectSecrets(decision.plan.body, NETWORK_LIMITS.maxBodyLength);
    if (dlpActionFor("broker", findings) === "block") {
      securityLog().record({
        type: "NETWORK_DLP_BLOCKED",
        reason: `outbound payload contains ${summarizeFindings(findings)}`,
        pluginId,
        host: urlForLog,
        method: methodForLog,
      });
      return {
        ok: false,
        status: 0,
        text: "",
        truncated: false,
        blockedReason: "outbound payload contained what looks like a credential",
      };
    }
  }

  let currentUrl = decision.plan.url.href;
  let currentMethod: NetworkMethod = decision.plan.method;
  let currentBody = decision.plan.body;

  // Headers the *plugin* asked for, kept aside so credentials can be re-derived
  // for every hop instead of being baked in once.
  //
  // Previously `applyCredentials` ran a single time, on the first host, and the
  // result was sent to every subsequent hop. A request to an allowed host that
  // answered `302 → https://elsewhere.example/` therefore carried that host's
  // credential to a host the plugin was never granted — the redirect *was* the
  // exfiltration. Each hop now re-derives its own credentials, so a header bound
  // to host A is simply absent on host B.
  const pluginHeaders = decision.plan.headers;

  for (let hop = 0; hop <= NETWORK_LIMITS.maxRedirects; hop++) {
    // Derived per hop, from this hop's own host and method.
    const headers = applyCredentials(
      safeHost(currentUrl) ?? "",
      currentMethod,
      pluginHeaders,
    );

    let response: Response;
    try {
      response = await brokerSession().fetch(currentUrl, {
        method: currentMethod,
        headers,
        body: currentBody,
        redirect: "manual",
        signal: AbortSignal.timeout(NETWORK_LIMITS.timeoutMs),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      securityLog().record({
        type: "NETWORK_BLOCKED",
        reason: `request failed: ${message}`,
        pluginId,
        host: safeHost(currentUrl),
        method: currentMethod,
      });
      return { ok: false, status: 0, text: "", truncated: false, blockedReason: "request failed" };
    }

    if (isRedirect(response.status)) {
      const location = response.headers.get("location");
      if (location === null) {
        return { ok: false, status: response.status, text: "", truncated: false };
      }
      // Re-validate the *resolved* redirect target with the full policy. This
      // is the check that stops `allowed.com` → `169.254.169.254`.
      let next: string;
      try {
        next = new URL(location, currentUrl).href;
      } catch {
        return deny("malformed", "redirect location could not be parsed", { pluginId, host: urlForLog });
      }

      // ── Method and body first, permission second ──────────────────────────
      // The old order evaluated the policy with `currentMethod` and only then
      // downgraded to GET, so the checked method and the sent method disagreed:
      // a GET-only grant was asked to authorise a POST that would never be sent
      // (a wrong refusal), and a POST grant was relied on for a GET.
      //
      // Method and body after the redirect, per Fetch's redirect algorithm rather
      // than a simplification of it.
      //
      // The previous code degraded on *any* 303. Fetch does not:
      //
      //   303  GET   -> GET      body dropped
      //   303  HEAD  -> HEAD     body dropped   (this was the bug)
      //   303  other -> GET      body dropped
      //   301  POST  -> GET      body dropped
      //   301/302 otherwise       method and body preserved
      //   307/308                method and body preserved
      //
      // So a HEAD redirected by 303 was validated as a POST — a method the grant
      // never authorised, checked against a body that was never sent, while the
      // request that actually went out was a HEAD.  The permission decision is
      // only meaningful if it is made about the request that is really made.
      const status = response.status;
      const dropsBody = status === 303 || ((status === 301 || status === 302) && currentMethod === "POST");
      let nextMethod: NetworkMethod = currentMethod;
      if (dropsBody) {
        // HEAD stays HEAD on a 303: "See Other" means retrieve the resource, and
        // for HEAD the retrieval *is* a HEAD.
        nextMethod = status === 303 && currentMethod === "HEAD" ? "HEAD" : "GET";
      }
      const nextBody = dropsBody ? undefined : currentBody;

      const redirectDecision = evaluateNetworkRequest(next, nextMethod, undefined, nextBody, {
        permissions: effectivePermissions(pluginId, entry),
        webhookSend: entry.webhookSend,
        networkBlocked: networkLockedDown || entry.blocked,
      });
      if (!redirectDecision.allowed) {
        securityLog().record({
          type: "NETWORK_BLOCKED",
          reason: `redirect refused (${redirectDecision.code}): ${redirectDecision.reason}`,
          pluginId,
          host: safeHost(next),
          // The method that would actually have been sent, not the one the
          // previous hop used.
          method: nextMethod,
        });
        return { ok: false, status: response.status, text: "", truncated: false, blockedReason: "redirect refused" };
      }
      currentUrl = redirectDecision.plan.url.href;
      currentMethod = nextMethod;
      currentBody = nextBody;
      continue;
    }

    const { text, truncated } = await readBounded(response);
    // Phase 27, response side. Reported only: a legitimate API response
    // routinely contains token-shaped strings, and blocking here would break
    // every plugin that talks to an authenticated API.
    const responseFindings = detectSecrets(text);
    if (responseFindings.length > 0) {
      securityLog().record({
        type: "NETWORK_ALLOWED",
        reason: `response contained ${summarizeFindings(responseFindings)} (reported only)`,
        pluginId,
        host: safeHost(currentUrl),
        method: currentMethod,
      });
    } else {
      securityLog().record({
        type: "NETWORK_ALLOWED",
        pluginId,
        host: safeHost(currentUrl),
        method: currentMethod,
        durationMs: Date.now() - started,
      });
    }
    return { ok: response.ok, status: response.status, text, truncated };
  }

  return deny("malformed", "too many redirects", { pluginId, host: urlForLog, method: methodForLog });
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Read at most `maxResponseBytes` from the response.
 *
 * Reading a hostile response in full would let a remote party dictate main
 * process memory usage, so the stream is cancelled the moment it exceeds the
 * cap rather than being truncated after the fact.
 */
async function readBounded(response: Response): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (body === null) {
    return { text: await response.text(), truncated: false };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > NETWORK_LIMITS.maxResponseBytes) {
        chunks.push(value.slice(0, Math.max(0, value.byteLength - (total - NETWORK_LIMITS.maxResponseBytes))));
        await reader.cancel().catch(() => {});
        return { text: decode(chunks), truncated: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return { text: decode(chunks), truncated: false };
}

function decode(chunks: Uint8Array[]): string {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** Exported for the Security Center so it can show the effective policy. */
export function describeBrokerPolicy(): { lockedDown: boolean; plugins: Array<{ id: string; hosts: string[]; webhookSend: boolean; blocked: boolean }> } {
  return {
    lockedDown: networkLockedDown,
    plugins: [...plugins.entries()].map(([id, entry]) => ({
      id,
      hosts: entry.permissions.map((rule) => rule.host),
      webhookSend: entry.webhookSend,
      blocked: entry.blocked,
    })),
  };
}

export { isDiscordWebhookUrl };
