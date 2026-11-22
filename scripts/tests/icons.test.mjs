/**
 * Application icon test suite.
 *
 * Run: `node --test scripts/tests/icons.test.mjs`
 *
 * The icons are checked in, not built in CI — the release workflow packages the
 * Injector with `scripts/package.mjs` and never runs a Tauri bundler, so the
 * only icon a user sees is whatever is committed here. That makes these files
 * *assets*, and assets drift without a test noticing.
 *
 * They already had. The set this replaces was not icons at all: `32x32.png` was
 * a flat purple square 149 bytes long, and `128x128.png` was a 24-pixel-wide
 * vertical strip cropped out of the middle of the artwork. Both had plausible
 * filenames and correct dimensions, and nothing checked that an icon was
 * *there*.
 *
 * So the assertions below are about a squircle being present and complete:
 *
 *   - corners transparent and the four edge midpoints opaque, which together
 *     prove a full-bleed shape rather than a fragment of one;
 *   - the centre opaque, which a strip fails;
 *   - more than a handful of distinct colours, which a flat fill fails;
 *   - every file the size its name claims, which a stale copy fails;
 *   - the `.icns` a real container holding a 1024px entry, which is what large
 *     views and Retina load;
 *   - and that regenerating from the source artwork reproduces the committed
 *     bytes, which is what stops all of the above from silently rotting.
 *
 * The last one runs the generator and restores the tree afterwards, so a failure
 * leaves the working copy as it found it.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import pkg from "pngjs";

const { PNG } = pkg;

const { test } = await import("node:test");

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const INJECTOR = path.join(REPO, "injector");
const ICON_DIR = path.join(INJECTOR, "src-tauri", "icons");
const MAKER = path.join(INJECTOR, "scripts", "make-icons.mjs");
const CONFIG = path.join(INJECTOR, "src-tauri", "tauri.conf.json");

/** Every PNG in the icon directory that the config or Tauri expects by name. */
const EXPECTED = {
  "32x32.png": 32,
  "128x128.png": 128,
  "128x128@2x.png": 256,
  "256x256.png": 256,
  "512x512.png": 512,
  "icon.png": 512,
};

function readPng(file) {
  return PNG.sync.read(fs.readFileSync(file));
}

/** The alpha of one pixel, by image coordinates. */
function alphaAt(png, x, y) {
  return png.data[(y * png.width + x) * 4 + 3];
}

test("every icon named in tauri.conf.json exists on disk", () => {
  const config = JSON.parse(fs.readFileSync(CONFIG, "utf-8"));
  const icons = config.bundle?.icon ?? [];
  assert.ok(icons.length > 0, "the config names no icons at all");

  for (const entry of icons) {
    const resolved = path.join(INJECTOR, "src-tauri", entry);
    assert.ok(fs.existsSync(resolved), `tauri.conf.json names ${entry}, which is not in the tree`);
  }
});

test("approved UI-kit branding is preserved and the supplied Windows ICO is used verbatim",()=>{
 const master=fs.readFileSync(path.join(INJECTOR,'src-tauri/ui/assets/syncord-app-icon.png'));
 assert.equal(crypto.createHash('sha256').update(master).digest('hex'),'b24db2177f48aba7ebcbb458424bd98820f43fff040d28455087e07d71e49c71');
 assert.deepEqual(fs.readFileSync(path.join(INJECTOR,'branding/syncord-app-icon.ico')),fs.readFileSync(file('icon.ico')));
 assert.ok(fs.existsSync(path.join(INJECTOR,'branding/syncord-logo-original.png')));
});

test("each icon is the size its filename claims", () => {
  for (const [name, size] of Object.entries(EXPECTED)) {
    const file = path.join(ICON_DIR, name);
    assert.ok(fs.existsSync(file), `${name} is missing`);
    const png = readPng(file);
    assert.equal(png.width, size, `${name} is ${png.width}px wide, not ${size}`);
    assert.equal(png.height, size, `${name} is ${png.height}px tall, not ${size}`);
  }
});

