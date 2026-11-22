/**
 * Titlebar label mount tests.
 *
 * Run: `node --test scripts/tests/titlebar.test.mjs`
 *
 * The "Syncord" label in the top-left is the only always-visible sign that
 * Syncord is running, and it disappeared — with a perfectly healthy client,
 * eleven plugins started, and no error anywhere. The cause was a selector
 * pinned to one English accessible name:
 *
 *     [aria-label="Go back"]  …  [aria-label="Geri"]
 *
 * This machine's Discord runs in Turkish, where the real labels are
 * **"Geri dön"** and **"İleri git"**. Neither matched, so `tryMount()` returned
 * false, the 500 ms retry loop kept returning false, and nothing was logged.
 *
 * That is the third silent-failure class in this project after incidents 004
 * and 005: a rule derived from something we do not control — a localised string,
 * a file layout, Electron's exports shape — which fails quietly instead of
 * loudly. The fix belongs in a test, not in a habit.
 *
 * The module is browser code, so a minimal fake `document` stands in. It answers
 * only the selector forms the module actually uses, which keeps the test honest:
 * if the module starts using a selector the fake does not understand, the test
 * fails rather than quietly passing against an empty world.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

const dir = await mkdtemp(path.join(tmpdir(), "dion-titlebar-"));
const outfile = path.join(dir, "titlebar.mjs");

await build({
  stdin: {
    contents: `export { findBackButton } from './src/renderer/ui/titlebarButton';`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile,
  logLevel: "warning",
  // The module imports the settings panel, which imports the logo asset. Only
  // `findBackButton` is used here, so the asset is stubbed rather than inlined
  // — this test is about DOM selectors, and failing to build it would be a
  // confusing way to learn that.
  loader: { ".png": "dataurl" },
});

const { test } = await import("node:test");

/**
 * A node with just enough DOM for the anchor search: attributes, a parent
 * chain, a `closest`, and a bounding box.
 */
