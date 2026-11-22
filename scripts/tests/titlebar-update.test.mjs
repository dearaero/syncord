/**
 * Titlebar update notification tests.
 *
 * Run: `node --test scripts/tests/titlebar-update.test.mjs`
 *
 * The update icon beside the Syncord wordmark. The indicator follows update
 * availability, survives opening settings and ignores historical seen markers.
 * These tests also cover version labels, status changes and subscription cleanup.
 * Anchor discovery is tested separately in titlebar.test.mjs.
 *
 * The module under test is the shipped file. Only its collaborators are
 * substituted — the settings store, the update status, the tooltip and the
 * settings panel — because the point is the decision and the click, not that
 * Electron and Discord exist.
 *
 * The fake DOM throws on any selector or method it does not implement, so a
 * change to the module that reaches for something new fails here rather than
 * quietly passing against an empty world.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { build } from "esbuild";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

const { test } = await import("node:test");

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = await mkdtemp(path.join(tmpdir(), "dion-titlebar-update-"));

// ── Stubs ─────────────────────────────────────────────────────────────────────

const UPDATER_STUB = `
export const state = {
  phase: "idle",
  detail: "",
  build: "1.4.0",
  current: "1.4.0",
  latest: null,
  channel: "stable",
  platform: "mac-arm64",
  progress: null,
  stagedVersion: null,
  lastError: null,
};
const listeners = new Set();

export function setState(patch) {
  Object.assign(state, patch);
  for (const listener of [...listeners]) listener({ ...state });
}

export function updateState() {
  return { ...state };
}

export function onUpdate(listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const listenerCount = () => listeners.size;
export const AUTO_UPDATE_KEY = "updates.autoCheck";
export const UPDATE_CHANNEL_KEY = "updates.channel";
export const INJECTOR_PATH_KEY = "updates.injectorPath";
export const LAST_SEEN_KEY = "updates.lastSeenVersion";
`;

const SETTINGS_STUB = `
export const stored = new Map();
export const settings = {
  get(key, fallback) {
    return stored.has(key) ? stored.get(key) : fallback;
  },
  set(key, value) {
    stored.set(key, value);
  },
};
export const __resetSettings = () => stored.clear();
`;

const TOOLTIP_STUB = `
export const bound = [];
export function bindTooltip(anchor, text, options = {}) {
  bound.push({ anchor, text, options });
  return () => {};
}
export const __tooltipText = (index = 0) => {
  const value = bound[index].text;
  return typeof value === "function" ? value() : value;
};
`;

const PANEL_STUB = `
export const opened = [];
export function openSettings() {
  opened.push(true);
}
export function closeSettings() {}
export function toggleSettings() {}
`;

const LOGGER_STUB = `
export function createLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}
`;

for (const [name, source] of [
  ["updater.ts", UPDATER_STUB],
  ["settings.ts", SETTINGS_STUB],
  ["tooltip.ts", TOOLTIP_STUB],
  ["settingsPanel.ts", PANEL_STUB],
  ["logger.ts", LOGGER_STUB],
]) {
  fs.writeFileSync(path.join(dir, name), source);
}

const entry = path.join(dir, "entry.ts");
fs.writeFileSync(
  entry,
  `export {
     installTitlebarButton, badgeStateFor, badgeMessage,
   } from ${JSON.stringify(path.join(REPO, "src", "renderer", "ui", "titlebarButton.ts"))};
   export { state, setState, listenerCount, LAST_SEEN_KEY } from "../api/updater";
   export { stored, settings, __resetSettings } from "../api/settings";
   export { opened } from "./ui/settingsPanel";
   export { __tooltipText } from "./ui/tooltip";
  `,
);

const outfile = path.join(dir, "bundle.mjs");
await build({
  entryPoints: [entry],
  bundle: true,
  platform: "neutral",
  format: "esm",
  outfile,
  logLevel: "warning",
  plugins: [
    {
      name: "stub-renderer-deps",
      setup(b) {
        // One specifier, one resolution, one instance. Aliasing by package name
        // would not work: these are all relative imports.
        //
        // The patterns match the *last segment* rather than a full path, because
        // the module under test imports "./settingsPanel" while this entry
        // re-exports "./ui/settingsPanel". Both must land on the same stub, or
        // the test would set state in one instance and read another -- which is
        // exactly the failure the update-ui suite records having hit.
        const stubs = new Map([
          [/(^|[\\/])api[\\/]updater$/, path.join(dir, "updater.ts")],
          [/(^|[\\/])api[\\/]settings$/, path.join(dir, "settings.ts")],
          [/(^|[\\/])api[\\/]logger$/, path.join(dir, "logger.ts")],
          [/(^|[\\/])tooltip$/, path.join(dir, "tooltip.ts")],
          [/(^|[\\/])settingsPanel$/, path.join(dir, "settingsPanel.ts")],
        ]);
        b.onResolve({ filter: /.*/ }, (args) => {
          if (args.kind !== "import-statement" && args.kind !== "require-call") return null;
          for (const [pattern, replacement] of stubs) {
            if (pattern.test(args.path)) return { path: replacement };
          }
          return null;
        });
      },
    },
  ],
  define: { __SYNCORD_VERSION__: JSON.stringify("1.4.0") },
});

