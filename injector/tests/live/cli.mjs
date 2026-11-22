/**
 * Live end-to-end test of the Injector binary.
 *
 * Run: `node injector/tests/live/cli.mjs`
 *
 * The unit and integration suites use a throwaway key compiled into a test
 * build. This runs the **real** executable, built with a real key, against a
 * synthetic Discord install in a temporary directory — the same binary and the
 * same code path the Electron client would spawn.
 *
 * Nothing here touches a real Discord. `SYNCORD_DISCORD_PATH` pins discovery to
 * a temporary tree, and every write lands under it.
 *
 * What it covers that the other suites do not:
 *
 *   * `--list` against a real filesystem, including the injected/unverified
 *     distinction;
 *   * a complete `--apply-staged` cycle: a genuine `tar.gz` built and signed the
 *     way `src/main/security/updater.ts` writes it, installed over a live
 *     install, with the result verified afterwards;
 *   * the refusals, each of which must leave the install untouched;
 *   * that a closed stdout (`| head`) does not panic.
 *
 * The GUI window itself is not here — it is covered by `tests/frontend/` plus a
 * manual launch, because driving a native window needs a display.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INJECTOR_ROOT = path.resolve(HERE, "..", "..");

// Shared with the TypeScript suites so every cargo invocation is capped the same
// way; see `scripts/tests/cargo-jobs.mjs` for why the cap exists. Imported after
// `HERE` exists, which a `const` above it would not have.
const { CARGO_ENV, CARGO_JOB_FLAGS, injectorBuildAllowed, runCargoSync } = await import(
  path.join(INJECTOR_ROOT, "..", "scripts", "tests", "cargo-jobs.mjs")
);

if (!injectorBuildAllowed()) throw new Error("Injector compilation requires explicit authorization: SYNCORD_ALLOW_INJECTOR_BUILD=1");

/** The payload members, in the order the packagers use. */
const PAYLOAD_MEMBERS = [
  "main.js",
  "preload.js",
  "renderer.js",
  "integrity.manifest.json",
  "syncord-version.json",
];

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, ok: Boolean(condition), detail });
  if (!condition) console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "syncord-live-"));
const bin = path.join(tmp, "syncord-injector");
const resources = path.join(tmp, "discord", "Resources");
const payload = path.join(tmp, "payload");
fs.mkdirSync(resources, { recursive: true });
fs.mkdirSync(payload, { recursive: true });
fs.writeFileSync(path.join(resources, "app.asar"), "pretend this is Discord");

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pubB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");

// Build the real binary with the real key. This is the step that makes the rest
// of the test meaningful: a build with the placeholder key verifies nothing.
console.log("[live] building the Injector with a real key…");
const build = runCargoSync(["build", ...CARGO_JOB_FLAGS], {
  cwd: INJECTOR_ROOT,
  encoding: "utf-8",
  // A private target directory: the verification key is compiled in, so this
  // suite cannot share `injector/target/` with any other suite that builds with
  // a different key. Whichever build lands last is the binary each copies.
  env: { ...process.env, SYNCORD_INTEGRITY_KEY: pubB64, CARGO_TARGET_DIR: path.join(tmp, "target"), ...CARGO_ENV },
});
if (build.status !== 0) {
  console.error(build.stderr || build.stdout);
  process.exit(1);
}
fs.copyFileSync(path.join(tmp, "target", "debug", "syncord-injector"), bin);

/** Write a signed payload directory for `version`. */
function writePayload(dir, version) {
  fs.mkdirSync(dir, { recursive: true });
  const bodies = {
    "main.js": `// main v${version}\n`,
    "preload.js": `// preload v${version}\n`,
    "renderer.js": `// renderer v${version}\n`,
  };
  const files = [];
  for (const [name, body] of Object.entries(bodies)) {
    fs.writeFileSync(path.join(dir, name), body);
    files.push({ name, sha256: createHash("sha256").update(body).digest("hex") });
  }
  const canonical = JSON.stringify({ version: 1, algorithm: "ed25519", files });
  const signature = sign(null, Buffer.from(canonical), privateKey).toString("base64");
  fs.writeFileSync(
    path.join(dir, "integrity.manifest.json"),
    JSON.stringify({ ...JSON.parse(canonical), signature }, null, 2),
  );
  fs.writeFileSync(path.join(dir, "syncord-version.json"), `${JSON.stringify({ version }, null, 2)}\n`);
}

