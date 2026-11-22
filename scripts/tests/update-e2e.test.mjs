/**
 * End-to-end test of the Electron → Injector hand-off.
 *
 * Run: `node --test scripts/tests/update-e2e.test.mjs`
 *
 * This is the one path in the update feature that had never been run:
 *
 *   src/main/security/updater.ts  →  handOffToInjector  →  spawn  →
 *   syncord-injector --apply-staged  →  the write into a Discord install
 *
 * Almost everything in that chain is real. The real `handOffToInjector`, the
 * real `spawn`, the real Injector binary built with a real key, a real signed
 * `tar.gz` that the real code downloads, verifies and stages, and a real
 * install performed by the Injector itself.
 *
 * ── What is substituted, and why ─────────────────────────────────────────────
 *
 * Two things, both at a boundary rather than inside the logic:
 *
 *   * **Electron.** Stubbed at the module boundary so `app.getPath("userData")`
 *     points at a temporary directory. Everything else in `updater.ts` is the
 *     shipped module: if `handOffToInjector` is broken, this fails.
 *
 *   * **The TLS socket.** `stageUpdate` fetches from `api.github.com`, and the
 *     SSRF guard correctly refuses a private address, so a local server is not
 *     an option. The transport is replaced *at build time* by re-bundling
 *     `updater.ts` with a `https.get` that serves fixtures from disk — not by
 *     adding a hook to the shipped module. The response is a real `Readable`,
 *     so backpressure, `sink.write` and the per-chunk size accounting all run.
 *
 * The consequence worth stating: everything above the socket is exercised for
 * real — descriptor validation, the Ed25519 check, offer evaluation, the digest
 * comparison, the staging layout, the phase transitions, the spawn, the exit
 * code, and the bytes that land in the Discord install.
 *
 * ── What this is allowed to touch ────────────────────────────────────────────
 *
 * A synthetic Discord in a temporary directory, reached through
 * `SYNCORD_DISCORD_PATH`. The user's own `/Applications/Discord.app` is never
 * read and never written. The pin has to be in the environment of *this*
 * process, because `handOffToInjector` spawns the Injector with the ambient
 * environment and the child inherits it.
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

import { CARGO_ENV, CARGO_JOB_FLAGS, injectorBuildAllowed, runCargoSync } from "./cargo-jobs.mjs";

const { test, before, after } = await import("node:test");

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const INJECTOR_ROOT = path.join(REPO, "injector");

const OLD_VERSION = "1.4.0";
const NEW_VERSION = "1.5.0";
const REPO_SLUG = "dearaero/discordion";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "syncord-e2e-"));
const userData = path.join(scratch, "userData");
const discordResources = path.join(scratch, "Discord.app", "Contents", "Resources");
const injectorBin = path.join(scratch, "injector", "syncord-injector");
const descriptorFixture = path.join(scratch, "descriptor.json");
const assetFixture = path.join(scratch, "asset.tar.gz");
const urlLog = path.join(scratch, "requested-urls.txt");

// The same worthless fixture key used by the Rust command tests. An explicit
// prebuilt test binary can exercise the complete worker flow without compiling
// the GUI dependencies in a fresh target directory each time.
const fixturePrivate = crypto.createPrivateKey({key: Buffer.from("MC4CAQAwBQYDK2VwBCIEIFCmGafBqqcA1yt3dsFJc5yuhy0KUE9irGd/8wyQrT1x", "base64"), format: "der", type: "pkcs8"});
const KEY = {privateKey: fixturePrivate, publicKey: crypto.createPublicKey(fixturePrivate)};
const PUB_B64 = KEY.publicKey.export({ format: "der", type: "spki" }).toString("base64");

// The pin has to be in this process's environment, because the Injector is
// spawned from here and inherits it.
process.env.SYNCORD_DISCORD_PATH = discordResources;

const hasCargo = Boolean(process.env.SYNCORD_TEST_INJECTOR_BINARY) || (injectorBuildAllowed() && spawnSync("cargo", ["--version"], { encoding: "utf-8" }).status === 0);

/** The payload members, in the order the packagers use. */
const PAYLOAD_MEMBERS = [
  "main.js",
  "preload.js",
  "renderer.js",
  "integrity.manifest.json",
  "syncord-version.json",
];

