/**
 * Renders the real settings panel and checks the Typing mode select against the
 * controls it has to sit next to.
 *
 * A screenshot is written to `scripts/tests/fixtures/settings-select.png` for
 * eyeballing, and the assertions below cover the things a screenshot cannot:
 * that the native appearance is actually dropped, that the arrow is ours rather
 * than the platform's, and that the colours come from the panel's own tokens
 * instead of the browser's defaults.
 */
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);

const dir = await mkdtemp(path.join(tmpdir(), "dion-panel-"));

await build({
  stdin: {
    contents: `
      import { openSettings } from './src/renderer/ui/settingsPanel';
      import { settings } from './src/renderer/api/settings';
      window.api = { openSettings, settings };
    `,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "browser",
  outfile: path.join(dir, "bundle.js"),
  loader: { ".png": "dataurl" },
  logLevel: "warning",
});

// Discord's own theme variables, so the panel renders with real values rather
// than the fallbacks.
const THEME = `
  :root {
    --background-primary: #313338;
    --background-base-low: #1e1f22;
    --background-base-lower: #1a1b1e;
    --background-secondary: #2b2d31;
    --text-normal: #f2f3f5;
    --text-muted: #b5bac1;
    --border-subtle: #ffffff;
    --brand-500: #5865f2;
  }
`;

await writeFile(
  path.join(dir, "boot.js"),
  `
  window.__store = {};
  window.SyncordNative = {
    ping: async () => 'pong',
    getVersion: async () => 'test',
    getSettings: async () => window.__store,
    setSettings: async (d) => { Object.assign(window.__store, d); },
    httpFetch: async () => ({ ok: false, status: 0, text: '' }),
  };
`,
);
await writeFile(
  path.join(dir, "index.html"),
  `<!doctype html><meta charset="utf-8"><style>${THEME}
   body{margin:0;background:#313338}</style>
   <body><script src="boot.js"></script><script src="bundle.js"></script></body>`,
);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(pathToFileURL(path.join(dir, "index.html")).href);

  const out = await page.evaluate(async () => {
    await window.api.settings.init();
    // The panel only renders the Typing mode row for the Hide Typing plugin, and
    // only when it is expanded, so start from a state that shows it.
    window.api.settings.set("plugins.hide-typing.enabled", true);
    window.api.settings.set("plugins.hide-typing.data.easyChange", true);
    window.api.settings.set("plugins.hide-typing.data.typingMode", "always");
    window.api.openSettings();
    await new Promise((r) => setTimeout(r, 150));

    const plugin = document.querySelector(
      '[data-dion-plugin="hide-typing"], .dion-plugin',
    );
    // Expand every plugin section so the row is in the DOM.
    for (const head of document.querySelectorAll(".dion-plugin")) {
      head.classList.add("is-open");
    }
    await new Promise((r) => setTimeout(r, 80));

    const sel = document.querySelector("select[data-dion-hide-typing-mode]");
    if (!sel) {
      return { found: false, html: document.querySelector("#Syncord-settings-root")?.innerHTML.slice(0, 400) };
    }
    const cs = getComputedStyle(sel);
    const wrap = sel.closest(".dion-select-wrap");
    const chevron = sel.parentElement.querySelector(".dion-select-chevron");
    const chev = chevron ? getComputedStyle(chevron) : null;
    const row = sel.closest(".dion-field-row");
    const rowBg = row ? getComputedStyle(row).backgroundColor : "";

    // The neighbouring text input, for comparison, and the panel's own tokens.
    const other = document.querySelector("#Syncord-settings-root input[type='number']");
    const ocs = other ? getComputedStyle(other) : null;
    const rootStyle = getComputedStyle(document.getElementById("Syncord-settings-root"));
    const tokens = {
      bg: rootStyle.getPropertyValue("--dion-bg").trim(),
      border: rootStyle.getPropertyValue("--dion-border").trim(),
      text: rootStyle.getPropertyValue("--dion-text").trim(),
    };

    return {
      found: true,
      // must not be the platform widget any more
      appearance: cs.appearance,
      webkitAppearance: cs.webkitAppearance,
      bg: cs.backgroundColor,
      color: cs.color,
      border: cs.borderTopWidth + " " + cs.borderTopStyle + " " + cs.borderTopColor,
      radius: cs.borderTopLeftRadius,
      height: cs.height,
      fontSize: cs.fontSize,
      fontFamily: cs.fontFamily,
      paddingRight: cs.paddingRight,
      options: [...sel.options].map((o) => o.value),
      selected: sel.value,
      // our own arrow, not the native one
      hasChevron: !!chevron,
      chevronPointerEvents: chev?.pointerEvents,
      chevronColor: chev?.color,
      wrapPosition: wrap ? getComputedStyle(wrap).position : null,
      // option popup colours come from the control
      optionBg: getComputedStyle(sel.options[0]).backgroundColor,
      // matched against a sibling control
      otherBg: ocs?.backgroundColor ?? null,
      otherBorder: ocs?.borderTopColor ?? null,
      otherRadius: ocs?.borderTopLeftRadius ?? null,
      otherHeight: ocs?.height ?? null,
      tokens,
      rowBg,
    };
  });

  assert.equal(out.found, true, `the Typing mode select must render; got: ${out.html}`);

  assert.match(out.appearance, /none/, `the native widget must be dropped, got "${out.appearance}"`);
  assert.equal(out.webkitAppearance, "none", "webkit appearance must be dropped too");

  // Not the browser default white box.
  assert.notEqual(out.bg, "rgba(0, 0, 0, 0)", "the select needs a background");
  assert.notEqual(out.bg, "rgb(255, 255, 255)", "it must not be the platform's white");
  // Chromium reports color-mix() results in srgb() form, so compare the parsed
  // channels rather than the exact serialisation.
  const lum = (c) => {
    const m = String(c).match(/[\d.]+/g);
    if (!m) return null;
    return m.slice(0, 3).map(Number);
  };
  const text = lum(out.color);
  assert.ok(text && text[0] > 200 && text[1] > 200 && text[2] > 200,
    `text must be near-white, got ${out.color}`);

  // Same shape as the panel's other controls: 32px tall, 9px corners, which is
  // what the text inputs use.
  assert.equal(out.height, "32px", `height must be 32px like the text inputs, got ${out.height}`);
  assert.equal(out.radius, "9px", `radius must be 9px like the text inputs, got ${out.radius}`);

  // Colours come from the panel's tokens, not the browser's defaults, so the
  // select follows the Discord theme.
  assert.match(out.bg, /0\.11|30, 31, 34|#1e1f22/i,
    `background must derive from --dion-bg, got ${out.bg} (token ${out.tokens.bg})`);
  assert.ok(out.border.includes("1px"), `a 1px border, got "${out.border}"`);

  // If a text input happens to be on screen, it must be indistinguishable.
  if (out.otherBg) {
    assert.equal(out.bg, out.otherBg, `background must match the other field, got ${out.bg} vs ${out.otherBg}`);
    assert.equal(out.border.split(" ")[2], out.otherBorder, "border colour must match the other field");
    assert.equal(out.radius, out.otherRadius, "radius must match the other field");
  }

  // Our arrow.
  assert.equal(out.hasChevron, true, "the arrow must be drawn by us");
  assert.equal(out.chevronPointerEvents, "none", "the arrow must not swallow clicks");
  assert.equal(out.wrapPosition, "relative", "the arrow is positioned against its wrapper");
  assert.ok(parseFloat(out.paddingRight) >= 24, `room must be left for the arrow, got ${out.paddingRight}`);

  // Still a working control.
  assert.deepEqual(out.options, ["hide", "always", "default"]);
  assert.equal(out.selected, "always", "it must show the saved mode");
  assert.equal(out.optionBg, "rgb(30, 31, 34)", `the popup must use the panel background, got ${out.optionBg}`);

  assert.deepEqual(errors, [], `no page errors, got: ${errors.join(", ")}`);

  const shot = path.join(process.cwd(), "scripts/tests/fixtures/settings-select.png");
  await page.locator("#Syncord-settings-root").screenshot({ path: shot });

  console.log("PASS: the Typing mode select is themed and matches the other fields");
  console.log(`screenshot: ${shot}`);
} finally {
  await browser.close();
}
