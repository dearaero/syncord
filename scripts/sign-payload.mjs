/**
 * Build a signed payload directory.
 *
 * Run: `node scripts/sign-payload.mjs <outDir> [--dist DIR]`
 *
 * The two release artifacts need the payload in different shapes:
 *
 *   scripts/package-payload.mjs   → a `.tar.gz` per platform, for the client
 *   injector/scripts/package.mjs  → a `payload/` directory, for the Injector
 *
 * Both need the *same* payload: the three bundles from `dist/`, an
 * `integrity.manifest.json` signed with the release key, and a version stamp.
 * Building it twice would risk the two disagreeing — one signed, one not, or one
 * a version behind — and the symptom would be an Injector that ships a payload
 * its own client would refuse. So it is built once, here, and both consume it.
 *
 * This is not the release signing path. `scripts/release.mjs` signs the *release
 * descriptor*, which is what tells a client an update exists; this signs the
 * *integrity manifest*, which is what proves the bundles themselves are ours.
 * Both are needed and neither substitutes for the other.
 *
 * The canonical payload here must be byte-identical to `canonicalPayload` in
 * `injector/crates/syncord-core/src/verify.rs` and to the `payload` built in
 * `src/main/security/integrity.ts`. The parity test in
 * `injector/crates/syncord-core/src/tests/parity.rs` checks the Rust side
 * against the TypeScript one directly; this script is checked by
 * `scripts/tests/packaging.test.mjs`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const BUNDLES = ["main.js", "preload.js", "renderer.js"];
const MANIFEST_NAME = "integrity.manifest.json";
const VERSION_FILE = "syncord-version.json";

/**
 * Read an environment variable that the two halves of Syncord spell differently.
 *
 * The TypeScript side has always used `Syncord_*` (`Syncord_INTEGRITY_KEY`,
 * `Syncord_SIGNING_KEY`, `Syncord_DISCORD_PATH`) and the Rust side has always
 * used `SYNCORD_*` (`SYNCORD_INTEGRITY_KEY` in `build.rs`, `SYNCORD_DISCORD_PATH`
 * in `discovery.rs`). Both conventions are established, both are load-bearing,
 * and neither is wrong on its own.
 *
 * This script sits exactly on the seam: it reads the key the *JavaScript* build
 * signs with and the key the *Rust* build verifies with, so it has to see both.
 * Picking one spelling would mean a release assembled with only the other
 * silently produces an unsigned payload — and an unsigned payload is refused by
 * every Syncord build, including the Injector it was about to be packaged into.
 *
 * So: prefer the TypeScript convention, accept the Rust one, and say so loudly
 * when only the Rust spelling is present.
 */
function readEnv(name) {
  const js = process.env[`Syncord_${name}`];
  if (js !== undefined && js !== "") return js;

  const rust = process.env[`SYNCORD_${name}`];
  if (rust !== undefined && rust !== "") {
    console.warn(
      `[Syncord] SYNCORD_${name} is set but Syncord_${name} is not. The TypeScript ` +
        `build reads the latter; both are accepted here, but a release assembled ` +
        `with only the former produces an unsigned payload.`,
    );
    return rust;
  }
  return undefined;
}

