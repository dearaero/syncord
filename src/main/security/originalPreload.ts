/**
 * Main-process wrapper around the shared Discord-preload path rules.
 *
 * Two responsibilities, deliberately split:
 *
 *  1. `validateOriginalPreload` runs in `patchBrowserWindow`, i.e. *before* the
 *     BrowserWindow is constructed. If the path Discord handed us is not
 *     trustworthy we do not install our own preload at all: Discord then boots
 *     exactly as it normally would, and the user sees a security event instead
 *     of a broken client. Failing closed must never mean "Discord won't start".
 *
 *  2. The preload re-runs the same rules independently (see
 *     `src/preload/index.ts`). The duplication is intentional defence in depth:
 *     if `process.env` is tampered with after the window was created, the second
 *     check still refuses.
 *
 * The allowed bases come from **Electron** (`app.getAppPath()` and
 * `process.resourcesPath`), never from our own `__dirname`. That was a real bug:
 * Discord 0.0.413's asar contains only `bundle.js` and `splashScreenPreload.js`,
 * so the window preload is not under `<resources>/<asar>/app/` at all, and a
 * base derived from our own bundle location rejected it. A check that is right
 * about the threat and wrong about the filesystem is worse than none, because it
 * silently disables the feature it protects.
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

import { canonicalizeWithRealpath, isContainedPath, normalizePath, validateDiscordPreloadPath } from "../../security/paths";
import { securityLog } from "./core";

/**
 * Canonicalize a path, resolving as much of it as exists on disk.
 *
 * Deliberately not `fs.realpathSync(target)` with a `path.resolve` fallback:
 * nothing inside an `.asar` can be realpath'd, and mixing a realpath'd base with
 * a resolve-only candidate makes macOS's `/var` → `/private/var` symlink break
 * the containment check for a legitimate Discord preload.
 */
const canonical = canonicalizeWithRealpath((target) => fs.realpathSync(target));

/**
 * Every directory a legitimate Discord preload may live in, most specific
 * first. Read from Electron at call time rather than cached, because
 * `app.setAppPath()` changes it during boot.
 *
 * ## Why `userData` is in this list
 *
 * Measured on Discord 0.0.413 (boot log, `SECURITY_AUDIT.md` §14):
 *
 *     window#1 title="Discord"
 *       preload=~/Library/Application Support/discord/app-0.0.413/modules/
 *              discord_desktop_core-1/discord_desktop_core/core.asar/mainScreenPreload.js
 *       action=rejected
 *
 * The main window's preload is **not** in the application bundle. Discord 0.0.413
 * keeps its host and its downloaded modules under the user-data directory
 * (`app-<version>/modules/…`) and loads the screen preload from there — its own
 * updater computes `rootPath = userData` on macOS. Without `userData` in the
 * allowed bases, the main window is never patched and the client is simply
 * stock Discord, with no error anywhere. That is exactly the bug.
 *
 * This is a real widening of the trust boundary and is called out rather than
 * buried: anything with write access to Discord's user-data directory can supply
 * a preload. But Discord 0.0.413 does that by design — it stores downloaded
 * modules and versioned hosts there — so a user-data path is not a more
 * privileged location than the app bundle for anyone who already has write
 * access to the install. What keeps the rule meaningful is everything else:
 * absolute path, no traversal after repeated percent-decoding, a JavaScript
 * extension, canonicalized containment, exclusion of our own injected
 * directory, and a preload-shaped basename — plus the independent re-check in the
 * preload itself, which compares against its *own* view of the allowed bases.
 *
 * An asar-inside-a-Discord-module check would narrow this further, and was
 * considered. It was rejected: it is trivially satisfiable (an attacker can
 * build an asar in a second), so it would add the appearance of a stronger
 * boundary without the substance, which is worse than an honest rule.
 */
