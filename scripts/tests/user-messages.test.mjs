/**
 * User-facing message policy.
 *
 * Run: `node --test scripts/tests/user-messages.test.mjs`
 *
 * A wrong instruction in an error message passes every other test in this
 * repository. Nothing here throws, nothing is malformed, the build is green —
 * and a user is told to do something that cannot work. That is the worst place
 * for a bug to live, because the only way it is found is when someone follows
 * the advice and it fails.
 *
 * The instance that motivated this file, in both languages at once:
 *
 *   "If the install is not writable, run: sudo pnpm inject
 *    On macOS you can instead grant Full Disk Access to Terminal or Cursor."
 *
 * Three separate problems, none of which any existing test could see:
 *
 *   - **The command is from another program.** `pnpm inject` drives the Electron
 *     client. The message is also shown by the standalone Injector, which is a
 *     different application with no `pnpm` anywhere near it.
 *   - **Elevation cannot grant this permission.** A macOS privacy permission
 *     belongs to an *application*, granted through System Settings. Running as
 *     root changes which process is asking, not what it may ask for.
 *   - **It named the wrong setting.** What blocks writing into another app's
 *     bundle is App Management. Full Disk Access is a separate service.
 *
 * The real cause is measured now — see `injector/crates/syncord-core/src/access.rs`
 * — so these assertions are about the *fallback* text, which is what a user sees
 * when nothing has measured anything.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const { test } = await import("node:test");

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The sources that produce a user-facing "you cannot write here" message, and
 * the one that measures why.
 */
const SOURCES = [
  {
    name: "the Electron client's permissionHelp",
    file: path.join(REPO, "scripts", "lib", "discordInstalls.mjs"),
  },
  {
    name: "the Injector's permission_help",
    file: path.join(REPO, "injector", "crates", "syncord-core", "src", "discovery.rs"),
  },
  {
    name: "the Injector's measured remedy",
    file: path.join(REPO, "injector", "crates", "syncord-core", "src", "access.rs"),
  },
];

/** Lift the two functions each source actually exports, as text. */
const BODIES = SOURCES.map((source) => ({ ...source, text: null }));

for (const entry of BODIES) {
  entry.text = await readFile(entry.file, "utf-8");
}

test("no user-facing message tells someone to elevate the process", async () => {
  // Scoped to the message-producing functions rather than the whole file: these
  // are libraries that legitimately mention `sudo` nowhere, but a build script
  // in the same tree may well need one for a reason that is none of this
  // file's business.
  for (const entry of BODIES) {
    const body = messageText(entry);
    for (const forbidden of ["sudo", "runas", "Start-Process -Verb RunAs", "osascript"]) {
      assert.ok(
        !body.toLowerCase().includes(forbidden.toLowerCase()),
        `${entry.name} suggests ${forbidden}, which cannot grant a privacy permission: ${body}`,
      );
    }
  }
});

test("no user-facing message names another program's command", async () => {
  for (const entry of BODIES) {
    const body = messageText(entry);
    assert.ok(
      !/\bpnpm\b/.test(body),
      `${entry.name} tells the user to run a command from a different program: ${body}`,
    );
  }
});

test("the macOS guidance names the setting that actually governs the write", async () => {
  // A test that only asserted "some guidance exists" is how the wrong setting
  // survived: the old text mentioned Full Disk Access, so a presence check
  // passed. What has to be checked is that the *right* one is named and that it
  // is not presented as the answer.
  for (const entry of BODIES) {
    const body = messageText(entry);
    if (!/macOS|daron|darwin/i.test(body)) continue; // not a macOS message

    assert.ok(
      body.includes("App Management"),
      `${entry.name} does not name App Management, which is what blocks the write: ${body}`,
    );
    assert.ok(
      !/Full Disk Access[^\n]*\n?[^.]*(instead|grant it|use this)/i.test(body),
      `${entry.name} presents Full Disk Access as the fix: ${body}`,
    );
  }
});

/**
 * The text a user would actually be shown.
 *
 * Deliberately coarse: the point is to catch a forbidden suggestion in a
 * message, and a substring search over the whole file would flag the *comment*
 * explaining why the suggestion was removed. Comments are stripped, and the
 * search is then over what remains.
 */
function messageText(entry) {
  return entry.text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