// ── Fake DOM ──────────────────────────────────────────────────────────────────

/**
 * A node that supports exactly what the module uses, and throws on the rest.
 *
 * The strictness is the point. A permissive fake returns `null` or `[]` for
 * anything it does not recognise, so a module that starts using a new selector
 * would find nothing and pass; a strict one makes that a test failure.
 */
class El {
  constructor(tag, attributes = {}) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.id = attributes.id ?? "";
    this.className = attributes.class ?? "";
    this.hidden = Boolean(attributes.hidden);
    this.textContent = "";
    this._attrs = { ...attributes };
    this._listeners = new Map();
    // `dataset` has to be a real object for `el.dataset.dionState = "x"` to
    // become `data-dion-state="x"`, which is what the stylesheet keys on. A plain
    // property bag would hide the very thing the CSS is matching.
    this.dataset = {};
    for (const [name, value] of Object.entries(attributes)) {
      if (name.startsWith("data-")) this.dataset[dashToCamel(name.slice(5))] = value;
    }
  }

  get classList() {
    return this.className.split(/\s+/).filter(Boolean);
  }

  contains(node) {
    return node === this || descendants(this).includes(node);
  }

  setAttribute(name, value) {
    this._attrs[name] = value;
    if (name === "id") this.id = value;
    if (name === "class") this.className = value;
    if (name === "hidden") this.hidden = value !== "" && value !== "false";
    if (name.startsWith("data-")) this.dataset[dashToCamel(name.slice(5))] = value;
  }

  getAttribute(name) {
    if (name.startsWith("data-")) {
      const value = this.dataset[dashToCamel(name.slice(5))];
      return value === undefined ? null : value;
    }
    // `id` is set as a property by the module (`btn.id = …`) and the real DOM
    // reflects that to the attribute. A fake that kept the two apart would fail
    // every `getElementById` the module does, with a message about a button that
    // "did not mount" and no hint that the document was the liar.
    if (name === "id") return this.id === "" ? null : this.id;
    return this._attrs[name] ?? null;
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  addEventListener(type, handler) {
    const list = this._listeners.get(type) ?? [];
    list.push(handler);
    this._listeners.set(type, list);
  }

  removeEventListener(type, handler) {
    const list = (this._listeners.get(type) ?? []).filter((h) => h !== handler);
    this._listeners.set(type, list);
  }

  dispatch(type) {
    for (const handler of this._listeners.get(type) ?? []) {
      handler({ target: this, preventDefault() {}, stopPropagation() {} });
    }
  }

  remove() {
    this.removed = true;
    if (this.parentElement !== null) {
      this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
      this.parentElement = null;
    }
  }

  insertAdjacentElement(position, node) {
    if (position !== "afterend") {
      throw new Error(`fake DOM does not implement insertAdjacentElement("${position}")`);
    }
    if (this.parentElement === null) throw new Error("no parent to insert after");
    const siblings = this.parentElement.children;
    const at = siblings.indexOf(this) + 1;
    node.parentElement = this.parentElement;
    siblings.splice(at, 0, node);
    return node;
  }

  getBoundingClientRect() {
    return { width: 32, height: 32, top: 0, left: 0, right: 32, bottom: 32 };
  }

  closest(selector) {
    const classMatch = /^\.([A-Za-z0-9_-]+)$/.exec(selector);
    const attrMatch = /^\[([a-z-]+)(?:\*?=.*)?\]$/.exec(selector);
    if (classMatch === null && attrMatch === null) {
      throw new Error(`fake DOM does not implement closest("${selector}")`);
    }
    let cur = this.parentElement;
    while (cur !== null) {
      if (classMatch !== null && cur.className.split(/\s+/).includes(classMatch[1])) return cur;
      if (attrMatch !== null && cur.getAttribute(attrMatch[1]) !== null) {
      // `class*="backForward"` is a substring test, not an equality one. The
      // module relies on the *stable prefix* because Discord rotates the hash on
      // every build, so a fake that compared the whole string would make the
      // class-hash strategy look broken when it is the part that survives.
      if (selector.includes("*=")) {
        const value = String(cur.getAttribute(attrMatch[1]) ?? "");
        const wanted = selector.slice(selector.indexOf("*=") + 2, -1);
        if (value.includes(wanted)) return cur;
      } else {
        return cur;
      }
    }
      cur = cur.parentElement;
    }
    return null;
  }

  querySelectorAll(selector) {
    if (selector !== "button") {
      throw new Error(`fake DOM does not implement querySelectorAll("${selector}")`);
    }
    return descendants(this).filter((n) => n.tagName === "BUTTON");
  }

  querySelector(selector) {
    return queryAll(this, selector)[0] ?? null;
  }
}

