import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";

const root = process.cwd();
const electron = ["Electron.app/Contents/MacOS/Electron", "electron.exe", "electron"]
  .map(name => path.join(root, "node_modules/electron/dist", name)).find(existsSync);

// Model Discord's two native contracts, independently of Syncord's adapter.
function setupNative(mode) {
  window.nativeState = { currentToastMap: new Map(), queuedToastsMap: new Map() };
  window.nativeCalls = 0;
  window.factoryCalls = 0;
  function render(spec) {
    let host = document.getElementById("native-toast");
    if (!host) {
      host = document.createElement("div");
      host.id = "native-toast";
      document.body.appendChild(host);
    }
    host.textContent = (mode === "legacy" ? spec.message : spec.text) ?? "";
    window.lastToast = spec;
  }
  function show(spec) {
    window.nativeCalls++;
    if (mode === "throws") throw new Error("Discord toast API unavailable");
    const surface = spec.surface ?? "app";
    if (window.nativeState.currentToastMap.has(surface)) {
      const queue = window.nativeState.queuedToastsMap.get(surface) ?? [];
      queue.push(spec);
      window.nativeState.queuedToastsMap.set(surface, queue);
      return;
    }
    window.nativeState.currentToastMap.set(surface, spec);
    render(spec);
  }
  function pop() {
    const queued = window.nativeState.queuedToastsMap.get("app") ?? [];
    if (queued.length) {
      const next = queued.shift();
      window.nativeState.currentToastMap.set("app", next);
      render(next);
    } else {
      window.nativeState.currentToastMap.delete("app");
      document.getElementById("native-toast")?.remove();
    }
  }
  // Show deliberately comes first: it also references queuedToastsMap.
  const exports = { show, pop };
  const req = () => { window.factoryCalls++; return exports; };
  req.c = mode === "factory" ? {} : { toast: { exports } };
  req.m = mode === "factory" ? { toast: function() { return " .currentToastMap.has("; } } : {};
  window.toastRequire = mode === "missing" ? undefined : req;
  window.makeNativeReady = () => { window.toastRequire = req; };
}

function setupActivity() {
  const id = "1425993161108357191";
  const disposers = [];
  window.activityDisposers = disposers;
  window.activityId = id;
  window.Syncord = { common: {
    flux: { FluxDispatcher: { dispatch() {} } },
    stores: {
      UserStore: { getCurrentUser:()=>({id:"1425993161108357999"}),getUser: userId => ({ id:userId, username: userId !== id ? "Bob" : 'Alice <img onerror="bad">', avatar: "a" }) },
      PresenceStore: { getStatus: () => "offline", getActivities: () => [] },
      ChannelStore: { getChannel: id => ({ id, type: 0, guild_id: "g", name: "general" }) },
      PermissionStore: { computePermissions: () => 1024n },
      GuildStore: { getGuild: () => ({ name: "Guild" }), getGuildIds: () => [] },
    },
  } };
  window.activityContext = {
    settings: { get: (key, fallback) => key === "userIds" ? [id,"1425993161108357192"] : fallback },
    log: { warn() {} }, disposable: fn => disposers.push(fn),
  };
}

function driver(dir) {
  const { app, BrowserWindow } = require("electron");
  const path = require("node:path");
  app.setPath("userData",path.join(dir,"profile"));
  app.disableHardwareAcceleration();
  app.on("window-all-closed", () => {});
  app.whenReady().then(async () => {
    const results = [];
    try {
      for (const mode of ["current", "legacy", "factory", "missing", "throws"]) {
        const win = new BrowserWindow({ width: 600, height: 400, show: false,
          webPreferences: { backgroundThrottling: false } });
        try {
          await win.loadFile(path.join(dir, mode + ".html"));
          const result = await win.webContents.executeJavaScript(`(async () => {
            const mode = ${JSON.stringify(mode)};
            const waitFor = async check => {
              const deadline = Date.now() + 2000;
              while (!check()) {
                if (Date.now() > deadline) throw new Error('Toast did not render: ' + mode);
                await new Promise(resolve => setTimeout(resolve, 20));
              }
            };
            Syncord.common.flux.FluxDispatcher.dispatch({type:'MESSAGE_CREATE', message:{
              id:'123', channel_id:'channel', author:{id:activityId}, content:'PRIVATE MESSAGE BODY'
            }});
            Syncord.common.flux.FluxDispatcher.dispatch({type:'MESSAGE_CREATE', message:{
              id:'124', channel_id:'channel', author:{id:'1425993161108357192'}
            }});
            Syncord.common.flux.FluxDispatcher.dispatch({type:'PRESENCE_UPDATE', user:{id:activityId}, status:'online'});
            const selector = mode === 'missing' || mode === 'throws' ? '#Syncord-toast' : '#native-toast';
            await waitFor(() => document.querySelector(selector));
            const host = document.querySelector(selector);
            const out = {mode, activityText:host.textContent, visible:host.getBoundingClientRect().width > 0,
              htmlSafe:!host.querySelector('img'), calls:nativeCalls, payload:window.lastToast};
            window.activityDisposers.reverse().forEach(fn => fn());
            toast.popToast();
            out.dismissed = !document.querySelector(selector);
            if (mode === 'missing') makeNativeReady();
            for (const [type, variant] of [['success','success'], ['failure','critical'], ['message','default']]) {
              toast.showToast('Notice: ' + type, {type, position:'bottom', duration:1234});
              const active = document.querySelector(mode === 'throws' ? '#Syncord-toast' : '#native-toast');
              out[type] = {text:active?.textContent, payload:window.lastToast};
              toast.popToast();
            }
            out.factoryCalls = factoryCalls;
            const overlay = document.createElement('div'); overlay.id = 'Syncord-settings-root'; document.body.appendChild(overlay);
            const callsBeforeOverlay = nativeCalls;
            toast.showToast('Visible above settings', {duration:100});
            out.overlay = document.getElementById('Syncord-toast')?.textContent;
            out.overlayNativeCalls = nativeCalls - callsBeforeOverlay;
            await waitFor(() => !document.getElementById('Syncord-toast'));
            overlay.remove();
            return out;
          })()`);
          results.push(result);
        } finally { win.destroy(); }
      }
      console.log("TOAST_UI_RESULT:" + JSON.stringify(results));
      app.exit(0);
    } catch (error) { console.error(error.stack); app.exit(1); }
  });
}

