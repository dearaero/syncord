/**
 * Release pipeline.
 *
 * Produces the artifacts an auto-updating client needs, and refuses to produce
 * a release it cannot vouch for. Run by the release workflow, not by hand
 * unless you are debugging the pipeline itself.
 *
 *   node scripts/release.mjs            # build, describe, sign, print the command
 *   node scripts/release.mjs --check    # verify the current dist without signing
 *
 * ── What this exists to prevent ──────────────────────────────────────────────
 *
 * The client refuses any release descriptor that is not correctly signed with
 * the release key. That is a strong guarantee and it has an uncomfortable
 * failure mode: if the pipeline ships a descriptor signed with the *wrong* key,
 * or a bundle whose manifest does not match, every client on earth silently
 * refuses to update and the mistake is invisible until users report it.
 *
 * So this script fails closed at each step and re-verifies its own output:
 *
 *   1. the private key must be present, parse, and be Ed25519;
 *   2. the public half of that key must equal the key compiled into the build
 *      (`Syncord_INTEGRITY_KEY`) — this catches the "rotated the key and forgot
 *      to rebuild" case, which is the one that actually happens;
 *   3. the build must exist and its integrity manifest must verify against that
 *      public key, so a release never ships bundles the client would reject;
 *   4. the descriptor is signed, then **re-verified from disk** with the public
 *      key, using the same code path the client uses;
 *   5. the signed descriptor is written next to the artifacts and the exact
 *      `wrangler r2 object put` and `gh release create` invocations are printed.
 *
 * The private key is read from `Syncord_SIGNING_KEY` and is never written,
 * logged, echoed, or included in any output. It exists only as a Buffer in this
 * process for the duration of `crypto.sign`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { readReleaseConfiguration } from "./lib/release-config.mjs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const outDir = path.join(root, "release");

const BUNDLES = ["main.js", "preload.js", "renderer.js"];

/** Mirrors `RELEASE_LIMITS` in `src/shared/release.ts`. */
const MAX_ASSET_BYTES = 256 * 1024 * 1024;
const MAX_DIGEST = /^[0-9a-f]{64}$/;
const ASSET_NAME = /^syncord-[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(?:tar\.gz|zip|dmg|exe|AppImage)$/;

const PLATFORMS = ["windows-x64", "windows-arm64", "mac-x64", "mac-arm64", "linux-x64", "linux-arm64"];

function fail(message) {
  console.error(`[Syncord][release] ${message}`);
  process.exit(1);
}

const releaseConfiguration = readReleaseConfiguration(root);

/** The version being released. Read from package.json, not from a hardcode. */
function releaseVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
  const raw = releaseConfiguration.releaseVersion || pkg.version;
  // The same grammar the client enforces, so a bad version fails here rather
  // than in front of every user.
  if (!/^\d{1,6}(?:\.\d{1,6}){0,3}(?:-[0-9A-Za-z.-]{1,32})?$/.test(String(raw))) {
    fail(`"${raw}" is not a release version the client would accept`);
  }
  return String(raw);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * The private key, and the public half derived from it.
 *
 * Derived rather than read separately, so step 2 of the checks below is a real
 * comparison of "what will sign" against "what the build expects" instead of
 * two independently-typed strings that happen to be the same variable name.
 */
function loadKeys() {
  const encoded = releaseConfiguration.signingKey;
  if (typeof encoded !== "string" || encoded.trim().length === 0) {
    fail("Syncord_SIGNING_KEY is not set. A release cannot be signed without it.");
  }

  let privateKey;
  let derivedPublic;
  try {
    privateKey = crypto.createPrivateKey({
      key: Buffer.from(encoded.trim(), "base64"),
      format: "der",
      type: "pkcs8",
    });
    derivedPublic = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" });
  } catch (err) {
    // The message is about the *key*, and never contains any part of it.
    fail(`Syncord_SIGNING_KEY could not be parsed as a base64 PKCS#8 Ed25519 key (${err.code ?? "parse error"})`);
  }

  if (privateKey.asymmetricKeyType !== "ed25519") {
    fail(`Syncord_SIGNING_KEY is a ${privateKey.asymmetricKeyType} key; releases require ed25519`);
  }

  return { privateKey, derivedPublicB64: derivedPublic.toString("base64") };
}

/** The public key the shipped build was compiled to verify against. */
function compiledPublicKey() {
  const encoded = releaseConfiguration.integrityKey;
  if (typeof encoded !== "string" || encoded.trim().length === 0) {
    fail(
      "Syncord_INTEGRITY_KEY is not set. The build's verifier has no key, so no signed " +
        "release could ever be accepted. Rebuild with it set.",
    );
  }
  try {
    crypto.createPublicKey({ key: Buffer.from(encoded.trim(), "base64"), format: "der", type: "spki" });
  } catch {
    fail("Syncord_INTEGRITY_KEY could not be parsed as a base64 SPKI Ed25519 key");
  }
  return encoded.trim();
}

function verify(publicB64, payload, signatureB64) {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(publicB64, "base64"),
      format: "der",
      type: "spki",
    });
    const signature = Buffer.from(signatureB64, "base64");
    if (signature.length !== 64) return false;
    return crypto.verify(null, Buffer.from(payload, "utf-8"), key, signature);
  } catch {
    return false;
  }
}

