/**
 * The main-process captcha solver client.
 *
 * ## Why main does this and the renderer cannot
 *
 * Three independent reasons, any one of which would be enough:
 *
 *  1. **The credential.** NoneCap requires `Authorization: Bearer …`. The
 *     Network Broker forbids that header from plugins outright, and the DLP
 *     backstop blocks an `api_key`-shaped field in an outbound body. A plugin
 *     cannot reach this service through `ctx.network` and should not try to.
 *  2. **The blast radius.** The key is a paid, rate-limited credential. A
 *     compromised page that could aim it at arbitrary challenges would turn it
 *     into a captcha oracle paid for by the user. Here the host is a constant
 *     and the path set is closed, so the worst case is "some solves the user
 *     already wanted".
 *  3. **The key must not live in the page.** It is stored with `safeStorage`
 *     (OS keychain) and read on demand. No IPC in this file returns it, so the
 *     renderer can only ever learn *whether* one exists.
 *
 * ## Shape
 *
 * Every request below is built from `CAPTCHA_API_HOST` and a path constant.
 * Nothing a caller supplies reaches the URL, the headers, or the timeout. That
 * is the whole reason this module is small enough to read in one sitting.
 */
import {
  CAPTCHA_API_HOST,
  CAPTCHA_IPC,
  CAPTCHA_MAX_RESPONSE_BYTES,
  CAPTCHA_SECRET_NAME,
  maskCaptchaKey,
  parseCaptchaFeedback,
  parseCaptchaKey,
  parseCaptchaSolve,
  readSolveResult,
  type CaptchaFeedbackInput,
  type CaptchaFeedbackResult,
  type CaptchaKeyStatus,
  type CaptchaSolveFailure,
  type CaptchaSolveInput,
  type CaptchaSolveResult,
} from "../../shared/captcha";
import { securityLog } from "./core";
import { isLockdown, isSafeMode } from "./modes";
import { isNetworkLockedDown } from "./networkBroker";
import { deleteSecret, encryptionAvailable, loadSecret, storeSecret } from "./safeStorage";

const API_BASE = `https://${CAPTCHA_API_HOST}/v1`;
const SOLVE_PATH = "/solves";
const FEEDBACK_PATH = "/feedback";
const ACCOUNT_PATH = "/me";

/**
 * How long we let a solve block.
 *
 * The service's own long-poll is capped at 90 s. We ask for 60 and give the
 * socket five more seconds of slack, so the normal case is one round trip that
 * returns a terminal answer, and the rare slow case is a clean timeout in main
 * rather than a hung renderer.
 */
const SOLVE_WAIT_SECONDS = 60;
const SOLVE_TIMEOUT_MS = (SOLVE_WAIT_SECONDS + 5) * 1000;
const QUICK_TIMEOUT_MS = 15_000;

/** Lockdown, Safe Mode and the broker's own kill switch all mean "stop". */
export function captchaLockedDown(): boolean {
  return isNetworkLockedDown() || isLockdown() || isSafeMode();
}

function failure(code: string, message: string, retryable = false): CaptchaSolveFailure {
  return { ok: false, code, message, retryable, solveId: null };
}

/**
 * Read at most `max` bytes of a response body.
 *
 * A duplicate of the broker's bounded reader on purpose: that one streams
 * through an Electron session partition, this one through the main process's own
 * `fetch`, and sharing them would mean importing session machinery (and its
 * readiness constraints) into a module that has no reason to know about it.
 */
async function readBoundedText(response: Response, max: number): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (body === null) {
    const text = await response.text();
    return { text, truncated: false };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return { text: "", truncated: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(merged), truncated: false };
}

type SolverResponse =
  | { status: number; text: string; truncated: boolean }
  | { error: CaptchaSolveFailure };

