/**
 * Persistent security audit log (Phase 12).
 *
 * The in-memory ring in `src/security/events.ts` is the primary sink; this adds
 * a bounded, rotating file so an incident survives a restart. The spec allows
 * memory-only for the first version, but "the client was attacked last night"
 * is not a question worth having to answer from memory, and the cost is ~40
 * lines and a hard size cap.
 *
 * Properties that matter:
 *
 *  - **Bounded on disk.** `maxBytes` with whole-file truncation of the oldest
 *    records. An attacker who can trigger security events must not be able to
 *    fill the user's disk, which would turn the log into a denial-of-service
 *    primitive against the very machine being protected.
 *  - **Secrets never reach it.** Every line is produced by `redactValue` on the
 *    event, and headers/bodies are not part of the event shape at all. The
 *    `REDACTED` marker is written literally, so an operator reading the file
 *    sees that a credential was present without seeing it.
 *  - **Not a secret store.** The file lives in the user profile with default
 *    permissions and contains hostnames, plugin ids and reasons. That is
 *    deliberate: a log nobody can read is not an audit log.
 *  - **Best-effort.** Every write is wrapped. A full disk or a read-only profile
 *    must not take down the client, and must not take down the *logging*.
 */
import fs from "node:fs";
import path from "node:path";

import { LOG_PREFIX } from "../../shared/constants";
import type { SecurityEvent, SecurityEventLog, SecurityEventType } from "../../security/events";
import { redactValue } from "../../security/redact";
import { bootLog } from "../../shared/bootLog";
import { SyncordUserDataPath } from "./core";

export const AUDIT_LOG_LIMITS = {
  maxBytes: 1024 * 1024,
  /** Flush at most this often, so a burst of events is not one write each. */
  flushIntervalMs: 2000,
  maxQueued: 500,
} as const;

function logFile(): string {
  return path.join(SyncordUserDataPath(), "security-audit.jsonl");
}

type Sink = {
  flush: () => void;
  close: () => void;
  path: string;
  dropped: number;
};

/**
 * Attach a rotating file sink to an existing event log.
 * Returns a no-op sink when the profile directory is not writable, so the
 * caller never has to branch.
 */
export function attachAuditFile(log: SecurityEventLog): Sink {
  const file = logFile();
  let queue: string[] = [];
  let dropped = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const write = (): void => {
    if (closed || queue.length === 0) return;
    const batch = queue;
    queue = [];
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      truncateIfNeeded(file, batch.join(""));
      fs.appendFileSync(file, batch.join(""), "utf-8");
    } catch (err) {
      // A log that cannot be written is not a reason to break the client.
      dropped += batch.length;
      console.warn(`${LOG_PREFIX}[security] audit log write failed:`, describe(err));
    }
  };

  const unsubscribe = log.subscribe((event) => {
    // Mirror into the boot log as well.
    //
    // The audit log is the *product's* record and it lives inside Discord's own
    // user-data container, which macOS TCC makes unreadable from a terminal.
    // That matters when a security control turns out to be too aggressive and
    // breaks the client: the evidence has to be readable by whoever is
    // debugging, or the only symptom is a black window. See SECURITY_AUDIT.md
    // §14 and §15 — four incidents in a row were misdiagnosed for this reason.
    bootLog(`event ${event.type} ${JSON.stringify(event).slice(0, 400)}`);

    if (closed) return;
    if (queue.length >= AUDIT_LOG_LIMITS.maxQueued) {
      dropped += 1;
      return;
    }
    queue.push(`${serialize(event)}\n`);
    if (timer === undefined) {
      timer = setTimeout(() => {
        timer = undefined;
        write();
      }, AUDIT_LOG_LIMITS.flushIntervalMs);
    }
  });

  return {
    path: file,
    get dropped() {
      return dropped;
    },
    flush() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      write();
    },
    close() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      write();
      unsubscribe();
      closed = true;
    },
  };
}

/**
 * Keep the file under `maxBytes`.
 *
 * The whole file is re-read and trimmed from the front rather than using
 * rotations (`audit.1.jsonl`, …): a security log is read by humans looking for
 * the *oldest* incident they can still see, and a single bounded file has one
 * obvious place to look. Records are whole lines, so trimming is lossless at
 * the record boundary.
 */
function truncateIfNeeded(file: string, incoming: string): void {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return; // No file yet.
  }
  const incomingBytes = Buffer.byteLength(incoming, "utf-8");
  if (size + incomingBytes <= AUDIT_LOG_LIMITS.maxBytes) return;

  try {
    const existing = fs.readFileSync(file, "utf-8");
    const trimmed = trimAuditLog(existing, size, incomingBytes);
    fs.writeFileSync(file, trimmed, "utf-8");
  } catch (err) {
    console.warn(`${LOG_PREFIX}[security] audit log truncate failed:`, describe(err));
  }
}

/** Preserve exactly the same complete records without repeated batch encoding
 * or Array.shift's repeated reindexing on the main thread. */
export function trimAuditLog(existing: string, existingBytes: number, incomingBytes: number, maxBytes: number = AUDIT_LOG_LIMITS.maxBytes): string {
  const lines = existing.split("\n");
  let first = 0, total = existingBytes;
  while (total + incomingBytes > maxBytes && first < lines.length - 1) {
    total -= Buffer.byteLength(`${lines[first]}\n`, "utf-8");
    first++;
  }
  return lines.slice(first).join("\n");
}

/**
 * One JSON object per line.
 *
 * `redactValue` runs a final time here even though `SecurityEventInput` is
 * already a closed shape. The event model is a *contract*, not a guarantee about
 * every future caller, and the log is the last place a secret would leak from —
 * so it gets the last word.
 */
function serialize(event: SecurityEvent): string {
  const safe = redactValue({
    ts: event.timestamp,
    id: event.id,
    type: event.type,
    severity: event.severity,
    pluginId: event.pluginId,
    origin: event.origin,
    host: event.host,
    method: event.method,
    channel: event.channel,
    permission: event.permission,
    webContentsId: event.webContentsId,
    durationMs: event.durationMs,
    count: event.count,
    reason: event.reason,
  });
  try {
    return JSON.stringify(safe);
  } catch {
    return JSON.stringify({ ts: event.timestamp, type: event.type as SecurityEventType, reason: "unserializable event" });
  }
}

/** Read back the most recent records, for the Security Center and for support. */
export function readAuditTail(limit = 200): string[] {
  try {
    const file = logFile();
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf-8")
      .split("\n")
      .filter((line) => line.length > 0)
      .slice(-Math.max(1, Math.min(limit, 1000)));
  } catch {
    return [];
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
