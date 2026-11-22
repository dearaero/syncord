/**
 * Release-gate test suite for `sign-payload.mjs` and `verify-artifacts.mjs`.
 *
 * Run: `node --test scripts/tests/release-gates.test.mjs`
 *
 * These two scripts are the last things that run before a release becomes
 * public, and both have the same unpleasant failure mode: they succeed while
 * producing something no client can use.
 *
 *   sign-payload.mjs      a payload signed with the wrong key, or whose manifest
 *                         does not match its bundles, is refused by every
 *                         Syncord build — including the Injector it is about to
 *                         be packaged into.
 *   verify-artifacts.mjs  a digest that does not describe the bytes being
 *                         attached produces a signed descriptor that no client
 *                         can satisfy, so every user is told no update exists.
 *
 * Both failures are silent from the outside. The release is created, the tag
 * moves, the download works, and nothing happens. So the assertions here are
 * mostly about refusal, and each one checks that the refusal happens *before*
 * anything is written rather than after.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const { test, beforeEach } = await import("node:test");

// Resolved from this file, not from `process.cwd()`. A test that only works
// when invoked from the repository root is a test that silently stops testing
// anything the moment CI runs it from a subdirectory — which the `rust` job in
// The explicitly authorized local Injector build does, with working directory
// `injector/`.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SIGN_SCRIPT = path.join(REPO, "scripts", "sign-payload.mjs");
const VERIFY_SCRIPT = path.join(REPO, "scripts", "verify-artifacts.mjs");

let scratch;
let distDir;

const KEYS = crypto.generateKeyPairSync("ed25519");
const PRIV_B64 = KEYS.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const PUB_B64 = KEYS.publicKey.export({ format: "der", type: "spki" }).toString("base64");

const OTHER = crypto.generateKeyPairSync("ed25519");

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "syncord-gate-"));
  distDir = path.join(scratch, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  for (const name of ["main.js", "preload.js", "renderer.js"]) {
    fs.writeFileSync(path.join(distDir, name), `// ${name}\n`);
  }
  // The version stamp is written by the build, not by the signer: it has to come
  // from the same value that was compiled into the bundles above, or a
  // `package.json` edit between build and sign stamps one version onto bundles
  // carrying another. A fixture that omits it would leave that untested, so it
  // is part of what a build produces.
  fs.writeFileSync(
    path.join(distDir, "syncord-version.json"),
    `${JSON.stringify({ version: "1.2.3" }, null, 2)}\n`,
  );
});

const run = (script, args, env = {}) => {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf-8",
    env: {
      ...process.env,
      Syncord_SIGNING_KEY: "",
      Syncord_INTEGRITY_KEY: "",
      Syncord_RELEASE_VERSION: "1.2.3",
      ...env,
    },
  });
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
};

const exists = (p) => fs.existsSync(p);

// ── sign-payload.mjs ─────────────────────────────────────────────────────────

test("the stamp comes from the build, so it cannot disagree with the bundles", () => {
  /*
   * The bug this is about, and it was found by packaging rather than by a test.
   *
   * The stamp used to be written from `package.json`, while the compiled version
   * comes from the bundles. Anything that changed `package.json` between the
   * build and the sign — a version bump, a `git checkout` — put a different
   * version in the stamp than the client would report, and nothing in the
   * release path noticed. The Injector packager caught it much later, with a
   * version-mismatch error from a tool that had nothing to do with versioning.
   *
   * The two must not simply be reconciled by preferring one. A disagreement is
   * precisely the fault being prevented, so it is refused with both values named
   * — the person who hit it is the only one who knows which of the two is wrong.
   */
  const out = path.join(scratch, "payload-stamped");
  const result = run(SIGN_SCRIPT, [out, "--dist", distDir], {
    Syncord_SIGNING_KEY: PRIV_B64,
    Syncord_INTEGRITY_KEY: PUB_B64,
    // Deliberately not the version these bundles were built with.
    Syncord_RELEASE_VERSION: "9.9.9",
  });
  assert.notEqual(result.code, 0, "it signed bundles as a version they were not built as");
  assert.match(result.err, /9\.9\.9/, `the refused value should be named: ${result.err}`);
  assert.match(result.err, /1\.2\.3/, `the built value should be named: ${result.err}`);
  assert.equal(exists(path.join(out, "syncord-version.json")), false, "it wrote a stamp anyway");

  // Unset, the same bundles stamp as what they actually are — the case that
  // was broken, and the one CI depends on.
  const plain = run(SIGN_SCRIPT, [path.join(scratch, "payload-plain"), "--dist", distDir], {
    Syncord_SIGNING_KEY: PRIV_B64,
    Syncord_INTEGRITY_KEY: PUB_B64,
  });
  assert.equal(plain.code, 0, plain.err);
  const stamped = JSON.parse(
    fs.readFileSync(path.join(scratch, "payload-plain", "syncord-version.json"), "utf-8"),
  );
  assert.equal(stamped.version, "1.2.3");
});

