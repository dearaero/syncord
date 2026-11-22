import { createLogger } from "../../api/logger";
import type { PluginContext } from "../../api/plugin";
import {
  isTerminal,
  newScheduledMessage,
  parseScheduledMessage,
  type ChannelTarget,
  type ScheduledMessage,
  type ScheduledStatus,
} from "./types";

/**
 * Persistence and in-memory state for scheduled messages.
 *
 * Storage is the plugin's own settings slot, which the main process writes to
 * `settings.json`. That keeps the data JSON-only, which matters: the settings
 * writer does a whole-file rewrite, and anything non-serialisable would be
 * silently lost.
 *
 * The instance is created per plugin start rather than kept as a module
 * singleton, because it holds the plugin context: disabling the plugin must
 * drop the old context's disposers, and a lingering reference to them would
 * re-register cleanup on a context that is already closed.
 */

const log = createLogger("scheduled-messages");

/** Settings key for the list. Namespaced by the plugin settings helper. */
const ITEMS_KEY = "items";
/** Bumped when the stored shape changes, so old data can be migrated. */
const SCHEMA_VERSION = 1;

const VERSION_KEY = "schemaVersion";

/**
 * Broadcast on `window` whenever the list changes, so the settings panel and
 * anything else mounted can redraw without polling.
 */
export const scheduledChangeEvent = "Syncord-scheduled-messages-change";

/**
 * How many finished messages to keep.
 *
 * Sent and cancelled rows are history, not work. Without a cap the settings
 * file would grow forever, and every write rewrites all of it.
 */
const HISTORY_LIMIT = 60;
const HISTORY_KEEP = 30;

export type ScheduledChange = { messages: readonly ScheduledMessage[] };

export class ScheduledStore {
  private readonly ctx: PluginContext;

  /** Authoritative copy, ordered by send time. */
  private messages: ScheduledMessage[] = [];