function dashToCamel(value) {
  return value.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function descendants(node, acc = []) {
  for (const child of node.children) {
    acc.push(child);
    descendants(child, acc);
  }
  return acc;
}

/**
 * Supports the three selector forms the module actually uses: a bare tag, an
 * exact attribute value, and a class. Anything else is a hard error.
 */
function queryAll(root, selector) {
  const out = [];
  const tag = /^[a-z]+$/.exec(selector);
  const attrValue = /^\[([a-z-]+)="([^"]*)"\]$/.exec(selector);
  const attr = /^\[([a-z-]+)\]$/.exec(selector);
  const classMatch = /^\.([A-Za-z0-9_-]+)$/.exec(selector);
  if (tag === null && attrValue === null && attr === null && classMatch === null) {
    throw new Error(`fake DOM does not implement the selector "${selector}"`);
  }

  const matches = (node) => {
    if (tag !== null) return node.tagName === tag[0].toUpperCase();
    if (attrValue !== null) return node.getAttribute(attrValue[1]) === attrValue[2];
    if (attr !== null) return node.getAttribute(attr[1]) !== null;
    return node.className.split(/\s+/).includes(classMatch[1]);
  };

  const visit = (node) => {
    if (node !== root && matches(node)) out.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return out;
}

const STYLE_TAG = Symbol("style");

/**
 * The document that exists between tests: no titlebar, no button, nothing.
 *
 * Present for a real reason rather than for convenience. `reset()` and the
 * teardown assertion both drive a status change while no titlebar is mounted,
 * and a renderer always has a `document` — one that simply finds no button.
 * Without this, those two cases would fail for the wrong reason
 * (`document is undefined` rather than "the code coped"), and the assertion that
 * teardown does not throw would pass on a `TypeError` it never looked at.
 */
const baseDocument = {
  documentElement: new El("html"),
  body: new El("body"),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (tag) => new El(tag),
};
globalThis.document = baseDocument;

/**
 * Install a Discord-like titlebar as the global `document`.
 *
 * Deliberately *not* scoped to a callback. A page has one document for its whole
 * lifetime, and a status change arrives seconds or hours after the button was
 * mounted — so a harness that tore the world down on return would have every
 * repaint test run against an empty document and fail for a reason that has
 * nothing to do with the code under test. `restoreWorld()` puts it back.
 *
 * The back button is named in the locale this machine actually runs, because the
 * anchor search goes through the accessible names first and a fake English world
 * would let a regression in that path pass.
 */
function installWorld() {
  const documentElement = new El("html");
  const chrome = new El("div");
  chrome.setAttribute("data-window-chrome", "true");
  documentElement.appendChild(chrome);

  const group = new El("div");
  group.setAttribute("class", "backForward-a1b2c3");
  chrome.appendChild(group);
  const back = new El("button");
  back.setAttribute("aria-label", "Geri dön");
  group.appendChild(back);

  globalThis.document = {
    documentElement,
    body: chrome,
    createElement: (tag) => new El(tag),
    createElementNS: (_namespace, tag) => new El(tag),
    getElementById: (id) => queryAll(documentElement, `[id="${id}"]`)[0] ?? null,
    querySelector(selector) {
      if (selector === "header") return null;
      return queryAll(documentElement, selector)[0] ?? null;
    },
    querySelectorAll: (selector) => queryAll(documentElement, selector),
  };

  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};

  return globalThis.document;
}

