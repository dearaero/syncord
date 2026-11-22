/**
 * Plugin manager lifecycle tests.
 *
 * Run: `node --test scripts/tests/plugin-manager.test.mjs`
 *
 * Bundles the real `src/renderer/api/plugin/manager.ts` and drives it with a
 * minimal `window`. Two behaviours are asserted that neither a unit test of the
 * primitives nor the static scan can see, because both bugs lived in the
 * *connection* between the caller and the primitive:
 *
 *  - **Safe Mode is a filter, not a one-time gate.** `startAll()` skipped
 *    non-core plugins while Safe Mode was on, but `enable()` did not check, so
 *    anything with a reference to the manager — the settings UI, a plugin, or
 *    page code reaching `window.Syncord` — could start one anyway. Safe Mode
 *    is what a user reaches for when a plugin is misbehaving; it has to hold
 *    until they turn it off.
 *
 *  - **Enable/disable is serialised.** `started` is set only after `await
 *    start()`, so two overlapping `enable()` calls can both pass the "already
 *    started?" check and run `start()` twice. The second disposer overwrites the
 *    first, so whatever the plugin patched is never undone on disable.
 *
 * `definePlugin` is the only registration path and it refuses a duplicate id, so
 * each test builds its own definition.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { test } from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), "dion-mgr-"));
const outfile = path.join(dir, "manager.mjs");

const store = new Map();

// A real (tiny) event target. Stubbing these as no-ops would make the
// safe-mode-applied test vacuous: the event would appear to work regardless of
// when the listener was attached, which is the exact bug being pinned.
const listeners = new Map();
function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
}
function off(type, fn) {
  listeners.get(type)?.delete(fn);
}
function fire(type, detail) {
  for (const fn of listeners.get(type) ?? []) fn({ type, detail });
}

globalThis.window = {
  addEventListener: on,
  removeEventListener: off,
  dispatchEvent(event) {
    fire(event.type, event.detail);
    return true;
  },
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => void store.delete(k),
  },
  location: { href: "https://discord.com/app", reload() {} },
};

await build({
  stdin: {
    contents: `export * from './src/renderer/api/plugin/manager';export {setLocale,canonicalMessage,t,SUPPORTED_LOCALES} from './src/renderer/i18n/core';`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile,
  logLevel: "warning",
  loader: { ".png": "dataurl" },
});

const M = await import(pathToFileURL(outfile).href);

/**
 * A fresh, independently-stateful copy of the manager.
 *
 * `armLockdown()` is one-way by design, and there is deliberately no production
 * way to disarm it — so a test that needs a clean slate cannot ask the module to
 * reset. Re-importing with a cache-busting query gives a *separate* module
 * instance with its own closure, which is the isolation the test actually needs.
 *
 * The alternative — a test-only exported reset — would put an unlock on the
 * module's surface forever, and "there is a way out of the emergency stop" is
 * the exact property item 4 is about.
 */
let instanceCounter = 0;
async function freshManager() {
  instanceCounter += 1;
  const url = `${pathToFileURL(outfile).href}?instance=${instanceCounter}`;
  return import(url);
}

/**
 * A plugin plus a counter that survives registration.
 *
 * `definePlugin` stores `{...def, permissions}`, so the object the manager holds
 * is a **copy** — counters written to `this` inside `start()` never appear on the
 * object the test created, and every assertion below would read 0. The counter
 * is therefore held in a closure, which the spread cannot take away.
 */
function freshPlugin(id) {
  const counter = { start: 0, stop: 0 };
  const plugin = {
    id,
    name: "Test",
    description: "test",
    author: "t",
    permissions: {},
    // startOne() skips a plugin whose enabled flag is false, so a test plugin has
    // to opt in or start() never runs and every assertion below is vacuous.
    enabledByDefault: true,
    start(ctx) {
      counter.start += 1;
      void ctx;
    },
    stop() {
      counter.stop += 1;
    },
  };
  return { plugin, counter };
}

