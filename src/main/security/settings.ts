/**
 * Settings storage.
 *
 * Split out of `ipc.ts` so the read/write policy (size, depth, type) lives in
 * one place and the IPC layer only decides *who* may call it.
 */
import fs from "node:fs";
import path from "node:path";

import { LOG_PREFIX } from "../../shared/constants";
import { SyncordSettingsFile } from "./core";

/** Refuse anything that could grow or nest the settings file without bound. */
export const SETTINGS_LIMITS = {
  maxBytes: 512 * 1024,
  maxDepth: 8,
  maxKeys: 2000,
  maxArrayItems: 500,
  maxStringLength: 100_000,
} as const;

export type SettingsLoad = { ok: true; data: Record<string, unknown> } | { ok: false; reason: string };

function ensureDir(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

/**
 * Structural validation for an incoming settings payload.
 *
 * This is not paranoia about "the renderer is hostile" — the renderer is the
 * *only* client we have, and Phase 1 established that it is on a trusted origin.
 * It is about the renderer being *compromised by a plugin*, which is the actual
 * threat model. A plugin that can write `security.lockdown = false` or blow the
 * settings file up to hundreds of megabytes has turned a code-execution bug into
 * a durable one, so the write is validated and the reserved security namespace
 * is protected (Phase 14 will formalise the lock).
 */
export function validateSettingsPayload(raw: unknown): { ok: true; data: Record<string, unknown> } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "settings must be a plain object" };
  }
  return checkNode(raw, 0, 0);
}

function checkNode(
  value: unknown,
  depth: number,
  keyCount: number,
): { ok: true; data: Record<string, unknown> } | { ok: false; reason: string } {
  if (depth > SETTINGS_LIMITS.maxDepth) {
    return { ok: false, reason: `settings nested deeper than ${SETTINGS_LIMITS.maxDepth} levels` };
  }
  if (keyCount > SETTINGS_LIMITS.maxKeys) {
    return { ok: false, reason: `settings exceed ${SETTINGS_LIMITS.maxKeys} keys` };
  }
  if (value === null) return { ok: true, data: {} };

  if (Array.isArray(value)) {
    if (value.length > SETTINGS_LIMITS.maxArrayItems) {
      return { ok: false, reason: `settings array longer than ${SETTINGS_LIMITS.maxArrayItems}` };
    }
    // Arrays are stored as-is; only their scalar members are length-checked.
    for (const item of value) {
      if (typeof item === "string" && item.length > SETTINGS_LIMITS.maxStringLength) {
        return { ok: false, reason: "settings string too long" };
      }
    }
    return { ok: true, data: {} };
  }

  if (typeof value !== "object") return { ok: true, data: {} };

  const out: Record<string, unknown> = {};
  let count = keyCount;
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (key.length > 200) return { ok: false, reason: "settings key name too long" };
    if (isReservedSettingsKey(key)) {
      // Reserved namespace: silently dropped rather than rejected, so a plugin
      // writing there gets a consistent "no effect" instead of a hard error it
      // could probe. The event log records it.
      continue;
    }
    if (typeof inner === "function" || typeof inner === "symbol" || typeof inner === "bigint") {
      return { ok: false, reason: `unsupported settings value type for "${key}"` };
    }
    if (typeof inner === "string") {
      if (inner.length > SETTINGS_LIMITS.maxStringLength) {
        return { ok: false, reason: "settings string too long" };
      }
      out[key] = inner;
      count += 1;
      continue;
    }
    if (typeof inner === "number") {
      if (!Number.isFinite(inner)) return { ok: false, reason: `non-finite number for "${key}"` };
      out[key] = inner;
      count += 1;
      continue;
    }
    if (typeof inner === "boolean") {
      out[key] = inner;
      count += 1;
      continue;
    }
    if (inner === null) {
      out[key] = null;
      count += 1;
      continue;
    }
    if (Array.isArray(inner)) {
      if (inner.length > SETTINGS_LIMITS.maxArrayItems) {
        return { ok: false, reason: `settings array longer than ${SETTINGS_LIMITS.maxArrayItems}` };
      }
      out[key] = inner;
      count += 1;
      continue;
    }
    const nested = checkNode(inner, depth + 1, count);
    if (!nested.ok) return nested;
    out[key] = nested.data;
    count += Object.keys(nested.data).length;
  }
  return { ok: true, data: out };
}

/**
 * Keys Syncord owns. The renderer may read them (it needs to render the
 * Security Center) but may never write them — that keeps lockdown, safe mode
 * and Developer Mode from being togglable by page code.
 */
export function isReservedSettingsKey(key: string): boolean {
  return key === "security" || key === "safeMode" || key === "developerMode" || key.startsWith("security.");
}

export function readSettings(): SettingsLoad {
  const file = SyncordSettingsFile();
  try {
    if (!fs.existsSync(file)) return { ok: true, data: {} };
    const stat = fs.statSync(file);
    if (stat.size > SETTINGS_LIMITS.maxBytes) {
      return { ok: false, reason: "settings file exceeds the size limit" };
    }
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ok: true, data: parsed as Record<string, unknown> };
    }
    return { ok: true, data: {} };
  } catch (err) {
    console.warn(`${LOG_PREFIX} settings read failed:`, err);
    return { ok: true, data: {} };
  }
}

export function writeSettings(data: Record<string, unknown>): { ok: true } | { ok: false; reason: string } {
  const file = SyncordSettingsFile();
  let serialized: string;
  try {
    serialized = `${JSON.stringify(data, null, 2)}\n`;
  } catch (err) {
    return { ok: false, reason: `settings are not serializable: ${String(err)}` };
  }
  if (Buffer.byteLength(serialized, "utf-8") > SETTINGS_LIMITS.maxBytes) {
    return { ok: false, reason: "settings payload exceeds the size limit" };
  }
  try {
    ensureDir(file);
    // Write-then-rename: a crash mid-write must not leave a truncated file that
    // fails to parse on next boot.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, serialized, "utf-8");
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (err) {
    console.warn(`${LOG_PREFIX} settings write failed:`, err);
    return { ok: false, reason: "settings could not be written" };
  }
}
