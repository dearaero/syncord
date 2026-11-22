/**
 * Package the Injector for release.
 *
 * Run: `node injector/scripts/package.mjs [--out DIR] [--payload DIR]`
 *
 * Produces one archive per target platform, each containing the Injector *and*
 * a verified `payload/` directory. That pairing is the whole point: an Injector
 * on its own can discover Discord but cannot install anything, and the failure
 * it reports ("no verified payload beside the Injector") reads like a corrupt
 * download rather than a packaging mistake.
 * `--standalone` instead requires a binary with an embedded signed payload and
 * ships no adjacent payload directory. The real binary self-check still runs.
 *
 * ── Why the layouts differ ───────────────────────────────────────────────────
 *
 * macOS gets a real `.app`, because that is what a macOS user expects to
 * double-click, and because Tauri's `bundle.resources` embeds the payload at
 * `Contents/Resources/payload` — inside the part of the bundle that code signing
 * covers, rather than beside the executable where nothing would.
 *
 * Windows and Linux get a portable directory: the raw binary plus `payload/`
 * beside it. An NSIS installer or a `.deb` would place the binary in Program
 * Files or `/usr/bin`, where there is no payload beside it. Those artifacts
 * would launch, discover Discord, and then be unable to install anything.
 * `syncord_core::inject::payload_dir_for_exe` knows all three layouts, and
 * `crates/syncord-core/src/tests/inject.rs` pins the search order.
 *
 * ── What this does not do ────────────────────────────────────────────────────
 *
 * No code signing and no notarization. A macOS `.app` produced here is
 * unsigned, so Gatekeeper will refuse it on another machine until the user
 * clears it by hand. That is a known gap, not an oversight — see
 * `injector/PACKAGING.md` — and it is why the auto-update path does not depend
 * on these artifacts: the Electron client stages a signed payload and the
 * Injector is spawned already carrying it.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INJECTOR_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(INJECTOR_ROOT, "..");

/** The files a payload must contain, per `syncord_core::archive::PAYLOAD_REQUIRED`. */
const PAYLOAD_REQUIRED = [
  "main.js",
  "preload.js",
  "renderer.js",
  "integrity.manifest.json",
  "syncord-version.json",
];

/** Must match `identifier` in `src-tauri/tauri.conf.json`. */
const BUNDLE_IDENTIFIER = "app.syncord.injector";

const PLATFORMS = {
  "macos-aarch64": { os: "macos", arch: "aarch64", ext: "tar.gz" },
  "macos-x86_64": { os: "macos", arch: "x86_64", ext: "tar.gz" },
  "linux-x86_64": { os: "linux", arch: "x86_64", ext: "tar.gz" },
  "linux-aarch64": { os: "linux", arch: "aarch64", ext: "tar.gz" },
  "windows-x86_64": { os: "windows", arch: "x86_64", ext: "zip" },
};

function parseArgs(argv) {
  const options = {
    out: path.join(INJECTOR_ROOT, "dist"),
    payload: path.join(INJECTOR_ROOT, "payload"),
    version: "0.1.0",
    target: currentTarget(),
    binary: null,
    runner: null,
    standalone: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--standalone":
        options.standalone = true;
        break;
      case "--out":
        options.out = path.resolve(value);
        i += 1;
        break;
      case "--payload":
        options.payload = path.resolve(value);
        i += 1;
        break;
      case "--version":
        options.version = value;
        i += 1;
        break;
      case "--target":
        options.target = value;
        i += 1;
        break;
      case "--binary":
        // An already-built executable, for a target this machine did not
        // compile. Packaging a cross-compiled artifact is the normal case in
        // CI, where the Rust build matrix and the packaging step are separate
        // jobs; passing the path in is how the two meet.
        options.binary = path.resolve(value);
        i += 1;
        break;
      case "--runner":
        // An explicit local runner (for example Wine) must execute the binary.
        // Its output is checked by the same payload verification gate.
        options.runner = path.resolve(value);
        i += 1;
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  return options;
}

function currentTarget() {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "darwin") return `macos-${arch}`;
  if (process.platform === "win32") return "windows-x86_64";
  return `linux-${arch}`;
}

