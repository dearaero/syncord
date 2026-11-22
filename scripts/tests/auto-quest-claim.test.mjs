/**
 * Auto-claim watcher tests.
 *
 * The watcher runs on its own, in the background, and spends real money: every
 * hCaptcha it solves costs the user a credit. So the properties asserted here
 * are the ones that decide whether it is safe to leave on — it does nothing
 * unless both the switch and a stored key are present, it never retries a
 * refused token more than the stated budget allows, and it stops cleanly.
 *
 * The module is bundled with the plugin API, the toast and the settings schema
 * stubbed out; the Discord module discovery underneath is the real one, driven
 * through a fake `window.Syncord.webpack`.
 *
 * Run: `node --test scripts/tests/auto-quest-claim.test.mjs`
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(path.join(tmpdir(), "syncord-auto-claim-"));
const out = path.join(dir, "bundle.mjs");

await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: "ts",
    contents: `export * from './src/renderer/plugins/autoQuests/claim';`,
  },
  bundle: true,
  platform: "neutral",
  format: "esm",
  outfile: out,
  logLevel: "warning",
  plugins: [
    {
      name: "fixture",
      setup(b) {
        b.onResolve({ filter: /api\/plugin\/settingsDef$/ }, () => ({ path: "settingsDef", namespace: "fixture" }));
        b.onResolve({ filter: /ui\/toast$/ }, () => ({ path: "toast", namespace: "fixture" }));
        b.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          loader: "js",
          contents:
            args.path === "settingsDef"
              ? `export const definePluginSettings=defs=>({bind:()=>({get:key=>globalThis.saved[key]??defs[key].default,set:(key,value)=>{globalThis.saved[key]=value;}})});`
              : `export const showToast=(text)=>{globalThis.notices.push(text);};export const ToastType={FAILURE:"failure",SUCCESS:"success",INFO:"info"};`,
        }));
      },
    },
  ],
});

const C = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

/**
 * Stop the watcher after every test, pass or fail.
 *
 * A failed assertion skips the rest of its body — including the
 * `stopClaimWatcher()` at the end — and the still-running supervisor then
 * resolves against the *next* test's fake world. That produced failures which
 * were artefacts of an earlier one, which is worse than useless in a suite
 * about a paid, stateful, background feature.
 */
afterEach(() => {
  C.stopClaimWatcher();
});

const QUEST_ID = "1425993161108357191";

/** A Discord captcha refusal, as the API returns it. */
const challenge = (sitekey = "4bb5aadb-b50f-4f23-b1c2-92b59ba400d5") => ({
  status: 400,
  body: {
    captcha_key: ["response-already-used-error"],
    captcha_service: "hcaptcha",
    captcha_sitekey: sitekey,
    captcha_session_id: "0ad46c1c-98e2-45f4-a09c-ddbfde9a301c",
    captcha_rqdata: "RQDATA-VALUE",
    captcha_rqtoken: "RQTOKEN-VALUE",
  },
});

const claimed = { status: 200, body: { claimed_at: "2026-01-01T00:00:00Z" } };

/**
 * Build a `config.rewards_config`, which is where Discord actually puts this
 * data: assignment method, the reward tiers, the platforms it can be redeemed
 * on, and when the claiming window shuts.
 */
function rewardsConfig({ platforms, assignmentMethod, rewardsExpireAt } = {}) {
  return {
    rewardsConfig: {
      assignmentMethod,
      rewards: [{ type: 3, skuId: "1342624440894361624" }],
      rewardsExpireAt,
      platforms,
    },
  };
}

