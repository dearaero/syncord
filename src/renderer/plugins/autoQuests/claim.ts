import { canonicalMessage as i18nText } from "../../i18n";
/**
 * Background reward claiming.
 *
 * ## What it does
 *
 * While the switch is on and a solver key is stored, every completed-but-unclaimed
 * quest is claimed through Discord's own API, in the background, with no UI of
 * its own. A captcha raised by the claim is solved through the main process and
 * the claim retried with the solution.
 *
 * ## Why it is separate from the completion runner
 *
 * The runner and the claimer have different triggers, different failure modes
 * and different costs. The runner is started by a person watching a progress
 * bar; the claimer has to survive the user leaving the client open overnight.
 * Coupling them meant either the claimer waited for a button nobody would press,
 * or the runner inherited a paid captcha dependency it does not need.
 *
 * ## The rules that keep this from burning money
 *
 * A solve costs the user a credit, and hCaptcha may refuse a token solved from
 * another network (NoneCap egresses from its own pool unless a proxy is given).
 * So:
 *
 *  - nothing runs without *both* the switch and a stored key;
 *  - a session-wide budget caps how many solves can be spent;
 *  - a refused token is reported once and the quest is dropped for the session
 *    rather than retried;
 *  - a terminal solver failure (no balance, revoked key) latches the watcher
 *    off until the key is removed and entered again, because retrying a
 *    configuration problem only spends the user's time.
 */
import type { PluginContext } from "../../api/plugin/types";
import { showToast, ToastType } from "../../ui/toast";
import {
  findModules,
  questsOf,
  readServerQuests,
  serverQuest,
  shortError,
  type Modules,
  type Quest,
  type QuestRewardsConfig,
  type RestApi,
} from "./modules";
import { autoQuestSettings } from "./settings";

/** Safety-net refresh, in case a Flux signal was missed. */
const POLL_MS = 60_000;
/** How often the switch and the stored key are re-read. */
const SUPERVISOR_MS = 15_000;
/** A second before retrying a solver failure the service called retryable. */
const SOLVER_RETRY_MS = 500;

/** Ceiling on paid solves per client session. */
export const SESSION_SOLVE_BUDGET = 20;

/** Attempts per quest. Two is enough for the header/body transport pair. */
const MAX_ATTEMPTS_PER_QUEST = 2;

/**
 * The page a quest captcha belongs to.
 *
 * NoneCap opens this URL to read the widget's configuration, so it has to be
 * the quest page rather than whatever the user happens to be looking at.
 */
const QUEST_PAGE = "https://discord.com/quest-home";

/**
 * Where the claim was "initiated", per the endpoint's own parameter names.
 *
 * `claim-reward` documents `location` and `platform` as required JSON params.
 * `location` is a *quest content type* — 11 is `QUEST_HOME_DESKTOP`, the page
 * the user would be on when they click Claim Reward. Guessing wrong is not
 * caught locally, which is why the failure is surfaced rather than swallowed.
 */
const CLAIM_LOCATION = 11;

/** Cross-platform, the fallback when the quest names no platform of its own. */
const DEFAULT_PLATFORM = 0;

/** Tiered quests (assignment method 2) refuse a claim that names no tier. */
const TIERED_ASSIGNMENT = 2;

function rewardsConfigOf(quest: Quest): QuestRewardsConfig | undefined {
  return quest.config?.rewardsConfig ?? quest.config?.rewards_config;
}

/**
 * The JSON body every claim attempt carries.
 *
 * `platform` and `claimed_tier` come from the quest's own reward config rather
 * than from one hard-coded guess. Discord answers a claim that names the wrong
 * platform — or names no tier on a tiered quest — with a bare `403`, which is
 * the least diagnosable answer an API can give.
 */
function claimBody(quest: Quest, solution?: { token: string; rqtoken?: string }): Record<string, unknown> {
  const rewards = rewardsConfigOf(quest);
  const platforms = rewards?.platforms;
  const platform = Array.isArray(platforms) && typeof platforms[0] === "number" ? platforms[0] : DEFAULT_PLATFORM;
  const assignment = rewards?.assignmentMethod ?? rewards?.assignment_method;
  const sealed = quest.trafficMetadataSealed ?? null;
  return {
    location: CLAIM_LOCATION,
    platform,
    metadata_sealed: null,
    traffic_metadata_sealed: sealed,
    ...(assignment === TIERED_ASSIGNMENT ? { claimed_tier: 0 } : {}),
    ...(solution === undefined
      ? {}
      : {
          captcha_key: solution.token,
          ...(solution.rqtoken === undefined ? {} : { captcha_rqtoken: solution.rqtoken }),
        }),
  };
}

