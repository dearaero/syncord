/** Env key: Discord's original preload path, set by the main-process patch. */
export const ORIGINAL_PRELOAD_ENV = "Syncord_ORIGINAL_PRELOAD";

/**
 * Env key: the canonical base directories the preload may be contained by.
 *
 * `app` is main-process only — in a preload, `require("electron")` returns the
 * *renderer* API and has no `app` — so the preload cannot resolve
 * `app.getPath("userData")` for itself. On Discord 0.0.413 that path is exactly
 * where the main screen's preload lives, so the main process passes the resolved
 * list.
 *
 * This is a consistency channel, not an authority: main already decided the
 * preload path is acceptable, and the preload only has to agree. See
 * `src/preload/index.ts` for the full trust discussion.
 */
export const PRELOAD_BASES_ENV = "Syncord_PRELOAD_BASES";

export const LOG_PREFIX = "[Syncord]";

/**
 * The version, compiled in from `package.json`.
 *
 * ── Why this is a define and not a literal ───────────────────────────────────
 *
 * It used to be `export const VERSION = "0.1.0"`, kept in sync with
 * `package.json` by hand. Two copies of one fact is two things that can disagree,
 * and the disagreement is invisible until it is load-bearing: the update
 * comparison would offer a release as "newer" when it is not, or the Security
 * Center would report a version the release pipeline never built.
 *
 * `scripts/build.mjs` reads `package.json` and passes the value in as
 * `__SYNCORD_VERSION__`, so there is exactly one source. The literal below is
 * only what `tsc` sees and what an unbundled test run gets; `build.mjs` refuses
 * to produce a bundle that does not carry the real value, so the fallback can
 * never reach a user.
 *
 * The type is declared rather than `any` so a missing define is a *type* failure
 * at build time rather than a runtime `undefined` in a version comparison.
 */
declare const __SYNCORD_VERSION__: string | undefined;

const COMPILED_VERSION: string | undefined =
  typeof __SYNCORD_VERSION__ === "string" ? __SYNCORD_VERSION__ : undefined;

/**
 * The value used when the define is absent — an unbundled test run, or a build
 * that somehow skipped `build.mjs`.
 *
 * `"unbuilt"`, and *not* something like `"0.0.0-dev"`. That is not a stylistic
 * choice: `"0.0.0-dev"` is a valid pre-release of `0.0.0`, so
 * `evaluateUpdateOffer` would happily tell such a build that every real release
 * is newer and offer it an update. `"unbuilt"` is not a version at all, so
 * `normalizeVersion` refuses it and the offer evaluation refuses *both*
 * directions — which is the correct failure for a build that does not know its
 * own version. Checked, not assumed: see the "the unbundled fallback offers no
 * update" test in `scripts/tests/update.test.mjs`.
 */
export const VERSION: string = COMPILED_VERSION ?? "unbuilt";

/**
 * The GitHub repository releases are read from, compiled in.
 *
 * The same reasoning as `VERSION`: one source, and `build.mjs` takes it from the
 * `Syncord_RELEASE_REPO` environment variable at *build* time.
 *
 * The reason it cannot be a runtime read is the important part. Anything the
 * main process reads from `process.env` can be changed by whoever launched the
 * process — a launch agent, a wrapper script, a `.env` file. The feed host is
 * a constant precisely so that the release feed cannot be pointed somewhere
 * else; a repository read from the environment at startup undoes that, because
 * the attacker only has to win a DNS or availability game against a host they
 * chose. A signature still has to verify, so this is not a code-execution hole —
 * but it would let anyone who can set one environment variable silently
 * redirect where updates come from, or suppress them entirely.
 */
declare const __SYNCORD_RELEASE_REPO__: string | undefined;

const COMPILED_RELEASE_REPO: string | undefined =
  typeof __SYNCORD_RELEASE_REPO__ === "string" ? __SYNCORD_RELEASE_REPO__ : undefined;

export const COMPILED_RELEASE_REPO_VALUE: string | undefined = COMPILED_RELEASE_REPO;

/**
 * Whitelisted IPC channel names (preload ↔ main).
 *
 * Note the absence of a generic "fetch this URL" channel. It existed until
 * Phase 3 and was the client's largest exfiltration surface: any renderer code
 * could ask the main process to GET/POST an arbitrary URL with arbitrary
 * headers. Network access is now `NETWORK_REQUEST`, which is permissioned,
 * SSRF-checked, rate limited and bounded.
 */
