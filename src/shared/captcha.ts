/**
 * Captcha solving contract — shared by main, preload and renderer.
 *
 * ## Why this exists at all
 *
 * Solving a captcha needs two things the renderer deliberately cannot have:
 *
 *  1. **A credential.** NoneCap authenticates with `Authorization: Bearer …`,
 *     and the Network Broker forbids plugin-supplied `Authorization` headers
 *     (`FORBIDDEN_HEADERS` in `src/security/networkPolicy.ts`) *and* blocks an
 *     `api_key`-shaped field in an outbound body with the DLP backstop. So a
 *     plugin cannot reach the solver through `ctx.network`, and it must not
 *     try. The request is made by the main process, against one fixed host.
 *  2. **A narrow call surface.** Nothing that reaches this file can name a
 *     host, a path, a header or a timeout. The only inputs are a sitekey, the
 *     Discord page the challenge belongs to, and hCaptcha's own `rqdata`.
 *
 * The same reasoning that keeps the Screen Recorder behind a native capability
 * keeps this one there: the plugin gets a function it can call, not a fetch.
 *
 * ## What is deliberately absent
 *
 * No `proxy` field, no `user_agent` override, no batch solve, no "solve
 * anything on this sitekey" mode. Each of those is a feature; each is also a
 * way for a page compromise to turn a paid, credentialed service into a
 * general-purpose captcha oracle.
 */
import { hostnameMatches, parseUrl } from "../security/url";

/** Channels are named here, next to their payloads, the way recording does it. */
export const CAPTCHA_IPC = {
  STATUS: "Syncord_CAPTCHA_STATUS",
  SET_KEY: "Syncord_CAPTCHA_SET_KEY",
  CLEAR_KEY: "Syncord_CAPTCHA_CLEAR_KEY",
  SOLVE: "Syncord_CAPTCHA_SOLVE",
  FEEDBACK: "Syncord_CAPTCHA_FEEDBACK",
} as const;

/** The one host this feature may ever talk to. Not caller-supplied, anywhere. */
export const CAPTCHA_API_HOST = "api.nonecap.com";

/**
 * Page URLs a challenge may belong to.
 *
 * Suffix semantics on purpose: Discord owns the whole `discord.com` domain
 * (`canary.`, `ptb.`, `www.` are all the same organisation serving the same
 * quest page), and the NoneCap solver opens this URL to find the widget's
 * configuration. `discord.com.evil.test` does not match, because the pattern is
 * matched against the parsed hostname rather than the raw string.
 */
export const CAPTCHA_TARGET_HOSTS = ["discord.com", "discordapp.com"] as const;

/** Hard ceiling on a solver response body. Read and refused before parsing. */
export const CAPTCHA_MAX_RESPONSE_BYTES = 64 * 1024;

/** `nc_live_` + 32 base64url characters, per NoneCap's key format. */
const KEY_PATTERN = /^nc_live_[A-Za-z0-9_-]{32}$/;

/** hCaptcha sitekeys are UUIDs. A reCAPTCHA key (`6L…`) is refused here. */
const SITEKEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Solve ids are prefixed ULIDs minted by the solver. */
const SOLVE_ID_PATTERN = /^solve_[A-Za-z0-9]{8,64}$/;

/** hCaptcha's rqdata is an opaque blob; a few hundred bytes is the real range. */
export const CAPTCHA_MAX_RQDATA = 2048;
const MAX_REASON = 512;
const MAX_CONTEXT = 2000;

export type CaptchaSolveInput = {
  sitekey: string;
  /** The Discord page the challenge was served on. */
  url: string;
  /** hCaptcha Enterprise's `rqdata`, when the challenge supplied one. */
  rqdata?: string;
};

export type CaptchaFeedbackInput = {
  solveId: string;
  outcome: "accepted" | "rejected" | "unknown" | "unused" | "error";
  reason?: string;
  context?: string;
};

export type CaptchaSolveSuccess = {
  ok: true;
  /** The `P1_` token to send back as `X-Captcha-Key`. */
  token: string;
  /** hCaptcha's response key (`hcaptcha.getRespKey()`), when the solver read it. */
  respKey: string | null;
  /** The browser version that earned the token; some sites refuse a mismatch. */
  userAgent: string | null;
  solveId: string;
  creditsCharged: number | null;
};

export type CaptchaSolveFailure = {
  ok: false;
  /** Stable machine code. Never a server string, never a file path. */
  code: string;
  /** Safe to show a user: the solver's own message, length-capped. */
  message: string;
  /** Whether submitting the identical request unchanged could succeed. */
  retryable: boolean;
  solveId: string | null;
};

