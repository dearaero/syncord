/**
 * `safeStorage` helpers (Phase 15).
 *
 * `safeStorage.encryptString` uses the OS keychain (Keychain on macOS, DPAPI on
 * Windows, libsecret/kwallet on Linux). The important property for us is that
 * the plaintext never touches a file we write.
 *
 * Scope, stated explicitly because it is easy to overreach here:
 *
 *  - This is for **Syncord's own** secrets: a third-party API credential, an
 *    OAuth refresh token for a Syncord integration, a private app token.
 *  - It is **not** for the Discord account token. Syncord never reads it,
 *    never copies it, and never migrates it into `safeStorage`. Discord already
 *    stores that token in its own encrypted store; duplicating it would create a
 *    second copy of the most valuable secret on the machine, in a store with a
 *    different threat model.
 *  - UI settings (theme, booleans, layout, pane counts) stay plain JSON. They are
 *    not secrets, and encrypting them would make them unreadable during support.
 *
 * Failure mode is fail-closed: if the OS store is unavailable — a Linux box with
 * no keyring daemon, a `safeStorage.isEncryptionAvailable() === false` result —
 * `decrypt` returns undefined and callers must treat the secret as absent rather
 * than falling back to a plaintext read.
 */
import { safeStorage } from "electron";

import { LOG_PREFIX } from "../../shared/constants";
import { SyncordUserDataPath } from "./core";
import path from "node:path";
import fs from "node:fs";

/** In-memory cache so we do not touch the keychain on every request. */
const cache = new Map<string, string>();

function secretFile(name: string): string {
  // `name` is a constant from this module, never user input. It is still
  // normalized and contained so a future caller cannot turn it into a path.
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error("invalid secret name");
  }
  return path.join(SyncordUserDataPath(), "secrets", `${name}.bin`);
}

export function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function encryptString(plaintext: string): Buffer | undefined {
  if (typeof plaintext !== "string" || plaintext.length === 0) return undefined;
  if (!encryptionAvailable()) {
    // No plaintext fallback. Writing the secret unencrypted "temporarily" is
    // how temporary becomes permanent.
    console.warn(`${LOG_PREFIX}[security] no OS keychain available; refusing to store secret in plaintext`);
    return undefined;
  }
  try {
    return safeStorage.encryptString(plaintext);
  } catch (err) {
    console.warn(`${LOG_PREFIX}[security] encryptString failed:`, describe(err));
    return undefined;
  }
}

export function decryptString(ciphertext: Buffer): string | undefined {
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0) return undefined;
  if (!encryptionAvailable()) return undefined;
  try {
    return safeStorage.decryptString(ciphertext);
  } catch (err) {
    // Fail closed: a decryption failure means the secret is gone, not that we
    // should look for an unencrypted copy.
    console.warn(`${LOG_PREFIX}[security] decryptString failed:`, describe(err));
    return undefined;
  }
}

/** Persist a secret. Returns whether it was written. */
export function storeSecret(name: string, plaintext: string): boolean {
  const blob = encryptString(plaintext);
  if (blob === undefined) return false;
  try {
    const file = secretFile(name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, blob, { mode: 0o600 });
    cache.set(name, plaintext);
    return true;
  } catch (err) {
    console.warn(`${LOG_PREFIX}[security] could not write secret:`, describe(err));
    return false;
  }
}

/**
 * Read a secret. Returns undefined when absent, unreadable, or undecryptable —
 * callers must handle "no secret" as a normal state, not an error.
 */
export function loadSecret(name: string): string | undefined {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  try {
    const file = secretFile(name);
    if (!fs.existsSync(file)) return undefined;
    const plaintext = decryptString(fs.readFileSync(file));
    if (plaintext !== undefined) cache.set(name, plaintext);
    return plaintext;
  } catch (err) {
    console.warn(`${LOG_PREFIX}[security] could not read secret:`, describe(err));
    return undefined;
  }
}

export function deleteSecret(name: string): void {
  cache.delete(name);
  try {
    const file = secretFile(name);
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  } catch (err) {
    console.warn(`${LOG_PREFIX}[security] could not delete secret:`, describe(err));
  }
}

/** Used by Emergency Lockdown to drop secrets from process memory. */
export function forgetSecrets(): void {
  cache.clear();
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