/**
 * Stage a release the way `src/main/security/updater.ts` does: a `release.json`
 * and the asset **side by side** in one directory.
 */
function stageRelease(root, version) {
  const dir = path.join(root, "staging", version);
  fs.mkdirSync(dir, { recursive: true });

  const source = fs.mkdtempSync(path.join(os.tmpdir(), "payload-"));
  writePayload(source, version);

  const asset = `syncord-${version}-test.tar.gz`;
  spawnSync("tar", ["-czf", path.join(dir, asset), "-C", source, ...PAYLOAD_MEMBERS], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    encoding: "utf-8",
  });
  const sha256 = createHash("sha256").update(fs.readFileSync(path.join(dir, asset))).digest("hex");
  fs.writeFileSync(path.join(dir, "release.json"), `${JSON.stringify({ version, asset, sha256 }, null, 2)}\n`);
  return { dir, release: path.join(dir, "release.json") };
}

const run = (args, extraEnv = {}) => {
  const result = spawnSync(bin, args, {
    encoding: "utf-8",
    env: { ...process.env, SYNCORD_DISCORD_PATH: resources, ...extraEnv },
  });
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
};

// ── 1. Discovery ──────────────────────────────────────────────────────────────

writePayload(payload, "1.4.0");
let state = run(["--list"]);
check("--list exits 0", state.code === 0, state.err);
check("--list finds the pinned install", state.out.includes("1 Discord install(s) found"), state.out);
check("and reports it as not injected", /custom\s+not injected/.test(state.out), state.out);
check("and verifies the bundled payload", state.out.includes("Bundled payload: verified, v1.4.0"), state.out);

// A closed stdout must not be a panic. `| head` is an ordinary thing to do.
const piped = spawnSync("/bin/sh", ["-c", `"${bin}" --list | head -2`], {
  encoding: "utf-8",
  env: { ...process.env, SYNCORD_DISCORD_PATH: resources },
});
check("a closed stdout does not panic", !piped.stdout.includes("panicked") && !piped.stderr.includes("panicked"), piped.stderr.slice(0, 200));

// ── 2. Refusal: nothing installed yet ─────────────────────────────────────────

const stage = stageRelease(tmp, "1.5.0");
let result = run(["--apply-staged", stage.release, "custom"]);
check("--apply-staged refuses when Syncord is not installed", result.code !== 0, `exit ${result.code}`);
check("and says so", result.err.includes("not installed"), result.err);
check("and points at the GUI", result.err.includes("Injector window"), result.err);
check("nothing was written", !fs.existsSync(path.join(resources, "app")));

// ── 3. Seed an install the way `inject` produces one ──────────────────────────

fs.cpSync(payload, path.join(resources, "app"), { recursive: true });
fs.renameSync(path.join(resources, "app.asar"), path.join(resources, "_app.asar"));
fs.writeFileSync(path.join(resources, "app", "package.json"), '{\n  "name": "discord",\n  "main": "main.js",\n  "private": true\n}\n');

state = run(["--list"]);
check("an installed, verifiable install is reported as such", /custom\s+injected, verified, v1\.4\.0/.test(state.out), state.out);

// A bundle edited outside Syncord must be *unverified*, not "modified".
fs.appendFileSync(path.join(resources, "app", "renderer.js"), "// tampered\n");
state = run(["--list"]);
check("an edited bundle reports unverified", /injected, UNVERIFIED/.test(state.out), state.out);
check("and does not accuse the user of tampering", !/MODIFIED|Modified/.test(state.out), state.out);
// Restore, so the rest of the test has a valid install.
fs.rmSync(path.join(resources, "app", "renderer.js"));
fs.cpSync(path.join(payload, "renderer.js"), path.join(resources, "app", "renderer.js"));

