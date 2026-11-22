/**
 * Build integrity verification (Phase 18).
 *
 * Threat: Syncord runs from `resources/app/*.js` inside the Discord install.
 * Anyone who can write those three files owns the client — and the client holds
 * the user's session. Code signing and notarization belong to Discord's
 * installer (Phase 23/24), so this is the compensating control: a signed hash
 * manifest of our own bundles, verified at startup.
 *
 * Design:
 *
 *  - The manifest lists SHA-256 hashes of `main.js`, `preload.js`, `renderer.js`.
 *    The *preload* is the most important entry: it is the only bundle that holds
 *    a `contextBridge` handle and a Node `require`.
 *  - The manifest is signed with Ed25519 and verified with an embedded public
 *    key. A bare hash file is not a security control — an attacker who can edit
 *    `main.js` can edit `manifest.json` too. The signature is what breaks that,
 *    because the public key is compiled into the verifying code and the private
 *    key never enters the repository or the build output.
 *  - Verification failure is **visible but not fatal by default**: a
 *    mismatched bundle is a critical event, non-core plugins are refused, and
 *    the Security Center shows it. Refusing to boot would mean a corrupted
 *    install is indistinguishable from an attack, and the user's only recourse
 *    would be to reinstall — with no way to find out why. `strict` mode is
 *    available for deployments that prefer fail-closed.
 *  - Development builds skip verification entirely, because a dev build is
 *    rebuilt constantly and a hash manifest would be pure noise. That is also
 *    why the check is *reported* in the status rather than assumed: "integrity
 *    not verified" is a meaningful, displayable state.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { LOG_PREFIX } from "../../shared/constants";
import { securityLog } from "./core";
import { INTEGRITY_PUBLIC_KEY } from "./signing";

/**
 * Ed25519 public key used to verify the manifest.
 *
 * The constant itself lives in `./signing`, which the updater also uses, so the
 * client has exactly one release key. Verification below is deliberately left
 * as its own explicit block rather than routed through
 * `verifyDetachedSignature`: this path reports *why* a signature could not be
 * checked into the Security Center, which the boolean-returning helper does
 * not do.
 */
const EMBEDDED_PUBLIC_KEY = INTEGRITY_PUBLIC_KEY;

export const INTEGRITY_FILES = ["main.js", "preload.js", "renderer.js"] as const;

export type IntegrityState = "unverified" | "development" | "ok" | "modified" | "unreadable";

export type IntegrityStatus = {
  state: IntegrityState;
  files: Array<{ name: string; present: boolean }>;
  /** Present only on failure, and never a hash of a secret. */
  detail?: string;
};

let status: IntegrityStatus = { state: "unverified", files: [] };
let checked = false;

/** Where the built bundles live — `<resources>/app`. */
function bundleDir(): string {
  return __dirname;
}

function manifestPath(): string {
  return path.join(bundleDir(), "integrity.manifest.json");
}

