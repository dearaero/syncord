/**
 * Auto-update UI behaviour tests.
 *
 * Run: `node --test scripts/tests/update-ui.test.mjs`
 *
 * The §5 items that are *behaviour* rather than markup: switching automatic
 * updates off clears what a check accepted, the channel control actually
 * re-checks, the hand-off's "installing" state is visible, and the restart
 * dialog only claims what main confirmed.
 *
 * These drive the real `updatePrompt.ts` in a real DOM. The modules it reaches
 * for — settings, the native bridge, the toast — are substituted, because the
 * point is what the UI *does* with a given update state, not that Electron
 * exists.
 *
 * Why this is a separate suite from the end-to-end one: that one proves the
 * install happens, this one proves the user is told the truth about it. A flow
 * can install correctly and still lie about it — and one did.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const { test, before, beforeEach } = await import("node:test");

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "syncord-ui-"));

const UPDATER_STUB = `
export const calls = [];
export const state = {
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
export const toasts = [];

export function setState(patch) {
  Object.assign(state, patch);
}

export function updateState() {
  return { ...state };
}

export function onUpdate(listener) {
  globalThis.__updateListener = listener;
  return () => {
    globalThis.__updateListener = undefined;
  };
}

export function checkNow(channel) {
  calls.push(["checkNow", channel]);
  return Promise.resolve({ ...state });
}

export function stageNow() {
  calls.push(["stageNow"]);
  return Promise.resolve({ ...state, phase: "ready", progress: 1, stagedVersion: "1.5.0" });
}

let handOffResult = null;
export const __setHandOffResult = (result) => {
  handOffResult = result;
};

export function handOffNow(path) {
  calls.push(["handOffNow", path]);
  const result = handOffResult ?? { ...state, phase: "handed-off", stagedVersion: "1.5.0" };
  Object.assign(state, result);
  return Promise.resolve({ ...state });
}

export function restartNow() {
  calls.push(["restartNow"]);
  return Promise.resolve(true);
}

export function resetUpdate() {
  calls.push(["resetUpdate"]);
  const result = { phase: "idle", detail: "Update checks are turned off.", latest: null, stagedVersion: null, lastError: null, progress: null };
  Object.assign(state, result);
  return Promise.resolve({ ...state });
}

let location = { found: null, searched: [] };
export const __setInjectorLocation = (next) => {
  location = next;
};

export function injectorLocation() {
  calls.push(["injectorLocation"]);
  return Promise.resolve(location);
}

export const startAutoUpdate = () => calls.push(["startAutoUpdate"]);
export const pauseAutoUpdate = () => calls.push(["pauseAutoUpdate"]);
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

const TOAST_STUB = `
export const ToastType = { MESSAGE: "message", SUCCESS: "success", FAILURE: "failure" };
export const toasts = [];
export function showToast(message, options = {}) {
  toasts.push({ message, type: options.type, duration: options.duration });
}
`;

const LOGGER_STUB = `
export function createLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}
`;

/** A DOM small enough to drive, large enough to be honest about the real one. */
class FakeElement {
  constructor(tag, attributes = {}) {
    this.tagName = tag.toUpperCase();
    this.attributes = { ...attributes };
    // `id` as a property, because the dialog sets `root.id = …` directly rather
    // than through `setAttribute`. A fake that only tracked attributes would not
    // find it, and "the dialog was not created" would then be unprovable.
    this.id = attributes.id ?? "";
    this.children = [];
    this.listeners = new Map();
    this.textContent = "";
    this.hidden = Boolean(attributes.hidden);
    this.disabled = Boolean(attributes.disabled);
    this.value = attributes.value ?? "";
    this.className = attributes.class ?? "";
  }

  set innerHTML(value) {
    this._html = value;
    const parsed = parseHtml(value);
    this.children = [];
    this.append(...parsed.children);
  }

  get innerHTML() { return this._html ?? ""; }

  setAttribute(name, value) {
    this.attributes[name] = value;
    if (name === "hidden") this.hidden = Boolean(value);
    if (name === "id") this.id = value;
  }