function restoreWorld() {
  globalThis.document = baseDocument;
}

// The module's own boot path uses these through `window`.
globalThis.window = {
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
};

const T = await import(pathToFileURL(outfile).href);

// ── Tests ─────────────────────────────────────────────────────────────────────

const IDLE = {
  phase: "idle",
  detail: "Update checks have not run yet.",
  build: "1.4.0",
  current: "1.4.0",
  latest: null,
  channel: "stable",
  platform: "mac-arm64",
  progress: null,
  stagedVersion: null,
  lastError: null,
};

const OFFER = { ...IDLE, phase: "available", latest: "1.5.0", detail: "Syncord 1.5.0 is available." };

function reset() {
  T.__resetSettings();
  T.setState(IDLE);
  T.opened.length = 0;
}

function mount() {
  installWorld();
  const dispose = T.installTitlebarButton();
  const btn = globalThis.document.getElementById("Syncord-titlebar-btn");
  assert.ok(btn !== null, "the titlebar button did not mount");
  const badge = btn.querySelector("[data-dion-titlebar-update]");
  assert.ok(badge !== null, "the button mounted with no badge in it");
  return { dispose, btn, badge };
}

test("titlebar update: the decision table", () => {
  // Unchecked or failed checks must never imply the client is current.
  for (const phase of ["idle", "checking", "error"]) {
    assert.equal(
      T.badgeStateFor(phase, "1.5.0", "1.4.0"),
      "none",
      `${phase} must not light up the titlebar`,
    );
  }

  assert.equal(T.badgeStateFor("up-to-date", "1.4.0", "1.4.0"), "current");
  assert.equal(T.badgeStateFor("up-to-date", "1.3.0", "1.4.0"), "current");
  assert.equal(T.badgeStateFor("up-to-date", "1.5.0", "1.4.0"), "none");
  assert.equal(T.badgeStateFor("up-to-date", null, "1.4.0"), "none");
  assert.equal(T.badgeStateFor("up-to-date", "1.4.0", "invalid"), "none");

  assert.equal(T.badgeStateFor("available", "1.5.0"), "offered");
  assert.equal(T.badgeStateFor("ready", "1.5.0"), "ready");
  assert.equal(T.badgeStateFor("downloading", "1.5.0"), "working");
  assert.equal(T.badgeStateFor("handing-off", "1.5.0"), "working");
  assert.equal(T.badgeStateFor("handed-off", "1.5.0"), "restart");

  assert.equal(T.badgeStateFor("available", "1.6.0"), "offered");

  // `latest` is null in every non-offering phase, so the guard is belt and
  // braces — but a dot with no version to name is not a notification.
  assert.equal(T.badgeStateFor("available", null), "none");
  assert.equal(T.badgeStateFor("ready", null), "none");
});