/**
 * Refuse to package a payload that is not complete.
 *
 * A missing file here would produce an artifact that downloads fine, launches
 * fine, and then reports "no verified payload" — so the check belongs in the
 * packager, where it can still stop the release, rather than in the GUI.
 */
function assertPayloadComplete(dir) {
  const missing = PAYLOAD_REQUIRED.filter((name) => !fs.existsSync(path.join(dir, name)));
  if (missing.length > 0) {
    throw new Error(
      `payload at ${dir} is missing ${missing.join(", ")}.\n` +
        `Build and sign it first: node scripts/release.mjs --help`,
    );
  }
}

/** Copy a directory tree, rejecting anything that is not a file or directory. */
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`payload contains a symbolic link: ${source}`);
    }
    if (entry.isDirectory()) {
      copyTree(source, target);
    } else if (entry.isFile()) {
      fs.copyFileSync(source, target);
    } else {
      throw new Error(`payload contains a non-regular file: ${source}`);
    }
  }
}

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
 * Sorted entries and a fixed mtime on GNU tar; bsdtar has neither, so the mtime
 * is fixed on the staged files instead (see `freezeTimestamps`) and only the
 * ownership fields are passed, spelled the way bsdtar spells them.
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
  for (const nested of fs.readdirSync(dir, { withFileTypes: true })) {
    if (nested.isDirectory()) freezeTimestamps(path.join(dir, nested.name), when);
  }
  fs.utimesSync(dir, when, when);
}

/**
 * Reproducible tar.gz: fixed mtime, owner, and sorted entries.
 *
 * Two steps rather than `tar -czf`, because gzip writes the archive's mtime into
 * its own header. `tar -z` therefore produces different bytes on every run even
 * with every tar flag pinned, which makes "did the artifact change?" unanswerable
 * — the exact question a release digest exists to answer. `gzip -n` omits the
 * timestamp and the stored filename, so identical inputs give identical bytes.
 */
function tarGz(sourceDir, outFile) {
  freezeTimestamps(sourceDir);

  // A scratch directory, rather than a name derived from `outFile`. Deriving one
  // is how the previous version ended up asking gzip to write
  // `…tar.gz.tar.gz`, and then refusing to overwrite the result of a run that
  // had already failed — a failure that looked like a permissions problem and
  // was really a leftover.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "syncord-tar-"));
  const plain = path.join(scratch, "archive.tar");
  try {
    const tarred = spawnSync(
      "tar",
      [
        ...tarReproducibilityFlags(),
        "-cf",
        plain,
        "-C",
        path.dirname(sourceDir),
        path.basename(sourceDir),
      ],
      { env: { ...process.env, COPYFILE_DISABLE: "1" }, encoding: "utf-8" },
    );
    if (tarred.status !== 0) {
      throw new Error(`tar failed: ${tarred.stderr || tarred.stdout}`);
    }

    // `gzip` appends `.gz` to whatever it is given, so it is pointed at the
    // scratch file and the result is renamed onto the final name.
    const gzipped = spawnSync("gzip", ["-n", "-9", plain], { encoding: "utf-8" });
    if (gzipped.status !== 0) {
      throw new Error(`gzip failed: ${gzipped.stderr || gzipped.stdout}`);
    }
    fs.rmSync(outFile, { force: true });
    fs.copyFileSync(`${plain}.gz`, outFile);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function zipDir(sourceDir, outFile) {
  freezeTimestamps(sourceDir);
  // Windows runners provide PowerShell, but do not provide the Unix zip CLI.
  // Paths are passed as environment values, never interpolated into commands.
  if (process.platform === "win32") {
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath $env:SYNCORD_ARCHIVE_SOURCE -DestinationPath $env:SYNCORD_ARCHIVE_OUTPUT -CompressionLevel Optimal",
    ], {
      encoding: "utf-8",
      env: { ...process.env, SYNCORD_ARCHIVE_SOURCE: sourceDir, SYNCORD_ARCHIVE_OUTPUT: outFile },
    });
    if (result.status !== 0) {
      throw new Error(`Compress-Archive failed: ${result.error?.message ?? result.stderr ?? result.stdout}`);
    }
    return;
  }
  // `zip -X` drops the extra fields that would otherwise record the host and
  // build time, so the archive is reproducible too.
  const result = spawnSync(
    "zip",
    ["-X", "-r", "-q", outFile, path.basename(sourceDir)],
    { cwd: path.dirname(sourceDir), encoding: "utf-8" },
  );
  if (result.status !== 0) {
    throw new Error(`zip failed: ${result.stderr || result.stdout}`);
  }
}

