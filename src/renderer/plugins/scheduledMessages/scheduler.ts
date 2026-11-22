import { createLogger } from "../../api/logger";
import type { PluginContext } from "../../api/plugin";
import type { ScheduledStore } from "./store";
import type { ScheduledMessage } from "./types";

/**
 * The dispatch loop.
 *
 * The rules that make this survive a real machine:
 *
 *  1. Every decision is made against `Date.now()`. Nothing is counted in ticks
 *     and nothing is accumulated, so a missed tick, a throttled one or a nap of
 *     two hours all resolve to the same answer.
 *  2. There is an interval as the floor, plus a short timer aimed at the next
 *     due message for precision. Never one long timeout: a single timer that
 *     fires once and is re-armed is exactly what breaks when the process is
 *     suspended, because the wake-up callback is the only thing that can notice
 *     a clock jump, and a chain of them compounds the error.
 *  3. Waking up is detected explicitly (window focus, visibility) and from the
 *     interval gap, so a backlog is picked up immediately.
 *  4. A wall-clock change is detected by comparing `Date.now()` against the
 *     monotonic `performance.now()`. If the user moves the system clock, timers
 *     are unaffected but every stored due time moves with it, and the loop has
 *     to know that the gap it just saw was not a nap.
 */

const log = createLogger("scheduled-messages:scheduler");

/** Floor cadence. Comfortably under a minute, cheap enough to run always. */
const TICK_MS = 10_000;

/**
 * The precision timer never waits longer than this, so one very distant message
 * cannot hold a short one hostage, and a clock change is picked up quickly
 * instead of after an hour.
 */
const PRECISE_MAX_MS = 60_000;

/** Fire slightly early rather than a hair late, then let the guard re-check. */
const PRECISE_EPSILON_MS = 150;

/**
 * How far the wall clock may drift from the monotonic clock before it counts as
 * a deliberate change. A few seconds of ordinary NTP slew stays under it.
 */
const CLOCK_JUMP_TOLERANCE_MS = 2_000;

/**
 * Sending is serialised.
 *
 * After a long sleep a whole backlog can come due at once, and firing them in
 * parallel invites rate limiting for no benefit. One at a time also keeps the
 * order the messages were scheduled in.
 */
const MAX_CONCURRENT_SENDS = 1;

export type SchedulerDeps = {
  store: ScheduledStore;
  /** Sends one message. Must resolve, never reject. */
  send: (message: ScheduledMessage) => Promise<void>;
  /** Called when a send settles, for a toast. */
  onSettled?: (message: ScheduledMessage, ok: boolean, error?: string) => void;
  /** Called when due messages are found that predate this run. */
  onBacklog?: (messages: readonly ScheduledMessage[]) => void;
  /** Overridable for tests. */
  now?: () => number;
  mono?: () => number;
};

export class Scheduler {
  private readonly ctx: PluginContext;
  private readonly deps: SchedulerDeps;
  private readonly now: () => number;
  private readonly mono: () => number;

  private interval: ReturnType<typeof setInterval> | undefined;
  private precise: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private stopped = false;
  private inFlight = 0;

  /**
   * Messages that were already due when the loop started.
   *
   * They are reported to the user and then held: the client was closed, the
   * moment passed without anyone watching, and firing a backlog unasked is
   * exactly the uncontrolled behaviour the feature must not have. They leave
   * this set the moment the user acts — sent, rescheduled or cancelled — and a
   * message that comes due while we are running is never held.
   */
  private readonly held = new Set<string>();

  private lastWall = 0;
  private lastMono = 0;

  constructor(ctx: PluginContext, deps: SchedulerDeps) {
    this.ctx = ctx;
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.mono =
      deps.mono ??
      (() =>
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now());
  }

  start(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    this.lastWall = this.now();
    this.lastMono = this.mono();

    this.interval = setInterval(() => this.tick(), TICK_MS);

    // A machine that was asleep, or a window that was hidden, gets its backlog
    // the moment it is looked at again.
    const onWake = (): void => this.tick();
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    window.addEventListener("online", onWake);
    this.ctx.disposable(() => {
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("online", onWake);
    });

    // Anything already overdue is a backlog to decide on, not a queue to drain.
    const backlog = this.deps.store.overdue(this.now());
    for (const message of backlog) this.held.add(message.id);
    if (backlog.length) {
      this.deps.onBacklog?.(backlog);
    }

    this.arm();
    this.tick();
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
    if (this.interval !== undefined) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    this.clearPrecise();
  }

