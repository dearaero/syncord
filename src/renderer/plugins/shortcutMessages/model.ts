export type Shortcut = { key: string; value: string };

export const MAX_SHORTCUTS = 200;
export const MAX_KEY_LENGTH = 32;
export const MAX_VALUE_LENGTH = 2000;

/** A key is one word: it is matched as a whole, case-sensitive token. */
export function validKey(key: unknown): key is string {
  return typeof key === "string" && key.length > 0 && key.length <= MAX_KEY_LENGTH && !/\s/.test(key);
}

export function validValue(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_VALUE_LENGTH && !/[\r\n]/.test(value);
}

/** Drops malformed entries and duplicate keys (first one wins). */
export function normalizeShortcuts(raw: unknown): Shortcut[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Shortcut[] = [];
  for (const item of raw) {
    if (out.length >= MAX_SHORTCUTS) break;
    if (!item || typeof item !== "object") continue;
    const { key, value } = item as Record<string, unknown>;
    if (!validKey(key) || !validValue(value) || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, value });
  }
  return out;
}

/**
 * The shortcut whose key is the whole word ending at the caret.
 * "adres|" and "x adres| y" match; "adresim|", "yadres|" and "Adres|" do not.
 */
export function matchShortcut(text: string, caret: number, list: readonly Shortcut[]): Shortcut | undefined {
  if (caret < 1 || caret > text.length) return undefined;
  const after = text[caret];
  if (after !== undefined && !/\s/.test(after)) return undefined;
  const token = /(\S+)$/.exec(text.slice(0, caret))?.[1];
  return token ? list.find((s) => s.key === token) : undefined;
}
