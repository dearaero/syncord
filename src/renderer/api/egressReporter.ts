/**
 * Bridges renderer-observed egress into the main-process event log.
 *
 * Reporting only. Nothing here decides whether a request may proceed — see
 * `egressGuard.ts` for why a renderer-side control is not a boundary, and for
 * the black-screen incident that came from pretending otherwise.
 *
 * The IPC surface is intentionally narrow: a fixed set of string fields, no
 * request body, no headers, no URL path. A compromised page can therefore spam
 * this channel with fabricated events, but it cannot use it to move data — the
 * worst it achieves is a noisy log, which is a much better failure mode than an
 * exfiltration path. The alternative (no reporting at all) would mean the
 * Security Center shows a clean log while the page talks to third parties.
 */
import { createLogger } from "./logger";
import { IPC_CHANNELS } from "./egressChannels";

const log = createLogger("egress");

/** Hostnames only, so nothing sensitive can ride along. */
function safeHost(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 253) : "";
}

/**
 * Report one observed request.
 *
 * Note the path: the channel lives on `SyncordNative.security`, not on
 * `SyncordNative` directly. An earlier version looked for it on the wrong
 * object, and because the call was made with an optional chain it failed
 * *silently* — every observed egress was dropped and the Security Center stayed
 * clean while the page was talking to third parties. A security feature that
 * fails silently is worse than an absent one, so the path is asserted below and
 * a missing bridge is logged rather than ignored.
 */
export function reportObservedEgress(input: {
  url: unknown;
  transport: string;
  host: string;
  reason: string;
  detail?: string;
}): void {
  const transport = input.transport.slice(0, 24);
  const host = safeHost(input.host);
  const reason = input.reason.slice(0, 200);
  // The request body length is a size, not content. We never send the payload.
  const detail = typeof input.detail === "string" ? input.detail.slice(0, 40) : undefined;

  try {
    const api = window.SyncordNative as unknown as
      | {
          security?: {
            reportEgress?: (report: unknown) => Promise<void>;
          };
        }
      | undefined;

    const report = api?.security?.reportEgress;
    if (typeof report !== "function") {
      // No bridge: the origin gate refused this frame, or the preload never ran.
      // Say so once — silently dropping every report is how the bug above went
      // unnoticed for an entire incident.
      log.warn("egress report channel unavailable (no SyncordNative.security)");
      return;
    }
    report({ transport, host, reason, detail }).catch(() => {
      /* reporting must never throw into the page */
    });
  } catch (err) {
    // A failure to report must never surface in the page: the reporting path is
    // diagnostic, and throwing from it would turn an observation into a crashed
    // caller — the exact failure mode this rewrite exists to remove.
    log.log("egress report failed:", err);
  }
}

export { IPC_CHANNELS };
