/**
 * Build the per-platform update assets that `scripts/release.mjs` signs.
 *
 * Run: `node scripts/package-payload.mjs`
 *
 * Produces one archive per platform in `release/`:
 *
 *   release/syncord-<version>-<platform>.tar.gz
 *
 * Each is the payload — the three bundles, the signed integrity manifest, and
 * the version stamp — flat at the archive root. That exact shape is not a
 * convention, it is what `injector/crates/syncord-core/src/archive.rs` accepts:
 * `PAYLOAD_ALLOWED` is a six-name allowlist and `safe_entry_path` refuses
 * everything else, so an archive with a directory in it, a nested path, or an
 * extra file is rejected by the Injector that has to consume it. A packaging
 * change here is an outage on every client, which is why the shape is asserted
 * after the archive is written rather than trusted.
 *
 * The payload is identical on every platform — it is JavaScript. The
 * per-platform naming exists because the release descriptor maps a platform to
 * an asset, and because it leaves room for a platform-specific bundle later
 * without another descriptor format. Nothing here varies by platform today, and
 * pretending otherwise would be a lie the naming invites.
 *
 * The version stamp is generated here rather than signed, because it grants no
 * capability: it is a display string, and the update decision comes from the
 * signed release descriptor in the client. See `VERSION_FILE` in
 * `syncord-core/src/verify.rs`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

/**
 * Input and output locations, overridable.
 *
 * Both default to the repository's `dist/` and `release/`, but a hardcoded
 * output makes the script untestable — a test cannot run it without writing
 * into the working tree, so the first version of `packaging.test.mjs` asserted
 * against a scratch directory the script had never heard of. Overridable paths
 * are also what lets a CI job stage artifacts somewhere other than the checkout.
 */
function parseArgs(argv) {
  const options = {
    dist: path.join(root, "dist"),
    outDir: path.join(root, "release"),
    // A scratch directory is created inside the repository rather than in the
    // OS temp dir: `tar` reads the staged files through `-C`, and keeping it on
    // the same filesystem keeps the run working on a runner with a small /tmp.
    scratchRoot: root,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--dist":
        options.dist = path.resolve(value);
        i += 1;
        break;
      case "--out":
        options.outDir = path.resolve(value);
        i += 1;
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  return options;
}

/** Mirrors `PLATFORMS` in `scripts/release.mjs` and `src/shared/release.ts`. */
const PLATFORMS = ["windows-x64", "windows-arm64", "mac-x64", "mac-arm64", "linux-x64", "linux-arm64"];

/**
 * The files a payload archive must contain, flat at the root.
 *
 * This is also the *member list* passed to `tar`, not just a checklist. Two
 * reasons, both learned the hard way:
 *
 *   - Archiving a directory (`tar -C dir .`) records a directory entry. On macOS
 *     that directory can carry extended attributes, and bsdtar then writes an
 *     AppleDouble sibling for it — an entry literally named `._.`, because the
 *     directory's own name is `.`. The Injector's allowlist refuses it, so a
 *     release built on a Mac produced an archive no client could install. The
 *     error names `._.` and points at the archive, not at the packaging step,
 *     which is a bad afternoon.
 *   - Naming the members also means a stray file in the staging directory cannot
 *     silently become part of a release.
 *
 * `COPYFILE_DISABLE=1` is set on every tar call as well, because it is the
 * documented fix for the same class on macOS and costs nothing elsewhere.
 */
const PAYLOAD_FILES = [
  "main.js",
  "preload.js",
  "renderer.js",
  "integrity.manifest.json",
  "syncord-version.json",
];

/** Entry names that are metadata, not payload. */
const APPLEDOUBLE = /(^|\/)\._|^\.\/\._|\.DS_Store$/;

/**
 * Abort with a message.
 *
 * **Throws**, rather than calling `process.exit`. A `process.exit` from inside
 * the packaging `try` blocks skips their `finally`, so every failure leaked a
 * `.package-*` scratch directory into the working tree — a failure that leaves
 * rubbish behind is harder to diagnose than the failure itself, and the leftovers
 * look like something else went wrong. Throwing unwinds normally, the scratch is
 * cleaned up, and `main` below is the single place that prints and exits.
 */
class PackageError extends Error {}

function fail(message) {
  throw new PackageError(message);
}
/**
 * Environment for every `tar` call.
 *
 * `COPYFILE_DISABLE` is the documented way to stop bsdtar writing AppleDouble
 * entries, and it is a no-op on GNU tar, so it is set unconditionally rather
 * than detected.
 */
const TAR_ENV = { COPYFILE_DISABLE: "1" };
const MAX_TAR_BYTES = 256 * 1024 * 1024;



/** Is this GNU tar, or the bsdtar that ships with macOS? */
let gnuTar = null;
function isGnuTar() {
  if (gnuTar !== null) return gnuTar;
  const version = spawnSync("tar", ["--version"], { encoding: "utf-8" });
  gnuTar = version.status === 0 && version.stdout.startsWith("tar (GNU");
  return gnuTar;
}

/**
 * Flags that strip the build environment out of the archive.
 *
 * Sorted entries and a fixed mtime on GNU tar; the mtime is already fixed on the
 * files themselves, so bsdtar only needs the ownership fields, spelled the way
 * bsdtar spells them.
 */
function tarReproducibilityFlags() {
  if (isGnuTar()) {
    return ["--sort=name", "--owner=0", "--group=0", "--numeric-owner", "--mtime=@0"];
  }
  return ["--uid", "0", "--gid", "0", "--uname", "root", "--gname", "root"];
}

/** Set every file's mtime under `dir` to a fixed instant. */
function freezeTimestamps(dir, when = new Date("2000-01-01T00:00:00Z")) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    fs.utimesSync(path.join(entry.parentPath ?? entry.path, entry.name), when, when);
  }
  fs.utimesSync(dir, when, when);
}