function world(options = {}) {
  const quest = {
    id: QUEST_ID,
    config: {
      messages: { questName: "Test Quest" },
      expiresAt: "2999-01-01T00:00:00Z",
      ...(options.config ?? {}),
    },
    userStatus: { enrolledAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-02T00:00:00Z" },
  };
  const quests = new Map([[QUEST_ID, quest]]);

  const calls = [];
  const solved = [];
  const feedback = [];
  const notices = [];
  const dispatched = [];

  const api = {
    get: async ({ url }) => {
      calls.push({ method: "get", url });
      // The server's view, which is what a claim is verified against. Marked
      // claimed only once the server says so.
      return {
        status: 200,
        body: {
          quests: [...quests.values()].map((quest) => ({
            ...quest,
            userStatus: options.serverClaimed?.has(quest.id)
              ? { ...quest.userStatus, claimedAt: "2026-01-03T00:00:00Z" }
              : quest.userStatus,
          })),
        },
      };
    },
    post: async ({ url, body, headers }) => {
      calls.push({ method: "post", url, body, headers });
      const scripted = options.post?.(url, body, headers) ?? claimed;
      // A 2xx normally means the server took the reward, which is what the
      // watcher then verifies against `/quests/@me`. A test that is specifically
      // about a 2xx which did *not* take it says so with `claimTakesEffect:false`.
      if (scripted.status >= 200 && scripted.status < 300 && url.includes("claim-reward")) {
        if (options.claimTakesEffect !== false) (options.serverClaimed ??= new Set()).add(url.split("/")[2]);
      }
      return scripted;
    },
    put: async () => ({ status: 200, body: {} }),
    patch: async () => ({ status: 200, body: {} }),
    del: async () => ({ status: 200, body: {} }),
  };

  const store = { getQuests: () => quests, getQuest: (id) => quests.get(id) };
  const dispatcher = {
    dispatch: (action) => { dispatched.push(action); },
    subscribe: () => {},
    unsubscribe: () => {},
  };

  const bus = new EventTarget();
  let nextId = 0;
  let now = 0;
  const jobs = new Map();
  const set = (fn, delay, repeat = false) => {
    const id = ++nextId;
    jobs.set(id, { fn, at: now + delay, delay, repeat });
    return id;
  };

  globalThis.saved = { autoClaim: options.autoClaim !== false };
  globalThis.notices = notices;
  globalThis.document = { querySelector: () => null };
  globalThis.window = {
    Syncord: {
      webpack: {
        findByStoreName: (name) => (name === "QuestsStore" ? store : undefined),
        find: () => api,
        findByProps: () => dispatcher,
      },
    },
    dispatchEvent: bus.dispatchEvent.bind(bus),
    addEventListener: bus.addEventListener.bind(bus),
    removeEventListener: bus.removeEventListener.bind(bus),
  };
  globalThis.setTimeout = (fn, delay) => set(fn, delay);
  globalThis.clearTimeout = (id) => jobs.delete(id);
  globalThis.setInterval = (fn, delay) => set(fn, delay, true);
  globalThis.clearInterval = (id) => jobs.delete(id);

  /**
 * Advance the virtual clock, flushing the microtasks the watcher awaits.
 *
 * The flush comes *before* each scan as well as after each job: a claim chain
 * that is still resolving when the scan happens has not scheduled its retry
 * timer yet, and a watcher that slept 500 ms between solves would otherwise
 * never be seen to wake up inside the window under test.
 */
  const tick = async (ms) => {
    const end = now + ms;
    for (;;) {
      await flush();
      const due = [...jobs.entries()].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, job] = due;
      now = job.at;
      jobs.delete(id);
      job.fn();
      if (job.repeat && !job.cancelled) jobs.set(id, { ...job, at: now + job.delay });
    }
    now = end;
    await flush();
  };

  const ctx = {
    plugin: { id: "auto-quests" },
    log: { info() {}, warn() {}, error() {} },
    settings: {
      get: (key, fallback) => globalThis.saved[key] ?? fallback,
      set: (key, value) => { globalThis.saved[key] = value; },
    },
    captcha: {
      status: async () => ({ configured: options.configured !== false, masked: "nc_live_••••0000" }),
      solve: async (request) => {
        solved.push(request);
        return options.solve?.(request, solved.length - 1) ?? {
          ok: true,
          token: "P1_TESTTOKEN",
          respKey: null,
          userAgent: null,
          solveId: `solve_${String(solved.length).padStart(8, "0")}`,
          creditsCharged: 1,
        };
      },
      feedback: async (input) => {
        feedback.push(input);
        return { ok: true, recorded: 1, failed: 0 };
      },
    },
    disposable: () => {},
  };

  const claimCalls = () => calls.filter((call) => call.url.includes("claim-reward"));
  return { calls, claimCalls, solved, feedback, notices, dispatched, jobs, tick, ctx };
}

/**
 * Let the watcher's promise chains settle.
 *
 * `setImmediate` rather than a fixed count of `await Promise.resolve()`: a
 * microtask budget is a guess, and a guess that is a few turns short fails as a
 * mystery assertion about a call that "never happened". A macrotask boundary
 * drains every queued continuation, so the loop is about letting scheduled
 * timers fire, not about counting.
 */
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
};