test("a build with no version stamp is refused, with the reason", () => {
  // The stamp is what ties the payload to the version compiled into it, so a
  // payload whose build predates it cannot be signed at all. Failing with a
  // reason beats stamping a guess.
  fs.rmSync(path.join(distDir, "syncord-version.json"));
  const result = run(SIGN_SCRIPT, [path.join(scratch, "payload-unstamped"), "--dist", distDir], {
    Syncord_SIGNING_KEY: PRIV_B64,
    Syncord_INTEGRITY_KEY: PUB_B64,
  });
  assert.notEqual(result.code, 0, "it signed a payload whose build carried no version");
  assert.match(result.err, /syncord-version\.json/, `unhelpful reason: ${result.err}`);
  assert.match(result.err, /build/i, `the reason should say what to do: ${result.err}`);
});

test("it signs a payload and re-verifies it from disk", () => {
  const out = path.join(scratch, "payload");
  const result = run(SIGN_SCRIPT, [out, "--dist", distDir], {
    Syncord_SIGNING_KEY: PRIV_B64,
    Syncord_INTEGRITY_KEY: PUB_B64,
  });
  assert.equal(result.code, 0, result.err);

  const manifest = JSON.parse(fs.readFileSync(path.join(out, "integrity.manifest.json"), "utf-8"));
  assert.equal(manifest.algorithm, "ed25519");
  assert.deepEqual(
    manifest.files.map((f) => f.name),
    ["main.js", "preload.js", "renderer.js"],
  );
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "syncord-version.json"), "utf-8")).version, "1.2.3");

  // Independently verified here, with the public key and the same canonical
  // form — not by trusting the script's own report of success.
  const canonical = JSON.stringify({
    version: 1,
    algorithm: "ed25519",
    files: manifest.files,
  });
  const ok = crypto.verify(
    null,
    Buffer.from(canonical, "utf-8"),
    crypto.createPublicKey({ key: Buffer.from(PUB_B64, "base64"), format: "der", type: "spki" }),
    Buffer.from(manifest.signature, "base64"),
  );
  assert.ok(ok, "the signature must verify against the public half of the signing key");

  for (const file of manifest.files) {
    const actual = crypto.createHash("sha256").update(fs.readFileSync(path.join(out, file.name))).digest("hex");
    assert.equal(actual, file.sha256, `${file.name} must match the manifest`);
  }
});

test("it refuses without a signing key and writes nothing", () => {
  // The failure this prevents is subtle: a payload built with a missing key
  // looks fine, and is refused by every client at the moment someone presses
  // Install.
  const out = path.join(scratch, "payload");
  const result = run(SIGN_SCRIPT, [out, "--dist", distDir]);
  assert.notEqual(result.code, 0);
  assert.match(result.err, /SYNCORD_SIGNING_KEY is not set/);
  assert.ok(!exists(out), "nothing may be written when the key is missing");
});

test("it refuses when the signing key is not the key the build trusts", () => {
  // "Rotated the key and forgot to rebuild" — the failure that actually happens,
  // and the one that produces a release every client silently declines.
  const out = path.join(scratch, "payload");
  const result = run(SIGN_SCRIPT, [out, "--dist", distDir], {
    Syncord_SIGNING_KEY: PRIV_B64,
    Syncord_INTEGRITY_KEY: OTHER.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  });
  assert.notEqual(result.code, 0);
  assert.match(result.err, /does not match/);
  assert.ok(!exists(out), "nothing may be written when the keys disagree");
});

test("it refuses a key that is not Ed25519", () => {
  const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const out = path.join(scratch, "payload");
  const result = run(SIGN_SCRIPT, [out, "--dist", distDir], {
    Syncord_SIGNING_KEY: rsa.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  });
  assert.notEqual(result.code, 0);
  assert.match(result.err, /not Ed25519/);
  assert.ok(!exists(out));
});