/** Set when the Injector could be built; every test that needs it skips without. */
let injectorReady = false;

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** A signed payload directory, byte-identical in shape to `sign-payload.mjs`. */
function writePayload(dir, version, signingKey = KEY.privateKey) {
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (const name of ["main.js", "preload.js", "renderer.js"]) {
    const body = `// ${name} for v${version}\nconsole.log("syncord ${version}");\n`;
    fs.writeFileSync(path.join(dir, name), body);
    files.push({ name, sha256: crypto.createHash("sha256").update(body).digest("hex") });
  }
  const canonical = JSON.stringify({ version: 1, algorithm: "ed25519", files });
  const signature = crypto.sign(null, Buffer.from(canonical), signingKey).toString("base64");
  fs.writeFileSync(
    path.join(dir, "integrity.manifest.json"),
    `${JSON.stringify({ ...JSON.parse(canonical), signature }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(dir, "syncord-version.json"), `${JSON.stringify({ version }, null, 2)}\n`);
}

/** A real `tar.gz` of a signed payload, as a release asset is. */
function writeAsset(version, signingKey = KEY.privateKey) {
  const payload = path.join(scratch, `payload-${version}`);
  fs.rmSync(payload, { recursive: true, force: true });
  writePayload(payload, version, signingKey);

  fs.rmSync(assetFixture, { force: true });
  // The same member list and environment `scripts/package-payload.mjs` uses.
  // Archiving the directory itself produced a macOS AppleDouble entry named
  // `._.`, which the Injector correctly refused — so the fixture failed for a
  // reason that was really a packaging bug, which is how the bug was found.
  const result = spawnSync(
    "tar",
    ["-czf", assetFixture, "-C", payload, ...PAYLOAD_MEMBERS],
    { env: { ...process.env, COPYFILE_DISABLE: "1" }, encoding: "utf-8" },
  );
  assert.equal(result.status, 0, `tar failed: ${result.stderr}`);
  return crypto.createHash("sha256").update(fs.readFileSync(assetFixture)).digest("hex");
}

/**
 * A signed release descriptor naming the asset, as the feed would carry it.
 *
 * `size` is the asset's real byte count, read from disk — the same thing
 * `scripts/release.mjs` puts there. A hardcoded number looked harmless and was
 * not: the transport enforces `maxBytes: asset.size`, so a fixture whose
 * declared size was even slightly small failed the download with "response is
 * larger than the allowed size", which reads like a product limit rather than a
 * bad fixture. It passed standalone and failed under `pnpm test`, because the
 * archive's size varies with the tar/gzip metadata.
 */
function writeDescriptor(version, assetName, digest) {
  const body = {
    version: 1,
    channel: "stable",
    release: version,
    publishedAt: "2026-01-01T00:00:00Z",
    assets: [
      {
        platform: currentPlatform(),
        name: assetName,
        size: fs.statSync(assetFixture).size,
        sha256: digest,
      },
    ],
  };
  const signature = crypto
    .sign(null, Buffer.from(JSON.stringify(body), "utf-8"), KEY.privateKey)
    .toString("base64");

  // The feed answers with the signed descriptor itself (api.syncord.pro serves
  // channels/<channel>.json from R2 verbatim). There is no release envelope.
  fs.writeFileSync(descriptorFixture, JSON.stringify({ ...body, signature }));
}

/** The platform name the release pipeline uses, which the client derives. */
function currentPlatform() {
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "darwin") return `mac-${arch}`;
  if (process.platform === "win32") return `windows-${arch}`;
  return `linux-${arch}`;
}

/** The installed state `inject` produces. */
function seedInstall(version) {
  fs.rmSync(discordResources, { recursive: true, force: true });
  fs.mkdirSync(discordResources, { recursive: true });
  fs.writeFileSync(path.join(discordResources, "app.asar"), "pretend this is Discord");

  const payload = path.join(scratch, `payload-${version}`);
  fs.cpSync(payload, path.join(discordResources, "app"), { recursive: true });
  fs.renameSync(path.join(discordResources, "app.asar"), path.join(discordResources, "_app.asar"));
  fs.writeFileSync(
    path.join(discordResources, "app", "package.json"),
    '{\n  "name": "discord",\n  "main": "main.js",\n  "private": true\n}\n',
  );
}

const installedVersion = () => {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(discordResources, "app", "syncord-version.json"), "utf-8"),
    ).version;
  } catch {
    return null;
  }
};

// ── The module under test ─────────────────────────────────────────────────────

const ELECTRON_STUB = `
import path from "node:path";

/**
 * Only as much Electron as the import graph touches.
 *
 * \`updater.ts\` itself needs \`app\`, but it reaches \`securityLog\` and the
 * session helpers, and those reach further. Rather than stub the world, this
 * provides the handful of shapes the graph destructures, each one clearly inert.
 * A stub that quietly *worked* would be worse than a missing one: a test running
 * against a fake that behaves differently from the real thing is a test that
 * proves nothing.
 */
export const app = {
  getPath(name) {
    return name === "userData" ? ${JSON.stringify(userData)} : ${JSON.stringify(scratch)};
  },
  isPackaged: false,
  getVersion: () => "0.0.0-test",
  getName: () => "Syncord",
  getAppPath: () => globalThis.__syncordQueueAppPath ?? ${JSON.stringify(scratch)},
  quit() { globalThis.__syncordQuitCalls = (globalThis.__syncordQuitCalls ?? 0) + 1; },
  exit() {},
  on() {},
  once() {},
  whenReady: () => Promise.resolve(),
  relaunch() {},
  setLoginItemSettings() {},
};

export const session = {
  fromPartition: () => makeSession(),
  defaultSession: makeSession(),
};

function makeSession() {
  return {
    webRequest: {
      onBeforeRequest() {},
      onBeforeSendHeaders() {},
      onHeadersReceived() {},
    },
    setPermissionRequestHandler() {},
    clearStorageData: async () => {},
    setProxy: async () => {},
    webContents: { on() {}, send() {} },
  };
}

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: () => { throw new Error("stub"); },
  decryptString: () => { throw new Error("stub"); },
};

export const shell = {
  openExternal: async () => {},
  openPath: async () => "",
};

export class IpcMainInvokeEvent {}
export default { app, session, safeStorage, shell };
`;

/**
 * The fixture transport, written as a module and substituted at build time.
 *
 * Build-time substitution rather than a runtime hook: nothing is added to
 * `updater.ts` for the test's benefit, so the module under test is the shipped
 * one in every respect except where it opens a socket.
 */
const TRANSPORT_STUB = `
import fs from "node:fs";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import https from "node:https";

const DESCRIPTOR = ${JSON.stringify(descriptorFixture)};
const ASSET = ${JSON.stringify(assetFixture)};
const URL_LOG = ${JSON.stringify(path.join(scratch, "requested-urls.txt"))};

export function install() {
  https.get = (url, _options, callback) => {
    const target = String(url);
    // Recorded rather than returned: the repository the client chose is only
    // observable as the URL it asked for, and that is worth asserting directly
    // rather than through a getter added to the module for the test's benefit.
    fs.appendFileSync(URL_LOG, target + "\\n");
    // Matched on the download path, not on "/releases": an asset URL is
    // github.com/<repo>/releases/download/<tag>/<asset>, so a looser test serves
    // the descriptor as the asset and the download fails its digest check. The
    // failure was correct — the bytes really were not the release.
    const isFeed = target.includes("/v1/update/") && !target.includes("/update/releases/");
    const body = fs.readFileSync(isFeed ? DESCRIPTOR : ASSET);

/*
     * GitHub 404s an asset path whose tag is not a real ref, and that is the
     * behaviour this stub used to lack: it answered 200 to any tag at all, so a
     * download URL built from the wrong tag was indistinguishable from a correct
     * one. That is exactly how a release could be fetched, parsed and
     * signature-verified and then fail with a 404 for every user, with this
     * suite green throughout and the URL builder's own test asserting the wrong
     * tag string.
     *
     * A stub has to refuse what the real service refuses, or it cannot see the
     * part that broke. So the tag in the path is compared against the one the
     * feed itself declares, and a mismatch is a 404 here exactly as it is there.
     *
     * (No backticks in this comment either: the stub is emitted inside a template
     * literal, so one would end the string. See the note on the regex below for
     * the other thing a template literal quietly eats.)
     */
    // The tag is read out of the path with a character class, and that is not a
    // style choice. This whole stub is a template literal, and inside one a
    // backslash before a slash collapses to a bare slash -- so a regex written the
    // obvious way arrives as two adjacent slashes, which is a line comment that
    // eats the rest of the statement. The build then fails at the *next* line with
    // an "unexpected const" that points nowhere near the cause. A character class
    // needs no escaping and survives the trip intact.
    const downloadVersion = /[/]update[/]releases[/]([^/]+)[/]/.exec(target)?.[1];
    let feedVersion;
    try { feedVersion = JSON.parse(fs.readFileSync(DESCRIPTOR, "utf-8")).release; } catch { feedVersion = undefined; }
    const tagMatches = downloadVersion === undefined || feedVersion === undefined || downloadVersion === feedVersion;

    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = () => {};

    setImmediate(() => {
      if (!tagMatches) {
        const missing = Readable.from([Buffer.alloc(0)]);
        missing.statusCode = 404;
        missing.headers = { "content-type": "text/plain", "content-length": "0" };
        missing.rawHeaders = Object.entries(missing.headers).flat();
        callback(missing);
        return;
      }
      const response = Readable.from([body]);
      response.statusCode = 200;
      response.headers = {
        "content-type": isFeed ? "application/json" : "application/octet-stream",
        "content-length": String(body.length),
      };
      response.rawHeaders = Object.entries(response.headers).flat();
      callback(response);
    });

    return request;
  };
}
`;

let buildCounter = 0;

/**
 * Load the real `updater.ts` with the fixture transport installed.
 *
 * A fresh query string per call, so each run gets its own module instance and
 * therefore its own `busy` / `accepted` / `status` state. Sharing them would make
 * a later test start from wherever an earlier one left off, which is the kind of
 * order-dependent test that passes on a clean machine and fails in CI.
 */
async function withUpdater(run) {
  fs.writeFileSync(path.join(scratch, "electron-stub.mjs"), ELECTRON_STUB);
  const transportPath = path.join(scratch, `transport-${buildCounter}.mjs`);
  fs.writeFileSync(transportPath, TRANSPORT_STUB);

  const entry = path.join(scratch, `entry-${buildCounter}.ts`);
  fs.writeFileSync(
    entry,
    `import { install } from ${JSON.stringify(transportPath)};
     install();
     export * from ${JSON.stringify(path.join(REPO, "src", "main", "security", "updater.ts"))};
     export * as modes from ${JSON.stringify(path.join(REPO, "src", "main", "security", "modes.ts"))};
    `,
  );
  const out = path.join(scratch, `updater-${buildCounter}.mjs`);
  buildCounter += 1;

  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: out,
    logLevel: "warning",
    alias: { electron: path.join(scratch, "electron-stub.mjs") },
    define: {
      __SYNCORD_VERSION__: JSON.stringify(OLD_VERSION),
      __SYNCORD_RELEASE_REPO__: JSON.stringify(REPO_SLUG),
      // The key arrives the way a client receives it: compiled in. It used to be
      // substituted as `process.env.Syncord_INTEGRITY_KEY`, which is how the
      // *release pipeline* supplies it -- so this suite was exercising the build
      // machine and reporting a green run while no shipped client could verify
      // anything at all. The define is what the artifact carries, so the define is
      // what the test has to set.
      __SYNCORD_INTEGRITY_KEY__: JSON.stringify(PUB_B64),
    },
  });

  const module = await import(`file://${out}`);
  fs.writeFileSync(urlLog, "");
  return run(module);
}