// ── The switch and the key both gate the feature ─────────────────────────────

test("auto claim: nothing happens while the switch is off", async () => {
  const w = world({ autoClaim: false });
  C.startClaimWatcher(w.ctx);
  await w.tick(10 * 60_000);
  assert.equal(w.claimCalls().length, 0);
  assert.equal(w.solved.length, 0);
  assert.equal(C.claimState().enabled, false);
  C.stopClaimWatcher();
});

test("auto claim: nothing happens while no API key is stored", async () => {
  const w = world({ configured: false });
  C.startClaimWatcher(w.ctx);
  await w.tick(10 * 60_000);
  assert.equal(w.claimCalls().length, 0, "an unconfigured key must not spend a credit");
  assert.equal(w.solved.length, 0);
  assert.equal(C.claimState().configured, false);
  C.stopClaimWatcher();
});

test("auto claim: storing a key later starts it without restarting the plugin", async () => {
  const w = world({ configured: false });
  C.startClaimWatcher(w.ctx);
  await w.tick(120_000);
  assert.equal(w.claimCalls().length, 0);

  w.ctx.captcha.status = async () => ({ configured: true, masked: "nc_live_••••0000" });
  await w.tick(120_000);
  assert.ok(w.claimCalls().length > 0, "the watcher should notice the key and start claiming");
  C.stopClaimWatcher();
});

// ── The happy path ───────────────────────────────────────────────────────────

test("auto claim: a completed quest is claimed in the background", async () => {
  const w = world();
  C.startClaimWatcher(w.ctx);
  await w.tick(1000);

  const state = C.claimState();
  assert.equal(state.claimed, 1);
  assert.equal(state.running, true);
  const [call] = w.claimCalls();
  assert.equal(call.url, `/quests/${QUEST_ID}/claim-reward`);
  assert.equal(w.solved.length, 0, "no captcha means no solve and no credit spent");
  C.stopClaimWatcher();
});

test("auto claim: the claim carries the location and platform the endpoint requires", async () => {
  // `claim-reward` documents `location` and `platform` as required JSON params.
  // Sending an empty body is what made the first version look like it "did
  // nothing": the server refused it with a plain 400 that carries no captcha,
  // so the watcher skipped the quest without ever reaching a solve.
  const w = world();
  C.startClaimWatcher(w.ctx);
  await w.tick(1000);

  const [call] = w.claimCalls();
  assert.equal(typeof call.body.location, "number", "location must be sent");
  assert.equal(typeof call.body.platform, "number", "platform must be sent");
  C.stopClaimWatcher();
});

test("auto claim: a validation refusal is reported instead of looking like silence", async () => {
  // The shape Discord returns for a missing parameter, which is what an empty
  // body produced. It must reach the user, because "nothing happened" and
  // "the request was refused" need different fixes.
  const w = world({
    post: (url) =>
      url.includes("claim-reward")
        ? { status: 400, body: { message: "Invalid Form Body", code: 50035 } }
        : null,
  });
  C.startClaimWatcher(w.ctx);
  await w.tick(1000);
  assert.match(C.claimState().lastError, /Invalid Form Body/);
  assert.ok(C.claimState().skipped >= 1, "a refused claim is counted, not hidden");
  C.stopClaimWatcher();
});

test("auto claim: a 200 that did not actually claim the reward is not counted as a win", async () => {
  // A claim endpoint that answers 200 without taking the reward is the failure a
  // counter cannot see. The server's own quest list is the authority, and the
  // cost of checking is one GET.
  const w = world({
    claimTakesEffect: false,
    post: (url) => (url.includes("claim-reward") ? { status: 200, body: { ok: true } } : null),
  });
  C.startClaimWatcher(w.ctx);
  await w.tick(1000);
  await w.tick(120_000);

  assert.equal(C.claimState().claimed, 0, "an unverified 2xx is not a claim");
  assert.match(C.claimState().lastError, /unverified/i);
  C.stopClaimWatcher();
});

test("auto claim: every test leaves the watcher stopped, so state cannot leak between them", () => {
  // A failed assertion skips the rest of its test, including `stopClaimWatcher`,
  // and the still-running supervisor then resolves against the *next* test's
  // fake world. The suite is only trustworthy because of this.
  assert.equal(C.claimState().running, false, "the watcher must be stopped between tests");
});