function hashFile(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Verify the bundles. Idempotent — the result is cached, because hashing
 * `renderer.js` on every call would be a measurable startup cost.
 */
export function verifyIntegrity(options: { development?: boolean } = {}): IntegrityStatus {
  if (checked) return status;
  checked = true;

  const dev = options.development === true || process.env.NODE_ENV === "development";

  const present = INTEGRITY_FILES.map((name) => ({
    name,
    present: fs.existsSync(path.join(bundleDir(), name)),
  }));

  if (dev) {
    status = { state: "development", files: present, detail: "development build — verification skipped" };
    return status;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath(), "utf-8");
  } catch {
    // No manifest: we cannot distinguish "unsigned build" from "manifest
    // deleted", so we say so rather than claiming the build is clean.
    status = {
      state: "unreadable",
      files: present,
      detail: "integrity manifest not found",
    };
    securityLog().record({ type: "PLUGIN_INTEGRITY_FAIL", reason: "integrity manifest not found" });
    console.warn(`${LOG_PREFIX}[security] ${status.detail}`);
    return status;
  }

  let manifest: { version?: unknown; algorithm?: unknown; files?: unknown; signature?: unknown };
  try {
    manifest = JSON.parse(raw) as typeof manifest;
  } catch {
    status = { state: "unreadable", files: present, detail: "integrity manifest is not valid JSON" };
    securityLog().record({ type: "PLUGIN_INTEGRITY_FAIL", reason: "integrity manifest is not valid JSON" });
    return status;
  }

  if (manifest.algorithm !== "ed25519" || !Array.isArray(manifest.files) || typeof manifest.signature !== "string") {
    // The most common cause by far is a build without Syncord_SIGNING_KEY.
    // Say so specifically, because "UNVERIFIED" with no explanation is the kind
    // of state a user learns to ignore.
    const unsigned = typeof manifest.signature !== "string";
    status = {
      state: "unreadable",
      files: present,
      detail: unsigned
        ? "integrity manifest is unsigned — this is a development build"
        : "integrity manifest has an unexpected shape",
    };
    securityLog().record({ type: "PLUGIN_INTEGRITY_FAIL", reason: status.detail });
    console.warn(`${LOG_PREFIX}[security] ${status.detail}`);
    return status;
  }

  // 1. Signature over the canonical serialization of the file list.
  //    Signing a re-serialization (rather than the file bytes) means whitespace
  //    and key order cannot be used to smuggle a different payload.
  let signatureOk = false;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(EMBEDDED_PUBLIC_KEY, "base64"),
      format: "der",
      type: "spki",
    });
    const payload = Buffer.from(
      JSON.stringify({ version: manifest.version, algorithm: manifest.algorithm, files: manifest.files }),
      "utf-8",
    );
    signatureOk = crypto.verify(null, payload, key, Buffer.from(manifest.signature, "base64"));
  } catch (err) {
    status = {
      state: "unreadable",
      files: present,
      detail: `signature could not be checked: ${err instanceof Error ? err.message : "unknown"}`,
    };
    securityLog().record({ type: "PLUGIN_INTEGRITY_FAIL", reason: status.detail });
    return status;
  }

  if (!signatureOk) {
    status = { state: "modified", files: present, detail: "integrity manifest signature is invalid" };
    securityLog().record({ type: "PRELOAD_INTEGRITY_FAIL", reason: status.detail });
    console.error(`${LOG_PREFIX}[security] ${status.detail}`);
    return status;
  }

  // 2. Hashes.
  const expected = new Map<string, string>();
  for (const entry of manifest.files as Array<Record<string, unknown>>) {
    if (typeof entry?.name === "string" && typeof entry?.sha256 === "string") {
      expected.set(entry.name, entry.sha256);
    }
  }

  const missing = INTEGRITY_FILES.filter((name) => !expected.has(name));
  if (missing.length > 0) {
    status = { state: "modified", files: present, detail: `manifest does not cover ${missing.join(", ")}` };
    securityLog().record({ type: "PRELOAD_INTEGRITY_FAIL", reason: status.detail });
    return status;
  }

  for (const name of INTEGRITY_FILES) {
    const file = path.join(bundleDir(), name);
    if (!fs.existsSync(file)) {
      status = { state: "modified", files: present, detail: `${name} is missing` };
      securityLog().record({ type: "PRELOAD_INTEGRITY_FAIL", reason: status.detail });
      return status;
    }
    let actual: string;
    try {
      actual = hashFile(file);
    } catch {
      status = { state: "unreadable", files: present, detail: `${name} could not be read` };
      securityLog().record({ type: "PRELOAD_INTEGRITY_FAIL", reason: status.detail });
      return status;
    }
    if (actual !== expected.get(name)) {
      status = { state: "modified", files: present, detail: `${name} does not match the signed manifest` };
      securityLog().record({ type: "PLUGIN_INTEGRITY_FAIL", reason: status.detail });
      console.error(`${LOG_PREFIX}[security] ${status.detail}`);
      return status;
    }
  }

  status = { state: "ok", files: present };
  securityLog().record({ type: "INTEGRITY_OK", reason: "all bundles match the signed manifest" });
  return status;
}

export function integrityStatus(): IntegrityStatus {
  if (!checked) return verifyIntegrity();
  return status;
}

/** A failed verification is treated as "not a trusted build" by Safe Mode. */
export function integrityTrusted(): boolean {
  const state = integrityStatus().state;
  return state === "ok" || state === "development";
}

/**
 * Generate the manifest. Run by the release build, never at runtime.
 * Exported so `scripts/build.mjs` and a future release pipeline share one
 * implementation of the canonical serialization.
 */
export function buildManifest(entries: Array<{ name: string; sha256: string }>): {
  version: 1;
  algorithm: "ed25519";
  files: Array<{ name: string; sha256: string }>;
} {
  return { version: 1, algorithm: "ed25519", files: entries };
}

export function canonicalPayload(manifest: { version: unknown; algorithm: unknown; files: unknown }): Buffer {
  return Buffer.from(
    JSON.stringify({ version: manifest.version, algorithm: manifest.algorithm, files: manifest.files }),
    "utf-8",
  );
}