/** Check, download, verify and stage — the real path, up to the spawn. */
async function stageReady(module) {
  const checked = await module.checkForUpdate({ channel: "stable" });
  assert.equal(checked.phase, "available", `checkForUpdate: ${checked.detail}`);

  const staged = await module.stageUpdate();
  assert.equal(staged.phase, "ready", `stageUpdate: ${staged.detail}`);
  assert.equal(staged.stagedVersion, NEW_VERSION);
  return staged;
}

/**
 * Skip marker, or `false` when the toolchain is present.
 *
 * Conditional on purpose. A constant `{ skip }` skips unconditionally, which
 * looks exactly like a suite that passes everywhere and runs nowhere — the
 * first version of this file did that and reported "13 skipped, 0 failed"
 * while a working Rust toolchain sat two directories away.
 */
const NO_CARGO = hasCargo ? false : { skip: "Injector compilation not authorized or Rust unavailable; no test binary provided" };

// ── Setup ─────────────────────────────────────────────────────────────────────

before(() => {
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(path.dirname(injectorBin), { recursive: true });
  // Built once: the payload for the "before" state and the release asset both
  // come out of these, and rebuilding per test would be pure latency.
  writePayload(path.join(scratch, `payload-${OLD_VERSION}`), OLD_VERSION);
  writeAsset(NEW_VERSION);

  if (process.env.SYNCORD_TEST_INJECTOR_BINARY) {
    fs.copyFileSync(process.env.SYNCORD_TEST_INJECTOR_BINARY, injectorBin);
    fs.chmodSync(injectorBin, 0o755);
    injectorReady = true;
    return;
  }
  if (!hasCargo) return;
  const built = runCargoSync(["build", "--release", ...CARGO_JOB_FLAGS], {
    cwd: INJECTOR_ROOT,
    encoding: "utf-8",
    env: {
      ...process.env,
      SYNCORD_INTEGRITY_KEY: PUB_B64,
      // Its own target directory, and not for speed.
      //
      // The Injector's verification key is compiled in, so two suites that build
      // with *different* keys cannot share `target/`: whichever finishes last
      // wins, and each suite copies whatever is there at that moment. Run
      // standalone this suite passed; run under `pnpm test`, alongside
      // `packaging.test.mjs` doing the same thing with its own key, it failed —
      // and the failure was "the Installor rejected a payload it had just
      // signed", which reads like a product bug rather than a test one.
      CARGO_TARGET_DIR: path.join(scratch, "target"),
      ...CARGO_ENV,
    },
  });
  if (built.status !== 0) {
    console.log(`[e2e] cargo build failed:\n${built.stderr.slice(0, 400)}`);
    return;
  }
  fs.copyFileSync(path.join(scratch, "target", "release", "syncord-injector"), injectorBin);
  injectorReady = true;
});