test("toast UI: activity events render text with current and legacy native APIs, fallback and dismiss", {
  skip: !electron && "Electron is not installed", timeout: 30_000,
}, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "syncord-toast-ui-"));
  try {
    await build({ stdin: { resolveDir: root, loader: "ts", contents: `
      import * as toast from './src/renderer/ui/toast';
      import {startActivity} from './src/renderer/plugins/userActivity/runtime';
      window.toast = toast;
      startActivity(window.activityContext);
    ` }, bundle: true, platform: "browser", format: "iife", outfile: path.join(dir, "fixture.js"), logLevel: "warning",
    plugins: [{ name: "toast-native-fixture", setup(b) {
      b.onResolve({ filter: /\/(webpack|logger)$/ }, args => ({ path: args.path.split("/").pop(), namespace: "fixture" }));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ loader: "js", contents: args.path === "webpack"
        ? "export const getRequire = () => window.toastRequire;"
        : "export const createLogger = () => ({info(){},warn(){},error(){}});" }));
    } }] });
    for (const mode of ["current", "legacy", "factory", "missing", "throws"]) {
      writeFileSync(path.join(dir, mode + ".html"), `<!doctype html><html><head><style>
        :root {--background-floating:#202024;--text-default:#fff;}body{font:16px sans-serif;}
      </style></head><body><script>(${setupNative.toString()})(${JSON.stringify(mode)});(${setupActivity.toString()})();</script>
        <script src="fixture.js"></script></body></html>`);
    }
    writeFileSync(path.join(dir, "main.cjs"), `(${driver.toString()})(${JSON.stringify(dir)});`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const run = spawnSync(electron, [path.join(dir, "main.cjs")], { env, encoding: "utf8", timeout: 25_000 });
    assert.equal(run.status, 0, `${run.error ?? ""}\n${run.stdout}\n${run.stderr}`);
    const line = run.stdout.split("\n").find(line => line.startsWith("TOAST_UI_RESULT:")); assert.ok(line, `${run.stdout}\n${run.stderr}`);
    for (const result of JSON.parse(line.slice("TOAST_UI_RESULT:".length))) {
      assert.match(result.activityText, /Alice <img onerror="bad">: Sent a message: PRIVATE MESSAGE BODY — Guild \/ #general/);
      assert.match(result.activityText, /Offline → Online/);
      assert.match(result.activityText, /Bob: Sent a message — Guild \/ #general/);
      assert.ok(result.activityText.includes("PRIVATE MESSAGE BODY"));
      assert.equal(result.visible, true); assert.equal(result.htmlSafe, true); assert.equal(result.dismissed, true);
      assert.equal(result.calls, result.mode === "missing" ? 0 : 1, result.mode);
      if (result.payload) {
        assert.equal(result.mode === "legacy" ? result.payload.options.position : result.payload.position, result.mode === "legacy" ? 0 : "top");
        assert.equal(result.mode === "legacy" ? result.payload.options.duration : result.payload.duration, 4000);
      }
      for (const [type, variant] of [["success", "success"], ["failure", "critical"], ["message", "default"]]) {
        assert.equal(result[type].text, "Notice: " + type);
        if (result.mode !== "throws") {
          const payload = result[type].payload;
          if (result.mode === "legacy") {
            assert.equal(payload.type, type); assert.equal(payload.options.position, 1); assert.equal(payload.options.duration, 1234);
          } else {
            assert.equal(payload.variant, variant); assert.equal(payload.position, "bottom"); assert.equal(payload.duration, 1234); assert.equal(payload.surface, "app");
          }
        }
      }
      assert.equal(result.factoryCalls, result.mode === "factory" ? 1 : 0);
      assert.equal(result.overlay, "Visible above settings"); assert.equal(result.overlayNativeCalls, 0);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