// ── 4. The happy path ─────────────────────────────────────────────────────────

result = run(["--apply-staged", stage.release, "custom"]);
check("--apply-staged succeeds", result.code === 0, `${result.err}${result.out}`);
check("and says to restart Discord", result.out.includes("Restart Discord"), result.out);

state = run(["--list"]);
check("the install is now the new version", /injected, verified, v1\.5\.0/.test(state.out), state.out);
check(
  "the version stamp was updated",
  fs.readFileSync(path.join(resources, "app", "syncord-version.json"), "utf-8").includes("1.5.0"),
);
check("Discord's asar was left alone", fs.existsSync(path.join(resources, "_app.asar")));
check("and not restored by mistake", !fs.existsSync(path.join(resources, "app.asar")));

// The manifest must describe the *new* bundles. This is the regression the live
// run found: the bundles were replaced while the old manifest stayed behind.
{
  const manifest = JSON.parse(fs.readFileSync(path.join(resources, "app", "integrity.manifest.json"), "utf-8"));
  const renderer = manifest.files.find((f) => f.name === "renderer.js").sha256;
  const actual = createHash("sha256")
    .update(fs.readFileSync(path.join(resources, "app", "renderer.js")))
    .digest("hex");
  check("the installed manifest describes the new bundles", renderer === actual, `${renderer.slice(0, 12)} vs ${actual.slice(0, 12)}`);
}

// ── 5. Refusals, each of which must change nothing ───────────────────────────

const before = fs.readFileSync(path.join(resources, "app", "renderer.js"), "utf-8");

// A descriptor whose digest does not match the asset.
const badDigest = path.join(tmp, "bad-digest");
fs.mkdirSync(badDigest, { recursive: true });
fs.copyFileSync(stage.release, path.join(badDigest, "release.json"));
const descriptor = JSON.parse(fs.readFileSync(stage.release, "utf-8"));
fs.copyFileSync(path.join(stage.dir, descriptor.asset), path.join(badDigest, descriptor.asset));
descriptor.sha256 = "0".repeat(64);
fs.writeFileSync(path.join(badDigest, "release.json"), JSON.stringify(descriptor, null, 2));
result = run(["--apply-staged", path.join(badDigest, "release.json"), "custom"]);
check("a digest mismatch is refused", result.code !== 0, `exit ${result.code}`);
check("and says why", result.err.includes("digest"), result.err);

// A descriptor whose version disagrees with the payload inside it.
const lying = path.join(tmp, "lying");
fs.mkdirSync(lying, { recursive: true });
fs.copyFileSync(stage.release, path.join(lying, "release.json"));
fs.copyFileSync(path.join(stage.dir, descriptor.asset), path.join(lying, descriptor.asset));
const lyingDescriptor = JSON.parse(fs.readFileSync(stage.release, "utf-8"));
lyingDescriptor.version = "9.9.9";
fs.writeFileSync(path.join(lying, "release.json"), JSON.stringify(lyingDescriptor, null, 2));
result = run(["--apply-staged", path.join(lying, "release.json"), "custom"]);
check("a descriptor that disagrees with its payload is refused", result.code !== 0, `exit ${result.code}`);
check("and says why", result.err.includes("9.9.9") || result.err.includes("but contains"), result.err);

// An asset name that is not a plain filename.
const traversal = path.join(tmp, "traversal");
fs.mkdirSync(traversal, { recursive: true });
const traversalDescriptor = { version: "1.5.0", asset: "../../../etc/passwd", sha256: "0".repeat(64) };
fs.writeFileSync(path.join(traversal, "release.json"), JSON.stringify(traversalDescriptor, null, 2));
result = run(["--apply-staged", path.join(traversal, "release.json"), "custom"]);
check("a traversal asset name is refused", result.code !== 0, `exit ${result.code}`);
check("and says why", result.err.includes("plain filename"), result.err);

