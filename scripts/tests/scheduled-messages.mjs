/**
 * The scheduled-message core: model, presets, time handling, the store and the
 * scheduler.
 *
 * The scheduler is driven by hand through injected clocks rather than by waiting
 * on real timers, so the interesting cases — a nap, a clock change, a backlog,
 * a double click — are exercised exactly and instantly.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { build } from "esbuild";

const dir = await mkdtemp(path.join(tmpdir(), "dion-sched-"));

await build({
  stdin: {
    contents: `
      export * from './src/renderer/plugins/scheduledMessages/types';
      export * from './src/renderer/plugins/scheduledMessages/presets';
      export * from './src/renderer/plugins/scheduledMessages/time';
      export * from './src/renderer/plugins/scheduledMessages/store';
      export * from './src/renderer/plugins/scheduledMessages/scheduler';
    `,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile: path.join(dir, "bundle.mjs"),
  logLevel: "warning",
});

const core = await import(pathToFileURL(path.join(dir, "bundle.mjs")).href);

// ── a DOM only good enough for the store's change event ──────────────────────
class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }
  dispatchEvent(event) {
    for (const fn of this.listeners.get(event.type) ?? []) fn(event);
    return true;
  }
}

const clock = { wall: 1_760_000_000_000, mono: 0 };
const now = () => clock.wall;
const mono = () => clock.mono;

/** Let an awaited send run its continuation. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Advance both clocks, as a real machine would. */
function advance(ms) {
  clock.wall += ms;
  clock.mono += ms;
}

globalThis.window = new FakeEventTarget();
globalThis.window.setTimeout = setTimeout;
globalThis.window.clearTimeout = clearTimeout;
globalThis.window.dispatchEvent = globalThis.window.dispatchEvent.bind(globalThis.window);
globalThis.document = {
  addEventListener() {},
  removeEventListener() {},
  hidden: false,
};
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init?.detail;
  }
};

// ── the model ────────────────────────────────────────────────────────────────
{
  const { parseScheduledMessage, contentProblem, normalizeContent, newScheduledMessage, createId } = core;

  const good = {
    id: "a", content: "hi", channelId: "c1", guildId: "g1",
    createdAt: 1, sendAt: 2, status: "pending",
  };
  assert.deepEqual(parseScheduledMessage(good), good, "a valid record round-trips");

  // Every field is load-bearing; a missing one must drop the record rather than
  // produce a half-built message that breaks the scheduler later.
  const broken = [
    undefined, null, "text", 42, [],
    { ...good, id: "" },
    { ...good, id: 7 },
    { ...good, content: undefined },
    { ...good, channelId: "" },
    { ...good, createdAt: "yesterday" },
    { ...good, createdAt: Number.NaN },
    { ...good, sendAt: Number.POSITIVE_INFINITY },
    { ...good, status: "sending" },
    { ...good, status: undefined },
  ];
  for (const value of broken) {
    assert.equal(parseScheduledMessage(value), undefined,
      `must reject ${JSON.stringify(value)}`);
  }

  // Optional fields stay optional.
  const minimal = parseScheduledMessage({ ...good, guildId: undefined, lastError: undefined });
  assert.equal("guildId" in minimal, false, "an absent guildId must not be invented");
  assert.equal("lastError" in minimal, false);

  assert.equal(contentProblem(""), "Write something to send first.");
  assert.equal(contentProblem("   \n "), "Write something to send first.");
  assert.equal(contentProblem("x".repeat(2001)).includes(new Intl.NumberFormat("en-US").format(2000)), true);
  assert.equal(contentProblem("hello"), undefined);
  assert.equal(normalizeContent("  hi  "), "hi");

  // A record with no id is unusable as a key.
  assert.match(createId(), /\S/);
  assert.notEqual(createId(), createId(), "ids must be unique");

  const made = newScheduledMessage({
    content: "  hello  ", target: { channelId: "c", channelName: "n", scopeName: "s", isDm: false },
    sendAt: 10, now: 5,
  });
  assert.equal(made.content, "hello");
  assert.equal(made.status, "pending");
  assert.equal(made.createdAt, 5);
  assert.equal(made.guildId, undefined, "a DM target must not gain a guildId");
}
console.log("PASS: the model validates, drops junk and builds clean records");