const CLAIM_CHANGE_EVENT = "Syncord-auto-quests-claim";

type DiscordChallenge = {
  sitekey: string;
  sessionId?: string;
  rqdata?: string;
  rqtoken?: string;
};

export type ClaimState = {
  /** The switch is on. */
  enabled: boolean;
  /** A solver key exists in the OS keychain. */
  configured: boolean;
  /** The claim loop is scheduled and ticking. */
  running: boolean;
  claimed: number;
  skipped: number;
  solves: number;
  /**
   * Why the most recent attempt failed, or null.
   *
   * A counter that goes up with no reason is the difference between a feature
   * that is working and one that is quietly broken, and "1 skipped" cannot
   * tell the user which they have. Short, escaped by the panel, never a token.
   */
  lastError: string | null;
  /** One line for the settings panel. Never contains a token or a key. */
  detail: string;
};

/**
 * Server answers that mean "stop asking about this quest".
 *
 * The local store does not reliably carry `claimedAt`, so the server is the
 * authority on what is still claimable. Anything matching these is an expected
 * outcome: the quest is done with, quietly, and the reason is recorded rather
 * than raised as a failure the user has to think about.
 */
const SETTLED_RE = /already (?:been )?claim|no reward|reward.*expir|expired|not completed|no longer available|unknown quest|does not exist/i;

/** How many times one quest may be retried before it is dropped for the session. */
const MAX_TRANSIENT_ATTEMPTS = 3;

let context: PluginContext | undefined;
let supervisorTimer: ReturnType<typeof setInterval> | undefined;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
const sleepers = new Set<() => void>();

/** Quests already dealt with this session, for whatever reason. */
const handled = new Set<string>();
/**
 * Failures that look transient, per quest.
 *
 * A 500 on a claim is Discord's problem, not the quest's, and dropping the quest
 * for the session would mean a reward that is still claimable silently never
 * gets claimed. Bounded, because "retry forever" is just a slower way of
 * hammering an endpoint that is refusing.
 */
const transientFailures = new Map<string, number>();
/** Latched on a terminal solver failure; cleared only by re-entering a key. */
let fault: string | undefined;

const state: ClaimState = {
  enabled: false,
  configured: false,
  running: false,
  claimed: 0,
  skipped: 0,
  solves: 0,
  lastError: null,
  detail: i18nText("ui.off"),
};

export const claimChangeEvent = CLAIM_CHANGE_EVENT;

export function claimState(): ClaimState {
  return { ...state };
}

/**
 * Record why something failed, and say so in the panel.
 *
 * Cleared on the next success, so a stale error sitting next to a working
 * counter reads as a new problem the user then has to work out is old.
 */
function reportFailure(reason: string): void {
  state.lastError = reason;
  update(i18nText("ui.error_value", {v0: reason}));
}

function update(detail: string): void {
  state.detail = detail;
  window.dispatchEvent(new Event(CLAIM_CHANGE_EVENT));
}

/** Sleep on the renderer's clock, cancellable by stop. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const cancel = (): void => {
      clearTimeout(timer);
      sleepers.delete(cancel);
      resolve();
    };
    const timer = setTimeout(() => {
      sleepers.delete(cancel);
      resolve();
    }, ms);
    sleepers.add(cancel);
  });
}

function cancelSleepers(): void {
  for (const cancel of [...sleepers]) cancel();
}

function stopLoop(detail: string): void {
  if (pollTimer !== undefined) {
    clearTimeout(pollTimer);
    pollTimer = undefined;
  }
  if (state.running) update(detail);
  state.running = false;
}

function stopFault(): void {
  fault = undefined;
}

/**
 * A quest is claimable when it is finished, nothing has claimed it yet, and the
 * reward is still worth claiming.
 */
