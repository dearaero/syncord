/**
 * Boot smoke test: run the *built* `dist/main.js` the way Electron does.
 *
 * This exists because of a crash that stopped Discord from starting on
 * 0.0.413: `installEgressGuard()` read `session.defaultSession` before the `ready`
 * event, and `session` is the one Electron API that is not available
 * synchronously. Every other test in this suite imports the modules directly;
 * none of them reproduced the failure, because the bug was in the *order* of the
 * real boot sequence rather than in any function.
 *
 * So this test reproduces that order:
 *
 *   1. lay out a fake Discord install (`Contents/Resources/{_app.asar,app}`)
 *   2. copy the real built bundle to `Resources/app/main.js`
 *   3. run it as the process entry, with a stubbed `electron` whose `session`
 *      throws before `ready` — exactly like the real one
 *   4. assert: it does not throw, the guards install after ready, and Discord's
 *      own main is loaded
 *
 * A future change that reintroduces a pre-ready `session` access fails here, not
 * in a dialog box on a user's machine.
 *
 * Run: `node --test scripts/tests/boot-smoke.test.mjs`
 */
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";

const ROOT = process.cwd();
const BUILT = path.join(ROOT, "dist", "main.js");

/**
 * The electron stub, written to disk and loaded via a `--require` hook.
 *
 * `session` throws before ready, and `getAppPath()` reports the fake asar, so
 * the preload-path rule is exercised against a realistic layout rather than a
 * convenient one.
 */
