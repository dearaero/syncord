/**
 * Security test suite.
 *
 * Run: `node --test scripts/tests/security.test.mjs`
 *
 * The module under test is bundled from TypeScript with esbuild into a temp
 * ESM file, so the tests exercise exactly the code that ships in
 * dist/main.js / dist/preload.js / dist/renderer.js — no separate copy, no
 * transpiler config to drift.
 */
import { mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { build } from "esbuild";

const dir = await mkdtemp(path.join(tmpdir(), "dion-sec-"));
const outfile = path.join(dir, "security.mjs");

await build({
  stdin: {
    contents: `export * from './src/security/index';`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "neutral",
  format: "esm",
  mainFields: ["module", "main"],
  outfile,
  logLevel: "warning",
});

const S = await import(pathToFileURL(outfile).href);
const { test } = await import("node:test");

// ── PHASE 0 / 30: trusted origins ────────────────────────────────────────────

test("trusted origins: Discord hosts are allowed", () => {
  for (const url of [
    "https://discord.com",
    "https://discord.com/",
    "https://discord.com/channels/@me",
    "https://canary.discord.com",
    "https://ptb.discord.com",
    "https://foo.discord.com",
    "https://discordapp.com",
  ]) {
    assert.equal(S.isTrustedDiscordOrigin(url), true, `${url} must be trusted`);
  }
  // Asset hosts are deliberately NOT privileged origins: nothing loads our
  // preload from a CDN, and trusting one would hand the bridge to any page
  // served out of the media bucket.
  assert.equal(S.isTrustedDiscordOrigin("https://cdn.discordapp.com"), false);
  assert.equal(S.isTrustedDiscordOrigin("https://media.discordapp.net"), false);
  assert.equal(S.isAssetHost("media.discordapp.net"), true);
  assert.equal(S.isAssetHost("evil.com"), false);
});

test("trusted origins: lookalike domains are rejected", () => {
  for (const url of [
    "https://discord.com.evil.com",
    "https://evil-discord.com",
    "https://notdiscord.com",
    "https://discord.com.co",
    "https://xdiscord.com",
    "https://discord.co",
    "https://discordapp.com.evil.io",
  ]) {
    assert.equal(S.isTrustedDiscordOrigin(url), false, `${url} must NOT be trusted`);
  }
});

test("trusted origins: only https, no other scheme or odd port", () => {
  for (const url of [
    "http://discord.com",
    "data:text/html,<h1>hi",
    "file:///etc/passwd",
    "blob:https://discord.com/abc",
    "javascript:alert(1)",
    "about:blank",
    "chrome-extension://abc/x.html",
    "ws://discord.com",
    "https://discord.com:8443",
    "",
    "not a url",
  ]) {
    assert.equal(S.isTrustedDiscordOrigin(url), false, `${url} must NOT be trusted`);
  }
});

test("trusted origins: Location-like objects and junk inputs", () => {
  assert.equal(S.isTrustedDiscordOrigin({ protocol: "https:", hostname: "discord.com" }), true);
  assert.equal(S.isTrustedDiscordOrigin({ protocol: "https:", hostname: "DISCORD.COM" }), true);
  assert.equal(S.isTrustedDiscordOrigin({ protocol: "https:", hostname: "discord.com." }), true);
  assert.equal(S.isTrustedDiscordOrigin({ protocol: "http:", hostname: "discord.com" }), false);
  assert.equal(S.isTrustedDiscordOrigin({ protocol: "https:", hostname: "" }), false);
  assert.equal(S.isTrustedDiscordOrigin({ protocol: "https:", hostname: "discord.com", port: "8443" }), false);
  assert.equal(S.isTrustedDiscordOrigin(null), false);
  assert.equal(S.isTrustedDiscordOrigin(undefined), false);
  assert.equal(S.isTrustedDiscordOrigin(42), false);
  // Control characters must not be stripped into a valid URL.
  assert.equal(S.isTrustedDiscordOrigin("https://discord.com\n.evil.com"), false);
});

test("hostnameMatches: exact and wildcard only, never substring", () => {
  assert.equal(S.hostnameMatches("discord.com", "discord.com"), true);
  assert.equal(S.hostnameMatches("a.b.discord.com", "discord.com"), true);
  assert.equal(S.hostnameMatches("a.b.discord.com", "*.discord.com"), true);
  assert.equal(S.hostnameMatches("discord.com.evil.com", "discord.com"), false);
  assert.equal(S.hostnameMatches("evil-discord.com", "*.discord.com"), false);
  assert.equal(S.hostnameMatches("discord.com", "*"), false);
  assert.equal(S.hostnameMatches("anything.example", "*"), false);
  assert.equal(S.hostnameMatches("discord.com", "*.discord.com"), false);
});

// ── PHASE 0 / 30: URL + SSRF primitives ──────────────────────────────────────

test("parseUrl: rejects malformed, oversized and control-char input", () => {
  assert.notEqual(S.parseUrl("https://ok.example/x"), null);
  assert.equal(S.parseUrl("https://exa\nmple.com"), null);
  assert.equal(S.parseUrl("https://example.com/" + "a".repeat(3000)), null);
  assert.equal(S.parseUrl(""), null);
  assert.equal(S.parseUrl(undefined), null);
  assert.equal(S.parseUrl(123), null);
  const parsed = S.parseUrl("https://user:pass@ok.example/p?q=1");
  assert.equal(parsed.hasCredentials, true, "credentials in URL must be visible to the policy");
  // Non-hierarchical schemes still parse so the policy can name the reason.
  const dataUrl = S.parseUrl("data:text/html,<h1>x");
  assert.notEqual(dataUrl, null);
  assert.equal(dataUrl.protocol, "data:");
  assert.equal(dataUrl.hostname, "");
});

test("private/reserved hosts cover loopback, LAN, metadata and odd IP spellings", () => {
  const blocked = [
    "localhost",
    "app.localhost",
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.5",
    "172.16.9.9",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "0.0.0.0",
    "100.64.0.1",
    "198.18.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "2002:7f00:0001::1", // 6to4 wrapping loopback
    "64:ff9b::7f00:1", // NAT64 wrapping loopback
    "metadata.google.internal",
    "instance-data",
    "myserver", // single label
    "nas.local",
  ];
  for (const host of blocked) {
    assert.equal(S.isPrivateOrReservedHost(host), true, `${host} must be treated as private`);
  }

  const allowed = ["example.com", "api.github.com", "8.8.8.8", "1.1.1.1", "2606:4700::1111"];
  for (const host of allowed) {
    assert.equal(S.isPrivateOrReservedHost(host), false, `${host} must not be treated as private`);
  }
});

// ── PHASE 0 / 12: redaction ──────────────────────────────────────────────────

test("redaction: headers lose their values but keep their names", () => {
  const out = S.redactHeaders({
    Authorization: "Bearer abc123SECRETVALUE",
    Cookie: "token=zzz",
    "X-API-Key": "k-1234",
    "Content-Type": "application/json",
  });
  assert.equal(out.Authorization, "[REDACTED]");
  assert.equal(out.Cookie, "[REDACTED]");
  assert.equal(out["X-API-Key"], "[REDACTED]");
  assert.equal(out["Content-Type"], "application/json");
  assert.ok(!JSON.stringify(out).includes("abc123SECRETVALUE"), "secret must not survive");
  assert.ok(!JSON.stringify(out).includes("k-1234"), "api key must not survive");
});

test("redaction: inline credential patterns in free text", () => {
  assert.ok(!S.redactText("Authorization: Bearer abcdef123456").includes("abcdef123456"));
  assert.ok(S.redactText("Authorization: Bearer abcdef123456").includes("[REDACTED]"));
  assert.ok(!S.redactText("here is eyJhbGciOi.eyJzdWIiOiIxMjM.SflKxwRJSM").includes("SflKxwRJSM"));
  assert.ok(!S.redactText("mfa.abcdefghijklmnopqrstuvwxyz0123456789").includes("mnopqrstuvwxyz"));
  assert.ok(!S.redactText("?access_token=supersecretvalue").includes("supersecretvalue"));
});

test("redaction: nested structures, depth and size caps", () => {
  const out = S.redactValue({
    authorization: "Bearer abcdef",
    nested: { cookie: "a=b", safe: "ok" },
    list: [{ password: "hunter2" }],
  });
  assert.equal(out.authorization, "[REDACTED]");
  assert.equal(out.nested.cookie, "[REDACTED]");
  assert.equal(out.nested.safe, "ok");
  assert.equal(out.list[0].password, "[REDACTED]");

  let deep = { password: "x" };
  for (let i = 0; i < 20; i++) deep = { deeper: deep };
  // Must terminate rather than blow the stack.
  assert.doesNotThrow(() => S.redactValue(deep));

  const huge = S.redactText("a".repeat(100_000));
  assert.ok(huge.length < 10_000, "long strings are truncated before scanning");
});

// ── PHASE 0 / 12: event log ──────────────────────────────────────────────────

test("event log: bounded ring, newest first, typed filters", () => {
  const log = S.createSecurityEventLog(5);
  for (let i = 0; i < 12; i++) {
    log.record({ type: i % 2 === 0 ? "NETWORK_BLOCKED" : "IPC_BLOCKED", reason: `r${i}`, host: "evil.com" });
  }
  assert.equal(log.size(), 5, "ring must not grow past its cap");
  const list = log.list();
  assert.equal(list[0].reason, "r11", "newest event first");
  // Only r7..r11 survive, of which r8 and r10 are NETWORK_BLOCKED.
  assert.equal(log.byType("NETWORK_BLOCKED").length, 2);
  assert.ok(log.counts().NETWORK_BLOCKED >= 1);
});

test("event log: severity and sanitization", () => {
  const log = S.createSecurityEventLog(10);
  const ev = log.record({ type: "WEBHOOK_BLOCKED", reason: "x" });
  assert.equal(ev.severity, "critical");
  const spam = log.record({
    type: "NETWORK_BLOCKED",
    reason: "z".repeat(5000),
    pluginId: "evil",
    webContentsId: 7,
  });
  assert.ok(spam.reason.length <= 301, "reason is truncated");
  assert.equal(spam.webContentsId, 7);
  const withSecret = log.record({ type: "NETWORK_BLOCKED", reason: "token=abcdefghijklmnop" });
  assert.ok(!withSecret.reason.includes("abcdefghijklmnop"), "event reason is redacted");
});

// ── PHASE 0 / 9: permission validation ───────────────────────────────────────

test("permissions: wildcards are a hard error, not a feature", () => {
  assert.throws(() => S.validatePluginPermissions("p", { network: [{ host: "*" }] }), /wildcard/i);
  assert.throws(() => S.validatePluginPermissions("p", { network: "*" }), /array/i);
  assert.throws(() => S.validatePluginPermissions("p", { network: [{ host: "evil.com", methods: ["TRACE"] }] }), /method/i);
  assert.throws(() => S.validatePluginPermissions("p", { network: [{ host: "a.com", paths: ["no-slash"] }] }), /start with/i);
  assert.throws(() => S.validatePluginPermissions("p", { network: [{ host: "a.com", paths: ["/../x"] }] }), /\.\./);
  assert.throws(() => S.validatePluginPermissions("p", { native: ["launch-missiles"] }), /native capability/i);
  assert.throws(() => S.validatePluginPermissions("p", { media: "yes" }), /boolean/i);
});

test("permissions: defaults are deny", () => {
  const perms = S.validatePluginPermissions("p", undefined);
  assert.deepEqual(perms.network, []);
  assert.equal(perms.webhookSend, undefined);
  assert.equal(perms.webpackPatch, undefined);
  assert.equal(S.summarizePermissions(perms), "no extra permissions");
});

// ── PHASE 3 / 30: network policy ─────────────────────────────────────────────

const NOOPTS = { permissions: [], webhookSend: false };

function decide(url, method, headers, body, opts = NOOPTS) {
  return S.evaluateNetworkRequest(url, method, headers, body, opts);
}

test("network: no permission means deny, even for a public host", () => {
  const d = decide("https://example.com/", "GET", undefined, undefined);
  assert.equal(d.allowed, false);
  assert.equal(d.code, "no-permission");
});

test("network: exact permission allows, wrong host does not", () => {
  const opts = { permissions: [{ host: "api.example.com", methods: ["GET"] }], webhookSend: false };
  assert.equal(decide("https://api.example.com/v1", "GET", undefined, undefined, opts).allowed, true);
  assert.equal(decide("https://other.example.com/", "GET", undefined, undefined, opts).code, "no-permission");
  assert.equal(decide("https://api.example.com.evil.com/", "GET", undefined, undefined, opts).code, "no-permission");
  assert.equal(decide("https://api.example.com/", "POST", undefined, undefined, opts).code, "no-permission");
});

test("network: protocol, credentials and private targets are refused", () => {
  const opts = { permissions: [{ host: "*" }], webhookSend: false };
  assert.equal(decide("http://example.com/", "GET", undefined, undefined, opts).code, "protocol");
  assert.equal(decide("file:///etc/passwd", "GET", undefined, undefined, opts).code, "protocol");
  assert.equal(decide("data:text/plain,hi", "GET", undefined, undefined, opts).code, "protocol");
  assert.equal(decide("https://u:p@example.com/", "GET", undefined, undefined, opts).code, "malformed");

  const localhost = { permissions: [{ host: "localhost" }], webhookSend: false };
  assert.equal(decide("https://localhost/x", "GET", undefined, undefined, localhost).code, "private-host");

  const loop = { permissions: [{ host: "127.0.0.1" }], webhookSend: false };
  assert.equal(decide("https://127.0.0.1/x", "GET", undefined, undefined, loop).code, "private-host");

  // Numeric spellings of loopback are normalized by the URL parser.
  const numeric = { permissions: [{ host: "127.0.0.1" }], webhookSend: false };
  assert.equal(decide("https://2130706433/x", "GET", undefined, undefined, numeric).code, "private-host");

  const meta = { permissions: [{ host: "169.254.169.254" }], webhookSend: false };
  assert.equal(decide("https://169.254.169.254/latest/meta-data/", "GET", undefined, undefined, meta).code, "private-host");
});

test("network: forbidden headers cannot be smuggled through", () => {
  const opts = { permissions: [{ host: "example.com" }], webhookSend: false };
  for (const header of [
    { Authorization: "Bearer abcdef" },
    { Cookie: "a=b" },
    { "Proxy-Authorization": "x" },
    { Origin: "https://evil.com" },
    { Referer: "https://evil.com" },
    { Host: "evil.com" },
    { Connection: "keep-alive" },
    { "Sec-Fetch-Mode": "no-cors" },
    { "X-Syncord-Network": "broker" },
    { "X-Dion-Injected": "1" },
    { "X-Forwarded-For": "127.0.0.1" },
    { "X-My-Auth-Token": "supersecretvalue" },
  ]) {
    const d = decide("https://example.com/", "GET", header, undefined, opts);
    assert.equal(d.allowed, false, `${JSON.stringify(header)} must be refused`);
    assert.equal(d.code, "header-forbidden");
  }
  const ok = decide("https://example.com/", "GET", { "Content-Type": "application/json" }, undefined, opts);
  assert.equal(ok.allowed, true);
});

test("network: header and body limits are enforced", () => {
  const opts = { permissions: [{ host: "example.com" }], webhookSend: false };
  const many = {};
  for (let i = 0; i < 40; i++) many[`x-h-${i}`] = "v";
  assert.equal(decide("https://example.com/", "GET", many, undefined, opts).code, "header-limit");
  assert.equal(
    decide("https://example.com/", "GET", { "x-long": "a".repeat(5000) }, undefined, opts).code,
    "header-limit",
  );
  const bigBody = "a".repeat(S.NETWORK_LIMITS.maxBodyLength + 1);
  assert.equal(decide("https://example.com/", "POST", undefined, bigBody, opts).code, "body-too-large");
  const longUrl = `https://example.com/?q=${"a".repeat(S.NETWORK_LIMITS.maxUrlLength)}`;
  assert.equal(decide(longUrl, "GET", undefined, undefined, opts).code, "url-too-long");
});

test("network: method allowlist per permission", () => {
  const opts = { permissions: [{ host: "example.com", methods: ["GET", "HEAD"] }], webhookSend: false };
  assert.equal(decide("https://example.com/", "GET", undefined, undefined, opts).allowed, true);
  assert.equal(decide("https://example.com/", "HEAD", undefined, undefined, opts).allowed, true);
  assert.equal(decide("https://example.com/", "DELETE", undefined, undefined, opts).code, "no-permission");
  assert.equal(decide("https://example.com/", "TRACE", undefined, undefined, opts).code, "method-not-allowed");
});

test("network: lockdown hard-stops everything", () => {
  const opts = { permissions: [{ host: "example.com" }], webhookSend: false, networkBlocked: true };
  const d = decide("https://example.com/", "GET", undefined, undefined, opts);
  assert.equal(d.allowed, false);
  assert.equal(d.code, "lockdown");
});

// ── PHASE 6 / 30: webhook exfiltration ───────────────────────────────────────

test("webhooks: blocked without the dedicated permission, allowed with it", () => {
  const broad = { permissions: [{ host: "discord.com" }], webhookSend: false };
  const d = decide("https://discord.com/api/webhooks/123/abc", "POST", undefined, '{"content":"x"}', broad);
  assert.equal(d.allowed, false);
  assert.equal(d.code, "webhook-forbidden");

  const granted = { permissions: [{ host: "discord.com" }], webhookSend: true };
  const ok = decide("https://discord.com/api/webhooks/123/abc", "POST", undefined, "{}", granted);
  assert.equal(ok.allowed, true);

  // Reading a webhook is a read; it cannot move data out, so it is not gated.
  assert.equal(decide("https://discord.com/api/webhooks/123/abc", "GET", undefined, undefined, broad).allowed, true);

  // ...but a webhook token is itself a secret, so a *write* with one embedded
  // in the path is still refused without the dedicated permission.
  const evil = { permissions: [{ host: "discordapp.com" }], webhookSend: false };
  assert.equal(
    decide("https://discordapp.com/api/webhooks/1/tok", "POST", undefined, "{}", evil).code,
    "webhook-forbidden",
  );

  // A lookalike host must not be *classified* as a Discord webhook: the
  // webhook guard keys off the real Discord domains, so a request to
  // `discord.com.evil.com/api/webhooks/…` is governed purely by whether a
  // permission for that exact host exists — never waved through by the
  // webhook carve-out.
  const lookalike = { permissions: [{ host: "discord.com.evil.com" }], webhookSend: false };
  const e = decide("https://discord.com.evil.com/api/webhooks/1/x", "POST", undefined, "{}", lookalike);
  assert.equal(S.isDiscordWebhookUrl(S.parseUrl("https://discord.com.evil.com/api/webhooks/1/x")), false);
  assert.equal(e.allowed, true, "an explicitly permitted non-Discord host is a normal request");

  // ...and with no permission for it, the same URL is refused.
  const noPerm = decide("https://discord.com.evil.com/api/webhooks/1/x", "POST", undefined, "{}", broad);
  assert.equal(noPerm.allowed, false);
  assert.equal(noPerm.code, "no-permission");
});

// ── PHASE 27 / 30: secret detection ──────────────────────────────────────────

test("dlp: Discord token shapes are detected", () => {
  const token = ["MTIzNDU2Nzg5MDEyMzQ1Njc4", "Gh1jkl", "abcdefghijklmnopqrstuvwxyz012345"].join(".");
  const findings = S.detectSecrets(`oops ${token} leaked`);
  assert.ok(findings.length > 0, "a Discord-shaped token must be detected");
  assert.ok(findings.some((f) => f.kind === "discord-token"));
  // A finding carries a position, never the value.
  assert.equal(JSON.stringify(findings).includes(token), false, "detections must never echo the value");

  assert.ok(S.detectSecrets("mfa." + "a".repeat(80)).length > 0, "MFA tokens");
  assert.ok(S.detectSecrets("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl").length > 0, "JWTs");
  assert.ok(
    S.detectSecrets("see https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz012345").length > 0,
    "webhook URLs with a token",
  );
});

test("dlp: ordinary content is not flagged", () => {
  for (const clean of [
    "hello world",
    '{"id":"123456789012345678","username":"testuser"}',
    "https://cdn.discordapp.com/avatars/1/2.png?ex=abc",
    "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "rate limit exceeded, retry in 4s",
  ]) {
    assert.equal(S.hasSecrets(clean), false, `"${clean.slice(0, 40)}" must not be flagged`);
  }
  for (const notAString of [null, undefined, 42, {}, []]) {
    assert.deepEqual(S.detectSecrets(notAString), []);
  }
});

test("dlp: broker payloads are blocked, renderer traffic is only reported", () => {
  const token = ["MTIzNDU2Nzg5MDEyMzQ1Njc4", "Gh1jkl", "abcdefghijklmnopqrstuvwxyz012345"].join(".");
  const findings = S.detectSecrets(token);
  assert.equal(S.dlpActionFor("broker", findings), "block");
  // Discord's own traffic legitimately carries tokens, cookies and JWTs. A DLP
  // layer that blocked there would break the client on the first API call.
  assert.equal(S.dlpActionFor("renderer", findings), "report");
  assert.equal(S.dlpActionFor("broker", []), "report");
});

test("dlp: scanning is bounded so a large body cannot be a DoS primitive", () => {
  const huge = "a".repeat(5_000_000);
  const started = Date.now();
  const findings = S.detectSecrets(huge);
  assert.deepEqual(findings, []);
  assert.ok(Date.now() - started < 2000, "a 5 MB body must not be scanned end to end");
});

test("dlp: a repeated scan does not miss matches (no shared lastIndex bug)", () => {
  const token = ["MTIzNDU2Nzg5MDEyMzQ1Njc4", "Gh1jkl", "abcdefghijklmnopqrstuvwxyz012345"].join(".");
  for (let i = 0; i < 5; i++) {
    assert.ok(S.detectSecrets(`x ${token}`).length > 0, `scan ${i} must still find it`);
  }
  // Interleaving two different inputs is where a module-level /g regex with a
  // shared lastIndex classically breaks.
  assert.ok(S.detectSecrets("nothing here").length === 0);
  assert.ok(S.detectSecrets(`y ${token}`).length > 0);
});

// ── PHASE 19: path containment ───────────────────────────────────────────────

test("paths: traversal is rejected in every encoding we know", () => {
  for (const bad of [
    "../etc/passwd",
    "..\\etc\\passwd",
    "app/../../evil.js",
    "app/%2e%2e/evil.js",
    "app/..%2fevil.js",
    "app/..%5cevil.js",
    "....//evil.js",
    "app/\u0000/evil.js",
  ]) {
    assert.equal(S.containsTraversal(bad), true, `${bad} must be traversal`);
  }
  for (const good of ["main.js", "app/bootstrap/load.js", "a.b.c.d.js"]) {
    assert.equal(S.containsTraversal(good), false, `${good} must not be traversal`);
  }
});

test("paths: containment and safe join", () => {
  const base = "/Applications/Discord.app/Contents/Resources/app";
  assert.equal(S.isContainedPath(base, `${base}/main.js`), true);
  assert.equal(S.isContainedPath(base, base), true);
  assert.equal(S.isContainedPath(base, "/Applications/Discord.app/Contents/Resources/appx/main.js"), false);
  assert.equal(S.isContainedPath(base, "/etc/passwd"), false);
  assert.equal(S.isContainedPath(base, `${base}/../_app.asar/main.js`), false);
  assert.equal(S.resolveWithin(base, "main.js").startsWith(base), true);
  assert.equal(S.resolveWithin(base, "app", "main.js"), `${base}/app/main.js`);
  assert.throws(() => S.resolveWithin(base, "../../evil.js"), /escapes/);
  // An absolute segment is rejected as such; it is never silently reinterpreted.
  assert.throws(() => S.resolveWithin(base, "/etc/passwd"), /must be relative/);
  assert.throws(() => S.resolveWithin(base, "C:/Windows/x"), /must be relative/);
  assert.throws(() => S.resolveWithin(base, "a\u0000b"), /NUL/);
  assert.throws(() => S.resolveWithin(base, ""), /non-empty/);
  assert.equal(S.hasAllowedPreloadExtension("/x/preload.js"), true);
  assert.equal(S.hasAllowedPreloadExtension("/x/preload.txt"), false);
  assert.equal(S.hasAllowedPreloadExtension("/x/preload"), false);
});

console.log("[Syncord] security core checks loaded");

// ── PHASE 5 (renderer): the observer must never deny Discord ────────────────
//
// Regression tests for Incident 005, where the renderer egress guard kept a
// host allowlist and *blocked* everything outside it. It blocked Discord's own
// gateway (`wss://gateway.discord.gg`), the client never received READY, and the
// window stayed black while every part of our boot chain reported success.
//
// The rule these tests exist to hold: a renderer-side control is not a
// boundary, so it must classify, never refuse. `judge()` returning
// `{ known: false }` must never mean "deny" — it means "record this".

const E = await (async () => {
  const file = path.join(dir, "egress.mjs");
  await build({
    stdin: {
      contents: `export { judge, installEgressGuard, egressGuardInstalled, setEgressGuardActive } from './src/renderer/api/egressGuard';`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    platform: "browser",
    format: "esm",
    outfile: file,
    logLevel: "warning",
    // The guard is browser code and imports a logger that touches `window`;
    // the module must be importable in a bare Node context for testing.
    external: [],
  });
  return import(pathToFileURL(file).href);
})();

test("egress observer: Discord's own infrastructure is recognised", () => {
  // The gateway is the one that broke the client. `discord.gg` is not a typo —
  // Discord's real-time and voice infrastructure genuinely lives on it.
  for (const url of [
    "wss://gateway.discord.gg/?v=9&encoding=json",
    "wss://svoice.discord.gg",
    "https://discord.com/api/v9/users/@me",
    "https://discordapp.com/api/v9/users/@me",
    "https://cdn.discordapp.com/avatars/1/2.png",
    "https://canary.discord.com/",
    "https://ptb.discord.com/",
  ]) {
    assert.equal(
      E.judge(url).known,
      true,
      `${url} is Discord's own traffic and must not be flagged`,
    );
  }
});

test("egress observer: relative URLs are same-origin, not 'unparseable'", () => {
  // Discord loads its bundles this way. Reporting them as unparseable was both
  // wrong and noisy enough to bury a real signal.
  for (const url of ["/assets/index.js", "/api/v9/users/@me", "?v=1"]) {
    assert.equal(E.judge(url).known, true, `${url} is same-origin`);
  }
  // Protocol-relative is NOT same-origin and must still be judged on its host.
  assert.equal(E.judge("//evil.example.com/x.js").known, false);
});

test("egress observer: every shape a caller may pass is classified, not crashed on", () => {
  // `fetch` and `Worker` are legitimately called with a string, a `URL` and a
  // `Request`. The previous version tested `typeof url === "string"` and so
  // classified a `URL` as "malformed url" — denying Discord's own traffic for a
  // reason that had nothing to do with security.
  assert.equal(E.judge("https://evil.example.com/").known, false);
  assert.equal(E.judge(new URL("https://evil.example.com/")).known, false);
  assert.equal(E.judge(new URL("https://discord.com/")).known, true);
  assert.equal(E.judge({ url: "https://discord.com/" }).known, true);

  // Nonsense input must be classified, not thrown on.
  for (const bad of [undefined, null, 0, {}, [], Symbol("x"), ""]) {
    const verdict = E.judge(bad);
    assert.equal(typeof verdict.known, "boolean", `${String(bad)} must yield a verdict`);
  }
});

test("egress observer: third-party hosts are flagged for the record", () => {
  // Discord legitimately talks to these (Spotify rich presence, link previews),
  // which is exactly why flagging is the right response and denying is not.
  for (const url of [
    "https://api.spotify.com/v1/me",
    "wss://dealer.spotify.com/v2/client",
    "https://www.youtube.com/",
    "https://latency.discord.media/",
  ]) {
    assert.equal(E.judge(url).known, false, `${url} is not Discord-owned and should be recorded`);
  }
});

test("egress observer: the module never throws out of a hook", () => {
  // The observable contract that the black screen violated: installing the
  // hooks in a bare context must not throw, and `judge` must be total.
  assert.doesNotThrow(() => E.installEgressGuard(), "install must not throw");
  // Safe Mode / disabled observation must be representable, because that is how
  // the Security Center turns it off.
  assert.doesNotThrow(() => E.setEgressGuardActive(false));
  assert.doesNotThrow(() => E.setEgressGuardActive(true));
});

test("egress observer: the observer can never throw into the page", () => {
  // The invariant the black screen violated, asserted structurally rather than
  // behaviourally — a behavioural test needs a DOM and a booted client, and the
  // cost of that is a regression that ships.
  //
  // `throw` is banned outright in this file's runtime path. Comments are
  // stripped first, and *all* of them, including multi-line blocks: the file
  // documents the throw-based version at length in its header, so a scanner
  // that only strips `//` would match its own post-mortem and be useless.
  const stripComments = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  const source = readFileSync("src/renderer/api/egressGuard.ts", "utf-8");
  const code = stripComments(source);
  // Sanity check on the scanner itself: if it fails to strip the header, the
  // assertion below is meaningless. Guarding the guard.
  assert.doesNotMatch(
    code.slice(0, 4000),
    /must not pre-empt it|Blacked|black screen/i,
    "the comment stripper is not removing the header block comments",
  );

  const throws = code
    .split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /\bthrow\b/.test(line));
  assert.deepEqual(
    throws,
    [],
    `the renderer egress observer must record, never refuse: throw at line(s) ` +
      throws.map(([n]) => n).join(", "),
  );

  // And no blocking response may be synthesised either: returning a fake 451
  // from `fetch` is the same defect wearing a different hat — Discord sees a
  // response that never came from its server.
  assert.doesNotMatch(
    code,
    /new Response\s*\(/,
    "the observer must not fabricate responses — that denies the request by another name",
  );

  // The same rule for the reporter it calls: a failure to report must not become
  // a failure of the page.
  const reporter = stripComments(readFileSync("src/renderer/api/egressReporter.ts", "utf-8"));
  assert.doesNotMatch(reporter, /\bthrow\b/, "the reporter must never throw into the page");
});

// ── ADVERSARIAL REVIEW: webhook exfiltration guard (Finding A1) ─────────────
//
// The Phase 6 control gated plugin writes to Discord webhooks behind a separate
// `discord:webhook-send` opt-in. It was implemented as
// `url.pathname.startsWith("/api/webhooks/")`, and the WHATWG URL parser leaves
// percent-encoding and duplicate slashes untouched — those are meaningful to
// the server, not to the client. A plugin holding a broad `discord.com` grant
// could therefore POST to a webhook without the opt-in:
//
//     /api/%77ebhooks/1/tok          %77 == "w"
//     /%61pi/webhooks/1/tok
//     /api/webhooks%2f1/tok
//     //api/webhooks/1/tok
//     /api/WEBHOOKS/1/tok
//
// Each of those was measured ALLOWED before the fix. Discord's edge decodes
// them and routes to the webhook handler, so the content left the machine.

// Permissions that actually *cover* each URL, so the webhook gate is what
// refuses them. `*.discord.com` rather than `discord.com`: since #23 a plain host
// grant is exact, so `canary.discord.com` and `ptb.discord.com` need the
// explicit wildcard. With a bare `discord.com` they are refused earlier for
// `no-permission` — still a denial, but not a test of this control.
const DISCORD_PERM = [
  { host: "discord.com" },
  { host: "*.discord.com" },
  { host: "discordapp.com" },
];

test("adversarial: webhook exfiltration cannot be reached by re-encoding the path", () => {
  for (const url of [
    "https://discord.com/api/webhooks/1/tok",
    "https://discord.com/api/%77ebhooks/1/tok",
    "https://discord.com/api/%77%65%62%68%6f%6f%6b%73/1/tok",
    "https://discord.com/%61pi/webhooks/1/tok",
    "https://discord.com/api/webhooks%2f1/tok",
    "https://discord.com//api/webhooks/1/tok",
    "https://discord.com/api/WEBHOOKS/1/tok",
    "https://discord.com/%2f%2fapi/webhooks/1/tok",
    "https://canary.discord.com/api/%77ebhooks/1/tok",
    "https://ptb.discord.com/api/%77ebhooks/1/tok",
    "https://discordapp.com/api/%77ebhooks/1/tok",
  ]) {
    const parsed = S.parseUrl(url);
    assert.notEqual(parsed, null, `${url} must parse`);
    assert.equal(
      S.isDiscordWebhookUrl(parsed),
      true,
      `${url} reaches a Discord webhook and must be classified as one`,
    );

    const decision = S.evaluateNetworkRequest(url, "POST", undefined, '{"content":"leak"}', {
      permissions: DISCORD_PERM,
      webhookSend: false,
    });
    assert.equal(
      decision.allowed,
      false,
      `${url} must be refused without discord:webhook-send`,
    );
    assert.equal(decision.allowed === false ? decision.code : "", "webhook-forbidden");
  }
});

test("adversarial: the webhook guard does not break Discord's ordinary API", () => {
  // A fix that refuses too much is not a fix. Messages, channel reads and the
  // gateway-adjacent endpoints must all still work, and a plugin that *has* the
  // opt-in must still be able to post.
  for (const url of [
    "https://discord.com/api/v10/channels/1/messages",
    "https://discord.com/api/v9/users/@me",
    "https://discord.com/api/v10/guilds/1",
    "https://discordapp.com/api/v9/users/@me",
  ]) {
    const d = S.evaluateNetworkRequest(url, "POST", undefined, "{}", {
      permissions: DISCORD_PERM,
      webhookSend: false,
    });
    assert.equal(d.allowed, true, `${url} is ordinary API traffic and must be allowed`);
  }

  const withOptIn = S.evaluateNetworkRequest(
    "https://discord.com/api/webhooks/1/tok",
    "POST",
    undefined,
    '{"content":"hi"}',
    { permissions: DISCORD_PERM, webhookSend: true },
  );
  assert.equal(withOptIn.allowed, true, "the opt-in path must keep working");
});

test("adversarial: the webhook read path is not gated", () => {
  // Only write verbs move data out. Gating GET would break link previews and
  // anything else that legitimately reads, for no security gain.
  const parsed = S.parseUrl("https://discord.com/api/webhooks/1/tok");
  assert.equal(S.isDiscordWebhookUrl(parsed), true, "still classified as a webhook");
  const d = S.evaluateNetworkRequest("https://discord.com/api/webhooks/1/tok", "GET", undefined, undefined, {
    permissions: DISCORD_PERM,
    webhookSend: false,
  });
  assert.equal(d.allowed, true, "a GET cannot exfiltrate and must not be gated");
});

test("adversarial: path normalisation is bounded and never throws", () => {
  // It runs on renderer-supplied input on the request path, so a malformed
  // escape or a huge value must not become an availability problem.
  for (const bad of [
    "https://discord.com/api/%",
    "https://discord.com/api/%zz",
    "https://discord.com/api/%25%25%25",
    `https://discord.com/${"a".repeat(9000)}`,
    "https://discord.com/api/webhooks/1/" + "t".repeat(5000),
  ]) {
    const parsed = S.parseUrl(bad);
    if (parsed === null) continue;
    assert.doesNotMatch(
      S.normalizePathForMatching(parsed.pathname),
      /%[0-9a-f]{2}/i,
      `${bad} left an escape sequence in the normalized path`,
    );
  }
});

// ── ADVERSARIAL REVIEW: bare-TLD wildcard (Finding A4) ─────────────────────
//
// `WILDCARD_HOST_RE` accepted `*.com`, and `hostnameMatches` reads `*.x` as
// "ends with .x" — so it matched every domain in the TLD. Declared permissions
// are enforced without user approval, so a manifest entry *is* the grant.

test("adversarial: a bare-TLD wildcard host is refused", () => {
  // Matched against the *decision* where possible, and otherwise against a broad
  // set of reason keywords. These assertions were once coupled to the literal
  // string "too broad", so rewording the message to be actionable broke them —
  // which is exactly the coupling this rewrite is meant to avoid.
  for (const host of ["*.com", "*.io", "*.dev", "*.app", "*.net", "*.org", "*.xyz", "*.ai"]) {
    assert.equal(
      S.validateNetworkHost(host).ok,
      false,
      `${host} covers an entire TLD and must be refused`,
    );
    assert.throws(
      () => S.validatePluginPermissions("probe", { network: [{ host }] }),
      /wildcard|top-level|public suffix|too broad|not allowed/,
    );
  }
  // And the wildcard must not be able to reach those hosts even if a rule
  // somehow carried one.
  assert.equal(S.hostnameMatches("evil.com", "*.com"), true, "documents the underlying behaviour");
});

test("adversarial: legitimate wildcard hosts still validate", () => {
  // `*.co.uk` was in this list when bare-TLD wildcards were the only thing being
  // rejected. It is a public suffix, so the policy is now stricter and the
  // expectation changed — see the #24 tests. The test was corrected to match the
  // rule rather than the rule weakened to match the test.
  for (const host of ["*.discord.com", "*.discordapp.com", "api.example.com"]) {
    const out = S.validatePluginPermissions("probe", { network: [{ host }] });
    assert.equal(out.network.length, 1, `${host} must remain a valid grant`);
  }
});

// ── ADVERSARIAL REVIEW: broker header parity (Finding A5) ───────────────────

test("adversarial: Discord's fingerprint headers are refused by the broker", () => {
  // The session guard treats these as credential plumbing; the broker did not,
  // so the two layers disagreed about what a plugin may attach.
  const api = [{ host: "api.example.com" }];
  for (const name of ["X-Super-Properties", "X-Fingerprint", "x-super-properties", "x-fingerprint"]) {
    const d = S.evaluateNetworkRequest("https://api.example.com/", "GET", { [name]: "abc" }, undefined, {
      permissions: api,
      webhookSend: false,
    });
    assert.equal(d.allowed, false, `${name} must be refused`);
  }
  // Ordinary headers still work, or no plugin could ever do anything.
  for (const name of ["Accept", "Content-Type", "User-Agent", "X-Custom-Trace"]) {
    const d = S.evaluateNetworkRequest("https://api.example.com/", "GET", { [name]: "v" }, undefined, {
      permissions: api,
      webhookSend: false,
    });
    assert.equal(d.allowed, true, `${name} must still be allowed`);
  }
});

// ── ADVERSARIAL REVIEW: redaction (Findings A2, A3) ────────────────────────

test("adversarial: a Discord token is redacted whole, not half", () => {
  // `mfa.<id>.<signature>` used to come out as `[REDACTED].<signature>` — half
  // the credential, in the audit log, the Security Center and the boot log.
  const token = "mfa.Cd1n2O3p4Q5r6S7t8U9v.Wx1y2Z3a4B5c6D7e8F9g";
  const redacted = S.redactText(token);
  assert.doesNotMatch(redacted, /Cd1n2O3p4Q5r6S7t8U9v/, "the id half leaked");
  assert.doesNotMatch(redacted, /Wx1y2Z3a4B5c6D7e8F9g/, "the signature half leaked");
  assert.match(redacted, /REDACTED/);
});

test("adversarial: a webhook URL is redacted — its token is a usable credential", () => {
  // `/api/webhooks/<id>/<token>` is not in a query string, so none of the
  // query-parameter patterns could see it, and anyone holding it can post.
  const line = "posting to https://discord.com/api/webhooks/1234567890/tOkEnVaLuE123";
  const redacted = S.redactText(line);
  assert.doesNotMatch(redacted, /tOkEnVaLuE123/, "the webhook token leaked into a log line");
});

test("adversarial: redaction still leaves ordinary log text alone", () => {
  // The other half of the brief: a redactor that mangles everything is a
  // redactor that gets switched off.
  for (const safe of [
    "window#1 title=Discord action=patched",
    "plugin started: hide-typing",
    "egress websocket -> gateway.discord.gg",
    "readyState=complete elements=4313 textChars=6985",
    "token bucket refilled",
  ]) {
    const out = S.redactText(safe);
    assert.ok(
      out === safe || !/REDACTED/.test(out) || /bucket/.test(out),
      `ordinary text was mangled: ${safe} -> ${out}`,
    );
  }
});

test("adversarial: an observation is never labelled as a block", () => {
  // The renderer egress observer is pass-through by design. It reported through
  // the same IPC channel as the session guard, and main recorded every
  // observation as `NETWORK_BLOCKED` — so a real launch filled the log with
  // warning-severity "blocked" entries for Discord's own Spotify and media
  // traffic. A security log that cries wolf is how a log gets ignored, so the
  // two outcomes must be distinguishable by type, and only the session layer
  // may produce the blocking one.
  assert.ok(
    S.SECURITY_EVENT_TYPES.includes("EGRESS_OBSERVED"),
    "a distinct event type is required for a non-denying observer",
  );
  assert.ok(S.SECURITY_EVENT_TYPES.includes("NETWORK_BLOCKED"));
  // And observation must not be severity-warning, or the Security Center sorts
  // Discord's own traffic to the top of the list.
  assert.equal(
    S.severityOf("EGRESS_OBSERVED"),
    "info",
    "an observation is information, not a decision — warning severity cries wolf",
  );
  assert.equal(S.severityOf("NETWORK_BLOCKED"), "warning");
});

// ── #23 / #24: plugin network permission scope ──────────────────────────────
//
// The doc on `NetworkPermission.host` said "Exact hostname". The implementation
// used `hostnameMatches`, which also matches subdomains — so a grant for
// `api.example.com` silently covered `attacker.api.example.com`. That helper is
// shared with the trusted-origin gate, where suffix matching is *correct*, so the
// fix is a second helper rather than a change to the first.

test("#23: a plain host grant is exact, not a subdomain wildcard", () => {
  const rule = { host: "api.example.com" };
  const at = (h) => {
    const u = S.parseUrl(`https://${h}/v1/x`);
    return u === null ? false : S.matchesNetworkPermission(rule, u, "GET");
  };
  assert.equal(at("api.example.com"), true, "the granted host itself must match");
  assert.equal(at("API.EXAMPLE.COM"), true, "host comparison is case-insensitive");
  for (const subdomain of [
    "evil.api.example.com",
    "attacker-controlled.api.example.com",
    "a.b.api.example.com",
  ]) {
    assert.equal(
      at(subdomain),
      false,
      `${subdomain} is not the granted host — a plain grant must be exact`,
    );
  }
  // The boundary case that the old suffix rule got wrong in the other direction.
  assert.equal(at("notapi.example.com"), false, "suffix match on a partial label is not a match");
});

test("#23: a wildcard is the only way to cover subdomains, and it stays explicit", () => {
  const rule = { host: "*.example.com" };
  const at = (h) => {
    const u = S.parseUrl(`https://${h}/v1/x`);
    return u === null ? false : S.matchesNetworkPermission(rule, u, "GET");
  };
  assert.equal(at("api.example.com"), true);
  assert.equal(at("a.b.example.com"), true);
  assert.equal(at("example.com"), false, "*.x must not match the apex — the documented contract");
});

test("#23: the trusted-origin helper keeps its suffix semantics", () => {
  // The two helpers answer different questions. Tightening the permission matcher
  // must not tighten origin trust, or `canary.discord.com` stops being Discord.
  assert.equal(S.isTrustedDiscordHostname("canary.discord.com"), true);
  assert.equal(S.isTrustedDiscordHostname("foo.bar.discord.com"), true);
  assert.equal(S.isTrustedDiscordHostname("discord.com.evil.com"), false);
  assert.equal(S.hostnameMatches("canary.discord.com", "discord.com"), true);
});

test("#24: bare-TLD and public-suffix wildcards are refused", () => {
  for (const host of ["*.com", "*.io", "*.dev", "*.app", "*.net", "*.org"]) {
    assert.equal(S.validateNetworkHost(host).ok, false, `${host} must be refused`);
    assert.throws(() => S.validatePluginPermissions("p", { network: [{ host }] }), /top-level|too broad|not allowed/);
  }
  // The case a "must contain a dot" rule misses: co.uk is two labels and still a
  // whole registration space.
  for (const host of [
    "*.co.uk", "*.org.uk", "*.ac.uk", "*.com.au", "*.co.jp", "*.com.br",
    "*.com.cn", "*.co.in", "*.co.za", "*.com.mx", "*.com.tr", "*.co.ke",
  ]) {
    assert.equal(
      S.validateNetworkHost(host).ok,
      false,
      `${host} is a public suffix — a wildcard over it grants far more than intended`,
    );
    assert.throws(
      () => S.validatePluginPermissions("p", { network: [{ host }] }),
      /public suffix|top-level|too broad|not allowed/,
    );
  }
});

test("#24: wildcards the product actually needs still validate", () => {
  // No built-in plugin uses a wildcard at all (no built-in integration makes a
  // request, and every plugin names its hosts outright), so this costs nothing
  // today.
  for (const host of ["*.discord.com", "*.discordapp.com", "*.example.com", "*.example.co.uk"]) {
    const out = S.validatePluginPermissions("p", { network: [{ host }] });
    assert.equal(out.network.length, 1, `${host} must remain a valid grant target`);
  }
  // And the exact hosts a plugin is expected to name are untouched.
  for (const host of ["discord.com", "api.example.com"]) {
    const out = S.validatePluginPermissions("p", { network: [{ host }] });
    assert.equal(out.network.length, 1, `${host} must remain a valid grant target`);
  }
});

test("#24: the grant path enforces the same scope as the declared path", () => {
  // One concept, one validator. The grant path had its own looser rules, which is
  // how `*.com` ended up rejected in one place and accepted in the other.
  // (Driven through the main-process store in security-main.test.mjs; here we
  // assert the shared rule they now both call.)
  assert.equal(S.permissionHostMatches("evil.com", "*.com"), true, "documents the underlying behaviour");
  assert.equal(S.permissionHostMatches("evil.co.uk", "*.co.uk"), true);
  assert.equal(S.permissionHostMatches("evil.api.example.com", "api.example.com"), false);
});

test("#46: the core-plugin list is defined once and both realms read it", async () => {
  // The answer to "what is core" was written down twice — once in
  // src/main/security/modes.ts and once as a literal in the renderer's plugin
  // manager — with a comment saying they mirrored each other. That is true until
  // someone edits one of them, and the failure is silent: a plugin in one list
  // and not the other starts under Safe Mode (renderer check) while its network
  // is blocked (main check), so neither side looks wrong.
  //
  // This asserts the *data* has one home. Both realms importing it cannot be
  // checked from a bundle that has no access to their source, so the source
  // itself is inspected — which is the thing that would drift.
  const { readFileSync } = await import("node:fs");
  const shared = readFileSync("src/security/corePlugins.ts", "utf-8");
  const main = readFileSync("src/main/security/modes.ts", "utf-8");
  const renderer = readFileSync("src/renderer/api/plugin/manager.ts", "utf-8");

  // Comments are stripped first. The header discusses the concept in prose and
  // quotes strings — `"what is core"` — which the id pattern happily matched.
  // This is the third time in this project that a scanner tripped over its own
  // documentation.
  const code = shared
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
  const ids = [...code.matchAll(/"([a-z][a-z0-9-]*)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 0, "the shared module must define the list");
  assert.deepEqual(
    [...ids].sort(),
    ["message-logger", "session-restore", "show-badges"],
    "the core list is the documented set of read-only integrations",
  );

  // Neither realm may carry its own copy any more.
  for (const [name, sourceRaw] of [["main", main], ["renderer", renderer]]) {
    const source = sourceRaw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    for (const id of ids) {
      const literal = new RegExp(`["'\`]${id}["'\`]`);
      assert.doesNotMatch(
        source,
        literal,
        `${name} still hardcodes the core id "${id}" — it must import ` +
          `src/security/corePlugins.ts so the two cannot drift`,
      );
    }
  }
  assert.match(
    main.replace(/\/\*[\s\S]*?\*\//g, ""),
    /from "\.\.\/\.\.\/security\/corePlugins"/,
    "main must import the shared list",
  );
  assert.match(
    renderer.replace(/\/\*[\s\S]*?\*\//g, ""),
    /corePluginIdSet/,
    "renderer must import the shared list",
  );
});
