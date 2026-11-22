/**
 * Adversarial probe v2 — measures the REAL end-to-end path.
 *
 * v1 called `isPrivateOrReservedHost()` with a raw string, which missed that
 * `parseUrl()` normalizes first (`https://127.1/` → `127.0.0.1`). A guard is
 * only as good as the path that reaches it, so every case here goes through
 * `evaluateNetworkRequest` — the function the broker actually calls.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { build } from "esbuild";

const dir = mkdtempSync(path.join(tmpdir(), "dion-adv2-"));
const out = path.join(dir, "sec.mjs");
await build({
  stdin: { contents: `export * from './src/security/index';`, resolveDir: process.cwd(), loader: "ts" },
  bundle: true, platform: "neutral", format: "esm", outfile: out, logLevel: "warning",
});
const S = await import(pathToFileURL(out).href);

let bad = 0;
const DENY = "deny", ALLOW = "allow";
/** `want` is what a correct implementation must return. */
function check(section, name, got, want) {
  if (got !== want) bad += 1;
  console.log(`${got === want ? "  ok " : ">>> "}[${section}] ${name} -> ${got}${got === want ? "" : `  (want ${want})`}`);
}

/** End-to-end: would the broker let this through? */
function policy(url, method, headers, body, permissions, webhookSend = false) {
  const d = S.evaluateNetworkRequest(url, method, headers, body, { permissions, webhookSend });
  return d.allowed ? ALLOW : DENY;
}

