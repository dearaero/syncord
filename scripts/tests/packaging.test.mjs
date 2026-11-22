/**
 * Packaging test suite.
 *
 * Run: `node --test scripts/tests/packaging.test.mjs`
 *
 * Two packagers produce the artifacts a release publishes:
 *
 *   scripts/package-payload.mjs       → the per-platform update asset
 *   injector/scripts/package.mjs      → the standalone Injector + payload
 *
 * Both are checked here for the property that matters most and is least
 * visible: the artifact must be something the *other* half of the system can
 * consume. An update archive the Injector refuses, or an Injector that cannot
 * find its own payload, both ship cleanly, download cleanly, and fail in front
 * of a user at the moment they press a button.
 *
 * The rule the Injector enforces is a security control — `PAYLOAD_ALLOWED` in
 * `injector/crates/syncord-core/src/archive.rs` is an allowlist, and
 * `safe_entry_path` refuses everything else — so the packagers read that
 * allowlist out of the Rust source rather than keeping a copy. These tests
 * assert both that the packagers follow it and that the check still fails when
 * they do not, because a check that cannot fail is not a check.
 *
 * Nothing here touches a real Discord, and nothing is signed with a real key.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { CARGO_ENV, CARGO_JOB_FLAGS, injectorBuildAllowed, runCargoSync } from "./cargo-jobs.mjs";

const { test, before, after } = await import("node:test");

// Resolved from this file, not from `process.cwd()`. A test that only works
// when invoked from the repository root is a test that silently stops testing
// anything the moment CI runs it from a subdirectory — which the `rust` job in
// The explicitly authorized local Injector build does, with working directory
// `injector/`.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const INJECTOR = path.join(REPO, "injector");
const PAYLOAD_SCRIPT = path.join(REPO, "scripts", "package-payload.mjs");
const INJECTOR_SCRIPT = path.join(INJECTOR, "scripts", "package.mjs");

const PLATFORMS = ["windows-x64", "mac-arm64", "linux-x64"];
const VERSION = "9.9.9-test";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "syncord-pkg-test-"));
const distDir = path.join(scratch, "dist");
const outDir = path.join(scratch, "release");
/**
 * A private Cargo target directory.
 *
 * The Injector's verification key is compiled in, so this suite and
 * `update-e2e.test.mjs` cannot share `injector/target/`: both build with a
 * different throwaway key, `node --test` runs files in parallel, and whichever
 * build lands last is the binary each suite then copies. Sharing made this
 * suite pass alone and fail under `pnpm test`.
 */
const targetDir = path.join(scratch, "target");

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** A `dist/` the payload packager will accept: three bundles and a manifest. */
function writeDist() {
  fs.mkdirSync(distDir, { recursive: true });
  for (const name of ["main.js", "preload.js", "renderer.js"]) {
    fs.writeFileSync(path.join(distDir, name), `// ${name} for the packaging test\n`);
  }
  fs.writeFileSync(
    path.join(distDir, "integrity.manifest.json"),
    `${JSON.stringify(
      { version: 1, algorithm: "ed25519", files: [{ name: "main.js", sha256: "0".repeat(64) }], signature: "x" },
      null,
      2,
    )}\n`,
  );
}

