/**
 * Discord's own hCaptcha flow, solved without a click.
 *
 * The auto-claimer makes its own API calls and handles its own captcha. This is
 * the other path: when *Discord* decides a request needs a captcha and opens its
 * own widget, the user is currently the one who clicks the checkbox. These tests
 * pin the behaviour that removes that click — and, just as importantly, the
 * behaviour that leaves Discord completely alone when solving is not possible.
 *
 * Run: `node --test scripts/tests/discord-hcaptcha.test.mjs
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(path.join(tmpdir(), "syncord-hcaptcha-"));
const out = path.join(dir, "bundle.mjs");

await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: "ts",
    contents: `export * from './src/renderer/plugins/autoQuests/hcaptcha';`,
  },
  bundle: true,
  platform: "neutral",
  format: "esm",
  outfile: out,
  logLevel: "warning",
  plugins: [
    {
      name: "fixture",
      setup(b) {
        b.onResolve({ filter: /api\/plugin\/settingsDef$/ }, () => ({ path: "settingsDef", namespace: "fixture" }));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          loader: "js",
          contents: `export const definePluginSettings=defs=>({bind:()=>({get:key=>globalThis.saved[key]??defs[key].default,set:(key,value)=>{globalThis.saved[key]=value;}})});`,
        }));
      },
    },
  ],
});

const H = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

const SITEKEY = "a9b5fb07-92ff-493f-86fe-352a2803b3df";

afterEach(() => {
  H.stopHcaptchaBridge();
  delete globalThis.window;
  delete globalThis.saved;
});

/** A minimal hCaptcha widget API, the way hcaptcha.com/1/api.js exposes it. */
function installWidget(overrides = {}) {
  const calls = { execute: 0, render: 0 };
  const widget = {
    execute(sitekey, params, callback) {
      calls.execute += 1;
      widget.lastExecute = { sitekey, params, callback };
      // The real widget answers asynchronously with a token.
      setTimeout(() => callback?.({ response: "P1_HUMAN", respKey: "E0_HUMAN" }), 0);
    },
    render(container, options) {
      calls.render += 1;
      return 1;
    },
    ...overrides,
  };
  globalThis.window = { hcaptcha: widget };
  return { widget, calls };
}

function context(options = {}) {
  const solved = [];
  const toasts = [];
  return {
    solved,
    toasts,
    plugin: { id: "auto-quests" },
    log: { info() {}, warn() {}, error() {} },
    settings: { get: (key, fallback) => globalThis.saved[key] ?? fallback, set() {} },
    captcha: {
      status: async () => ({ configured: options.configured !== false }),
      solve: async (request) => {
        solved.push(request);
        return options.solve?.(request, solved.length - 1) ?? {
          ok: true,
          token: "P1_SOLVED",
          respKey: "E0_SOLVED",
          userAgent: null,
          solveId: "solve_00000001",
          creditsCharged: 1,
        };
      },
      feedback: async () => ({ ok: true, recorded: 1, failed: 0 }),
    },
    disposable: () => {},
    toast: (message) => toasts.push(message),
  };
}

test("hcaptcha: Discord's execute is answered from the solver, with no widget", async () => {
  const { widget, calls } = installWidget();
  const ctx = context();
  globalThis.saved = { autoClaim: true };
  H.startHcaptchaBridge(ctx);

  const answer = new Promise((resolve) => widget.execute(SITEKEY, { rqdata: "RQ" }, resolve));
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(calls.execute, 0, "the real widget must never open once we can answer");
  assert.equal((await answer).response, "P1_SOLVED");
  assert.equal(ctx.solved[0].sitekey, SITEKEY);
  assert.equal(ctx.solved[0].rqdata, "RQ", "enterprise rqdata has to reach the solver");
});

test("hcaptcha: the callback gets the response key alongside the token", async () => {
  const { widget } = installWidget();
  globalThis.saved = { autoClaim: true };
  H.startHcaptchaBridge(context());
  const answer = new Promise((resolve) => widget.execute(SITEKEY, {}, resolve));
  await new Promise((r) => setTimeout(r, 5));
  const value = await answer;
  assert.equal(value.respKey, "E0_SOLVED");
});