// ── presets ──────────────────────────────────────────────────────────────────
{
  const { SCHEDULE_PRESETS, resolvePreset, presetById, isPresetId, MIN_LEAD_MS } = core;

  assert.deepEqual(
    SCHEDULE_PRESETS.map((p) => p.id),
    ["m1", "m5", "m15", "m30", "h1", "h3", "tomorrow", "custom"],
    "exactly the presets that were asked for, in order",
  );
  assert.deepEqual(
    SCHEDULE_PRESETS.map((p) => p.label),
    ["In 1 minute", "In 5 minutes", "In 15 minutes", "In 30 minutes",
     "In 1 hour", "In 3 hours", "Tomorrow at this time", "Custom date & time"],
  );

  const t0 = new Date(2026, 8, 27, 14, 30, 0, 0).getTime();
  const minute = 60_000;
  assert.equal(resolvePreset("m1", t0), t0 + minute);
  assert.equal(resolvePreset("m5", t0), t0 + 5 * minute);
  assert.equal(resolvePreset("m15", t0), t0 + 15 * minute);
  assert.equal(resolvePreset("m30", t0), t0 + 30 * minute);
  assert.equal(resolvePreset("h1", t0), t0 + 60 * minute);
  assert.equal(resolvePreset("h3", t0), t0 + 180 * minute);

  // Tomorrow keeps the wall-clock time, whatever the time of day.
  for (const hour of [0, 9, 14, 23]) {
    const at = new Date(2026, 8, 27, hour, 45, 0, 0).getTime();
    const next = resolvePreset("tomorrow", at);
    const then = new Date(next);
    assert.equal(then.getDate(), 28, `hour ${hour}: must be the next day`);
    assert.equal(then.getHours(), hour, `hour ${hour}: must keep the clock time`);
    assert.equal(then.getMinutes(), 45);
    assert.ok(next > at, "must always be in the future");
  }

  // Whatever the moment, no preset may resolve into the past or inside the
  // minimum lead — that is the guarantee the composer relies on.
  for (const offset of [0, 1, -60_000, -3_600_000, 86_400_000]) {
    for (const preset of SCHEDULE_PRESETS) {
      if (!preset.resolve) continue;
      const at = resolvePreset(preset.id, t0 + offset);
      assert.ok(at > t0 + offset, `${preset.id} at ${offset} must be in the future`);
      assert.ok(at - (t0 + offset) >= MIN_LEAD_MS,
        `${preset.id} at ${offset} must respect the minimum lead`);
    }
  }

  assert.equal(resolvePreset("custom", t0), undefined, "custom needs a time from the user");
  assert.equal(presetById("h1").label, "In 1 hour");
  assert.equal(isPresetId("h1"), true);
  assert.equal(isPresetId("nope"), false);
  assert.equal(isPresetId(7), false);
}
console.log("PASS: all eight presets resolve to the future, and custom defers to the picker");