/** SHA-256 of a file, as `release.json` and `updater.ts` both spell it. */
function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Assemble the macOS `.app` bundle.
 *
 * ── Why not `tauri build --bundles app` ─────────────────────────────────────
 *
 * It works, and it was the first thing tried. It needs the `tauri-cli` binary,
 * which is not a dependency of anything else in this repository and is
 * installed with `cargo install tauri-cli` — a multi-minute compile on every CI
 * run, at whatever version the caret resolves to that week. A release artifact
 * whose build depends on a floating tool is an artifact nobody can reproduce,
 * and the cost buys nothing here: a `.app` is a documented directory layout, and
 * the parts Tauri would add beyond what is here are app-store metadata this
 * project does not need.
 *
 * The result is validated below, and `cargo test` pins the payload lookup order
 * that depends on this layout, so a mistake here fails rather than shipping.
 *
 * Ad-hoc code signing (`codesign -s -`) is applied. That is *not* identity
 * signing: it produces a structurally valid bundle that `codesign --verify`
 * accepts, and nothing more. Gatekeeper on another machine will still refuse it
 * until the user clears it, which is the known and documented gap — see
 * `injector/PACKAGING.md`. The payload is covered by Syncord's own Ed25519
 * signature regardless, which is the guarantee that actually matters here.
 */
function buildMacosApp(stagingRoot, options) {
  const appName = "Syncord Injector.app";
  const app = path.join(stagingRoot, appName);
  const macos = path.join(app, "Contents", "MacOS");
  const resources = path.join(app, "Contents", "Resources");
  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(resources, { recursive: true });

  // 1. The executable, named exactly as Info.plist says it will be.
  const binary = options.binary ?? path.join(INJECTOR_ROOT, "target", "release", "syncord-injector");
  if (!fs.existsSync(binary)) {
    throw new Error(
      `no release binary at ${binary}. Build it first:\n` +
        `  pnpm injector:build (from repository root; explicit user request required)\nor pass one with --binary <path>`,
    );
  }
  const binaryName = "Syncord Injector";
  fs.copyFileSync(binary, path.join(macos, binaryName));
  fs.chmodSync(path.join(macos, binaryName), 0o755);

  // 2. The signed payload, inside the part of the bundle that signing covers.
  if (!options.standalone) embedPayloadInApp(app, options.payload);

  // 3. The icon. `iconutil` wants an .iconset, so the one PNG is rendered at
  //    each size first. A missing icon is cosmetic, so a failure here is
  //    reported and skipped rather than fatal.
  const icns = buildIcns(path.join(resources, "icon.icns"));
  if (icns === null) {
    console.warn("[package] could not build an .icns; the app will use a generic icon");
  }

  // 4. Info.plist.
  const plist = path.join(app, "Contents", "Info.plist");
  fs.writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Syncord Injector</string>
  <key>CFBundleDisplayName</key><string>Syncord Injector</string>
  <key>CFBundleExecutable</key><string>${binaryName}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_IDENTIFIER}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${options.version}</string>
  <key>CFBundleVersion</key><string>${options.version}</string>
  <key>LSMinimumSystemVersion</key><string>10.15</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Syncord</string>