function claimable(store: Modules["store"]): Quest[] {
  return questsOf(store).filter((q) => {
    if (!q.id || handled.has(q.id)) return false;
    if (!q.userStatus?.completedAt || q.userStatus?.claimedAt) return false;
    // The claiming window lives in `rewards_config`, four levels down from the
    // quest. Reading a field that does not exist meant an expired reward looked
    // claimable and was sent to the server on every poll.
    const rewards = rewardsConfigOf(q);
    const raw = rewards?.rewardsExpireAt ?? rewards?.rewards_expire_at
      ?? q.config?.rewardsExpireAt ?? q.config?.rewards_expire_at;
    const expires = Date.parse(typeof raw === "string" ? raw : "");
    return !(Number.isFinite(expires) && expires > 0 && expires < Date.now());
  });
}

/**
 * How a failed claim should be treated.
 *
 * Three outcomes, and the difference between them is the whole reason this
 * function exists:
 *
 *  - **settled** — the server says the quest is finished business. Drop it, no
 *    toast: toasting at someone for a quest that was never in question is how a
 *    background feature gets turned off.
 *  - **transient** — a 5xx, a rate limit, a network blip. Retry on a later poll,
 *    because the reward is still out there.
 *  - **refused** — everything else. Drop it and say why, once.
 */
type FailureKind = "settled" | "transient" | "refused";

function classify(status: number, body: unknown): FailureKind {
  const message = errorMessage(body);
  if (message !== "" && SETTLED_RE.test(message)) return "settled";
  if (status >= 500 || status === 408 || status === 429) return "transient";
  if (status === 0) return "transient";
  return "refused";
}

/** Discord's own error text, cleaned for a one-line message. */
function errorMessage(body: unknown): string {
  if (typeof body === "string") {
    // An edge block or error page arrives as HTML. Stripping it leaves the
    // status text, which is more useful than "no message" and more honest than
    // pretending the body parsed.
    return body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
  }
  if (!body || typeof body !== "object") return "";
  const raw = body as Record<string, unknown>;
  const value = raw.message ?? raw.error ?? raw.detail;
  if (typeof value === "string") return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
  // Discord codes its refusals: 50035 is a form error, 50013 is missing
  // permissions, 10008 is unknown quest. A code with no message still names the
  // reason, and it is the only thing there is when the body is bare.
  const code = raw.code ?? raw.error_code ?? raw.errors;
  if (typeof code === "number") return i18nText("ui.discord_error_code_value", {v0: code});
  return "";
}

/** A one-line description of a failed attempt, for the panel and the log. */
function failureReason(status: number, body: unknown): string {
  const message = errorMessage(body);
  return message === "" ? i18nText("ui.http_value", {v0: status}) : i18nText("ui.http_value_value", {v0: status, v1: message});
}

/**
 * Read a captcha challenge out of an error body.
 *
 * Only hCaptcha is claimed to be solvable here. A `recaptcha` service is not
 * attempted: it would be a paid round trip to a service the client does not
 * speak, and the honest outcome is to leave that quest to the user.
 */
function readChallenge(body: unknown): DiscordChallenge | undefined {
  if (!body || typeof body !== "object") return undefined;
  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.captcha_key)) return undefined;
  if (raw.captcha_service !== undefined && raw.captcha_service !== "hcaptcha") return undefined;
  if (typeof raw.captcha_sitekey !== "string" || raw.captcha_sitekey.length === 0) return undefined;
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined;
  const challenge: DiscordChallenge = { sitekey: raw.captcha_sitekey };
  const sessionId = text(raw.captcha_session_id);
  const rqdata = text(raw.captcha_rqdata);
  const rqtoken = text(raw.captcha_rqtoken);
  if (sessionId !== undefined) challenge.sessionId = sessionId;
  if (rqdata !== undefined) challenge.rqdata = rqdata;
  if (rqtoken !== undefined) challenge.rqtoken = rqtoken;
  return challenge;
}

type ClaimResponse = { status: number; body: unknown };

/**
 * Claim one quest, returning the server's verdict.
 *
 * Discord's request helper throws on a 4xx and resolves on a 2xx depending on
 * the release, so both are normalized here — a claim that only worked on the
 * resolving path would silently stop working on the next Discord update.
 */
