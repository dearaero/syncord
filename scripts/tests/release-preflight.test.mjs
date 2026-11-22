/**
 * Release-preflight test suite.
 *
 * Run: `node --test scripts/tests/release-preflight.test.mjs`
 *
 * `scripts/release-preflight.mjs` is the gate between "the build succeeded" and
 * "this artifact may be published". Every failure it catches has the same
 * shape: the release publishes cleanly and then fails for every user, with
 * nothing in the logs to explain why.
 *
 *   - a bundle compiled at the wrong version offers a release the client already
 *     has, or hides one it needs;
 *   - a bundle compiled for the wrong repository asks GitHub for a feed that
 *     does not exist and reports "up to date" — forever, silently;
 *   - an unsigned or mismatched manifest makes every client refuse its own
 *     bundles at startup and report MODIFIED for a build nobody touched;
 *   - signing with a key other than the one compiled in produces a release no
 *     client can install.
 *
 * So the assertions here are almost entirely about refusal, and each one
 * builds the broken artifact for real rather than stubbing the check.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const { test, beforeEach, afterEach } = await import("node:test");

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const KEY = crypto.generateKeyPairSync("ed25519");
const PRIV_B64 = KEY.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
const PUB_B64 = KEY.publicKey.export({ format: "der", type: "spki" }).toString("base64");

const OTHER = crypto.generateKeyPairSync("ed25519");
const OTHER_PRIV_B64 = OTHER.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");

let scratch;
let distDir;
let packageFile;

/**
 * A `dist/` that looks like a real signed build.
 *
 * The bundles carry the exact shape esbuild emits for a `define` — which is
 * what the preflight reads — so a fixture cannot drift from the real thing
 * without this file being wrong, and the "no compiled-in value" case is a real
 * absence rather than a different pattern.
 */
function buildDist({
  version = "1.4.0",
  repo = "dearaero/syncord-releases",
  // The key compiled into main.js. `null` is the case this file exists for: a
  // bundle with no key reaches users who cannot install anything from it, and
  // nothing about the manifest or the signature is wrong.
  key = PUB_B64,
  sign = true,
  rendererSource = null,
  mutate = null,
  // Runs *after* the manifest is written, for the cases that need to change the
  // manifest itself. `mutate` runs before it and is for the bundles.
  postManifest = null,
} = {}) {
  fs.mkdirSync(distDir, { recursive: true });

  const body = (name) => {
    if (name === "renderer.js" && rendererSource !== null) return rendererSource;
    const define =
      `var COMPILED_VERSION = ${version === null ? "false" : "true"} ? ${
            version === null ? "void 0" : JSON.stringify(version)
          } : void 0;\n` +
          (name === "main.js"
            ? `var COMPILED_RELEASE_REPO = ${repo === null ? "false" : "true"} ? ${
                repo === null ? "void 0" : JSON.stringify(repo)
              } : void 0;\n` +
              `var COMPILED_INTEGRITY_KEY = ${key === null ? "false" : "true"} ? ${
                key === null ? '""' : JSON.stringify(key)
              } : "";\n`
            : "");
    return `// ${name}\n${define}console.log("${name}");\n`;
  };

  const files = [];
  for (const name of ["main.js", "preload.js", "renderer.js"]) {
    const contents = body(name);
    fs.writeFileSync(path.join(distDir, name), contents);
    files.push({ name, sha256: crypto.createHash("sha256").update(contents).digest("hex") });
  }
  if (mutate !== null) mutate();

  const manifest = { version: 1, algorithm: "ed25519", files };
  if (sign) {
    const payload = JSON.stringify({ version: manifest.version, algorithm: manifest.algorithm, files: manifest.files });
    manifest.signature = crypto.sign(null, Buffer.from(payload, "utf-8"), KEY.privateKey).toString("base64");
  }
  fs.writeFileSync(path.join(distDir, "integrity.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (postManifest !== null) postManifest(manifest, () => {
    fs.writeFileSync(path.join(distDir, "integrity.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  });

  fs.writeFileSync(packageFile, `${JSON.stringify({ name: "syncord", version }, null, 2)}\n`);
}

const run = (env = {}) => {
  const result = spawnSync(process.execPath, [path.join(scratch, "scripts/release-preflight.mjs"), "--dist", distDir, "--package", packageFile], {
    encoding: "utf-8",
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:SYNCORD|Syncord)_/.test(key))),
      Syncord_SIGNING_KEY: "",
      Syncord_INTEGRITY_KEY: "",
      Syncord_RELEASE_REPO: "",
      ...env,
    },
  });
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
};

const GOOD_ENV = { Syncord_SIGNING_KEY: PRIV_B64, Syncord_INTEGRITY_KEY: PUB_B64 };

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "syncord-preflight-"));
  distDir = path.join(scratch, "dist");
  packageFile = path.join(scratch, "package.json");
  // Run the real script in an isolated checkout: a maintainer's .env must
  // never supply production signing material to synthetic test fixtures.
  for (const name of ["scripts/release-preflight.mjs", "scripts/lib/release-config.mjs", "src/shared/release.ts"]) {
    const target = path.join(scratch, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(REPO, name), target);
  }
});
afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