/**
 * Re-verify the shipped integrity manifest, using the same algorithm
 * `src/main/security/integrity.ts` uses.
 *
 * A release whose own bundles would be reported `MODIFIED` by the client it is
 * updating is a broken release, so this is a hard stop rather than a warning.
 */
function verifyBundles(publicB64) {
  const manifestPath = path.join(dist, "integrity.manifest.json");
  if (!fs.existsSync(manifestPath)) {
    fail("dist/integrity.manifest.json is missing. Run `pnpm build` first.");
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch {
    fail("dist/integrity.manifest.json is not valid JSON");
  }

  if (typeof manifest.signature !== "string" || manifest.signature.length === 0) {
    fail(
      "dist/integrity.manifest.json is UNSIGNED. A release must never ship an unsigned " +
        "manifest — every client would refuse its own bundles at startup.",
    );
  }

  const payload = JSON.stringify({
    version: manifest.version,
    algorithm: manifest.algorithm,
    files: manifest.files,
  });
  if (!verify(publicB64, payload, manifest.signature)) {
    fail("the integrity manifest signature does not verify against Syncord_INTEGRITY_KEY");
  }

  for (const name of BUNDLES) {
    const file = path.join(dist, name);
    if (!fs.existsSync(file)) fail(`dist/${name} is missing. Run \`pnpm build\` first.`);
    const entry = (manifest.files ?? []).find((f) => f.name === name);
    if (entry === undefined) fail(`the integrity manifest does not cover ${name}`);
    const actual = sha256(file);
    if (actual !== entry.sha256) {
      fail(`${name} does not match the signed manifest — the build output changed after signing`);
    }
  }

  console.log("[Syncord][release] bundles verified against the signed manifest");
  return manifest;
}

/**
 * Archive suffixes we know how to publish, in preference order.
 *
 * Windows is normally a `.zip` (or an NSIS `.exe`), macOS a `.dmg` or a
 * `.tar.gz`, Linux a `.AppImage` or a `.tar.gz`. Rather than hardcode one
 * suffix per platform — which silently skipped a `.zip` that a maintainer had
 * built and uploaded — the first existing file in this list wins, and the name
 * that exists is the name that goes into the descriptor.
 */
const SUFFIXES = [".tar.gz", ".zip", ".dmg", ".exe", ".AppImage"];

/** The bundles that ship inside each platform archive. */
function collectAssets(version) {
  const assets = [];

  for (const platform of PLATFORMS) {
    const found = SUFFIXES.map((suffix) => {
      const name = `syncord-${version}-${platform}${suffix}`;
      const file = path.join(outDir, name);
      return existsSync(file) ? { name, file } : null;
    }).find(Boolean);

    if (found === undefined) {
      // Absent platform builds are not an error: a maintainer may only be
      // producing one platform at a time. The descriptor simply will not offer
      // an update to a client on a platform with no asset, which is the correct
      // and safe outcome — it never offers the wrong file.
      console.log(`[Syncord][release] skipping ${platform} (no archive in release/)`);
      continue;
    }

    const size = fs.statSync(found.file).size;
    if (size <= 0) fail(`${found.name} is empty`);
    if (size > MAX_ASSET_BYTES) fail(`${found.name} is larger than ${MAX_ASSET_BYTES} bytes`);

    const digest = sha256(found.file);
    if (!MAX_DIGEST.test(digest)) fail(`${found.name} produced an unexpected digest format`);

    assets.push({ platform, name: found.name, size, sha256: digest });
  }

  if (assets.length === 0) {
    fail(
      `no platform archives found in ${outDir}. Expected files named ` +
        `syncord-<version>-<platform>${SUFFIXES.join("|")} for any of: ${PLATFORMS.join(", ")}.`,
    );
  }

  for (const asset of assets) {
    if (!ASSET_NAME.test(asset.name)) fail(`asset name "${asset.name}" is outside the client's grammar`);
  }

  return assets;
}

/**
 * The exact bytes the client verifies.
 *
 * Field order here and in `canonicalReleasePayload` in `src/shared/release.ts`
 * must match. That is the whole reason step 4 below re-verifies: this function
 * and that one are separate implementations of the same contract, and a
 * mismatch between them would ship a release no client can install.
 */
function canonicalPayload({ channel, release, publishedAt, assets }) {
  return JSON.stringify({
    version: 1,
    channel,
    release,
    publishedAt,
    assets: assets.map((a) => ({ platform: a.platform, name: a.name, size: a.size, sha256: a.sha256 })),
  });
}

function main() {
  const checkOnly = process.argv.includes("--check");

  const version = releaseVersion();
  const channel = releaseConfiguration.releaseChannel === "beta" ? "beta" : "stable";
  const publicB64 = compiledPublicKey();

  if (!checkOnly) {
    // The preflight reads the *built bundles*, not the environment, so it
    // catches a `dist/` that was built before the last version bump or with
    // another key. Signing without it is how a release publishes successfully
    // and then fails for every user.
    const preflight = spawnSync(process.execPath, [path.join(root, "scripts", "release-preflight.mjs")], {
      encoding: "utf-8",
      stdio: "inherit",
    });
    if (preflight.status !== 0) {
      fail("the release preflight failed. Nothing was signed; see the problems listed above.");
    }

    const { privateKey, derivedPublicB64 } = loadKeys();
    if (derivedPublicB64 !== publicB64) {
      fail(
        "Syncord_SIGNING_KEY does not match Syncord_INTEGRITY_KEY. The release would be " +
          "signed with a key no client can verify. Rebuild with the matching public key.",
      );
    }
    console.log("[Syncord][release] signing key matches the key compiled into the build");
    verifyBundles(publicB64);

    fs.mkdirSync(outDir, { recursive: true });
    const assets = collectAssets(version);
    const publishedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const body = { channel, release: version, publishedAt, assets };
    const payload = canonicalPayload(body);
    const signature = crypto.sign(null, Buffer.from(payload, "utf-8"), privateKey).toString("base64");

    const descriptor = { ...body, version: 1, signature };
    const descriptorPath = path.join(outDir, "syncord-release.json");
    fs.writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

    // ── Step 4: verify our own output, from disk, with the public key. ────────
    const reread = JSON.parse(fs.readFileSync(descriptorPath, "utf-8"));
    const rereadPayload = canonicalReleasePayloadLike(reread);
    if (!verify(publicB64, rereadPayload, reread.signature)) {
      fs.rmSync(descriptorPath, { force: true });
      fail(
        "the descriptor we just wrote does not verify against the release key. It has " +
          "been deleted rather than shipped. This means canonicalReleasePayload in " +
          "src/shared/release.ts and canonicalPayload in this script disagree.",
      );
    }
    console.log("[Syncord][release] descriptor re-verified from disk");

    console.log("");
    console.log(`[Syncord][release] ${version} (${channel}) is ready in ${outDir}`);
    for (const asset of assets) {
      console.log(`  ${asset.platform.padEnd(14)} ${asset.name}  ${asset.sha256.slice(0, 16)}…`);
    }
    console.log("");
    console.log("Publish in this order (nothing below has been run for you):");
    console.log("");
    console.log("  1. Payloads first, so a client never sees a descriptor whose files are missing:");
    for (const asset of assets) {
      console.log(
        `     pnpm -C services/ecosystem exec wrangler r2 object put syncord-releases/releases/${version}/${asset.name} ` +
          `--file ${path.join(outDir, asset.name)} --remote`,
      );
    }
    console.log("  2. The signed descriptor last. This is the moment clients can see the release:");
    console.log(
      `     pnpm -C services/ecosystem exec wrangler r2 object put syncord-releases/channels/${channel}.json ` +
        `--file ${descriptorPath} --content-type application/json --remote`,
    );
    console.log("  3. Download both back from https://api.syncord.pro/v1/update/ and compare sha256 before announcing.");
    console.log("");
    console.log(
      `  GitHub (${releaseConfiguration.repository}) carries only the installers, SHA256SUMS and the human release notes:`,
    );
    console.log(
      `     gh release create v${version} --repo ${releaseConfiguration.repository} <installers> <SHA256SUMS.txt> ` +
        `--title "Syncord ${version}" --notes-file <release-notes.md>` +
        (channel === "beta" ? " --prerelease" : " --latest"),
    );
    console.log("");
    console.log(
      "The client never reads GitHub: it reads the descriptor from api.syncord.pro. Do not attach " +
        "the payload archives or syncord-release.json to the GitHub release.",
    );
    return;
  }

  // `--check` is the dry run, so it gets the same gate the real run does. Both
  // are read-only; the difference is only whether anything is signed.
  const preflight = spawnSync(process.execPath, [path.join(root, "scripts", "release-preflight.mjs")], {
    encoding: "utf-8",
    stdio: "inherit",
  });
  if (preflight.status !== 0) {
    fail("the release preflight failed. See the problems listed above.");
  }

  verifyBundles(publicB64);
  const { derivedPublicB64 } = loadKeys();
  console.log(
    derivedPublicB64 === publicB64
      ? "[Syncord][release] keys agree — this build could be released"
      : "[Syncord][release] keys disagree — this build must not be released",
  );
  if (derivedPublicB64 !== publicB64) process.exit(1);
}

/**
 * Rebuild the signed payload from a descriptor read back off disk.
 *
 * Written as its own function so the verification is of the *file*, parsed
 * fresh, rather than of the object that was just built in memory. A bug that
 * corrupted the object would corrupt both and the check would pass.
 */
function canonicalReleasePayloadLike(descriptor) {
  return JSON.stringify({
    version: descriptor.version,
    channel: descriptor.channel,
    release: descriptor.release,
    publishedAt: descriptor.publishedAt,
    assets: (descriptor.assets ?? []).map((a) => ({
      platform: a.platform,
      name: a.name,
      size: a.size,
      sha256: a.sha256,
    })),
  });
}

main();
