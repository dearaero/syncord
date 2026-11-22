/**
 * End-to-end boot test against the **real Electron binary**.
 *
 * `boot-smoke.test.mjs` uses a stubbed `electron`, which is necessary for
 * reproducing the pre-ready `session` throw and for asserting log lines, but a
 * stub can lie: an early version declared `BrowserWindow` as a plain writable
 * property, which made an in-place assignment appear to succeed while the real
 * patch was a silent no-op. That is how a broken patch shipped.
 *
 * This test removes the stub. It runs the real `dist/main.js` under the real
 * Electron binary, so it exercises:
 *
 *   - Electron's actual `require("electron")` exports object, whose `BrowserWindow`
 *     is a getter-only, non-configurable property (measured, not assumed),
 *   - the real `BrowserWindow` class and the real preload lifecycle,
 *   - our preload actually executing in a real renderer process,
 *   - the app path / resources path / **user data path** that the preload-path
 *     rule validates against — the last of which is where Discord 0.0.413 keeps
 *     the main screen's preload, and where three of this project's bugs lived.
 *
 * The fake install uses Discord 0.0.413's real layout: a frameless, titleless
 * splash whose preload is in the app bundle, and a titled main window whose
 * preload is `…/userData/app-0.0.413/modules/…/core.asar/mainScreenPreload.js`.
 * The asar is a file and the preload "inside" it does not exist on disk, which is
 * precisely the case that defeated realpath-based containment in production.
 *
 * Run: `node --test scripts/tests/boot-real-electron.test.mjs`
 */
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";

const ROOT = process.cwd();