function electronStub(resourcesDir) {
  return `
let ready = false;
let appPath = ${JSON.stringify(path.join(resourcesDir, "_app.asar"))};
const readyCallbacks = [];
function requireReady(what) {
  if (!ready) throw new TypeError(what + " can only be received when app is ready");
}
let defaultSessionObj = null;
const app = {
  getPath: () => ${JSON.stringify(path.join(resourcesDir, "..", "userData"))},
  getAppPath: () => appPath,
  isReady: () => ready,
  whenReady: () => new Promise((resolve) => readyCallbacks.push(() => { ready = true; resolve(); })),
  on(event, handler) {
    if (event === "browser-window-created") {
      // Electron emits this after every window is constructed; the injection
      // report hangs off it, so the stub has to emit it too.
      queueMicrotask(() => handler({}, electronBrowserWindowStub()));
    }
  },
  commandLine: { hasSwitch: () => false },
  exit(code) { console.log("[stub] app.exit(" + code + ")"); process.exit(code); },
  quit() {},
  getVersion: () => "0.0.0",
  getName: () => "Discord",
  setPath() {},
  // Real Electron has this (it is untyped in electron.d.ts, which is why the
  // real code casts). The stub records it, because the preload-path rule reads
  // back whatever was set.
  setAppPath(p) { appPath = p; },
};
const session = {
  get defaultSession() {
    requireReady("Session");
    if (defaultSessionObj === null) {
      defaultSessionObj = {
        webRequest: {
          __listeners: 0,
          // Both stages are stubbed. The egress guard installs on
          // onBeforeSendHeaders, because that is the only stage Electron
          // populates requestHeaders on (measured on the real binary) -- a stub
          // that only offered the old stage made the guard look uninstalled
          // rather than reporting a real difference.
          // (No backticks here: this stub lives inside a template literal.)
          onBeforeRequest() { this.__privacyListeners = (this.__privacyListeners || 0) + 1; },
          onBeforeSendHeaders() { this.__listeners++; },
        },
        setPermissionRequestHandler() { this.__permissionHandlerInstalled = true; },
        setPermissionCheckHandler() { this.__permissionCheckInstalled = true; },
      };
    }
    return defaultSessionObj;
  },
  fromPartition: () => {
    requireReady("Session");
    return { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, fetch: async () => new Response("", { status: 599 }) };
  },
};
const ipcMain = { handle() {}, on() {} };
const shell = { openExternal: async () => {} };
const safeStorage = { isEncryptionAvailable: () => false, encryptString: () => undefined, decryptString: () => undefined };
const net = { fetch: async () => new Response("", { status: 599 }) };

// Minimal BrowserWindow so patchBrowserWindow() can subclass it. The stub
// records every window the boot sequence creates, with the webPreferences it
// was given, which is what lets the test assert the preload was actually
// replaced rather than merely "not crashing".
const createdWindows = [];
/** Shape Electron passes to a browser-window-created listener. */
function electronBrowserWindowStub() {
  return { id: 1, webContents: { id: 1, on() {}, isDestroyed: () => false } };
}
// Built with a getter-only, non-configurable BrowserWindow, mirroring real
// Electron (measured: { get: true, set: false, configurable: false }).
// A stub with a plain writable property would let an in-place assignment appear
// to work, and the test would pass while the patch was a no-op — which is
// exactly the bug this file was written after.
const browserWindowClass = class BrowserWindow {
  constructor(options) {
    this.options = options ?? {};
    this.webContents = {
      id: createdWindows.length + 1,
      on() {},
      once() {},
      getURL: () => "https://discord.com/app",
      setWindowOpenHandler() {},
      toggleDevTools() {},
      isDestroyed: () => false,
    };
    createdWindows.push(this);
  }
  static getAllWindows() { return createdWindows; }
  static fromId(id) { return createdWindows[id - 1]; }
};
const browserWindowExports = {};
Object.defineProperty(browserWindowExports, "BrowserWindow", {
  get: () => browserWindowClass,
  enumerable: true,
  configurable: false,
});

const electron = { ...browserWindowExports, app, session, ipcMain, shell, safeStorage, net, __windows: createdWindows };

// The spread above *un-does* the getter: spreading evaluates it and copies the
// value into a plain writable data property, which would make an in-place
// assignment succeed and the test would pass while the real patch is a no-op.
// So the getter is (re)defined on the final object, which is what Discord's
// bundle actually receives.
Object.defineProperty(electron, "BrowserWindow", {
  get: () => browserWindowClass,
  enumerable: true,
  configurable: false,
});

const Module = require("node:module");
const originalLoad = Module._load;
const originalResolve = Module._resolveFilename;
// require.resolve("electron") is a real call in patchBrowserWindow (it looks
// up the cached module to replace its exports), and electron is a builtin in the
// real runtime — so the resolution has to be stubbed too, not just the load.
Module._resolveFilename = function (request, ...rest) {
  if (request === "electron") return "electron";
  return originalResolve.call(this, request, ...rest);
};
Module._load = function (request, parent, isMain) {
  if (request === "electron") return require.cache["electron"].exports;
  return originalLoad.apply(this, arguments);
};

// patchBrowserWindow replaces the BrowserWindow by mutating the *cached*
// electron module's exports, which is why it calls require.resolve("electron")
// and then edits require.cache. In the real runtime electron is a builtin and
// therefore always cached; the stub has to reproduce that, or the patch is a
// silent no-op and the test would pass for entirely the wrong reason.
require.cache["electron"] = {
  id: "electron",
  filename: "electron",
  loaded: true,
  exports: electron,
  children: [],
  paths: [],
};

// Stand in for Electron's own ready event. Real Electron fires it on its own
// schedule; the stub fires it after the synchronous boot sequence has finished,
// which is exactly the ordering the crash depended on.
setTimeout(() => {
  ready = true;
  for (const cb of readyCallbacks.splice(0)) cb();
}, 20);

// Report what the cache actually holds, so a passing test cannot be explained by
// the stub being more permissive than real Electron.
setTimeout(() => {
  const cached = require.cache["electron"];
  if (cached === undefined) { console.log("[stub] cache: <no entry>"); return; }
  const d = Object.getOwnPropertyDescriptor(cached.exports, "BrowserWindow");
  console.log("[stub] cache entry present; BrowserWindow descriptor: " + JSON.stringify({
    get: !!d?.get, set: !!d?.set, writable: d?.writable, configurable: d?.configurable,
  }));
  console.log("[stub] cached BrowserWindow.name: " + String(cached.exports.BrowserWindow?.name));
  console.log("[stub] is the stub class: " + (cached.exports.BrowserWindow === browserWindowClass));
  console.log("[stub] created windows: " + createdWindows.length +
    " | first window ctor name: " + (createdWindows[0]?.constructor?.name ?? "n/a"));
}, 40);

// Then report what the boot sequence actually installed, asserting on the
// objects themselves rather than on log text, so a stub that silently does
// nothing cannot pass the test.
setTimeout(() => {
  let egress = "not-installed";
  let permissions = "not-installed";
  try {
    const s = session.defaultSession;
    egress = s.webRequest.__listeners === 1 ? "installed" : "listeners=" + s.webRequest.__listeners;
    permissions = s.__permissionHandlerInstalled === true ? "installed" : "missing";
  } catch (e) {
    egress = "threw: " + e.message;
  }
  for (const w of electron.__windows) {
    console.log("[stub] window preload=" + String(w.options?.webPreferences?.preload));
  }
  try {
    const r = require("node:fs").readFileSync(
      require("node:path").join(app.getPath("userData"), "Syncord", "injection.json"),
      "utf-8",
    );
    // Newlines become "|" so the report survives as a single log line, without
    // collapsing the JSON keys the assertions match on.
    console.log("[stub] injection=" + r.split("\\n").join("|"));
  } catch (e) {
    console.log("[stub] injection=<unreadable: " + e.message + ">");
  }
  console.log("[stub] ready egress=" + egress + " permissions=" + permissions);
  process.exit(0);
}, 2500);
`;
}