${icns === null ? "" : "  <key>CFBundleIconFile</key><string>icon</string>\n"}
</dict>
</plist>
`,
  );

  // 5. Ad-hoc signature, so the bundle is internally consistent. `plutil -lint`
  //    first: a bundle with a malformed plist is a bundle that does not launch,
  //    and it is a one-character mistake to make.
  const lint = spawnSync("plutil", ["-lint", plist], { encoding: "utf-8" });
  if (lint.status !== 0) {
    throw new Error(`the generated Info.plist is not valid: ${lint.stderr || lint.stdout}`);
  }

  const sign = spawnSync("codesign", ["--force", "--sign", "-", app], { encoding: "utf-8" });
  if (sign.status !== 0) {
    // Not fatal: an unsigned bundle still runs locally, and a machine without
    // the signing tool (CI containers, a stripped macOS) must not block a
    // release. The payload's own signature is the real guarantee.
    console.warn(
      `[package] ad-hoc codesign failed, shipping unsigned: ${(sign.stderr || sign.stdout).trim()}`,
    );
  }

  assertAppBundleLayout(app, binaryName, options.standalone);
  return app;
}

/**
 * The bundle's `.icns`, or null when neither route is available.
 *
 * Prefers the checked-in `icons/icon.icns`. `scripts/make-icons.mjs` generates
 * it with the complete member set `iconutil` requires, including the 1024px
 * entry — which is what large Finder views and Retina actually load, and which
 * the fallback below cannot produce.
 *
 * The `sips` route stays as a safety net for a checkout missing the generated
 * file, and is deliberately second rather than removed: it needs no Node
 * dependencies, so a tree with only `sips` still packages. It resamples a 512px
 * source, so the icon is softer in exactly the places it is seen most closely —
 * good enough to be recognisable, and a reason to run the generator.
 */
function buildIcns(outFile) {
  const checkedIn = path.join(INJECTOR_ROOT, "src-tauri", "icons", "icon.icns");
  if (fs.existsSync(checkedIn)) {
    fs.copyFileSync(checkedIn, outFile);
    return outFile;
  }

  const source = path.join(INJECTOR_ROOT, "src-tauri", "icons", "512x512.png");
  if (!fs.existsSync(source)) return null;

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "syncord-icns-"));
  try {
    const iconset = path.join(scratch, "icon.iconset");
    fs.mkdirSync(iconset, { recursive: true });
    // 16, 32, 128, 256 and 512 at 1x, plus 32 and 256 at 2x. A subset of what
    // `iconutil` accepts, and the best a 512px source can justify: the 1024px
    // member would only be an upscale.
    const sizes = [16, 32, 128, 256, 512];
    for (const size of sizes) {
      const scaled = spawnSync("sips", ["-z", String(size), String(size), source, "--out", path.join(iconset, `icon_${size}x${size}.png`)]);
      if (scaled.status !== 0) return null;
    }
    for (const size of [32, 256]) {
      const scaled = spawnSync("sips", ["-z", String(size * 2), String(size * 2), source, "--out", path.join(iconset, `icon_${size}x${size}@2x.png`)]);
      if (scaled.status !== 0) return null;
    }
    const built = spawnSync("iconutil", ["-c", "icns", iconset, "-o", outFile]);
    if (built.status !== 0) return null;
    return outFile;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Check the bundle is the shape macOS requires, before it is published.
 *
 * A `.app` that is missing its executable or whose plist disagrees with the
 * executable's name fails at double-click time, on a user's machine, with no
 * useful message. Every one of these is a mistake this script could make by
 * editing a string.
 */
function assertAppBundleLayout(app, binaryName, standalone = false) {
  const executable = path.join(app, "Contents", "MacOS", binaryName);
  if (!fs.existsSync(executable)) {
    throw new Error(`the bundle has no executable at Contents/MacOS/${binaryName}`);
  }
  if (!(fs.statSync(executable).mode & 0o111)) {
    throw new Error(`Contents/MacOS/${binaryName} is not executable`);
  }
  if (!standalone && !fs.existsSync(path.join(app, "Contents", "Resources", "payload", "integrity.manifest.json"))) {
    throw new Error("the bundle has no signed payload at Contents/Resources/payload");
  }
}

/**
 * Run the packaged binary and confirm it finds and verifies its own payload.
 *
 * This is the check that makes the rest of the layout assertions worth having.
 * It runs the *artifact that is about to be published* — not the build tree, not
 * a copy — through the real discovery code, so "the payload is where
 * `payload_dir_for_exe` looks" is established by the Rust code that will do the
 * looking rather than by this script's own idea of where it should be.
 *
 * Discovery is pinned to an empty temporary directory, so the check is hermetic
 * and reads nothing about the machine running it.
 */
function assertPackagedBinaryFindsItsPayload(binary, expectVersion, runner = null) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "syncord-verify-"));
  try {
    // A synthetic Discord, so discovery succeeds and `--list` reaches the
    // payload line. Pointing it at an empty directory would exit 3 with "not a
    // Discord install" and the check would never see the thing it is checking.
    const resources = path.join(scratch, "Resources");
    fs.mkdirSync(resources, { recursive: true });
    fs.writeFileSync(path.join(resources, "app.asar"), "pretend this is Discord");

    const result = spawnSync(runner ?? binary, runner ? [binary, "--list"] : ["--list"], {
      encoding: "utf-8",
      env: { ...process.env, SYNCORD_DISCORD_PATH: resources },
    });
    const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    if (result.status !== 0) {
      throw new Error(
        `the packaged Injector exited ${result.status} ` +
          `(signal ${result.signal}, error ${result.error?.message ?? "none"}) on --list:\n${out.trim()}`,
      );
    }
    if (/REJECTED/.test(out)) {
      throw new Error(
        `the packaged Injector rejected its own payload. The archive is signed with a key ` +
          `this binary was not built with, or the payload was altered after signing.\n${out.trim()}`,
      );
    }
    if (!/Bundled payload: verified/.test(out)) {
      throw new Error(
        `the packaged Injector cannot find its own payload. It looks beside the ` +
          `executable, in Contents/Resources, and three levels up from the executable.\n${out.trim()}`,
      );
    }
    if (expectVersion && !out.includes(`v${expectVersion}`)) {
      throw new Error(
        `the packaged Injector verified a payload that reports a different version ` +
          `than ${expectVersion}.`,
      );
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Put the signed payload inside the `.app`, at `Contents/Resources/payload`.
 *
 * ── Why this is a post-build copy and not `bundle.resources` ────────────────
 *
 * `bundle.resources` was the obvious way to express this, and it was tried. It
 * makes Tauri's build script fail with `resource path 'payload' doesn't exist`
 * on *every* `cargo build` — including the ones in `cargo test`, `cargo clippy`
 * and CI — because those run without a release payload. A repository that only
 * builds when you happen to have signed artifacts lying around is a repository
 * that stops building the moment someone tidies up.
 *
 * Copying it in afterwards has the same result by the same mechanism Tauri
 * would have used, and leaves the ordinary build independent of the release
 * pipeline. `syncord_core::inject::payload_dir_for_exe` finds this location as
 * its second candidate, and `crates/syncord-core/src/tests/inject.rs` pins the
 * order.
 */
