/** The cached client REST object; the lower-level transport may be a function. */
export function isDiscordRestApi(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  try {
    const candidate = value as Record<string, unknown>;
    return ["get", "post", "put", "patch", "del"].every(key => typeof candidate[key] === "function");
  } catch { return false; }
}