/** A fake Discord install, with our bundle dropped in as `Resources/app/main.js`. */
function makeInstall() {
  const base = mkdtempSync(path.join(tmpdir(), "dion-boot-"));
  const resources = path.join(base, "Contents", "Resources");
  const appDir = path.join(resources, "app");
  const asar = path.join(resources, "_app.asar");
  mkdirSync(appDir, { recursive: true });
  mkdirSync(asar, { recursive: true });

  copyFileSync(BUILT, path.join(appDir, "main.js"));
  writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name: "discord", main: "main.js" }));
  writeFileSync(path.join(asar, "package.json"), JSON.stringify({ name: "discord", main: "bundle.js" }));
  // Discord's own entry point, reduced to the two window shapes that matter.
  //
  // A titleless main window still needs injection. The native splash must
  // retain its own preload so its startup-ready handshake can run.
  writeFileSync(
    path.join(asar, "bundle.js"),
    'const path = require("node:path");\n' +
      'const { app, BrowserWindow } = require("electron");\n' +
      'app.whenReady().then(() => {\n' +
      '  // Shape 1: a main window with no title — title cannot decide injection.\n' +
      '  new BrowserWindow({\n' +
      '    width: 300, height: 300, transparent: true, frame: false, resizable: false, show: false,\n' +
      '    webPreferences: { preload: path.join(app.getAppPath(), "bundle.js"), sandbox: false, contextIsolation: true, nodeIntegration: false },\n' +
      '  });\n' +
      '  // Shape 2: the native splash — its preload must be left intact.\n' +
      '  new BrowserWindow({\n' +
      '    title: "Discord",\n' +
      '    webPreferences: { preload: path.join(app.getAppPath(), "splashScreenPreload.js"), sandbox: false, contextIsolation: true, nodeIntegration: false },\n' +
      '  });\n' +
      '  // Shape 3: a utility window with no preload at all — must be left alone.\n' +
      '  new BrowserWindow({ title: "no-preload" });\n' +
      '  console.log("[discord] main loaded");\n' +
      '});\n',
  );

  return { base, resources };
}

function runBoot({ withHook = true } = {}) {
  const { base, resources } = makeInstall();
  const hook = path.join(base, "hook.cjs");
  writeFileSync(hook, electronStub(resources));

  const args = withHook
    ? ["--require", hook, path.join(resources, "app", "main.js")]
    : [path.join(resources, "app", "main.js")];
  const result = spawnSync(process.execPath, args, { encoding: "utf-8", timeout: 30_000 });
  return { ...result, resources, base };
}