test("auto claim: a claimed reward does not push Discord into its own claim flow", async () => {
  // The watcher used to dispatch a guessed `QUESTS_CLAIM_REWARD_SUCCESS` after a
  // claim. The event name was never verified, and the user reported a captcha
  // window opening over a reward that had *already* been claimed — Discord
  // reacting to something the plugin invented. A stale Quest tab is harmless;
  // an unsolicited claim flow is not.
  const w = world();
  C.startClaimWatcher(w.ctx);
  await w.tick(1000);
  assert.equal(C.claimState().claimed, 1);
  assert.deepEqual(w.dispatched, [], `unexpected Flux traffic: ${JSON.stringify(w.dispatched)}`);
});

test("auto claim: an already claimed quest is left alone", async () => {
  const w = world();
  const quest = w.calls;
  C.startClaimWatcher(w.ctx);
  await w.tick(1000);
  const first = w.claimCalls().length;
  await w.tick(10 * 60_000);
  assert.equal(
    w.claimCalls().length,
    first,
    `a claimed quest must not be re-submitted; ${JSON.stringify(quest)}`,
  );
  C.stopClaimWatcher();
});

// ── The captcha path ─────────────────────────────────────────────────────────

test("auto claim: a captcha is solved and the claim retried with the token", async () => {
  const w = world({
    post: (url, _body, headers) => {
      if (!url.includes("claim-reward")) return null;
      if (headers && headers["X-Captcha-Key"]) return claimed;
      return challenge();
    },
  });
  C.startClaimWatcher(w.ctx);
  await w.tick(1000);

  assert.equal(w.solved.length, 1, "one challenge means exactly one paid solve");
  assert.equal(w.solved[0].sitekey, "4bb5aadb-b50f-4f23-b1c2-92b59ba400d5");
  assert.equal(w.solved[0].rqdata, "RQDATA-VALUE", "enterprise rqdata must be passed through");
  const retried = w.claimCalls()[1];
  assert.equal(retried.headers["X-Captcha-Key"], "P1_TESTTOKEN");
  assert.equal(retried.headers["X-Captcha-Session-Id"], "0ad46c1c-98e2-45f4-a09c-ddbfde9a301c");
  assert.equal(retried.headers["X-Captcha-Rqtoken"], "RQTOKEN-VALUE");
  assert.equal(C.claimState().claimed, 1);
  C.stopClaimWatcher();
});

test("auto claim: when the header transport is refused the body transport is tried", async () => {
  // Discord moved the solution from the JSON body to a header. If a given
  // client build ignores the header, a watcher that only knew the new spelling
  // would loop forever buying tokens it can never use.
  let attempts = 0;
  const w = world({
    post: (url, body, headers) => {
      if (!url.includes("claim-reward")) return null;
      attempts += 1;
      const solutionInHeader = typeof headers?.["X-Captcha-Key"] === "string";
      const solutionInBody = typeof body?.captcha_key === "string";
      if (attempts === 1) return challenge();
      if (solutionInHeader && !solutionInBody) return challenge();
      return claimed;
    },
  });
  C.startClaimWatcher(w.ctx);
  await w.tick(1000);

  assert.equal(w.solved.length, 1, "the fallback must reuse the token, not buy a second one");
  assert.equal(C.claimState().claimed, 1);
  const last = w.claimCalls().at(-1);
  assert.equal(last.body.captcha_key, "P1_TESTTOKEN");
  C.stopClaimWatcher();
});

test("auto claim: a refused token is reported to the solver and the quest is skipped", async () => {
  const w = world({ post: (url) => (url.includes("claim-reward") ? challenge() : null) });
  C.startClaimWatcher(w.ctx);
  await w.tick(1000);

  assert.equal(w.feedback.length, 1, "a refused token has to be reported or it looks solved");
  assert.equal(w.feedback[0].outcome, "rejected");
  assert.equal(w.feedback[0].solveId, "solve_00000001");
  assert.equal(C.claimState().claimed, 0);
  assert.ok(w.notices.length > 0, "the user should be told once that claiming did not work");
  C.stopClaimWatcher();
});