after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
  delete process.env.SYNCORD_DISCORD_PATH;
});

// ── The shape of the feed, and what binds it ─────────────────────────────────

test("the feed is the signed descriptor itself and is read correctly", async () => {
  // The Worker serves channels/<channel>.json verbatim. If the fixture drifts
  // back to a wrapped shape, this fails before any parser change can hide it.
  const assetName = `syncord-${NEW_VERSION}-test.tar.gz`;
  writeAsset(NEW_VERSION);
  writeDescriptor(NEW_VERSION, assetName, digestOfAsset());

  const response = JSON.parse(fs.readFileSync(descriptorFixture, "utf-8"));
  assert.equal(response.release, NEW_VERSION, "the feed carries the release directly");
  assert.equal(typeof response.signature, "string", "and its signature");
  assert.ok(!("tag_name" in response) && !("body" in response), "there is no release envelope");

  const outcome = await withUpdater(async (module) => {
    const checked = await module.checkForUpdate({ channel: "stable" });
    assert.equal(checked.phase, "available", `the real shape was rejected: ${checked.detail}`);
  });
  assert.equal(outcome, undefined);
});

test("a GitHub-style release envelope is refused, not unwrapped", async () => {
  // The old feed wrapped the descriptor in a release object. A feed that still
  // does is not the Syncord feed, and unwrapping it would reintroduce a layer
  // whose fields (tag_name, body) nothing signs.
  const assetName = `syncord-${NEW_VERSION}-test.tar.gz`;
  writeAsset(NEW_VERSION);
  writeDescriptor(NEW_VERSION, assetName, digestOfAsset());

  const descriptor = fs.readFileSync(descriptorFixture, "utf-8");
  fs.writeFileSync(descriptorFixture, JSON.stringify({ tag_name: `v${NEW_VERSION}`, body: descriptor }));

  const outcome = await withUpdater(async (module) => {
    const checked = await module.checkForUpdate({ channel: "stable" });
    assert.notEqual(checked.phase, "available", "an enveloped descriptor produced an offer");
    assert.equal(checked.lastError, "descriptor", `wrong reason: ${checked.detail}`);
  });
  assert.equal(outcome, undefined);
});

test("a feed that is not JSON is refused, not half-read", async () => {
  // A misconfigured proxy or an error page must fail as a clean refusal, not as
  // a parse exception or an absence that reads like "up to date".
  const assetName = `syncord-${NEW_VERSION}-test.tar.gz`;
  writeAsset(NEW_VERSION);
  writeDescriptor(NEW_VERSION, assetName, digestOfAsset());

  fs.writeFileSync(descriptorFixture, "<html>502 Bad Gateway</html>");

  const outcome = await withUpdater(async (module) => {
    const checked = await module.checkForUpdate({ channel: "stable" });
    assert.notEqual(checked.phase, "available");
    assert.equal(checked.lastError, "bad-json", `wrong reason: ${checked.detail}`);
  });
  assert.equal(outcome, undefined);
});

// ── The whole chain ───────────────────────────────────────────────────────────

