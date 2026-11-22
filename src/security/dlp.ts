/**
 * Secret detection in outbound payloads (Phase 27).
 *
 * This is a **backstop**, not a control. The control is the host allowlist: a
 * request that never reaches an unapproved host cannot exfiltrate regardless of
 * what it carries. Detection exists for the cases the allowlist cannot cover —
 * an approved host that turns out to be hostile, a misconfigured permission, or
 * a credential appearing somewhere nobody thought to look.
 *
 * Therefore, on the limits:
 *  - Base64, hex, compression, chunking and encryption all defeat pattern
 *    matching. A determined attacker exfiltrates by encoding, and pretending
 *    otherwise would be worse than saying so.
 *  - False positives are real. A JWT-shaped string in a legitimate API response
 *    is common. The default action is therefore **report**, not block, for
 *    broker traffic that already passed the permission check; blocking is
 *    reserved for broker requests, where a credential in a plugin's outbound
 *    payload has no legitimate explanation.
 *
 * Patterns are shaped to Discord's actual token format (three dot-separated
 * base64url segments) rather than to "anything long", because a length heuristic
 * flags every attachment hash and every CDN URL.
 */
import { REDACTED } from "./redact";

/** A single detection, with the *position* rather than the value. */
export type DlpFinding = {
  kind: "discord-token" | "jwt" | "authorization" | "cookie" | "api-key" | "discord-webhook-url";
  /** Never the matched text. */
  at: number;
};

const PATTERNS: Array<{ kind: DlpFinding["kind"]; re: RegExp }> = [
  // Discord regular / MFA tokens. Three base64url segments; the first decodes to
  // a string starting with "MTIz" (the version marker) in practice, but the
  // shape alone is a strong enough signal and avoids a decode step.
  { kind: "discord-token", re: /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,38}\b/g },
  { kind: "discord-token", re: /\bmfa\.[A-Za-z0-9_-]{60,}/g },
  { kind: "discord-webhook-url", re: /discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/gi },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "authorization", re: /\b(?:authorization|proxy-authorization)\b\s*[:=]\s*\S{8,}/gi },
  { kind: "cookie", re: /\b(?:cookie|set-cookie)\b\s*[:=]\s*\S{8,}/gi },
  { kind: "api-key", re: /\b(?:x-api-key|api[_-]?key|apikey|client[_-]?secret)\b\s*[:=]\s*\S{8,}/gi },
];

/**
 * Scan a string for credential-shaped content.
 *
 * `scanLimit` bounds the work: a 2 MB response body is not scanned end to end,
 * because the first 64 KB is where a leaked credential appears if it appears at
 * all, and a linear scan over attacker-controlled megabytes on every response is
 * a denial-of-service primitive.
 */
export function detectSecrets(text: unknown, scanLimit = 64 * 1024): DlpFinding[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const sample = text.length > scanLimit ? text.slice(0, scanLimit) : text;

  const findings: DlpFinding[] = [];
  for (const { kind, re } of PATTERNS) {
    // A fresh lastIndex per pattern: these are module-level /g regexes and a
    // shared lastIndex across calls is a classic source of missed matches.
    re.lastIndex = 0;
    let match = re.exec(sample);
    let guard = 0;
    while (match !== null && guard < 8) {
      findings.push({ kind, at: match.index });
      guard += 1;
      match = re.exec(sample);
    }
  }
  return findings;
}

export function hasSecrets(text: unknown): boolean {
  return detectSecrets(text).length > 0;
}

/** What to do about a detection. */
export type DlpAction = "report" | "block";

/**
 * Decide what a detection means for a given request.
 *
 * The distinction that matters: a *broker* request is a plugin's own outbound
 * payload, where carrying a Discord token or a webhook URL is never legitimate,
 * so it is blocked. *Renderer* traffic is page traffic we do not own — Discord
 * legitimately sends and receives tokens, cookies and JWTs on every request — so
 * a match there is reported and never blocked. Blocking on a pattern match in
 * the renderer's own traffic would break the client on the first API call, and a
 * broken DLP layer gets switched off.
 */
export function dlpActionFor(surface: "broker" | "renderer", findings: DlpFinding[]): DlpAction {
  if (findings.length === 0) return "report";
  return surface === "broker" ? "block" : "report";
}

/** Human-readable summary for the Security Center. Never includes a match. */
export function summarizeFindings(findings: DlpFinding[]): string {
  if (findings.length === 0) return "none";
  const kinds = new Set(findings.map((finding) => finding.kind));
  return [...kinds].join(", ");
}

export { REDACTED };