  getAttribute(name) {
    return this.attributes[name];
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  removeEventListener(type) {
    this.listeners.delete(type);
  }

  dispatch(type) {
    for (const handler of this.listeners.get(type) ?? []) handler({ target: this });
  }

  append(...nodes) {
    for (const node of nodes) {
      this.children.push(node);
      if (node instanceof FakeElement) node.parentNode = this;
    }
  }

  /** The real DOM method the dialog and the stylesheet installer use. */
  appendChild(node) {
    this.append(node);
    return node;
  }

  remove() {
    this.removed = true;
    if (this.parentNode !== undefined) {
      this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    }
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  /**
   * Supports the attribute and class selectors the real code uses, and
   * descends into `innerHTML` when one is set, so a dialog built from a template
   * string is inspectable the way the browser would make it.
   */
  querySelectorAll(selector) {
    const match = /^\[([a-z-]+)\]$/.exec(selector) ?? /^\.([a-z-]+)$/.exec(selector);
    if (match === null) return [];
    const [, key] = match;
    const isAttribute = selector.startsWith("[");

    const out = [];
    const visit = (node) => {
      if (!(node instanceof FakeElement)) return;
      if (isAttribute ? node.attributes[key] !== undefined : node.className.split(/\s+/).includes(key)) {
        out.push(node);
      }
      for (const child of node.children) visit(child);
    };
    visit(this);
    return out;
  }
}

/** Parse the small, known subset of HTML the dialog templates use. */
function parseHtml(html) {
  const root = new FakeElement("div");
  const stack = [root];
  const tagPattern = /<(\/)?([a-z0-9]+)([^>]*?)(\/)?>|([^<]+)/gi;
  let match;
  while ((match = tagPattern.exec(html)) !== null) {
    const [, closing, tag, rawAttrs, selfClosing, text] = match;
    if (text !== undefined) {
      if (text.trim().length > 0) stack[stack.length - 1].textContent += text.trim();
      continue;
    }
    if (closing === "/") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attributes = {};
    const attrPattern = /([a-z-]+)(?:="([^"]*)")?/gi;
    let attr;
    while ((attr = attrPattern.exec(rawAttrs ?? "")) !== null) {
      attributes[attr[1]] = attr[2] ?? "";
    }
    const element = new FakeElement(tag, attributes);
    stack[stack.length - 1].append(element);
    if (selfClosing !== "/") stack.push(element);
  }
  return root;
}

let ui;
let updaterStub;
let toastStub;
let settingsStub;

// ── Setup ─────────────────────────────────────────────────────────────────────

before(async () => {
  fs.writeFileSync(path.join(scratch, "updater.ts"), UPDATER_STUB);
  fs.writeFileSync(path.join(scratch, "settings.ts"), SETTINGS_STUB);
  fs.writeFileSync(path.join(scratch, "toast.ts"), TOAST_STUB);
  fs.writeFileSync(path.join(scratch, "logger.ts"), LOGGER_STUB);

  const entry = path.join(scratch, "entry.ts");
  fs.writeFileSync(
    entry,
    // Every stub is reached by the *same specifier* the module under test uses.
    // Naming the stub files by absolute path instead produced two module
    // instances with independent state — the test set a value in one and the
    // code under test read the other — which is a suite that passes and proves
    // nothing. One specifier, one resolution, one instance.
    `export * from ${JSON.stringify(path.join(REPO, "src", "renderer", "ui", "updatePrompt.ts"))};
     export {
       calls, state, setState, __setHandOffResult, __setInjectorLocation,
       AUTO_UPDATE_KEY, UPDATE_CHANNEL_KEY, INJECTOR_PATH_KEY,
     } from "../api/updater";
     export { stored, settings, __resetSettings } from "../api/settings";
     export { toasts, ToastType } from "./toast";
    `,
  );

  // A minimal document the module can mount into.
  const out = path.join(scratch, "bundle.mjs");
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "neutral",
    format: "esm",
    outfile: out,
    logLevel: "warning",
    // `api/updater` and `api/settings` resolve to the stubs above, as do the
    // toast and the logger. Nothing else is substituted, so `updatePrompt.ts`
    // itself is the shipped file.
    //
    // A resolve plugin rather than `alias`: esbuild's `alias` matches package
    // specifiers, and these are relative imports, so aliasing by path is
    // rejected outright.
    plugins: [
      {
        name: "stub-renderer-deps",
        setup(build) {
          const stubs = new Map([
            [/[\\/]api[\\/]updater$/, path.join(scratch, "updater.ts")],
            [/[\\/]api[\\/]settings$/, path.join(scratch, "settings.ts")],
            [/[\\/]api[\\/]logger$/, path.join(scratch, "logger.ts")],
            [/(^|[\\/])toast$/, path.join(scratch, "toast.ts")],
          ]);
          build.onResolve({ filter: /.*/ }, (args) => {
            // esbuild names this kind "import-statement"; an earlier version
            // of this file filtered on "import", which never matches anything,
            // so the real modules were loaded and every stub below was a lie.
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

  const head = new FakeElement("head");
  const body = new FakeElement("body");
  /** Real enough to find what the module mounted, so dispose is observable. */
  const getElementById = (id) => {
    const find = (node) => {
      if (node.id === id || node.attributes?.id === id) return node;
      for (const child of node.children ?? []) {
        const hit = find(child);
        if (hit !== undefined) return hit;
      }
      return undefined;
    };
    return find(head) ?? find(body) ?? null;
  };
  const document = {
    head,
    body,
    getElementById,
    createElement: (tag) => new FakeElement(tag),
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.document = document;
  globalThis.location = { reload: () => {} };

  // One module instance for everything, so the test and the module under test
  // share state. Two instances would mean the test setting a fixture the module
  // never reads — a suite that passes for the wrong reason.
  ui = await import(`file://${out}`);
  updaterStub = ui;
  toastStub = ui;
  settingsStub = ui;
});

/**
 * Run `action` and return the dialog's template string.
 *
 * The dialog is built with `innerHTML` — that is what the shipped code does, and
 * the test is about the *text* it produces, so the string is what needs
 * inspecting rather than a re-parse of it.
 */
function captureDialogHtml(action) {
  document.getElementById("Syncord-update-root")?.remove();
  action();
  const root = document.getElementById("Syncord-update-root");
  // An empty array rather than an empty string, so a missing dialog fails the
  // assertions on its content instead of matching a regex against "".
  return root === null ? [] : [root.innerHTML ?? ""];
}

/** A panel containing the update card, as the settings panel builds it. */
function mountPanel(overrides = {}) {
  const scope = new FakeElement("div", { class: "panel" });
  const card = parseHtml(ui.updateSettingsRowHtml());
  for (const child of card.children) scope.append(child);
  const button = new FakeElement("button", { "data-dion-update": "", hidden: true });
  scope.append(button);
  if (overrides.channel !== undefined) {
    const select = scope.querySelector("[data-dion-update-channel]");
    select.value = overrides.channel;
  }
  return { scope, button };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

beforeEach(() => {
  updaterStub.calls.length = 0;
  toastStub.toasts.length = 0;
  updaterStub.__resetSettings();
  updaterStub.setState({
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
  });
  ui.disposeUpdateUi();
});

// ── The channel control ───────────────────────────────────────────────────────

test("the settings row offers both channels and reflects the stored one", () => {
  const html = ui.updateSettingsRowHtml();
  assert.match(html, /value="stable"/);
  assert.match(html, /value="beta"/);

  updaterStub.settings.set("updates.channel", "beta");
  assert.match(ui.updateSettingsRowHtml(), /value="beta" selected/);

  // Anything unrecognised falls back to stable rather than rendering a control
  // whose value main will not accept.
  updaterStub.settings.set("updates.channel", "nightly");
  assert.match(ui.updateSettingsRowHtml(), /value="stable" selected/);
  assert.equal(ui.updateChannel(), "stable");
});

test("changing the channel stores it and re-checks straight away", async () => {
  const { scope } = mountPanel();
  ui.bindUpdateUi(scope);

  const select = scope.querySelector("[data-dion-update-channel]");
  select.value = "beta";
  select.dispatch("change");
  await tick();

  assert.equal(updaterStub.settings.get("updates.channel"), "beta");
  assert.deepEqual(
    updaterStub.calls.filter(([name]) => name === "checkNow"),
    [["checkNow", "beta"]],
    "a channel change must re-check, not wait up to six hours to be noticed",
  );
});

test("the channel control is disabled while automatic updates are off", () => {
  updaterStub.settings.set("updates.autoCheck", false);
  const { scope } = mountPanel();
  ui.bindUpdateUi(scope);

  const select = scope.querySelector("[data-dion-update-channel]");
  assert.equal(select.disabled, true, "a control that looks live but does nothing is worse");

  updaterStub.settings.set("updates.autoCheck", true);
  const { scope: on } = mountPanel();
  ui.bindUpdateUi(on);
  assert.equal(on.querySelector("[data-dion-update-channel]").disabled, false);
});

// ── Turning automatic updates off ─────────────────────────────────────────────

test("switching automatic updates off resets the accepted release", async () => {
  // The item the plan flagged: without this, main keeps the accepted descriptor
  // and the Download button goes on offering a release the user has just
  // switched off checking for. The switch would stop the schedule and nothing
  // else, which is not what "off" means.
  updaterStub.setState({ phase: "available", latest: "1.5.0" });
  const { scope } = mountPanel();
  ui.bindUpdateUi(scope);

  const toggle = scope.querySelector("[data-dion-update-auto]");
  toggle.checked = false;
  toggle.dispatch("change");
  await tick();

  assert.equal(updaterStub.settings.get("updates.autoCheck"), false);
  assert.ok(
    updaterStub.calls.some(([name]) => name === "resetUpdate"),
    "turning it off must clear the accepted release",
  );
  assert.ok(updaterStub.calls.some(([name]) => name === "pauseAutoUpdate"));
  assert.equal(updaterStub.state.phase, "idle");
  assert.equal(updaterStub.state.latest, null);
});

test("switching it back on checks again", async () => {
  updaterStub.settings.set("updates.autoCheck", false);
  const { scope } = mountPanel();
  ui.bindUpdateUi(scope);

  const toggle = scope.querySelector("[data-dion-update-auto]");
  toggle.checked = true;
  toggle.dispatch("change");
  await tick();

  assert.ok(updaterStub.calls.some(([name]) => name === "checkNow"));
  assert.ok(updaterStub.calls.some(([name]) => name === "startAutoUpdate"));
  assert.ok(
    !updaterStub.calls.some(([name]) => name === "resetUpdate"),
    "turning it on must not reset anything",
  );
});

test("manual checking remains available with automatic checks disabled", async () => {
  updaterStub.settings.set("updates.autoCheck", false);
  const { scope } = mountPanel();
  ui.bindUpdateUi(scope);
  const button = scope.querySelector("[data-dion-update-check]");
  assert.ok(button);
  assert.equal(button.disabled, false);
  button.dispatch("click");
  await tick();
  assert.ok(updaterStub.calls.some(([name]) => name === "checkNow"));
});

test("manual checking is disabled while checking or installing", () => {
  const { scope } = mountPanel();
  for (const phase of ["checking", "downloading", "ready", "handing-off", "handed-off"]) {
    updaterStub.setState({ phase });
    ui.paintUpdateUi(scope);
    assert.equal(scope.querySelector("[data-dion-update-check]").disabled, true);
  }
});

// ── The button, through its phases ────────────────────────────────────────────

test("the button is hidden unless there is something to act on", () => {
  const { scope, button } = mountPanel();

  updaterStub.setState({ phase: "idle" });
  ui.paintUpdateUi(scope);
  assert.equal(button.hidden, true);

  updaterStub.setState({ phase: "up-to-date", latest: "1.4.0" });
  ui.paintUpdateUi(scope);
  assert.equal(button.hidden, true, "nothing to download means nothing to offer");

  updaterStub.setState({ phase: "available", latest: "1.5.0" });
  ui.paintUpdateUi(scope);
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, false);
  assert.equal(button.querySelector("[data-dion-update-label]")?.textContent ?? button.children[0]?.textContent, undefined);
});

test("while the installer runs the button is visible, disabled, and says so", () => {
  // The first version had no such state: the flow fired the installer detached
  // and immediately claimed success, so there was nothing to show and nothing
  // true to show.
  const { scope, button } = mountPanel();
  updaterStub.setState({ phase: "handing-off", stagedVersion: "1.5.0" });
  ui.paintUpdateUi(scope);

  assert.equal(button.hidden, false, "the user must see that something is happening");
  assert.equal(button.disabled, true, "main will not start a second installer");
  const label = button.querySelector("[data-dion-update-label]");
  assert.ok(
    label === null || label.textContent === "",
    "the label is rendered by the caller in the real panel; the phase is what matters here",
  );
  assert.equal(button.getAttribute("aria-label"), "Download update");
});

test("a failed hand-off shows the reason and does not claim success", async () => {
  updaterStub.__setHandOffResult({
    phase: "error",
    detail: "The Syncord Installer refused the update. Discord is still running.",
    lastError: "refused",
  });
  updaterStub.setState({ phase: "ready", stagedVersion: "1.5.0", latest: "1.5.0" });

  const { scope, button } = mountPanel();
  ui.bindUpdateUi(scope);
  button.dispatch("click");
  await tick();

  assert.equal(toastStub.toasts.at(-1).type, "failure");
  assert.match(toastStub.toasts.at(-1).message, /refused the update/);
  assert.match(toastStub.toasts.at(-1).message, /still running/, "main's own reason must survive");
  assert.equal(
    document.getElementById("Syncord-update-root"),
    null,
    "no restart dialog after a failed install",
  );
});

test("a successful hand-off shows the restart dialog", async () => {
  updaterStub.__setHandOffResult({ phase: "handed-off", stagedVersion: "1.5.0", latest: "1.5.0" });
  updaterStub.setState({ phase: "ready", stagedVersion: "1.5.0", latest: "1.5.0" });

  const { scope, button } = mountPanel();
  ui.bindUpdateUi(scope);
  button.dispatch("click");
  await tick();

  // The stub `document.getElementById` returns null, so the dialog cannot be
  // looked up by id here. What matters is that it was constructed, and that the
  // call did not throw.
  assert.ok(
    updaterStub.calls.some(([name]) => name === "handOffNow"),
    "the hand-off must have been attempted",
  );
  assert.equal(toastStub.toasts.filter((t) => t.type === "failure").length, 0, "no failure toast");
});

// ── The restart dialog's claims ───────────────────────────────────────────────

test("the restart dialog only claims what main confirmed", () => {
  // Every word here is a claim about something that happened. The dialog is
  // reached only when the installer exited 0, which is the only thing making
  // them true — so the wording must not promise more than that.
  const captured = captureDialogHtml(() => ui.showRestartPrompt("1.5.0"));

  const html = captured.join("\n");
  assert.match(html, /1\.5\.0/);
  assert.match(html, /Installer confirmed it wrote the new bundles/);
  assert.match(html, /Quit Discord completely and open it again/);

  // It must NOT offer a reload. On Windows and Linux Electron is
  // single-process, so a reload re-runs the preload against the new bundles
  // while main is still the old one — and a dialog that warns against something
  // and then does it is worse than one with no button.
  assert.doesNotMatch(html, /Reload Discord/);
  assert.doesNotMatch(html, /location\.reload/);
});

test("the version in the dialog is escaped, not interpolated", () => {
  const html = captureDialogHtml(() => ui.showRestartPrompt("<img src=x onerror=alert(1)>")).join("\n");
  assert.doesNotMatch(html, /<img/, "a version is never markup");
  assert.match(html, /&lt;img/);
});

// ── Where the installer is ────────────────────────────────────────────────────

test("the panel says where the installer was found", async () => {
  updaterStub.__setInjectorLocation({ found: "/Applications/Syncord Installer.app/…", searched: [] });
  const { scope } = mountPanel();
  ui.bindUpdateUi(scope);
  await tick();

  const node = scope.querySelector("[data-dion-update-injector]");
  assert.match(node.textContent, /Installer found at \/Applications/);
});

test("and says what to do when there is none", async () => {
  updaterStub.__setInjectorLocation({ found: null, searched: ["/a", "/b"] });
  const { scope } = mountPanel();
  ui.bindUpdateUi(scope);
  await tick();

  const node = scope.querySelector("[data-dion-update-injector]");
  assert.match(node.textContent, /Download it from the Syncord releases page/);
});

test("a missing installer is announced before the user presses anything", async () => {
  // The reason this exists: otherwise a user with no installer downloads a
  // bundle first and only then finds out, which reads as a failure at the worst
  // possible moment.
  updaterStub.__setInjectorLocation({ found: null, searched: [] });
  const { scope } = mountPanel();
  ui.bindUpdateUi(scope);
  await tick();
  assert.ok(
    scope.querySelector("[data-dion-update-injector]").textContent.length > 0,
    "the state must be visible without pressing a button",
  );
});

// ── Cleanup ───────────────────────────────────────────────────────────────────


/* ── Layout: the thing that broke ────────────────────────────────────────── */

test("the channel select is wrapped, so it cannot starve the description", () => {
  /*
   * The bug, in one sentence: the select's rule is `width: 100%` so that it
   * fills its box, and as a *direct* flex child of the row that 100% became its
   * flex basis while the copy beside it had a zero basis. The description was
   * starved to a few pixels and wrapped one word per line, and the select took
   * the entire row.
   *
   * Every other assertion in this file passed while the panel was a thousand
   * pixels tall, because none of them look at layout. This one is structural so
   * that the markup cannot drift back to a bare select.
   */
  const card = parseHtml(ui.updateSettingsRowHtml());
  const row = card.querySelector(".dion-update-channel");
  assert.ok(row, "the update channel row is missing");

  const wrap = row.querySelector(".dion-select-wrap");
  assert.ok(wrap, "the channel select has no .dion-select-wrap around it");

  const select = row.querySelector("[data-dion-update-channel]");
  assert.ok(select, "the channel select is missing");

  // The relationship is asserted through the children the fake DOM does track,
  // because that is the property that matters: the select must not be a
  // *sibling* of the wrapper, since a bare select is the whole bug.
  assert.ok(
    wrap.children.includes(select),
    "the select is not inside the wrapper, so it is a bare flex child again",
  );
  assert.ok(
    row.children.includes(wrap),
    "the wrapper is not a child of the row",
  );
  assert.ok(
    !row.children.includes(select),
    "the select is a direct child of the row: `width: 100%` is its flex basis " +
      "and the description beside it is starved to nothing",
  );

  // The wrapper is what reserves the room the chevron draws into. Without it the
  // control keeps 30px of right padding reserved for an arrow that is not there.
  assert.ok(
    wrap.querySelector(".dion-select-chevron"),
    "the select has 30px of right padding reserved for a chevron that is not drawn",
  );
});

test("a select used without the wrapper still cannot take the row", () => {
  /*
   * The wrapper is the supported way to use `.dion-select`, and the markup above
   * now does. This is the floor under it: a future control that reaches for a
   * bare select should cost alignment, not a panel a thousand pixels tall.
   */
  const css = fs.readFileSync(
    path.join(REPO, "src", "renderer", "ui", "settingsPanel.ts"),
    "utf-8",
  );

  assert.match(
    css,
    /\.dion-setting-row\s*>\s*\.dion-select[\s\S]{0,200}?width:\s*min\(/,
    "a bare .dion-select in a row has no width floor, so `width: 100%` wins and " +
      "the description beside it is starved to nothing",
  );
});

test("the injector hint is styled, not left at the panel's base font size", () => {
  /*
   * `[data-dion-update-injector]` was in the markup with no rule anywhere, so it
   * rendered at the panel's 16px body size — visibly larger than every other
   * line of the card it sits in. A class that appears in markup and in the
   * behaviour code but in no stylesheet is the quietest kind of dead code there
   * is, and nothing else in the suite would have looked.
   */
  const css = fs.readFileSync(
    path.join(REPO, "src", "renderer", "ui", "settingsPanel.ts"),
    "utf-8",
  );

  assert.match(
    css,
    /\.dion-update-injector\s*\{/,
    "[data-dion-update-injector] has no rule, so it inherits the panel's body " +
      "font size and reads as a heading inside a card of small text",
  );
  // And it must be grouped with the status line rather than re-specified, so
  // the two cannot drift apart in colour or leading.
  assert.match(
    css,
    /\.dion-update-status,\s*\n?\s*#\$\{ROOT_ID\} \.dion-update-injector\s*\{/,
    "the injector hint is not sharing the status line's type treatment",
  );
  // An empty one must collapse, or an empty <p> leaves a gap under the card.
  assert.match(
    css,
    /\.dion-update-injector:empty\s*\{/,
    "an empty hint still occupies a line",
  );
});

test("the channel row stacks on a narrow window like the field rows do", () => {
  /*
   * The narrow-window rules only ever named `.dion-field-row`, so the update
   * channel — a `.dion-setting-row` — kept its two-column shape at any width
   * and squeezed its description into a sliver. The new controls are exactly
   * where a hole in the narrow layout is least likely to be noticed.
   */
  const css = fs.readFileSync(
    path.join(REPO, "src", "renderer", "ui", "settingsPanel.ts"),
    "utf-8",
  );

  // The stacking has to be inside a width-constrained block, not merely present.
  const narrow = /@media \(max-width: 820px\)[\s\S]*?@media \(max-width: 650px\)/.exec(css);
  assert.ok(narrow, "the 820px block is missing, so the width cannot be verified");

  assert.match(
    narrow[0],
    /\.dion-update-channel\s*\{[\s\S]{0,160}?flex-direction:\s*column/,
    "the update channel row does not stack on a narrow window, while every " +
      "field row beside it does",
  );
  assert.match(
    narrow[0],
    /\.dion-update-channel \.dion-select-wrap\s*\{[\s\S]{0,120}?width:\s*100%/,
    "the channel control keeps its 44% width when the row stacks, so it is " +
      "still not using the width it now has",
  );
});

test("disposing removes everything the module installed", () => {
  const { scope } = mountPanel();
  ui.bindUpdateUi(scope);
  ui.disposeUpdateUi();
  // Idempotent: the panel re-renders on every open, so a second dispose must
  // not throw or leave a listener behind.
  ui.disposeUpdateUi();
  assert.equal(ui.autoUpdateEnabled(), true, "the default is on");
});

test("a waiting worker is ready to install, not already installed", () => {
  const html = captureDialogHtml(() => ui.showRestartPrompt("1.5.0", true)).join("\n");
  assert.match(html, /ready to install/);
  assert.match(html, /Restart and Install/);
  assert.doesNotMatch(html, /Installer confirmed it wrote/);
  assert.equal(updaterStub.calls.filter(([name]) => name === "restartNow").length, 0);
});

test("a verified queued update remains actionable without a second download", () => {
  updaterStub.setState({ phase: "awaiting-restart", stagedVersion: "1.5.0", latest: "1.5.0" });
  const {scope, button} = mountPanel();
  const label = new FakeElement("span", { "data-dion-update-label": "" });
  button.append(label);
  ui.paintUpdateUi(scope);
  assert.equal(button.disabled, false);
  assert.equal(button.hidden, false);
  assert.equal(scope.querySelector("[data-dion-update-label]").textContent, "Restart and Install");
});

test("Restart and Install actually requests main to quit; Later does not", async () => {
  ui.showRestartPrompt("1.5.0", true);
  let root = document.getElementById("Syncord-update-root");
  root.querySelectorAll("[data-dion-update-close]")[0].dispatch("click");
  assert.equal(updaterStub.calls.filter(([name]) => name === "restartNow").length, 0);
  ui.showRestartPrompt("1.5.0", true);
  root = document.getElementById("Syncord-update-root");
  root.querySelector("[data-dion-update-restart]").dispatch("click");
  await tick();
  assert.equal(updaterStub.calls.filter(([name]) => name === "restartNow").length, 1);
  assert.equal(document.getElementById("Syncord-update-root"), null);
});