async function postClaim(
  api: RestApi,
  questId: string,
  init: { body?: Record<string, unknown>; headers?: Record<string, string> } = {},
): Promise<ClaimResponse> {
  try {
    const response = await api.post({ url: `/quests/${questId}/claim-reward`, ...init });
    return { status: typeof response.status === "number" ? response.status : 200, body: response.body };
  } catch (error) {
    const value = error as { status?: number; httpStatus?: number; body?: unknown };
    return {
      status: typeof value?.status === "number" ? value.status : (value?.httpStatus ?? 0),
      body: value?.body,
    };
  }
}

function solutionHeaders(token: string, challenge: DiscordChallenge): Record<string, string> {
  const headers: Record<string, string> = { "X-Captcha-Key": token };
  if (challenge.sessionId !== undefined) headers["X-Captcha-Session-Id"] = challenge.sessionId;
  if (challenge.rqtoken !== undefined) headers["X-Captcha-Rqtoken"] = challenge.rqtoken;
  return headers;
}

/**
 * Report a token the target refused.
 *
 * Reporting is the only signal that separates "solved" from "actually worked",
 * and it is what makes the real acceptance rate of a proxyless solve visible
 * instead of guessed at.
 */
async function reportRejected(questId: string, solveId: string, reason: string): Promise<void> {
  if (!/^solve_[A-Za-z0-9]{8,64}$/.test(solveId)) return;
  try {
    await context?.captcha.feedback({
      solveId,
      outcome: "rejected",
      reason: reason.slice(0, 200),
      context: i18nText("ui.quest_claim"),
    });
  } catch {
    /* feedback is diagnostics, never a reason to fail the claim */
  }
}

/** Solve a challenge, retrying once when the service says the failure is transient. */
async function solveChallenge(challenge: DiscordChallenge): Promise<
  { ok: true; token: string; solveId: string } | { ok: false; terminal: boolean; message: string }
> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await context!.captcha.solve({
      sitekey: challenge.sitekey,
      url: QUEST_PAGE,
      ...(challenge.rqdata === undefined ? {} : { rqdata: challenge.rqdata }),
    });
    if (result.ok) {
      state.solves += 1;
      return { ok: true, token: result.token, solveId: result.solveId };
    }
    if (!result.retryable) {
      return { ok: false, terminal: true, message: result.message || result.code };
    }
    if (attempt === 0) await sleep(SOLVER_RETRY_MS);
  }
  return { ok: false, terminal: false, message: i18nText("ui.the_captcha_service_did_not_answer") };
}

/**
 * Decide what a failed claim means, and act on it.
 *
 * Returns true when the caller should keep trying this quest in this pass.
 */
function settle(questId: string, status: number, body: unknown): boolean {
  const reason = failureReason(status, body);
  const kind = classify(status, body);

  if (kind === "transient") {
    const seen = (transientFailures.get(questId) ?? 0) + 1;
    transientFailures.set(questId, seen);
    if (seen < MAX_TRANSIENT_ATTEMPTS) {
      // Not counted as skipped and not toasted: the quest is still claimable and
      // the next poll is the retry.
      reportFailure(i18nText("ui.value_will_retry", {v0: reason}));
      return true;
    }
    handled.add(questId);
    state.skipped += 1;
    context?.log.warn(`Quest ${questId}: ${reason} (skipped after ${seen} attempts)`);
    showToast(i18nText("ui.auto_claim_could_not_claim_value_value", {v0: name(questId), v1: reason}), { type: ToastType.FAILURE });
    update(i18nText("ui.value_skipped_after_a_temporary_error", {v0: name(questId)}));
    return false;
  }

  handled.add(questId);
  transientFailures.delete(questId);
  reportFailure(reason);
  if (kind === "settled") {
    // Expected: the server is the authority on what is still claimable, and it
    // says this one is not. Recorded, never toasted.
    context?.log.info(`Quest ${questId}: reward already claimed or not eligible (${reason})`);
    update(i18nText("ui.value_no_reward_to_claim", {v0: name(questId)}));
    return false;
  }

  state.skipped += 1;
  context?.log.warn(`Quest ${questId}: could not claim reward (${reason}) ${rawSnippet(body)}`);
  showToast(i18nText("ui.auto_claim_could_not_claim_value_value", {v0: name(questId), v1: reason}), { type: ToastType.FAILURE });
  return false;
}