  /**
   * Re-evaluate now.
   *
   * Exposed for the "send now" button and for the panel, so a manual action is
   * not queued behind the next interval.
   */
  tick(): void {
    if (!this.running || this.stopped) return;
    // A tick that arrives while one is already running would double-claim; the
    // store's own guard would stop a double send, but skipping is cheaper and
    // keeps the log clean.
    if (this.inFlight >= MAX_CONCURRENT_SENDS) return;

    const wall = this.now();
    this.detectClockJump(wall);
    this.lastWall = wall;
    this.lastMono = this.mono();

    this.arm();
    this.releaseSettledHolds(wall);

    const due = this.deps.store.due(wall).filter((m) => !this.held.has(m.id));
    if (!due.length) return;
    void this.dispatch(due[0]!);
  }

  /**
   * Drop held ids the user has dealt with.
   *
   * The hold is a set of ids, so it cannot know that a message was rescheduled,
   * retried, cancelled or deleted. Checking the current state instead of being
   * told about it keeps the store free of scheduler concerns, and a held message
   * is released as soon as it is no longer overdue — so moving it to a real time
   * is enough to let it fire then, with no further nudge.
   */
  private releaseSettledHolds(wall: number): void {
    if (!this.held.size) return;
    for (const id of [...this.held]) {
      const message = this.deps.store.byId(id);
      if (!message || message.status !== "pending" || message.sendAt > wall) {
        this.held.delete(id);
      }
    }
  }

  /**
   * Point the precision timer at the next due message.
   *
   * Re-armed from `tick`, not chained from its own callback, so it can never
   * drift or stop after a missed wake-up.
   */
  private arm(): void {
    this.clearPrecise();
    if (!this.running || this.stopped) return;

    const next = this.deps.store.nextDueAt(this.held);
    if (next === undefined) return;

    const delay = Math.min(
      Math.max(next - this.now() - PRECISE_EPSILON_MS, 0),
      PRECISE_MAX_MS,
    );
    this.precise = setTimeout(() => this.tick(), delay);
  }

  private clearPrecise(): void {
    if (this.precise !== undefined) {
      clearTimeout(this.precise);
      this.precise = undefined;
    }
  }

  private detectClockJump(wall: number): void {
    const mono = this.mono();
    const wallDelta = wall - this.lastWall;
    const monoDelta = mono - this.lastMono;
    if (wallDelta < 0 || monoDelta < 0) {
      // A monotonic clock going backwards is impossible; treat it as a reset.
      this.lastWall = wall;
      this.lastMono = mono;
      return;
    }
    const drift = Math.abs(wallDelta - monoDelta);
    if (drift > CLOCK_JUMP_TOLERANCE_MS) {
      log.info(
        `system clock moved by ${Math.round(wallDelta - monoDelta)}ms — re-evaluating`,
      );
    }
  }

  private async dispatch(message: ScheduledMessage): Promise<void> {
    // The claim is the duplicate guard. Whoever wins it sends; the other caller
    // backs off without a second request.
    if (!this.deps.store.claim(message.id)) return;

    this.held.delete(message.id);
    this.inFlight += 1;
    const settledAt = this.now();
    try {
      await this.deps.send(message);
      this.deps.store.markSent(message.id, settledAt);
      this.deps.onSettled?.(message, true);
      log.info(`sent ${message.id}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.deps.store.markFailed(message.id, reason);
      this.deps.onSettled?.(message, false, reason);
      log.warn(`send failed for ${message.id}: ${reason}`);
    } finally {
      this.inFlight -= 1;
      // Something else may have come due while this one was in the air.
      if (this.running && !this.stopped) this.tick();
    }
  }

  /**
   * Send one message immediately, ignoring its time.
   *
   * The user asked for it, so the usual "not in the future" guard does not
   * apply; the duplicate guard still does.
   */
  async sendNow(message: ScheduledMessage): Promise<boolean> {
    if (this.inFlight >= MAX_CONCURRENT_SENDS) return false;
    await this.dispatch(message);
    return true;
  }
}