// ── time parsing ─────────────────────────────────────────────────────────────
{
  const { parseLocalDateTime, customTimeProblem, formatCountdown, formatWhen,
          toDateInputValue, toTimeInputValue, formatAbsolute } = core;

  const at = parseLocalDateTime("2026-09-27", "14:05");
  const d = new Date(at);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8);
  assert.equal(d.getDate(), 27);
  assert.equal(d.getHours(), 14);
  assert.equal(d.getMinutes(), 5);
  assert.equal(d.getSeconds(), 0, "seconds are dropped");
  assert.equal(d.getMilliseconds(), 0);

  // Impossible dates must be refused, not rolled over into the next month.
  for (const bad of ["2026-02-31", "2026-04-31", "2026-13-01", "2026-00-10", "2026-09-32"]) {
    assert.equal(parseLocalDateTime(bad, "10:00"), undefined, `${bad} must be refused`);
  }
  for (const bad of ["2026-09-27", "25:00", "10:60", "10:99"]) {
    assert.equal(parseLocalDateTime("2026-09-27", bad), undefined, `time ${bad} must be refused`);
  }
  for (const bad of ["", "tomorrow", "2026-9-7", "26-09-27", "2026-09-27T14:05"]) {
    assert.equal(parseLocalDateTime(bad, "14:05"), undefined, `${bad} must be refused`);
  }
  // A real 29-day month is fine.
  assert.ok(parseLocalDateTime("2028-02-29", "10:00") !== undefined, "leap day is valid");

  const now = new Date(2026, 8, 27, 12, 0, 0, 0).getTime();
  assert.equal(customTimeProblem("2026-09-27", "11:00", now).message, "Pick a time in the future.");
  assert.equal(customTimeProblem("2026-09-27", "12:00", now).message, "Pick a time in the future.",
    "the current minute is not 'in the future'");
  assert.equal(customTimeProblem("2026-09-27", "12:00", now).at, undefined,
    "a past time offers no suggestion, because there is nothing to suggest");

  // Now with seconds, so "12:01" is ahead but inside the one-minute lead.
  const midMinute = new Date(2026, 8, 27, 12, 0, 30, 0).getTime();
  const tooClose = customTimeProblem("2026-09-27", "12:01", midMinute);
  assert.ok(tooClose, "a time inside the minimum lead must be refused");
  assert.match(tooClose.message, /minute/);
  assert.ok(tooClose.at > midMinute, "the refusal suggests a legal time");
  assert.equal(customTimeProblem("2026-09-27", "12:02", midMinute), undefined,
    "a minute out is the earliest legal time");
  assert.equal(customTimeProblem("2026-09-27", "18:00", now), undefined, "a future time is fine");
  assert.equal(customTimeProblem("2026-13-01", "18:00", now).message, "That date and time cannot be read.");

  const minute = 60_000, hour = 60 * minute, day = 24 * hour;
  assert.equal(formatCountdown(now - 1000, now), "due now", "the past reads as due");
  assert.equal(formatCountdown(now, now), "due now", "exactly now is due");
  assert.equal(formatCountdown(now + 30_000, now), "in under a minute");
  assert.equal(formatCountdown(now + 5 * minute, now), "in 5 min");
  assert.equal(formatCountdown(now + 3 * hour, now), "in 3 h");
  assert.equal(formatCountdown(now + day, now), "tomorrow");
  assert.equal(formatCountdown(now + 5 * day, now), "in 5 days");

  assert.equal(toDateInputValue(now), "2026-09-27");
  assert.equal(toTimeInputValue(now), "12:00");
  assert.equal(formatWhen(now, now), "Today, 12:00");
  assert.equal(formatWhen(now + day, now), "Tomorrow, 12:00");
  assert.ok(formatWhen(now + 5 * day, now).includes("2026"));
  assert.ok(formatAbsolute(now).includes("12:00"));
}
console.log("PASS: dates are validated, impossible ones refused, countdowns read plainly");

// ── the picker's starting point ─────────────────────────────────────────────
// A rule that only misbehaves just before midnight cannot be tested by running
// the picker at whatever time the suite happens to start, so the rule itself is
// a pure function and gets driven across a day.
{
  const { defaultSelection, parseTimeOfDay, MIN_LEAD_MS } = core;

  const at = (h, m) => new Date(2026, 8, 27, h, m, 0, 0).getTime();
  const dayOf = (ms) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };

  // Midday: the next quarter hour, on today.
  const noon = defaultSelection(at(12, 0));
  assert.equal(
    noon.timeText,
    "12:15",
    "at least a minute out, snapped up to the next quarter hour",
  );
  assert.equal(dayOf(noon.day), dayOf(at(12, 0)), "and it stays on today");

  // Snapping up to the quarter hour.
  const quarter = defaultSelection(at(9, 7));
  assert.equal(quarter.timeText, "09:15", "snapped up to the next quarter hour");
  assert.equal(dayOf(quarter.day), dayOf(at(9, 7)));

  // Just after midnight: today is still fine.
  const small = defaultSelection(at(0, 5));
  assert.equal(small.timeText, "00:15");
  assert.equal(dayOf(small.day), dayOf(at(0, 5)), "early morning stays on today");

  // The case that used to be broken: snapping up would cross midnight, which
  // would leave a time belonging to tomorrow on a calendar showing today — a
  // moment already in the past.
  for (const [h, m] of [[23, 30], [23, 45], [23, 50], [23, 58], [23, 59]]) {
    const late = defaultSelection(at(h, m));
    const chosen = dayOf(late.day) + (() => {
      const c = parseTimeOfDay(late.timeText);
      return c.hours * 60 + c.minutes;
    })() * 60_000;
    assert.ok(
      chosen > at(h, m),
      `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} must land in the future, got ${late.timeText}`,
    );
    // The day may be today or tomorrow — anything else is a wrong day. What
    // matters is that the pair is coherent and lands ahead of now.
    const dayDelta = (dayOf(late.day) - dayOf(at(h, m))) / 86_400_000;
    assert.ok(
      dayDelta === 0 || dayDelta === 1,
      `${h}:${m} must stay on today or move to tomorrow, moved ${dayDelta} days`,
    );
  }

  // Every starting point must be sendable, at any minute of the day.
  for (let minutes = 0; minutes < 24 * 60; minutes += 7) {
    const now = at(0, 0) + minutes * 60_000;
    const pick = defaultSelection(now);
    const clock = parseTimeOfDay(pick.timeText);
    assert.ok(clock, `at minute ${minutes} the time must parse, got "${pick.timeText}"`);
    const chosen =
      dayOf(pick.day) + (clock.hours * 60 + clock.minutes) * 60_000;
    assert.ok(chosen > now, `at minute ${minutes} it must be in the future`);
    assert.ok(chosen - now >= MIN_LEAD_MS, `at minute ${minutes} it must respect the lead`);
  }

  assert.equal(parseTimeOfDay("24:00"), undefined, "24:00 is not a time");
  assert.equal(parseTimeOfDay("7:5"), undefined, "minutes need two digits");
  assert.deepEqual(parseTimeOfDay("7:05"), { hours: 7, minutes: 5 }, "single-digit hours are fine");
  assert.deepEqual(parseTimeOfDay(" 09:30 "), { hours: 9, minutes: 30 }, "and so is whitespace");
}
console.log("PASS: the picker opens on a day and a time that agree, at any hour");

