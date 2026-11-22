/**
 * The contract across the Tauri boundary.
 *
 * Run: `node injector/tests/frontend/state_contract.mjs`
 *
 * `app.js` and `state.rs` agree on two things that no unit test can check:
 *
 *   1. the **command names** — `invoke("inject_into", …)` must match
 *      `#[tauri::command] pub async fn inject_into` and the `generate_handler!` list.
 *      A typo here produces a window that renders perfectly and does nothing,
 *      and neither side's own tests would notice, because each is correct about
 *      itself.
 *   2. the **field names** — `row.injected` must survive serde's
 *      `rename_all = "camelCase"` and arrive under the same name.
 *
 * Both sides are read as text rather than imported, because that is the only way
 * to catch the case where one is changed and the other is not. Importing them
 * would test that both agree with themselves.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INJECTOR_ROOT = path.resolve(HERE, "..", "..");

const stateRs = await readFile(path.join(INJECTOR_ROOT, "src-tauri", "src", "state.rs"), "utf-8");
const appJs = await readFile(path.join(INJECTOR_ROOT, "src-tauri", "ui", "app.js"), "utf-8");
const mainRs = await readFile(path.join(INJECTOR_ROOT, "src-tauri", "src", "main.rs"), "utf-8");

const results = [];
const check = (name, condition, detail = "") => {
  results.push({ name, ok: Boolean(condition), detail });
};

// ── 1. Command names ──────────────────────────────────────────────────────────

/** Commands the frontend invokes, in source order. */
const invoked = [...appJs.matchAll(/\binvoke\(\s*"([a-z_]+)"/g)].map((m) => m[1]);

/** Commands registered with Tauri. */
const registeredBlock = /generate_handler!\[([\s\S]*?)\]/.exec(mainRs);
const registered = registeredBlock
  ? [...registeredBlock[1].matchAll(/state::([a-z_]+)/g)].map((m) => m[1])
  : [];

/** Commands actually declared as `#[tauri::command]`. */
const declared = [...stateRs.matchAll(/#\[tauri::command\]\s*\npub (?:async )?fn ([a-z_]+)/g)].map((m) => m[1]);

check("the frontend invokes at least one command", invoked.length > 0, invoked.join(", "));
check("the frontend invokes no unknown command", invoked.every((name) => registered.includes(name)),
  `invoked: ${invoked.join(", ")} / registered: ${registered.join(", ")}`);

for (const name of registered) {
  check(`registered command ${name} is declared with #[tauri::command]`, declared.includes(name));
}
for (const name of invoked) {
  check(`invoked command ${name} is registered`, registered.includes(name));
}
// ── 2. No command accepts a path ──────────────────────────────────────────────

// Installation commands still grant no filesystem/process/network capability.
// Asserted here as well as in review, because it is a one-line regression away.
const commandParams = [...stateRs.matchAll(/#\[tauri::command\][\s\S]*?pub (?:async )?fn [a-z_]+\(([\s\S]*?)\)\s*->\s*(\w+)/g)];
check("commands are found to inspect", commandParams.length > 0, `${commandParams.length} commands`);

for (const match of commandParams) {
  const [, params, ] = match;
  const name = /pub (?:async )?fn ([a-z_]+)/.exec(/pub (?:async )?fn [a-z_]+\([\s\S]*?\)\s*->\s*\w+/.exec(match[0])[0])[1];
  check(
    `${name} takes no filesystem path`,
    !/\b(path|dir|file|p|target|dest|destination)\s*:\s*(String|PathBuf|&\s*(str|Path))/i.test(params),
    `params: ${params.replace(/\s+/g, " ").trim()}`,
  );
  check(
    `${name} takes no ` + "`tauri::Window`" + ` or file handle`,
    !/tauri::Window|std::fs|File\b/.test(params),
  );
}

// ── 3. Field names survive serialisation ──────────────────────────────────────

/** Structs the frontend reads from, and the fields it accesses. */
const rowFields = [...new Set([...appJs.matchAll(/\brow\.([a-zA-Z]+)/g)].map((m) => m[1]))].sort();

const installRowBlock = /pub struct InstallRow \{([\s\S]*?)\n\}/.exec(stateRs);
const declaredRowFields = installRowBlock
  ? [...installRowBlock[1].matchAll(/pub ([a-z_]+):/g)].map((m) => m[1])
  : [];
// serde's `rename_all = "camelCase"` maps `fingerprint` to itself and
// `payload_version` to `payloadVersion`; the frontend must use the latter form.
const camel = (name) => name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

check("InstallRow was found", declaredRowFields.length > 0, declaredRowFields.join(", "));
for (const field of rowFields) {
  check(
    `row.${field} is a real field of InstallRow`,
    declaredRowFields.map(camel).includes(field),
    `declared: ${declaredRowFields.map(camel).join(", ")}`,
  );
}
check("InstallRow is serialised camelCase, which is what the frontend assumes",
  /#\[serde\(rename_all = "camelCase"\)\]/.test(stateRs));

// `ActionResult` fields the frontend reads.
const actionFields = [...new Set([...appJs.matchAll(/result\.([a-zA-Z]+)/g)].map((m) => m[1]))].sort();
const actionBlock = /pub struct ActionResult \{([\s\S]*?)\n\}/.exec(stateRs);
const declaredActionFields = actionBlock
  ? [...actionBlock[1].matchAll(/pub ([a-z_]+):/g)].map((m) => m[1])
  : [];
for (const field of actionFields) {
  check(
    `result.${field} is a real field of ActionResult`,
    declaredActionFields.map(camel).includes(field),
    `declared: ${declaredActionFields.map(camel).join(", ")}`,
  );
}

// `Startup` fields the frontend reads.
const startupBlock = /pub struct Startup \{([\s\S]*?)\n\}/.exec(stateRs);
const declaredStartupFields = startupBlock
  ? [...startupBlock[1].matchAll(/pub ([a-z_]+):/g)].map((m) => m[1])
  : [];
for (const field of ["installs", "payloadVersion", "payloadUnavailable", "injectorVersion", "releaseVersion", "releaseError"]) {
  check(
    `startup.${field} exists`,
    declaredStartupFields.map(camel).includes(field),
    `declared: ${declaredStartupFields.map(camel).join(", ")}`,
  );
}

// ── 4. The capability file stays minimal ──────────────────────────────────────

const capabilities = JSON.parse(
  await readFile(path.join(INJECTOR_ROOT, "src-tauri", "capabilities", "default.json"), "utf-8"),
);
const allowedPermissions=["core:default","core:window:allow-minimize","core:window:allow-toggle-maximize","core:window:allow-close","core:window:allow-start-dragging"];
check("only core defaults and four approved titlebar capabilities are granted", capabilities.permissions.length === allowedPermissions.length && allowedPermissions.every(p=>capabilities.permissions.includes(p)),
  JSON.stringify(capabilities.permissions));
check("no fs plugin is granted", !capabilities.permissions.some((p) => p.startsWith("fs:")));
check("no shell plugin is granted", !capabilities.permissions.some((p) => p.startsWith("shell:")));
check("no http plugin is granted", !capabilities.permissions.some((p) => p.startsWith("http:")));

// ── 5. The bridge the frontend uses must actually exist in production ────────

// The DOM tests stub `window.__TAURI__`, because a headless browser has no
// Tauri runtime. That is the right thing to do and it is also how a whole class
// of bug walks straight through: the stub is a promise that production keeps,
// and nothing checked.
//
// The real window did exactly that. `app.js` reaches the backend through
// `window.__TAURI__.core.invoke`, Tauri v2 does *not* inject that by default
// (`withGlobalTauri` is false), and so every command rejected with
// "unavailable" — an empty window on a machine where everything worked. The
// DOM suite was green throughout, because it had been testing the frontend
// against a bridge that shipped with nobody.
//
// So: if the frontend uses the global bridge, the shipped configuration has to
// provide it. This is the assertion that turns a stub into a contract.
const usesGlobalBridge = /window\.__TAURI__/.test(appJs);
const config = JSON.parse(
  await readFile(path.join(INJECTOR_ROOT, "src-tauri", "tauri.conf.json"), "utf-8"),
);
check("native window exposes transparent rounded corners", config.app.windows[0].transparent === true && config.app.windows[0].backgroundColor === "#00000000");
check("macOS native transparency is enabled", config.app.macOSPrivateApi === true);

check(
  "the frontend uses the global Tauri bridge",
  usesGlobalBridge,
  "if this changes, this whole section needs re-checking",
);
check(
  "and the shipped configuration provides it",
  usesGlobalBridge === true ? config.app?.withGlobalTauri === true : true,
  `app.withGlobalTauri is ${JSON.stringify(config.app?.withGlobalTauri)}; the frontend ` +
    `reads window.__TAURI__, which Tauri v2 only injects when this is true. ` +
    `Without it every command rejects and the window is empty.`,
);

// The rejection stub must be visible when the bridge is missing, so a future
// regression surfaces as a clear message rather than a blank window.
check(
  "a missing bridge produces a legible error rather than a blank window",
  /Promise\.reject\(new Error\("unavailable"\)\)/.test(appJs),
  "the invoke fallback should name what is missing",
);

check("the custom titlebar has no second native decoration",config.app.windows[0].decorations===false);

// ── 6. `hidden` has to actually hide ─────────────────────────────────────────

// A class selector beats the user-agent `[hidden]` rule on specificity, so
// `.banner { display: flex }` shows an element marked hidden. The first version
// of the stylesheet did, and the window opened with the "no payload" banner and
// the empty state visible at the same time.
const styles = await readFile(path.join(INJECTOR_ROOT, "src-tauri", "ui", "styles.css"), "utf-8");

// The one rule that matters. Every other `display` in this stylesheet is
// ordinary presentation; this one exists because the user-agent's
// `[hidden] { display: none }` is a bare type-plus-attribute selector and any
// class selector outranks it. Without this rule, `.banner { display: flex }`
// shows an element that is marked hidden — which is what the first version of
// the window did: the "no payload" banner and the empty state both visible at
// once, on a machine where nothing was wrong.
const HIDDEN_WINS = /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(styles);

check(
  "the stylesheet makes [hidden] win over any class display rule",
  HIDDEN_WINS,
  "without this, every element with a class that sets `display` is visible " +
    "even when the frontend marked it hidden — the banner, the empty state and " +
    "the toast all render at once",
);

// Recorded rather than asserted per selector: with the rule above in place, a
// class that sets `display` is harmless, and asserting otherwise would be
// asserting a falsehood. What is worth keeping is the list, because it is the
// set of selectors that *would* be visible if the rule were ever removed.
const displayRules = [...styles.matchAll(/(^|\n)(\.[a-z-]+)\s*\{([^}]*display:[^}]*)\}/g)]
  .map((match) => ({ selector: match[2], body: match[3] }))
  .filter((rule) => /display:\s*(flex|grid|block|inline)/.test(rule.body))
  .map((rule) => rule.selector);

check(
  "the selectors that depend on [hidden] winning are all class selectors",
  displayRules.length > 0,
  "if this is empty the rule above has nothing to protect",
);
for (const selector of displayRules) {
  check(
    `${selector} is a class selector, so [hidden] !important outranks it`,
    selector.startsWith("."),
    `a bare element or id selector with a display rule would need its own [hidden] guard`,
  );
}

// ── 7. The DOM tests exercise the page the app ships ─────────────────────────

// `harness.html` holds a *copy* of the shipped markup, because a headless
// browser cannot load the Tauri page and still give `app.js` a bridge. Copies
// drift: someone restructures `index.html`, the harness keeps the old shape, and
// the DOM suite goes on passing against a page that no longer exists. Every
// structural check in the harness is then a true statement about the wrong
// document.
//
// The invariant that prevents this is narrow and checkable: every element
// `app.js` reaches for by id has to be present in *both* files. `app.js` looks
// them all up at module load and dereferences them without a guard, so a missing
// id is a hard crash rather than a subtle mismatch — which makes the ids the
// right seam to assert on, as opposed to the whole markup.
const indexHtml = await readFile(path.join(INJECTOR_ROOT, "src-tauri", "ui", "index.html"), "utf-8");
const harnessHtml = await readFile(path.join(HERE, "harness.html"), "utf-8");

/** Ids `app.js` dereferences, in source order. */
const requiredIds = [...new Set([...appJs.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]))];

check("app.js looks up at least one element by id", requiredIds.length > 0, requiredIds.join(", "));

for (const id of requiredIds) {
  for (const [label, html] of [["index.html", indexHtml], ["harness.html", harnessHtml]]) {
    check(
      `#${id} exists in ${label}`,
      new RegExp(`id="${id}"`).test(html),
      `app.js dereferences this at module load, so a missing id crashes the frontend`,
    );
  }
}

// ── 8. The frontend never builds a path ───────────────────────────────────────

// Comments are stripped first: `app.js` *documents* that it never touches
// `innerHTML`, and a naive substring search would flag its own explanation.
// Reading the comment as usage is exactly the sort of false positive that
// trains people to ignore a check.
const appJsCode = appJs
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

for (const forbidden of ["path.join", "../", "require(", "process.env", "innerHTML", "eval(", "document.write"]) {
  check(
    `app.js does not use ${forbidden}`,
    !appJsCode.includes(forbidden),
    forbidden === "innerHTML" ? "found in executable code" : "",
  );
}

// ── 9. Every command is reachable, and nothing else is registered ─────────────

// A registered-but-unreachable command is dead surface: it widens what a
// compromised frontend could reach for no user-visible gain. `apply_staged`
// was exactly this — the CLI applies staged updates, so the GUI copy was
// never called and duplicated `main.rs`'s implementation.
check(
  "no dead commands are registered",
  registered.every((name) => invoked.includes(name)),
  `registered but never invoked: ${registered.filter((n) => !invoked.includes(n)).join(", ")}`,
);

// ── Report ────────────────────────────────────────────────────────────────────

check("release Windows builds do not create a console",
  mainRs.includes('cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")'));
check("the OS application name matches the visible title",
  mainRs.includes('context.package_info_mut().name = "Syncord Injector".into()'));

const failed = results.filter((r) => !r.ok);
for (const result of results) {
  if (!result.ok) console.log(`FAIL ${result.name}${result.detail ? ` — ${result.detail}` : ""}`);
}
console.log(`\n${results.length - failed.length}/${results.length} contract assertions passed`);

if (failed.length > 0) {
  console.error(`\nFAIL ${failed.length} contract assertions`);
  process.exit(1);
}
console.log("PASS: the frontend and the Rust commands agree on names, shapes and permissions");
