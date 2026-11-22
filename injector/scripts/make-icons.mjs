/** Generate platform sizes from the approved, already-composed UI-kit icon.
 * No trimming, recoloring, masking or new background is applied. Native iconutil
 * builds ICNS on macOS; the supplied Windows ICO is preserved byte for byte.
 * Run: node injector/scripts/make-icons.mjs [--portable]
 */
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';import pkg from 'pngjs';
const {PNG}=pkg,HERE=path.dirname(fileURLToPath(import.meta.url)),INJECTOR_ROOT=path.resolve(HERE,'..'),REPO_ROOT=path.resolve(INJECTOR_ROOT,'..');
const ICON_DIR=path.join(INJECTOR_ROOT,'src-tauri','icons');
const DEFAULT_SOURCE=path.join(INJECTOR_ROOT,'src-tauri','ui','assets','syncord-app-icon.png');
const MASTER=1024,SIZES=[16,24,32,48,64,128,256,512,1024];
// Area-average downsampling retains the original composition and alpha edges.
function resize(png, dw, dh) {
  const out = new PNG({ width: dw, height: dh });
  const xRatio = png.width / dw;
  const yRatio = png.height / dh;

  for (let y = 0; y < dh; y++) {
    const y0 = y * yRatio;
    const y1 = (y + 1) * yRatio;

    for (let x = 0; x < dw; x++) {
      const x0 = x * xRatio;
      const x1 = (x + 1) * xRatio;

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let weight = 0;

      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        // Fractional coverage of this source row, so the seam between rows is
        // smooth rather than stair-stepped.
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        if (wy <= 0) continue;

        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
          if (wx <= 0) continue;

          const wgt = wx * wy;
          const i = (sy * png.width + sx) * 4;
          // Premultiplied, so a transparent pixel cannot drag its own colour
          // into the edge and halo it.
          const alpha = png.data[i + 3] / 255;
          r += png.data[i] * alpha * wgt;
          g += png.data[i + 1] * alpha * wgt;
          b += png.data[i + 2] * alpha * wgt;
          a += alpha * wgt;
          weight += wgt;
        }
      }

      const o = (y * dw + x) * 4;
      if (weight === 0 || a === 0) continue;
      out.data[o] = Math.round(r / a);
      out.data[o + 1] = Math.round(g / a);
      out.data[o + 2] = Math.round(b / a);
      out.data[o + 3] = Math.round((a / weight) * 255);
    }
  }
  return out;
}

function buildIco(images, sizes) {
  const payloads = sizes.map((size) => PNG.sync.write(images.get(size)));
  const count = sizes.length;

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(count, 4);

  const directory = Buffer.alloc(16 * count);
  let offset = header.length + directory.length;
  sizes.forEach((size, index) => {
    const at = index * 16;
    // 0 means 256; every other size fits in a byte directly.
    directory.writeUInt8(size === 256 ? 0 : size, at);
    directory.writeUInt8(size === 256 ? 0 : size, at + 1);
    directory.writeUInt8(0, at + 2); // colour count: 0 for >8bpp
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(payloads[index].length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += payloads[index].length;
  });

  return Buffer.concat([header, directory, ...payloads]);
}

/* ── Build ───────────────────────────────────────────────────────────────── */

const source = process.argv.includes("--source")
  ? path.resolve(process.argv[process.argv.indexOf("--source") + 1])
  : DEFAULT_SOURCE;

if (!fs.existsSync(source)) {
  console.error(`[icons] source artwork not found: ${source}`);
  process.exit(1);
}

console.log(`[icons] source ${path.relative(REPO_ROOT, source)}`);
const master = PNG.sync.read(fs.readFileSync(source));
if(master.width!==MASTER||master.height!==MASTER)throw Error('Approved icon master must be 1024×1024');
fs.mkdirSync(ICON_DIR, { recursive: true });

/** Written as both a Tauri name and, where useful, an `.iconset` member name. */
const rendered = new Map();

for (const size of SIZES) {
  const image = size === MASTER ? master : resize(master, size, size);
  rendered.set(size, image);
  console.log(`[icons] rendered ${size}x${size}`);
}

// The names `tauri.conf.json` and the Tauri bundler expect. `icon.png` is the
// 512px master the existing packaging reads.
const FILES = {
  "16x16.png": 16,
  "24x24.png": 24,
  "32x32.png": 32,
  "48x48.png": 48,
  "64x64.png": 64,
  "128x128.png": 128,
  "128x128@2x.png": 256,
  "256x256.png": 256,
  "512x512.png": 512,
  "icon.png": 512,
};

for (const [name, size] of Object.entries(FILES)) {
  fs.writeFileSync(path.join(ICON_DIR, name), PNG.sync.write(rendered.get(size)));
  console.log(`[icons] wrote icons/${name}`);
}

// --portable regenerates PNG/ICO on any OS and preserves the checked-in .icns.
// The native .icns is regenerated and checked separately on macOS.
if (!process.argv.includes("--portable")) {
  // `.icns` is built by `iconutil` rather than assembled by hand: the container
  // format is Apple's and versioned, and the tool that ships with the OS is the
  // one that knows the current layout.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "syncord-icons-"));
  const iconset = path.join(scratch, "icon.iconset");
  fs.mkdirSync(iconset, { recursive: true });

  // iconutil validates this member list exactly; a missing or extra entry is an
  // error rather than a warning.
  const ICONSET_MEMBERS = [
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
    ["icon_512x512@2x.png", 1024],
  ];

  for (const [name, size] of ICONSET_MEMBERS) {
    fs.writeFileSync(path.join(iconset, name), PNG.sync.write(rendered.get(size)));
  }

  const icnsPath = path.join(ICON_DIR, "icon.icns");
  const built = spawnSync("iconutil", ["-c", "icns", iconset, "-o", icnsPath], { encoding: "utf-8" });
  fs.rmSync(scratch, { recursive: true, force: true });

  if (built.status !== 0 || !fs.existsSync(icnsPath)) {
    console.error(`[icons] iconutil failed: ${built.stderr?.trim() ?? "no output"}`);
    console.error("[icons] the PNGs are written; only the .icns is missing.");
    process.exit(1);
  }

  console.log(`[icons] wrote icons/icon.icns (${fs.statSync(icnsPath).size} bytes)`);

}

// The Windows icon, written last so a failure here cannot cost the macOS ones.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const icoPath = path.join(ICON_DIR, "icon.ico");
if(!process.argv.includes('--source'))fs.copyFileSync(path.join(INJECTOR_ROOT,'branding','syncord-app-icon.ico'),icoPath);
else fs.writeFileSync(icoPath, buildIco(rendered, ICO_SIZES));
console.log(`[icons] wrote icons/icon.ico (${ICO_SIZES.join(", ")})`);