test("it accepts the Rust spelling of the key, and says so", () => {
  // The TypeScript side reads `Syncord_*` and the Rust side `SYNCORD_*`. This
  // script sits on the seam, so it reads both — but the case where only the
  // Rust spelling is present is a mistake, and it is worth a warning rather
  // than a silent success.
  const out = path.join(scratch, "payload");
  const result = run(SIGN_SCRIPT, [out, "--dist", distDir], {
    SYNCORD_SIGNING_KEY: PRIV_B64,
    SYNCORD_INTEGRITY_KEY: PUB_B64,
  });
  assert.equal(result.code, 0, result.err);
  assert.match(result.err, /SYNCORD_SIGNING_KEY is set but Syncord_SIGNING_KEY is not/);

  // Both spellings must produce identical bytes, or which one you used changes
  // the artifact.
  const other = path.join(scratch, "payload-js");
  run(SIGN_SCRIPT, [other, "--dist", distDir], {
    Syncord_SIGNING_KEY: PRIV_B64,
    Syncord_INTEGRITY_KEY: PUB_B64,
  });
  for (const name of ["main.js", "preload.js", "renderer.js", "integrity.manifest.json", "syncord-version.json"]) {
    assert.deepEqual(
      fs.readFileSync(path.join(out, name)),
      fs.readFileSync(path.join(other, name)),
      `${name} must not depend on which spelling was used`,
    );
  }
});

test("it refuses a version the client would reject", () => {
  const out = path.join(scratch, "payload");
  const result = run(SIGN_SCRIPT, [out, "--dist", distDir], {
    Syncord_SIGNING_KEY: PRIV_B64,
    Syncord_INTEGRITY_KEY: PUB_B64,
    Syncord_RELEASE_VERSION: "1.2.3 || 1.2.4",
  });
  assert.notEqual(result.code, 0);
  assert.match(result.err, /not a version the client would accept/);
});

test("it refuses a missing bundle rather than signing an incomplete payload", () => {
  fs.rmSync(path.join(distDir, "renderer.js"));
  const out = path.join(scratch, "payload");
  const result = run(SIGN_SCRIPT, [out, "--dist", distDir], {
    Syncord_SIGNING_KEY: PRIV_B64,
    Syncord_INTEGRITY_KEY: PUB_B64,
  });
  assert.notEqual(result.code, 0);
  assert.match(result.err, /renderer\.js is missing/);
});

// ── verify-artifacts.mjs ─────────────────────────────────────────────────────

/** A directory holding one archive and the index that describes it. */
function writeDescribedArtifact(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  const sha256 = crypto.createHash("sha256").update(body).digest("hex");
  const index = path.join(dir, name.replace(/\.(tar\.gz|zip)$/, ".json"));
  fs.writeFileSync(
    index,
    `${JSON.stringify({ version: "1.2.3", asset: name, sha256, bytes: body.length }, null, 2)}\n`,
  );
  return { file, index, sha256 };
}

test("it accepts an artifact that matches its index", () => {
  const dir = path.join(scratch, "ok");
  writeDescribedArtifact(dir, "syncord-injector-linux-x86_64-1.2.3.tar.gz", "pretend archive");

  const result = run(VERIFY_SCRIPT, [dir]);
  assert.equal(result.code, 0, result.err);
  assert.match(result.err, /1 artifact\(s\) verified/);
});

test("it refuses an artifact whose bytes changed after they were described", () => {
  // The failure this exists for: an artifact touched between packaging and
  // publishing. The descriptor stays signed, the download works, and the client
  // refuses — silently, for everyone.
  const dir = path.join(scratch, "tampered");
  const { file } = writeDescribedArtifact(dir, "syncord-injector-linux-x86_64-1.2.3.tar.gz", "pretend archive");
  fs.appendFileSync(file, "x");

  const result = run(VERIFY_SCRIPT, [dir]);
  assert.notEqual(result.code, 0);
  assert.match(result.err, /does not match its index/);
  assert.match(result.err, /Do not publish/);
});