export type CaptchaSolveResult = CaptchaSolveSuccess | CaptchaSolveFailure;

export type CaptchaKeyStatus = {
  configured: boolean;
  /** Enough to recognise a key without revealing it. */
  masked: string | null;
  /** False on a machine with no OS keychain, where we refuse to store one. */
  encryptionAvailable: boolean;
  lockedDown: boolean;
};

export type CaptchaFeedbackResult = {
  ok: boolean;
  recorded: number;
  failed: number;
  reason?: string;
};

/** The preload surface. Five named operations, no generic request. */
export type CaptchaBridge = {
  status(): Promise<CaptchaKeyStatus>;
  /** Store a key in the OS keychain. The value never comes back out. */
  setKey(key: string): Promise<{ ok: boolean; reason?: string }>;
  clearKey(): Promise<{ cleared: boolean }>;
  solve(input: CaptchaSolveInput): Promise<CaptchaSolveResult>;
  feedback(input: CaptchaFeedbackInput): Promise<CaptchaFeedbackResult>;
};

/** Name used in the OS keychain store. Constant, never caller-supplied. */
export const CAPTCHA_SECRET_NAME = "nonecap-api-key";

/**
 * Validate a NoneCap API key.
 *
 * Throws rather than returning a verdict, because every caller wants the same
 * behaviour: refuse to store, refuse to send. A key that does not match is not
 * a key we can spend, and storing it would put an unverified credential in the
 * user's keychain where it would sit until they noticed it was wrong.
 */
export function parseCaptchaKey(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("API key must be text.");
  const key = raw.trim();
  if (!KEY_PATTERN.test(key)) {
    throw new Error("That is not a NoneCap key. Expected nc_live_ followed by 32 characters.");
  }
  return key;
}

/** `nc_live_••••abcd`. Enough to recognise the key, not enough to use it. */
export function maskCaptchaKey(raw: string): string {
  if (typeof raw !== "string" || !KEY_PATTERN.test(raw.trim())) return "••••";
  const key = raw.trim();
  return `${key.slice(0, 8)}••••${key.slice(-4)}`;
}

/**
 * Validate one solve request.
 *
 * The URL is checked against Discord's own domains rather than merely being
 * "some https URL", because that string is handed to a third party which will
 * open it. A compromised page could otherwise point the solver at anything —
 * an SSRF from our own API key, at our expense.
 */
export function parseCaptchaSolve(raw: unknown): CaptchaSolveInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("A captcha request must be an object.");
  }
  const input = raw as Record<string, unknown>;

  if (typeof input.sitekey !== "string" || !SITEKEY_PATTERN.test(input.sitekey)) {
    throw new Error("That is not an hCaptcha sitekey.");
  }
  const sitekey = input.sitekey.toLowerCase();

  const url = typeof input.url === "string" ? parseUrl(input.url) : null;
  if (url === null || url.protocol !== "https:" || url.hasCredentials) {
    throw new Error("The challenge page must be a Discord https URL.");
  }
  if (!CAPTCHA_TARGET_HOSTS.some((host) => hostnameMatches(url.hostname, host))) {
    throw new Error("The challenge page must be a Discord https URL.");
  }

  let rqdata: string | undefined;
  if (input.rqdata !== undefined && input.rqdata !== null && input.rqdata !== "") {
    if (typeof input.rqdata !== "string") throw new Error("rqdata must be text.");
    if (input.rqdata.length > CAPTCHA_MAX_RQDATA) throw new Error("rqdata is too large.");
    rqdata = input.rqdata;
  }

  return rqdata === undefined ? { sitekey, url: url.href } : { sitekey, url: url.href, rqdata };
}

/** Validate a verdict about a solve this client created. */
export function parseCaptchaFeedback(raw: unknown): CaptchaFeedbackInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Captcha feedback must be an object.");
  }
  const input = raw as Record<string, unknown>;
  if (typeof input.solveId !== "string" || !SOLVE_ID_PATTERN.test(input.solveId)) {
    throw new Error("Unknown solve id.");
  }
  const outcomes = ["accepted", "rejected", "unknown", "unused", "error"];
  if (typeof input.outcome !== "string" || !outcomes.includes(input.outcome)) {
    throw new Error("Unknown captcha outcome.");
  }
  const text = (value: unknown, max: number, label: string): string | undefined => {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string") throw new Error(`${label} must be text.`);
    if (value.length > max) throw new Error(`${label} is too long.`);
    return value;
  };
  const reason = text(input.reason, MAX_REASON, "reason");
  const context = text(input.context, MAX_CONTEXT, "context");
  return {
    solveId: input.solveId,
    outcome: input.outcome as CaptchaFeedbackInput["outcome"],
    ...(reason === undefined ? {} : { reason }),
    ...(context === undefined ? {} : { context }),
  };
}

