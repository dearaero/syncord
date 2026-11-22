import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { build } from "esbuild";

const compiled = await build({
  entryPoints: ["src/renderer/api/updater.ts"], bundle: true, write: false,
  platform: "browser", format: "cjs", logLevel: "silent",
  plugins: [{ name: "settings-and-logger", setup(builder) {
    builder.onResolve({filter: /^\.\/(settings|logger)$/}, args => ({path: args.path, namespace: "fixture"}));
    builder.onLoad({filter: /.*/, namespace: "fixture"}, args => ({
      contents: args.path === "./settings"
        ? 'export const settings = {get: (key, fallback) => globalThis.saved.has(key) ? globalThis.saved.get(key) : fallback};'
        : 'export const createLogger = () => ({info(){},warn(){},error(){}});', loader: "js",
    }));
  }}],
});
const code = compiled.outputFiles[0].text;
const status = (phase = "idle", channel = "stable") => ({
  phase, channel, latest: phase === "available" ? "0.1.1" : null,
  current: "0.1.0", build: "0.1.0", detail: "", stagedVersion: null,
  progress: null, platform: "mac-arm64", lastError: null,
});
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(check = async channel => status("available", channel)) {
  const timers = new Map(), intervals = new Map(), saved = new Map(), calls = [];
  let timerId = 0;
  const module = {exports: {}};
  const context = vm.createContext({module, exports: module.exports, saved,
    window: {SyncordNative: {updates: {
      check: channel => {calls.push(channel); return check(channel);},
      reset: async () => status(), status: async () => status("ready"),
    }}},
    setTimeout: fn => {timers.set(++timerId, fn); return timerId;},
    clearTimeout: id => timers.delete(id),
    setInterval: fn => {intervals.set(++timerId, fn); return timerId;},
    clearInterval: id => intervals.delete(id),
  });
  vm.runInContext(code, context);
  return {api: module.exports, calls, saved, timers, intervals,
    fireStartup() {for (const [id, callback] of timers) {timers.delete(id); callback();}},
    fireInterval() {for (const callback of intervals.values()) callback();},
  };
}

test("startup checks the saved beta channel and schedules only once", async () => {
  const f = fixture();
  f.saved.set("updates.channel", "beta");
  f.api.startAutoUpdate(); f.api.startAutoUpdate();
  assert.equal(f.timers.size, 1);
  f.fireStartup(); await flush();
  assert.deepEqual(f.calls, ["beta"]);
  assert.equal(f.intervals.size, 1);
  f.saved.set("updates.autoCheck", false);
  f.fireInterval(); await flush();
  assert.equal(f.calls.length, 1);
  f.api.pauseAutoUpdate();
  assert.equal(f.intervals.size, 0);
  f.saved.set("updates.autoCheck", true);
  f.saved.set("updates.channel", "stable");
  f.api.startAutoUpdate(); f.fireStartup(); await flush();
  assert.deepEqual(f.calls, ["beta", "stable"]);
  f.api.stopAutoUpdate();
  assert.equal(f.timers.size + f.intervals.size, 0);
});

test("automatic checks preserve a bundle awaiting installation", async () => {
  const f = fixture();
  await f.api.refreshStatus();
  f.api.startAutoUpdate(); f.fireStartup(); await flush();
  assert.deepEqual(f.calls, []);
  assert.equal(f.api.updateState().phase, "ready");
});

test("switching channel while checking serializes requests and suppresses the old offer", async () => {
  const pending = [], seen = [];
  const f = fixture(channel => new Promise(resolve => pending.push({channel, resolve})));
  f.api.onUpdate(value => {if (value.phase === "available") seen.push(value.channel);});
  const first = f.api.checkNow("stable"); await flush();
  const second = f.api.checkNow("beta");
  pending[0].resolve(status("available", "stable")); await flush();
  assert.deepEqual(f.calls, ["stable", "beta"]);
  assert.deepEqual(seen, []);
  pending[1].resolve(status("available", "beta"));
  await Promise.all([first, second]);
  assert.deepEqual(seen, ["beta"]);
});

test("turning off checks discards an outstanding result", async () => {
  let resolve;
  const f = fixture(() => new Promise(done => {resolve = done;}));
  const request = f.api.checkNow("stable"); await flush();
  await f.api.resetUpdate();
  resolve(status("available")); await request;
  assert.equal(f.api.updateState().phase, "idle");
  assert.equal(f.api.hasPendingUpdate(), false);
});

test("bridge failures produce a retryable error instead of leaving a checking spinner", async () => {
  const f = fixture(async () => {throw new Error("bridge unavailable");});
  const result = await f.api.checkNow("stable");
  assert.equal(result.phase, "error");
  assert.equal(result.lastError, "bridge-check");
  assert.equal(result.latest, null);
});

test("a listener checking again cannot start an overlapping bridge request", async () => {
  const f = fixture();
  let once = false;
  f.api.onUpdate(value => {if (value.phase === "checking" && !once) {once = true; void f.api.checkNow("stable");}});
  await f.api.checkNow("stable");
  assert.deepEqual(f.calls, ["stable"]);
});


test("immediate channel switches check the most recent selection", async () => {
  const f = fixture();
  const first = f.api.checkNow("stable");
  const second = f.api.checkNow("beta");
  await Promise.all([first, second]);
  assert.deepEqual(f.calls, ["beta"]);
  assert.equal(f.api.updateState().channel, "beta");
});

test("reset before a scheduled request starts prevents that request", async () => {
  const f = fixture();
  const request = f.api.checkNow("stable");
  await f.api.resetUpdate(); await request;
  assert.deepEqual(f.calls, []);
  assert.equal(f.api.updateState().phase, "idle");
});