console.log("\n== 4. SSRF via the real policy path (permission: *.example.com) ==");
const wide = [{ host: "*.example.com" }, { host: "example.com" }];
const ssrf = [
  "https://127.0.0.1/", "https://127.1/", "https://0177.0.0.1/", "https://2130706433/",
  "https://0x7f000001/", "https://0x7f.0.0.1/", "https://[::1]/", "https://[::ffff:127.0.0.1]/",
  "https://[::ffff:7f00:1]/", "https://[64:ff9b::7f00:1]/", "https://[2002:7f00:1::]/",
  "https://10.1.2.3/", "https://172.16.5.4/", "https://192.168.0.1/", "https://169.254.169.254/",
  "https://[fe80::1]/", "https://[fc00::1]/", "https://100.64.0.1/", "https://0.0.0.0/",
  "https://localhost/", "https://LOCALHOST/", "https://foo.localhost/", "https://metadata.google.internal/",
  "https://user:pass@example.com/", "https://xn--80ak6aa92e.com/", "https://[::]/",
  "https://example.com/", "https://sub.example.com/", "https://example.com.evil.com/",
];
for (const u of ssrf) {
  // Only assert on hosts the permission actually covers, otherwise every case
  // measures the allowlist rather than the SSRF rule.
  if (!/(^|\.)example\.com\//.test(u)) { continue; }
  const privateish = /127\.|localhost|10\.|172\.16|192\.168|169\.254|::1|fe80|fc00|100\.64|0\.0\.0\.0|metadata|\[::\]|@/.test(u);
  check("ssrf", u, policy(u, "GET", undefined, undefined, wide), privateish ? DENY : ALLOW);
}

console.log("\n== 3. webhook exfiltration end-to-end (permission: discord.com, NO webhookSend) ==");
const disc = [{ host: "discord.com" }, { host: "discordapp.com" }];
const hooks = [
  "https://discord.com/api/webhooks/1/tok",
  "https://discord.com/api/%77ebhooks/1/tok",
  "https://discord.com/api/%77%65%62%68%6f%6f%6b%73/1/tok",
  "https://discord.com/%61pi/webhooks/1/tok",
  "https://discord.com/api/webhooks%2f1/tok",
  "https://discord.com//api/webhooks/1/tok",
  "https://discord.com/api/WEBHOOKS/1/tok",
  "https://canary.discord.com/api/webhooks/1/tok",
  "https://ptb.discord.com/api/webhooks/1/tok",
  "https://discordapp.com/api/webhooks/1/tok",
  "https://discord.com/api/v10/channels/1/messages",
];
for (const u of hooks) {
  const p2 = S.parseUrl(u);
  // Ask the same question the policy asks, rather than pattern-matching the
  // spelling: an encoded `/api/%77ebhooks/` is a webhook even though the
  // literal text "webhooks" is absent.
  const isHook = p2 !== null && S.isDiscordWebhookUrl(p2);
  check("webhook", `POST ${u}`, policy(u, "POST", undefined, '{"content":"leak"}', disc, false),
    isHook ? DENY : ALLOW);
}
console.log("  -- same URLs, GET (read path must not be gated):");
for (const u of hooks) {
  check("webhook-get", `GET ${u}`, policy(u, "GET", undefined, undefined, disc, false), ALLOW);
}
console.log("  -- with webhookSend granted, real webhooks must be allowed:");
for (const u of ["https://discord.com/api/webhooks/1/tok", "https://canary.discord.com/api/webhooks/1/tok"]) {
  check("webhook-ok", `POST ${u}`, policy(u, "POST", undefined, "{}", disc, true), ALLOW);
}

console.log("\n== 2. broker header policy ==");
const api = [{ host: "api.example.com" }];
for (const [n, v, want] of [
  ["Authorization", "Bearer abc", DENY], ["authorization", "Bearer abc", DENY],
  ["AUTHORIZATION", "Bearer abc", DENY], [" Cookie", "d=1", DENY], ["X-Auth-Token", "t", DENY],
  ["Proxy-Authorization", "p", DENY], ["X-Api-Key", "k", DENY], ["X-Token", "t", DENY],
  ["X-Secret", "s", DENY], ["X-Super-Properties", "abc", DENY], ["X-Fingerprint", "abc", DENY],
  ["x-forwarded-for", "1.2.3.4", DENY], ["Sec-Fetch-Mode", "cors", DENY],
  ["X-Syncord-Network", "broker", DENY], ["X-Dion-Evil", "v", DENY],
  ["Accept", "application/json", ALLOW], ["Content-Type", "application/json", ALLOW],
  ["Referer", "https://discord.com/", DENY], ["Origin", "https://discord.com", DENY],
]) {
  check("header", `${n}`, policy("https://api.example.com/", "GET", { [n]: v }, undefined, api), want);
}

console.log("\n== 2b. body / size limits ==");
check("body", "object body", policy("https://api.example.com/", "POST", undefined, { a: 1 }, api), DENY);
check("body", "oversize body", policy("https://api.example.com/", "POST", undefined, "x".repeat(300 * 1024), api), DENY);
check("body", "normal body", policy("https://api.example.com/", "POST", undefined, "{}", api), ALLOW);
check("url", "oversize url", policy(`https://api.example.com/${"a".repeat(3000)}`, "GET", undefined, undefined, api), DENY);
check("method", "TRACE", policy("https://api.example.com/", "TRACE", undefined, undefined, api), DENY);
check("method", "DELETE allowed if declared", policy("https://api.example.com/", "DELETE", undefined, undefined,
  [{ host: "api.example.com", methods: ["GET", "DELETE"] }]), ALLOW);
check("lockdown", "networkBlocked", (() => {
  const d = S.evaluateNetworkRequest("https://api.example.com/", "GET", undefined, undefined,
    { permissions: api, webhookSend: false, networkBlocked: true });
  return d.allowed ? ALLOW : DENY;
})(), DENY);

console.log("\n== 12. redaction ==");
const secrets = {
  "plain bearer": "Bearer mfaAbCdEfGhIjKlMnOpQr",
  // KNOWN LIMITATION, not a divergence: an unlabelled base64 blob. There is no
  // way to tell a secret from an inline data-URI, a content hash or a build
  // fingerprint, and redacting all of them would destroy the logs. The session
  // layer, not DLP, is what stops the token leaving.
  "unlabelled base64 (known limit)": { a: { b: ["MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI="] } },
  "error": new Error("failed: Bearer zzzzzzzzzzzzzzzzzzzz"),
  "url query": "https://x.com/?token=supersecretvalue1234&access_token=abcdefghijklmnop",
  "header casing": { AUTHORIZATION: "Bearer Cccccccccccccccccccc" },
  "discord token shape": "mfa.Cd1n2O3p4Q5r6S7t8U9v.Wx1y2Z3a4B5c6D7e8F9g",
  "safe string": "nothing to see here",
};
for (const [label, input] of Object.entries(secrets)) {
  const s = JSON.stringify(S.redactValue(input), (k, v) => (v instanceof Error ? `ERR:${v.message}` : v));
  // Exact substrings only. An earlier version of this probe used a character
  // class here and matched the "C" inside "[REDACTED]", reporting a clean
  // redactor as leaking on every case.
  const NEEDLES = [
    "supersecretvalue1234", "mfa.Cd1n2O3p4Q5r6S7t8U9v", "Wx1y2Z3a4B5c6D7e8F9g",
    "mfaAbCdEfGhIjKlMnOpQr", "zzzzzzzzzzzzzzzzzzzz", "cccccccccccccccccccc",
    "MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=",
  ];
  const leaked = NEEDLES.some((needle) => s.includes(needle));
  check("redact", label, leaked ? "LEAK" : "clean", "clean");
}
check("redact", "safe string preserved",
  S.redactValue("nothing to see here") === "nothing to see here" ? "clean" : "MANGLED", "clean");

console.log(`\n=== ${bad} divergence(s) ===`);