function embedPayloadInApp(appPath, payloadDir) {
  const resources = path.join(appPath, "Contents", "Resources");
  if (!fs.existsSync(resources)) {
    throw new Error(
      `${appPath} is not a macOS app bundle — it has no Contents/Resources.`,
    );
  }
  const dest = path.join(resources, "payload");
  fs.rmSync(dest, { recursive: true, force: true });
  copyTree(payloadDir, dest);
  return dest;
}

/**
 * The freedesktop integration: a launcher entry, an icon theme, and a script
 * that installs both.
 *
 * Linux has no equivalent of an icon compiled into the binary and no equivalent
 * of a macOS bundle. A desktop environment shows an application because a
 * `.desktop` file names it, and that file names an icon by looking it up in the
 * icon theme. Neither exists by being extracted, so shipping the icons alone
 * would ship something that displays nowhere, and shipping the entry alone
 * would show a generic placeholder.
 *
 * The entry and the theme tree are laid out the way the specifications say to —
 * `share/applications` and `hicolor/<size>/apps` under the user's data
 * directory — and `install-desktop-entry.sh` copies them there and refreshes
 * the two caches. Writing them into the archive rather than only installing
 * them keeps the package honest: everything the script does is visible in the
 * archive, and a user who would rather wire it up themselves can.
 *
 * `Exec` is left as a bare command name in the shipped entry, which is correct
 * only if the directory is on `PATH`. The install script rewrites it to an
 * absolute path, because a launcher that cannot start the thing it names is
 * worse than no launcher.
 */
