import { createLogger } from "./logger";

const log = createLogger("settings");

type SettingsMap = Record<string, unknown>;

const WRITE_DEBOUNCE_MS = 300;

let cache: SettingsMap = {};
let loaded = false;
let writeTimer: ReturnType<typeof setTimeout> | undefined;
let pendingWrite: SettingsMap | undefined;

function native() {
  return window.SyncordNative;
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  const api = native();
  if (!api) {
    log.warn("SyncordNative missing — settings are in-memory only");
    loaded = true;
    return;
  }
  try {
    cache = (await api.getSettings()) ?? {};
  } catch (err) {
    log.error("Failed to load settings:", err);
    cache = {};
  }
  loaded = true;
}

function scheduleWrite(): void {
  const api = native();
  if (!api) return;

  pendingWrite = { ...cache };
  if (writeTimer !== undefined) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = undefined;
    const data = pendingWrite;
    pendingWrite = undefined;
    if (!data) return;
    api.setSettings(data).catch((err: unknown) => {
      log.error("Failed to save settings:", err);
    });
  }, WRITE_DEBOUNCE_MS);
}

export async function initSettings(): Promise<void> {
  await ensureLoaded();
}

export function get<T = unknown>(key: string, fallback?: T): T | undefined {
  if (!loaded) {
    log.warn("get() before init — returning fallback");
    return fallback;
  }
  return (key in cache ? (cache[key] as T) : fallback);
}

export function set(key: string, value: unknown): void {
  cache[key] = value;
  scheduleWrite();
}

export function isLoaded(): boolean {
  return loaded;
}

export function getAll(): Readonly<SettingsMap> {
  return cache;
}

/** Flush pending write immediately (best-effort). */
export async function flush(): Promise<void> {
  if (writeTimer !== undefined) {
    clearTimeout(writeTimer);
    writeTimer = undefined;
  }
  const api = native();
  const data = pendingWrite ?? cache;
  pendingWrite = undefined;
  if (!api) return;
  await api.setSettings(data);
}

export const settings = {
  init: initSettings,
  get,
  set,
  getAll,
  isLoaded,
  flush,
};