async function callSolver(
  path: string,
  init: { method: string; body?: unknown; timeoutMs: number },
): Promise<SolverResponse> {
  const key = loadSecret(CAPTCHA_SECRET_NAME);
  if (key === undefined) {
    return { error: failure("not_configured", "No captcha API key is stored.", false) };
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      // No redirect is ever followed. The host is a constant, so a redirect can
      // only be an attempt to move a bearer credential somewhere else, and the
      // check that would have to catch it is exactly the one an attacker
      // controls the answer to.
      redirect: "manual",
      signal: AbortSignal.timeout(init.timeoutMs),
    });
  } catch {
    securityLog().record({
      type: "CAPTCHA_BLOCKED",
      reason: "captcha solver request failed before a response arrived",
      host: CAPTCHA_API_HOST,
    });
    return { error: failure("request_failed", "Could not reach the captcha service.", true) };
  }

  if (response.status >= 300 && response.status < 400) {
    securityLog().record({
      type: "CAPTCHA_BLOCKED",
      reason: `captcha solver tried to redirect (HTTP ${response.status})`,
      host: CAPTCHA_API_HOST,
    });
    return { error: failure("redirect_refused", "The captcha service tried to redirect the request.", false) };
  }

  let read: { text: string; truncated: boolean };
  try {
    read = await readBoundedText(response, CAPTCHA_MAX_RESPONSE_BYTES);
  } catch {
    return { error: failure("request_failed", "The captcha service response could not be read.", true) };
  }
  if (read.truncated) {
    securityLog().record({
      type: "CAPTCHA_BLOCKED",
      reason: "captcha solver response exceeded the size limit",
      host: CAPTCHA_API_HOST,
    });
    return { error: failure("response_too_large", "The captcha service returned an oversized response.", false) };
  }
  return { status: response.status, text: read.text, truncated: false };
}

/**
 * Solve one hCaptcha challenge.
 *
 * Never throws: a caller in the renderer gets a typed result it can log and
 * move on from, because the alternative — a rejected promise from an IPC
 * channel — surfaces to the user as an unexplained failure of the feature
 * they did not touch.
 */
export async function solveCaptcha(rawInput: unknown): Promise<CaptchaSolveResult> {
  let input: CaptchaSolveInput;
  try {
    input = parseCaptchaSolve(rawInput);
  } catch (err) {
    securityLog().record({
      type: "CAPTCHA_BLOCKED",
      reason: `captcha solve refused: ${(err as Error).message.slice(0, 120)}`,
    });
    return failure("invalid_request", (err as Error).message, false);
  }

  if (captchaLockedDown()) {
    securityLog().record({ type: "CAPTCHA_BLOCKED", reason: "captcha solve refused while a security mode is active" });
    return failure("locked_down", "Captcha solving is disabled while a security mode is active.", false);
  }

  // `hcaptcha_enterprise` only when the challenge actually carried rqdata.
  // Sending the enterprise type for a sitekey that is not configured for it
  // wastes a round trip and, on some sitekeys, the credit.
  const response = await callSolver(SOLVE_PATH, {
    method: "POST",
    timeoutMs: SOLVE_TIMEOUT_MS,
    body: {
      type: input.rqdata === undefined ? "hcaptcha" : "hcaptcha_enterprise",
      sitekey: input.sitekey,
      url: input.url,
      ...(input.rqdata === undefined ? {} : { rqdata: input.rqdata }),
    },
  });

  if ("error" in response) return response.error;

  const result = readSolveResult(response.status, response.text);
  if (result.ok) {
    securityLog().record({
      type: "CAPTCHA_SOLVED",
      reason: `captcha solved (credits: ${result.creditsCharged ?? "?"})`,
      host: CAPTCHA_API_HOST,
      method: "POST",
    });
  } else {
    securityLog().record({
      type: "CAPTCHA_BLOCKED",
      reason: `captcha solve returned ${result.code}`,
      host: CAPTCHA_API_HOST,
    });
  }
  return result;
}

/**
 * Tell the service what happened to its token.
 *
 * Reporting refusals is the only signal that distinguishes "we solved it" from
 * "it worked", and it is what makes a proxyless token's real acceptance rate
 * visible instead of guessed at.
 */
