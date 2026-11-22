import * as esbuild from "esbuild";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readReleaseConfiguration } from "./lib/release-config.mjs";
import { spawn } from "node:child_process";

import { resizePng } from "./lib/resizePng.mjs";

const shared = {
  bundle: true,
  sourcemap: true,
  minify: false,
  logLevel: "info",
  target: "es2022",
};

const watch = process.argv.includes("--watch");
const sync = process.argv.includes("--sync");

/**
 * Build-time facts, so there is one copy of each.
 *
 * `VERSION` and the release repository used to be literals in the TypeScript,
 * kept in step with `package.json` and the git remote by hand. Two copies of
 * one fact is two things that can disagree, and both disagreements are silent:
 * a version that lags makes the updater offer a release as newer when it is
 * not, and a wrong repository makes the updater ask GitHub for a feed that does
 * not exist and report "up to date" forever.
 *
 * `define` rather than a runtime read, deliberately. Anything the main process
 * reads from `process.env` can be changed by whoever launched it; the feed host
 * is a constant precisely so the feed cannot be pointed elsewhere, and a
 * repository read at startup would undo that.
 */
const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"));

const releaseConfiguration = readReleaseConfiguration(process.cwd());
const releaseRepo = releaseConfiguration.repository;
const buildVersion = releaseConfiguration.releaseVersion || pkg.version;
if (!/^\d{1,6}(?:\.\d{1,6}){0,3}(?:-[0-9A-Za-z.-]{1,32})?$/.test(String(buildVersion))) {
  throw new Error("The build version is not a version the client would accept");
}
// The git remote names the source checkout, not the public update feed.

/**
 * What an unkeyed build gets compiled with.
 *
 * Lives here rather than in `signing.ts` because always emitting a syntactically
 * valid define is the build's job; the verifier only has to decide whether what
 * it was handed is a real key, which it does structurally in
 * `signingKeyPresent()`. One literal, one place, no second copy to drift.
 *
 * It is deliberately not a valid SPKI DER for any signer, so a build that forgets
 * the variable fails closed: verification returns false, the updater refuses,
 * and the client reports itself as unable to check rather than as checked.
 */
const PLACEHOLDER_INTEGRITY_KEY = "sOOl0replacethiswitharealEd25519publickeybase64value0=";

/**
 * Facts every bundle carries.
 *
 * `main` and `preload` both need the version; only `main` needs the repository
 * and the integrity key. The renderer gets only the public version for UI
 * labels. Release endpoints and signing configuration remain outside the page.
 *
 * The key is compiled in for the same reason the repository is, and the force of
 * the argument is higher rather than lower: the repository decides *where* an
 * update comes from, the key decides *whether it is genuine*. A repository read
 * from `process.env` at startup can be redirected by whoever launched the
 * process, and a signature still has to verify. A **key** read from `process.env`
 * is worse, because the value is not something a user would ever set — so nothing
 * would look wrong, and the client's own integrity check would quietly stop
 * verifying anything at all. That is not hypothetical; it is exactly what this
 * build did, and the symptom was an updater that reported nothing and a
 * Security Center that reported every plugin as unverifiable.
 *
 * The placeholder is what an unkeyed build gets, and it is not a valid key for
 * any signer, so the build fails closed — see `signingKeyPresent()`. A build
 * without a key is inert by design, not broken; what it must never be is
 * quietly wrong.
 */
const integrityKey = releaseConfiguration.integrityKey || PLACEHOLDER_INTEGRITY_KEY;

if (releaseConfiguration.signingKey) {
  // Refuse an incorrectly configured signed build before writing any bundles.
  const key = crypto.createPrivateKey({ key: Buffer.from(releaseConfiguration.signingKey, "base64"), format: "der", type: "pkcs8" });
  if (key.asymmetricKeyType !== "ed25519"
    || crypto.createPublicKey(key).export({format:"der",type:"spki"}).toString("base64") !== integrityKey) {
    throw new Error("The release signing key does not match the compiled Ed25519 public key");
  }
}