/** A signed payload directory, for the Injector packager. */
function writeSignedPayload(dir) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pubB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");

  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (const name of ["main.js", "preload.js", "renderer.js"]) {
    const body = `// ${name} payload ${VERSION}\n`;
    fs.writeFileSync(path.join(dir, name), body);
    files.push({ name, sha256: crypto.createHash("sha256").update(body).digest("hex") });
  }
  const canonical = JSON.stringify({ version: 1, algorithm: "ed25519", files });
  const signature = crypto.sign(null, Buffer.from(canonical), privateKey).toString("base64");
  fs.writeFileSync(
    path.join(dir, "integrity.manifest.json"),
    `${JSON.stringify({ ...JSON.parse(canonical), signature }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(dir, "syncord-version.json"),
    `${JSON.stringify({ version: VERSION }, null, 2)}\n`,
  );
  return pubB64;
}

/**
 * Has Injector compilation been explicitly authorized with a Rust toolchain?
 *
 * The two Injector-artifact tests need one. Without it they are **skipped, and
 * reported as skipped** — not returned from after a log line, which is
 * indistinguishable from a pass. The Rust CI job installs the pinned toolchain,
 * on explicit manual runs; normal `pnpm test` never opts into compilation.
 */
const NO_CARGO =
  injectorBuildAllowed() && spawnSync("cargo", ["--version"], { encoding: "utf-8" }).status === 0
    ? false
    : { skip: "Injector compilation requires explicit authorization and a Rust toolchain" };

/** Run the payload packager against the scratch fixtures, not the repo. */
const runPackager = (script = PAYLOAD_SCRIPT, extra = []) =>
  run(process.execPath, [script, "--dist", distDir, "--out", outDir, ...extra], {
    env: { ...process.env, Syncord_RELEASE_VERSION: VERSION },
  });

const run = (command, args, options = {}) => {
  const result = command === "cargo"
    ? runCargoSync(args, { encoding: "utf-8", ...options })
    : spawnSync(command, args, { encoding: "utf-8", ...options });
  return {
    code: result.status,
    out: result.stdout ?? "",
    err: result.stderr ?? "",
    all: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
};

/** The names an archive contains, as the Injector's extractor would see them. */
function listArchive(file) {
  // GNU tar cannot read ZIP archives; use the ZIP reader on both macOS and Linux.
  const listed = file.endsWith(".zip")
    ? run("unzip", ["-Z1", file])
    : run("tar", ["-tzf", file]);
  assert.equal(listed.code, 0, `listing ${path.basename(file)} failed: ${listed.err}`);
  return listed.out
    .split("\n")
    .map((line) => line.trim().replace(/^\.\//, ""))
    .filter(Boolean);
}

/** The contents of one archive member, as text. */
function extractMember(archive, member) {
  const extracted = run("tar", ["-xzf", archive, "-O", member]);
  assert.equal(extracted.code, 0, `extracting ${member} failed: ${extracted.err}`);
  return extracted.out;
}

/** Every file under a directory, recursively, as absolute paths. */
function walkFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, found);
    else found.push(full);
  }
  return found;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

before(() => {
  writeDist();
});

after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

// ── The update asset ──────────────────────────────────────────────────────────

test("the payload packager produces one archive per platform", () => {
  const result = runPackager();
  assert.equal(result.code, 0, result.all);

  const assets = fs
    .readdirSync(outDir)
    .filter((name) => name.endsWith(".tar.gz"))
    .sort();
  assert.equal(
    assets.length,
    6,
    `expected one archive per platform in ${PLATFORMS.join(", ")} and the rest; got ${assets.join(", ")}`,
  );
  for (const platform of PLATFORMS) {
    assert.ok(
      assets.includes(`syncord-${VERSION}-${platform}.tar.gz`),
      `missing syncord-${VERSION}-${platform}.tar.gz`,
    );
  }
});

test("the version variable is the one scripts/release.mjs also reads", () => {
  // Two scripts, one contract: this one names the archives, `release.mjs` signs
  // a descriptor listing them by name. If they read different environment
  // variables — or one accepts a spelling the other does not — a release goes
  // out whose descriptor names files that are not attached, and every client
  // declines it with nothing anyone would see.
  //
  // Asserted by behaviour rather than by grepping the source: a grep would pass
  // while a `readEnv` shim quietly made the two accept different spellings,
  // which is the bug this is looking for.
  const out = path.join(scratch, "version-check");
  const result = run(process.execPath, [PAYLOAD_SCRIPT, "--dist", distDir, "--out", out], {
    env: { ...process.env, Syncord_RELEASE_VERSION: "7.7.7" },
  });
  assert.equal(result.code, 0, result.all);

  const archives = fs.readdirSync(out).filter((name) => name.endsWith(".tar.gz"));
  assert.ok(archives.length > 0, "no archives produced");
  for (const name of archives) {
    assert.ok(
      name.startsWith("syncord-7.7.7-"),
      `the archive must be named for the requested version; got ${name}`,
    );
  }
});

test("an update archive contains exactly what the Injector allows", () => {
  const entries = listArchive(path.join(outDir, `syncord-${VERSION}-linux-x64.tar.gz`));
  const files = entries.filter((entry) => entry !== "." && !entry.endsWith("/"));

  assert.deepEqual(
    files.sort(),
    [
      "integrity.manifest.json",
      "main.js",
      "preload.js",
      "renderer.js",
      "syncord-version.json",
    ],
    "the archive must be the five payload files, flat at the root",
  );
  assert.equal(
    entries.filter((entry) => entry.includes("/") && entry !== ".").length,
    0,
    "no nested paths: the Injector's allowlist admits root-level files only",
  );
});

test("the archives are byte-reproducible", () => {
  const file = path.join(outDir, `syncord-${VERSION}-mac-arm64.tar.gz`);
  const first = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

  const rebuild = runPackager();
  assert.equal(rebuild.code, 0, rebuild.all);

  const second = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  assert.equal(
    first,
    second,
    "a rebuild must produce identical bytes, or a changed digest means nothing",
  );
});

test("the version stamp is regenerated, not copied from a stale dist", () => {
  // A stamp left over from an earlier build in `dist/` is the failure this
  // guards: the client would install a new payload and report the old version.
  fs.writeFileSync(
    path.join(distDir, "syncord-version.json"),
    `${JSON.stringify({ version: "0.0.1-stale" }, null, 2)}\n`,
  );
  try {
    const result = runPackager();
    assert.equal(result.code, 0, result.all);

    const extracted = path.join(scratch, "stamp-check");
    fs.rmSync(extracted, { recursive: true, force: true });
    fs.mkdirSync(extracted, { recursive: true });
    const untarred = run("tar", [
      "-xzf", path.join(outDir, `syncord-${VERSION}-linux-x64.tar.gz`),
      "-C", extracted,
    ]);
    assert.equal(untarred.code, 0, untarred.err);
    const stamp = JSON.parse(fs.readFileSync(path.join(extracted, "syncord-version.json"), "utf-8"));
    assert.equal(stamp.version, VERSION);
  } finally {
    fs.rmSync(path.join(distDir, "syncord-version.json"), { force: true });
  }
});

test("the allowlist check rejects an archive the Injector would refuse", () => {
  // Proves the check is load-bearing. The packager is made to add a file the
  // Injector does not accept, and must refuse to produce a release rather than
  // publishing something that fails at extraction time on a user's machine.
  //
  // The injection point is the *member list*, not the staging directory. Adding
  // a file to the directory is no longer enough to get it into the archive —
  // which is the improvement this test now also covers — so the list is what has
  // to be tampered with for the check to be reached at all.
  const original = fs.readFileSync(PAYLOAD_SCRIPT, "utf-8");
  const anchor = 'const PAYLOAD_FILES = [\n  "main.js",';
  assert.ok(original.includes(anchor), "the injection point moved; this test is no longer testing anything");

  // Two edits, because two things have to agree: the file has to exist in the
  // staging directory *and* be named as a member. Adding only the member makes
  // `tar` fail first, which is a correct refusal but not the one under test.
  const stageAnchor = "    freezeTimestamps(stage);";
  assert.ok(original.includes(stageAnchor), "the staging anchor moved; this test is no longer testing anything");

  const tampered = original
    .replace(anchor, 'const PAYLOAD_FILES = [\n  "postinstall.sh",\n  "main.js",')
    .replace(
      stageAnchor,
      '    fs.writeFileSync(path.join(stage, "postinstall.sh"), "#!/bin/sh\\n");\n' + stageAnchor,
    );
  assert.notEqual(tampered, original);

  // The copy has to sit in `scripts/`, because the script resolves the
  // repository — and therefore `injector/crates/…/archive.rs` — from its own
  // `__dirname`.
  const copy = path.join(REPO, "scripts", ".packaging-tampered.mjs");
  fs.writeFileSync(copy, tampered);
  try {
    const result = runPackager(copy);
    assert.notEqual(result.code, 0, "a payload with a disallowed file must not package");
    assert.match(result.err, /not in the Injector's payload allowlist/);
  } finally {
    fs.rmSync(copy, { force: true });
  }
});

test("the payload contains only literal ustar files, including on macOS with file metadata", () => {
  if (process.platform === "darwin") {
    const attr = run("xattr", ["-w", "com.syncord.packaging-test", "metadata", path.join(distDir, "main.js")]);
    assert.equal(attr.code, 0, attr.all);
  }
  const result = runPackager();
  assert.equal(result.code, 0, result.all);
  const archive = gunzipSync(fs.readFileSync(path.join(outDir, `syncord-${VERSION}-mac-arm64.tar.gz`)));
  const names = [];
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start, end) => header.subarray(start, end).toString("utf-8").split("\0", 1)[0];
    assert.ok(["", "0"].includes(text(156, 157)), "payloads must have no PAX overrides, links or directories");
    assert.equal(text(345, 500), "", "every payload must be a root-level file");
    names.push(text(0, 100));
    offset += 512 + Math.ceil(Number.parseInt(text(124, 136).trim(), 8) / 512) * 512;
  }
  assert.deepEqual(names.sort(), ["main.js", "preload.js", "renderer.js", "integrity.manifest.json", "syncord-version.json"].sort());
});

test("the raw archive gate catches metadata hidden by the macOS tar listing", { skip: process.platform !== "darwin" }, () => {
  const original = fs.readFileSync(PAYLOAD_SCRIPT, "utf-8");
  const stageAnchor = "    freezeTimestamps(stage);";
  const environment = "env: { ...process.env, ...TAR_ENV }";
  assert.ok(original.includes(stageAnchor) && original.includes(environment));
  const broken = original.replace(environment, "env: { ...process.env, COPYFILE_DISABLE: undefined }").replace('"--format=ustar", ', "").replace(
    stageAnchor,
    '    spawnSync("xattr", ["-w", "com.syncord.packaging-test", "metadata", path.join(stage, "main.js")]);\n' + stageAnchor,
  );
  const copy = path.join(REPO, "scripts", ".packaging-metadata.mjs");
  fs.writeFileSync(copy, broken);
  try {
    const result = runPackager(copy);
    assert.notEqual(result.code, 0, "metadata in the tar must prevent publication");
    assert.match(result.err, /macOS metadata entry|unsupported tar entry/);
  } finally {
    fs.rmSync(copy, { force: true });
  }
});

// ── The standalone Injector ───────────────────────────────────────────────────

test("a stray file in the staging directory cannot reach the archive", () => {
  // The structural half of the AppleDouble fix: `tar` is given an explicit
  // member list, so a file that nobody asked for — a macOS `._` entry, an
  // editor's swap file, a previous build's leftover — is not archived even if it
  // is sitting right there.
  fs.writeFileSync(path.join(distDir, "postinstall.sh"), "#!/bin/sh\n");
  try {
    const result = runPackager();
    assert.equal(result.code, 0, result.all);

    const entries = listArchive(path.join(outDir, `syncord-${VERSION}-linux-x64.tar.gz`));
    assert.ok(
      !entries.includes("postinstall.sh"),
      `an unrequested file reached the archive: ${entries.join(", ")}`,
    );
    assert.equal(
      entries.filter((e) => /(^|\/)\._|\.DS_Store$/.test(e)).length,
      0,
      "no AppleDouble or Finder metadata may ever be archived",
    );
  } finally {
    fs.rmSync(path.join(distDir, "postinstall.sh"), { force: true });
  }
});

test("the Injector packager refuses a payload that is missing a file", () => {
  // The failure this prevents is a download that works, a window that opens,
  // and Inject disabled for a reason the user cannot act on.
  const incomplete = path.join(scratch, "incomplete-payload");
  fs.mkdirSync(incomplete, { recursive: true });
  fs.writeFileSync(path.join(incomplete, "main.js"), "// main\n");

  const result = run(process.execPath, [
    INJECTOR_SCRIPT,
    "--payload", incomplete,
    "--out", path.join(scratch, "unused"),
    "--version", VERSION,
    "--target", "linux-x86_64",
    "--binary", "/bin/sh",
  ]);
  assert.notEqual(result.code, 0);
  assert.match(result.err, /is missing .*renderer\.js/);
});

test("the Injector packager carries both the binary and the payload", NO_CARGO, () => {
  const installerVersion = "0.1.5";
  const payloadDir = path.join(scratch, "injector-payload");
  const pubB64 = writeSignedPayload(payloadDir);

  // The binary must be built with the key the payload is signed with, or its
  // own self-check refuses the payload — which is the point of the self-check,
  // and is why this test builds one.
  const build = run("cargo", ["build", "--release", ...CARGO_JOB_FLAGS], {
    cwd: INJECTOR,
    env: { ...process.env, SYNCORD_INTEGRITY_KEY: pubB64, CARGO_TARGET_DIR: targetDir, ...CARGO_ENV },
  });
  assert.equal(build.code, 0, `cargo build --release failed:\n${build.err}`);

  const targetOut = path.join(scratch, "injector-artifacts");
  const packaged = run(process.execPath, [
    INJECTOR_SCRIPT,
    "--payload", payloadDir,
    "--out", targetOut,
    "--version", installerVersion,
    "--target", "linux-x86_64",
    // The binary this suite just built, not the one in the shared target
    // directory. The packager's self-check runs the artifact and refuses if it
    // cannot verify the payload, so pointing it at a build made with another
    // key fails with exactly that message.
    "--binary", path.join(targetDir, "release", "syncord-injector"),
  ]);
  assert.equal(packaged.code, 0, packaged.all);

  const archive = path.join(targetOut, `syncord-injector-linux-x86_64-${installerVersion}.tar.gz`);
  assert.ok(fs.existsSync(archive), `expected ${archive}`);

  const entries = listArchive(archive);
  const root = `syncord-injector-linux-x86_64-${installerVersion}`;
  assert.ok(entries.includes(`${root}/syncord-injector`), `binary missing: ${entries.join(", ")}`);
  for (const name of ["main.js", "preload.js", "renderer.js", "integrity.manifest.json", "syncord-version.json"]) {
    assert.ok(entries.includes(`${root}/payload/${name}`), `payload/${name} missing from the archive`);
  }

  // The index the release step reads.
  const index = JSON.parse(
    fs.readFileSync(path.join(targetOut, `syncord-injector-linux-x86_64-${installerVersion}.json`), "utf-8"),
  );
  assert.equal(index.version, installerVersion);
  assert.equal(index.payloadVersion, VERSION);
  assert.match(index.sha256, /^[0-9a-f]{64}$/);
  assert.equal(
    index.sha256,
    crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex"),
    "the index digest must be the digest of the archive next to it",
  );
  assert.equal(index.codesigned, false, "nothing here is identity-signed, and the index says so");
});

test("the Linux archive carries a launcher entry and an icon theme", NO_CARGO, () => {
  const payloadDir = path.join(scratch, "injector-payload-desktop");
  const pubB64 = writeSignedPayload(payloadDir);

  const build = run("cargo", ["build", "--release", ...CARGO_JOB_FLAGS], {
    cwd: INJECTOR,
    env: { ...process.env, SYNCORD_INTEGRITY_KEY: pubB64, CARGO_TARGET_DIR: targetDir, ...CARGO_ENV },
  });
  assert.equal(build.code, 0, `cargo build --release failed:\n${build.err}`);

  const targetOut = path.join(scratch, "injector-desktop-artifacts");
  const packaged = run(process.execPath, [
    INJECTOR_SCRIPT,
    "--payload", payloadDir,
    "--out", targetOut,
    "--version", VERSION,
    "--target", "linux-x86_64",
    "--binary", path.join(targetDir, "release", "syncord-injector"),
  ]);
  assert.equal(packaged.code, 0, packaged.all);

  const entries = listArchive(path.join(targetOut, `syncord-injector-linux-x86_64-${VERSION}.tar.gz`));
  const root = `syncord-injector-linux-x86_64-${VERSION}`;

  // A Linux desktop shows an application because a `.desktop` file names it, and
  // that file finds its icon by looking up a name in the icon theme. Neither
  // exists by being extracted, so an archive without both displays nothing at
  // all — the binary runs, and there is no launcher to run it from.
  assert.ok(
    entries.includes(`${root}/syncord-injector.desktop`),
    `launcher entry missing: ${entries.join(", ")}`,
  );
  assert.ok(
    entries.includes(`${root}/install-desktop-entry.sh`),
    "nothing installs the launcher entry, so it is a file nobody reads",
  );

  // `hicolor` is the fallback theme every environment resolves, so an icon under
  // any other name is an icon no desktop finds. 48 is the default application
  // size and 256 is what a large launcher panel asks for.
  for (const size of [16, 24, 32, 48, 64, 128, 256]) {
    const member = `${root}/icons/hicolor/${size}x${size}/apps/syncord-injector.png`;
    assert.ok(entries.includes(member), `${size}px icon missing from the theme tree`);
  }

  // The entry has to actually say how to start the thing. A `.desktop` with a
  // missing or malformed key is silently dropped by the desktop, which is the
  // same as shipping no entry at all.
  const entry = extractMember(
    path.join(targetOut, `syncord-injector-linux-x86_64-${VERSION}.tar.gz`),
    `${root}/syncord-injector.desktop`,
  );
  assert.match(entry, /^\[Desktop Entry\]$/m, "no [Desktop Entry] group header");
  assert.match(entry, /^Type=Application$/m);
  assert.match(entry, /^Exec=\S+$/m, "Exec is missing or empty");
  assert.match(
    entry,
    /^Icon=syncord-injector$/m,
    "Icon must be the theme *name*, not a path; a path is resolved only by some desktops",
  );
  assert.match(entry, /^Terminal=false$/m);
  assert.match(
    entry,
    /^Categories=[\w-]+;$/m,
    "Categories must be from the registered list and end in a semicolon",
  );
  // A path in an `Exec` line is not shell-expanded, so a directory with a space
  // in it breaks every launcher that does not quote.
  assert.match(entry, /^Name=Syncord Injector$/m);
});

test("the Linux install script works, is idempotent, and writes only under the data dir", {
  skip: process.platform === "win32" ? "POSIX shell script" : false,
  ...NO_CARGO,
}, () => {
  const payloadDir = path.join(scratch, "injector-payload-installer");
  const pubB64 = writeSignedPayload(payloadDir);

  const build = run("cargo", ["build", "--release", ...CARGO_JOB_FLAGS], {
    cwd: INJECTOR,
    env: { ...process.env, SYNCORD_INTEGRITY_KEY: pubB64, CARGO_TARGET_DIR: targetDir, ...CARGO_ENV },
  });
  assert.equal(build.code, 0, `cargo build --release failed:\n${build.err}`);

  const targetOut = path.join(scratch, "injector-installer-artifacts");
  const packaged = run(process.execPath, [
    INJECTOR_SCRIPT,
    "--payload", payloadDir,
    "--out", targetOut,
    "--version", VERSION,
    "--target", "linux-x86_64",
    "--binary", path.join(targetDir, "release", "syncord-injector"),
  ]);
  assert.equal(packaged.code, 0, packaged.all);

  const archive = path.join(targetOut, `syncord-injector-linux-x86_64-${VERSION}.tar.gz`);
  const extracted = path.join(scratch, "installer-extracted");
  fs.mkdirSync(extracted, { recursive: true });
  const untar = run("tar", ["-xzf", archive, "-C", extracted]);
  assert.equal(untar.code, 0, untar.all);

  const dir = path.join(extracted, `syncord-injector-linux-x86_64-${VERSION}`);
  const script = path.join(dir, "install-desktop-entry.sh");

  // The tar has to keep the executable bit, or the documented `sh
  // install-desktop-entry.sh` is the only way to run it and that is a worse
  // first experience than the packaging deserves.
  assert.ok(
    (fs.statSync(script).mode & 0o111) !== 0,
    "install-desktop-entry.sh is not executable in the archive",
  );

  const data = path.join(scratch, "xdg-data-home");

  // Run it the way a user would, from inside the extracted directory.
  const install = run("sh", ["./install-desktop-entry.sh"], {
    cwd: dir,
    env: { ...process.env, XDG_DATA_HOME: data },
  });
  assert.equal(install.code, 0, `the install script failed:\n${install.all}`);

  const written = [
    "applications/syncord-injector.desktop",
    ...[16, 24, 32, 48, 64, 128, 256].map(
      (size) => `icons/hicolor/${size}x${size}/apps/syncord-injector.png`,
    ),
  ];
  for (const relative of written) {
    assert.ok(fs.existsSync(path.join(data, relative)), `the script did not write ${relative}`);
  }

  // The `Exec` line has to point at the real binary, or the launcher starts
  // nothing — and it is the install script, not the shipped entry, that can
  // know the absolute path.
  const installed = fs.readFileSync(path.join(data, "applications/syncord-injector.desktop"), "utf-8");
  const exec = /^Exec=(.*)$/m.exec(installed)?.[1] ?? "";
  assert.ok(exec.includes(path.join(dir, "syncord-injector")), `Exec does not name the binary: ${exec}`);

  // Cache tools may also create these two files on Linux. Reject any other
  // unexpected file, then compare the actual first and second installations.
  const firstFiles = walkFiles(data).map((file) => path.relative(data, file)).sort();
  const allowedFiles = new Set([...written, "icons/hicolor/icon-theme.cache", "applications/mimeinfo.cache"]);
  for (const file of firstFiles) {
    assert.ok(allowedFiles.has(file), `unexpected installed file: ${file}`);
  }
  const firstContents = new Map(written.map((file) => [file, fs.readFileSync(path.join(data, file))]));

  // Second run: the same two locations, no duplicates, still a success. An
  // install that has to be run once is an install nobody retries.
  const again = run("sh", ["./install-desktop-entry.sh"], {
    cwd: dir,
    env: { ...process.env, XDG_DATA_HOME: data },
  });
  assert.equal(again.code, 0, `the install script is not idempotent:\n${again.all}`);
  const after = [
    ...walkFiles(data).map((file) => path.relative(data, file)).sort(),
  ];
  assert.deepEqual(after, firstFiles, "a second run changed what is installed");
  for (const [file, contents] of firstContents) {
    assert.deepEqual(fs.readFileSync(path.join(data, file)), contents, `a second run changed ${file}`);
  }

  // Nothing outside the data directory. A launcher installer that writes to
  // /usr needs root, and one that writes to the working directory litters the
  // directory the user just extracted.
  assert.ok(
    !fs.existsSync(path.join(dir, ".local")),
    "the script wrote into the extracted directory",
  );

  // With no data directory to write to, it must say so rather than abort with
  // `set -u` and a bare "HOME: unbound variable".
  const homeless = run("sh", [script], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.notEqual(homeless.code, 0, "it claimed success with nowhere to install to");
  assert.match(
    `${homeless.out}${homeless.err}`,
    /XDG_DATA_HOME/,
    "the failure does not name the variable the user has to set",
  );
});