test("a release is checked, downloaded, staged, installed and confirmed", NO_CARGO, async (t) => {
  if (!injectorReady) return t.skip("the Injector did not build");

  seedInstall(OLD_VERSION);
  assert.equal(installedVersion(), OLD_VERSION, "the synthetic Discord starts at the old version");

  const assetName = `syncord-${NEW_VERSION}-test.tar.gz`;
  const digest = writeAsset(NEW_VERSION);
  writeDescriptor(NEW_VERSION, assetName, digest);

  const outcome = await withUpdater(async (module) => {
    const checked = await module.checkForUpdate({ channel: "stable" });
    assert.equal(checked.phase, "available", `checkForUpdate: ${checked.detail}`);
    assert.equal(checked.latest, NEW_VERSION, "the offer must name the release version");

    const staged = await stageReady(module);

    // The staging layout must be exactly what the Injector is documented to
    // read: the asset and `release.json` side by side, with a matching digest.
    // This is the seam between the two halves of the system, and it is produced
    // by the production code rather than assembled by the test.
    const dir = path.join(userData, "Syncord", "staging", NEW_VERSION);
    assert.ok(fs.existsSync(path.join(dir, assetName)), "the asset must be staged");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "release.json"), "utf-8")), {
      version: NEW_VERSION,
      asset: assetName,
      sha256: digest,
    });

    return module.handOffToInjector(injectorBin);
  });

  // What main reported, and why it is now worth believing: the hand-off resolves
  // only after the Injector has exited, so `handed-off` means exit code 0 from
  // the process that does the writing. The first version of this flow spawned it
  // detached with its output discarded and reported the same phase immediately.
  assert.equal(outcome.phase, "handed-off", `${outcome.phase}: ${outcome.detail}`);
  assert.match(outcome.detail, new RegExp(`Syncord ${NEW_VERSION} was installed`));

  // And what actually happened on disk, which is the only claim worth making.
  assert.equal(installedVersion(), NEW_VERSION, "the new version must be installed");
  assert.match(
    fs.readFileSync(path.join(discordResources, "app", "renderer.js"), "utf-8"),
    new RegExp(`syncord ${NEW_VERSION}`),
  );
  assert.ok(fs.existsSync(path.join(discordResources, "_app.asar")), "Discord's asar must survive");
  assert.ok(!fs.existsSync(path.join(discordResources, "app.asar")));
});

test("the install is verifiable afterwards, not just present", NO_CARGO, async (t) => {
  if (!injectorReady) return t.skip("the Injector did not build");
  // The bug the previous session found: `update` replaced the bundles and left
  // the old manifest, so the install was permanently unverifiable. Asserting the
  // version stamp alone would not have caught it.
  assert.equal(installedVersion(), NEW_VERSION);

  const listed = spawnSync(injectorBin, ["--list"], {
    encoding: "utf-8",
    env: { ...process.env, SYNCORD_DISCORD_PATH: discordResources },
  });
  const out = `${listed.stdout}${listed.stderr}`;
  assert.match(out, new RegExp(`injected, verified, v${NEW_VERSION}`), out);
});

test("a hand-off with nothing staged is refused before any process starts", NO_CARGO, async (t) => {
  if (!injectorReady) return t.skip("the Injector did not build");
  seedInstall(OLD_VERSION);

  const status = await withUpdater((module) => module.handOffToInjector(injectorBin));
  assert.equal(status.phase, "error");
  assert.equal(status.lastError, "nothing-staged");
  assert.equal(installedVersion(), OLD_VERSION, "nothing may be installed");
});

// ── The hand-off's own failure modes ──────────────────────────────────────────

test("a binary that exits non-zero is reported, not treated as success", NO_CARGO, async (t) => {
  if (!injectorReady) return t.skip("the Injector did not build");
  seedInstall(OLD_VERSION);
  writeAsset(NEW_VERSION);
  writeDescriptor(NEW_VERSION, `syncord-${NEW_VERSION}-test.tar.gz`, digestOfAsset());

  // The exact lie the first version told: a process was started, so the UI said
  // the update was installed. A stub exiting 2 — the Injector's own "refused" —
  // must surface as a failure, carrying the installer's reason.
  const stub = path.join(scratch, "stub-injector");
  fs.writeFileSync(
    stub,
    "#!/bin/sh\necho '[Syncord] The Syncord Installer refused the update.' 1>&2\nexit 2\n",
    { mode: 0o755 },
  );

  const outcome = await withUpdater(async (module) => {
    await stageReady(module);
    return module.handOffToInjector(stub);
  });

  assert.equal(outcome.phase, "error", "a non-zero exit must never read as success");
  assert.match(outcome.detail, /refused the update/i);
  assert.match(outcome.detail, /Syncord Installer refused/, "the installer's own reason must survive");
  assert.equal(installedVersion(), OLD_VERSION, "nothing may be installed");
});

test("exit code 3 is reported as 'no Discord found', not a generic failure", NO_CARGO, async (t) => {
  if (!injectorReady) return t.skip("the Injector did not build");
  seedInstall(OLD_VERSION);

  const stub = path.join(scratch, "stub-no-target");
  fs.writeFileSync(stub, "#!/bin/sh\necho '[Syncord] no Discord install was found' 1>&2\nexit 3\n", {
    mode: 0o755,
  });

  const outcome = await withUpdater(async (module) => {
    writeAsset(NEW_VERSION);
    writeDescriptor(NEW_VERSION, `syncord-${NEW_VERSION}-test.tar.gz`, digestOfAsset());
    await stageReady(module);
    return module.handOffToInjector(stub);
  });

  assert.equal(outcome.phase, "error");
  assert.equal(outcome.lastError, "no-target");
  assert.match(outcome.detail, /could not find a Discord/i);
});