test("each approved icon preserves its rounded composition and transparent margins", () => {
  for (const [name, size] of Object.entries(EXPECTED)) {
    const png = readPng(file(name));
    const mid = Math.floor(size / 2);
    const edge = Math.max(1,Math.floor(size * 0.08));

    // Corners cut away. This is what makes it a platform icon at all: macOS
    // does not round the corners for you, so the shape has to be in the pixels.
    assert.equal(alphaAt(png, 0, 0), 0, `${name}: top-left corner is not transparent`);
    assert.equal(alphaAt(png, size - 1, 0), 0, `${name}: top-right corner is not transparent`);
    assert.equal(alphaAt(png, 0, size - 1), 0, `${name}: bottom-left corner is not transparent`);
    assert.equal(alphaAt(png, size - 1, size - 1), 0, `${name}: bottom-right corner is not transparent`);

    // Midpoints of all four edges painted. A cropped fragment — the 128px icon
    // this replaces was a 24px-wide vertical strip — has transparent edges
    // where a squircle has none.
    for (const [label, x, y] of [
      ["top", mid, edge],
      ["bottom", mid, size - 1 - edge],
      ["left", edge, mid],
      ["right", size - 1 - edge, mid],
    ]) {
      assert.ok(alphaAt(png, x, y) > 240, `${name}: ${label} edge midpoint is not opaque`);
    }

    assert.ok(alphaAt(png, mid, mid) > 240, `${name}: centre is not opaque`);
  }
});

test("no icon is a flat fill or a single flat colour", () => {
  for (const [name, size] of Object.entries(EXPECTED)) {
    const png = readPng(file(name));
    const seen = new Set();
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        const i = (y * png.width + x) * 4;
        if (png.data[i + 3] === 0) continue; // transparent is not a colour choice
        seen.add((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2]);
      }
    }
    // A gradient squircle with artwork on it lands in the thousands; a flat
    // square has one. 64 is far below real output and far above a placeholder.
    assert.ok(seen.size > 64, `${name} has only ${seen.size} distinct colours — that is a flat fill`);
  }
});

test("icon.icns is a well-formed container with a 1024px entry", () => {
  const file = path.join(ICON_DIR, "icon.icns");
  assert.ok(fs.existsSync(file), "icon.icns is missing");

  const buf = fs.readFileSync(file);
  assert.equal(buf.toString("ascii", 0, 4), "icns", "not an .icns container");

  // The header carries the total length; a mismatch means a truncated file,
  // which macOS renders as a blank icon rather than as an error.
  const declared = buf.readUInt32BE(4);
  assert.equal(declared, buf.length, `header claims ${declared} bytes, file is ${buf.length}`);

  // Walk the chunks: 4-byte type, 4-byte big-endian length, then that payload.
  const largest = [];
  let offset = 8;
  while (offset < buf.length) {
    const type = buf.toString("ascii", offset, offset + 4);
    const length = buf.readUInt32BE(offset + 4);
    assert.ok(length >= 8, `chunk ${type} declares an impossible length of ${length}`);
    assert.ok(offset + length <= buf.length, `chunk ${type} runs past the end of the file`);

    const payload = buf.subarray(offset + 8, offset + length);
    // The large members are whole PNGs; the small ones are raw RGB triples.
    if (payload.subarray(1, 4).toString("ascii") === "PNG") {
      const png = PNG.sync.read(payload);
      largest.push({ type, width: png.width });
    }
    offset += length;
  }

  assert.ok(largest.length > 0, "no PNG-backed members found in the .icns");
  const max = Math.max(...largest.map((entry) => entry.width));
  assert.equal(
    max,
    1024,
    `largest member is ${max}px; a 1024px entry is what large views and Retina load, ` +
      `and the sips fallback cannot produce one`,
  );
});

