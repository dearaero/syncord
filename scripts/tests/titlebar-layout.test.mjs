/** Native titlebar layout and lifecycle checks in a real Electron renderer. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const root = process.cwd();
const electron = [
  "Electron.app/Contents/MacOS/Electron", "electron.exe", "electron",
].map(name => path.join(root, "node_modules/electron/dist", name)).find(existsSync);

test("titlebar layout: native context stays live on the left, Syncord stays centered", {
  skip: !electron && "Electron is not installed", timeout: 30_000,
}, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "syncord-titlebar-layout-"));
  try {
    await build({
      loader: { ".png": "dataurl" },
      stdin: {
        resolveDir: root, loader: "ts",
        contents: `import { installTitlebarButton } from "./src/renderer/ui/titlebarButton";
          window.disposeTitlebar = installTitlebarButton();`,
      },
      bundle: true, platform: "browser", format: "iife",
      outfile: path.join(dir, "titlebar.js"), logLevel: "warning",
      plugins: [{
        name: "titlebar-fixture-dependencies",
        setup(b) {
          const stubs = {
            updater: `let state = {phase:"idle",latest:null,current:"0.1.2"};
              const listeners = new Set();
              export const updateState = () => state;
              export const onUpdate = fn => { listeners.add(fn); return () => listeners.delete(fn); };
              window.setUpdate = next => { state = {...state,...next}; for (const fn of listeners) fn(); };
              window.updateListeners = () => listeners.size;`,
            settingsPanel: `export const openSettings = () => { window.settingsOpened = (window.settingsOpened || 0) + 1; };`,
            tooltip: `export const bindTooltip = () => {};`,
            logger: `export const createLogger = () => ({info(){},warn(){}});`,
          };
          b.onResolve({ filter: /\/(updater|settingsPanel|tooltip|logger)$/ }, args => ({
            path: args.path.split("/").pop(), namespace: "fixture",
          }));
          b.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: stubs[args.path], loader: "js" }));
        },
      }],
    });
    // Discord's real leading/title/trailing structure and positioning; rotating
    // class suffixes ensure the layout does not depend on a specific build hash.
    writeFileSync(path.join(dir, "index.html"), `<!doctype html><html><head><style>
      html,body { margin:0; background:#121214; color:#ddd; font:15px sans-serif; }
      .bar_fixture { height:36px; box-sizing:border-box; display:flex; align-items:center;
        justify-content:space-between; position:relative; gap:8px; padding:0 12px 0 84px; }
      .leading_fixture { position:relative; display:flex; align-items:center; gap:12px; z-index:1; }
      .trailing_fixture { display:flex; position:relative; align-items:center; gap:12px; z-index:1; }
      .title_fixture { position:absolute; inset:0; display:flex; justify-content:center; align-items:center; }
      .backForwardButtons_fixture { display:flex; gap:8px; }
      .content_fixture { display:flex; align-items:center; gap:8px; }
      .name_fixture { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .icon_fixture { width:18px; height:18px; flex-shrink:0; }
      button.native { width:24px; height:24px; padding:0; border:0; background:transparent; color:#aaa; }
    </style></head><body>
      <div class="bar_fixture" data-window-chrome="true">
        <div class="leading_fixture"><div class="backForwardButtons_fixture">
          <button class="native" aria-label="Geri dön">←</button><button class="native" aria-label="İleri git">→</button>
        </div></div>
        <div class="title_fixture"><div class="content_fixture"><svg class="icon_fixture" aria-hidden="true"></svg><span class="name_fixture">Arkadaşlar</span></div></div>
        <div class="trailing_fixture"><button class="native" aria-label="Inbox">▣</button><button class="native" aria-label="Help">?</button></div>
      </div>
      <script src="titlebar.js"></script>
    </body></html>`);

    writeFileSync(path.join(dir, "main.cjs"), `
      const {app,BrowserWindow} = require("electron");
      app.disableHardwareAcceleration();
      app.whenReady().then(async () => {
        const win = new BrowserWindow({width:1200,height:120,show:false,frame:false,
          webPreferences:{backgroundThrottling:false,contextIsolation:true,nodeIntegration:false}});
        try {
          await win.loadFile(${JSON.stringify(path.join(dir, "index.html"))});
          const run = code => win.webContents.executeJavaScript(code);
          const snapshot = () => run(\`(() => {
            const bar = document.querySelector('[data-window-chrome]');
            const title = bar.querySelector('.title_fixture');
            const btn = document.getElementById('Syncord-titlebar-btn');
            const rect = el => { const r = el.getBoundingClientRect(); return {left:r.left,right:r.right,width:r.width,top:r.top,bottom:r.bottom}; };
            const badge = btn.querySelector('[data-dion-titlebar-update]');
            return {bar:rect(bar),context:rect(title),button:rect(btn),
              navigation:rect(bar.querySelector('.backForwardButtons_fixture')),
              trailing:rect(bar.querySelector('.trailing_fixture')),
              name:title.textContent, nativeParent:title.parentElement===bar,
              childCount:bar.querySelectorAll('.title_fixture').length,
              iconCount:title.querySelectorAll('svg').length,
              label:btn.getAttribute('aria-label'),badgeHidden:badge.hidden};
          })()\`);
          const settle = async () => {
            // Wait for the measured layout, rather than assuming an observer +
            // resize/transition cycle finishes in 160ms on a busy machine.
            let stable=0;const deadline=Date.now()+2000;
            while(Date.now()<deadline){
              await run('new Promise(resolve => setTimeout(resolve, 25))');const s=await snapshot();
              const centered=Math.abs((s.button.left+s.button.right)/2-(s.bar.left+s.bar.width/2))<1;
              if(centered&&s.context.left>=s.navigation.right+9&&s.context.right<=s.button.left-11&&s.button.right<s.trailing.left){if(++stable===2)return;}else stable=0;
            }
            throw Error('Titlebar layout did not settle: '+JSON.stringify(await snapshot()));
          };
          const result = {};
          await settle(); result.wide = await snapshot();
          await run(\`document.querySelector('.name_fixture').textContent = '! Very long server / channel / DM name '.repeat(12);
            window.setUpdate({phase:'available',latest:'0.1.3'});\`);
          await settle(); result.long = await snapshot();
          win.setContentSize(720,120); await settle(); result.narrow = await snapshot();
          win.webContents.setZoomFactor(1.25); await settle(); result.zoom = await snapshot();
          win.webContents.setZoomFactor(1); win.setContentSize(500,120); await settle(); result.small = await snapshot();
          win.setContentSize(1200,120); await settle();
          await run(\`(() => {
            const old = document.querySelector('.title_fixture');
            const next = old.cloneNode(true); next.querySelector('.name_fixture').textContent = '#general';
            next.removeAttribute('data-syncord-titlebar-context'); old.replaceWith(next);
          })()\`);
          await settle(); result.channel = await snapshot();
          await run(\`(() => {
            const bar = document.querySelector('[data-window-chrome]');
            const next = bar.cloneNode(true);
            next.querySelector('#Syncord-titlebar-btn').remove();
            next.removeAttribute('data-syncord-titlebar-layout');
            next.style.cssText = '';
            next.querySelector('.title_fixture').removeAttribute('data-syncord-titlebar-context');
            next.querySelector('.name_fixture').textContent = 'DM: Johny';
            bar.replaceWith(next);
          })()\`);
          await settle(); result.replaced = await snapshot();
          await run(\`document.getElementById('Syncord-titlebar-btn').click();
            window.setUpdate({phase:'up-to-date',latest:'0.1.2'});\`);
          await settle();
          result.current = await snapshot();
          result.click = await run('window.settingsOpened');
          result.listeners = await run('window.updateListeners()');
          result.cleanup = await run(\`(() => {
            window.disposeTitlebar();
            const bar = document.querySelector('[data-window-chrome]');
            return {button:!!document.getElementById('Syncord-titlebar-btn'),
              css:!!document.getElementById('Syncord-titlebar-css'),
              context:!!document.querySelector('[data-syncord-titlebar-context]'),
              layout:bar.hasAttribute('data-syncord-titlebar-layout'),
              left:bar.style.getPropertyValue('--syncord-context-left'),
              listeners:window.updateListeners(),nativeTitle:bar.querySelector('.title_fixture').textContent};
          })()\`);
          console.log('SYNCORD_LAYOUT_RESULT:'+JSON.stringify(result));
          win.destroy(); app.exit(0);
        } catch(error) { console.error(error.stack); win.destroy(); app.exit(1); }
      });
    `);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const run = spawnSync(electron, [path.join(dir, "main.cjs")], {
      env, encoding: "utf8", timeout: 25_000, maxBuffer: 1024 * 1024,
    });
    assert.equal(run.status, 0, `Electron fixture failed: ${run.error ?? ""}\n${run.stdout}\n${run.stderr}`);
    const line = run.stdout.split("\n").find(line => line.startsWith("SYNCORD_LAYOUT_RESULT:"));
    assert.ok(line, "Electron did not return the layout measurements");
    const result = JSON.parse(line.slice("SYNCORD_LAYOUT_RESULT:".length));
    for (const name of ["wide", "long", "narrow", "zoom", "small", "channel", "replaced", "current"]) {
      const state = result[name];
      const center = (state.button.left + state.button.right) / 2;
      assert.ok(Math.abs(center - (state.bar.left + state.bar.width / 2)) < 1, `${name}: Syncord is not centered`);
      assert.ok(state.context.left >= state.navigation.right + 9, `${name}: context overlaps navigation`);
      assert.ok(state.context.right <= state.button.left - 11, `${name}: context overlaps Syncord`);
      assert.ok(state.button.right < state.trailing.left, `${name}: Syncord overlaps native right controls`);
      assert.equal(state.nativeParent, true, `${name}: native title was moved out of React's parent`);
      assert.equal(state.childCount, 1);
      assert.equal(state.iconCount, 1);
    }
    assert.equal(result.wide.name, "Arkadaşlar");
    assert.equal(result.channel.name, "#general");
    assert.equal(result.replaced.name, "DM: Johny");
    assert.match(result.long.label, /0\.1\.3 is available/);
    assert.equal(result.replaced.badgeHidden, false);
    assert.match(result.current.label, /0\.1\.2 is up to date/);
    assert.equal(result.click, 1);
    assert.equal(result.listeners, 1, "remounting added a duplicate updater subscription");
    assert.deepEqual(result.cleanup, {
      button:false,css:false,context:false,layout:false,left:"",listeners:0,nativeTitle:"DM: Johny",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
