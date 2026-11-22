/**
 * Boot log — a file the boot process can be read from.
 *
 * ## Why this exists
 *
 * Three incidents in a row (SECURITY_AUDIT.md §11–13) all had the same shape:
 * something in the injection chain did not happen, and the only symptom was that
 * Syncord was not there. Console output does not help — Discord launched from
 * Finder has no stdout, and Electron's renderer console output is not visible
 * from the shell at all. Worse, macOS TCC blocks a terminal from reading
 * Discord's own container, so even a file written next to it is invisible to the
 * person debugging.
 *
 * So the boot path writes its own trace to a file *next to the injected bundle*,
 * where it is readable, plus a copy under the system temp directory.
 *
 * ## Properties
 *
 * - **Bounded.** One file, truncated from the front past `MAX_BYTES`. An
 *   unbounded log in the Discord install is a disk-fill vector, and this thing
 *   runs on every launch.
 * - **Redacted.** Every line passes through `redactText`. The boot log records
 *   decisions, not payloads, but a stray value must not reach disk.
 * - **Never throws.** A boot log that can crash the client is worse than no boot
 *   log. Every write is best-effort.
 * - **Cheap.** One `appendFileSync` per line, and the boot writes on the order of
 *   twenty lines. Deliberately not a ring buffer in memory: the point is to
 *   survive the process.
 */
import { LOG_PREFIX } from "./constants";
import { redactText } from "../security/redact";

export const BOOT_LOG_MAX_BYTES = 512 * 1024;
export const BOOT_LOG_NAME = "Syncord-boot.log";

type Append = (line: string) => void;

let append: Append | undefined;
/** Only set when a writer was installed — lets the renderer detect "no main". */
let active = false;

function makeAppend(fs: typeof import("node:fs"), file: string): Append {
  return (line: string) => {
    try {
      // Truncate from the front once the file is over budget, so the newest
      // lines — the ones that describe this launch — are always present.
      try {
        const size = fs.statSync(file).size;
        if (size > BOOT_LOG_MAX_BYTES) {
          const existing = fs.readFileSync(file, "utf-8");
          fs.writeFileSync(file, `${existing.slice(Math.floor(existing.length * 0.5))}\n`, "utf-8");
        }
      } catch {
        /* no file yet */
      }
      fs.appendFileSync(file, line, "utf-8");
    } catch {
      /* the install may be read-only; the console still has the line */
    }
  };
}

/**
 * Start writing to every given path. Call once, as early as possible, in both
 * the main process and the preload — they are separate realms, so they each need
 * their own.
 */
export function initBootLog(paths: readonly string[]): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path") as typeof import("node:path");
    const writers = paths
      .filter((p) => typeof p === "string" && p.length > 0)
      .map((p) => makeAppend(fs, p));
    if (writers.length === 0) return;

    const stamp = (): string => new Date().toISOString().slice(11, 23);
    const realm = process.type === "renderer" ? "renderer" : "main";

    append = (line: string) => {
      const safe = redactText(line);
      const stamped = `${stamp()} [${realm}] ${safe}\n`;
      for (const write of writers) write(stamped);
    };
    active = true;

    // Record where the log lives, so the next person debugging does not have to
    // guess — this is the single most useful line in the file.
    for (const p of paths) {
      try {
        const resolved = path.resolve(p);
        append?.(`${LOG_PREFIX} boot log: ${resolved}`);
      } catch {
        /* ignore */
      }
    }
  } catch {
    // No fs (e.g. the renderer bundle, where this module must never be used).
    append = undefined;
  }
}

/** Append one line. No-op until `initBootLog` has run. */
export function bootLog(message: string): void {
  if (append === undefined) return;
  try {
    append(`${LOG_PREFIX} ${message}`);
  } catch {
    /* never throw from logging */
  }
}

/** Is a writer installed? The renderer uses this to tell "no main" from "quiet". */
export function bootLogActive(): boolean {
  return active;
}