test("lifecycle: enable and disable run the plugin's start and stop", async () => {
  const { plugin: p, counter } = freshPlugin("lifecycle-single");
  M.definePlugin(p);
  // The counter is zeroed because the Safe Mode test calls `startAll()`, which
  // starts every *enabled* plugin — including this one. The manager holds
  // module-level state, so sharing it across tests is unavoidable; making each
  // test's precondition explicit beats depending on declaration order.
  counter.start = 0;
  counter.stop = 0;
  await M.enable(p.id);
  assert.equal(counter.start, 1, "start must run exactly once");
  await M.disable(p.id);
  assert.equal(counter.stop, 1, "stop must run exactly once");
});

test("lifecycle: enabling twice does not start the plugin twice", async () => {
  // `started` used to be set only after `await start()`, so two overlapping
  // calls both passed the "already started?" check and both ran `start()`.
  const { plugin: p, counter } = freshPlugin("lifecycle-double");
  M.definePlugin(p);
  counter.start = 0;
  counter.stop = 0;
  await Promise.all([M.enable(p.id), M.enable(p.id)]);
  assert.equal(counter.start, 1, `two concurrent enable() calls ran start() ${counter.start} times`);
  await M.disable(p.id);
  assert.equal(counter.stop, 1, "the plugin must be stopped exactly once — no leaked disposer");
});

test("safe mode: enable() refuses a non-core plugin, and startAll agrees", async () => {
  // The bug: startAll skipped non-core plugins, enable() did not. Anything with
  // a reference to the manager could start one anyway.
  const { plugin: p, counter } = freshPlugin("safe-mode-blocked");
  M.setSafeMode(true);
  try {
    M.definePlugin(p);
    await M.enable(p.id);
    assert.equal(counter.start, 0, "Safe Mode must block enable() for a non-core plugin");
    await M.startAll();
    assert.equal(counter.start, 0, "Safe Mode must block startAll() for a non-core plugin");
  } finally {
    M.setSafeMode(false);
  }
});

test("safe mode: a core plugin is still allowed through enable()", async () => {
  // The other half: the filter must not become "no plugins at all", or Safe Mode
  // would be indistinguishable from a broken install.
  // Must be an id the *renderer's* core list actually contains. That list is a
  // literal mirroring src/main/security/modes.ts, and the two can drift — which
  // is exactly finding #46. A main-process-only id would make this test pass or
  // fail for the wrong reason.
  const { plugin: core, counter } = freshPlugin("message-logger");
  M.setSafeMode(true);
  try {
    M.definePlugin(core);
    counter.start = 0;
    counter.stop = 0;
    await M.enable(core.id);
    assert.equal(counter.start, 1, "a core plugin must still start under Safe Mode");
    await M.disable(core.id);
  } finally {
    M.setSafeMode(false);
  }
});

test("safe mode: the applied event fires while startAll is still running", async () => {
  // The listener was registered *after* `await plugins.startAll()`, and the event
  // is dispatched from inside `startAll()` — so it was dispatched before
  // anything could hear it. The audit log recorded the Safe Mode *request* and
  // never the outcome, with no error anywhere.
  const seen = [];
  const listener = (e) => seen.push(e.detail);

  const { plugin: p } = freshPlugin("safe-mode-event");
  M.definePlugin(p);
  M.setSafeMode(true);
  window.addEventListener("Syncord-safe-mode-applied", listener);
  try {
    await M.startAll();
    assert.ok(
      seen.length > 0,
      "a listener attached before startAll() must receive the event — the renderer " +
        "registers it afterwards, and therefore never does",
    );
    const detail = seen[0];
    assert.ok(Array.isArray(detail.kept), "kept must be a list");
    assert.ok(Array.isArray(detail.skipped), "skipped must be a list");
    assert.ok(
      detail.skipped.includes(p.id),
      `a non-core plugin must appear in skipped, got ${JSON.stringify(detail.skipped)}`,
    );
  } finally {
    window.removeEventListener("Syncord-safe-mode-applied", listener);
    M.setSafeMode(false);
  }
});