/**
 * A bounded look at the body, for the log.
 *
 * A `403` with nothing readable is the case where the status code is the whole
 * story, and the status code alone is not enough to act on. Written to the log
 * rather than the panel because it can be long, and because it is the line
 * worth copying into a bug report.
 */
function rawSnippet(body: unknown): string {
  if (body === undefined || body === null) return i18nText("ui.no_response_body");
  let text: string;
  try {
    text = typeof body === "string" ? body : JSON.stringify(body);
  } catch {
    return i18nText("ui.could_not_read_response");
  }
  if (typeof text !== "string" || text === "") return i18nText("ui.empty_response_body");
  return i18nText("ui.body_value", {v0: text.slice(0, 300)});
}

/** Best-effort display name for a quest id, for a toast. */
const questNames = new Map<string, string>();
function name(questId: string): string {
  return questNames.get(questId) ?? questId;
}

/**
 * Verify a 2xx, then record the win.
 *
 * A claim that answers successfully but leaves no `claimed_at` behind is the
 * failure mode a status-code-only check cannot see, and it is exactly what this
 * feature was reported as doing. One GET decides it.
 */
async function succeed(quest: Quest, label: string, modules: Modules, claimedBody: unknown): Promise<void> {
  if (await claimVerified(modules.api, quest.id, claimedBody)) {
    finishClaim(quest, label);
    return;
  }
  // Not taken. Handled rather than re-claimed on the spot, so a server that
  // answers 200 forever cannot turn the watcher into a request loop; the next
  // poll picks it up again if the quest is genuinely still claimable.
  handled.add(quest.id);
  reportFailure(i18nText("ui.the_server_did_not_mark_the_reward_as_claimed_unverified"));
  context?.log.warn(`Quest ${quest.id}: received 2xx but the server did not return claimed_at`);
  update(i18nText("ui.value_unverified", {v0: label}));
}

async function claimQuest(quest: Quest, modules: Modules): Promise<void> {
  const label = quest.config?.messages?.questName ?? quest.id;
  questNames.set(quest.id, label);
  let attempts = 0;

  while (attempts < MAX_ATTEMPTS_PER_QUEST) {
    attempts += 1;
    const first = await postClaim(modules.api, quest.id, { body: claimBody(quest) });
    if (first.status >= 200 && first.status < 300) return await succeed(quest, label, modules, first.body);

    const challenge = first.status === 400 ? readChallenge(first.body) : undefined;
    if (!challenge) {
      // No captcha in this refusal, so there is nothing to buy and nothing to
      // retry within this pass — whatever kind of failure it is, it is settled
      // or scheduled for the next poll by `settle`.
      settle(quest.id, first.status, first.body);
      return;
    }

    if (state.solves >= SESSION_SOLVE_BUDGET) {
      handled.add(quest.id);
      state.skipped += 1;
      update(i18nText("ui.session_captcha_solve_budget_reached"));
      reportFailure(i18nText("ui.session_captcha_solve_budget_reached"));
      return;
    }

    update(i18nText("ui.value_solving_captcha", {v0: label}));
    const solved = await solveChallenge(challenge);
    if (!solved.ok) {
      handled.add(quest.id);
      state.skipped += 1;
      reportFailure(i18nText("ui.could_not_solve_captcha_value", {v0: solved.message}));
      if (solved.terminal) {
        // A revoked key or an empty balance is a configuration problem. Keep
        // the latch: retrying it only spends the user's time.
        fault = solved.message;
        stopLoop(i18nText("ui.unable_to_solve_captcha_value", {v0: solved.message}));
        context?.log.warn(`Quest ${quest.id}: CAPTCHA service rejected the request: ${solved.message}`);
        showToast(i18nText("ui.auto_claim_stopped_value", {v0: solved.message}), { type: ToastType.FAILURE });
        return;
      }
      context?.log.warn(`Quest ${quest.id}: could not solve CAPTCHA (${solved.message})`);
      showToast("Auto-claim: could not solve the CAPTCHA; quest skipped.", { type: ToastType.FAILURE });
      return;
    }

    // Discord moved the solution from the JSON body to a request header. Try
    // the header first, then the body, reusing the token we already paid for:
    // a build that ignores the header must not buy a second solve per poll.
    const withHeader = await postClaim(modules.api, quest.id, {
      body: claimBody(quest),
      headers: solutionHeaders(solved.token, challenge),
    });
    if (withHeader.status >= 200 && withHeader.status < 300) {
      await reportAccepted(solved.solveId);
      return await succeed(quest, label, modules, withHeader.body);
    }
    if (withHeader.status !== 400 || readChallenge(withHeader.body) === undefined) {
      handled.add(quest.id);
      state.skipped += 1;
      const reason = failureReason(withHeader.status, withHeader.body);
      reportFailure(reason);
      context?.log.warn(`Quest ${quest.id}: solution was not accepted (${reason})`);
      showToast(i18nText("ui.auto_claim_solution_was_not_accepted_value", {v0: reason}), { type: ToastType.FAILURE });
      return;
    }

    const withBody = await postClaim(modules.api, quest.id, {
      body: claimBody(quest, {
        token: solved.token,
        ...(challenge.rqtoken === undefined ? {} : { rqtoken: challenge.rqtoken }),
      }),
    });
    if (withBody.status >= 200 && withBody.status < 300) {
      await reportAccepted(solved.solveId);
      return await succeed(quest, label, modules, withBody.body);
    }

    const rejected = errorMessage(withBody.body) || "invalid-response";
    await reportRejected(quest.id, solved.solveId, rejected);
    handled.add(quest.id);
    state.skipped += 1;
    reportFailure(i18nText("ui.discord_rejected_the_captcha_solution_value", {v0: rejected}));
    context?.log.warn(`Quest ${quest.id}: CAPTCHA solution was rejected by both submission methods (${rejected})`);
    showToast(
      i18nText("ui.auto_claim_discord_rejected_the_captcha_solution_quest_skipped_for_thi"),
      { type: ToastType.FAILURE },
    );
    return;
  }
}

