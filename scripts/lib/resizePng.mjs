import { createRequire } from "node:module";

const { PNG } = createRequire(import.meta.url)("pngjs");

/**
 * Shrink a PNG to fit inside a square, keeping alpha.
 * Pure JS so `pnpm build` does not depend on macOS `sips`.
 */
export function resizePng(buffer, size) {
  const src = PNG.sync.read(buffer);
  const scale = Math.min(size / src.width, size / src.height);
  const width = Math.max(1, Math.round(src.width * scale));
  const height = Math.max(1, Math.round(src.height * scale));
  const ox = Math.floor((size - width) / 2);
  const oy = Math.floor((size - height) / 2);
  const dst = new PNG({ width: size, height: size });
  const xScale = src.width / width;
  const yScale = src.height / height;

  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * yScale);
    const y1 = Math.max(y0 + 1, Math.min(src.height, Math.floor((y + 1) * yScale)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * xScale);
      const x1 = Math.max(x0 + 1, Math.min(src.width, Math.floor((x + 1) * xScale)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * src.width + sx) << 2;
          const pa = src.data[i + 3];
          r += src.data[i] * pa;
          g += src.data[i + 1] * pa;
          b += src.data[i + 2] * pa;
          a += pa;
          n++;
        }
      }
      const di = ((oy + y) * size + (ox + x)) << 2;
      if (a === 0 || n === 0) continue;
      dst.data[di] = Math.round(r / a);
      dst.data[di + 1] = Math.round(g / a);
      dst.data[di + 2] = Math.round(b / a);
      dst.data[di + 3] = Math.round(a / n);
    }
  }

  return PNG.sync.write(dst);
}