/**
 * Solver error codes worth trying again.
 *
 * Everything else — an unknown key, an empty balance, a validation failure —
 * would fail identically on a second attempt, and retrying them spends the
 * user's time and our rate-limit budget to learn nothing.
 */
const RETRYABLE_CODES = new Set([
  "rate_limited",
  "sitekey_rate_limited",
  "concurrency_limit_exceeded",
  "maintenance",
  "internal_error",
  "service_unavailable",
  "request_failed",
  "pending",
]);

const TERMINAL_SOLVE_STATES = new Set(["failed", "cancelled", "expired"]);
const RUNNING_SOLVE_STATES = new Set(["pending", "solving"]);

const failure = (
  code: string,
  message: string,
  retryable: boolean,
  solveId: string | null = null,
): CaptchaSolveFailure => ({ ok: false, code, message, retryable, solveId });

/**
 * Read a solver response.
 *
 * Two rules matter more than the rest:
 *
 *  - **A body is never trusted to be the shape it claims.** Anything that is
 *    not a solved token is a failure with a stable code. A `200` carrying
 *    `status: "solved"` and a null token used to be the dangerous case: it is
 *    a success by every field a caller would check, with nothing to send.
 *  - **The size is checked before the parse.** A hostile (or merely broken)
 *    endpoint must not be able to make the main process build a megabyte-wide
 *    string to find out it is not JSON.
 */
export function readSolveResult(status: number, text: unknown): CaptchaSolveResult {
  if (typeof text !== "string" || text.length === 0) {
    return failure("invalid_response", "The captcha service returned no usable response.", false);
  }
  if (text.length > CAPTCHA_MAX_RESPONSE_BYTES) {
    return failure("response_too_large", "The captcha service returned an oversized response.", false);
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return failure("invalid_response", "The captcha service returned an unreadable response.", false);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return failure("invalid_response", "The captcha service returned an unreadable response.", false);
  }

  const raw = body as Record<string, unknown>;
  const solveId = typeof raw.id === "string" && SOLVE_ID_PATTERN.test(raw.id) ? raw.id : null;
  const envelope = raw.error && typeof raw.error === "object" && !Array.isArray(raw.error)
    ? (raw.error as Record<string, unknown>)
    : undefined;
  const code = typeof envelope?.code === "string" ? envelope.code : "";
  const message = typeof envelope?.message === "string" ? envelope.message.slice(0, 300) : "";
  const state = typeof raw.status === "string" ? raw.status : "";
  const explicitRetryable = typeof envelope?.retryable === "boolean" ? envelope.retryable : undefined;

  // Request-level refusal (401/402/403/422/429/5xx). Checked before the solve
  // states because a request that never started has nothing to poll.
  if (envelope !== undefined && !RUNNING_SOLVE_STATES.has(state) && state !== "solved") {
    const retryable = explicitRetryable ?? (RETRYABLE_CODES.has(code) || status === 429 || status >= 500);
    return failure(
      code === "" ? `http_${status}` : code,
      message === "" ? `The captcha service refused the request (HTTP ${status}).` : message,
      retryable,
      solveId,
    );
  }

  if (RUNNING_SOLVE_STATES.has(state)) {
    return failure("pending", "The captcha service is still working on it.", true, solveId);
  }

  if (state === "solved") {
    if (typeof raw.token !== "string" || !raw.token.startsWith("P1_") || raw.token.length > 4096) {
      return failure("invalid_response", "The captcha service reported a solve with no usable token.", false, solveId);
    }
    const credits = typeof raw.credits_charged === "number" && Number.isFinite(raw.credits_charged)
      ? raw.credits_charged
      : null;
    return {
      ok: true,
      token: raw.token,
      respKey: typeof raw.resp_key === "string" ? raw.resp_key : null,
      userAgent: typeof raw.user_agent === "string" ? raw.user_agent : null,
      solveId: solveId ?? "",
      creditsCharged: credits,
    };
  }

  if (TERMINAL_SOLVE_STATES.has(state)) {
    // The solver knows better than we do whether a repeat can succeed, so its
    // own `retryable` is preferred over our guess from the state name.
    const retryable = explicitRetryable ?? state === "expired";
    return failure(
      code === "" ? state : code,
      message === "" ? `The captcha service could not solve it (${state}).` : message,
      retryable,
      solveId,
    );
  }

  return failure("invalid_response", "The captcha service returned an unknown response.", false, solveId);
}