test("the Windows archive has no launcher entry, because its icon is in the executable", NO_CARGO, () => {
  const payloadDir = path.join(scratch, "injector-payload-windows");
  const pubB64 = writeSignedPayload(payloadDir);

  const build = run("cargo", ["build", "--release", ...CARGO_JOB_FLAGS], {
    cwd: INJECTOR,
    env: { ...process.env, SYNCORD_INTEGRITY_KEY: pubB64, CARGO_TARGET_DIR: targetDir, ...CARGO_ENV },
  });
  assert.equal(build.code, 0, `cargo build --release failed:\n${build.err}`);

  const targetOut = path.join(scratch, "injector-windows-artifacts");
  // The host binary is packaged under the Windows name. It is a Mach-O here,
  // but the packager's self-check runs whatever it was given, and this test is
  // about the archive's *shape* — the icon question is settled in
  // `scripts/tests/icons.test.mjs`, which reads build.rs.
  const packaged = run(process.execPath, [
    INJECTOR_SCRIPT,
    "--payload", payloadDir,
    "--out", targetOut,
    "--version", VERSION,
    "--target", "windows-x86_64",
    "--binary", path.join(targetDir, "release", "syncord-injector"),
  ]);
  assert.equal(packaged.code, 0, packaged.all);

  const entries = listArchive(path.join(targetOut, `syncord-injector-windows-x86_64-${VERSION}.zip`));
  const root = `syncord-injector-windows-x86_64-${VERSION}`;

  assert.ok(entries.includes(`${root}/syncord-injector.exe`), `binary missing: ${entries.join(", ")}`);
  for (const name of ["syncord-injector.desktop", "install-desktop-entry.sh"]) {
    assert.ok(
      !entries.includes(`${root}/${name}`),
      `${name} is freedesktop and has no meaning on Windows`,
    );
  }
  assert.ok(
    !entries.some((entry) => entry.includes("/icons/hicolor/")),
    "the hicolor theme tree is a freedesktop concept",
  );
});

