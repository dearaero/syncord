import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
const dir = mkdtempSync(path.join(tmpdir(), "syncord-privacy-"));
const stub = path.join(dir, "webpack.mjs");
writeFileSync(stub, "export function beforeWebpackReady(fn) { globalThis.__privacyHook = fn; }");
await build({ stdin: { resolveDir: process.cwd(), contents: `
 export * from './src/security/privacy';
 export * from './src/renderer/core/privacy';
 export { blockPrivacyRequest, privacyStatus } from './src/main/security/privacy';
` }, outfile: path.join(dir, "privacy.mjs"), bundle: true, platform: "node", format: "esm", external: ["electron"], logLevel: "silent", plugins: [{ name: "webpack", setup(b) { b.onResolve({ filter: /^\.\.\/webpack$/ }, () => ({ path: stub })); } }] });
const T = await import(pathToFileURL(path.join(dir, "privacy.mjs")));
test.after(() => { rmSync(dir, { recursive: true, force: true }); delete globalThis.__privacyHook; });

test("privacy: Discord analytics, beaker, metrics and both Sentry transports are classified", () => {
 for (const host of ["discord.com", "canary.discord.com", "ptb.discordapp.com"]) {
  for (const prefix of ["", "/api", "/api/v9", "/api/v125"]) {
   for (const endpoint of ["science", "beaker", "track"]) assert.equal(T.classifyPrivacyRequest(`https://${host}${prefix}/${endpoint}/?x=1`), "analytics");
   for (const endpoint of ["metrics", "metrics/v2"]) assert.equal(T.classifyPrivacyRequest(`https://${host}${prefix}/${endpoint}`), "metrics");
  }
  assert.equal(T.classifyPrivacyRequest(`https://${host}/error-reporting-proxy/web`), "crashReports");
  assert.equal(T.classifyPrivacyRequest(`https://${host}/assets/sentry.77e23b6dcd52b017.js`), "sentryScript");
 }
 for (const host of ["o64374.ingest.sentry.io", "o447951.ingest.sentry.io"]) assert.equal(T.classifyPrivacyRequest(`https://${host}/api/146342/minidump/?sentry_key=x`), "crashReports");
 assert.equal(T.classifyPrivacyRequest("https://sentry.io/api/140984/envelope/"), "crashReports");
});

test("privacy: messages, voice, auth, upload, integrations, updates and unrelated reporters remain reachable", () => {
 for (const url of [
  "https://discord.com/api/v9/channels/123/messages", "https://discord.com/api/v9/users/@me", "https://discord.com/api/v9/auth/login",
  "https://discord.com/api/v9/voice/regions", "wss://gateway.discord.gg/?v=9", "https://router.discordapp.net/", "https://cdn.discordapp.com/attachments/1/2/science.mp4",
  "https://discord.com/assets/main.js", "https://discord.com/assets/sentry-icon.png", "https://discord.com/api/v9/channels/1/metrics", "https://discord.com/api/v9/science-fiction",
  "https://discord.com/api/v9/reports", "https://discord.com/api/v9/fingerprint", "https://discord.com/api/v9/quests/1/heartbeat",
  "https://api.spotify.com/v1/me", "https://github.com/dearaero/syncord-releases", "https://example.com/science", "https://discord.com.evil.test/api/v9/science",
  "https://sentry.io/api/999/envelope/", "https://other.ingest.sentry.io/api/146342/store/", "https://o64374.ingest.sentry.io.evil.test/", "blob:https://discord.com/id", "file:///science", "invalid",
 ]) assert.equal(T.classifyPrivacyRequest(url), undefined, url);
});

test("privacy: counters contain categories only, snapshots cannot mutate main state", () => {
 const before = T.privacyStatus(true);
 assert.equal(T.blockPrivacyRequest("https://discord.com/api/v9/science?secret=must-not-be-stored"), true);
 assert.equal(T.blockPrivacyRequest("https://discord.com/api/v9/channels/1/messages"), false);
 const next = T.privacyStatus(true);
 assert.equal(next.blocked.analytics, before.blocked.analytics + 1);
 assert.deepEqual(Object.keys(next.blocked), ["analytics", "metrics", "crashReports", "sentryScript"]);
 next.blocked.analytics = -100;
 assert.notEqual(T.privacyStatus(true).blocked.analytics, -100);
 assert.doesNotMatch(JSON.stringify(T.privacyStatus(true)), /secret|must-not-be-stored/);
});