test("titlebar update: the sentence names the version, and never invents one", () => {
  assert.equal(T.badgeMessage("none", "1.5.0"), null, "a state with no dot still produced copy");
  assert.equal(T.badgeMessage("current", "1.4.0"), "Syncord 1.4.0 is up to date");
  assert.equal(T.badgeMessage("current", null), "Syncord is up to date");
  assert.equal(T.badgeMessage("offered", "1.5.0"), "Syncord 1.5.0 is available");
  assert.match(T.badgeMessage("ready", "1.5.0"), /1\.5\.0.*ready to install/);
  assert.match(T.badgeMessage("restart", "1.5.0"), /quit and reopen/);

  /*
   * `restart` with no version is reachable: main reports the install through
   * `stagedVersion`, and a hand-off that somehow carried neither would otherwise
   * render "Syncord null is installed". The copy has to stand on its own.
   */
  const restart = T.badgeMessage("restart", null);
  assert.ok(restart !== null, "a restart with no version said nothing at all");
  assert.doesNotMatch(restart, /null|undefined/, `leaked a missing version: ${restart}`);
  assert.match(restart, /quit and reopen/);

  /*
   * `offered` and `ready` without a version are *unreachable* — the state machine
   * refuses both without a version, which the decision table asserts. So the
   * branch is defensive, and the property worth pinning is that it declines to
   * produce a sentence rather than interpolating nothing into one.
   */
  for (const state of ["offered", "ready"]) {
    const message = T.badgeMessage(state, null);
    assert.ok(
      message === null || !/null|undefined/.test(message),
      `${state} invented copy from no version: ${message}`,
    );
  }
});

test("titlebar update: nothing shows before an update check succeeds", () => {
  reset();
  const { dispose, btn, badge } = mount();
  try {
    assert.equal(badge.hidden, true, "a dot appeared with no update available");
    assert.equal(btn.getAttribute("aria-label"), "Open Syncord settings");
    assert.match(T.__tooltipText(), /Open Syncord settings/);
  } finally {
    dispose();
    restoreWorld();
  }
});

test("titlebar update: a completed check shows a checkmark and labels the installed version", () => {
  reset();
  T.setState({ ...IDLE, phase: "up-to-date", latest: "1.3.0" });
  const { dispose, btn, badge } = mount();
  try {
    assert.equal(badge.hidden, false);
    assert.equal(badge.dataset.dionState, "current");
    assert.match(btn.getAttribute("aria-label"), /Syncord 1\.4\.0 is up to date/);
    assert.match(T.__tooltipText(), /Syncord 1\.4\.0 is up to date/);
    const checkmark = badge.querySelector("path").getAttribute("d");
    btn.dispatch("click");
    assert.equal(badge.hidden, false, "opening settings must preserve the current status");
    T.setState(OFFER);
    assert.equal(badge.dataset.dionState, "offered");
    assert.notEqual(badge.querySelector("path").getAttribute("d"), checkmark);
    assert.match(T.__tooltipText(), /1\.5\.0 is available/);
    T.setState({ ...IDLE, phase: "error" });
    assert.equal(badge.hidden, true, "a failed check must not keep a success checkmark");
  } finally {
    dispose();
    restoreWorld();
  }
});

test("titlebar update: a newer signed release shows an icon and identifies the release", () => {
  reset();
  T.setState(OFFER);
  const { dispose, btn, badge } = mount();
  try {
    assert.equal(badge.hidden, false, "the dot did not appear for a real offer");
    assert.equal(badge.dataset.dionState, "offered");
    assert.match(T.__tooltipText(), /1\.5\.0/, "the tooltip does not say which version");
    // The badge is decorative; the label is what a screen reader reads.
    assert.match(btn.getAttribute("aria-label"), /1\.5\.0/);
    assert.equal(badge.getAttribute("aria-hidden"), "true");
    const icon = badge.querySelector("svg");
    assert.ok(icon, "the update indicator must contain an icon");
    assert.equal(icon.getAttribute("viewBox"), "0 0 24 24");
    assert.equal(icon.getAttribute("focusable"), "false");
  } finally {
    dispose();
    restoreWorld();
  }
});

test("titlebar update: a release found before the titlebar mounted still shows", () => {
  // The first status change is twenty seconds away, and the next check is six
  // hours away. A titlebar that mounted into an already-known offer and did not
  // draw it would look exactly like an updater that had never found anything.
  reset();
  T.setState(OFFER);
  const { dispose, badge } = mount();
  try {
    assert.equal(badge.hidden, false);
  } finally {
    dispose();
    restoreWorld();
  }
});

