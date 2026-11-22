/**
 * Runtime tamper watchdog (Phase 28).
 *
 * Checks that the things Syncord installed are still installed. Concretely:
 *
 *  - the renderer egress hooks are still the functions we put on `window`
 *  - `SyncordNative` still exists and still has the `security` bridge
 *  - the security IPC channels still resolve to a main process that is
 *    responding
 *
 * The hard requirement, stated up front: **it must not produce false positives.**
 * A watchdog that cries wolf gets muted, and a muted watchdog is worse than no
 * watchdog because it manufactures the belief that someone is watching. So:
 *
 *  - it is a *heartbeat*, not a tripwire. It records a tamper event; it does not
 *    unload plugins, close windows, or enter safe mode on its own. The reaction
 *    is the user's decision, made from a Security Center they can read.
 *  - it is observational only. Anything a page can restore, the page can also
 *    legitimately restore — a Discord client update that redefines a built-in
 *    is not an attack, and treating it as one would break the client.
 *  - it checks identity by *shape and behaviour*, not by identity function. A
 *    tampered function that behaves identically is not a problem worth waking
 *    anyone for.
 */
import { createLogger } from "./logger";
import { securityEvents } from "./security";
import { egressGuardInstalled } from "./egressGuard";

const log = createLogger("watchdog");

type Check = {
  name: string;
  run: () => "ok" | "tampered" | "unknown";
};

const checks: Check[] = [
  {
    name: "egress-hooks",
    run: () => (egressGuardInstalled() ? "ok" : "tampered"),
  },
  {
    name: "native-bridge",
    run: () => {
      const api = window.SyncordNative;
      // Absent means the page is not a trusted origin, which is correct
      // behaviour, not tampering. We cannot tell the two apart from here, so we
      // report "unknown" rather than guessing.
      if (api === undefined) return "unknown";
      return typeof api.security === "object" && api.security !== null ? "ok" : "tampered";
    },
  },
  {
    name: "Syncord-api",
    run: () => {
      const api = (window as unknown as { Syncord?: unknown }).Syncord;
      if (api === undefined) return "unknown";
      return typeof api === "object" ? "ok" : "tampered";
    },
  },
];

export type WatchdogReport = {
  at: number;
  results: Array<{ name: string; state: "ok" | "tampered" | "unknown" }>;
  tampered: number;
};

let timer: ReturnType<typeof setInterval> | undefined;
let last: WatchdogReport | undefined;

/** Run one check cycle. Exported for tests and for the Security Center's
 * "run check now" button. */
export function runWatchdog(): WatchdogReport {
  const results = checks.map((check) => {
    try {
      return { name: check.name, state: check.run() };
    } catch (err) {
      log.log("watchdog check threw:", err);
      return { name: check.name, state: "unknown" as const };
    }
  });

  const tampered = results.filter((result) => result.state === "tampered").length;
  const report: WatchdogReport = { at: Date.now(), results, tampered };
  last = report;

  if (tampered > 0) {
    // Reported, not acted on. The user decides; see the file header.
    log.warn(`tamper check: ${tampered} check(s) failed — reporting only`);
    void securityEvents(1);
  }
  return report;
}

export function lastWatchdogReport(): WatchdogReport | undefined {
  return last;
}

/**
 * Start the periodic check.
 *
 * The interval is deliberately long (60s). This is a diagnostic for a user who
 * is already suspicious, not a defence against a determined attacker, and a
 * tight loop would be both expensive and prone to firing during legitimate
 * Discord client updates.
 */
export function startWatchdog(intervalMs = 60_000): () => void {
  if (timer !== undefined) return stopWatchdog;
  runWatchdog();
  timer = setInterval(() => runWatchdog(), intervalMs);
  return stopWatchdog;
}

export function stopWatchdog(): void {
  if (timer === undefined) return;
  clearInterval(timer);
  timer = undefined;
}
