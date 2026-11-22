/**
 * Renders the Auto Quests auto-claim block inside the real settings panel and
 * writes a screenshot to `scripts/tests/fixtures/auto-claim-panel.png`.
 *
 * This is a **manual harness**, not an assertion suite: it exists because the
 * first version of this block was visibly broken — the key field crushed to
 * 90px beside two overlapping buttons — and the failure was spatial, not
 * behavioural. Every automated test passed while the panel looked wrong.
 *
 * Run: `node scripts/tests/auto-claim-panel-shot.mjs`
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const dir = await mkdtemp(path.join(tmpdir(), "syncord-questshot-"));

await build({
  stdin: {
    contents: `
      import { openSettings } from './src/renderer/ui/settingsPanel';
      import { settings } from './src/renderer/api/settings';
      window.api = { openSettings, settings };
    `,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  platform: "browser",
  outfile: path.join(dir, "bundle.js"),
  loader: { ".png": "dataurl" },
  logLevel: "warning",
  plugins: [
    {
      name: "fixture",
      setup(b) {
        b.onResolve({ filter: /api\/plugin\/settingsDef$/ }, () => ({ path: "settingsDef", namespace: "fixture" }));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          loader: "js",
          contents: `export const definePluginSettings=defs=>({bind:()=>({
            get:key=>globalThis.saved[key]??defs[key].default,
            set:(key,value)=>{globalThis.saved[key]=value;},
          })});`,
        }));
      },
    },
  ],
});

const THEME = `
  :root {
    --background-primary:#313338; --background-secondary:#2b2d31; --background-base-high:#242429;
    --background-base-low:#1e1f22; --background-modifier-hover:#34343a;
    --text-default:#f2f3f5; --text-normal:#f2f3f5; --text-muted:#a6a6ad; --text-danger:#f23f43;
    --border-subtle:#ffffff; --border-strong:#ffffff; --brand-500:#5865f2;
  }
`;

await writeFile(
  path.join(dir, "boot.js"),
  `
  window.__store = { plugins: { "auto-quests": { enabled: true, data: { autoClaim: true } } } };
  window.saved = { autoClaim: true };
  window.SyncordNative = {
    ping: async () => "pong",
    getVersion: async () => "test",
    getSettings: async () => window.__store,
    setSettings: async (d) => { Object.assign(window.__store, d); },
    captcha: {
      status: async () => ({
        configured: true,
        masked: "nc_live_••••7f3a",
        encryptionAvailable: true,
        lockedDown: false,
      }),
      setKey: async () => ({ ok: true }),
      clearKey: async () => ({ cleared: true }),
      solve: async () => ({ ok: false, code: "not_configured", message: "", retryable: false, solveId: null }),
      feedback: async () => ({ ok: true, recorded: 0, failed: 0 }),
    },
    security: { status: async () => ({ trustedOrigins: true }), events: async () => [] },
  };
  window.Syncord = { common: { stores: {}, actions: {}, flux: {} }, toast: { show() {} }, webpack: {} };
  window.__questState = { claimed: 4, skipped: 1, solves: 2, lastError: null };
`,
);

await writeFile(
  path.join(dir, "index.html"),
  `<!doctype html><meta charset="utf-8"><style>${THEME}
   body{margin:0;background:#313338}</style>
   <body><script src="boot.js"></script><script src="bundle.js"></script></body>`,
);

const { existsSync, writeFileSync } = await import("node:fs");
const { spawnSync } = await import("node:child_process");
const electron = ["Electron.app/Contents/MacOS/Electron", "electron.exe", "electron"]
  .map((name) => path.join(root, "node_modules", "electron", "dist", name))
  .find(existsSync);
if (!electron) {
  console.error("Electron is not installed; skipping the panel screenshot.");
  process.exit(0);
}

await writeFile(
  path.join(dir, "main.cjs"),
  `
  const {app, BrowserWindow} = require("electron");
  const fs = require("fs");
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    const win = new BrowserWindow({width:900,height:900,show:false,frame:false,
      webPreferences:{backgroundThrottling:false,contextIsolation:false,nodeIntegration:true}});
    try {
      await win.loadFile(${JSON.stringify(path.join(dir, "index.html"))});
      const run = (code) => win.webContents.executeJavaScript(code);
      const result = await run(\`(async () => {
        const api = window.api;
        await api.settings.init();
        api.openSettings();
        await new Promise(r => setTimeout(r, 200));
        document.querySelector('[data-dion-quest-expand]').click();
        await new Promise(r => setTimeout(r, 120));
        const field = document.querySelector("[data-dion-quest-key]");
        field.value = "nc_live_0123456789abcdefghijklmnopqrstuv";
        field.focus();
        await new Promise(r => setTimeout(r, 200));
        const rect = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return {left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height};
        };
        const input = rect("[data-dion-quest-key]");
        const save = rect("[data-dion-quest-key-save]");
        const clear = rect("[data-dion-quest-key-clear]");
        return {
          block: !!document.querySelector(".dion-quest-key-block"),
          input, save, clear,
          valueKept: field.value,
          focused: document.activeElement === field,
        };
      })()\`);
      const image = await win.webContents.capturePage();
      fs.writeFileSync(${JSON.stringify(path.join(root, "scripts", "tests", "fixtures", "auto-claim-panel.png"))},
        image.toPNG());
      console.log("SYNCORD_PANEL_RESULT:" + JSON.stringify(result));
      win.destroy(); app.exit(0);
    } catch (error) { console.error(error.stack); win.destroy(); app.exit(1); }
  });
`,
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const run = spawnSync(electron, [path.join(dir, "main.cjs")], {
  env,
  encoding: "utf8",
  timeout: 40_000,
  maxBuffer: 1024 * 1024,
});
const line = (run.stdout ?? "").split("\n").find((l) => l.startsWith("SYNCORD_PANEL_RESULT:"));
if (!line) {
  console.error(run.stdout ?? "", run.stderr ?? "");
  process.exit(1);
}
const measured = JSON.parse(line.slice("SYNCORD_PANEL_RESULT:".length));
const { input, save, clear } = measured;
console.log(
  JSON.stringify(
    {
      ...measured,
      inputWidth: Math.round(input?.width ?? 0),
      // The reported bug was three controls crushed onto one line; the fix is
      // the input having its own row under the description, with the two
      // buttons beside it rather than on top of it.
      controlsOnTheirOwnRow: !!(input && save && save.top >= input.top - 1 && save.bottom <= input.bottom + 1),
      overlap: !!(input && save && (input.right > save.left + 1 || save.right > clear.left + 1)),
      screenshot: path.join(root, "scripts", "tests", "fixtures", "auto-claim-panel.png"),
    },
    null,
    2,
  ),
);