test("auto claim: a retryable solver failure is retried, a terminal one is not", async () => {
  let solves = 0;
  const w = world({
    post: (url) => (url.includes("claim-reward") ? challenge() : null),
    solve: () => {
      solves += 1;
      return solves === 1
        ? { ok: false, code: "request_failed", message: "Could not reach the captcha service.", retryable: true, solveId: null }
        : { ok: true, token: "P1_SECOND", respKey: null, userAgent: null, solveId: "solve_00000002", creditsCharged: 1 };
    },
  });
  C.startClaimWatcher(w.ctx);
  await w.tick(1000);

  assert.equal(w.solved.length, 2, "a retryable failure is worth one more attempt");
  const withToken = w.claimCalls().find((call) => call.headers?.["X-Captcha-Key"]);
  assert.equal(withToken.headers["X-Captcha-Key"], "P1_SECOND");
  C.stopClaimWatcher();
});

test("auto claim: an empty balance stops the watcher instead of retrying forever", async () => {
  const w = world({
    post: (url) => (url.includes("claim-reward") ? challenge() : null),
    solve: () => ({
      ok: false,
      code: "insufficient_credits",
      message: "Top up at dashboard.nonecap.com",
      retryable: false,
      solveId: null,
    }),
  });
  C.startClaimWatcher(w.ctx);
  await w.tick(1000);
  const before = w.solved.length;
  await w.tick(30 * 60_000);

  assert.equal(w.solved.length, before, "a terminal failure must not be retried on the next tick");
  assert.equal(C.claimState().running, false);
  C.stopClaimWatcher();
});

test("auto claim: the per-session solve budget is never exceeded", async () => {
  const w = world({ post: (url) => (url.includes("claim-reward") ? challenge() : null) });
  C.startClaimWatcher(w.ctx);
  await w.tick(60 * 60_000);
  assert.ok(
    w.solved.length <= C.SESSION_SOLVE_BUDGET,
    `spent ${w.solved.length} solves against a budget of ${C.SESSION_SOLVE_BUDGET}`,
  );
  C.stopClaimWatcher();
});

// ── Why a quest was skipped ──────────────────────────────────────────────────

test("auto claim: a quest the server says is already claimed is dropped quietly", async () => {
  // The local store does not always carry `claimedAt`, so the server is the
  // authority. Treating that answer as a failure to report would toast at the
  // user every poll for a quest that was never in question.
  const w = world({
    post: (url) =>
      url.includes("claim-reward")
        ? { status: 400, body: { message: "This quest has already been claimed", code: 40035 } }
        : null,
  });
  C.startClaimWatcher(w.ctx);
  await w.tick(1000);
  const after = w.claimCalls().length;
  await w.tick(10 * 60_000);

  assert.equal(w.claimCalls().length, after, "an already-claimed quest is not re-submitted");
  assert.equal(w.notices.length, 0, "an expected outcome should not raise a toast");
  assert.match(C.claimState().lastError, /already been claimed/i, "the reason must still be visible");
  C.stopClaimWatcher();
});

test("auto claim: a transient failure is retried on a later poll instead of dropped", async () => {
  let failures = 2;
  const w = world({
    post: (url) => {
      if (!url.includes("claim-reward")) return null;
      if (failures > 0) {
        failures -= 1;
        return { status: 500, body: { message: "Internal Server Error" } };
      }
      return claimed;
    },
  });
  C.startClaimWatcher(w.ctx);
  await w.tick(1000);
  assert.equal(C.claimState().claimed, 0);

  // A 5xx is not the quest's fault: dropping it for the session would mean a
  // reward that is still claimable silently never gets claimed.
  await w.tick(3 * 60_000);
  assert.equal(C.claimState().claimed, 1, "the quest should be retried on a later poll");
  C.stopClaimWatcher();
});

test("auto claim: a refusal with no JSON body says so instead of 'unknown message'", async () => {
  // An edge block (or an HTML error page) arrives as a status with nothing that
  // looks like a Discord error. "Bilinmeyen Mesaj" is what the user saw, and it
  // is the one output that helps nobody — say what actually arrived, and put the
  // raw body in the log where it can be copied.
  const logs = [];
  const w = world({
    post: (url) => (url.includes("claim-reward") ? { status: 403, body: "<html><title>403</title></html>" } : null),
  });
  w.ctx.log.warn = (...parts) => { logs.push(parts.join(" ")); };
  C.startClaimWatcher(w.ctx);
  await w.tick(1000);

  const reason = C.claimState().lastError ?? "";
  assert.equal(/Bilinmeyen Mesaj|unknown message/i.test(reason), false);
  assert.match(reason, /403/, "the status must survive even when the body is not JSON");
  assert.ok(
    logs.some((line) => /body|<html>/.test(line)),
    `the raw body belongs in the log, saw ${JSON.stringify(logs)}`,
  );
  C.stopClaimWatcher();
});