function allowedBases(): string[] {
  const bases: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0 && !bases.includes(value)) {
      bases.push(value);
    }
  };

  // Windows 1.0.52 puts downloaded modules beside resources, under the
  // same versioned host. Allow only that modules directory, never the whole
  // parent or LocalAppData. Linux can use the same sibling layout.
  const pushHostModules = (resources: unknown): void => {
    if (typeof resources !== "string") return;
    const normalized = normalizePath(resources);
    if (!/\/resources$/i.test(normalized)) return;
    const host = normalized.slice(0, normalized.lastIndexOf("/"));
    if (host.length === 0) return;
    const modules = `${host}/modules`;
    // Reject a modules symlink that redirects outside this installation.
    if (isContainedPath(canonical(host), canonical(modules))) push(modules);
  };

  try {
    const appPath = app.getAppPath();
    push(appPath);
    // app.getAppPath() is our resolved Discord asar after app.setAppPath().
    // Derive its resources parent too; the real Electron boot fixtures and
    // portable hosts need not share Electron's executable resources directory.
    pushHostModules(normalizePath(appPath).replace(/\/_?app\.asar$/i, ""));
  } catch {
    /* before ready, or a non-standard entry point */
  }
  try {
    push(process.resourcesPath);
    pushHostModules(process.resourcesPath);
  } catch {
    /* not available in this context */
  }
  try {
    // Discord's own host/module root on 0.0.413. Without this the main window
    // is never patched — see the note above.
    push(app.getPath("userData"));
  } catch {
    /* not available before ready */
  }
  return bases;
}

export function validateOriginalPreload(
  candidate: unknown,
): { ok: true; path: string; basename: string; knownName: boolean } | { ok: false; reason: string } {
  const bases = allowedBases();
  if (bases.length === 0) {
    return { ok: false, reason: "Electron did not report an app path" };
  }
  return validateDiscordPreloadPath(candidate, { allowedBases: bases, realpath: canonical });
}

/**
 * The canonicalized base list, for the preload to re-check against.
 *
 * `app` does not exist in a preload realm, so this cannot be recomputed there —
 * main hands it over instead. Exported (and env-encoded) rather than re-derived
 * so the two sides cannot silently disagree about what "inside Discord" means.
 */
export function allowedPreloadBases(): string[] {
  return allowedBases().map((base) => canonical(base));
}

/**
 * Note that Discord's preload is named something we do not recognise.
 *
 * Informational by design. Enforcing a name list broke the client on 0.0.413
 * (`bundle.js` was refused, so Syncord silently stopped loading), and the
 * security value of the rule was nil next to containment + realpath + the
 * preload-side re-check. Recording it keeps the signal that Discord changed its
 * layout, which is the thing a human actually wants to know.
 */
export function reportUnknownPreloadName(basename: string, fullPath: string): void {
  securityLog().record({
    type: "PRELOAD_INTEGRITY_FAIL",
    reason: `unrecognised preload name "${basename}" (accepted: it is inside the Discord app path)`,
    origin: "preload",
  });
  console.log(
    `[Syncord][security] Discord's preload is named "${basename}" — not in our known list, ` +
      `accepted because it is inside the app path. path: ${fullPath}`,
  );
}

/** Report a rejected preload path to the security log. Safe to call repeatedly. */
export function reportPreloadRejection(reason: string, stage: "window" | "load", candidate?: unknown): void {
  securityLog().record({
    type: "PRELOAD_INTEGRITY_FAIL",
    reason: `${stage}: ${reason}`,
    origin: "preload",
  });
  // The rejected path is logged so a legitimate preload blocked by a stale rule
  // is diagnosable. This is a path Discord itself supplied, not user data.
  const shown = typeof candidate === "string" ? candidate.slice(0, 300) : String(candidate);
  console.error(
    `[Syncord][security] Refusing to load original preload (${stage}): ${reason}\n` +
      `                path: ${shown}\n` +
      `                allowed: ${allowedBases().join(", ")}`,
  );
}