// ── #37: Emergency Lockdown, renderer side ───────────────────────────────────
//
// Main already cut the network and dropped the credentials, but a plugin that
// had already patched a store method or injected CSS was still running in the
// page — the visible half of the damage lockdown exists to stop. Lockdown is
// kept as its own flag rather than folded into the safe-mode flag: merging them
// would let a user leaving Safe Mode also lift the emergency stop.

test("lockdown: a non-core plugin cannot be started or re-enabled", async () => {
  const M = await freshManager();
  const p = freshPlugin("lockdown-blocked");
  M.definePlugin(p.plugin);
  M.armLockdown();

  await M.enable(p.plugin.id);
  assert.equal(counterOf(p), 0, "lockdown must block enable() for a non-core plugin");
  await M.startAll();
  assert.equal(counterOf(p), 0, "lockdown must block startAll() for a non-core plugin");
});

test("lockdown: already-running non-core plugins are stopped, core ones are kept", async () => {
  const M = await freshManager();
  // The controlled stop. Core plugins keep running on purpose — message logging
  // and the settings/security UI are how the user reads the audit log and leaves
  // lockdown, so stopping them would remove the recovery path at the moment it is
  // needed.
  const nonCore = freshPlugin("lockdown-running");
  // A different core id from the one the Safe Mode test above registers:
  // definePlugin refuses a duplicate id, and the manager is module-level state
  // shared by every test in this file.
  const core = freshPlugin("session-restore");
  M.definePlugin(nonCore.plugin);
  M.definePlugin(core.plugin);
  try {
    await M.enable(nonCore.plugin.id);
    await M.enable(core.plugin.id);
    assert.equal(counterOf(nonCore), 1, "precondition: the non-core plugin is running");
    assert.equal(counterOf(core), 1, "precondition: the core plugin is running");

    const result = await M.stopNonCore();

    assert.ok(
      result.stopped.includes(nonCore.plugin.id),
      `a running non-core plugin must be stopped, got ${JSON.stringify(result)}`,
    );
    assert.ok(
      result.kept.includes(core.plugin.id),
      "a core plugin must keep running — it is the recovery path",
    );
    // counterOf is start - stop, so a kept plugin reads 1 (running), not 0.
    assert.equal(counterOf(nonCore), 0, "the non-core plugin's stop() must have run");
    assert.equal(core.counter.stop, 0, "the core plugin's stop() must NOT have run");
    assert.equal(counterOf(core), 1, "the core plugin must still be running after lockdown");
  } finally {
    M.setSafeMode(false);
  }
});

test("lockdown: leaving Safe Mode does not lift the emergency stop", async () => {
  // Merging the two flags would make this true, and it is exactly backwards.
  const M = await freshManager();
  const p = freshPlugin("lockdown-vs-safemode");
  M.definePlugin(p.plugin);
  M.setSafeMode(true);
  M.armLockdown();

  M.setSafeMode(false);
  assert.equal(M.isSafeModeActive(), false, "Safe Mode was left");
  assert.equal(M.isLockdownActive(), true, "lockdown must still be armed");
  resetCounters(p);
  await M.enable(p.plugin.id);
  assert.equal(
    counterOf(p),
    0,
    "with Safe Mode left but lockdown armed, a non-core plugin must still be refused",
  );
});

function counterOf(p) {
  return p.counter.start - p.counter.stop;
}
function resetCounters(p) {
  p.counter.start = 0;
  p.counter.stop = 0;
}

// ── #3: lifecycle serialization ─────────────────────────────────────────────
//
// A single boolean claimed *before* awaiting fixed the double-start race and
// created the mirror one: a `disable()` arriving mid-start stopped a context
// whose `start()` had not returned, and then `start()` resolved and installed
// disposers on a plugin the manager already believed was stopped.
//
// These drive the real manager. The `deferred` helper is the instrument: a
// `start()` that does not resolve until the test says so, which is the only way
// to have a pending start at a chosen moment.

