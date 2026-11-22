import { t as i18nText } from "../../i18n";
/**
 * The scheduled-message model.
 *
 * Kept free of Discord and DOM types on purpose: the scheduler, the store and
 * the settings section all speak this shape, and none of them should need a
 * client to reason about.
 */

/**
 * Lifecycle of one scheduled message.
 *
 * `sending` is deliberately absent. In-flight state lives in memory only (see
 * `store.ts`): if the client dies mid-send we cannot know whether the message
 * went out, and a persisted "sending" would be a lie. A message that was due
 * while we were closed comes back as `pending` and the user decides.
 */
export type ScheduledStatus = "pending" | "sent" | "failed" | "cancelled";

export type ScheduledMessage = {
  /** Unique, stable across restarts. */
  id: string;
  content: string;
  channelId: string;
  /** Present for guild channels; absent for DMs and group DMs. */
  guildId?: string;
  /** When the message was scheduled, epoch ms. */
  createdAt: number;
  /** When it should be sent, epoch ms. */
  sendAt: number;
  status: ScheduledStatus;
  /** Why the last attempt failed, shown to the user. */
  lastError?: string;
  /** Set once the message is confirmed sent. */
  sentAt?: number;
};

/** The subset the composer needs to describe one channel. */
export type ChannelTarget = {
  channelId: string;
  guildId?: string;
  /** Display name for the management list. */
  channelName: string;
  /** Server name, or a DM descriptor. */
  scopeName: string;
  isDm: boolean;
};

export function isPending(message: ScheduledMessage): boolean {
  return message.status === "pending";
}

/**
 * Due means "past its time and still waiting".
 *
 * Kept derived rather than stored so it cannot go stale: a message that was
 * scheduled for the future and then had the clock moved back is correctly not
 * overdue again.
 */
export function isOverdue(message: ScheduledMessage, now: number): boolean {
  return isPending(message) && message.sendAt <= now;
}

const TERMINAL: ReadonlySet<ScheduledStatus> = new Set<ScheduledStatus>([
  "sent",
  "failed",
  "cancelled",
]);

/** Terminal states are kept for the history, but never acted on again. */
export function isTerminal(message: ScheduledMessage): boolean {
  return TERMINAL.has(message.status);
}

/** Trimmed for storage and display; also the guard against empty messages. */
export function normalizeContent(content: string): string {
  return content.replace(/\s+$/u, "").replace(/^\s+/u, "");
}

/** Discord's own ceiling for a single message. */
export const MAX_CONTENT_LENGTH = 2000;

export function contentProblem(content: string): string | undefined {
  const trimmed = normalizeContent(content);
  if (!trimmed) return i18nText("ui.write_something_to_send_first");
  if (trimmed.length > MAX_CONTENT_LENGTH) {
    return i18nText("ui.messages_are_limited_to_value_characters", {v0: MAX_CONTENT_LENGTH});
  }
  return undefined;
}

/**
 * Parse stored data defensively.
 *
 * Settings survive across Discord versions, so a record written by an older
 * build — or a hand-edited settings file — must not be able to break startup. A
 * record that fails validation is dropped rather than repaired.
 */
export function parseScheduledMessage(
  value: unknown,
): ScheduledMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;

  const id = raw.id;
  const content = raw.content;
  const channelId = raw.channelId;
  const createdAt = raw.createdAt;
  const sendAt = raw.sendAt;
  const status = raw.status;

  if (typeof id !== "string" || !id) return undefined;
  if (typeof content !== "string") return undefined;
  if (typeof channelId !== "string" || !channelId) return undefined;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) {
    return undefined;
  }
  if (typeof sendAt !== "number" || !Number.isFinite(sendAt)) {
    return undefined;
  }
  if (
    status !== "pending" &&
    status !== "sent" &&
    status !== "failed" &&
    status !== "cancelled"
  ) {
    return undefined;
  }

  const message: ScheduledMessage = {
    id,
    content,
    channelId,
    createdAt,
    sendAt,
    status,
  };

  if (typeof raw.guildId === "string" && raw.guildId) {
    message.guildId = raw.guildId;
  }
  if (typeof raw.lastError === "string" && raw.lastError) {
    message.lastError = raw.lastError;
  }
  if (typeof raw.sentAt === "number" && Number.isFinite(raw.sentAt)) {
    message.sentAt = raw.sentAt;
  }

  return message;
}

/** Ids are generated here so every caller produces the same shape. */
export function newScheduledMessage(input: {
  content: string;
  target: ChannelTarget;
  sendAt: number;
  now: number;
  id?: string;
}): ScheduledMessage {
  const message: ScheduledMessage = {
    id: input.id ?? createId(),
    content: normalizeContent(input.content),
    channelId: input.target.channelId,
    createdAt: input.now,
    sendAt: input.sendAt,
    status: "pending",
  };
  if (input.target.guildId) message.guildId = input.target.guildId;
  return message;
}

/**
 * `crypto.randomUUID` when available, with a fallback.
 *
 * The fallback still has to be unique across restarts, so it mixes time with
 * randomness rather than a counter.
 */
export function createId(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === "function") {
    return cryptoRef.randomUUID();
  }
  if (cryptoRef && typeof cryptoRef.getRandomValues === "function") {
    const bytes = cryptoRef.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