export async function reportCaptchaFeedback(rawInput: unknown): Promise<CaptchaFeedbackResult> {
  let input: CaptchaFeedbackInput;
  try {
    input = parseCaptchaFeedback(rawInput);
  } catch (err) {
    return { ok: false, recorded: 0, failed: 0, reason: (err as Error).message };
  }
  if (captchaLockedDown()) {
    return { ok: false, recorded: 0, failed: 0, reason: "disabled" };
  }

  const response = await callSolver(FEEDBACK_PATH, {
    method: "POST",
    timeoutMs: QUICK_TIMEOUT_MS,
    body: {
      feedback: [
        {
          solve_id: input.solveId,
          outcome: input.outcome,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          ...(input.context === undefined ? {} : { context: input.context }),
        },
      ],
    },
  });
  if ("error" in response) return { ok: false, recorded: 0, failed: 0, reason: response.error.code };

  // Two documented shapes: the single-item resource, or a batch envelope when
  // a caller sends many. This client always sends one, but a service upgrade
  // that switches the default would otherwise silently report zero recorded.
  try {
    const body = JSON.parse(response.text) as Record<string, unknown>;
    const recorded = typeof body.recorded === "number"
      ? body.recorded
      : typeof body.object === "string" && typeof body.solve_id === "string"
        ? 1
        : 0;
    const failed = typeof body.failed === "number" ? body.failed : 0;
    return { ok: response.status >= 200 && response.status < 300, recorded, failed };
  } catch {
    return { ok: false, recorded: 0, failed: 0, reason: "unreadable response" };
  }
}

/** Remaining credit, for the settings panel. Read on demand, never polled. */
export async function captchaBalance(): Promise<{ ok: boolean; credits: number | null; reason?: string }> {
  if (captchaLockedDown()) return { ok: false, credits: null, reason: "disabled" };
  const response = await callSolver(ACCOUNT_PATH, { method: "GET", timeoutMs: QUICK_TIMEOUT_MS });
  if ("error" in response) return { ok: false, credits: null, reason: response.error.code };
  try {
    const body = JSON.parse(response.text) as Record<string, unknown>;
    const credits = typeof body.credits_balance === "number" ? body.credits_balance : null;
    return { ok: credits !== null, credits, ...(credits === null ? { reason: "no balance in response" } : {}) };
  } catch {
    return { ok: false, credits: null, reason: "unreadable response" };
  }
}

/** Whether a key is stored. Deliberately returns no key material. */
export function captchaKeyStatus(): CaptchaKeyStatus {
  const key = loadSecret(CAPTCHA_SECRET_NAME);
  return {
    configured: key !== undefined,
    masked: key === undefined ? null : maskCaptchaKey(key),
    encryptionAvailable: encryptionAvailable(),
    lockedDown: captchaLockedDown(),
  };
}

/** Store a key in the OS keychain. Returns false rather than falling back. */
export function saveCaptchaKey(raw: unknown): { ok: boolean; reason?: string } {
  let key: string;
  try {
    key = parseCaptchaKey(raw);
  } catch (err) {
    securityLog().record({ type: "CAPTCHA_BLOCKED", reason: `captcha key rejected: ${(err as Error).message.slice(0, 120)}` });
    return { ok: false, reason: (err as Error).message };
  }
  if (!encryptionAvailable()) {
    // No plaintext fallback. A key written unencrypted "temporarily" is how
    // temporary becomes permanent.
    return { ok: false, reason: "This system has no encrypted key store, so the key was not saved." };
  }
  if (!storeSecret(CAPTCHA_SECRET_NAME, key)) {
    return { ok: false, reason: "The key could not be written to the system key store." };
  }
  securityLog().record({ type: "CAPTCHA_KEY_CHANGED", reason: "captcha API key stored in the OS keychain" });
  return { ok: true };
}

export function clearCaptchaKey(): { cleared: boolean } {
  deleteSecret(CAPTCHA_SECRET_NAME);
  securityLog().record({ type: "CAPTCHA_KEY_CHANGED", reason: "captcha API key removed" });
  return { cleared: true };
}

export { CAPTCHA_IPC };