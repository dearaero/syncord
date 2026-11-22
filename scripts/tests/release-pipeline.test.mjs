/**
 * Release-pipeline test suite.
 *
 * Run: `node --test scripts/tests/release-pipeline.test.mjs`
 *
 * `scripts/release.mjs` is the one script in this repository that holds a
 * private key. Its failure modes are unusually quiet: a descriptor signed with
 * the wrong key, or built with a different field order than the client expects,
 * produces a release that every client silently refuses — and the only symptom
 * is users saying "no update is available".
 *
 * So the assertions here are mostly about refusal, and the one that matters
 * most is the last: the payload this script signs must be byte-identical to the
 * payload `src/shared/release.ts` verifies. Those are two independent
 * implementations of one contract, and a divergence between them is invisible
 * until release day.
 */
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { build } from "esbuild";
import crypto from "node:crypto";

const { test } = await import("node:test");

const REPO = process.cwd();
const RELEASE_SCRIPT = path.join(REPO, "scripts", "release.mjs");
const PREFLIGHT_SCRIPT = path.join(REPO, "scripts", "release-preflight.mjs");

/** One key pair for the whole suite: private signs, public is compiled in. */
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const PUB_B64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const PRIV_B64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");

/** A second, unrelated pair — used to prove a key mismatch is caught. */
const other = crypto.generateKeyPairSync("ed25519");
const OTHER_PRIV_B64 = other.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");

// The client's own canonicalization, bundled from source.
const sharedOut = path.join(await mkdtemp(path.join(tmpdir(), "dion-rel-")), "shared.mjs");
await build({
  stdin: {
    contents: `
      export * from './src/shared/version';
      export * from './src/shared/release';
    `,
    resolveDir: REPO,
    loader: "ts",
  },
  bundle: true,
  platform: "neutral",
  format: "esm",
  outfile: sharedOut,
  logLevel: "warning",
});
const S = await import(pathToFileURL(sharedOut).href);

const signManifest = (payload) =>
  crypto.sign(null, Buffer.from(payload, "utf-8"), privateKey).toString("base64");

/**
 * Build a throwaway repository containing a copy of the release script, a
 * `dist/` with signed bundles, and one platform archive.
 */
async function makeRepo(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "dion-relrepo-"));
  await mkdir(path.join(dir, "scripts/lib"), { recursive: true });
  await writeFile(path.join(dir, "scripts/lib/release-config.mjs"), await readFile(path.join(REPO, "scripts/lib/release-config.mjs")));
  await mkdir(path.join(dir, "dist"), { recursive: true });
  await mkdir(path.join(dir, "release"), { recursive: true });
  await mkdir(path.join(dir, "node_modules"), { recursive: true });

  // The preflight is part of the pipeline, so a fixture that tests the pipeline
  // includes it. Not a stub: the assertions below depend on the preflight
  // actually running and passing, so that each test reaches the specific
  // refusal it is about.
  await writeFile(path.join(dir, "scripts", "release.mjs"), await readFile(RELEASE_SCRIPT));
  await writeFile(
    path.join(dir, "scripts", "release-preflight.mjs"),
    await readFile(PREFLIGHT_SCRIPT),
  );

  const version = options.version ?? "1.4.0";
  const repo = options.repo ?? "dearaero/discordion";
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "Syncord", version }, null, 2),
  );
  // The preflight compares the compiled repository against the one in
  // `src/shared/release.ts`, so the fixture needs a copy of that too.
  await mkdir(path.join(dir, "src", "shared"), { recursive: true });
  await writeFile(
    path.join(dir, "src", "shared", "release.ts"),
    `export const DEFAULT_RELEASE_REPO = ${JSON.stringify(repo)};\n`,
  );

  // The bundles carry the shape esbuild emits for a `define`, because that is
  // what the preflight reads to find the compiled-in version, repository and
  // integrity key. A fixture of plain `console.log` bodies would be refused
  // before reaching any of the behaviour these tests are about -- and the key is
  // in the same position as the other two for the same reason: a build without it
  // is one no client can install anything from.
  const versionDefine = `var COMPILED_VERSION = true ? ${JSON.stringify(version)} : void 0;\n`;
  const repoDefine = `var COMPILED_RELEASE_REPO = true ? ${JSON.stringify(repo)} : void 0;\n`;
  const keyDefine = `var COMPILED_INTEGRITY_KEY = true ? ${JSON.stringify(PUB_B64)} : "";\n`;
  const bundles = {
    "main.js": `${versionDefine}${repoDefine}${keyDefine}console.log('main')\n`,
    "preload.js": `${versionDefine}console.log('preload')\n`,
    "renderer.js": `${versionDefine}console.log('renderer')\n`,
  };
  const files = [];
  for (const [name, body] of Object.entries(bundles)) {
    await writeFile(path.join(dir, "dist", name), body);
    files.push({ name, sha256: crypto.createHash("sha256").update(body).digest("hex") });
  }

  const manifestBody = { version: 1, algorithm: "ed25519", files };
  const manifest = options.unsignedManifest
    ? manifestBody
    : { ...manifestBody, signature: signManifest(JSON.stringify(manifestBody)) };
  await writeFile(path.join(dir, "dist", "integrity.manifest.json"), JSON.stringify(manifest, null, 2));

  for (const name of options.assets ?? [`syncord-${version}-mac-arm64.tar.gz`]) {
    await writeFile(path.join(dir, "release", name), `archive:${name}`);
  }

  return dir;
}