function analyticsModule() {
 const exports = {};
 const handlers = { handleTrack() {}, handleConnectionOpen() {}, handleConnectionClosed() {}, handleFingerprint() {}, handleSetAnalyticsToken() {} };
 let queued = 0, started = 0;
 const maker = options => {
  handlers.handleTrack = () => queued++;
  handlers.handleConnectionOpen = () => started++;
  return { options, requestDrain() { queued++; }, submitEventsImmediately() { queued++; }, getState() { return "native-store"; } };
 };
 for (const [name, value] of Object.entries({ analyticsTrackingStoreMaker: maker, trackMaker: () => () => { queued++; }, AnalyticsActionHandlers: handlers, unrelated: "retained" })) {
  Object.defineProperty(exports, name, { enumerable: true, configurable: false, get: () => value });
 }
 return { exports, handlers, counters: () => ({ queued, started }) };
}

test("privacy: real Flux store shape survives, telemetry actions do not queue, caller promises resolve", async () => {
 const a = analyticsModule(), quiet = T.suppressAnalytics(a.exports);
 assert.notEqual(quiet, a.exports); assert.equal(quiet.unrelated, "retained");
 const store = quiet.analyticsTrackingStoreMaker({ dispatcher: {}, actionHandler: { TRACK() {}, CONNECTION_OPEN() {} } });
 assert.equal(store.getState(), "native-store");
 let resolved = 0;
 store.options.actionHandler.TRACK({ resolve: () => resolved++ });
 store.options.actionHandler.CONNECTION_OPEN({});
 a.handlers.handleTrack({ resolve: () => resolved++ }); a.handlers.handleConnectionOpen({});
 await quiet.trackMaker({})("event", {}); store.requestDrain();
 assert.equal((await store.submitEventsImmediately([])).status, 204);
 assert.equal(resolved, 2); assert.deepEqual(a.counters(), { queued: 0, started: 0 });
 assert.equal(T.rendererPrivacyStatus().analytics, true);
});

test("privacy: metrics timer is canceled and repeated calls cannot grow a buffer or send", () => {
 const interval = setInterval(() => assert.fail("timer must be canceled"), 500);
 const metric = { _metrics: ["old"], _intervalId: interval, increment() { this._metrics.push("event"); }, distribution() { this._metrics.push("event"); }, _flush() { assert.fail("network send"); } };
 T.suppressMetrics({ minifiedExport: metric });
 assert.equal(metric._intervalId, undefined); assert.equal(interval._destroyed, true);
 for (let n = 0; n < 10000; n++) { metric.increment(); metric.distribution(); }
 metric._flush(); assert.deepEqual(metric._metrics, []);
 const unrelated = { increment() { return "unchanged"; }, distribution() {} };
 T.suppressMetrics({ unrelated }); assert.equal(unrelated.increment(), "unchanged");
});

test("privacy: factory hook is lazy, semantic and idempotent, preserves this and unrelated exports", () => {
 assert.equal(globalThis.__privacyHook, T.installPrivacyFactories);
 let calls = 0;
 function analyticFactory(module) {
  // analyticsTrackingStoreMaker: AnalyticsActionHandlers: trackMaker:
  assert.equal(this.marker, "preserved"); calls++; module.exports = analyticsModule().exports;
 }
 const unrelated = () => assert.fail("must never force Discord factories");
 const req = Object.assign(() => assert.fail("must not require a module"), { m: { "a": analyticFactory, "other": unrelated }, c: {} });
 T.installPrivacyFactories(req); assert.equal(calls, 0); assert.equal(req.m.other, unrelated);
 const wrapped = req.m.a; T.installPrivacyFactories(req); assert.equal(req.m.a, wrapped);
 const module = { exports: {} }; req.m.a.call({ marker: "preserved" }, module, module.exports, req);
 assert.equal(calls, 1); assert.equal(module.exports.unrelated, "retained");
 const result = module.exports.analyticsTrackingStoreMaker({ actionHandler: {} }); result.requestDrain();
});

test("privacy: version drift and malformed exports do not stop Discord startup", () => {
 for (const value of [null, undefined, 1, {}, { trackMaker() {} }]) assert.equal(T.suppressAnalytics(value), value);
 T.installPrivacyFactories(Object.assign(() => {}, { m: { changed: function () { return "analyticsTrackingStoreMaker only"; } } }));
 T.suppressMetrics({ unknown: {} });
});