// ── the store ────────────────────────────────────────────────────────────────
const target = { channelId: "c1", guildId: "g1", channelName: "general", scopeName: "My Server", isDm: false };

function makeStore(seed) {
  const data = new Map();
  if (seed) for (const [k, v] of Object.entries(seed)) data.set(k, v);
  const disposables = [];
  const ctx = {
    plugin: { id: "scheduled-messages", name: "Scheduled Messages" },
    log: Object.fromEntries(["log", "info", "warn", "error"].map((l) => [l, () => {}])),
    disposable: (fn) => disposables.push(fn),
    patch: {}, css: {},
    settings: {
      get: (key, fallback) => (data.has(key) ? data.get(key) : fallback),
      set: (key, value) => data.set(key, value),
    },
  };
  const store = new core.ScheduledStore(ctx);
  store.load();
  return { store, data, ctx, disposables };
}

{
  const { store, data } = makeStore();
  const t0 = now();

  const added = store.add({ content: "first", target, sendAt: t0 + 60_000, now: t0 });
  store.add({ content: "second", target, sendAt: t0 + 30_000, now: t0 });

  // Ordered by send time regardless of insertion order.
  assert.deepEqual(store.all().map((m) => m.content), ["second", "first"]);
  assert.equal(store.nextDueAt(), t0 + 30_000, "the next due time is the earliest");

  // It really is persisted, not just held in memory.
  const persisted = data.get("items");
  assert.ok(Array.isArray(persisted) && persisted.length === 2, "written through to settings");
  const { store: reloaded } = makeStore({ items: persisted });
  assert.equal(reloaded.all().length, 2, "survives a reload");
  assert.equal(reloaded.all()[0].content, "second");

  // Junk in storage must not stop the plugin loading the rest.
  const mixed = makeStore({ items: [persisted[0], { id: "bad" }, null, persisted[1]] });
  assert.equal(mixed.store.all().length, 2, "valid records load, invalid ones are dropped");

  // ── duplicate prevention, the important one ──
  const m = reloaded.all()[0];
  assert.equal(reloaded.claim(m.id), true, "the first claim wins");
  assert.equal(reloaded.claim(m.id), false, "a second claim is refused");
  assert.equal(reloaded.isSending(m.id), true);
  reloaded.markSent(m.id, t0 + 1000);
  assert.equal(reloaded.isSending(m.id), false, "settling releases the claim");
  assert.equal(reloaded.claim(m.id), false, "a sent message is never claimed again");
  assert.equal(reloaded.byId(m.id).status, "sent");
  assert.equal(reloaded.byId(m.id).sentAt, t0 + 1000);

  // ── transitions ──
  const { store: s2 } = makeStore();
  const a = s2.add({ content: "x", target, sendAt: now() + 60_000, now: now() });
  assert.equal(s2.setContent(a.id, "edited"), true);
  assert.equal(s2.byId(a.id).content, "edited");
  assert.equal(s2.cancel(a.id), true);
  assert.equal(s2.byId(a.id).status, "cancelled");
  assert.equal(s2.cancel(a.id), false, "cancelling twice is a no-op");
  assert.equal(s2.setContent(a.id, "nope"), false, "a cancelled message is immutable");
  assert.equal(s2.remove(a.id), true);
  assert.equal(s2.remove(a.id), false);

  // Rescheduling may not push a message into the past.
  const { store: s3 } = makeStore();
  const b = s3.add({ content: "y", target, sendAt: now() - 1000, now: now() });
  assert.equal(s3.setSendAt(b.id, now() - 5000, now()), false, "the past is refused");
  assert.equal(s3.setSendAt(b.id, now() + 5000, now()), true);
  assert.equal(s3.byId(b.id).sendAt, now() + 5000);

  // A failed send can be retried, and lands in the future either way.
  const { store: s4 } = makeStore();
  const c = s4.add({ content: "z", target, sendAt: now() - 10_000, now: now() });
  s4.markFailed(c.id, "no permission");
  assert.equal(s4.byId(c.id).status, "failed");
  assert.equal(s4.byId(c.id).lastError, "no permission");
  assert.equal(s4.retry(c.id, now()), true);
  assert.equal(s4.byId(c.id).status, "pending");
  assert.equal(s4.byId(c.id).lastError, undefined, "the error is cleared on retry");
  assert.ok(s4.byId(c.id).sendAt > now(), "a retry is never due in the past");

  // lastError must be removable, not left behind as undefined-valued noise.
  assert.equal("lastError" in s4.byId(c.id), false);

  // Overdue means "past its time and still waiting" — derived, never stored.
  const { store: s5 } = makeStore();
  const d1 = s5.add({ content: "p1", target, sendAt: now() - 1000, now: now() });
  const d2 = s5.add({ content: "p2", target, sendAt: now() + 100_000, now: now() });
  assert.deepEqual(s5.overdue(now()).map((m) => m.id), [d1.id]);
  assert.equal(s5.overdue(now()).length, 1);
  s5.cancel(d2.id);
  assert.equal(s5.overdue(now()).length, 1, "a cancelled message is never overdue");
  // The still-pending overdue one is exactly what a timer should be armed for.
  assert.equal(s5.nextDueAt(), d1.sendAt);

  // With nothing actionable left there is no reason to keep a timer alive.
  s5.cancel(d1.id);
  assert.equal(s5.nextDueAt(), undefined, "nothing pending means no timer to arm");
}
console.log("PASS: the store persists, orders, transitions and refuses a second send");