test("boot: the built main.js starts without touching session before ready", () => {
  const { base, stdout, stderr, status } = runBoot();
  const output = `${stdout}\n${stderr}`;

  // An injection that does not engage has no visible symptom, so the log is the
  // only evidence there is. Print it on demand while diagnosing.
  if (process.env.DION_BOOT_DEBUG === "1") {
    console.log("--- boot output ---\n" + output + "\n--- end ---");
  }

  try {
    // The failure this test exists for.
    assert.equal(
      /can only be received when app is ready/.test(output),
      false,
      `session was touched before the app was ready:\n${output}`,
    );
    assert.equal(
      /JavaScript error occurred in the main process|Uncaught Exception|TypeError/.test(output),
      false,
      `main process threw during boot:\n${output}`,
    );

    // Boot must actually reach Discord, or "did not crash" is meaningless.
    assert.match(
      stdout,
      /\[discord\] main loaded/,
      `Discord's own main was never loaded:\n${output}`,
    );

    // And the pre-ready phase must have completed its own work.
    assert.match(stdout, /\[Syncord\] Main process starting/);
    assert.match(stdout, /\[Syncord\] Loading Discord from/);

    // The guards must actually be installed by the time we are ready — "did not
    // crash" is only meaningful if the security layer came up with it.
    assert.match(
      stdout,
      /\[stub\] ready egress=installed permissions=installed/,
      `session guards were not installed after ready:\n${output}`,
    );

    // And the preload must have been swapped for ours, which means the path
    // validation accepted a realistic Discord candidate.
    assert.match(
      stdout,
      /\[stub\] window preload=.*[/\\]app[/\\]preload\.js/,
      `Discord's window was not patched — the preload path was refused:\n${output}`,
    );
    assert.equal(
      /Refusing to load original preload|Not patching window/.test(output),
      false,
      `a legitimate preload path was rejected:\n${output}`,
    );

    // Inject the titleless main window, while keeping the native splash's
    // own startup bridge. A title must never decide whether injection works.
    const preloads = [...stdout.matchAll(/\[stub\] window preload=(.*)/g)].map((m) => m[1].trim());
    assert.equal(preloads.length, 3, `expected three windows, saw ${preloads.length}:\n${output}`);
    assert.equal(
      preloads.filter((p) => /[/\\]app[/\\]preload\.js$/.test(p)).length,
      1,
      `only the main window must be patched:\n${output}`,
    );

    assert.match(
      preloads[1],
      /[/\\]_app\.asar[/\\]splashScreenPreload\.js$/,
      `the native splash preload must be preserved:\n${output}`,
    );
    assert.match(stdout, /"action": "skipped-native-splash"/, output);

    // The window with no preload must be left completely alone.
    assert.match(
      stdout,
      /\[stub\] window preload=undefined/,
      `a window with no preload must be left untouched:\n${output}`,
    );

    // And the on-disk report must account for every window.
    assert.match(
      stdout,
      /"patchedWindows": 1/,
      `the injection report must show one patched main window:\n${output}`,
    );
    assert.match(
      stdout,
      /"action": "skipped-no-preload"/,
      `the report must record the skipped window:\n${output}`,
    );
    assert.equal(
      /"patchInstalledVia": null/.test(output),
      false,
      `the patch must report how it was installed:\n${output}`,
    );

    // The summary must be logged after the windows exist, never before — a
    // warning emitted from `whenReady` is a guaranteed false alarm, because our
    // ready handler is registered before Discord's.
    assert.equal(
      /No Discord window was patched/.test(output),
      false,
      `a false "nothing was patched" warning was emitted:\n${output}`,
    );
    assert.match(
      stdout,
      /Injection report \(first window\): patch=.*\bpatched=1\b/,
      `the summary must be reported after the first window:\n${output}`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("boot: a window with a rejected preload is left alone and reported", () => {
  // The other half of the contract: we patch what we can validate, and we say
  // so loudly when we cannot. Silently skipping is what made this class of bug
  // invisible in the first place.
  const { base, resources } = makeInstall();
  const hook = path.join(base, "hook.cjs");
  writeFileSync(hook, electronStub(resources));

  // Replace Discord's entry with one whose preload points outside the app path.
  writeFileSync(
    path.join(resources, "_app.asar", "bundle.js"),
    'const path = require("node:path");\n' +
      'const { app, BrowserWindow } = require("electron");\n' +
      'app.whenReady().then(() => {\n' +
      '  new BrowserWindow({ title: "evil", webPreferences: { preload: "/tmp/evil.js", sandbox: false } });\n' +
      '  console.log("[discord] main loaded");\n' +
      '});\n',
  );

  const result = spawnSync(
    process.execPath,
    ["--require", hook, path.join(resources, "app", "main.js")],
    { encoding: "utf-8", timeout: 30_000 },
  );
  const output = `${result.stdout}\n${result.stderr}`;

  try {
    assert.match(
      output,
      /Refusing to load original preload/,
      `an out-of-tree preload must be refused loudly:\n${output}`,
    );
    assert.match(
      output,
      /\[stub\] window preload=\/tmp\/evil\.js/,
      `a rejected preload must be left untouched:\n${output}`,
    );
    assert.match(
      output,
      /"preloadRejections": 1/,
      `the rejection must be counted in the report:\n${output}`,
    );
    assert.match(
      output,
      /"patchedWindows": 0/,
      `nothing may be reported as patched:\n${output}`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("boot: a Discord install with no matching asar exits with a clear message", () => {
  // The failure path must be legible rather than a stack trace. The electron
  // stub is required here too, because main.js imports electron before it looks
  // for the asar.
  const base = mkdtempSync(path.join(tmpdir(), "dion-boot-noasar-"));
  try {
    const resources = path.join(base, "Contents", "Resources");
    const appDir = path.join(resources, "app");
    mkdirSync(appDir, { recursive: true });
    copyFileSync(BUILT, path.join(appDir, "main.js"));

    const hook = path.join(base, "hook.cjs");
    writeFileSync(hook, electronStub(resources));

    const result = spawnSync(
      process.execPath,
      ["--require", hook, path.join(appDir, "main.js")],
      { encoding: "utf-8", timeout: 30_000 },
    );
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /Discord asar not found/,
      "a missing asar must say so explicitly",
    );
    // And it must say *where* it looked, because a wrong assumption about the
    // launch shape is otherwise invisible.
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /resources dir searched:/,
      "a missing asar must report the directories it searched",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