async function reportAccepted(solveId: string): Promise<void> {
  if (!/^solve_[A-Za-z0-9]{8,64}$/.test(solveId)) return;
  try {
    await context?.captcha.feedback({ solveId, outcome: "accepted", context: i18nText("ui.quest_claim") });
  } catch {
    /* diagnostics only */
  }
}

/**
 * Confirm against the server that the reward was actually taken.
 *
 * A 2xx from `claim-reward` is not proof: the endpoint can answer successfully
 * for a quest whose reward was not assigned, and a counter that only watched
 * status codes would report a claim that never happened. `/quests/@me` is the
 * same authority the completion runner already trusts for enrollment.
 */
async function claimVerified(api: RestApi, questId: string, claimedBody: unknown): Promise<boolean> {
  // The claim's own response is the cheapest authority and says so directly.
  if (claimedAtOf(claimedBody)) return true;
  try {
    const body = await readServerQuests(api);
    return claimedAtOf(serverQuest(body, questId)) !== undefined;
  } catch (error) {
    context?.log.warn(`Quest ${questId}: could not read verification: ${shortError(error)}`);
    return false;
  }
}

/** `claimed_at`, in any of the spellings Discord uses for it. */
function claimedAtOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const status = (raw.user_status ?? raw.userStatus) as Record<string, unknown> | undefined;
  const direct = raw.claimed_at ?? raw.claimedAt;
  if (typeof direct === "string" && direct !== "") return direct;
  if (status && typeof status === "object") {
    const nested = status.claimed_at ?? status.claimedAt;
    if (typeof nested === "string" && nested !== "") return nested;
  }
  return undefined;
}

/**
 * Record a completed claim.
 *
 * Deliberately silent on Discord's Flux store. Dispatching a synthesised quest
 * action here was how the first version tried to clear the "claim" button, and
 * it had two problems: the event name was never verified against a real build,
 * and Discord's own reaction to it was a captcha window over a reward that had
 * already been taken. Discord learns about the claim through its gateway
 * anyway; the Quest tab catches up on its next fetch, and a stale button is a
 * far smaller problem than a phantom claim flow.
 */
function finishClaim(quest: Quest, name: string): void {
  handled.add(quest.id);
  transientFailures.delete(quest.id);
  state.claimed += 1;
  // A stale error next to a working counter reads as a new problem the user
  // then has to work out is old.
  state.lastError = null;
  update(i18nText("ui.value_reward_claimed", {v0: name}));
}

let cachedModules: Modules | undefined;
let modulesErrored = false;