const LINUX_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];

function buildDesktopIntegration(stagingRoot, version) {
  const iconDir = path.join(INJECTOR_ROOT, "src-tauri", "icons");

  // The icon theme tree. `hicolor` is the fallback theme every environment
  // resolves, so a name that is not in it is a name no desktop finds.
  for (const size of LINUX_ICON_SIZES) {
    const source = path.join(iconDir, `${size}x${size}.png`);
    if (!fs.existsSync(source)) {
      throw new Error(
        `no ${size}px icon at ${source}. Run: node injector/scripts/make-icons.mjs`,
      );
    }
    const target = path.join(
      stagingRoot,
      "icons",
      "hicolor",
      `${size}x${size}`,
      "apps",
      "syncord-injector.png",
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }

  // Rewritten in full by the install script, so this copy is the PATH variant.
  const desktopEntry = path.join(stagingRoot, "syncord-injector.desktop");
  fs.writeFileSync(desktopEntry, desktopFile("syncord-injector", version));

  const installer = path.join(stagingRoot, "install-desktop-entry.sh");
  fs.writeFileSync(installer, installScript());
  fs.chmodSync(installer, 0o755);
}

function desktopFile(exec, version) {
  return `[Desktop Entry]
Type=Application
Name=Syncord Injector
GenericName=Discord client installer
Comment=Installs Syncord into your Discord client (${version})
Exec=${exec}
Icon=syncord-injector
Terminal=false
Categories=Utility;
Keywords=discord;syncord;injector;plugin;
`;
}

function installScript() {
  return `#!/bin/sh
# Install the Syncord Injector launcher entry and its icon theme.
#
# Written into the archive rather than only run by the packager, so that
# everything it does is visible before it happens. It touches only
# $XDG_DATA_HOME (or ~/.local/share) — no system directory, no root, and nothing
# outside the user's own files.
#
# Idempotent: running it again overwrites the same two locations.
set -eu

here=\$(CDPATH= cd -- "\$(dirname -- "\$0")" && pwd)
binary="\$here/syncord-injector"

if [ ! -x "\$binary" ]; then
  echo "error: \$binary is missing or not executable." >&2
  echo "       Run this script from inside the extracted archive." >&2
  exit 1
fi

data="\${XDG_DATA_HOME:-\${HOME:-}}"
if [ -z "\$data" ]; then
  # \`set -u\` would otherwise abort with "HOME: unbound variable", which says
  # what happened and not what to do about it.
  echo "error: neither XDG_DATA_HOME nor HOME is set, so there is nowhere to" >&2
  echo "       install the launcher entry. Set XDG_DATA_HOME and run again." >&2
  exit 1
fi

mkdir -p "\$data/applications" "\$data/icons"

# The whole entry is written here rather than sed-ed, because \$here may contain
# characters that are special in a sed replacement — a backslash or a slash in a
# path is enough to produce a silently wrong Exec line.
cat > "\$data/applications/syncord-injector.desktop" <<ENTRY
[Desktop Entry]
Type=Application
Name=Syncord Injector
GenericName=Discord client installer
Comment=Installs Syncord into your Discord client
Exec="\$binary"
Icon=syncord-injector
Terminal=false
Categories=Utility;
Keywords=discord;syncord;injector;plugin;
ENTRY

chmod 644 "\$data/applications/syncord-injector.desktop"

for size in ${LINUX_ICON_SIZES.join(" ")}; do
  mkdir -p "\$data/icons/hicolor/\${size}x\${size}/apps"
  cp -f "\$here/icons/hicolor/\${size}x\${size}/apps/syncord-injector.png" \\
    "\$data/icons/hicolor/\${size}x\${size}/apps/syncord-injector.png"
done

# Both tools are optional and neither is present on every system, so a missing
# one is reported rather than treated as a failure. Without the icon cache
# refresh, a session that already has an icon cache keeps showing the old one.
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "\$data/icons/hicolor" >/dev/null 2>&1 || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "\$data/applications" >/dev/null 2>&1 || true
fi

echo "Installed Syncord Injector to \$data"

# A quoted heredoc, so none of this is interpreted. The obvious version of this
# message — backticks inside a double-quoted echo — makes the *shell* run the
# command the user is being told about, which prints a "command not found" in
# the middle of the instructions and eats the rest of the sentence.
cat <<'NOTE'

Your desktop will not list it until the session reloads its applications.
On GNOME:  loginctl terminate-user "$USER"
On KDE:     kbuildsycoca5

To remove it:
  rm -f  ~/.local/share/applications/syncord-injector.desktop
  rm -rf ~/.local/share/icons/hicolor

The Injector itself runs from this directory; nothing is copied anywhere else,
and nothing was installed outside your own home.
NOTE
`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const platform = PLATFORMS[options.target];
  if (!platform) {
    throw new Error(
      `unknown target ${options.target}. Known: ${Object.keys(PLATFORMS).join(", ")}`,
    );
  }
  assertPayloadComplete(options.payload);
  const version = options.version;
  // The Installer has its own version; the embedded client follows a separate
  // release cycle. Verify the client stamp against the binary's verified payload.
  const payloadVersion = JSON.parse(fs.readFileSync(path.join(options.payload, "syncord-version.json"), "utf8")).version;
  if (typeof payloadVersion !== "string" || !/^\d{1,6}(?:\.\d{1,6}){0,3}(?:-[0-9A-Za-z.-]{1,32})?$/.test(payloadVersion)) {
    throw new Error("payload has no valid client version stamp");
  }
  const root = `syncord-injector-${options.target}-${version}`;
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "syncord-pkg-"));
  const stagingRoot = path.join(staging, root);
  fs.mkdirSync(stagingRoot, { recursive: true });

  let primary;
  if (platform.os === "macos") {
    primary = buildMacosApp(stagingRoot, options);
    // The payload also sits at the archive root, so an extracted archive works
    // whether the user runs the app or the bare binary. The copy inside
    // Contents/Resources is the one inside the code-signed part of the bundle;
    // this one is what `payload_dir_for_exe` reaches through `../../../payload`
    // from inside the app.
    if (!options.standalone) copyTree(options.payload, path.join(stagingRoot, "payload"));
  } else {
    const binaryName = platform.os === "windows" ? "syncord-injector.exe" : "syncord-injector";
    const built =
      options.binary ?? path.join(INJECTOR_ROOT, "target", "release", binaryName);
    if (!fs.existsSync(built)) {
      throw new Error(
        `no binary at ${built}. Build it first:\n` +
          `  pnpm injector:rust --allow-build build --release --target ${rustTargetTriple(options.target)} (from repository root)\n` +
          `or pass one with --binary <path>`,
      );
    }
    fs.copyFileSync(built, path.join(stagingRoot, binaryName));
    // `cargo build --release` leaves any DLL the executable needs beside it, so
    // those are carried over too. Missing on a static build, which is the
    // common case, and therefore not an error.
    for (const sibling of fs.readdirSync(path.dirname(built))) {
      if (!sibling.toLowerCase().endsWith(".dll")) continue;
      if (sibling === binaryName) continue;
      fs.copyFileSync(path.join(path.dirname(built), sibling), path.join(stagingRoot, sibling));
    }
    if (!options.standalone) copyTree(options.payload, path.join(stagingRoot, "payload"));
    // Windows has no lookup for a bare executable — the icon is linked into the
    // PE by `build.rs` — so the archive needs nothing extra there.
    if (platform.os === "linux") {
      buildDesktopIntegration(stagingRoot, version);
    }
    primary = path.join(stagingRoot, binaryName);
  }

  // The check runs the executable, not the bundle directory it lives in.
  const executable =
    platform.os === "macos"
      ? path.join(primary, "Contents", "MacOS", "Syncord Injector")
      : primary;
  assertPackagedBinaryFindsItsPayload(executable, payloadVersion, options.runner);

  fs.mkdirSync(options.out, { recursive: true });
  const archiveName = `${root}.${platform.ext}`;
  const archive = path.join(options.out, archiveName);
  fs.rmSync(archive, { force: true });

  if (platform.ext === "zip") {
    zipDir(stagingRoot, archive);
  } else {
    tarGz(stagingRoot, archive);
  }

  const digest = sha256File(archive);
  const manifest = {
    target: options.target,
    version,
    payloadVersion,
    asset: archiveName,
    sha256: digest,
    bytes: fs.statSync(archive).size,
    // Recorded so a downloaded artifact says what it was and how it was built,
    // without claiming anything it cannot prove: there is no code signature
    // here, only the Syncord Ed25519 signature over the payload inside.
    runtime: `rust-${platform.arch === "aarch64" ? "aarch64" : "x86_64"}-${platform.os}`,
    codesigned: false,
    standalone: options.standalone,
  };
  const manifestPath = path.join(options.out, `${root}.json`);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  // On macOS, leave the unpacked bundle next to the archive as well.
  //
  // The archive root is a directory named after the release, so unpacking it
  // produces `…/syncord-injector-macos-aarch64-0.1.0/Syncord Injector.app` —
  // a bundle one level deeper than anyone expects, which is easy to move by hand
  // and easy to move *wrongly*. Doing it here means a double-clickable app with
  // no post-extraction step and no chance of a half-relocated bundle.
  if (platform.os === "macos") {
    const appName = `${root}.app`;
    const source = path.join(staging, root, "Syncord Injector.app");
    const destination = path.join(options.out, "Syncord Injector.app");
    if (fs.existsSync(source)) {
      fs.rmSync(destination, { recursive: true, force: true });
      fs.renameSync(source, destination);
      // Re-sign, because the move changed nothing inside the bundle but the
      // seal records paths. A stale signature on a relocated bundle is exactly
      // the kind of thing macOS refuses to open with no useful message.
      spawnSync("codesign", ["--force", "--sign", "-", destination], { encoding: "utf-8" });
    } else {
      console.warn(
        `[package] expected the unpacked app at ${path.relative(REPO_ROOT, source)} and it is ` +
          `not there; the archive is still correct.`,
      );
    }
  }

  fs.rmSync(staging, { recursive: true, force: true });

  console.log(`packaged ${archiveName}`);
  console.log(`  bytes  ${manifest.bytes}`);
  console.log(`  sha256 ${digest}`);
  console.log(`  index  ${path.relative(REPO_ROOT, manifestPath)}`);
  if (platform.os === "macos") {
    console.log(`  app    ${path.relative(REPO_ROOT, path.join(options.out, "Syncord Injector.app"))}`);
    console.log("         open it with Finder, or: open \"" + path.join(options.out, "Syncord Injector.app") + "\"");
  }
  console.log("");
  console.log("  not code signed and not notarized — see injector/PACKAGING.md");
  return archive;
}

function rustTargetTriple(target) {
  const [os, arch] = target.split("-");
  const osPart = os === "macos" ? "apple-darwin" : os === "windows" ? "pc-windows-msvc" : "unknown-linux-gnu";
  return `${arch}-${osPart}`;
}

main();
