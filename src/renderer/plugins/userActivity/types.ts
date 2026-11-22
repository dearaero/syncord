export const ACTIVITY_PLUGIN_ID = "user-activity";
export const ACTIVITY_SETTINGS_EVENT = "Syncord-user-activity-settings";
export const ACTIVITY_STATUS_EVENT = "Syncord-user-activity-status";
export const MAX_ACTIVITY_USERS = 32;
export const EVENT_KINDS = ["presence", "messages", "typing", "avatar", "profile", "activities", "voice"] as const;
export type EventKind = typeof EVENT_KINDS[number];
export type ActivityConfig = Record<EventKind, boolean> & {
  /** Primary target for a single ActivityEngine; legacy settings migrate into userIds. */
  userId: string;
  userIds: string[];
  paused: boolean;
  typingCooldown: number;
  notificationInterval: number;
};
export type MessageEvent = "sent" | "edited" | "deleted";
export type ActivityNotice = { userId?: string; kind: EventKind; channelId?: string; text: string; messageId?: string; messageEvent?: MessageEvent; content?: string; timestamp?: number };
export function messageContent(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0,32_000).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "") : undefined;
}
export type UserFields = { id: string; avatar?: string | null; username?: string; global_name?: string | null };
export type Baseline = { user?: UserFields; status?: string; activities?: unknown; voice?: Record<string, unknown> };
export type Action = Record<string, unknown>;

export function record(value: unknown): Action | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Action : undefined;
}
export function userId(value: unknown): string {
  if (typeof value !== "string") return "";
  const id = value.trim().replace(/^<@!?(\d+)>$/, "$1");
  return /^\d{17,20}$/.test(id) ? id : "";
}
export function userIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const item of value) {
    const id = userId(item);
    if (id) ids.add(id);
    if (ids.size === MAX_ACTIVITY_USERS) break;
  }
  return [...ids];
}
export function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}
export function readConfig(get: (key: string, fallback?: unknown) => unknown): ActivityConfig {
  const flags = Object.fromEntries(EVENT_KINDS.map(kind => [kind, get(kind, true) === true])) as Record<EventKind, boolean>;
  const saved = get("userIds");
  // An explicitly empty list must never resurrect the previous single-user selection.
  const selected = userIds(Array.isArray(saved) ? saved : [get("userId", "")]);
  return { ...flags, userId: selected[0] ?? "", userIds: selected, paused: get("paused", false) === true,
    typingCooldown: boundedNumber(get("typingCooldown", 30), 30, 5, 300),
    notificationInterval: boundedNumber(get("notificationInterval", 5), 5, 5, 60) };
}
export function cleanText(value: unknown, limit = 100): string {
  return typeof value === "string" ? value.slice(0, limit).replace(/[\u0000-\u001f\u007f]/g, " ") : "";
}