test("titlebar update: a status change repaints the icon", () => {
  reset();
  const { dispose, btn, badge } = mount();
  try {
    assert.equal(badge.hidden, true);

    T.setState(OFFER);
    assert.equal(badge.hidden, false, "the dot ignored a status change");
    assert.match(btn.getAttribute("aria-label"), /1\.5\.0/);

    T.setState({ ...OFFER, phase: "ready" });
    assert.equal(badge.dataset.dionState, "ready");

    T.setState({ ...OFFER, phase: "up-to-date", latest: "1.4.0" });
    assert.equal(badge.hidden, false, "the completed check must show its current status");
    assert.equal(badge.dataset.dionState, "current");
    assert.match(T.__tooltipText(), /1\.4\.0 is up to date/);
  } finally {
    dispose();
    restoreWorld();
  }
});

test("titlebar update: opening settings preserves the update icon", () => {
  reset();
  T.setState(OFFER);
  const { dispose, btn, badge } = mount();
  try {
    btn.dispatch("click");

    assert.deepEqual(T.opened, [true], "the click did not open the settings panel");
    assert.equal(
      T.stored.get(T.LAST_SEEN_KEY),
      undefined,
      "opening settings must not acknowledge the update",
    );
    assert.equal(badge.hidden, false, "opening settings hid an available update");

    // Ignored is not installed. The offer itself is untouched, so the panel still
    // offers the download and nothing was installed without asking.
    assert.equal(T.state.phase, "available", "the click changed the update phase");
    T.setState(OFFER);
    assert.equal(badge.hidden, false, "the update icon disappeared on a later status event");
  } finally {
    dispose();
    restoreWorld();
  }
});

test("titlebar update: a restart still owed is not silenced by a click", () => {
  reset();
  T.setState({ ...OFFER, phase: "handed-off", stagedVersion: "1.5.0" });
  const { dispose, btn, badge } = mount();
  try {
    assert.equal(badge.dataset.dionState, "restart");

    btn.dispatch("click");

    assert.deepEqual(T.opened, [true]);
    assert.equal(
      T.stored.get(T.LAST_SEEN_KEY),
      undefined,
      "a restart was marked seen by being looked at, which is not the same act",
    );
    assert.equal(badge.hidden, false, "the restart reminder was cleared by a click");
  } finally {
    dispose();
    restoreWorld();
  }
});

test("titlebar update: a failed check does not light up the titlebar", () => {
  // `error` covers a failed check and a failed install with the same phase, so a
  // dot built on it cannot say which, and a user cannot clear one they do not
  // understand. The panel's status line is where the reason belongs.
  reset();
  T.setState({ ...IDLE, phase: "error", latest: "1.5.0", lastError: "the feed was unreachable" });
  const { dispose, badge } = mount();
  try {
    assert.equal(badge.hidden, true);
  } finally {
    dispose();
    restoreWorld();
  }
});

test("titlebar update: teardown drops the subscription and the nodes", () => {
  reset();
  const before = T.listenerCount();
  const { dispose, btn, badge } = mount();
  assert.equal(T.listenerCount(), before + 1, "mounting subscribed to update status");

  dispose();

  assert.equal(T.listenerCount(), before, "the status subscription outlived the button");
  assert.equal(btn.removed, true, "the button was left in the document");
  // The badge is a child of the button, so it goes with it rather than being
  // removed in its own right. What has to hold is that nothing is reachable from
  // the document any more -- asserting `badge.removed` would be asserting on an
  // implementation detail that was never the point.
  assert.equal(
    globalThis.document.querySelectorAll("[data-dion-titlebar-update]").length,
    0,
    "a badge is still reachable from the document after teardown",
  );

  // A status change after teardown must not throw against a detached node, which
  // is the failure this guards: the observer and the subscription used to be torn
  // down independently.
  T.setState(OFFER);
  restoreWorld();
});


test("titlebar update: an offer previously marked seen still shows its icon", () => {
  reset();
  T.stored.set(T.LAST_SEEN_KEY, "1.5.0");
  T.setState(OFFER);
  const { dispose, badge } = mount();
  try {
    assert.equal(badge.hidden, false);
  } finally {
    dispose();
    restoreWorld();
  }
});
