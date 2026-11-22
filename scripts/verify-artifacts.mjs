/**
 * Verify every release artifact against the index written beside it.
 *
 * Run: `node scripts/verify-artifacts.mjs <dir> [<dir> …] [--list]`
 *
 * `--list` prints the verified artifact paths, one per line, and nothing else.
 * The publish step uses it rather than a glob over the directory, so what gets
 * attached to a release is exactly what was verified — a glob would also attach
 * whatever else happened to be in there, and an undescribed file is a file no
 * client can use.
 *
 * The last gate before publishing. Each packager writes an index next to its
 * archive — `{asset, sha256, bytes}` — and this checks that what is about to be
 * attached to a release still hashes to what the index says.
 *
 * The failure this exists for is not subtle in principle and is very easy in
 * practice: an artifact is built on one runner, downloaded, and published from
 * another. Anything that touches the bytes in between — a re-zip, a line-ending
 * fixup, an artifact store that recompresses, a stale file from a previous run
 * in the same directory — leaves the release descriptor describing something
 * that is not attached. And because the descriptor is signed, that is not a
 * visible error: the client verifies the descriptor, verifies the download
 * against the digest *in* the descriptor, and refuses. Every user, silently, and
 * the only symptom is "no update available".
 *
 * So this runs last, on the exact bytes that will be published, and refuses to
 * let a release proceed on a digest it cannot reproduce.
 *
 * It also checks the two things a digest cannot: that an archive is not empty,
 * and that the release descriptor's asset list is actually present. A descriptor
 * advertising a file that was not uploaded produces exactly the same silence.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

/** Index files that are indexes rather than something else that happens to be JSON. */
const INDEX_NAMES = new Set(["syncord-release.json"]);

/**
 * Human-readable progress goes to stderr, always.
 *
 * stdout is reserved for the `--list` output, so the publish step can pipe this
 * straight into `xargs` without filtering chatter out of a path. Mixing the two
 * streams is how a log line becomes part of a filename.
 */
function note(message) {
  console.error(`[Syncord][verify-artifacts] ${message}`);
}

function fail(message) {
  note(message);
  process.exit(1);
}

/** Recursively collect files, skipping the descriptor, which is checked separately. */
function collect(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, found);
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

function isArchive(file) {
  return file.endsWith(".tar.gz") || file.endsWith(".zip") || file.endsWith(".AppImage");
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function main() {
  const argv = process.argv.slice(2);
  const listOnly = argv.includes("--list");
  const dirs = argv.filter((arg) => !arg.startsWith("--"));
  if (dirs.length === 0) {
    fail("Usage: node scripts/verify-artifacts.mjs <dir> [<dir> …] [--list]");
  }
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) fail(`${dir} does not exist — an artifact download failed`);
  }

  const all = dirs.flatMap((dir) => collect(dir));
  const archives = all.filter(isArchive);
  const indexes = all.filter(
    (file) =>
      file.endsWith(".json") &&
      (INDEX_NAMES.has(path.basename(file)) || /^syncord-injector-.*\.json$/.test(path.basename(file))),
  );

  // Not "are there archives in this directory?" — that question is answered by
  // whether anything got described, below. A directory holding a descriptor that
  // references three missing archives is the case that matters, and checking for
  // archives first would report "nothing to publish" and stop, hiding the one
  // fact worth reporting: which file is missing.
  if (indexes.length === 0) {
    fail(
      archives.length === 0
        ? "nothing to publish: no archives and no index describing them"
        : `${archives.length} archive(s) present but no index describes them`,
    );
  }

  // ── Every archive is described, and described correctly. ───────────────────

  const described = new Set();
  for (const indexPath of indexes) {
    let index;
    try {
      index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    } catch (err) {
      fail(`${indexPath} is not valid JSON: ${err.message}`);
    }

    const dir = path.dirname(indexPath);

    // `syncord-release.json` lists its assets; an Injector index names its own
    // file. Both are checked, by the same loop, because both are the claim that
    // the descriptor makes about bytes on disk.
    const entries = Array.isArray(index.assets)
      ? index.assets.map((a) => ({ name: a.name, sha256: a.sha256, size: a.size }))
      : index.asset !== undefined
        ? [{ name: index.asset, sha256: index.sha256, size: index.bytes ?? index.size }]
        : [];

    if (entries.length === 0) {
      fail(`${indexPath} lists no assets, so it describes nothing`);
    }

    for (const entry of entries) {
      if (typeof entry.name !== "string" || entry.name.length === 0) {
        fail(`${indexPath} has an asset with no name`);
      }
      if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
        fail(`${indexPath}: ${entry.name} has no usable sha256, so nothing can verify it`);
      }

      // A name from a signed descriptor is data, not a path. `path.join` would
      // happily resolve `../../etc/passwd`, so the name is checked first.
      if (entry.name !== path.basename(entry.name)) {
        fail(`${indexPath}: "${entry.name}" is not a plain filename`);
      }

      const file = path.join(dir, entry.name);
      if (!fs.existsSync(file)) {
        fail(
          `${indexPath} advertises ${entry.name}, which is not in ${dir}. A release that ` +
            `ships a descriptor referencing a missing asset tells every client to refuse ` +
            `the update, with no error anyone would see.`,
        );
      }

      const actual = sha256(file);
      if (actual !== entry.sha256) {
        fail(
          `${entry.name} does not match its index.\n` +
            `  expected ${entry.sha256}\n` +
            `  actual   ${actual}\n` +
            `The bytes changed after they were described. Do not publish.`,
        );
      }

      const size = fs.statSync(file).size;
      if (size === 0) fail(`${entry.name} is empty`);
      if (typeof entry.size === "number" && entry.size !== size) {
        fail(`${entry.name} is ${size} bytes but the index says ${entry.size}`);
      }

      described.add(file);
    }
  }

  // ── Nothing is published that nothing describes. ──────────────────────────
  //
  // An extra archive in the directory is not obviously wrong — but it will be
  // attached to the release, and a file with no digest is a file the client
  // cannot use. Better to say so now than to attach it silently.

  if (described.size === 0) {
    fail("every index was read but none of them describes an artifact, so there is nothing to publish");
  }

  const orphans = archives.filter((file) => !described.has(file));
  if (orphans.length > 0) {
    note("not described by any index, and therefore not usable by a client:");
    for (const file of orphans) console.warn(`  ${path.relative(root, file)}`);
    console.warn(`[Syncord][verify-artifacts] publish only the described files.`);
  }

  note(`${described.size} artifact(s) verified`);
  for (const file of [...described].sort()) {
    note(
      `  ${path.basename(file).padEnd(46)} ${String(fs.statSync(file).size).padStart(10)} B  ${sha256(file).slice(0, 16)}…`,
    );
  }
  if (orphans.length > 0) {
    fail(`${orphans.length} archive(s) are not described by any index`);
  }

  // Only after every check has passed: a list printed from a failed run would
  // give the publish step something to attach.
  if (listOnly) {
    for (const file of [...described].sort()) {
      process.stdout.write(`${file}\n`);
    }
  }
}

main();