export const IPC = {
  PING: "Syncord_PING",
  GET_VERSION: "Syncord_GET_VERSION",
  GET_SETTINGS: "Syncord_GET_SETTINGS",
  STATISTICS_SNAPSHOT: "Syncord_STATISTICS_SNAPSHOT",
  STATISTICS_STORAGE: "Syncord_STATISTICS_STORAGE",
  SET_SETTINGS: "Syncord_SET_SETTINGS",

  /** Renderer → main: the plugin/permission manifest, registered once at boot. */
  SECURITY_MANIFEST: "Syncord_SECURITY_MANIFEST",
  /** Renderer → main: Network Broker. Permissioned, never arbitrary. */
  NETWORK_REQUEST: "Syncord_NETWORK_REQUEST",
  /** Renderer ← main: which guards are currently active (Security Center). */
  SECURITY_STATUS: "Syncord_SECURITY_STATUS",
  /** Renderer ← main: recent, redacted security events. */
  SECURITY_EVENTS: "Syncord_SECURITY_EVENTS",
  /** Renderer ← main: the effective broker policy. */
  SECURITY_POLICY: "Syncord_SECURITY_POLICY",
  /** Renderer ← main: user-approved host permissions (Phase 4). */
  SECURITY_PERMISSIONS: "Syncord_SECURITY_PERMISSIONS",
  /** Renderer → main: record a user-approved permission. */
  SECURITY_GRANT: "Syncord_SECURITY_GRANT",
  /** Renderer → main: revoke a permission by key. */
  SECURITY_REVOKE: "Syncord_SECURITY_REVOKE",
  /** Renderer → main: "a direct egress attempt was refused" (Phase 5). */
  REPORT_EGRESS: "Syncord_REPORT_EGRESS",
  /**
   * Renderer → main: append one line to the boot log.
   *
   * Reporting only, and deliberately narrow: a single short string, sliced and
   * redacted on the way in. It exists because the renderer is the one part of the
   * boot chain whose own console is invisible from a terminal — see
   * `src/shared/bootLog.ts`.
   */
  BOOT_LOG: "Syncord_BOOT_LOG",
  /** Renderer → main: arm / disarm Emergency Lockdown for this session. */
  SECURITY_LOCKDOWN: "Syncord_SECURITY_LOCKDOWN",
  /** Renderer → main: leave Safe Mode (Phase 13). */
  SECURITY_SAFE_MODE: "Syncord_SECURITY_SAFE_MODE",

  /**
   * Update service. Six narrow operations, deliberately not one "manage the
   * update" channel with a free-form action string.
   *
   * The split matters: `UPDATE_CHECK` and `UPDATE_STATUS` move no data and are
   * safe to poll, while `UPDATE_STAGE` and `UPDATE_HANDOFF` cause a download
   * and start a process. A single channel would have to be rate limited at the
   * strictest of the two rates, which is precisely the trade the
   * `IPC_RATE_LIMIT_EXEMPT` comment in `src/main/ipc.ts` describes for `PING`
   * and `SECURITY_STATUS` — a tripped bucket making the UI lie.
   */
  UPDATE_CHECK: "Syncord_UPDATE_CHECK",
  UPDATE_STATUS: "Syncord_UPDATE_STATUS",
  UPDATE_STAGE: "Syncord_UPDATE_STAGE",
  UPDATE_HANDOFF: "Syncord_UPDATE_HANDOFF",
  UPDATE_RESTART: "Syncord_UPDATE_RESTART",
  /**
   * Renderer → main: forget the accepted release.
   *
   * Its own channel rather than an argument to `UPDATE_CHECK`, because it is
   * the answer to "the user turned automatic updates off" and it must work when
   * checking is off — which is exactly when a shared channel would be refused.
   */
  UPDATE_RESET: "Syncord_UPDATE_RESET",
  /**
   * Renderer ← main: where the Syncord Installer was found.
   *
   * Read-only. It exists so the settings UI can say "one-click install will
   * work" or "download the Installer first", instead of the user finding out by
   * pressing a button.
   */
  UPDATE_INJECTOR: "Syncord_UPDATE_INJECTOR",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