test("it refuses an index that advertises a file that is not there", () => {
  // A signed descriptor referencing a missing asset tells every client to
  // decline the update, with nothing anyone would see.
  const dir = path.join(scratch, "missing");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "syncord-release.json"),
    `${JSON.stringify(
      {
        version: 1,
        channel: "stable",
        release: "1.2.3",
        publishedAt: "2026-01-01T00:00:00Z",
        assets: [{ platform: "linux-x64", name: "syncord-1.2.3-linux-x64.tar.gz", size: 10, sha256: "0".repeat(64) }],
        signature: "irrelevant here",
      },
      null,
      2,
    )}\n`,
  );

  const result = run(VERIFY_SCRIPT, [dir]);
  assert.notEqual(result.code, 0);
  assert.match(result.err, /which is not in/);
});

test("it refuses an asset name that is not a plain filename", () => {
  // An asset name comes from a signed descriptor, which makes it data rather
  // than a path. Resolving `../../` against the artifact directory would let a
  // descriptor describe a file outside it.
  const dir = path.join(scratch, "traversal");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "syncord-release.json"),
    `${JSON.stringify(
      {
        version: 1,
        channel: "stable",
        release: "1.2.3",
        publishedAt: "2026-01-01T00:00:00Z",
        assets: [{ platform: "linux-x64", name: "../../etc/passwd", size: 10, sha256: "0".repeat(64) }],
        signature: "irrelevant here",
      },
      null,
      2,
    )}\n`,
  );

  const result = run(VERIFY_SCRIPT, [dir]);
  assert.notEqual(result.code, 0);
  assert.match(result.err, /not a plain filename/);
});

test("it refuses a directory containing an undescribed archive", () => {
  // A glob-based publish step would attach this. A file no index describes is a
  // file no client can use, so it is a stop rather than a warning.
  const dir = path.join(scratch, "orphan");
  writeDescribedArtifact(dir, "syncord-injector-linux-x86_64-1.2.3.tar.gz", "described");
  fs.writeFileSync(path.join(dir, "syncord-1.2.3-linux-x64.tar.gz"), "stale from an earlier run");

  const result = run(VERIFY_SCRIPT, [dir]);
  assert.notEqual(result.code, 0);
  assert.match(result.err, /not described by any index/);
});

test("--list prints only paths, so it can be piped", () => {
  // The publish step uses this instead of a glob. Progress output on stdout
  // would become part of a filename.
  const dir = path.join(scratch, "listed");
  writeDescribedArtifact(dir, "syncord-injector-linux-x86_64-1.2.3.tar.gz", "one");
  writeDescribedArtifact(dir, "syncord-injector-macos-aarch64-1.2.3.tar.gz", "two");

  const result = run(VERIFY_SCRIPT, [dir, "--list"]);
  assert.equal(result.code, 0, result.err);

  const lines = result.out.split("\n").filter(Boolean);
  assert.equal(lines.length, 2, `expected two paths on stdout, got: ${JSON.stringify(result.out)}`);
  for (const line of lines) {
    assert.ok(exists(line), `every listed path must exist: ${line}`);
    assert.doesNotMatch(line, /verified|artifact/);
  }
});

test("--list prints nothing when verification fails", () => {
  // A list from a failed run would give the publish step something to attach.
  const dir = path.join(scratch, "failed-list");
  const { file } = writeDescribedArtifact(dir, "syncord-injector-linux-x86_64-1.2.3.tar.gz", "x");
  fs.appendFileSync(file, "y");

  const result = run(VERIFY_SCRIPT, [dir, "--list"]);
  assert.notEqual(result.code, 0);
  assert.equal(result.out.trim(), "", "no paths may be printed for a failed run");
});

test("it refuses an index with no usable digest", () => {
  // Without a digest there is nothing for a client to verify against, so the
  // asset is unusable whatever else is true of it.
  const dir = path.join(scratch, "nodigest");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "syncord-injector-linux-x86_64-1.2.3.tar.gz"), "x");
  fs.writeFileSync(
    path.join(dir, "syncord-injector-linux-x86_64-1.2.3.json"),
    `${JSON.stringify({ version: "1.2.3", asset: "syncord-injector-linux-x86_64-1.2.3.tar.gz" }, null, 2)}\n`,
  );

  const result = run(VERIFY_SCRIPT, [dir]);
  assert.notEqual(result.code, 0);
  assert.match(result.err, /no usable sha256/);
});

test("it refuses when there is nothing at all to publish", () => {
  const dir = path.join(scratch, "empty");
  fs.mkdirSync(dir, { recursive: true });
  const result = run(VERIFY_SCRIPT, [dir]);
  assert.notEqual(result.code, 0);
  assert.match(result.err, /nothing to publish/);
});
