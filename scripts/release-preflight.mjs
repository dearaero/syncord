/**
 * Release preflight: check the *built artifact*, not the environment.
 *
 * Run: `node scripts/release-preflight.mjs`
 *
 * ── Why this reads `dist/` rather than `process.env` ─────────────────────────
 *
 * Every key check that only looks at the environment is checking the wrong
 * thing. The environment can be correct while the bundle in `dist/` was built
 * twenty minutes ago with a different one, from a different checkout, on a
 * developer's laptop. That is not a contrived scenario; it is what a stale
 * `dist/` is.
 *
 * The consequences are all silent, which is what makes them worth a gate:
 *
 *   - a bundle whose compiled version lags `package.json` makes the updater
 *     offer a release it already has, or hide one it needs;
 *   - a bundle compiled for the wrong repository asks GitHub for a feed that
 *     does not exist and reports "you are up to date" — forever, with no error
 *     anywhere;
 *   - a bundle compiled with the wrong public key accepts nothing, or, worse,
 *     accepts something only the person who made the mistake knows about;
 *   - an unsigned manifest means every client refuses its own bundles at
 *     startup.
 *
 * Each of those produces a release that *publishes successfully* and fails for
 * every user. So the preflight reads the emitted bundles, where the truth is.
 *
 * ── What it deliberately does not do ──────────────────────────────────────────
 *
 * It does not check that the private key is safe, that the secrets are stored
 * correctly, or that anyone was authorised to run it. It checks that the thing
 * about to be published is internally consistent. A green preflight means "this
 * artifact is coherent", not "this artifact is good".
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readReleaseConfiguration } from "./lib/release-config.mjs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const SIGNED_FILES = ["main.js", "preload.js", "renderer.js"];

/**
 * What to check. Overridable so the tests can point this at a fixture instead
 * of the working tree — a preflight that can only run against `dist/` is a
 * preflight whose failure paths never get exercised, because producing each
 * failure means breaking the real build.
 */
function parseArgs(argv) {
  const options = { dist: path.join(root, "dist"), pkg: path.join(root, "package.json") };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--dist":
        options.dist = path.resolve(argv[i + 1]);
        i += 1;
        break;
      case "--package":
        options.pkg = path.resolve(argv[i + 1]);
        i += 1;
        break;
      default:
        fail(`unknown flag: ${argv[i]}`);
    }
  }
  return options;
}

let dist = path.join(root, "dist");
let packageFile = path.join(root, "package.json");

/** Problems found, rather than the first one. Every one of them is actionable. */
const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

/**
 * Read a value esbuild compiled in from a `define`.
 *
 * `constants.ts` guards the define with `typeof X === "string"`, which esbuild
 * folds to a literal when the define is present. So the shape is
 * `var NAME = true ? "value" : void 0;` when it landed and
 * `var NAME = false ? … : void 0` when it did not — and "did not land" is
 * exactly the failure this is looking for, so `true` is required rather than
 * assumed. The renderer can hoist declarations into an ESM initializer, so
 * accept the same literal assignment with or without an inline var declaration.
 */
function readDefine(bundle, name) {
  const source = fs.readFileSync(path.join(dist, bundle), "utf-8");
  const pattern = new RegExp(String.raw`^\s*(?:var )?${name} = (true|false) \? ("(?:[^"\\]|\\.)*") :`, "m");
  const match = pattern.exec(source);
  if (match === null) {
    return { present: false, value: null };
  }
  return { present: match[1] === "true", value: JSON.parse(match[2]) };
}

function readPackageVersion() {
  return JSON.parse(fs.readFileSync(packageFile, "utf-8")).version;
}

/** The same grammar the client enforces, checked here so it fails on a runner. */
const VERSION_GRAMMAR = /^\d{1,6}(?:\.\d{1,6}){0,3}(?:-[0-9A-Za-z.-]{1,32})?$/;