// A payload signed by the wrong key.
const wrongKey = generateKeyPairSync("ed25519");
const forged = fs.mkdtempSync(path.join(os.tmpdir(), "forged-"));
writePayload(forged, "1.6.0");
{
  const bodies = {
    "main.js": "// main v1.6.0\n",
    "preload.js": "// preload v1.6.0\n",
    "renderer.js": "// renderer v1.6.0\n",
  };
  const files = Object.entries(bodies).map(([name, body]) => ({
    name,
    sha256: createHash("sha256").update(body).digest("hex"),
  }));
  const canonical = JSON.stringify({ version: 1, algorithm: "ed25519", files });
  const signature = sign(null, Buffer.from(canonical), wrongKey.privateKey).toString("base64");
  fs.writeFileSync(
    path.join(forged, "integrity.manifest.json"),
    JSON.stringify({ ...JSON.parse(canonical), signature }, null, 2),
  );
}
const forgedStage = path.join(tmp, "staging", "1.6.0");
fs.mkdirSync(forgedStage, { recursive: true });
const forgedAsset = "syncord-1.6.0-test.tar.gz";
spawnSync("tar", ["-czf", path.join(forgedStage, forgedAsset), "-C", forged, ...PAYLOAD_MEMBERS], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    encoding: "utf-8",
  });
fs.writeFileSync(
  path.join(forgedStage, "release.json"),
  JSON.stringify(
    {
      version: "1.6.0",
      asset: forgedAsset,
      sha256: createHash("sha256").update(fs.readFileSync(path.join(forgedStage, forgedAsset))).digest("hex"),
    },
    null,
    2,
  ),
);
result = run(["--apply-staged", path.join(forgedStage, "release.json"), "custom"]);
check("a payload signed by the wrong key is refused", result.code !== 0, `exit ${result.code}`);
check("and says why", result.err.includes("signed") || result.err.includes("unpack"), result.err);

check(
  "after every refusal the install is byte-identical",
  fs.readFileSync(path.join(resources, "app", "renderer.js"), "utf-8") === before,
);

// ── 6. Ambiguity is refused rather than guessed ──────────────────────────────

result = run(["--apply-staged", stage.release, "no-such-branch"]);
check("an unknown branch is refused", result.code !== 0, `exit ${result.code}`);
check("and named", result.err.includes("no-such-branch"), result.err);

// ── 7. A build with no key verifies nothing ───────────────────────────────────

console.log("[live] rebuilding with the placeholder key…");
const noKey = runCargoSync(["build", ...CARGO_JOB_FLAGS], {
  cwd: INJECTOR_ROOT,
  encoding: "utf-8",
  env: { ...process.env, CARGO_TARGET_DIR: path.join(tmp, "target"), ...CARGO_ENV },
});
if (noKey.status === 0) {
  const noKeyBin = path.join(tmp, "nokey-injector");
  fs.copyFileSync(path.join(tmp, "target", "debug", "syncord-injector"), noKeyBin);
  const noKeyState = spawnSync(noKeyBin, ["--list"], {
    encoding: "utf-8",
    env: { ...process.env, SYNCORD_DISCORD_PATH: resources },
  });
  check("a build with no key reports the payload as unverifiable", noKeyState.stdout.includes("no signing key"), noKeyState.stdout);
} else {
  check("a build with no key builds", false, noKey.stderr.slice(0, 200));
}

// Leave the working tree with a key-built binary, matching a release build.
runCargoSync(["build", ...CARGO_JOB_FLAGS], {
  cwd: INJECTOR_ROOT,
  encoding: "utf-8",
  env: { ...process.env, SYNCORD_INTEGRITY_KEY: pubB64, CARGO_TARGET_DIR: path.join(tmp, "target"), ...CARGO_ENV },
});

// ── Report ────────────────────────────────────────────────────────────────────

fs.rmSync(tmp, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
for (const result of failed) console.log(`FAIL ${result.name}${result.detail ? ` — ${result.detail}` : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} live assertions passed`);

if (failed.length > 0) {
  console.error(`\nFAIL ${failed.length} live assertions`);
  process.exit(1);
}
console.log("PASS: the real binary installs, updates, and refuses correctly");