test("auto claim: a refusal with no body at all is described, not left blank", async () => {
  const logs = [];
  const w = world({
    post: (url) => (url.includes("claim-reward") ? { status: 403, body: undefined } : null),
  });
  w.ctx.log.warn = (...parts) => { logs.push(parts.join(" ")); };
  C.startClaimWatcher(w.ctx);
  await w.tick(1000);
  assert.ok(logs.some((line) => /body/i.test(line)), `saw ${JSON.stringify(logs)}`);
  C.stopClaimWatcher();
});

test("auto claim: a Discord error code is reported when there is no message", async () => {
  const w = world({
    post: (url) => (url.includes("claim-reward") ? { status: 403, body: { code: 50035 } } : null),
  });
  C.startClaimWatcher(w.ctx);
  await w.tick(1000);
  assert.match(C.claimState().lastError ?? "", /50035/);
  C.stopClaimWatcher();
});

test("auto claim: the platform and tier come from the quest's own reward config", async () => {
  // `rewards_config` is where the real data lives (docs.discord.food), and a
  // claim sent with the wrong platform or without a tier on a TIERED quest is
  // refused with a bare 403. Guessing one global value is what produced it.
  const w = world({ config: rewardsConfig({ platforms: [4], assignmentMethod: 2 }) });
  C.startClaimWatcher(w.ctx);
  await w.tick(1000);

  const [call] = w.claimCalls();
  assert.equal(call.body.platform, 4, "the quest's own reward platform");
  assert.equal(typeof call.body.claimed_tier, "number", "a tiered quest needs a tier");
  C.stopClaimWatcher();
});

test("auto claim: an expired reward is never sent to the server", async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const w = world({ config: rewardsConfig({ rewardsExpireAt: past }) });
  C.startClaimWatcher(w.ctx);
  await w.tick(10 * 60_000);
  assert.equal(w.claimCalls().length, 0, "an expired reward is not claimable at all");
  C.stopClaimWatcher();
});

test("auto claim: a live reward window is still claimable", async () => {
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const w = world({ config: rewardsConfig({ rewardsExpireAt: future }) });
  C.startClaimWatcher(w.ctx);
  await w.tick(1000);
  assert.equal(w.claimCalls().length, 1);
  C.stopClaimWatcher();
});

test("auto claim: the last failure reason is reported without a token", async () => {
  const w = world({
    post: (url) =>
      url.includes("claim-reward")
        ? { status: 400, body: { message: "You do not have permission to claim this reward" } }
        : null,
  });
  C.startClaimWatcher(w.ctx);
  await w.tick(1000);
  assert.match(C.claimState().lastError, /permission/i);
  C.stopClaimWatcher();
});

test("auto claim: a cleared failure reason does not linger after a success", async () => {
  let first = true;
  const w = world({
    post: (url) => {
      if (!url.includes("claim-reward")) return null;
      if (first) {
        first = false;
        return { status: 500, body: { message: "Internal Server Error" } };
      }
      return claimed;
    },
  });
  C.startClaimWatcher(w.ctx);
  await w.tick(1_000);
  assert.ok(C.claimState().lastError);
  await w.tick(3 * 60_000);
  assert.equal(C.claimState().claimed, 1);
  assert.equal(C.claimState().lastError, null, "a stale error next to a success reads as a new failure");
  C.stopClaimWatcher();
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

test("auto claim: stopping the plugin leaves no timer behind", async () => {
  const w = world();
  C.startClaimWatcher(w.ctx);
  await w.tick(1000);
  assert.ok(w.jobs.size > 0, "the watcher should be running");
  C.stopClaimWatcher();
  assert.equal(w.jobs.size, 0);
});

test("auto claim: the state reported to the UI never contains a token", async () => {
  const w = world({
    post: (url, _body, headers) => (url.includes("claim-reward") && !headers?.["X-Captcha-Key"] ? challenge() : claimed),
  });
  C.startClaimWatcher(w.ctx);
  await w.tick(1000);
  const state = JSON.stringify(C.claimState());
  assert.equal(state.includes("P1_"), false);
  assert.equal(state.includes("nc_live"), false);
  C.stopClaimWatcher();
});