  /**
   * Ids currently being sent.
   *
   * In memory only, on purpose: a persisted "sending" that survived a crash
   * would be a claim we cannot verify. Anything that was mid-send comes back as
   * `pending` and the user is asked.
   */
  private readonly inFlight = new Set<string>();

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
  }

  /**
   * Read persisted messages, discarding anything malformed.
   *
   * The settings file survives upgrades and can be hand-edited, so a bad record
   * must not be able to stop the plugin from starting.
   */
  load(): void {
    const raw = this.ctx.settings.get<unknown>(ITEMS_KEY, []);
    const version = this.ctx.settings.get<number>(VERSION_KEY, 0);

    if (!Array.isArray(raw)) {
      this.messages = [];
      return;
    }

    const parsed: ScheduledMessage[] = [];
    let dropped = 0;
    for (const entry of raw) {
      const message = parseScheduledMessage(entry);
      if (message) parsed.push(message);
      else dropped += 1;
    }

    this.messages = sortBySendAt(parsed);

    if (dropped) {
      log.warn(`dropped ${dropped} unreadable scheduled message(s)`);
    }
    if (version !== SCHEMA_VERSION) {
      this.ctx.settings.set(VERSION_KEY, SCHEMA_VERSION);
    }
  }

  all(): readonly ScheduledMessage[] {
    return this.messages;
  }

  byId(id: string): ScheduledMessage | undefined {
    return this.messages.find((message) => message.id === id);
  }

  /** Only the rows the user still has to act on. */
  pending(): ScheduledMessage[] {
    return this.messages.filter((message) => message.status === "pending");
  }

  /**
   * Messages that came due while we were not running.
   *
   * Returned rather than sent: the user asked to be offered a choice, and
   * firing a backlog without asking is exactly the uncontrolled behaviour they
   * ruled out.
   */
  overdue(now: number): ScheduledMessage[] {
    return this.messages.filter(
      (message) => message.status === "pending" && message.sendAt <= now,
    );
  }

  /** Messages due now or earlier, in the order they should be sent. */
  due(now: number): ScheduledMessage[] {
    return this.messages
      .filter(
        (message) =>
          message.status === "pending" && message.sendAt <= now && !this.inFlight.has(message.id),
      )
      .sort((a, b) => a.sendAt - b.sendAt);
  }

  /**
   * The next time anything is due, for arming a precise timer.
   *
   * `exclude` lets the scheduler ignore messages it is deliberately holding for
   * the user, so a held message does not keep re-arming a timer for a moment
   * that will never be acted on automatically.
   */
  nextDueAt(exclude?: ReadonlySet<string>): number | undefined {
    let next: number | undefined;
    for (const message of this.messages) {
      if (message.status !== "pending" || this.inFlight.has(message.id)) {
        continue;
      }
      if (exclude?.has(message.id)) continue;
      if (next === undefined || message.sendAt < next) next = message.sendAt;
    }
    return next;
  }

  add(input: {
    content: string;
    target: ChannelTarget;
    sendAt: number;
    now: number;
  }): ScheduledMessage {
    const message = newScheduledMessage({ ...input, now: input.now });
    this.messages = sortBySendAt([...this.messages, message]);
    this.commit();
    return message;
  }

  /** Edit the text of a message that has not gone out yet. */
  setContent(id: string, content: string): boolean {
    const message = this.byId(id);
    if (!message || message.status !== "pending") return false;
    this.replace({ ...message, content });
    return true;
  }

  /**
   * Move a message's send time.
   *
   * Refuses a time that is not in the future: rescheduling something that was
   * due into the past would fire it immediately, which is never what "change
   * the date" means.
   */
  setSendAt(id: string, sendAt: number, now: number): boolean {
    const message = this.byId(id);
    if (!message || message.status !== "pending") return false;
    if (!Number.isFinite(sendAt) || sendAt <= now) return false;
    this.inFlight.delete(id);
    this.replace({ ...message, sendAt });
    return true;
  }

  cancel(id: string): boolean {
    const message = this.byId(id);
    if (!message || message.status !== "pending") return false;
    this.inFlight.delete(id);
    this.patch(id, { status: "cancelled", lastError: undefined });
    return true;
  }

  remove(id: string): boolean {
    const before = this.messages.length;
    this.messages = this.messages.filter((message) => message.id !== id);
    if (this.messages.length === before) return false;
    this.commit();
    return true;
  }

  markSent(id: string, now: number): boolean {
    this.inFlight.delete(id);
    return this.patch(id, { status: "sent", sentAt: now, lastError: undefined });
  }

  /** A failed attempt stays pending-able, so the user can retry it. */
  markFailed(id: string, reason: string): boolean {
    this.inFlight.delete(id);
    return this.patch(id, { status: "failed", lastError: reason });
  }

  /**
   * Put a failed message back in the queue, keeping its original time.
   *
   * The time is only moved forward if it is already in the past, otherwise
   * "retry" would send something the user had already given up on the moment
   * they retried.
   */
  retry(id: string, now: number, sendAt?: number): boolean {
    const message = this.byId(id);
    if (!message) return false;
    const next =
      sendAt !== undefined
        ? sendAt
        : Math.max(message.sendAt, now + 1000);
    if (next <= now) return false;
    this.replace({ ...message, status: "pending", sendAt: next, lastError: undefined });
    return true;
  }

  /**
   * Claim a message for sending.
   *
   * The single guard against sending the same message twice: a tick that
   * overlaps the previous send, and a manual "send now" pressed twice, both
   * come through here. Returns false when the claim is already held.
   */
  claim(id: string): boolean {
    const message = this.byId(id);
    if (!message) return false;
    if (this.inFlight.has(id)) return false;
    if (message.status !== "pending") return false;
    this.inFlight.add(id);
    return true;
  }

  /** True while a send is in progress, for the UI to disable buttons. */
  isSending(id: string): boolean {
    return this.inFlight.has(id);
  }

  /** True for anything the scheduler will no longer touch. */
  isFinished(message: ScheduledMessage): boolean {
    return isTerminal(message) || this.inFlight.has(message.id);
  }

  /**
   * Drop the oldest finished rows once history grows past the cap.
   *
   * Only terminal rows go, so nothing the user still has to act on is lost.
   */
  private prune(): void {
    const finished = this.messages.filter((message) => isTerminal(message));
    if (finished.length <= HISTORY_LIMIT) return;
    const excess = finished
      .slice()
      .sort((a, b) => a.sendAt - b.sendAt)
      .slice(0, finished.length - HISTORY_KEEP);
    if (!excess.length) return;
    const drop = new Set(excess.map((message) => message.id));
    this.messages = this.messages.filter((message) => !drop.has(message.id));
  }

  private replace(next: ScheduledMessage): void {
    this.messages = sortBySendAt(
      this.messages.map((message) =>
        message.id === next.id ? tidy(next) : message,
      ),
    );
    this.commit();
  }

  private patch(
    id: string,
    change: Partial<ScheduledMessage> & { status?: ScheduledStatus },
  ): boolean {
    let changed = false;
    const next = this.messages.map((message) => {
      if (message.id !== id) return message;
      changed = true;
      return tidy({ ...message, ...change });
    });
    if (!changed) return false;
    this.messages = sortBySendAt(next);
    this.commit();
    return true;
  }

  private commit(): void {
    this.prune();
    this.ctx.settings.set(ITEMS_KEY, this.messages);
    this.emit();
  }

  private emit(): void {
    try {
      window.dispatchEvent(
        new CustomEvent<ScheduledChange>(scheduledChangeEvent, {
          detail: { messages: this.messages },
        }),
      );
    } catch (err) {
      log.warn("could not announce the change:", err);
    }
  }
}

function sortBySendAt(messages: ScheduledMessage[]): ScheduledMessage[] {
  return messages.slice().sort((a, b) => a.sendAt - b.sendAt);
}

/**
 * Drop optional fields that were cleared.
 *
 * Spreading `{ lastError: undefined }` leaves the key present, which makes
 * "does this message have an error?" answerable two different ways depending on
 * which code path wrote it. Every write goes through here so the in-memory shape
 * matches what the JSON round-trip will produce.
 */
function tidy(message: ScheduledMessage): ScheduledMessage {
  const out: ScheduledMessage = { ...message };
  if (out.lastError === undefined) delete out.lastError;
  if (out.sentAt === undefined) delete out.sentAt;
  if (out.guildId === undefined) delete out.guildId;
  return out;
}

/**
 * The live store, or `undefined` while the plugin is stopped.
 *
 * The settings panel and the composer read through this rather than importing
 * an instance, so they see `undefined` instead of stale data after a disable.
 */
let current: ScheduledStore | undefined;

export function setActiveStore(store: ScheduledStore | undefined): void {
  current = store;
}

export function activeStore(): ScheduledStore | undefined {
  return current;
}