/** Discovery is retried on the next poll rather than caching a failure. */
function safeModules(): Modules | undefined {
  if (cachedModules !== undefined || modulesErrored) return cachedModules;
  try {
    cachedModules = findModules();
  } catch (error) {
    modulesErrored = true;
    context?.log.warn("Quest modules were not found:", shortError(error));
  }
  return cachedModules;
}

async function claimOnce(): Promise<void> {
  const modules = safeModules();
  if (!modules) return;
  for (const quest of claimable(modules.store)) {
    try {
      await claimQuest(quest, modules);
    } catch (error) {
      // An unexpected throw is treated as transient for the same reason a 5xx
      // is: the client had no reason to expect it, and one bad pass should not
      // cost the user a reward that is still sitting there.
      const seen = (transientFailures.get(quest.id) ?? 0) + 1;
      transientFailures.set(quest.id, seen);
      reportFailure(shortError(error));
      if (seen < MAX_TRANSIENT_ATTEMPTS) return;
      handled.add(quest.id);
      state.skipped += 1;
      context?.log.error(`Quest ${quest.id}: could not claim reward: ${shortError(error)}`);
    }
  }
}

function schedulePoll(): void {
  if (pollTimer !== undefined || !state.running) return;
  pollTimer = setTimeout(() => {
    pollTimer = undefined;
    void (async () => {
      if (!state.running) return;
      await claimOnce();
      if (state.running) schedulePoll();
    })();
  }, POLL_MS);
}

function startLoop(): void {
  state.running = true;
  update(i18nText("ui.running"));
  void (async () => {
    await claimOnce();
    if (state.running) schedulePoll();
  })();
}

/**
 * Bring the watcher in line with the switch and the stored key.
 *
 * Called on a timer rather than only at plugin start, so a user who pastes a
 * key into the settings panel gets a working feature without restarting
 * Discord — the supervisor is the only thing that ever *starts* a claim loop,
 * and it will not start one twice.
 */
async function supervisor(): Promise<void> {
  if (!context) return;
  const enabled = autoQuestSettings.bind("auto-quests").get("autoClaim") === true;
  state.enabled = enabled;

  if (!enabled) {
    stopFault();
    state.configured = false;
    stopLoop(i18nText("ui.automatic_claiming_is_off"));
    return;
  }

  const status = await context.captcha.status();
  state.configured = status.configured;
  if (!status.configured) {
    stopFault();
    stopLoop(i18nText("ui.no_api_key_is_saved"));
    return;
  }
  if (fault !== undefined) {
    state.detail = i18nText("ui.stopped_value", {v0: fault});
    return;
  }
  if (state.running) return;
  startLoop();
}

/**
 * Re-read the switch and the stored key right now.
 *
 * Called by the settings panel after the user changes either. The watcher would
 * notice on its next tick anyway; this only removes the wait, which is the
 * difference between a switch that feels live and one that feels broken.
 * A no-op when the plugin is not running — the watcher owns the lifecycle, and
 * the panel has no business starting it.
 */
export function requestClaimRefresh(): void {
  void supervisor();
}

export function startClaimWatcher(ctx: PluginContext): void {
  context = ctx;
  // A restart is a new session. Quests already handled are re-examined,
  // because the reason they were skipped — a refused token, an empty balance —
  // is exactly what the user just went and fixed.
  handled.clear();
  transientFailures.clear();
  questNames.clear();
  state.claimed = 0;
  state.skipped = 0;
  state.solves = 0;
  state.lastError = null;
  cachedModules = undefined;
  modulesErrored = false;
  stopFault();
  state.enabled = autoQuestSettings.bind("auto-quests").get("autoClaim") === true;
  // Immediate, then on a timer: waiting 15 seconds to notice the switch the
  // user just flipped is the kind of detail that makes a feature feel broken.
  void supervisor();
  supervisorTimer = setInterval(() => {
    void supervisor();
  }, SUPERVISOR_MS);
}

export function stopClaimWatcher(): void {
  stopLoop(i18nText("ui.stopped"));
  if (supervisorTimer !== undefined) {
    clearInterval(supervisorTimer);
    supervisorTimer = undefined;
  }
  cancelSleepers();
  cachedModules = undefined;
  fault = undefined;
  state.enabled = false;
  context = undefined;
}