const ecosystemConfig=JSON.parse(fs.readFileSync(path.join(process.cwd(),"config/ecosystem.json"),"utf8"));
const ecosystemOrigin=ecosystemConfig.origin??"";
if(ecosystemOrigin){const u=new URL(ecosystemOrigin);if(u.protocol!=="https:"||u.origin!==ecosystemOrigin||u.username||u.password||u.port||! /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(u.hostname)||/(?:^|\.)(localhost|local|internal|test|invalid)$/.test(u.hostname))throw Error("Ecosystem origin must be an exact public HTTPS origin");}
const buildFacts = {
  __SYNCORD_ECOSYSTEM_ORIGIN__: JSON.stringify(ecosystemOrigin),
  __SYNCORD_VERSION__: JSON.stringify(buildVersion),
  __SYNCORD_RELEASE_REPO__: JSON.stringify(releaseRepo),
  __SYNCORD_INTEGRITY_KEY__: JSON.stringify(integrityKey),
};

let syncTimer;
function scheduleSync() {
  if (!sync) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    const child = spawn(process.execPath, ["scripts/inject.mjs", "sync"], {
      stdio: "inherit",
    });
    child.on("close", (code) => {
      if (code === 0) {
        console.log("[Syncord] Synced — Syncord.reload() or restart Discord");
      }
    });
  }, 150);
}

const syncPlugin = {
  name: "Syncord-sync",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      scheduleSync();
    });
  },
};

/**
 * Map renderer.js positions to source modules for slow-frame attribution
 * (src/renderer/core/performance/diagnostics.ts). Unminified esbuild output
 * marks each module with a `// src/...` comment; the table is appended at the
 * end so no earlier offset moves, and a sourceURL lets Chromium name the
 * script injected through webFrame.executeJavaScript.
 */
function rendererModuleMap(code) {
  const map = [];
  for (const match of code.matchAll(/^[ \t]*\/\/ (?:src\/renderer\/|src\/|node_modules\/)(\S+)$/gm)) {
    const file = match[1];
    const plugin = /^plugins\/([^/]+?)(?:\.ts|\/.*)?$/.exec(file);
    const key = plugin ? `plugins/${plugin[1]}` : match[0].includes("node_modules/") ? "deps" : file.replace(/\.tsx?$/, "");
    if (map.at(-1)?.[1] !== key) map.push([match.index, key]);
  }
  return map;
}

const moduleMapPlugin = {
  name: "Syncord-module-map",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      const file = build.initialOptions.outfile;
      const code = fs.readFileSync(file, "utf-8");
      const map = JSON.stringify(rendererModuleMap(code));
      fs.appendFileSync(
        file,
        `\n;try{Object.defineProperty(window,"__SyncordModuleMap",{value:Object.freeze(${map}),configurable:true})}catch{}\n//# sourceURL=syncord-renderer.js\n`,
      );
    });
  },
};

/** Inline PNGs as data URLs. Header art is large, so shrink it first. */
const pngPlugin = {
  name: "png-dataurl",
  setup(build) {
    build.onResolve({ filter: /\.png$/ }, (args) => ({
      path: path.isAbsolute(args.path)
        ? args.path
        : path.resolve(args.resolveDir, args.path),
      namespace: "png-dataurl",
    }));

    build.onLoad({ filter: /.*/, namespace: "png-dataurl" }, (args) => {
      const shrunk = resizePng(fs.readFileSync(args.path), 128);
      const data = shrunk.toString("base64");
      return {
        contents: `export default ${JSON.stringify(`data:image/png;base64,${data}`)};`,
        loader: "js",
      };
    });
  },
};

/** @type {esbuild.BuildOptions[]} */
const builds = [
  {
    ...shared,
    entryPoints: ["src/main/index.ts"],
    outfile: "dist/main.js",
    platform: "node",
    format: "cjs",
    external: ["electron"],
    define: buildFacts,
    plugins: sync ? [syncPlugin] : [],
  },
  {
    ...shared,
    entryPoints: ["src/preload/index.ts"],
    outfile: "dist/preload.js",
    platform: "node",
    format: "cjs",
    external: ["electron"],
    // The same facts as main, and for the same reasons. Only the version and the
    // repository are actually referenced here -- the preload does no verification
    // and has no business holding the key -- so the key define is inert in this
    // bundle. It used to be spelled a second way, as a
    // `process.env.Syncord_INTEGRITY_KEY` substitution, which was inert too and
    // for the same reason: esbuild only replaces an expression that appears. Two
    // spellings of one value, neither of them effective here, is one more thing to
    // misread when working out why a key is or is not reaching a process.
    define: buildFacts,
    plugins: sync ? [syncPlugin] : [],
  },
  {
    ...shared,
    entryPoints: ["src/renderer/index.ts"],
    outfile: "dist/renderer.js",
    platform: "browser",
    format: "iife",
    // Public display version only; do not forward all main-process build facts.
    define: { __SYNCORD_VERSION__: JSON.stringify(buildVersion) },
    // No `define` for secrets. The renderer bundle must not contain any
    // credential: it is copied into the Discord install, where every plugin
    // running in the page can read it.
    plugins: sync ? [pngPlugin, moduleMapPlugin, syncPlugin] : [pngPlugin, moduleMapPlugin],
  },
];