test("a payload the Injector cannot verify never reaches the install", NO_CARGO, async (t) => {
  if (!injectorReady) return t.skip("the Injector did not build");
  seedInstall(OLD_VERSION);

  // The realistic shape of this: a release built against one key, installed by a
  // client built against another. The descriptor and its digest are perfectly
  // valid — the payload inside is signed with a key the Injector does not hold.
  const foreign = crypto.generateKeyPairSync("ed25519").privateKey;
  writeAsset(NEW_VERSION, foreign);
  writeDescriptor(NEW_VERSION, `syncord-${NEW_VERSION}-test.tar.gz`, digestOfAsset());

  const outcome = await withUpdater(async (module) => {
    await stageReady(module);
    return module.handOffToInjector(injectorBin);
  });

  assert.equal(outcome.phase, "error", "a payload the Injector cannot verify must not install");
  assert.equal(installedVersion(), OLD_VERSION, "the install must be untouched");
});

test("a configured path that is not a file is refused", NO_CARGO, async (t) => {
  if (!injectorReady) return t.skip("the Injector did not build");
  seedInstall(OLD_VERSION);
  writeAsset(NEW_VERSION);
  writeDescriptor(NEW_VERSION, `syncord-${NEW_VERSION}-test.tar.gz`, digestOfAsset());

  const outcome = await withUpdater(async (module) => {
    await stageReady(module);
    return module.handOffToInjector(scratch); // a directory
  });

  assert.equal(outcome.phase, "error");
  assert.match(outcome.detail, /could not be found at the configured path/);
  assert.equal(installedVersion(), OLD_VERSION);
});

test("a relative configured path is refused rather than resolved", NO_CARGO, async (t) => {
  if (!injectorReady) return t.skip("the Injector did not build");
  seedInstall(OLD_VERSION);
  writeAsset(NEW_VERSION);
  writeDescriptor(NEW_VERSION, `syncord-${NEW_VERSION}-test.tar.gz`, digestOfAsset());

  const outcome = await withUpdater(async (module) => {
    await stageReady(module);
    return module.handOffToInjector("syncord-injector");
  });

  assert.equal(outcome.phase, "error");
  assert.match(outcome.detail, /not an absolute path/);
});

test("no installer anywhere is refused with something the user can act on", NO_CARGO, async (t) => {
  if (!injectorReady) return t.skip("the Injector did not build");
  seedInstall(OLD_VERSION);
  writeAsset(NEW_VERSION);
  writeDescriptor(NEW_VERSION, `syncord-${NEW_VERSION}-test.tar.gz`, digestOfAsset());

  const outcome = await withUpdater(async (module) => {
    await stageReady(module);
    // No path, so discovery runs. In this environment `~/.local/bin` and
    // /Applications hold nothing of ours, so nothing is found.
    return module.handOffToInjector("");
  });

  assert.equal(outcome.phase, "error");
  assert.equal(outcome.lastError, "no-injector");
  assert.match(outcome.detail, /not found|Download it from the Syncord releases page/);
  assert.equal(installedVersion(), OLD_VERSION);
});

test("Lockdown refuses the hand-off even with everything staged", NO_CARGO, async (t) => {
  if (!injectorReady) return t.skip("the Injector did not build");
  seedInstall(OLD_VERSION);
  writeAsset(NEW_VERSION);
  writeDescriptor(NEW_VERSION, `syncord-${NEW_VERSION}-test.tar.gz`, digestOfAsset());

  const previous = process.env.Syncord_LOCKDOWN;
  process.env.Syncord_LOCKDOWN = "1";
  let outcome;
  try {
    outcome = await withUpdater(async (module) => {
      await stageReady(module);
      // Armed through `modes`' own API rather than by stubbing the predicate,
      // so the real Lockdown check is what refuses. `enableLockdown` is the
      // same function the startup path and the Security Center button call.
      module.modes.enableLockdown("e2e test");
      assert.equal(module.modes.isLockdown(), true, "Lockdown must actually be armed");
      return module.handOffToInjector(injectorBin);
    });
  } finally {
    if (previous === undefined) delete process.env.Syncord_LOCKDOWN;
    else process.env.Syncord_LOCKDOWN = previous;
  }

  assert.equal(outcome.phase, "error");
  assert.equal(outcome.lastError, "lockdown");
  assert.match(outcome.detail, /Emergency Lockdown/);
  assert.equal(installedVersion(), OLD_VERSION, "Lockdown must prevent the install entirely");
});

const digestOfAsset = () =>
  crypto.createHash("sha256").update(fs.readFileSync(assetFixture)).digest("hex");

// ── Discovery ─────────────────────────────────────────────────────────────────

test("a symlinked candidate is not a discovered installer", NO_CARGO, (t) => {
  if (!injectorReady) return t.skip("needs the built Injector for a real candidate list");

  // The plan's rule, and the reason `lstat` is used rather than `stat`: `stat`
  // follows the link, so a symlink sitting at a candidate path would pass every
  // other check while executing a different file.
  return withUpdater((module) => {
    assert.equal(module.isExecutableFile(process.execPath, true), true, "a real file is fine");

    const link = path.join(scratch, "link-to-node");
    fs.rmSync(link, { force: true });
    fs.symlinkSync(process.execPath, link);

    assert.equal(
      module.isExecutableFile(link, true),
      false,
      "a symlink must be refused where symlinks are rejected",
    );
    assert.equal(
      module.isExecutableFile(link, false),
      true,
      "a user-configured symlink is allowed — they chose that path",
    );
    assert.equal(module.isExecutableFile(scratch, true), false, "a directory is never an installer");
    assert.equal(module.isExecutableFile(path.join(scratch, "absent"), true), false);
  });
});