function run(dir, env = {}, args = []) {
  return spawnSync(process.execPath, [path.join(dir, "scripts", "release.mjs"), ...args], {
    cwd: dir,
    encoding: "utf-8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...env,
    },
  });
}

// ── Refusals ──────────────────────────────────────────────────────────────────

test("release: refuses to run without a signing key", async () => {
  const dir = await makeRepo();
  try {
    const result = run(dir, { Syncord_INTEGRITY_KEY: PUB_B64 });
    assert.notEqual(result.status, 0, "must not succeed");
    assert.match(result.stderr, /SIGNING_KEY is not set/);
    // The reason must never quote any part of a key.
    assert.equal(/[A-Za-z0-9+/]{40,}/.test(result.stderr), false, "stderr must not contain key material");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release: refuses when the signing key does not match the compiled key", async () => {
  const dir = await makeRepo();
  try {
    const result = run(dir, { Syncord_SIGNING_KEY: OTHER_PRIV_B64, Syncord_INTEGRITY_KEY: PUB_B64 });
    assert.notEqual(result.status, 0, "must not succeed");
    // This is the failure that would otherwise ship a release no client can
    // install, so it is checked explicitly rather than as a generic non-zero.
    assert.match(result.stderr, /different keys|does not match Syncord_INTEGRITY_KEY/);
    assert.equal(existsSync(path.join(dir, "release", "syncord-release.json")), false, "nothing may be written");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release: refuses an unsigned integrity manifest", async () => {
  const dir = await makeRepo({ unsignedManifest: true });
  try {
    const result = run(dir, { Syncord_SIGNING_KEY: PRIV_B64, Syncord_INTEGRITY_KEY: PUB_B64 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /UNSIGNED/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release: refuses a manifest whose signature does not verify", async () => {
  const dir = await makeRepo();
  try {
    const manifestPath = path.join(dir, "dist", "integrity.manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    // A signature from an unrelated key, over the right bytes.
    const body = { version: manifest.version, algorithm: manifest.algorithm, files: manifest.files };
    manifest.signature = crypto
      .sign(null, Buffer.from(JSON.stringify(body), "utf-8"), other.privateKey)
      .toString("base64");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const result = run(dir, { Syncord_SIGNING_KEY: PRIV_B64, Syncord_INTEGRITY_KEY: PUB_B64 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not verify against/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release: refuses when a bundle no longer matches the signed manifest", async () => {
  const dir = await makeRepo();
  try {
    // The real-world case: something touched dist/ after the build.
    await writeFile(path.join(dir, "dist", "renderer.js"), "console.log('tampered')\n");
    const result = run(dir, { Syncord_SIGNING_KEY: PRIV_B64, Syncord_INTEGRITY_KEY: PUB_B64 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match the signed manifest/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release: refuses a version the client would not accept", async () => {
  const dir = await makeRepo();
  try {
    const result = run(dir, {
      Syncord_SIGNING_KEY: PRIV_B64,
      Syncord_INTEGRITY_KEY: PUB_B64,
      Syncord_RELEASE_VERSION: "not-a-version",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not a release version/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release: refuses when no platform archive exists", async () => {
  const dir = await makeRepo({ assets: [] });
  try {
    const result = run(dir, { Syncord_SIGNING_KEY: PRIV_B64, Syncord_INTEGRITY_KEY: PUB_B64 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no platform archives/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── The happy path, and the check that matters most ───────────────────────────

test("release: produces a descriptor the client accepts and a newer version is offered", async () => {
  const dir = await makeRepo();
  try {
    const result = run(dir, { Syncord_SIGNING_KEY: PRIV_B64, Syncord_INTEGRITY_KEY: PUB_B64 });
    assert.equal(result.status, 0, result.stderr);

    const descriptor = JSON.parse(await readFile(path.join(dir, "release", "syncord-release.json"), "utf-8"));

    // 1. The client's own parser accepts it.
    const verdict = S.evaluateReleaseDescriptor(descriptor);
    assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.reason);

    // 2. The client's own canonicalization reproduces the exact signed bytes.
    //    This is the assertion that fails if the two implementations ever
    //    disagree about field order, and it is the whole reason this test exists.
    const payload = S.canonicalReleasePayload(verdict.descriptor);
    const verified = crypto.verify(
      null,
      Buffer.from(payload, "utf-8"),
      publicKey,
      Buffer.from(descriptor.signature, "base64"),
    );
    assert.equal(verified, true, "the client and the pipeline must agree on the signed bytes");

    // 3. And a client on an older version is offered the update.
    const offer = S.evaluateUpdateOffer(verdict.descriptor, "1.3.9", "mac-arm64");
    assert.equal(offer.available, true);
    assert.equal(offer.latest, "1.4.0");
    assert.equal(offer.asset.name, "syncord-1.4.0-mac-arm64.tar.gz");

    // 4. A client already on that version is not.
    assert.equal(S.evaluateUpdateOffer(verdict.descriptor, "1.4.0", "mac-arm64").available, false);

    // 5. A client on a platform with no asset is not offered someone else's file.
    assert.equal(S.evaluateUpdateOffer(verdict.descriptor, "1.3.9", "windows-x64").available, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release: a descriptor with a swapped digest does not verify", async () => {
  const dir = await makeRepo();
  try {
    const result = run(dir, { Syncord_SIGNING_KEY: PRIV_B64, Syncord_INTEGRITY_KEY: PUB_B64 });
    assert.equal(result.status, 0, result.stderr);

    const descriptor = JSON.parse(await readFile(path.join(dir, "release", "syncord-release.json"), "utf-8"));
    const verdict = S.evaluateReleaseDescriptor(descriptor);
    const payload = S.canonicalReleasePayload(verdict.descriptor);

    // Point the client at different bytes while keeping the signature.
    const swapped = S.evaluateReleaseDescriptor({
      ...descriptor,
      assets: [{ ...descriptor.assets[0], sha256: "f".repeat(64) }],
    });
    assert.equal(swapped.ok, true);
    const swappedPayload = S.canonicalReleasePayload(swapped.descriptor);
    assert.notEqual(swappedPayload, payload);
    assert.equal(
      crypto.verify(null, Buffer.from(swappedPayload, "utf-8"), publicKey, Buffer.from(descriptor.signature, "base64")),
      false,
      "a swapped asset digest must not verify under the original signature",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release: a platform with no published archive is not offered someone else's file", async () => {
  const dir = await makeRepo({
    assets: [
      "syncord-1.4.0-windows-x64.zip",
      "syncord-1.4.0-mac-arm64.tar.gz",
      "syncord-1.4.0-linux-x64.tar.gz",
    ],
  });
  try {
    const result = run(dir, { Syncord_SIGNING_KEY: PRIV_B64, Syncord_INTEGRITY_KEY: PUB_B64 });
    assert.equal(result.status, 0, result.stderr);

    const descriptor = JSON.parse(await readFile(path.join(dir, "release", "syncord-release.json"), "utf-8"));
    const verdict = S.evaluateReleaseDescriptor(descriptor);
    assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.reason);
    assert.equal(verdict.descriptor.assets.length, 3);

    const published = new Set(verdict.descriptor.assets.map((a) => a.platform));
    for (const platform of S.RELEASE_PLATFORMS) {
      const available = S.evaluateUpdateOffer(verdict.descriptor, "1.3.0", platform).available;
      assert.equal(available, published.has(platform), `${platform} availability must match what was published`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release: --check reports agreement without writing anything", async () => {
  const dir = await makeRepo();
  try {
    const result = run(dir, { Syncord_SIGNING_KEY: PRIV_B64, Syncord_INTEGRITY_KEY: PUB_B64 }, ["--check"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /keys agree/);
    assert.equal(existsSync(path.join(dir, "release", "syncord-release.json")), false, "--check must not sign");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("release: --check fails when the keys disagree", async () => {
  const dir = await makeRepo();
  try {
    const result = run(dir, { Syncord_SIGNING_KEY: OTHER_PRIV_B64, Syncord_INTEGRITY_KEY: PUB_B64 }, ["--check"]);
    // `--check` is the dry run, so it gets the same preflight gate the real run
    // does — which is where the key mismatch is now caught, before
    // `release.mjs` reaches its own comparison. The exit status is the
    // assertion; the wording is whichever check fired first.
    assert.notEqual(result.status, 0);
    assert.match(
      result.stdout + result.stderr,
      /different keys|does not match Syncord_INTEGRITY_KEY|keys disagree/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

console.log("[Syncord] release pipeline tests loaded");
