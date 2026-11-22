/**
 * Auto-claim settings section markup.
 *
 * The section is the only place a paid credential is ever typed into the
 * client, so two properties are asserted rather than assumed: the input is a
 * password field that never carries a stored key back into the page, and the
 * rendered text tells the user the truth about whether automatic claiming can
 * actually run right now.
 *
 * Run: `node --test scripts/tests/auto-quest-panel.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(path.join(tmpdir(), "syncord-quest-panel-"));
const out = path.join(dir, "bundle.mjs");
await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: "ts",
    contents: `export * from './src/renderer/plugins/autoQuests/panel';`,
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
const P = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

globalThis.saved = { autoClaim: true };

const stored = {
  enabled: true,
  configured: true,
  masked: "nc_live_••••7f3a",
  encryptionAvailable: true,
  lockedDown: false,
  status: "Running",
  claimed: 4,
  skipped: 1,
  solves: 2,
};

test("panel: the key field is a password box that never carries the key back", () => {
  const html = P.autoClaimSectionHtml(stored);
  assert.match(html, /type="password"/, "a stored key must not be rendered back into the page");
  assert.match(html, /data-dion-quest-key/);
  assert.equal(/value="nc_live_/.test(html), false, "the section must not render a key value");
  assert.match(html, /nc_live_••••7f3a/, "the masked form is shown instead, so the user recognises which key is in use");
});

test("panel: the field shows the stored key as a placeholder, so an empty box is not ambiguous", () => {
  // The field is cleared on save so the value does not sit in the DOM. Without
  // a placeholder the user cannot tell "no key stored" from "key stored".
  // Matched across the tag's lines: the markup is wrapped, and a regex that
  // stops at the first `>` silently stops matching nothing at all.
  const fieldOf = (view) => {
    const html = P.autoClaimSectionHtml(view);
    const tag = /<input\b[\s\S]*?data-dion-quest-key[\s\S]*?>/.exec(html);
    assert.ok(tag, "the key input should be present");
    return tag[0];
  };
  assert.match(fieldOf(stored), /placeholder="nc_live_••••7f3a"/);
  const empty = fieldOf({ ...stored, configured: false, masked: null });
  // The hint legitimately starts with `nc_live_`; what must not appear is a
  // second, stored key rendered alongside it.
  assert.match(empty, /placeholder="nc_live_…"/);
  assert.equal(empty.includes("7f3a"), false, "no stored key may appear when none is configured");
});

test("panel: the key field sits on its own row with the buttons, not squeezed beside the description", () => {
  const html = P.autoClaimSectionHtml(stored);
  // The squeeze was structural, not cosmetic: the input inherited the panel's
  // 90px `.dion-limit-controls input` rule and the buttons overlapped it.
  const block = /<div class="dion-quest-key-block">([\s\S]*?)<\/div>\s*<span/.exec(html);
  assert.ok(block, "the key controls should live in their own block");
  assert.match(block[1], /data-dion-quest-key/);
  assert.match(block[1], /data-dion-quest-key-save/);
  assert.match(block[1], /data-dion-quest-key-clear/);
  assert.equal(/dion-limit-controls/.test(html), false, "the key field must not reuse the number-spinner row");
});

test("panel: the typed key survives a repaint, so a background claim cannot wipe it", () => {
  // The watcher repaints this block whenever its state changes, and a claim can
  // land while someone is halfway through pasting a key. Replacing the markup
  // wholesale is what keeps the renderer simple; carrying the field across is
  // what makes it usable.
  const draft = P.captureAutoClaimDraft({ value: "nc_live_half_typed", focused: true });
  assert.equal(draft.value, "nc_live_half_typed");
  assert.equal(draft.focused, true);
  assert.deepEqual(P.captureAutoClaimDraft(null), { value: "", focused: false }, "a missing field must not throw");
  assert.deepEqual(P.captureAutoClaimDraft({ value: "", focused: false }), { value: "", focused: false });
});

test("panel: it says whether Discord's own captcha flow is covered", () => {
  // "Nothing happened" is ambiguous: either every captcha is being solved
  // without a click, or the bridge never found the surface Discord uses.
  assert.match(
    P.autoClaimSectionHtml({ ...stored, enabled: true, configured: true, widgetPatched: true }),
    /CAPTCHA dialog is also solved automatically/,
  );
  assert.match(
    P.autoClaimSectionHtml({ ...stored, enabled: true, configured: true, widgetPatched: false }),
    /has not been found|may need to complete it manually/,
  );
  // With the switch off or no key there is nothing to report.
  assert.equal(
    /data-dion-quest-autoclaim-widget/.test(
      P.autoClaimSectionHtml({ ...stored, enabled: false, configured: false, widgetPatched: false }),
    ),
    false,
  );
});

test("panel: the last failure reason is shown so a quiet skip is explainable", () => {
  const html = P.autoClaimSectionHtml({ ...stored, lastError: "HTTP 400: This quest has already been claimed" });
  assert.match(html, /This quest has already been claimed/);
  assert.equal(/data-dion-quest-autoclaim-error/.test(html), true);
});

test("panel: no failure row is rendered when there is nothing to report", () => {
  const html = P.autoClaimSectionHtml({ ...stored, lastError: null });
  assert.equal(/data-dion-quest-autoclaim-error/.test(html), false);
});

test("panel: the switch reflects the saved setting", () => {
  assert.match(P.autoClaimSectionHtml(stored), /data-dion-quest-autoclaim[^>]*checked/);
  assert.equal(
    /data-dion-quest-autoclaim[^>]*checked/.test(P.autoClaimSectionHtml({ ...stored, enabled: false })),
    false,
  );
});

test("panel: without a stored key the section says automatic claiming cannot run", () => {
  const html = P.autoClaimSectionHtml({ ...stored, configured: false, masked: null });
  assert.match(html, /No API key is saved/);
});

test("panel: a machine with no encrypted key store says so instead of failing silently", () => {
  const html = P.autoClaimSectionHtml({ ...stored, encryptionAvailable: false });
  assert.match(html, /Encrypted key storage/);
});

test("panel: a locked-down client refuses new solves and says so", () => {
  const html = P.autoClaimSectionHtml({ ...stored, lockedDown: true });
  assert.match(html, /Lockdown|lockedDown/);
});

test("panel: counters are rendered without any token or key material", () => {
  const html = P.autoClaimSectionHtml(stored);
  assert.match(html, /Claimed: 4 · Skipped: 1 · CAPTCHAs solved: 2/);
  assert.equal(html.includes("P1_"), false);
  assert.equal(/nc_live_[A-Za-z0-9_-]{8,}/.test(html), false, "only the masked form may appear");
});

test("panel: every string interpolated into the markup is escaped", () => {
  // The status line carries solver-supplied text. A status of `<img onerror>`
  // must not become markup.
  const html = P.autoClaimSectionHtml({ ...stored, status: '<img src=x onerror="alert(1)">' });
  assert.equal(html.includes("<img"), false);
  assert.match(html, /&lt;img/);
});