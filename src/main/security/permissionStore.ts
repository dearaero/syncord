/**
 * Host permission store (Phase 4).
 *
 * A plugin's *declared* permissions come from its source. This store holds
 * *granted* permissions: the ones a human approved through a prompt. The broker
 * treats the union as the effective policy, so a grant is the only way a plugin
 * reaches a host its author did not write down.
 *
 * Three properties are deliberate:
 *
 *  - **Default deny.** A host with no grant is denied. There is no "ask later"
 *    fallback and no implicit allowance for a first-time request.
 *  - **Granular categories.** `network-connect` is a different permission from
 *    `image` or `font`. Granting one never implies another — a plugin allowed to
 *    load remote images gets no `connect-src`, which is the distinction that
 *    stops a "just an avatar from my server" request from becoming an
 *    exfiltration channel. `script` is not grantable at all; see below.
 *  - **Explicit trust to persist.** The prompt has a separate "I trust this
 *    domain" checkbox. Without it a grant is session-only and disappears on
 *    restart, so a user who approves something once on a whim is not stuck with
 *    it forever.
 *
 * Persistence: `permissions.json` under the Syncord profile. Grants are not
 * secrets (hostnames, methods, dates) so plain JSON is appropriate — that is
 * what makes them reviewable, which is the point of showing them in settings.
 */
import fs from "node:fs";
import path from "node:path";

import { NETWORK_METHODS, validateNetworkHost, type NetworkMethod, type NetworkPermission } from "../../security/permissions";
import { SyncordUserDataPath, securityLog } from "./core";

/** Grantable permission categories. `script` is intentionally absent. */
export const PERMISSION_CATEGORIES = [
  "network-connect",
  "image",
  "media",
  "font",
  "style",
] as const;
export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

/**
 * Why `script` is not in the list.
 *
 * A remote-script permission is a remote-code-execution permission. Unlike
 * `image` (which can only leak a URL and a referrer) it hands the attacker the
 * ability to read the page and everything in it. There is no version of this
 * prompt that should be able to grant it, so the category does not exist and
 * `PERMISSION_CATEGORIES` is the only source of truth for what a prompt can
 * create. PHASE 10 makes remote JS a hard block for the same reason.
 */

export type PermissionGrant = {
  /** `${pluginId}::${category}::${host}` — stable key for revoke. */
  key: string;
  pluginId: string;
  category: PermissionCategory;
  host: string;
  methods: NetworkMethod[];
  /** Session grants are dropped on restart unless `trusted` was checked. */
  trusted: boolean;
  grantedAt: number;
};

type StoreFile = {
  version: 1;
  grants: PermissionGrant[];
};

const MAX_GRANTS = 500;

function storeFile(): string {
  return path.join(SyncordUserDataPath(), "permissions.json");
}

/** Grants for this session, including the ones persisted earlier. */
const grants = new Map<string, PermissionGrant>();

export function grantKey(pluginId: string, category: PermissionCategory, host: string): string {
  return `${pluginId}::${category}::${host.toLowerCase()}`;
}

/**
 * The host rule for a grant — the *same* rule a declared permission goes through.
 *
 * ## Why the shared helper and not a local copy
 *
 * This used to be a second implementation, and the two disagreed: the declared
 * path rejected `*.co.uk` as a public suffix while this one accepted it, so a
 * plugin that could not *declare* the wildcard could be handed it through the
 * grant flow. A grant is a user-approved permission — the same decision with a
 * different person in the loop — so it cannot afford a looser rule, and the test
 * suite had come to encode the disagreement rather than catch it.
 *
 * `validateNetworkHost` lives in `src/security/` so main, preload and renderer all
 * compile the same bytes; there is now no second copy to drift.
 */
function isAcceptableGrantHost(rawHost: string): boolean {
  return validateNetworkHost(rawHost).ok;
}

export function loadGrants(): void {
  grants.clear();
  const file = storeFile();
  try {
    if (!fs.existsSync(file)) return;
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as StoreFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.grants)) return;
    for (const raw of parsed.grants) {
      const grant = sanitizeGrant(raw);
      if (grant !== null) grants.set(grant.key, grant);
    }
  } catch (err) {
    // A corrupt permission file must not brick startup, and it must not
    // silently become "everything allowed" either. Starting from empty is the
    // fail-closed outcome.
    console.warn("[Syncord][security] permissions file unreadable, starting empty:", err);
    grants.clear();
  }
}