/**
 * The release version.
 *
 * `Syncord_RELEASE_VERSION` — the TypeScript spelling, and deliberately the
 * same variable `scripts/release.mjs` reads. These two scripts have to agree:
 * this one names the archives, that one signs a descriptor listing them, and a
 * release whose descriptor names files that are not attached is one every
 * client silently refuses. The agreement is asserted behaviourally by
 * `scripts/tests/packaging.test.mjs`, not left to a comment.
 *
 * The Rust side spells it `SYNCORD_RELEASE_VERSION`. This script does not need
 * the Rust spelling — it never touches a key — so it does not accept it. A
 * script that quietly read both would let a CI job set one and mean the other.
 */
function releaseVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
  const raw = process.env.Syncord_RELEASE_VERSION ?? pkg.version;
  if (!/^\d{1,6}(?:\.\d{1,6}){0,3}(?:-[0-9A-Za-z.-]{1,32})?$/.test(String(raw))) {
    fail(`"${raw}" is not a version the client would accept`);
  }
  return String(raw);
}

/**
 * Build the archive, then prove the result is one the Injector can consume.
 *
 * The verification is not paranoia about our own code. It is that the
 * allowlist in `archive.rs` is a *security* control: an archive with an extra
 * entry is refused at extraction time, in front of every user, at update time.
 * Catching it here turns a release-day outage into a build failure.
 */