// ── The green path ───────────────────────────────────────────────────────────

test("a consistent, correctly signed build passes", () => {
  buildDist();
  const result = run(GOOD_ENV);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /internally consistent and ready to sign/);
});

test("passing without the private key still checks everything it can", () => {
  // `--check`-style use: the bundles are verified, the private key is simply
  // absent. That must not be reported as a pass *and* must not be a failure.
  buildDist();
  const result = run({ Syncord_INTEGRITY_KEY: PUB_B64 });
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /integrity manifest verifies against the release key/);
  assert.match(result.out, /nothing will be signed/);
});

// ── The failures that ship silently ──────────────────────────────────────────

test("a bundle compiled at a stale version is refused", () => {
  // The whole reason the preflight reads `dist/`: the environment can be
  // perfectly correct while the bundle on disk was built before the last
  // version bump. Checking only the environment would call this ready.
  buildDist({ version: "1.3.0" });
  fs.writeFileSync(packageFile, `${JSON.stringify({ name: "syncord", version: "1.4.0" }, null, 2)}\n`);

  const result = run(GOOD_ENV);
  assert.notEqual(result.code, 0);
  assert.match(result.err, /built with version 1\.3\.0 but package\.json says 1\.4\.0/);
});

test("a bundle with no compiled-in integrity key is refused", () => {
  /*
   * The check whose absence let a signed, published, correct release reach users
   * who could not install it.
   *
   * `signing.ts` read the public key from `process.env.Syncord_INTEGRITY_KEY` at
   * runtime. The Discord process has no `Syncord_*` variables in its environment,
   * so every client fell through to a placeholder that is not a valid key, and
   * "fails closed" held exactly as designed: the updater refused every release and
   * logged nothing, while the client's own integrity check called every plugin
   * unverifiable. The manifest, the signature and the descriptor were all fine,
   * which is why every other check here passed -- and why a unit test of
   * `signing.ts` could not have found it. Those tests set the variable, which is
   * how the *build machine* gets the key, not how a *client* does.
   */
  buildDist({ key: null });
  const result = run(GOOD_ENV);
  assert.notEqual(result.code, 0, "a keyless bundle was allowed to publish");
  assert.match(result.err, /no compiled-in integrity key/);
  // The message has to say what to do, or it costs the same afternoon twice.
  assert.match(result.err, /Syncord_INTEGRITY_KEY/);
});

test("a bundle whose compiled key is not a key at all is refused", () => {
  // Base64-decodable and still useless. The client parses the compiled value with
  // `createPublicKey`, so anything that is not SPKI Ed25519 leaves
  // `signingKeyPresent()` false everywhere -- the same failure as no key at all,
  // with a cause that is much harder to see from a distance.
  buildDist({ key: "bm90LWEta2V5LWF0LWFsbC1qdXN0LXNvbWUtc3RyaW5n" });
  const result = run(GOOD_ENV);
  assert.notEqual(result.code, 0, "a bundle compiled with a non-key was allowed to publish");
  assert.match(result.err, /SPKI|integrity key/);
});

test("a bundle with no compiled-in version is refused", () => {
  // What an unbundled or mis-wired build looks like. The client would call
  // itself "unbuilt" and refuse every update, which looks like "no new version".
  buildDist({ version: null });
  const result = run(GOOD_ENV);
  assert.notEqual(result.code, 0);
  assert.match(result.err, /no compiled-in version/);
});

test("preload and main must not disagree about the version", () => {
  // Two bundles, two versions. The client would report one and verify against
  // the other, and neither would look wrong on its own.
  buildDist({ version: "1.4.0", mutate: () => {
    fs.writeFileSync(
      path.join(distDir, "preload.js"),
      'var COMPILED_VERSION = true ? "1.3.0" : void 0;\nconsole.log("preload.js");\n',
    );
  } });
  const result = run(GOOD_ENV);
  assert.notEqual(result.code, 0);
  assert.match(result.err, /preload\.js/);
});

test("a bundle pointing at the wrong repository is refused", () => {
  // The silent one. The client asks GitHub for a feed that does not exist and
  // reports "you are up to date" for the rest of time.
  buildDist({ repo: "someone/somewhere-else" });
  const result = run(GOOD_ENV);
  assert.notEqual(result.code, 0);
  assert.match(result.err, /reads releases from someone\/somewhere-else/);
});

test("a repository the release targets explicitly must match the bundle", () => {
  buildDist({ repo: "dearaero/syncord-releases" });
  const result = run({ ...GOOD_ENV, Syncord_RELEASE_REPO: "myfork/discordion" });
  assert.notEqual(result.code, 0);
  assert.match(result.err, /but this release targets myfork\/discordion/);
});