test("hcaptcha: with no stored key Discord behaves exactly as it did", async () => {
  const { calls } = installWidget();
  const ctx = context({ configured: false });
  globalThis.saved = { autoClaim: true };
  H.startHcaptchaBridge(ctx);

  const answer = new Promise((resolve) => window.hcaptcha.execute(SITEKEY, {}, resolve));
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(calls.execute, 1, "the original widget must run when we cannot answer");
  assert.equal((await answer).response, "P1_HUMAN");
  assert.equal(ctx.solved.length, 0, "no credit may be spent with no key");
});

test("hcaptcha: with the switch off Discord is never touched", async () => {
  const { calls } = installWidget();
  const ctx = context();
  globalThis.saved = { autoClaim: false };
  H.startHcaptchaBridge(ctx);

  const answer = new Promise((resolve) => window.hcaptcha.execute(SITEKEY, {}, resolve));
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(calls.execute, 1);
  assert.equal((await answer).response, "P1_HUMAN");
  assert.equal(ctx.solved.length, 0);
});

test("hcaptcha: a failed solve falls back to the human rather than breaking the flow", async () => {
  const { calls } = installWidget();
  const ctx = context({
    solve: () => ({ ok: false, code: "request_failed", message: "no", retryable: false, solveId: null }),
  });
  globalThis.saved = { autoClaim: true };
  H.startHcaptchaBridge(ctx);

  const answer = new Promise((resolve) => window.hcaptcha.execute(SITEKEY, {}, resolve));
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(calls.execute, 1, "Discord's own widget is the fallback");
  assert.equal((await answer).response, "P1_HUMAN");
});

test("hcaptcha: a widget that appears after we start is still patched", async () => {
  globalThis.window = {};
  globalThis.saved = { autoClaim: true };
  const ctx = context();
  H.startHcaptchaBridge(ctx);

  // hcaptcha's script loads lazily; a patch installed at boot sees nothing.
  const { widget, calls } = installWidget();
  H.checkHcaptchaWidget(ctx);
  await new Promise((r) => setTimeout(r, 5));

  const answer = new Promise((resolve) => widget.execute(SITEKEY, {}, resolve));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.execute, 0);
  assert.equal((await answer).response, "P1_SOLVED");
});

test("hcaptcha: installing twice patches once", async () => {
  const { widget } = installWidget();
  const ctx = context();
  globalThis.saved = { autoClaim: true };
  H.startHcaptchaBridge(ctx);
  H.startHcaptchaBridge(ctx);
  H.checkHcaptchaWidget(ctx);

  await new Promise((resolve) => widget.execute(SITEKEY, {}, resolve));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(ctx.solved.length, 1, "one solve per challenge, however many installs");
});

test("hcaptcha: stopping restores Discord's own function", async () => {
  const { widget, calls } = installWidget();
  const original = widget.execute;
  globalThis.saved = { autoClaim: true };
  H.startHcaptchaBridge(context());
  H.checkHcaptchaWidget(context());
  assert.notEqual(window.hcaptcha.execute, original, "it should be patched while running");

  H.stopHcaptchaBridge();
  assert.equal(window.hcaptcha.execute, original, "leaving a widget patched is how a disabled plugin keeps spending money");
  const answer = new Promise((resolve) => window.hcaptcha.execute(SITEKEY, {}, resolve));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await answer).response, "P1_HUMAN");
  assert.equal(calls.execute, 1);
});

test("hcaptcha: the page URL sent to the solver is Discord's own origin", async () => {
  const { widget } = installWidget();
  const ctx = context();
  globalThis.saved = { autoClaim: true };
  H.startHcaptchaBridge(ctx);
  await new Promise((resolve) => widget.execute(SITEKEY, {}, resolve));
  await new Promise((r) => setTimeout(r, 5));
  assert.match(ctx.solved[0].url, /^https:\/\/(www\.)?discord(app)?\.com\//);
});

test("hcaptcha: a challenge with no sitekey is left entirely to Discord", async () => {
  const { calls } = installWidget();
  const ctx = context();
  globalThis.saved = { autoClaim: true };
  H.startHcaptchaBridge(ctx);

  await new Promise((resolve) => window.hcaptcha.execute(undefined, {}, resolve));
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(calls.execute, 1);
  assert.equal(ctx.solved.length, 0, "a solve request with no sitekey cannot be sent");
});