function packagePlatform(platform, version, allowed, options) {
  const name = `syncord-${version}-${platform}.tar.gz`;
  const outFile = path.join(options.outDir, name);

  // A scratch directory, so the archive contains the files at the root rather
  // than a directory named after the platform.
  const stage = fs.mkdtempSync(path.join(options.scratchRoot, ".package-"));
  try {
    for (const file of ["main.js", "preload.js", "renderer.js", "integrity.manifest.json"]) {
      const from = path.join(options.dist, file);
      if (!fs.existsSync(from)) {
        fail(`dist/${file} is missing. Run \`pnpm build\` first.`);
      }
      fs.copyFileSync(from, path.join(stage, file));
    }
    // Regenerated per build rather than copied, so a stale stamp in `dist/`
    // cannot ship a release that reports the wrong version after updating.
    fs.writeFileSync(
      path.join(stage, "syncord-version.json"),
      `${JSON.stringify({ version }, null, 2)}\n`,
    );

    // Reproducibility: a rebuild from identical inputs must produce identical
    // bytes, or every CI run presents as a changed artifact and nobody can tell
    // a real change from a timestamp.
    //
    // Fixed mtimes are set on the staged files rather than passed as a flag,
    // because GNU tar's `--mtime` and `--sort` do not exist in the bsdtar that
    // ships on macOS — and a packaging script that only runs on the maintainer's
    // Linux laptop is not a packaging script. Owner and group flags are spelled
    // differently in the two, so those are selected per implementation.
    freezeTimestamps(stage);

    fs.rmSync(outFile, { force: true });
    // gzip stores the archive's mtime in its own header, so `tar -z` is not
    // reproducible even with every tar flag pinned: two runs a second apart
    // produce different bytes. Hence tar to a plain file, then `gzip -n`,
    // which omits the timestamp and the original name.
    //
    // A scratch directory, not a name derived from `outFile`: deriving one is
    // how a previous version ended up asking gzip to write `…tar.gz.tar.gz` and
    // then refusing to overwrite the remains of a run that had already failed —
    // a failure that reads like a permissions problem and is really a leftover.
    const scratch = fs.mkdtempSync(path.join(options.scratchRoot, ".package-tar-"));
    try {
      const plain = path.join(scratch, "archive.tar");
      const tarred = spawnSync(
        "tar",
        [...tarReproducibilityFlags(), "--format=ustar", "-cf", plain, "-C", stage, ...PAYLOAD_FILES],
        { env: { ...process.env, ...TAR_ENV }, encoding: "utf-8" },
      );
      if (tarred.status !== 0) {
        fail(`tar failed for ${platform}: ${tarred.stderr || tarred.stdout}`);
      }
      // `gzip` appends `.gz` to whatever it is given, so it is pointed at the
      // scratch file and the result is copied onto the final name.
      const gzipped = spawnSync("gzip", ["-n", "-9", plain], { encoding: "utf-8" });
      if (gzipped.status !== 0) {
        fail(`gzip failed for ${platform}: ${gzipped.stderr || gzipped.stdout}`);
      }
      fs.rmSync(outFile, { force: true });
      fs.copyFileSync(`${plain}.gz`, outFile);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }

  assertInjectable(name, outFile, allowed);
  return { name, size: fs.statSync(outFile).size };
}

/**
 * Read the archive back and check it against the Injector's own rules.
 *
 * The names are re-read from `archive.rs` rather than duplicated, so a change to
 * the allowlist cannot quietly leave this check asserting something stale.
 */
function assertInjectable(name, file, allowed) {
  // bsdtar hides AppleDouble entries in its listing on macOS. Inspect the
  // actual tar headers instead, matching what the Rust extractor receives.
  const archive = gunzipSync(fs.readFileSync(file), { maxOutputLength: MAX_TAR_BYTES });
  const entries = [];
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const read = (start, end) => header.subarray(start, end).toString("utf-8").split("\0", 1)[0];
    const size = Number.parseInt(read(124, 136).trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > archive.length) {
      fail(`${name} contains an invalid tar entry size.`);
    }
    const type = read(156, 157);
    // Our root-level ASCII filenames need no PAX/long-name/symlink entries.
    // Reject them rather than accepting an override the listing may hide.
    if (type !== "0" && type !== "") fail(`${name} contains unsupported tar entry type "${type}".`);
    const prefix = read(345, 500);
    entries.push(prefix ? `${prefix}/${read(0, 100)}` : read(0, 100));
    offset += 512 + Math.ceil(size / 512) * 512;
  }

  for (const entry of entries) {
    if (entry === "." || entry === "") continue;
    if (APPLEDOUBLE.test(entry)) {
      fail(
        `${name} contains the macOS metadata entry "${entry}". Something in the staging ` +
          `directory carries an extended attribute, and archiving the directory recorded a ` +
          `sibling for it. The Injector refuses it, so this release would install nowhere.`,
      );
    }
    if (entry.endsWith("/")) {
      fail(`${name} contains a directory entry ("${entry}"). The Injector's allowlist admits files only.`);
    }
    if (entry.includes("/")) {
      fail(`${name} contains a nested path ("${entry}"). The Injector's allowlist admits root-level files only.`);
    }
    if (!allowed.includes(entry)) {
      fail(`${name} contains "${entry}", which is not in the Injector's payload allowlist.`);
    }
  }

  const present = new Set(entries);
  const missing = PAYLOAD_FILES.filter((f) => !present.has(f));
  if (missing.length > 0) {
    fail(`${name} is missing ${missing.join(", ")}; the Injector would refuse it as incomplete.`);
  }
}