test("discovery returns something that passes its own rules, or null", NO_CARGO, (t) => {
  if (!injectorReady) return t.skip("needs the built Injector");
  return withUpdater((module) => {
    const found = module.discoverInjector();
    if (found !== null) {
      assert.ok(
        module.isExecutableFile(found, true),
        `discovery returned ${found}, which does not satisfy the rule discovery enforces`,
      );
      assert.equal(found, path.normalize(found), "a discovered path must be normalised");
    }

    const searched = module.injectorSearchPaths();
    assert.ok(searched.length > 0, "the search list must not be empty");
    for (const candidate of searched) {
      assert.ok(path.isAbsolute(candidate), `every candidate must be absolute: ${candidate}`);
      assert.equal(candidate, path.normalize(candidate), `candidates must be normalised: ${candidate}`);
    }
  });
});

test("the feed address is a constant, not read from the environment", async (t) => {
  // Setting the old runtime variable must change nothing.
  const previous = process.env.Syncord_RELEASE_REPO;
  process.env.Syncord_RELEASE_REPO = "attacker/elsewhere";
  try {
    return withUpdater(async (module) => {
      writeAsset(NEW_VERSION);
      writeDescriptor(NEW_VERSION, `syncord-${NEW_VERSION}-test.tar.gz`, digestOfAsset());
      const status = await module.checkForUpdate({ channel: "stable" });
      assert.equal(status.phase, "available", `checkForUpdate: ${status.detail}`);

      const requested = fs.readFileSync(urlLog, "utf-8").trim().split("\n").filter(Boolean);
      assert.equal(requested.length, 1, `expected one request, got ${requested.length}`);
      assert.equal(requested[0], "https://api.syncord.pro/v1/update/stable");
    });
  } finally {
    if (previous === undefined) delete process.env.Syncord_RELEASE_REPO;
    else process.env.Syncord_RELEASE_REPO = previous;
  }
});

test("resetting a pending check cannot restore an offer after opt-out", async () => {
  writeAsset(NEW_VERSION);
  writeDescriptor(NEW_VERSION, `syncord-${NEW_VERSION}-test.tar.gz`, digestOfAsset());
  await withUpdater(async module => {
    const pending = module.checkForUpdate();
    module.resetUpdateState();
    await pending;
    assert.equal(module.updateStatus().phase, "idle");
    assert.equal(module.updateStatus().latest, null);
    assert.equal((await module.stageUpdate()).lastError, "nothing-staged");
  });
});

test("a failed re-check discards the previously accepted descriptor", async () => {
  writeAsset(NEW_VERSION);
  writeDescriptor(NEW_VERSION, `syncord-${NEW_VERSION}-test.tar.gz`, digestOfAsset());
  await withUpdater(async module => {
    assert.equal((await module.checkForUpdate()).phase, "available");
    fs.writeFileSync(descriptorFixture, JSON.stringify({bad:"descriptor"}));
    assert.equal((await module.checkForUpdate()).phase, "error");
    assert.equal((await module.stageUpdate()).lastError, "nothing-staged");
  });
});


// The parent side of the waiting-worker protocol is tested without requiring
// Rust. The native tests separately prove verification and application.
test("a queued worker does not claim installation or quit before the user chooses", async () => {
  seedInstall(OLD_VERSION);
  writeDescriptor(NEW_VERSION, `syncord-${NEW_VERSION}-test.tar.gz`, writeAsset(NEW_VERSION));
  const worker = path.join(scratch, "queue-worker");
  const pidFile = path.join(scratch, "queue-worker.pid");
  fs.writeFileSync(worker, `#!${process.execPath}\nconst fs=require('fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdout.write('SYNCORD_UPDATE_READY:${NEW_VERSION}\\n');setTimeout(()=>{},10000);\n`, { mode: 0o755 });
  globalThis.__syncordQueueAppPath = path.join(discordResources, "app");
  globalThis.__syncordQuitCalls = 0;
  try {
    await withUpdater(async module => {
      await stageReady(module);
      const status = await module.handOffToInjector(worker);
      assert.equal(status.phase, "awaiting-restart", status.detail);
      assert.equal(installedVersion(), OLD_VERSION);
      assert.equal(globalThis.__syncordQuitCalls, 0);
      assert.equal((await module.checkForUpdate({channel:"beta"})).phase,"awaiting-restart", "a channel change must not orphan the worker");
      module.resetUpdateState();
      assert.equal(module.updateStatus().phase, "awaiting-restart", "turning off checks must not orphan the worker");
      assert.equal(module.restartForUpdate(), true);
      assert.equal(module.restartForUpdate(), false, "a second click cannot queue another quit");
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(globalThis.__syncordQuitCalls, 1);
    });
  } finally {
    if (fs.existsSync(pidFile)) { try { process.kill(Number(fs.readFileSync(pidFile,"utf8"))); } catch {} }
    delete globalThis.__syncordQueueAppPath; delete globalThis.__syncordQuitCalls;
  }
});

test("an old Injector is identified instead of falsely reporting an install", async () => {
  seedInstall(OLD_VERSION);
  writeDescriptor(NEW_VERSION, `syncord-${NEW_VERSION}-test.tar.gz`, writeAsset(NEW_VERSION));
  const worker = path.join(scratch, "old-worker");
  fs.writeFileSync(worker, "#!/bin/sh\necho 'unknown argument: --wait-and-apply-staged' >&2\nexit 3\n", { mode: 0o755 });
  globalThis.__syncordQueueAppPath = path.join(discordResources, "app");
  try {
    await withUpdater(async module => {
      await stageReady(module);
      const status = await module.handOffToInjector(worker);
      assert.equal(status.phase, "error");
      assert.equal(status.lastError, "old-injector");
      assert.match(status.detail, /one-time upgrade/);
      assert.equal(module.restartForUpdate(), false);
      assert.equal(installedVersion(), OLD_VERSION);
    });
  } finally { delete globalThis.__syncordQueueAppPath; }
});