test("icon.ico is a well-formed container with every size Windows asks for", () => {
  const file = path.join(ICON_DIR, "icon.ico");
  assert.ok(fs.existsSync(file), "icon.ico is missing");

  const buf = fs.readFileSync(file);
  assert.equal(buf.readUInt16LE(0), 0, "the reserved field is not zero");
  assert.equal(buf.readUInt16LE(2), 1, "the type field is not 1 (icon)");

  const count = buf.readUInt16LE(4);
  assert.ok(count > 0, "the .ico declares no images");

  const seen = [];
  let cursor = 6 + 16 * count;
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    // 0 is the only way to say 256, because the field is a single byte. Writing
    // 256 truncates, and the entry is then read as a size that does not exist.
    const width = buf.readUInt8(at) === 0 ? 256 : buf.readUInt8(at);
    const height = buf.readUInt8(at + 1) === 0 ? 256 : buf.readUInt8(at + 1);
    const bytes = buf.readUInt32LE(at + 8);
    const imageOffset = buf.readUInt32LE(at + 12);

    assert.equal(width, height, `entry ${i} is ${width}x${height}, not square`);
    // PNG-backed ICO entries may use 0 (unspecified) or 1 for planes.
    assert.ok([0,1].includes(buf.readUInt16LE(at + 4)), `entry ${i} has invalid colour planes`);
    assert.equal(buf.readUInt16LE(at + 6), 32, `entry ${i} is not 32bpp`);
    assert.ok(bytes > 0, `entry ${i} declares a zero-length image`);
    assert.ok(imageOffset + bytes <= buf.length, `entry ${i} runs past the end of the file`);
    assert.equal(
      buf.subarray(imageOffset, imageOffset + 4).toString("hex"),
      "89504e47",
      `entry ${i} (${width}px) is not a PNG payload`,
    );

    // A decoder is the only proof the payload is a real image rather than a
    // plausible-looking byte range, and that it is the size the directory claims.
    const png = PNG.sync.read(buf.subarray(imageOffset, imageOffset + bytes));
    assert.equal(png.width, width, `entry ${i} declares ${width}px but decodes to ${png.width}px`);

    seen.push(width);
    cursor = imageOffset + bytes;
  }

  assert.equal(cursor, buf.length, "the entries do not cover the file exactly");

  for (const size of [16, 32, 48, 256]) {
    assert.ok(seen.includes(size), `no ${size}px entry; Explorer asks for that size`);
  }
  // Explorer picks a size by scanning, so a table in the wrong order makes it
  // choose the wrong image rather than failing.
  assert.deepEqual(
    seen,
    [...seen].sort((a, b) => a - b),
    `entries are not in ascending size order: ${seen.join(", ")}`,
  );
});

test("the Windows icon has one resource compiler for native and cross builds", () => {
  const buildRs = fs.readFileSync(path.join(INJECTOR, "src-tauri", "build.rs"), "utf-8");
  const manifest = fs.readFileSync(path.join(INJECTOR, "src-tauri", "Cargo.toml"), "utf-8");

  assert.match(buildRs, /WindowsAttributes::new\(\)\.window_icon_path\(&icon\)/,
    "Tauri must embed the checked-in Windows icon");
  assert.match(buildRs, /join\("icons"\)\.join\("icon\.ico"\)/);
  assert.match(buildRs, /if !icon\.is_file\(\)/,
    "a missing icon must fail the build");
  assert.match(buildRs, /tauri_build::try_build\(attributes\)/,
    "the resource compiler must run and propagate failures");
  assert.ok(!buildRs.includes('cfg(target_os = "windows")'),
    "build scripts run on the host; Tauri must select the Windows target");
  assert.ok(!/embed_resource::compile\(/.test(buildRs),
    "a second resource compiler duplicates Tauri's icon IDs");
  assert.ok(!/^embed-resource\s*=/m.test(manifest),
    "the redundant resource compiler must not be a direct dependency");
});

test("regenerating from the source artwork reproduces the committed icons", () => {
  assert.ok(fs.existsSync(MAKER), "injector/scripts/make-icons.mjs is missing");

  // Hash what is committed, run the generator, hash again. The generator writes
  // into the tree, so the originals are restored either way — a failing test
  // must not leave the working copy rewritten.
  const tracked = [...Object.keys(EXPECTED), "icon.icns", "icon.ico"];
  const before = new Map();
  for (const name of tracked) {
    before.set(name, crypto.createHash("sha256").update(fs.readFileSync(file(name))).digest("hex"));
  }

  const backup = fs.mkdtempSync(path.join(os.tmpdir(), "syncord-icons-backup-"));
  try {
    for (const name of tracked) {
      fs.copyFileSync(file(name), path.join(backup, name));
    }

    // PNG/ICO regeneration is portable. Only macOS provides iconutil for ICNS.
    // Always exercise portable mode, including preservation of the ICNS file.
    const modes = process.platform === "darwin" ? [["--portable"], []] : [["--portable"]];
    for (const args of modes) {
      const run = spawnSync(process.execPath, [MAKER, ...args], { encoding: "utf-8", cwd: INJECTOR });
      assert.equal(run.status, 0, `make-icons.mjs failed:\n${run.stdout}\n${run.stderr}`);
    }

    for (const name of tracked) {
      const after = crypto.createHash("sha256").update(fs.readFileSync(file(name))).digest("hex");
      assert.equal(
        after,
        before.get(name),
        `${name} does not match what make-icons.mjs produces. Either the committed ` +
          `icons or the source artwork changed without the other; re-run the generator.`,
      );
    }
  } finally {
    for (const name of tracked) {
      const saved = path.join(backup, name);
      if (fs.existsSync(saved)) fs.copyFileSync(saved, file(name));
    }
    fs.rmSync(backup, { recursive: true, force: true });
  }
});

function file(name) {
  return path.join(ICON_DIR, name);
}