/**
 * Phase 18: write the integrity manifest for the emitted bundles.
 *
 * The manifest is only as trustworthy as its signature, so:
 *  - with `Syncord_SIGNING_KEY` (base64 Ed25519 private key) the manifest is
 *    signed, and the verification code compiled into `main.js` is built with the
 *    matching public key;
 *  - without it, the manifest is written *unsigned* and the build prints a loud
 *    warning. An unsigned manifest is still useful — it detects accidental
 *    corruption and a partially-written sync — but it is not a security control,
 *    and the startup check reports `unreadable` rather than `ok` so the Security
 *    Center does not claim a protection that is not there.
 *
 * The private key is never written into the repository, the build output, or a
 * log line.
 */
const SIGNED_FILES = ["main.js", "preload.js", "renderer.js"];

function buildManifest(dist) {
  const files = [];
  for (const name of SIGNED_FILES) {
    const file = path.join(dist, name);
    if (!fs.existsSync(file)) continue;
    files.push({
      name,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    });
  }
  if (files.length !== SIGNED_FILES.length) {
    console.warn(
      `[Syncord] integrity manifest incomplete (${files.length}/${SIGNED_FILES.length} bundles found)`,
    );
  }
  return { version: 1, algorithm: "ed25519", files };
}

function writeManifest(dist) {
  const manifest = buildManifest(dist);
  const privateKey = releaseConfiguration.signingKey;

  /*
   * The version stamp, written here so that it cannot disagree with the version
   * compiled into the bundles.
   *
   * It used to be written by `sign-payload.mjs`, which read `package.json`. The
   * compiled version comes from `dist/`, so anything that changed `package.json`
   * between the build and the signing — a version bump, a `git checkout` — put a
   * different version in the stamp than the one the client would report. Nothing
   * in the release path noticed; only the Injector packager's own self-check
   * caught it, at packaging time, with a message about a version mismatch that
   * had nothing to do with packaging.
   *
   * Writing it from the build removes the possibility rather than the symptom:
   * one value, produced once, carried into the payload.
   */
  fs.writeFileSync(
    path.join(dist, "syncord-version.json"),
    `${JSON.stringify({ version: buildVersion }, null, 2)}\n`,
  );

  if (privateKey) {
    try {
      const key = crypto.createPrivateKey({
        key: Buffer.from(privateKey, "base64"),
        format: "der",
        type: "pkcs8",
      });
      // Sign the canonical serialization, matching src/main/security/integrity.ts
      // exactly. Re-serializing rather than signing raw bytes means whitespace
      // cannot be used to smuggle a different payload past the check.
      const payload = Buffer.from(JSON.stringify(manifest), "utf-8");
      manifest.signature = crypto.sign(null, payload, key).toString("base64");
      fs.writeFileSync(
        path.join(dist, "integrity.manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      console.log("[Syncord] integrity manifest written and signed");
      return;
    } catch (err) {
      throw new Error("Release manifest signing failed; refusing this build", { cause: err });
    }
  } else {
    console.warn(
      "[Syncord] Syncord_SIGNING_KEY not set — integrity manifest is UNSIGNED.\n" +
        "                Startup integrity will report UNVERIFIED. This is expected for\n" +
        "                local development and must not be used for a release build.",
    );
  }

  fs.writeFileSync(
    path.join(dist, "integrity.manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

if (watch) {
  const contexts = await Promise.all(builds.map((opts) => esbuild.context(opts)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log(
    "[Syncord] Watching…" + (sync ? " (auto-sync on rebuild)" : ""),
  );
  // Watch mode never writes a manifest: the output changes constantly and a
  // stale manifest would produce integrity failures that mean nothing.
} else {
  await Promise.all(builds.map((opts) => esbuild.build(opts)));
  writeManifest(path.join(process.cwd(), "dist"));
  // What went in, stated plainly. A release built against the wrong repository
  // looks exactly like a correct one until the updater silently stops working,
  // so the two facts that steer it are printed on every build.
  console.log(`[Syncord] version ${buildVersion} · releases from ${releaseRepo}`);
  console.log("[Syncord] Build completed");
  if (sync) scheduleSync();
}