function main() {
  const releaseConfiguration = readReleaseConfiguration(root);
  const options = parseArgs(process.argv.slice(2));
  dist = options.dist;
  packageFile = options.pkg;

  // ── The bundles exist at all ───────────────────────────────────────────────
  for (const name of SIGNED_FILES) {
    if (!fs.existsSync(path.join(dist, name))) {
      fail(`dist/${name} is missing. Run \`pnpm build\` first.`);
    }
  }
  if (problems.length > 0) return report();

  const pkgVersion = releaseConfiguration.releaseVersion || readPackageVersion();

  // ── 1. The compiled version is the intended release version ────────────────────────
  //
  // Check all three realms: the renderer displays the version in Settings.
  // An omitted renderer define otherwise ships a misleading "vunbuilt" label
  // even when the signed main/preload bundles agree.
  for (const bundle of SIGNED_FILES) {
    const version = readDefine(bundle, "COMPILED_VERSION");
    if (!version.present) {
      fail(
        `dist/${bundle} has no compiled-in version. The __SYNCORD_VERSION__ define did not ` +
          `reach the bundle, so the client would report itself as "unbuilt" and refuse every ` +
          `update. Rebuild with \`pnpm build\`.`,
      );
      continue;
    }
    if (version.value !== pkgVersion) {
      fail(
        `dist/${bundle} was built with version ${version.value} but ${releaseConfiguration.releaseVersion ? "release configuration" : "package.json"} says ` +
          `${pkgVersion}. The bundle is stale; rebuild before releasing.`,
      );
    }
  }

  if (!VERSION_GRAMMAR.test(pkgVersion)) {
    fail(
      `package.json version "${pkgVersion}" is not a version the client would accept, so a ` +
        `client would refuse the release.`,
    );
  }

  // ── The compiled integrity key is a real key, and the one we signed with ──
  //
  // This is the check whose absence let a fully published, fully signed release
  // reach users who could not install it.
  //
  // `signing.ts` used to read the public key from `process.env.Syncord_INTEGRITY_KEY`
  // at runtime. The Discord process has no `Syncord_*` variables in its
  // environment, so every launched client fell through to the placeholder, and
  // because the placeholder is not a valid key "fails closed" held exactly as
  // designed: the updater refused every release with "this build has no release
  // signing key" and logged nothing, while the client's own integrity check
  // reported every plugin as unverifiable.
  //
  // Every test passed, because every test built the module with the variable set
  // in the environment -- the way the release pipeline does. They were testing the
  // build machine's shell rather than the artifact it produced, and no amount of
  // unit testing that module could have found it. Only an assertion about the
  // *bundle* can, which is why this lives here and not in a test of `signing.ts`.
  const compiledKey = readDefine("main.js", "COMPILED_INTEGRITY_KEY");
  if (!compiledKey.present) {
    fail(
      "dist/main.js has no compiled-in integrity key. The __SYNCORD_INTEGRITY_KEY__ define " +
        "did not reach the bundle, so every client would refuse every update as unverifiable " +
        "and report its own plugins as unsigned. Rebuild with `pnpm build` and " +
        "Syncord_INTEGRITY_KEY set.",
    );
  } else if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compiledKey.value)) {
    fail(
      `the compiled integrity key is not valid base64, so no client could use it. ` +
        `Rebuild with a real SPKI Ed25519 public key.`,
    );
  } else {
    // Parse it the way the client does. A key that base64-decodes but is not
    // Ed25519 SPKI is the same failure as no key at all, with a subtler cause.
    try {
      const parsed = crypto.createPublicKey({
        key: Buffer.from(compiledKey.value, "base64"),
        format: "der",
        type: "spki",
      });
      if (parsed.asymmetricKeyType !== "ed25519") {
        fail(
          `the compiled integrity key is a ${parsed.asymmetricKeyType} key; the client only ` +
            `verifies ed25519, so every signature would be rejected.`,
        );
      }
    } catch {
      fail(
        "the compiled integrity key does not parse as SPKI DER, so `signingKeyPresent()` " +
          "returns false in every client and updates are refused everywhere.",
      );
    }
  }

  // ── 3. The integrity manifest is signed, and signs what is there ──────────
  const manifestPath = path.join(dist, "integrity.manifest.json");
  if (!fs.existsSync(manifestPath)) {
    fail("dist/integrity.manifest.json is missing. Run `pnpm build` first.");
    return report();
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    fail(`dist/integrity.manifest.json is not valid JSON: ${err.message}`);
    return report();
  }

  if (typeof manifest.signature !== "string" || manifest.signature.length === 0) {
    fail(
      "dist/integrity.manifest.json is UNSIGNED. A release must never ship an unsigned " +
        "manifest: every client would refuse its own bundles at startup, and the startup " +
        "check would report MODIFIED for a build nobody tampered with.",
    );
  } else {
    for (const entry of manifest.files ?? []) {
      const file = path.join(dist, entry.name);
      if (!fs.existsSync(file)) continue;
      const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      if (actual !== entry.sha256) {
        fail(
          `${entry.name} does not match the signed manifest. The build output changed after ` +
            `signing — a watcher, a formatter, or a second build. Rebuild and re-sign.`,
        );
      }
    }
    for (const name of SIGNED_FILES) {
      const covered = (manifest.files ?? []).some((f) => f.name === name);
      if (!covered) fail(`the integrity manifest does not cover ${name}.`);
    }
  }

  // ── 4. The keys agree, and the signature is real ─────────────────────────
  const publicB64 = releaseConfiguration.integrityKey;
  if (publicB64.length === 0) {
    fail(
      "Syncord_INTEGRITY_KEY is not set. Without it the preflight cannot confirm that the " +
        "shipped bundles verify against the key clients were built with, which is the one " +
        "property a release absolutely needs.",
    );
    return report();
  }

  if (compiledKey.value !== publicB64) {
    fail("The compiled integrity key does not match the configured release public key. Rebuild before publishing.");
  }
  let publicKey;
  try {
    publicKey = crypto.createPublicKey({
      key: Buffer.from(publicB64, "base64"),
      format: "der",
      type: "spki",
    });
  } catch {
    fail("Syncord_INTEGRITY_KEY could not be parsed as a base64 SPKI Ed25519 key.");
    return report();
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    fail(`Syncord_INTEGRITY_KEY is a ${publicKey.asymmetricKeyType} key; Syncord uses ed25519.`);
    return report();
  }

  if (typeof manifest.signature === "string" && manifest.signature.length > 0) {
    // The exact bytes `src/main/security/integrity.ts` verifies. Re-deriving
    // them here is the point: a manifest that is signed over a *different*
    // serialization is a manifest every client rejects.
    const payload = JSON.stringify({
      version: manifest.version,
      algorithm: manifest.algorithm,
      files: manifest.files,
    });
    let ok = false;
    try {
      ok = crypto.verify(
        null,
        Buffer.from(payload, "utf-8"),
        publicKey,
        Buffer.from(manifest.signature, "base64"),
      );
    } catch {
      ok = false;
    }
    if (!ok) {
      fail(
        "the integrity manifest signature does not verify against Syncord_INTEGRITY_KEY. Either " +
          "the manifest was signed with a different private key, or the build's compiled key " +
          "does not match the signing key. A client built with this key would refuse its own " +
          "bundles.",
      );
    } else {
      notes.push("integrity manifest verifies against the release key");
    }
  }

  // ── 5. The private key, when we have it, is the public key's other half ──
  const privateB64 = releaseConfiguration.signingKey;
  if (privateB64.length > 0) {
    try {
      const privateKey = crypto.createPrivateKey({
        key: Buffer.from(privateB64, "base64"),
        format: "der",
        type: "pkcs8",
      });
      const derived = crypto
        .createPublicKey(privateKey)
        .export({ format: "der", type: "spki" })
        .toString("base64");
      if (derived !== publicB64) {
        fail(
          "Syncord_SIGNING_KEY and Syncord_INTEGRITY_KEY are different keys. The release would " +
            "be signed with a key no client can verify. This is the rotated-the-key-and-forgot-to-" +
            "rebuild case.",
        );
      } else {
        notes.push("signing key matches the key compiled into the build");
      }
    } catch (err) {
      fail(`Syncord_SIGNING_KEY could not be parsed as a base64 PKCS#8 Ed25519 key (${err.code ?? "parse error"}).`);
    }
  } else {
    notes.push("Syncord_SIGNING_KEY is not set — nothing will be signed by this preflight run");
  }

  report();
}

/** The repository the source code names, for comparison with the compiled one. */
function readSourceDefaultRepo() {
  try {
    const source = fs.readFileSync(path.join(root, "src", "shared", "release.ts"), "utf-8");
    const match = /export const DEFAULT_RELEASE_REPO = "([^"]+)"/.exec(source);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

function report() {
  for (const note of notes) console.log(`[Syncord][preflight] ${note}`);

  if (problems.length > 0) {
    console.error("");
    console.error(`[Syncord][preflight] ${problems.length} problem(s) — this release is not publishable:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("");
    process.exit(1);
  }

  console.log(`[Syncord][preflight] ${readPackageVersion()} is internally consistent and ready to sign`);
}

main();