function sanitizeGrant(raw: unknown): PermissionGrant | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Record<string, unknown>;
  if (typeof g.pluginId !== "string" || !/^[a-z][a-z0-9-]*$/.test(g.pluginId)) return null;
  if (typeof g.category !== "string") return null;
  if (!(PERMISSION_CATEGORIES as readonly string[]).includes(g.category)) return null;
  if (typeof g.host !== "string" || g.host.length === 0 || g.host.length > 253) return null;
  if (!isAcceptableGrantHost(g.host)) return null;
  // An unusable method list must not become an *unrestricted* one.
  //
  // The old code produced `methods: []` for anything that was not an array of
  // valid verbs, and `grantedNetworkPermissions` omits the field when the list
  // is empty — which `matchesNetworkPermission` reads as "no method restriction".
  // So a grant of `{host, methods: "GET"}` or `methods: [42]` became a grant on
  // **every** HTTP method, including POST, PUT and DELETE. A sanitizer that
  // turns a malformed request into a broader one is worse than one that drops
  // it, so an empty result is now a rejected grant.
  const methods = Array.isArray(g.methods)
    ? g.methods.filter((m): m is NetworkMethod => typeof m === "string" && (NETWORK_METHODS as readonly string[]).includes(m.toUpperCase())).map((m) => m.toUpperCase() as NetworkMethod)
    : [];
  if (methods.length === 0) return null;
  return {
    key: grantKey(g.pluginId, g.category as PermissionCategory, g.host),
    pluginId: g.pluginId,
    category: g.category as PermissionCategory,
    host: g.host.toLowerCase(),
    methods: [...new Set(methods)],
    trusted: g.trusted === true,
    grantedAt: typeof g.grantedAt === "number" && Number.isFinite(g.grantedAt) ? g.grantedAt : Date.now(),
  };
}

/**
 * Record a user-approved grant.
 *
 * `trusted === false` stores the grant in memory only. That is the whole point
 * of the extra checkbox: "allow this once" must not silently become "allow this
 * forever".
 */
export function grantPermission(input: {
  pluginId: string;
  category: string;
  host: string;
  methods?: unknown;
  trusted?: boolean;
}): { ok: true; grant: PermissionGrant } | { ok: false; reason: string } {
  if (typeof input.category !== "string" || !(PERMISSION_CATEGORIES as readonly string[]).includes(input.category)) {
    return { ok: false, reason: `unknown permission category "${String(input.category)}"` };
  }
  const candidate: Record<string, unknown> = {
    pluginId: input.pluginId,
    category: input.category,
    host: input.host,
    methods: Array.isArray(input.methods)
      ? input.methods.map((m) => (typeof m === "string" ? m.toUpperCase() : m))
      : ["GET"],
    trusted: input.trusted === true,
    grantedAt: Date.now(),
  };
  const grant = sanitizeGrant(candidate);
  if (grant === null) {
    return { ok: false, reason: "invalid permission request" };
  }
  // Session grants must not evict persistent ones when the table is full.
  if (grants.size >= MAX_GRANTS && !grants.has(grant.key)) {
    const evictable = [...grants.values()].find((existing) => !existing.trusted);
    if (evictable === undefined) return { ok: false, reason: "permission table is full" };
    grants.delete(evictable.key);
  }
  grants.set(grant.key, grant);
  if (grant.trusted) persist();
  securityLog().record({
    type: "PERMISSION_GRANTED",
    pluginId: grant.pluginId,
    host: grant.host,
    permission: grant.category,
    reason: grant.trusted ? "persistent" : "session only",
  });
  return { ok: true, grant };
}

export function revokePermission(key: unknown): boolean {
  if (typeof key !== "string" || key.length === 0) return false;
  const existing = grants.get(key);
  if (existing === undefined) return false;
  grants.delete(key);
  persist();
  securityLog().record({
    type: "PERMISSION_REVOKED",
    pluginId: existing.pluginId,
    host: existing.host,
    permission: existing.category,
  });
  return true;
}

export function listGrants(pluginId?: string): PermissionGrant[] {
  const all = [...grants.values()];
  const filtered = typeof pluginId === "string" ? all.filter((g) => g.pluginId === pluginId) : all;
  return filtered.sort((a, b) => b.grantedAt - a.grantedAt);
}

/**
 * Extra network permissions a grant contributes for `pluginId`.
 *
 * Only `network-connect` grants turn into broker permissions. A plugin granted
 * `image` for `cdn.example.com` gets *nothing* here — that is the category
 * separation the spec asks for, enforced in code rather than in a comment.
 */
export function grantedNetworkPermissions(pluginId: string): NetworkPermission[] {
  return listGrants(pluginId)
    .filter((grant) => grant.category === "network-connect")
    .map((grant) => ({
      host: grant.host,
      ...(grant.methods.length > 0 ? { methods: grant.methods } : {}),
    }));
}

export function hasGrant(pluginId: string, category: PermissionCategory, host: string): boolean {
  return grants.has(grantKey(pluginId, category, host));
}

function persist(): void {
  const file = storeFile();
  const persistent = [...grants.values()].filter((g) => g.trusted);
  const payload: StoreFile = { version: 1, grants: persistent };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn("[Syncord][security] could not persist permissions:", err);
  }
}

export function clearSessionGrants(): void {
  for (const [key, grant] of [...grants.entries()]) {
    if (!grant.trusted) grants.delete(key);
  }
}