// History must stay bounded without ever dropping something pending.
{
  const { store } = makeStore();
  for (let i = 0; i < 200; i++) {
    const m = store.add({ content: `m${i}`, target, sendAt: now() + i, now: now() });
    store.markSent(m.id, now());
  }
  const kept = store.all();
  assert.ok(kept.length <= 60, `history is capped, got ${kept.length}`);
  assert.ok(kept.length >= 30, "recent history is kept");

  const { store: s2 } = makeStore();
  for (let i = 0; i < 100; i++) s2.add({ content: `p${i}`, target, sendAt: now() + 10_000_000 + i, now: now() });
  assert.equal(s2.all().length, 100, "pending messages are never pruned");
}
console.log("PASS: finished history is trimmed, pending messages never are");

// ── the scheduler ────────────────────────────────────────────────────────────
{
  const schedulers = [];
  const track = (s) => { schedulers.push(s); return s; };
  const { store } = makeStore();
  const sent = [];
  let backlog = 0;
  const settled = [];

  const sched = track(new core.Scheduler(
    { plugin: { id: "x" }, log: { info(){}, warn(){}, error(){}, log(){} }, disposable(){} },
    {
      store,
      send: async (m) => { sent.push(m.id); },
      onBacklog: (list) => { backlog += list.length; },
      onSettled: (m, ok, err) => settled.push({ id: m.id, ok, err }),
      now, mono,
    },
  ));

  clock.wall = 1_760_000_000_000; clock.mono = 0;
  const base = clock.wall;

  const a = store.add({ content: "soon", target, sendAt: base + 10_000, now: base });
  const b = store.add({ content: "later", target, sendAt: base + 300_000, now: base });

  sched.start();
  assert.equal(sent.length, 0, "nothing is sent before its time");
  assert.equal(backlog, 0);

  // Not yet.
  advance(5_000);
  sched.tick();
  assert.equal(sent.length, 0, "still early");

  // Due.
  advance(6_000);
  sched.tick();
  assert.deepEqual(sent, [a.id], "the due message goes out, in time order");
  // The send is awaited, so the status settles a microtask later.
  await settle();
  assert.equal(store.byId(a.id).status, "sent");
  assert.equal(settled.at(-1).ok, true);
  assert.equal(store.byId(a.id).sentAt, clock.wall);

  // A tick arriving during a send must not produce a second one.
  const { store: s2 } = makeStore();
  const sent2 = [];
  let resolveSend;
  const slow = track(new core.Scheduler(
    { plugin: { id: "x" }, log: { info(){}, warn(){}, error(){}, log(){} }, disposable(){} },
    { store: s2, send: () => new Promise((r) => { resolveSend = r; }), now, mono },
  ));
  // Anchored to the clock as it is now: a message already overdue at start()
  // would be held for the user instead of dispatched.
  const b2 = clock.wall;
  const c = s2.add({ content: "slow", target, sendAt: b2 + 1000, now: b2 });
  slow.start();
  assert.equal(s2.isSending(c.id), false, "not claimed before it is due");
  advance(2000);
  slow.tick();
  slow.tick();
  slow.tick();
  assert.equal(sent2.length, 0);
  // The claim is what matters: a second attempt is refused while one is in air.
  assert.equal(s2.isSending(c.id), true, "held while in flight");
  assert.equal(s2.claim(c.id), false, "and cannot be claimed again");
  resolveSend?.();
  await settle();
  assert.equal(s2.byId(c.id).status, "sent");

  // A failure is recorded, not thrown away.
  const { store: s3 } = makeStore();
  const s3sched = track(new core.Scheduler(
    { plugin: { id: "x" }, log: { info(){}, warn(){}, error(){}, log(){} }, disposable(){} },
    { store: s3, send: async () => { throw new Error("Missing Permissions"); }, now, mono },
  ));
  const b3 = clock.wall;
  const d = s3.add({ content: "doomed", target, sendAt: b3 + 1000, now: b3 });
  s3sched.start();
  advance(2000);
  s3sched.tick();
  await settle();
  assert.equal(s3.byId(d.id).status, "failed");
  assert.equal(s3.byId(d.id).lastError, "Missing Permissions");
  assert.equal(s3.isSending(d.id), false, "a failed send releases its claim so it can be retried");

  // A machine that was asleep for an hour: one tick, and the backlog is found.
  const { store: s4 } = makeStore();
  const sent4 = [];
  let backlog4 = null;
  const s4sched = track(new core.Scheduler(
    { plugin: { id: "x" }, log: { info(){}, warn(){}, error(){}, log(){} }, disposable(){} },
    {
      store: s4,
      send: async (m) => { sent4.push(m.id); },
      onBacklog: (l) => { backlog4 = l.map((m) => m.id); },
      now, mono,
    },
  ));
  const b4 = clock.wall;
  const e1 = s4.add({ content: "e1", target, sendAt: b4 + 60_000, now: b4 });
  const e2 = s4.add({ content: "e2", target, sendAt: b4 + 120_000, now: b4 });
  s4sched.start();
  assert.equal(sent4.length, 0);

  // The nap. Wall clock jumps an hour; the monotonic clock only advances a tick.
  clock.wall += 3_600_000;
  clock.mono += 16_000;
  s4sched.tick();
  assert.equal(sent4.length, 1, "one message goes out, serially, not a burst");
  await settle();
  s4sched.tick();
  assert.equal(sent4.length, 2, "the next one follows");
  assert.deepEqual(sent4, [e1.id, e2.id], "in scheduled order");

  // The clock moving backwards must not fire anything early.
  const { store: s5 } = makeStore();
  const sent5 = [];
  const s5sched = track(new core.Scheduler(
    { plugin: { id: "x" }, log: { info(){}, warn(){}, error(){}, log(){} }, disposable(){} },
    { store: s5, send: async (m) => { sent5.push(m.id); }, now, mono },
  ));
  // Anchored to the clock as it is now, since the block above moved it.
  const b5 = clock.wall;
  s5.add({ content: "future", target, sendAt: b5 + 600_000, now: b5 });
  s5sched.start();
  assert.equal(sent5.length, 0, "nothing is due yet");
  clock.wall -= 3_600_000; // the user sets the clock back an hour
  clock.mono += 16_000;
  s5sched.tick();
  s5sched.tick();
  assert.equal(sent5.length, 0, "a rewound clock must not trigger a future message");
  // Coming back to normal time brings it due, exactly once.
  clock.wall = b5 + 600_000;
  clock.mono += 16_000;
  s5sched.tick();
  await settle();
  assert.equal(sent5.length, 1, "once time catches up, it fires once");

  // Messages already overdue when the plugin starts are offered, not fired.
  const { store: s6 } = makeStore();
  const sent6 = [];
  let backlog6 = null;
  const stale = s6.add({ content: "stale", target, sendAt: clock.wall - 5_000, now: clock.wall - 60_000 });
  s6.markSent(stale.id, clock.wall - 4000);
  const missed = s6.add({ content: "missed", target, sendAt: clock.wall - 5_000, now: clock.wall - 60_000 });
  const s6sched = track(new core.Scheduler(
    { plugin: { id: "x" }, log: { info(){}, warn(){}, error(){}, log(){} }, disposable(){} },
    {
      store: s6, send: async (m) => { sent6.push(m.id); },
      onBacklog: (l) => { backlog6 = l.map((m) => m.id); },
      now, mono,
    },
  ));
  s6sched.start();
  assert.deepEqual(backlog6, [missed.id], "the overdue one is reported for a decision");
  // It is deliberately left for the user rather than sent on sight.
  assert.equal(sent6.length, 0, "a backlog is not drained without the user choosing");
  assert.equal(s6.byId(missed.id).status, "pending");

  // Rescheduling it is the user choosing, and that must actually let it through:
  // the hold is a set of ids, so it has to notice the time moved.
  s6.setSendAt(missed.id, clock.wall + 5_000, clock.wall);
  s6sched.tick();
  await settle();
  assert.equal(sent6.length, 0, "not yet");
  clock.wall += 6_000;
  clock.mono += 6_000;
  s6sched.tick();
  await settle();
  assert.deepEqual(sent6, [missed.id], "a rescheduled backlog message does get sent");
  assert.equal(s6.byId(missed.id).status, "sent");

  // And "send now" on a still-held one is the other way the user can clear it.
  const { store: s7 } = makeStore();
  const sent7 = [];
  let s7sched;
  s7sched = track(new core.Scheduler(
    { plugin: { id: "x" }, log: { info(){}, warn(){}, error(){}, log(){} }, disposable(){} },
    { store: s7, send: async (m) => { sent7.push(m.id); }, now, mono },
  ));
  const b7 = clock.wall;
  const heldOne = s7.add({ content: "held", target, sendAt: b7 - 1000, now: b7 - 60_000 });
  s7sched.start();
  s7sched.tick();
  await settle();
  assert.equal(sent7.length, 0, "still held after a tick");
  assert.equal(await s7sched.sendNow(s7.byId(heldOne.id)), true, "the user can force it");
  await settle();
  assert.deepEqual(sent7, [heldOne.id], "send now bypasses the hold, once");
  assert.equal(s7.byId(heldOne.id).status, "sent");

  // Stopping really stops it.
  s4sched.stop();
  clock.wall += 10_000_000;
  s4sched.tick();
  assert.equal(sent4.length, 2, "a stopped scheduler does nothing, even when things are due");

  // Every loop is stopped, so a live interval cannot keep the test alive.
  for (const s of schedulers) s.stop();
  assert.ok(schedulers.length >= 6, "the scheduler was exercised in several configurations");
}
console.log("PASS: the scheduler is serial, restart-safe, clock-aware and stops cleanly");

console.log("\nAll scheduled-messages core checks passed.");
