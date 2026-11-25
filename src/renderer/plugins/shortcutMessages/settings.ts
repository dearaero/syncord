import { settings } from "../../api/settings";
import { normalizeShortcuts, type Shortcut } from "./model";

export const SHORTCUTS_ID = "shortcut-messages";
export const SHORTCUTS_EVENT = "Syncord-shortcut-messages-change";
const KEY = `plugins.${SHORTCUTS_ID}.data.shortcuts`;

let lastRaw: unknown;
let cached: Shortcut[] = [];

export function shortcuts(): Shortcut[] {
  const raw = settings.get<unknown>(KEY);
  if (raw !== lastRaw) {
    lastRaw = raw;
    cached = normalizeShortcuts(raw);
  }
  return cached;
}

export function saveShortcuts(next: Shortcut[]): void {
  settings.set(KEY, normalizeShortcuts(next));
  window.dispatchEvent(new Event(SHORTCUTS_EVENT));
}