test("an unsigned manifest is refused", () => {
  buildDist({ sign: false });
  const result = run(GOOD_ENV);
  assert.notEqual(result.code, 0);
  assert.match(result.err, /UNSIGNED/);
});

test("a bundle edited after signing is refused", () => {
  // A watcher, a formatter, or a second build. The manifest still verifies as a
  // signature; it just no longer describes the bytes on disk.
  buildDist({ mutate: () => {
    fs.appendFileSync(path.join(distDir, "renderer.js"), "// changed after signing\n");
  } });
  const result = run(GOOD_ENV);
  assert.notEqual(result.code, 0);
  assert.match(result.err, /does not match the signed manifest/);
});

test("a manifest signed with another key is refused", () => {
  // "Rotated the key and forgot to rebuild", from the other direction: the
  // signature is real, and verifies against a key no client holds.
  buildDist({
    postManifest: (manifest, rewrite) => {
      const payload = JSON.stringify({
        version: manifest.version,
        algorithm: manifest.algorithm,
        files: manifest.files,
      });
      manifest.signature = crypto
        .sign(null, Buffer.from(payload, "utf-8"), OTHER.privateKey)
        .toString("base64");
      rewrite();
    },
  });
  const result = run(GOOD_ENV);
  assert.notEqual(result.code, 0);
  assert.match(result.err, /does not verify against Syncord_INTEGRITY_KEY/);
});

test("a signing key that is not the compiled key is refused", () => {
  // The release would be signed with a key no client can verify. Every user
  // silently gets "no update available".
  buildDist();
  const result = run({ Syncord_SIGNING_KEY: OTHER_PRIV_B64, Syncord_INTEGRITY_KEY: PUB_B64 });
  assert.notEqual(result.code, 0);
  assert.match(result.err, /different keys/);
});

test("a missing explicit key cannot silently accept a build signed with another trust anchor", () => {
  buildDist();
  const result = run({});
  assert.notEqual(result.code, 0);
  assert.match(result.err, /compiled integrity key does not match|Syncord_INTEGRITY_KEY is not set/);
});

test("every problem is reported, not just the first", () => {
  // A preflight that stops at the first failure turns a five-minute fix into
  // five five-minute fixes.
  buildDist({ version: "1.3.0", sign: false, repo: "someone/else" });
  fs.writeFileSync(packageFile, `${JSON.stringify({ name: "syncord", version: "1.4.0" }, null, 2)}\n`);

  const result = run(GOOD_ENV);
  assert.notEqual(result.code, 0);
  for (const expected of [/UNSIGNED/, /built with version 1\.3\.0/, /reads releases from someone\/else/]) {
    assert.match(result.err, expected, `expected ${expected} in:\n${result.err}`);
  }
});

test("missing bundles are refused with a build instruction", () => {
  fs.mkdirSync(distDir, { recursive: true });
  const result = run(GOOD_ENV);
  assert.notEqual(result.code, 0);
  assert.match(result.err, /Run `pnpm build` first/);
});

test("a version the client would reject is refused", () => {
  // The grammar the client enforces, checked on a runner rather than in front
  // of every user.
  buildDist({ version: "1.4.0 || 2.0.0" });
  const result = run(GOOD_ENV);
  assert.notEqual(result.code, 0);
  assert.match(result.err, /not a version the client would accept/);
});


test("a tag version override must agree with both compiled bundles", () => {
  buildDist({ version: "1.5.0" });
  fs.writeFileSync(packageFile, JSON.stringify({ name: "syncord", version: "1.4.0" }));
  const result = run({ ...GOOD_ENV, SYNCORD_RELEASE_VERSION: "1.5.0" });
  assert.equal(result.code, 0, result.err);
  const stale = run({ ...GOOD_ENV, SYNCORD_RELEASE_VERSION: "1.6.0" });
  assert.notEqual(stale.code, 0);
  assert.match(stale.err, /release configuration says 1\.6\.0/);
});


test("renderer must carry the same compiled version as the updater and preload",()=>{
 for(const body of ['console.log("renderer");\n','var COMPILED_VERSION = true ? "1.3.0" : void 0;\n']){
  buildDist({version:"1.4.0",rendererSource:body});
  const result=run(GOOD_ENV);assert.notEqual(result.code,0);assert.match(result.err,/renderer\.js/);assert.match(result.err,/no compiled-in version|built with version 1\.3\.0/);
 }
});


test("esbuild renderer ESM initializers may hoist the compiled version declaration",()=>{
 buildDist({rendererSource:'var COMPILED_VERSION;\nvar init_constants = () => {\n  COMPILED_VERSION = true ? "1.4.0" : void 0;\n};\n'});
 const good=run(GOOD_ENV);assert.equal(good.code,0,good.err);
 buildDist({rendererSource:'var COMPILED_VERSION;\nvar init_constants = () => {\n  COMPILED_VERSION = true ? "1.3.0" : void 0;\n};\n'});
 const stale=run(GOOD_ENV);assert.notEqual(stale.code,0);assert.match(stale.err,/renderer\.js.*built with version 1\.3\.0/);
});