/** A promise plus the handles to settle it, for staging a pending start(). */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("#3: concurrent enable() calls run start() exactly once", async () => {
  const p = freshPlugin("ser-double-enable");
  M.definePlugin(p.plugin);
  p.counter.start = 0;
  p.counter.stop = 0;
  await Promise.all([M.enable(p.plugin.id), M.enable(p.plugin.id)]);
  assert.equal(p.counter.start, 1, `start ran ${p.counter.start} times`);
  await M.disable(p.plugin.id);
  assert.equal(p.counter.stop, 1, "stop ran exactly once");
});

test("#3: a disable() during a pending start stops it cleanly afterwards", async () => {
  // The mirror race. Before the chain existed, `disable()` ran `stop()` against
  // a half-built context and the start then resolved and added disposers to a
  // plugin the manager had already written off — leaving a patch in place.
  //
  // Counters live in a closure, not on the plugin object: `definePlugin` stores
  // `{...def}`, so `this` inside start/stop is the manager's copy. Writing
  // `this.starts` and reading `p.starts` silently compares two different objects.
  const c = { starts: 0, stops: 0, disposersRun: 0 };
  const gate = deferred();
  const p = {
    id: "ser-disable-midstart",
    name: "T",
    description: "d",
    author: "a",
    permissions: {},
    enabledByDefault: true,
    async start(ctx) {
      c.starts += 1;
      await gate.promise; // hold the start open
      // A disposer added *after* the stop was requested — this is what used to leak.
      ctx.disposable(() => {
        c.disposersRun += 1;
      });
    },
    stop() {
      c.stops += 1;
    },
  };
  M.definePlugin(p);

  const enabling = M.enable(p.id);
  await Promise.resolve();
  const disabling = M.disable(p.id);

  gate.resolve();
  await Promise.all([enabling, disabling]);

  assert.equal(c.starts, 1, "start must have run");
  assert.equal(c.stops, 1, `stop must have run exactly once after the start, got ${c.stops}`);
  assert.equal(
    c.disposersRun,
    1,
    "a disposer registered after the stop was requested must still be disposed — " +
      "otherwise the plugin leaves a live patch behind",
  );
  assert.equal(M.get(p.id)?.started, false, "final state must be stopped");
});

test("#3: a failed start stays retryable", async () => {
  let attempt = 0;
  const c = { starts: 0 };
  const p = {
    id: "ser-retry",
    name: "T",
    description: "d",
    author: "a",
    permissions: {},
    enabledByDefault: true,
    async start() {
      attempt += 1;
      c.starts += 1;
      if (attempt === 1) throw new Error("boom on the first attempt");
    },
    stop() {},
  };
  M.definePlugin(p);

  await M.enable(p.id);
  assert.equal(M.get(p.id)?.started, false, "a failed start must not report started");
  assert.equal(c.starts, 1);

  await M.enable(p.id);
  assert.equal(c.starts, 2, "a later enable must retry rather than being permanently blocked");
  assert.equal(M.get(p.id)?.started, true, "the retry succeeded");
  await M.disable(p.id);
});

test("#3: a chain rejection does not break the operations queued behind it", async () => {
  // A throwing disposer inside a failed start must not poison the chain for the
  // operations queued after it.
  const c = { starts: 0, stops: 0 };
  const p = {
    id: "ser-poison",
    name: "T",
    description: "d",
    author: "a",
    permissions: {},
    enabledByDefault: true,
    async start(ctx) {
      c.starts += 1;
      ctx.disposable(() => {
        throw new Error("disposer explodes");
      });
      throw new Error("start fails after registering a bad disposer");
    },
    stop() {
      c.stops += 1;
    },
  };
  M.definePlugin(p);
  await M.enable(p.id);
  assert.equal(c.starts, 1);
  assert.equal(M.get(p.id)?.started, false, "start failed, so not started");
  await M.enable(p.id);
  assert.equal(c.starts, 2, "the second enable must reach start, i.e. the chain survived");
  await M.disable(p.id);
  // Both starts failed, so the plugin is already stopped and disable() is a
  // no-op. Asserting stop() ran here would be asserting the wrong thing: there is
  // nothing to tear down, and calling a teardown on a plugin that never started is
  // how a stop() ends up running against a context that does not exist.
  assert.equal(c.stops, 0, "a plugin that never started must not have stop() called on it");
  assert.equal(M.get(p.id)?.started, false);
});