/**
 * Read the Injector's payload allowlist out of its own source.
 *
 * Parsed rather than duplicated for one reason: the allowlist is a *security*
 * control in `archive.rs`, and a copy of it here would drift. The first version
 * of this function did exactly that, and immediately failed on
 * `crate::verify::VERSION_FILE` — the allowlist is written with constant
 * identifiers, not literals, so the names have to be resolved through
 * `verify.rs` rather than read as strings.
 *
 * Reading the source also means this check follows the Rust side automatically.
 * If `PAYLOAD_ALLOWED` gains a name, this accepts it; if it loses one, this
 * rejects archives the Injector would refuse. Neither direction can be stale.
 */
function readRustAllowlist() {
  const archive = fs.readFileSync(
    path.join(root, "injector", "crates", "syncord-core", "src", "archive.rs"),
    "utf-8",
  );
  const verify = fs.readFileSync(
    path.join(root, "injector", "crates", "syncord-core", "src", "verify.rs"),
    "utf-8",
  );

  // `crate::verify::FOO` and a bare `FOO` both resolve to the same constant.
  const constants = new Map();
  for (const match of verify.matchAll(
    /pub const ([A-Z_0-9]+): &str = "([^"]+)";/g,
  )) {
    constants.set(match[1], match[2]);
  }

  const read = (constName) => {
    const match = new RegExp(
      `pub const ${constName}: \\[&str; \\d+\\] = \\[([\\s\\S]*?)\\];`,
    ).exec(archive);
    if (!match) {
      fail(`could not find ${constName} in archive.rs — the allowlist shape changed`);
    }

    const names = [];
    for (const entry of match[1].matchAll(/"([^"]+)"|([A-Z_][A-Z_0-9]*)/g)) {
      if (entry[1] !== undefined) {
        names.push(entry[1]);
        continue;
      }
      const resolved = constants.get(entry[2]);
      if (resolved === undefined) {
        fail(
          `archive.rs refers to "${entry[2]}", which is not a string constant in verify.rs. ` +
            `This script cannot tell what the Injector will accept — refusing to guess.`,
        );
      }
      names.push(resolved);
    }
    return names;
  };

  const allowed = [...new Set([...read("PAYLOAD_REQUIRED"), ...read("PAYLOAD_ALLOWED")])];
  if (allowed.length === 0) fail("the Injector payload allowlist is empty");
  return allowed;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const version = releaseVersion();

  if (!fs.existsSync(path.join(options.dist, "integrity.manifest.json"))) {
    fail("dist/integrity.manifest.json is missing. Run `pnpm build` first.");
  }

  fs.mkdirSync(options.outDir, { recursive: true });

  const allowed = readRustAllowlist();
  console.log(`[Syncord][package] ${version}`);
  console.log(
    `[Syncord][package] every archive will be checked against the Injector allowlist ` +
      `(${allowed.length} names: ${allowed.join(", ")})`,
  );
  console.log("");
  for (const platform of PLATFORMS) {
    const asset = packagePlatform(platform, version, allowed, options);
    console.log(`  ${platform.padEnd(14)} ${asset.name.padEnd(44)} ${String(asset.size).padStart(9)} B`);
  }

  console.log("");
  console.log(
    `[Syncord][package] ${PLATFORMS.length} assets in ${path.relative(root, options.outDir)}/`,
  );
  console.log("[Syncord][package] each one re-read and checked against the Injector's allowlist");
  console.log("");
  console.log("Sign the release descriptor with:");
  console.log("");
  console.log("  node scripts/release.mjs");
}

try {
  main();
} catch (err) {
  if (err instanceof PackageError) {
    console.error(`[Syncord][package] ${err.message}`);
    process.exit(1);
  }
  // An unexpected throw is a bug in this script, so it keeps its stack rather
  // than being flattened into a one-line message.
  throw err;
}