/** Locate the Electron binary the project already depends on. */
function findElectron() {
  const pkgDir = path.join(ROOT, "node_modules", "electron");
  if (!existsSync(pkgDir)) return null;
  const dist = path.join(pkgDir, "dist");
  for (const rel of [
    ["Electron.app", "Contents", "MacOS", "Electron"],
    ["electron.exe"],
    ["electron"],
  ]) {
    const candidate = path.join(dist, ...rel);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const ELECTRON = findElectron();
const APP_NAME = "SyncordBootTest";

function makeInstall(layout) {
  const base = mkdtempSync(path.join(tmpdir(), "dion-real-"));
  const resources = layout === "host-modules"
    ? path.join(base, "app-1.0.52", "resources")
    : path.join(base, "Contents", "Resources");
  const appDir = path.join(resources, "app");
  const asar = path.join(resources, "_app.asar");
  const userData = path.join(base, "userData");
  const moduleDir = path.join(
    ...(layout === "host-modules" ? [path.dirname(resources)] : [userData, "app-0.0.413"]),
    "modules",
    layout === "host-modules" ? "discord_desktop_core-2" : "discord_desktop_core-1",
    "discord_desktop_core",
  );
  mkdirSync(appDir, { recursive: true });
  mkdirSync(asar, { recursive: true });
  mkdirSync(moduleDir, { recursive: true });

  // The asar is a file; the preload "inside" it does not exist on disk.
  writeFileSync(path.join(moduleDir, "core.asar"), "asar-placeholder");

  for (const file of ["main.js", "preload.js", "renderer.js"]) {
    const src = path.join(ROOT, "dist", file);
    if (!existsSync(src)) return null;
    copyFileSync(src, path.join(appDir, file));
  }
  writeFileSync(
    path.join(appDir, "package.json"),
    JSON.stringify({ name: APP_NAME, main: "main.js", private: true }),
  );
  writeFileSync(path.join(asar, "package.json"), JSON.stringify({ name: "discord", main: "bundle.js" }));

  // Opening the main window depends on the native splash bridge, just as in
  // Discord. If Syncord replaces that preload, its data: origin gate blocks
  // the bridge and the main-window handshake never arrives.
  const mainScreenPreload = path.join(moduleDir, "core.asar", "mainScreenPreload.js");
  writeFileSync(
    path.join(asar, "splashScreenPreload.js"),
    'const { contextBridge, ipcRenderer } = require("electron");\n' +
      'contextBridge.exposeInMainWorld("DiscordSplash", { ready: () => ipcRenderer.send("discord-splash-ready") });\n',
  );
  const bundle = [
    'const path = require("node:path");',
    'const { app, BrowserWindow, ipcMain } = require("electron");',
    `const MAIN_SCREEN_PRELOAD = ${JSON.stringify(mainScreenPreload)};`,
    "app.whenReady().then(() => {",
    '  ipcMain.once("discord-splash-ready", () => {',
    '    console.log("[discord] native splash ready");',
    '    const opts = { title: "Discord", show: false, width: 400, height: 300,',
    '      webPreferences: { preload: MAIN_SCREEN_PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false } };',
    '    const main = new BrowserWindow(opts);',
    '    console.log("[discord] window preload now: " + String(opts.webPreferences.preload));',
    '    main.loadURL("data:text/html,<h1>main probe</h1>");',
    '    main.webContents.once("did-finish-load", () => console.log("[discord] main loaded after splash"));',
    '  });',
    '  const opts = { show: false, width: 300, height: 300, transparent: true, frame: false,',
    '    webPreferences: { preload: path.join(app.getAppPath(), "splashScreenPreload.js"), sandbox: true, contextIsolation: true, nodeIntegration: false } };',
    '  const splash = new BrowserWindow(opts);',
    '  console.log("[discord] window preload now: " + String(opts.webPreferences.preload));',
    '  console.log("[discord] splash sandbox preserved: " + String(opts.webPreferences.sandbox));',
    '  splash.loadURL("data:text/html,<script>window.DiscordSplash.ready()</script>");',
    '  setTimeout(() => app.quit(), 2500);',
    "});",
    "",
  ].join("\n");
  writeFileSync(path.join(asar, "bundle.js"), bundle);

  return { base, resources, appDir, asar, userData };
}

function run(install) {
  // Pass the app *directory*, exactly as launching Discord does, so Electron
  // resolves `resources/app/package.json` → `main.js` and `app.getAppPath()`
  // is the real injected path.
  //
  // `--user-data-dir` is not optional. Electron derives `app.getPath("userData")`
  // from the app name (`~/Library/Application Support/<name>`), not from the app
  // location, so without the switch the fake module directory would not be inside
  // the real user-data path — and the preload-path rule, which validates against
  // `app.getPath("userData")`, would correctly reject it. The test would then be
  // measuring the wrong thing: a rejection, rather than the acceptance that
  // Discord 0.0.413 actually needs.
  const result = spawnSync(
    ELECTRON,
    [install.appDir, `--user-data-dir=${install.userData}`],
    {
      encoding: "utf-8",
      timeout: 60_000,
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: "0" },
    },
  );
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

for (const layout of ["user-data", "host-modules"]) test(
  `real Electron: native splash handshake opens the patched main window (${layout}) while the origin gate holds`,
  { skip: ELECTRON === null ? "electron binary not installed" : false, timeout: 90_000 },
  () => {
    const install = makeInstall(layout);
    assert.notEqual(install, null, "dist/main.js, preload.js and renderer.js must be built first");

    let output;
    try {
      output = run(install);
    } finally {
      rmSync(install.base, { recursive: true, force: true });
    }

    // The failure this test exists for: a patch that reports success but is a
    // no-op because Electron's `BrowserWindow` export cannot be assigned.
    assert.doesNotMatch(output, /FAILED to install the BrowserWindow patch/, output);
    assert.doesNotMatch(output, /patch did NOT take effect/, output);
    assert.match(
      output,
      /BrowserWindow patch installed \(require-cache\)/,
      `the require-cache mechanism is the one that works on Electron's getter-only exports:\n${output}`,
    );

    assert.match(output, /\[discord\] native splash ready/, `the native splash bridge must run:\n${output}`);
    assert.match(output, /\[discord\] main loaded after splash/, `the splash must unblock the main window:\n${output}`);
    assert.match(output, /\[discord\] splash sandbox preserved: true/, output);
    assert.match(
      output,
      /Injection report \([^)]*\): patch=[^\n]*\bpatched=1\b/,
      `only the main window should receive our preload:\n${output}`,
    );
    assert.match(output, /\bskipped=1\b/, output);
    assert.match(output, /\brejected=0\b/, `no preload may be rejected:\n${output}`);
    assert.doesNotMatch(output, /No Discord window was patched/, output);

    const observed = [...output.matchAll(/\[discord\] window preload now: (.*)/g)].map((m) =>
      m[1].trim(),
    );
    assert.equal(observed.length, 2, `the splash handshake must create the main window:\n${output}`);
    assert.match(observed[0], /[/\\]_app\.asar[/\\]splashScreenPreload\.js$/, output);
    assert.match(observed[1], /[/\\]resources[/\\]app[/\\]preload\.js$/i, output);

    // No legitimate preload may be refused. The user-data-hosted one is the
    // regression this test was extended for.
    assert.doesNotMatch(output, /REFUSING original preload/, output);
    assert.doesNotMatch(output, /Refusing to load original preload/, output);

    // The preload must run in a real renderer, and the Phase 1 origin gate must
    // refuse the `data:` frame — both halves of the trust boundary, verified on
    // the real binary rather than asserted in the abstract.
    assert.match(output, /\[Syncord\] Preload loaded/, `our preload must run:\n${output}`);
    assert.match(
      output,
      /Preload skipped for untrusted frame \(data:\/\/\?\)/,
      `the origin gate must refuse a data: frame:\n${output}`,
    );
    assert.doesNotMatch(
      output,
      /SyncordNative exposed/,
      `a data: frame must never receive the privileged bridge:\n${output}`,
    );
  },
);