test("real parent and native worker install only after Discord quits", NO_CARGO, async t => {
  if (!injectorReady) return t.skip("the Injector did not build");
  if (process.platform === "win32") return t.skip("the POSIX live-process fixture is tested on macOS/Linux");
  seedInstall(OLD_VERSION);
  writeDescriptor(NEW_VERSION, `syncord-${NEW_VERSION}-test.tar.gz`, writeAsset(NEW_VERSION));
  const target = path.join(scratch, "live-discord");
  const resources = path.join(target, "Resources");
  fs.mkdirSync(target, {recursive: true});
  fs.cpSync(discordResources, resources, {recursive: true});
  const executable = path.join(target, "Discord");
  fs.copyFileSync("/bin/sleep", executable); fs.chmodSync(executable, 0o755);
  if (process.platform === "darwin") assert.equal(spawnSync("/usr/bin/codesign",["--force","--sign","-",executable]).status,0);
  const fake = spawn(executable, ["60"], {stdio:"ignore"});
  await new Promise((resolve,reject) => { fake.once("spawn",resolve); fake.once("error",reject); });
  globalThis.__syncordQueueAppPath = path.join(resources,"app");
  const readVersion = () => JSON.parse(fs.readFileSync(path.join(resources,"app","syncord-version.json"))).version;
  try {
    await withUpdater(async module => {
      await stageReady(module);
      const state = await module.handOffToInjector(injectorBin);
      assert.equal(state.phase,"awaiting-restart",state.detail);
      await new Promise(resolve => setTimeout(resolve,2300));
      assert.equal(fake.exitCode,null); assert.equal(fake.signalCode,null);
      assert.equal(readVersion(),OLD_VERSION,"an open Discord's bundles must remain untouched");
      assert.equal(module.restartForUpdate(),true);
      await new Promise(resolve => setTimeout(resolve,150));
      fake.kill();
      const receipt = path.join(userData,"Syncord","staging",NEW_VERSION,"update-result.json");
      const deadline = Date.now()+15000;
      let result;
      do {
        await new Promise(resolve => setTimeout(resolve,100));
        try { result=JSON.parse(fs.readFileSync(receipt)); } catch {}
      } while (result?.phase !== "installed" && result?.phase !== "failed" && Date.now()<deadline);
      assert.equal(result?.phase,"installed",result?.detail);
      assert.equal(readVersion(),NEW_VERSION);
      const listing=spawnSync(injectorBin,["--list"],{encoding:"utf8",env:{...process.env,SYNCORD_DISCORD_PATH:target}});
      assert.equal(listing.status,0,listing.stderr);
      assert.match(listing.stdout,new RegExp(`injected, verified, v${NEW_VERSION.replaceAll(".","\\.")}`));
    });
  } finally { fake.kill(); delete globalThis.__syncordQueueAppPath; }
});


test("Emergency Lockdown cancels a verified waiting worker and refuses restart", async () => {
  seedInstall(OLD_VERSION);
  writeDescriptor(NEW_VERSION, `syncord-${NEW_VERSION}-test.tar.gz`, writeAsset(NEW_VERSION));
  const worker = path.join(scratch, "cancel-worker");
  const pidFile = path.join(scratch, "cancel-worker.pid");
  fs.writeFileSync(worker, `#!${process.execPath}\nconst fs=require('fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdout.write('SYNCORD_UPDATE_READY:${NEW_VERSION}\\n');setTimeout(()=>{},10000);\n`, {mode:0o755});
  globalThis.__syncordQueueAppPath = path.join(discordResources,"app");
  try {
    await withUpdater(async module => {
      await stageReady(module);
      assert.equal((await module.handOffToInjector(worker)).phase,"awaiting-restart");
      module.cancelPendingUpdate();
      module.modes.enableLockdown("test explicit cancellation");
      assert.equal(module.restartForUpdate(),false);
      assert.equal(module.updateStatus().lastError,"lockdown");
      assert.equal(installedVersion(),OLD_VERSION);
    });
  } finally {
    if (fs.existsSync(pidFile)) {try {process.kill(Number(fs.readFileSync(pidFile,"utf8")));} catch {}}
    delete globalThis.__syncordQueueAppPath;
  }
});


test("Injector discovery uses the shipped macOS name and a portable Linux location", async () => {
  await withUpdater(module => {
    const paths = module.injectorSearchPaths();
    if (process.platform === "darwin") {
      assert.equal(paths[0],"/Applications/Syncord Injector.app/Contents/MacOS/Syncord Injector");
      assert.ok(paths.some(candidate => candidate.includes("Syncord Installer.app")),"legacy names remain supported");
    } else if (process.platform === "linux") {
      assert.ok(paths.some(candidate => candidate.endsWith("/.local/share/Syncord/syncord-injector")));
    }
    if (process.platform !== "win32") {
      const nonExecutable = path.join(scratch,"non-executable-injector");
      fs.writeFileSync(nonExecutable,"not an executable",{mode:0o644});
      assert.equal(module.isExecutableFile(nonExecutable,true),false,"a non-executable candidate must not throw during discovery");
    }
  });
});
