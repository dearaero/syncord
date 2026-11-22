/**
 * Captcha solver contract tests.
 *
 * `src/shared/captcha.ts` is the one place that knows what a NoneCap API key,
 * a sitekey and a solver response are allowed to look like, and it runs in three
 * realms (main validates it, preload forwards it, the renderer shapes it). These
 * tests are the reason a compromised page cannot talk the main process into
 * solving something else, or into holding a key it should never see.
 *
 * The main-process client itself is covered here too, with `fetch` replaced, so
 * the wire-level guarantees (fixed host, fixed paths, bounded reads) are
 * assertions rather than a comment.
 *
 * Run: `node --test scripts/tests/captcha-solver.test.mjs`
 */
import { mkdtemp } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { build } from "esbuild";
import test from "node:test";

const dir = await mkdtemp(path.join(os.tmpdir(), "syncord-captcha-"));

/**
 * `safeStorage` and the main-process modules import `electron`. The stub gives
 * exactly what they touch: a keychain that works, plus one switch to take it
 * away, so the "refuses to store a secret without a keychain" path is driven
 * through the real module rather than through a hook in production code.
 */
const electronStubPath = path.join(dir, "electron-stub.mjs");
await fs.promises.writeFile(
  electronStubPath,
  `
  let available = true;
  export const __safeStorage = {
    isAvailable: () => available,
    setAvailable: (value) => { available = value; },
  };
  export const safeStorage = {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from("enc:" + value, "utf8"),
    decryptString: (buf) => Buffer.from(buf).toString("utf8").replace(/^enc:/, ""),
  };
  export const app = { getPath: () => ${JSON.stringify(dir)}, isReady: () => true, on() {} };
  export const ipcMain = { handle() {} };
  export const session = {};
  export const shell = {};
  export const BrowserWindow = class {};
  `,
);