function fail(message) {
  console.error(`[Syncord][sign-payload] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { outDir: null, dist: path.join(root, "dist") };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined) fail(`expected a directory, got nothing`);
    if (!flag.startsWith("--")) {
      if (options.outDir !== null) fail("only one output directory may be given");
      options.outDir = path.resolve(flag);
      continue;
    }
    switch (flag) {
      case "--dist":
        options.dist = path.resolve(value);
        i += 1;
        break;
      default:
        fail(`unknown flag: ${flag}`);
    }
  }
  if (options.outDir === null) {
    fail("Usage: node scripts/sign-payload.mjs <outDir> [--dist DIR]");
  }
  return options;
}

/**
 * The exact bytes that are signed and that the Injector re-derives.
 *
 * Field order is the contract. `verify.rs` builds this same string, and a
 * difference in ordering produces a manifest whose signature is valid and whose
 * verification always fails — the quietest possible failure, because everything
 * looks right until a user presses Install.
 */
function canonicalPayload(files) {
  return JSON.stringify({ version: 1, algorithm: "ed25519", files });
}

/**
 * The version to stamp, taken from the build rather than from `package.json`.
 *
 * The compiled version lives in the bundles; `package.json` is only where it
 * came from. Reading the stamp from the source tree let the two disagree --
 * `package.json` bumped after a build stamped the new version onto bundles
 * carrying the old one -- and the only thing that noticed was a check several
 * steps later, in a different tool, complaining about a version.
 *
 * `Syncord_RELEASE_VERSION` exists because CI reads the version off the git tag,
 * and the build already read the same tag, so in a pipeline the two agree. When
 * they do not, neither is quietly preferred: a disagreement is the exact bug
 * this function exists to prevent, so it is refused with both values named.
 */
function releaseVersion(dist) {
  const stamp = path.join(dist, VERSION_FILE);
  if (!fs.existsSync(stamp)) {
    fail(
      `${stamp} does not exist. The version stamp is written by the build, so that it ` +
        `cannot disagree with the version compiled into the bundles. Run the build first.`,
    );
  }

  const built = JSON.parse(fs.readFileSync(stamp, "utf-8")).version;
  const fromEnv = readEnv("RELEASE_VERSION");

  // Shape before agreement. A value the client would reject outright is a
  // format problem whatever it disagrees with, and reporting it as a
  // disagreement would send the reader looking at the wrong thing.
  const acceptable = /^\d{1,6}(?:\.\d{1,6}){0,3}(?:-[0-9A-Za-z.-]{1,32})?$/;
  for (const value of [built, fromEnv]) {
    if (value !== undefined && !acceptable.test(String(value))) {
      fail(`"${value}" is not a version the client would accept`);
    }
  }

  if (fromEnv !== undefined && String(fromEnv) !== String(built)) {
    fail(
      `Syncord_RELEASE_VERSION says ${fromEnv} but these bundles were built as ${built}. ` +
        `Signing them as ${fromEnv} would put a version in the payload that the client ` +
        `does not report. Rebuild with the version you intend to release, or set ` +
        `Syncord_RELEASE_VERSION=${built} to sign what is actually here.`,
    );
  }

  return String(built);
}

/** The private key, and the public half it must agree with. */
function loadKeys() {
  const encoded = readEnv("SIGNING_KEY");
  if (!encoded) {
    fail(
      "SYNCORD_SIGNING_KEY is not set. Without it the payload can only be produced " +
        "unsigned, and an unsigned payload is refused by every Syncord build — " +
        "including the Injector this one is about to be packaged into.",
    );
  }
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey({
      key: Buffer.from(encoded.trim(), "base64"),
      format: "der",
      type: "pkcs8",
    });
  } catch {
    fail("SYNCORD_SIGNING_KEY is not a readable PKCS#8 DER key");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    fail(`SYNCORD_SIGNING_KEY is a ${privateKey.asymmetricKeyType} key, not Ed25519`);
  }

  // `createPublicKey` is a static on the module, not a method on the key object.
  const publicB64 = crypto
    .createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .toString("base64");

  // The build is compiled with a public key. If the two disagree, the payload
  // is signed with a key the Injector does not trust and it will refuse its own
  // contents — a release that installs nothing and reports no error worth
  // reading. This is the "rotated the key and forgot to rebuild" case.
  const compiled = readEnv("INTEGRITY_KEY");
  if (compiled && compiled.trim() !== publicB64) {
    fail(
      "SYNCORD_SIGNING_KEY does not match SYNCORD_INTEGRITY_KEY. The payload would be " +
        "signed with a key no released build can verify. Rebuild with the matching " +
        "public key.",
    );
  }
  return { privateKey, publicB64 };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const version = releaseVersion(options.dist);
  const { privateKey, publicB64 } = loadKeys();

  const bodies = [];
  for (const name of BUNDLES) {
    const file = path.join(options.dist, name);
    if (!fs.existsSync(file)) {
      fail(`${path.relative(root, file)} is missing. Run \`pnpm build\` first.`);
    }
    bodies.push({ name, bytes: fs.readFileSync(file) });
  }

  const files = bodies.map(({ name, bytes }) => ({
    name,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  }));
  const signature = crypto
    .sign(null, Buffer.from(canonicalPayload(files), "utf-8"), privateKey)
    .toString("base64");

  fs.mkdirSync(options.outDir, { recursive: true });
  for (const { name, bytes } of bodies) {
    fs.writeFileSync(path.join(options.outDir, name), bytes);
  }
  fs.writeFileSync(
    path.join(options.outDir, MANIFEST_NAME),
    `${JSON.stringify({ ...JSON.parse(canonicalPayload(files)), signature }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(options.outDir, VERSION_FILE),
    `${JSON.stringify({ version }, null, 2)}\n`,
  );

  // ── Verify our own output, from disk, with the public key. ────────────────
  //
  // The same discipline as `release.mjs`: the file that was just written is
  // re-read and re-verified, so a bug in this script cannot produce a manifest
  // that is signed but wrong. `crypto.verify` with the public half, not a
  // re-sign, so the check is independent of the code that signed.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(options.outDir, MANIFEST_NAME), "utf-8"),
  );
  const payload = canonicalPayload(manifest.files);
  const ok = crypto.verify(
    null,
    Buffer.from(payload, "utf-8"),
    crypto.createPublicKey({
      key: Buffer.from(publicB64, "base64"),
      format: "der",
      type: "spki",
    }),
    Buffer.from(manifest.signature, "base64"),
  );
  if (!ok) {
    fs.rmSync(options.outDir, { recursive: true, force: true });
    fail(
      "the manifest this script just wrote does not verify against its own public key. " +
        "It has been deleted rather than shipped. This means the canonical form here " +
        "disagrees with canonicalPayload in syncord-core/src/verify.rs.",
    );
  }

  for (const { name, bytes } of bodies) {
    const recorded = manifest.files.find((f) => f.name === name)?.sha256;
    const actual = crypto.createHash("sha256").update(bytes).digest("hex");
    if (recorded !== actual) {
      fs.rmSync(options.outDir, { recursive: true, force: true });
      fail(`${name} does not match the manifest it was written with. Deleted rather than shipped.`);
    }
  }

  console.log(`[Syncord][sign-payload] ${version} in ${path.relative(root, options.outDir)}/`);
  for (const { name, bytes } of bodies) {
    console.log(`  ${name.padEnd(12)} ${bytes.length.toString().padStart(8)} B`);
  }
  console.log("[Syncord][sign-payload] manifest re-verified from disk against the release key");
}

main();
