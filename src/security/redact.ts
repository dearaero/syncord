/**
 * Secret redaction.
 *
 * Every string that reaches a console, a security event, or the Security Center
 * UI passes through here first. The rule the spec sets is simple: `Authorization:
 * Bearer abc123` must be logged as `Authorization: [REDACTED]`. We go further
 * and redact the *key name* as well as the value, so a reader cannot tell from
 * the log which credential was presented.
 */

export const REDACTED = "[REDACTED]";

/**
 * Field names whose value is always a credential, matched case-insensitively
 * against the whole name (with `-`/`_` normalized) so `x-api-key`, `X_API_KEY`
 * and `apiKey` all land in the same bucket.
 */
const SECRET_FIELD_NAMES = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "idntoken",
  "sessiontoken",
  "xauthtoken",
  "xcsrftoken",
  "password",
  "passwd",
  "pwd",
  "secret",
  "clientsecret",
  "apikey",
  "xapikey",
  "privatekey",
  "discordtoken",
  "superproperties",
]);

/** `normalizeFieldName("X-Syncord-Token")` → "xSyncordtoken" */
export function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isSecretFieldName(name: string): boolean {
  return SECRET_FIELD_NAMES.has(normalizeFieldName(name));
}

const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 20;
const MAX_STRING_SCAN = 4096;

/**
 * Value-level patterns. These catch credentials that appear *inline* in a log
 * line or a URL, which is where they usually leak in practice.
 */
const VALUE_PATTERNS: RegExp[] = [
  // "Bearer <blob>" / "Basic <blob>" / "ApiKey <blob>" — space-separated, and
  // only for the three labels that are unambiguously an auth scheme.
  //
  // The bare word `token` was in this alternation and had to come out. It
  // matched ordinary English: "token bucket refilled" became "[REDACTED]
  // refilled", which is our own rate-limiter vocabulary appearing in a log. A
  // redactor that mangles normal text gets switched off by the first person who
  // reads a log and sees nothing but redactions — and coverage is not actually
  // lost, because `token` in its `token=…` / `token: …` label form is already
  // covered by the key=value pattern below, and `Authorization: token` by the
  // header pattern.
  /\b(bearer|basic|apikey)\s+[A-Za-z0-9._~+/=-]{6,}/gi,
  // `token <blob>` is only treated as a credential when it is labelled, i.e.
  // `token: abc` or `token=abc`, which is the form anything real uses.
  /\btoken\s*[:=]\s*[A-Za-z0-9._~+/=-]{6,}/gi,
  // "authorization: ..." inside a dumped header blob
  /\b(authorization|proxy-authorization|cookie|set-cookie)\b\s*[:=]\s*[^\s;"']+/gi,
  // JWT-shaped triple. The 4-character floor is what makes this a real check
  // rather than a decoration — real JWT header segments are ~36 chars, so the
  // bound costs nothing in false negatives.
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
  // Discord MFA / regular token shapes.
  //
  // The trailing segment is part of the credential, not decoration. A Discord
  // token is `mfa.<id>.<signature>`, and the previous pattern stopped at the
  // first dot, so a token in a log line came out as
  // `[REDACTED].Wx1y2Z3a4B5c6D7e8F9g` — half the secret, in the audit file, in
  // the Security Center and in the boot log. The optional group is what closes
  // it, and it cannot over-match: `mfa.` plus 20+ base64url characters is
  // already unambiguous before the group is considered.
  /\bmfa\.[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]{20,})?/g,
  // A Discord webhook URL embeds a usable credential *in its path*:
  // `/api/webhooks/<id>/<token>`. Anyone holding it can post to that webhook,
  // so it is a secret in exactly the way a bearer token is, and none of the
  // query-string patterns above can see it. The generic replacer below replaces
  // a match that carries no `:`/`=` separator wholesale, so the whole URL
  // becomes `[REDACTED]` — the id is not secret, but dropping it costs nothing
  // and guessing wrong costs a credential.
  /\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{10,}/gi,
  // Bare `key=value` pairs, with or without a query separator. Covers the very
  // common case of a secret reaching a log line inside a reason string.
  /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|api[_-]?key|apikey|token|secret|password|passwd|session|sessionid)\s*[:=]\s*[^\s&;,"']{4,}/gi,
  // URL query secrets
  /([?&#](?:access_token|token|api_key|apikey|auth|key|signature|sig)=)[^&\s#]+/gi,
];

/**
 * Redact credential-looking substrings inside a free-form string.
 * Never throws; strings longer than MAX_STRING_SCAN are truncated first so a
 * huge response body cannot make logging quadratic.
 */
export function redactText(input: string): string {
  if (input.length === 0) return input;
  let text = input.length > MAX_STRING_SCAN ? `${input.slice(0, MAX_STRING_SCAN)}…` : input;
  for (const pattern of VALUE_PATTERNS) {
    text = text.replace(pattern, (match) => {
      // Keep the label so logs stay readable; drop everything after it.
      const sep = match.match(/[:=]\s*/);
      const label = match.slice(0, match.search(/[:=]\s*/));
      if (sep && label.length > 0) return `${label}${sep[0]}${REDACTED}`;
      return REDACTED;
    });
  }
  return text;
}

/**
 * Redact a header map. Names are preserved (case included) so a reader can see
 * *that* an Authorization header was present; values never are.
 */
export function redactHeaders(
  headers: Readonly<Record<string, string>> | undefined | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [name, value] of Object.entries(headers)) {
    out[name] = isSecretFieldName(name) ? REDACTED : redactText(String(value));
  }
  return out;
}

/**
 * Recursively redact an arbitrary structure.
 *
 * Guards: depth, array length and string length. Without those, redacting a
 * hostile payload would itself be a DoS primitive, which would turn a logging
 * call into an attack surface.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`…+${value.length - MAX_ARRAY_ITEMS} more`);
    return items;
  }

  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message) };
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretFieldName(key) ? REDACTED : redactValue(inner, depth + 1);
    }
    return out;
  }

  return REDACTED;
}