test("the Injector packager is byte-reproducible", NO_CARGO, () => {
  const payloadDir = path.join(scratch, "injector-payload-repro");
  const pubB64 = writeSignedPayload(payloadDir);
  const build = run("cargo", ["build", "--release", ...CARGO_JOB_FLAGS], {
    cwd: INJECTOR,
    env: { ...process.env, SYNCORD_INTEGRITY_KEY: pubB64, CARGO_TARGET_DIR: targetDir, ...CARGO_ENV },
  });
  assert.equal(build.code, 0, `cargo build --release failed:\n${build.err}`);

  const targetOut = path.join(scratch, "injector-repro");
  const args = [
    INJECTOR_SCRIPT,
    "--payload", payloadDir,
    "--out", targetOut,
    "--version", VERSION,
    "--target", "linux-x86_64",
    "--binary", path.join(targetDir, "release", "syncord-injector"),
  ];
  assert.equal(run(process.execPath, args).code, 0);
  const file = path.join(targetOut, `syncord-injector-linux-x86_64-${VERSION}.tar.gz`);
  const first = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

  assert.equal(run(process.execPath, args).code, 0);
  const second = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  assert.equal(first, second, "two builds of the same input must produce the same artifact");
});


test("an external runner cannot skip packaged payload verification", {
  skip: process.platform === "win32" ? "POSIX runner fixture" : false,
}, () => {
  const payloadDir = path.join(scratch, "runner-payload");
  writeSignedPayload(payloadDir);
  for (const mode of [[], ["--standalone"]]) {
  const result = run(process.execPath, [
    INJECTOR_SCRIPT,
    ...mode,
    "--payload", payloadDir,
    "--out", path.join(scratch, "runner-artifacts"),
    "--version", VERSION,
    "--target", "windows-x86_64",
    "--binary", process.execPath,
    "--runner", "/usr/bin/true",
  ]);
  assert.notEqual(result.code, 0, "a successful runner must still verify the actual payload");
  assert.match(result.all, /cannot find its own payload/);
  }
});