function el(tag, { ariaLabel, id, width = 32, height = 32 } = {}) {
  const node = {
    tagName: tag.toUpperCase(),
    id: id ?? "",
    classList: [],
    parentElement: null,
    children: [],
    _attrs: {},
    getAttribute(name) {
      return this._attrs[name] ?? null;
    },
    getBoundingClientRect() {
      return { width, height, top: 0, left: 0, right: width, bottom: height };
    },
    closest(selector) {
      if (!selector.startsWith(".")) return null;
      const wanted = selector.slice(1);
      let cur = this.parentElement;
      while (cur !== null) {
        if (cur.classList.includes(wanted)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector !== "button") throw new Error(`fake DOM does not implement ${selector}`);
      return descendants(this).filter((n) => n.tagName === "BUTTON");
    },
  };
  if (ariaLabel !== undefined) node._attrs["aria-label"] = ariaLabel;
  if (id !== undefined) node.id = id;
  return node;
}

function descendants(node, acc = []) {
  for (const child of node.children) {
    acc.push(child);
    descendants(child, acc);
  }
  return acc;
}

function append(parent, child) {
  child.parentElement = parent;
  parent.children.push(child);
  return child;
}

/**
 * Build a Discord-like titlebar in a given language, and install it as the
 * global `document` for the duration of `body`.
 *
 * @param {object} opts
 * @param {string} opts.back     accessible name of the back button
 * @param {string} opts.forward  accessible name of the forward button
 * @param {boolean} opts.chrome  whether to include the `data-window-chrome` host
 * @param {boolean} opts.localizedNames  name buttons by locale instead of marking
 *                                      them structurally
 */
function withTitlebar({ back, forward, chrome = true, localizedNames = true }, body) {
  const doc = {
    querySelector(selector) {
      const all = descendants(doc.documentElement);
      if (selector === '[data-window-chrome="true"]') {
        return chrome ? doc.documentElement : null;
      }
      if (selector === "header") return null;
      const ariaLabel = /^\[aria-label="(.+)"\]$/.exec(selector);
      if (ariaLabel !== null) {
        const wanted = ariaLabel[1].replace(/\\(.)/g, "$1");
        return all.find((n) => n.getAttribute("aria-label") === wanted) ?? null;
      }
      throw new Error(`fake DOM does not implement ${selector}`);
    },
  };

  const host = el("div", { id: localizedNames ? "" : "chrome" });
  if (chrome) host._attrs["data-window-chrome"] = "true";
  doc.documentElement = host;

  const group = append(host, el("div"));
  group.classList.push("backForward-abc123");
  const backBtn = append(group, el("button", { ariaLabel: back }));
  // Class hashes rotate every build, so mark the group with the stable prefix
  // that the module's `closest('[class*="backForward"]')` looks for.
  void backBtn;

  // A search field, so the structural strategy has a reason to reject it.
  append(host, el("input", { width: 200, height: 24 }));
  const forwardBtn = append(host, el("button", { ariaLabel: forward }));
  void forwardBtn;

  const previous = globalThis.document;
  globalThis.document = doc;
  try {
    return body();
  } finally {
    globalThis.document = previous;
  }
}

/**
 * The module graph reaches the settings panel, which touches `window` at import
 * time. Provide the minimum before importing, and restore afterwards so the rest
 * of the suite is unaffected.
 *
 * `document` is deliberately *not* installed globally here — each test installs
 * its own, so a test can never accidentally pass against a leftover world.
 */
const stubWindow = {
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  addEventListener: () => {},
  location: { href: "https://discord.com/app" },
  innerWidth: 1280,
  innerHeight: 720,
};
globalThis.window = stubWindow;

const T = await import(pathToFileURL(outfile).href);

test("titlebar: the back button is found in every locale Syncord is used in", () => {
  // Each of these is a real accessible name from a real Discord client. A
  // selector that only matches the first one is the bug this file exists for.
  for (const [back, forward] of [
    ["Go back", "Go forward"],
    ["Geri dön", "İleri git"],
    ["Zurück", "Vorwärts"],
    ["Retour", "Suivant"],
    ["Atrás", "Adelante"],
    ["Indietro", "Avanti"],
    ["Voltar", "Avançar"],
    ["Назад", "Вперёд"],
  ]) {
    withTitlebar({ back, forward }, () => {
      const found = T.findBackButton();
      assert.notEqual(found, null, `the back button must be found for locale "${back}"`);
      assert.equal(
        found.getAttribute("aria-label"),
        back,
        `the wrong element was selected for locale "${back}"`,
      );
    });
  }
});

test("titlebar: a locale we did not enumerate still yields a usable anchor", () => {
  // The name list is a guess, and a guess about someone else's UI goes stale.
  // The structural strategy is what makes the label appear on the *next* locale
  // rather than after the next bug report — so assert it works on its own, with
  // no known label present at all.
  withTitlebar({ back: "◀", forward: "▶" }, () => {
    const found = T.findBackButton();
    assert.notEqual(
      found,
      null,
      "an unenumerated locale must still be anchored structurally",
    );
  });
});

test("titlebar: the structural anchor is a small icon button, not the search field", () => {
  // The search field is 200×24 — wide, so inserting relative to it would put
  // the label in the middle of the titlebar. The structural strategy has to
  // reject it.
  withTitlebar({ back: "◀", forward: "▶" }, () => {
    const found = T.findBackButton();
    assert.equal(
      found.getAttribute("aria-label"),
      "◀",
      "the wide search input must not be selected as the anchor",
    );
  });
});

test("titlebar: no titlebar yet is reported, not thrown", () => {
  // The retry loop calls this twice a second for thirty seconds while Discord
  // is still building its UI. Throwing here would take the client down; the
  // caller logs the reason and tries again.
  const previous = globalThis.document;
  globalThis.document = {
    querySelector() {
      return null;
    },
  };
  try {
    assert.equal(T.findBackButton(), null);
  } finally {
    globalThis.document = previous;
  }
});

test("titlebar: the module does not depend on a single hardcoded English label", () => {
  // Belt and braces over the behavioural tests above: assert the source cannot
  // regress to one English string. Reads the file because the failure mode is
  // textual — someone tidying the list down to one entry.
  const source = readFileSync("src/renderer/ui/titlebarButton.ts", "utf-8");
  const named = [...source.matchAll(/"([A-Za-zÀ-ÿЀ-ӿ][^"]{1,24})"/g)].map((m) => m[1]);
  const localeNames = named.filter(
    (value) => !value.includes("aria-label") && !value.includes("dion-") && !value.includes(":"),
  );
  assert.ok(
    localeNames.length >= 4,
    `expected several accessible names in the locale list, found ${localeNames.length}: ` +
      JSON.stringify(localeNames),
    "a single-name lookup is the bug from incident 005's sibling — see this file's header",
  );
});
