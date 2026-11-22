/**
 * Static policy checks over the bundled plugin sources.
 *
 * These are not runtime tests. They exist because the properties they check are
 * *declarative* — a permission is a line of source, so it can be read and
 * asserted on without booting Discord. That makes them the cheapest possible
 * guard against a plugin gaining a capability by accident.
 *
 * Run: `node --test scripts/tests/plugin-policy.test.mjs`
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

const PLUGIN_DIR = path.join(process.cwd(), "src", "renderer", "plugins");

/** Every .ts file under src/renderer/plugins, recursively. */
function pluginSources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".ts")) out.push(full);
    }
  };
  walk(PLUGIN_DIR);
  return out;
}

const SOURCES = pluginSources();
const relative = (file) => path.relative(process.cwd(), file);

// ── PHASE 10: no remote code execution in bundled plugins ───────────────────

test("plugins: no eval, new Function, or dynamic remote import", () => {
  // `Function.prototype.toString` is fine (it reads an existing function's
  // source); *constructing* a function from a string is not.
  const banned = [
    { re: /\beval\s*\(/, why: "eval(" },
    { re: /\bnew\s+Function\s*\(/, why: "new Function(" },
    { re: /\bimport\s*\(/, why: "dynamic import()" },
    { re: /\brequire\s*\(\s*[^"']/, why: "dynamic require()" },
    { re: /createElement\s*\(\s*["']script["']/, why: "injected <script>" },
    { re: /\.src\s*=\s*["']https?:/, why: "remote script src" },
    { re: /child_process|execSync|spawnSync/, why: "child process" },
    { re: /\bipcRenderer\b/, why: "raw ipcRenderer" },
    { re: /\brequire\s*\(\s*["']node:/, why: "raw Node module" },
  ];
  for (const file of SOURCES) {
    const source = readFileSync(file, "utf-8");
    for (const { re, why } of banned) {
      assert.equal(re.test(source), false, `${relative(file)} contains ${why}`);
    }
  }
});

test("plugins: no renderer calls the raw SyncordNative bridge for network access", () => {
  // Plugins must go through `ctx.network`, which binds their identity. A direct
  // `window.SyncordNative` call is how a plugin would forge another plugin's
  // permissions.
  for (const file of SOURCES) {
    const source = readFileSync(file, "utf-8");
    assert.equal(
      /window\.SyncordNative/.test(source),
      false,
      `${relative(file)} reaches window.SyncordNative directly; use ctx.* instead`,
    );
    assert.equal(
      /httpFetch/.test(source),
      false,
      `${relative(file)} references the removed httpFetch API`,
    );
  }
});

test("plugins: no process.env secret access", () => {
  for (const file of SOURCES) {
    const source = readFileSync(file, "utf-8");
    assert.equal(
      /process\.env/.test(source),
      false,
      `${relative(file)} reads process.env; secrets do not belong in the renderer bundle`,
    );
  }
});

// ── PHASE 9: every built-in declares its permissions ────────────────────────

/** Extract the `permissions: { … }` block that follows a `definePlugin({`. */
function declaredPermissions(file) {
  const source = readFileSync(file, "utf-8");
  const start = source.indexOf("definePlugin({");
  if (start === -1) return null;
  const marker = source.indexOf("permissions:", start);
  if (marker === -1) return null;
  let depth = 0;
  let i = source.indexOf("{", marker);
  const from = i;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(from, i + 1);
}

test("plugins: every plugin definition declares a permissions block", () => {
  const definitions = SOURCES.filter((file) => readFileSync(file, "utf-8").includes("definePlugin({"));
  assert.ok(definitions.length > 0, "no plugin definitions found — the scan is broken");

  for (const file of definitions) {
    const block = declaredPermissions(file);
    assert.notEqual(
      block,
      null,
      `${relative(file)} calls definePlugin() without a permissions block. An absent block ` +
        `means "deny everything", which silently breaks the plugin — declare what it needs.`,
    );
  }
});

test("plugins: no built-in requests a network permission or webhook access", () => {
  // Every built-in talks to Discord's own API through Discord's own code, so
  // none of them needs broker access. A built-in that starts declaring a network
  // host is a change that must be reviewed, not a refactor.
  for (const file of SOURCES) {
    const block = declaredPermissions(file);
    if (block === null) continue;
    assert.equal(/\bnetwork\s*:/.test(block), false, `${relative(file)} declares a network permission`);
    assert.equal(/webhookSend/.test(block), false, `${relative(file)} declares webhookSend`);
    assert.equal(/["']\*["']/.test(block), false, `${relative(file)} declares a wildcard host`);
  }
});

/**
 * Does this file reach for the plugin context's patch API?
 *
 * Matches any receiver, not just the parameter named `ctx`: plugins routinely
 * stash the context in a module-level variable (`auto-quests` does), and a scan
 * that only sees `ctx.patch.` silently exempts exactly those files.
 */
const CALLS_PATCH = /\w[.!]*\w*\s*[.!?]?\s*patch\s*\.\s*(before|after|instead)\s*\(/;

test("plugins: every plugin that calls ctx.patch declares webpackPatch", () => {
  // The invariant that matters, and the one whose absence let a real regression
  // through: the Phase work added a `permissions` block to `auto-quests` without
  // `webpackPatch`, which silently turned `ctx.patch` into a no-op and left the
  // whole plugin inert. The old version of this test asserted the *set* of
  // declaring files, so adding the missing declaration broke it — it was pinned
  // to the buggy state rather than to the rule.
  //
  // A permission that is used but not declared is always a bug. The reverse
  // (declaring and not using) is allowed, so this is deliberately one-directional.
  //
  // The scan matches `<anything>.patch.before|after|instead`, not the literal
  // `ctx.patch.` — a plugin that stashes the context in a module-level variable
  // (`auto-quests` does exactly that) is invisible to the narrower pattern, and
  // an invisible plugin is an unverified plugin.
  // Shared native DM rendering still consumes the caller's gated ctx.patch.
  // Count and verify its consumers just like direct patch users.
  const sharedView = readFileSync(path.join(process.cwd(), "src/renderer/ui/privateChannelView.ts"), "utf-8");
  assert.ok(CALLS_PATCH.test(sharedView), "shared DM view must use the gated plugin context");
  const users = SOURCES.filter((file) => {
    const source = readFileSync(file, "utf-8");
    return CALLS_PATCH.test(source) || /registerDmView\s*\(\s*ctx\s*,/.test(source) || /simulateGame\s*\(/.test(source) || /attachIdentity\s*\(\s*ctx\s*,/.test(source);
  });
  assert.ok(users.length > 0, "no ctx.patch users found — the scan is broken");
  const gameCoordinator=readFileSync("src/renderer/api/gameSimulation.ts","utf8");
  assert.match(gameCoordinator,/if\(!ctx\.permissions\.webpackPatch\)/,"shared game coordinator must enforce the caller capability");
  assert.match(gameCoordinator,/ctx\.disposable\(/,"shared game hooks need an owning context disposer");
  const identityAdapter=readFileSync("src/renderer/api/platformIdentity.ts","utf8");
  assert.ok(CALLS_PATCH.test(identityAdapter),"native identity adapter must use the gated context");
  assert.match(identityAdapter,/ctx\.plugin\.id!=='platform-spoofer'\|\|!ctx\.permissions\.webpackPatch/,"identity adapter must restrict its owner and patch capability");
  const identityOwner=readFileSync("src/renderer/plugins/platformSpoofer/index.ts","utf8");
  assert.match(identityOwner,/ctx\.disposable\(identity\.dispose\)/,"native identity hook needs an owning context disposer");
  for (const file of users) {
    const block = declaredPermissions(file);
    assert.notEqual(
      block,
      null,
      `${relative(file)} calls ctx.patch but its plugin does not declare permissions`,
    );
    assert.match(
      block,
      /webpackPatch:\s*true/,
      `${relative(file)} calls ctx.patch but does not declare permissions.webpackPatch — ` +
        `ctx.patch would be a no-op and the plugin silently inert`,
    );
  }

  // And the capability is not so cheap that every plugin declares it: least
  // privilege still has to mean something.
  const withPatch = SOURCES.filter((file) => {
    const block = declaredPermissions(file);
    return block !== null && /webpackPatch:\s*true/.test(block);
  });
  assert.ok(
    withPatch.length < users.length + 4,
    `webpackPatch is declared by nearly every plugin (${withPatch.length}/${users.length}) — ` +
      `that is not least privilege`,
  );
});

test("plugins: every file calling ctx.css has a plugin declaring media", () => {
  const cssUsers = SOURCES.filter((file) => readFileSync(file, "utf-8").includes("ctx.css.inject"));
  assert.ok(cssUsers.length > 0, "no ctx.css users found — the scan is broken");
  const withMedia = SOURCES.filter((file) => {
    const block = declaredPermissions(file);
    return block !== null && /media:\s*true/.test(block);
  });
  assert.ok(
    withMedia.length >= 3,
    "expected several plugins to declare media; the scan may have stopped matching",
  );
});

console.log("[Syncord] plugin policy checks loaded");