const outfile = path.join(dir, "captcha.mjs");
await build({
  stdin: {
    contents: `
      export * from './src/shared/captcha';
      export * as solver from './src/main/security/captchaSolver';
      export { setNetworkLockdown } from './src/main/security/networkBroker';
      export { __safeStorage } from 'electron';
    `,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
  external: ["electron", "node:fs", "node:path"],
  alias: { electron: electronStubPath },
  logLevel: "warning",
});

const C = await import(pathToFileURL(outfile).href);
const solver = C.solver;

// ── API key ───────────────────────────────────────────────────────────────────

test("api key: only a NoneCap live key is accepted", () => {
  const key = `nc_live_${"a".repeat(32)}`;
  assert.equal(C.parseCaptchaKey(key), key);
  assert.equal(C.parseCaptchaKey(`  ${key}  `), key, "a pasted key arrives with whitespace");
});

test("api key: a malformed key is refused rather than stored", () => {
  for (const bad of [
    undefined,
    null,
    "",
    "   ",
    42,
    { key: "x" },
    // A key with the right prefix but the wrong body length.
    `nc_live_${"a".repeat(31)}`,
    `nc_live_${"a".repeat(33)}`,
    // A test-mode prefix is reserved and must not be accepted as a live key.
    `nc_test_${"a".repeat(32)}`,
    // Characters outside base64url.
    `nc_live_${"a".repeat(31)}+`,
    // A Discord token pasted into the wrong field is refused, not silently
    // sent to a third party as a bearer credential.
    "mfa.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  ]) {
    assert.throws(() => C.parseCaptchaKey(bad), `expected ${String(bad)} to be refused`);
  }
});

test("api key: the masked form never reveals the secret", () => {
  const key = `nc_live_${"0123456789abcdefghijklmnopqrstuv".slice(0, 32)}`;
  const masked = C.maskCaptchaKey(key);
  assert.ok(masked.includes("••••"), `expected a masked middle, got ${masked}`);
  assert.ok(masked.endsWith(key.slice(-4)), "the last four characters are how a user recognises their own key");
  assert.ok(!masked.includes(key.slice(8, 20)), "the masked form leaked the middle of the key");
});

// ── Solve request ─────────────────────────────────────────────────────────────

test("solve request: a Discord hCaptcha challenge is accepted", () => {
  const input = C.parseCaptchaSolve({
    sitekey: "4bb5aadb-b50f-4f23-b1c2-92b59ba400d5",
    url: "https://discord.com/quest-home",
    rqdata: "abc123",
  });
  assert.equal(input.sitekey, "4bb5aadb-b50f-4f23-b1c2-92b59ba400d5");
  assert.equal(input.url, "https://discord.com/quest-home");
  assert.equal(input.rqdata, "abc123");
});

test("solve request: rqdata is optional and absent means absent", () => {
  const input = C.parseCaptchaSolve({
    sitekey: "4bb5aadb-b50f-4f23-b1c2-92b59ba400d5",
    url: "https://discord.com/channels/@me",
  });
  assert.equal("rqdata" in input, false);
});

test("solve request: a non-hCaptcha sitekey is refused", () => {
  // reCAPTCHA site keys start with 6L. NoneCap would reject them at the far
  // end, but refusing here means no credit is ever spent discovering it.
  assert.throws(() =>
    C.parseCaptchaSolve({ sitekey: "6Lef5iQTAAAAAKeIvIY", url: "https://discord.com/quest-home" }),
  );
  assert.throws(() =>
    C.parseCaptchaSolve({ sitekey: "not-a-uuid", url: "https://discord.com/quest-home" }),
  );
  assert.throws(() =>
    C.parseCaptchaSolve({ sitekey: "4bb5aadb-b50f-4f23-b1c2-92b59ba400d5" }),
  );
});

test("solve request: the target url must be a Discord page over https", () => {
  const sitekey = "4bb5aadb-b50f-4f23-b1c2-92b59ba400d5";
  for (const url of [
    "http://discord.com/quest-home",
    "https://discord.com.evil.test/quest-home",
    "https://evildiscord.com/quest-home",
    "https://discord.com@evil.test/quest-home",
    "https://evil.test/?next=discord.com",
    "file:///etc/passwd",
    "",
    7,
    null,
  ]) {
    assert.throws(() => C.parseCaptchaSolve({ sitekey, url }), `expected ${String(url)} to be refused`);
  }
});

test("solve request: an oversized rqdata is refused instead of truncated", () => {
  assert.throws(() =>
    C.parseCaptchaSolve({
      sitekey: "4bb5aadb-b50f-4f23-b1c2-92b59ba400d5",
      url: "https://discord.com/quest-home",
      rqdata: "x".repeat(2049),
    }),
  );
});

// ── Feedback ──────────────────────────────────────────────────────────────────

test("feedback: a verdict is accepted only for a solve this client created", () => {
  const input = C.parseCaptchaFeedback({
    solveId: "solve_01HQF7K3JKWZX",
    outcome: "rejected",
    reason: "invalid-response",
  });
  assert.equal(input.outcome, "rejected");

  for (const bad of [
    { solveId: "01HQF7K3JKWZX", outcome: "rejected" },
    { solveId: "solve_01HQF7K3JKWZX", outcome: "exploded" },
    { solveId: "solve_01HQF7K3JKWZX" },
    { outcome: "accepted" },
    { solveId: "solve_01HQF7K3JKWZX", outcome: "accepted", reason: "x".repeat(513) },
  ]) {
    assert.throws(() => C.parseCaptchaFeedback(bad), `expected ${JSON.stringify(bad)} to be refused`);
  }
});

// ── Solver responses ──────────────────────────────────────────────────────────

test("solve response: a solved token is returned with the pairing values", () => {
  const result = C.readSolveResult(
    200,
    JSON.stringify({
      id: "solve_01HQF7K3JKWZX",
      status: "solved",
      token: "P1_eyJ0eXAiOiJKV1QiLCJhbGci",
      resp_key: "E0_eyJ0eXAiOiJKV1QiLCJhbGci",
      user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      credits_charged: 1,
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.token, "P1_eyJ0eXAiOiJKV1QiLCJhbGci");
  assert.equal(result.respKey, "E0_eyJ0eXAiOiJKV1QiLCJhbGci");
  assert.equal(result.solveId, "solve_01HQF7K3JKWZX");
  assert.equal(result.creditsCharged, 1);
});

test("solve response: an unsent token is a failure, not an empty success", () => {
  // A 200 with `status: "solved"` but no token would otherwise hand the caller
  // an empty string and look like a successful solve.
  const result = C.readSolveResult(
    200,
    JSON.stringify({ id: "solve_01HQF7K3JKWZX", status: "solved", token: null }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_response");
});

test("solve response: a still-running solve is retryable and carries its id", () => {
  const result = C.readSolveResult(
    202,
    JSON.stringify({ id: "solve_01HQF7K3JKWZX", status: "pending", token: null }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "pending");
  assert.equal(result.retryable, true);
  assert.equal(result.solveId, "solve_01HQF7K3JKWZX");
});

test("solve response: a terminal solve failure keeps the server's own retry hint", () => {
  const result = C.readSolveResult(
    200,
    JSON.stringify({
      id: "solve_01HQF7K3JKWZX",
      status: "failed",
      error: { code: "challenge_not_loaded", message: "hCaptcha did not serve a challenge.", retryable: true },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "challenge_not_loaded");
  assert.equal(result.retryable, true);
});

test("solve response: an exhausted balance is not retryable", () => {
  const result = C.readSolveResult(
    402,
    JSON.stringify({ error: { code: "insufficient_credits", message: "Top up at dashboard.nonecap.com" } }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "insufficient_credits");
  assert.equal(result.retryable, false);
});

test("solve response: a rejected key is not retryable either", () => {
  const result = C.readSolveResult(401, JSON.stringify({ error: { code: "unauthorized" } }));
  assert.equal(result.ok, false);
  assert.equal(result.code, "unauthorized");
  assert.equal(result.retryable, false);
});

test("solve response: a throttled request is retryable", () => {
  const result = C.readSolveResult(429, JSON.stringify({ error: { code: "rate_limited" } }));
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
});

test("solve response: a hostile body is a failure, never a throw", () => {
  for (const body of ["", "<html>502 Bad Gateway</html>", "null", JSON.stringify({ error: "not-an-object" })]) {
    const result = C.readSolveResult(200, body);
    assert.equal(result.ok, false, `expected ${JSON.stringify(body)} to fail`);
    assert.equal(typeof result.code, "string");
  }
});

test("solve response: an oversized body is refused before it is parsed", () => {
  const result = C.readSolveResult(200, `{"status":"solved","token":"P1_${"a".repeat(200_000)}"}`);
  assert.equal(result.ok, false);
  assert.equal(result.code, "response_too_large");
});

// ── The main-process client ───────────────────────────────────────────────────

/**
 * Replace `fetch` and record every URL it was handed.
 *
 * The stub answers with a real `Response`, not a hand-written lookalike: the
 * client reads `body` as a stream and caps it, and a plain object would have
 * made that path untested while still passing.
 */
function captureFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length - 1);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

const jsonResponse = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

test("client: a solve goes to the fixed NoneCap host and path, with the key only in the request header", async () => {
  solver.clearCaptchaKey();
  assert.equal(solver.saveCaptchaKey(`nc_live_${"b".repeat(32)}`).ok, true);

  const fetchStub = captureFetch(() => jsonResponse(200, { id: "solve_1", status: "solved", token: "P1_abc" }));
  try {
    const result = await solver.solveCaptcha({
      sitekey: "4bb5aadb-b50f-4f23-b1c2-92b59ba400d5",
      url: "https://discord.com/quest-home",
    });
    assert.equal(result.ok, true);
    assert.equal(fetchStub.calls.length, 1);
    const [call] = fetchStub.calls;
    assert.equal(call.url.startsWith("https://api.nonecap.com/v1/solves"), true);
    const headers = call.init.headers;
    assert.equal(headers.Authorization, `Bearer nc_live_${"b".repeat(32)}`);
    const body = JSON.parse(call.init.body);
    assert.equal(body.sitekey, "4bb5aadb-b50f-4f23-b1c2-92b59ba400d5");
    assert.equal(body.type, "hcaptcha");
    // The key must never be in the body: a body is what a log, a proxy or an
    // error report would carry.
    assert.equal(call.init.body.includes("nc_live_"), false);
  } finally {
    fetchStub.restore();
  }
});

test("client: without a stored key nothing is sent at all", async () => {
  solver.clearCaptchaKey();
  const fetchStub = captureFetch(() => jsonResponse(200, {}));
  try {
    const result = await solver.solveCaptcha({
      sitekey: "4bb5aadb-b50f-4f23-b1c2-92b59ba400d5",
      url: "https://discord.com/quest-home",
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "not_configured");
    assert.equal(fetchStub.calls.length, 0);
  } finally {
    fetchStub.restore();
  }
});

test("client: a key is never stored when the OS keychain is unavailable", () => {
  solver.clearCaptchaKey();
  C.__safeStorage.setAvailable(false);
  try {
    assert.equal(solver.saveCaptchaKey(`nc_live_${"c".repeat(32)}`).ok, false);
    assert.equal(solver.captchaKeyStatus().configured, false);
  } finally {
    C.__safeStorage.setAvailable(true);
    solver.clearCaptchaKey();
  }
});

test("client: status never returns the key, only whether one exists", () => {
  solver.clearCaptchaKey();
  const key = `nc_live_${"d".repeat(32)}`;
  assert.equal(solver.saveCaptchaKey(key).ok, true);
  const status = solver.captchaKeyStatus();
  assert.equal(status.configured, true);
  assert.equal(status.masked, C.maskCaptchaKey(key));
  // The prefix is intentionally visible (that is what a masked form *is*); the
  // part that must never leave is the body of the key.
  assert.equal(JSON.stringify(status).includes(key), false);
  assert.equal(JSON.stringify(status).includes(key.slice(8, 28)), false);
  solver.clearCaptchaKey();
});

test("client: a solve is refused while emergency lockdown is armed", async () => {
  solver.clearCaptchaKey();
  assert.equal(solver.saveCaptchaKey(`nc_live_${"e".repeat(32)}`).ok, true);
  C.setNetworkLockdown(true);
  const fetchStub = captureFetch(() => jsonResponse(200, {}));
  try {
    const result = await solver.solveCaptcha({
      sitekey: "4bb5aadb-b50f-4f23-b1c2-92b59ba400d5",
      url: "https://discord.com/quest-home",
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "locked_down");
    assert.equal(fetchStub.calls.length, 0);
  } finally {
    C.setNetworkLockdown(false);
    fetchStub.restore();
    solver.clearCaptchaKey();
  }
});

test("client: a redirect off the fixed host is refused", async () => {
  solver.clearCaptchaKey();
  assert.equal(solver.saveCaptchaKey(`nc_live_${"f".repeat(32)}`).ok, true);
  const fetchStub = captureFetch(() => new Response("", {
    status: 302,
    headers: { location: "https://evil.test/v1/solves" },
  }));
  try {
    const result = await solver.solveCaptcha({
      sitekey: "4bb5aadb-b50f-4f23-b1c2-92b59ba400d5",
      url: "https://discord.com/quest-home",
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "redirect_refused");
  } finally {
    fetchStub.restore();
    solver.clearCaptchaKey();
  }
});

test("client: a transport failure is a failure, not an exception", async () => {
  solver.clearCaptchaKey();
  assert.equal(solver.saveCaptchaKey(`nc_live_${"g".repeat(32)}`).ok, true);
  const fetchStub = captureFetch(() => {
    throw new Error("getaddrinfo ENOTFOUND api.nonecap.com");
  });
  try {
    const result = await solver.solveCaptcha({
      sitekey: "4bb5aadb-b50f-4f23-b1c2-92b59ba400d5",
      url: "https://discord.com/quest-home",
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "request_failed");
    assert.equal(result.retryable, true);
  } finally {
    fetchStub.restore();
    solver.clearCaptchaKey();
  }
});