test("#4: the renderer lockdown has no way out on its public surface", async () => {
  // `setLockdown(active: boolean)` was reachable as `Syncord.plugins.setLockdown(false)`,
  // which reopened the renderer gate — so a non-core plugin could be started
  // again while main's network lockdown still held. The two halves of an
  // emergency stop disagreeing is worse than either state.
  //
  // Checked three ways, because "I renamed the function" is not the property:
  //   1. nothing on the exported manager or the public `plugins` object takes a
  //      boolean that could mean "off";
  //   2. the source contains no setter, clearer, or disarm path;
  //   3. arming twice is harmless.
  const fresh = await freshManager();
  const api = Object.keys(fresh).filter((k) => /lockdown/i.test(k));
  assert.deepEqual(
    api.sort(),
    ["armLockdown", "isLockdownActive"],
    `the lockdown surface must be arm-and-read only, found: ${api.join(", ")}`,
  );
  // `length` alone is not enough: a default parameter (`armLockdown(active = true)`)
  // also reports 0, and that is exactly the shape that reintroduces the bug. The
  // body is pinned instead — the only assignment in it may be `= true`.
  const body = String(fresh.armLockdown);
  assert.equal(fresh.armLockdown.length, 0, "armLockdown must take no argument");
  assert.doesNotMatch(
    body,
    /active|enable[ds]?\b|=\s*false/,
    `armLockdown must have no way to express "off": ${body}`,
  );
  assert.match(body, /=\s*true\s*;/, `armLockdown must only ever set the flag true: ${body}`);

  const { readFileSync } = await import("node:fs");
  for (const file of [
    "src/renderer/api/plugin/manager.ts",
    "src/renderer/api/plugin/index.ts",
  ]) {
    // Comments are stripped: the manager's header *describes* the old setter by
    // name, and matching that would be matching the post-mortem.
    const code = readFileSync(file, "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    for (const forbidden of [/setLockdown/, /clearLockdown/, /disarmLockdown/, /resetLockdown/]) {
      assert.doesNotMatch(
        code,
        forbidden,
        `${file} must not export ${forbidden} — an emergency stop needs no exit`,
      );
    }
  }

  // Arming is idempotent, and the flag stays set.
  const M = await freshManager();
  assert.equal(M.isLockdownActive(), false, "precondition: not armed");
  M.armLockdown();
  M.armLockdown();
  assert.equal(M.isLockdownActive(), true, "arming twice must be harmless and stay armed");
});

test('plugin names: canonical registration follows all 18 locales, including non-English startup and returning to English',async()=>{
 const manager=await freshManager();manager.setLocale('tr');
 const entries=[['long-messages','long.name'],['virtual-servers','virtual.pluginName'],['platform-spoofer','ps.name'],['fake-dm','fd.name']];
 for(const [id,key]of entries)manager.definePlugin({id,name:manager.canonicalMessage(key),permissions:{},enabledByDefault:false,start(){throw Error('Reading names must not start plugins');}});
 try{for(const locale of [...manager.SUPPORTED_LOCALES,'en-US']){manager.setLocale(locale);for(const [id,key]of entries){const name=manager.list().find(p=>p.id===id).name;assert.equal(name,manager.t(key),locale+' '+id);if(locale!=='en-US')assert.notEqual(name,manager.canonicalMessage(key),locale+' must translate '+id);}}}
 finally{manager.setLocale('en-US');}
});
