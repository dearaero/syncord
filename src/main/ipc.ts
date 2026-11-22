import {registerDrop,closeDrops,dropSettingsChanged} from './drop';
import {DROP_IPC} from '../shared/drop';
import {registerPopoutChats,closePopoutChats} from "./popoutChats";
import {SUPPORTER_IPC} from "../shared/supporter";
import {ecosystemHandlers,createEcosystemSupporterScope} from "./ecosystem";
import {statisticsSnapshot,statisticsStorage} from "./statistics";
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { readRecordingPlayback, closeRecordingPlayback } from "./recording/playback";
import { RECORDING_IPC } from "../shared/recording";
import { SNAPSHOT_IPC } from "../shared/snapshot";
import { copySnapshot } from "./snapshot";
import { CAPTCHA_IPC } from "../shared/captcha";
import {
  captchaKeyStatus,
  clearCaptchaKey,
  reportCaptchaFeedback,
  saveCaptchaKey,
  solveCaptcha,
} from "./security/captchaSolver";
import { setRecordingLocale, assertRecordingWorker, recordingWorkerInit, recordingSelect, recordingReady, recordingChunk, recordingFinish, recordingFailure, recordingDevices, recordingDevicesResult, startRecording, stopRecording, recordingStatus, listRecordings, playRecording, revealRecording, cancelRecordingForSecurity } from "./recording";

import { IPC, LOG_PREFIX, VERSION } from "../shared/constants";
import { bootLog } from "../shared/bootLog";
import { devToolsAllowed } from "./enableDevTools";
import { integrityStatus } from "./security/integrity";
import { assertTrustedSender, securityLog } from "./security/core";
import { enableLockdown, exitSafeMode, isDeveloperMode, isLockdown, isSafeMode } from "./security/modes";
import { permissionHandlersActive } from "./security/permissions";
import {
  brokerRequest,
  describeBrokerPolicy,
  isPluginRegistered,
  registerPluginManifest,
} from "./security/networkBroker";
import { encryptionAvailable, forgetSecrets } from "./security/safeStorage";
import { privacyStatus } from "./security/privacy";
import { egressGuardActive } from "./security/session";
import { grantPermission, listGrants, loadGrants, revokePermission } from "./security/permissionStore";
import { consumeLimit } from "./security/rateLimit";
import { readSettings, validateSettingsPayload, writeSettings } from "./security/settings";
import {
  cancelPendingUpdate,
  checkForUpdate,
  discoverInjector,
  handOffToInjector,
  injectorSearchPaths,
  resetUpdateState,
  restartForUpdate,
  stageUpdate,
  updateStatus,
} from "./security/updater";

/**
 * Discord-facing privileged IPC is registered through `handle`. Recorder
 * workers have a separate exact-webContents/main-frame identity check below;
 * they never receive the Discord bridge.
 *
 * `handle` is not a convenience wrapper, it is the enforcement point: there is
 * no Discord-facing path in this file that reaches `ipcMain.handle` except through here,
 * and `here` refuses any sender that is not the main frame of a trusted Discord
 * page. Adding a channel therefore cannot accidentally skip validation the way
 * a hand-written `ipcMain.on` would.
 */
/**
 * Channels that are exempt from the shared IPC rate limit.
 *
 * Chosen rather than "limit everything" for a specific reason: `PING` and
 * `GET_VERSION` are how the Security Center polls live state, and a tripped
 * bucket on those would make the UI *lie* — a panel that says "unreachable"
 * when the truth is "you clicked refresh too fast". The rest are bounded work
 * (settings, status, a permission prompt) and benefit from the limit.
 */
/**
 * Buckets whose "rate limit exceeded" record has already been written for the
 * current cooldown. Small, local, and cleared the moment the bucket refills.
 */
const egressReportedFor = new Set<string>();

const IPC_RATE_LIMIT_EXEMPT: ReadonlySet<string> = new Set([
  // Streaming has its own one-read/2 MB/token bound, rather than a UI click bucket.
  DROP_IPC.READ,
  DROP_IPC.WRITE,
  RECORDING_IPC.PLAYBACK_READ,
  RECORDING_IPC.PLAYBACK_CLOSE,
  RECORDING_IPC.STATUS,
  IPC.PING,
  IPC.GET_VERSION,
  IPC.SECURITY_STATUS,
  IPC.SECURITY_EVENTS,
  IPC.SECURITY_POLICY,
  IPC.SECURITY_PERMISSIONS,
  IPC.UPDATE_STATUS,
  IPC.UPDATE_RESET,
  IPC.UPDATE_INJECTOR,
  // Read-only, and consulted by the settings panel and by the Auto Quests
  // supervisor every few seconds. It is exempt here so a fast status poll
  // cannot eat the 200/s IPC budget a user action needs; the solve channel,
  // which costs money, has its own bucket and is *not* exempt.
  CAPTCHA_IPC.STATUS,
]);

/**
 * Register one privileged IPC channel.
 *
 * `RATE_LIMITS.ipc` existed from Phase 2 but nothing ever consumed it, so a
 * compromised page could call the privileged channels in an unbounded loop
 * against a trusted sender. The sender check answers *who* is calling; this
 * answers *how often*, which is a different question and was unanswered.
 *
 * Keyed per channel rather than globally: one noisy channel must not starve the
 * others, and a global bucket turns a single misbehaving caller into a
 * self-inflicted denial of service against the Security Center.
 */
function handle(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedSender(event, channel);
    if (!IPC_RATE_LIMIT_EXEMPT.has(channel)) {
      const verdict = consumeLimit(`ipc:${channel}`, "ipc");
      if (!verdict.allowed) {
        securityLog().record({
          type: "RATE_LIMIT_TRIGGERED",
          channel,
          reason: `ipc channel "${channel}" exceeded its rate limit`,
          webContentsId: typeof event?.sender?.id === "number" ? event.sender.id : undefined,
        });
        throw new Error("Too many requests");
      }
    }
    return handler(event, ...args);
  });
}

/** Register whitelisted IPC handlers. Call once before Discord boots. */
export function registerIpc(): void {
  registerDrop(handle);
  registerPopoutChats(handle);
  for(const [channel,handler] of Object.entries(ecosystemHandlers))handle(channel,(_event,...args)=>handler(...args));
  const supporterScopes=new Map<number,ReturnType<typeof createEcosystemSupporterScope>>();
  for(const channel of Object.values(SUPPORTER_IPC))handle(channel,(event,...args)=>{
    const senderId=event.sender.id;let scope=supporterScopes.get(senderId);
    if(!scope){scope=createEcosystemSupporterScope();supporterScopes.set(senderId,scope);const owned=scope;event.sender.once('destroyed',()=>{owned.dispose();supporterScopes.delete(senderId);});}
    return scope.handlers[channel](...args);
  });
  handle(IPC.STATISTICS_SNAPSHOT, () => statisticsSnapshot());
  handle(IPC.STATISTICS_STORAGE, () => statisticsStorage());
  handle(SNAPSHOT_IPC.COPY, (event, rect) => copySnapshot(event, rect));
  // Phase 4: load persisted grants before any handler can consult them, so the
  // first request of the session already sees the user's decisions.
  loadGrants();

  handle(RECORDING_IPC.LOCALE, (event, locale) => setRecordingLocale(event.sender, locale));
  handle(RECORDING_IPC.DEVICES, event => recordingDevices(event.sender));
  handle(RECORDING_IPC.START, (event, options) => startRecording(event.sender, options));
  handle(RECORDING_IPC.STOP, (event, release) => stopRecording(event.sender, release === true));
  handle(RECORDING_IPC.STATUS, () => recordingStatus());
  handle(RECORDING_IPC.LIST, (_event, before) => listRecordings(before));
  handle(RECORDING_IPC.PLAYBACK_READ, (event, token, offset) => readRecordingPlayback(event.sender, token, offset));
  handle(RECORDING_IPC.PLAYBACK_CLOSE, (event, token) => {if(typeof token !== "string" || !/^[a-f0-9]{48}$/.test(token)) throw new Error("Invalid recording preview token.");return closeRecordingPlayback(event.sender,token);});
  handle(RECORDING_IPC.PLAY, (event, id) => playRecording(event.sender, id));
  handle(RECORDING_IPC.REVEAL, (_event, id) => revealRecording(id));

  // Worker-only channels use an exact owned webContents + main-frame check.
  // Discord frames cannot write video bytes or impersonate a capture window.
  const workerHandle = (channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, (event, ...args) => { assertRecordingWorker(event); return fn(event, ...args); });
  };
  workerHandle(RECORDING_IPC.DEVICES_RESULT, (event, devices) => recordingDevicesResult(event, devices));
  workerHandle(RECORDING_IPC.INIT, event => recordingWorkerInit(event));
  workerHandle(RECORDING_IPC.SELECT, (event, source) => recordingSelect(event, source));
  workerHandle(RECORDING_IPC.READY, (event, data) => recordingReady(event, data));
  workerHandle(RECORDING_IPC.CHUNK, (event, sequence, bytes) => recordingChunk(event, sequence, bytes));
  workerHandle(RECORDING_IPC.FINISH, (event, failed, duration, reason) => recordingFinish(event, failed, duration, reason));
  workerHandle(RECORDING_IPC.ERROR, (event, reason) => recordingFailure(event, reason));

  handle(IPC.PING, () => "pong" as const);
  handle(IPC.GET_VERSION, () => VERSION);

  // The renderer half of the boot log. Reporting only: one short line, sliced
  // and redacted, sent from a sender that has already passed `assertTrustedSender`
  // like every other channel. A compromised page can forge log lines, which is
  // noise in a file nobody executes — the alternative is a boot chain whose
  // final third is completely unobservable.
  handle(IPC.BOOT_LOG, (_event, line: unknown) => {
    if (typeof line !== "string") return;
    bootLog(`renderer: ${line.slice(0, 500)}`);
  });

  handle(IPC.GET_SETTINGS, () => {
    const load = readSettings();
    return load.ok ? load.data : {};
  });

  handle(IPC.SET_SETTINGS, (_event, data: unknown) => {
    // Phase 2/R7: a plain-object check is not enough. The payload is
    // structurally validated and the reserved security namespace is stripped
    // before anything touches disk.
    const verdict = validateSettingsPayload(data);
    if (!verdict.ok) {
      securityLog().record({ type: "SETTINGS_REJECTED", channel: IPC.SET_SETTINGS, reason: verdict.reason });
      throw new Error(`settings rejected: ${verdict.reason}`);
    }
    const written = writeSettings(verdict.data);
    if(written.ok)dropSettingsChanged(verdict.data);
    if (!written.ok) {
      securityLog().record({ type: "SETTINGS_REJECTED", channel: IPC.SET_SETTINGS, reason: written.reason });
      throw new Error(`settings rejected: ${written.reason}`);
    }
  });

  // ── Security control plane ────────────────────────────────────────────────
  // These replace the old generic HTTP_FETCH. Each one is narrow, typed and
  // independently enforceable; there is deliberately no "call any URL" channel.

  handle(IPC.SECURITY_MANIFEST, (_event, entries: unknown) => {
    const result = registerPluginManifest(entries);
    for (const reason of result.rejected) {
      securityLog().record({ type: "PERMISSION_REQUESTED", reason: `manifest rejected: ${reason}` });
    }
    return { accepted: result.accepted };
  });

  handle(IPC.NETWORK_REQUEST, async (_event, request: unknown) => {
    const rawId =
      request && typeof request === "object" && typeof (request as { pluginId?: unknown }).pluginId === "string"
        ? (request as { pluginId: string }).pluginId
        : "";

    // Rate limited per plugin, before any policy work, so a hostile caller
    // cannot use the policy evaluation itself as a CPU sink.
    //
    // Only a *registered* plugin gets its own bucket. Two earlier versions were
    // not enough:
    //
    //   1. no check at all — an arbitrary string off the payload minted a bucket
    //      per call, growing the limiter's Map without bound;
    //   2. a shape check only — `zz-0-not-a-real-id` is syntactically fine, so a
    //      caller could still mint thousands of *plausible-looking* buckets.
    //
    // That second case is the dangerous one, because the Map is capped by evicting
    // the lowest-token bucket: flooding with fake ids could evict a real plugin's
    // bucket while it was in cooldown, and the next genuine request would find no
    // bucket and be handed a **full** one. The cap turned a memory leak into a
    // rate-limit bypass.
    //
    // So identity is checked before the key is built, and everything unregistered
    // shares one `network:unknown` bucket. The Map cap stays as defence in depth
    // for a future caller that forgets this.
    const pluginId = isPluginRegistered(rawId) ? rawId : "unknown";
    const limit = consumeLimit(`network:${pluginId}`, "network");
    if (!limit.allowed) {
      securityLog().record({
        type: "RATE_LIMIT_TRIGGERED",
        pluginId,
        permission: "network-connect",
        reason: "network rate limit",
        count: limit.retryAfterMs,
      });
      return { ok: false, status: 0, text: "", truncated: false, blockedReason: "rate limited" };
    }
    return brokerRequest(request);
  });

  handle(IPC.SECURITY_STATUS, () => ({
    version: VERSION,
    trustedOrigins: true,
    senderValidation: true,
    networkLockedDown: describeBrokerPolicy().lockedDown,
    developerMode: isDeveloperMode(),
    safeMode: isSafeMode(),
    lockdown: isLockdown(),
    devTools: devToolsAllowed(),
    egressMonitor: egressGuardActive(),
    privacy: privacyStatus(egressGuardActive()),
    // The broker is registered for the whole session, and it is the layer that
    // actually refuses plugin requests. Reporting it separately stops the
    // observe-only monitor from being read as the network control.
    brokerEnforcing: true,
    permissionHandlers: permissionHandlersActive(),
    integrity: integrityStatus().state,
    encryptionAvailable: encryptionAvailable(),
  }));

  handle(IPC.SECURITY_EVENTS, (_event, limit: unknown) => {
    const max = typeof limit === "number" && Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 100;
    return securityLog().list(max);
  });

  handle(IPC.SECURITY_POLICY, () => describeBrokerPolicy());

  // ── Phase 4: user-approved host permissions ───────────────────────────────
  // The prompt itself lives in the renderer (Security Center). What crosses IPC
  // is the *decision*, and the decision is what the store validates: the
  // category must be one of the five grantable ones, and `script` is not one of
  // them, so there is no argument a compromised page can pass to make the
  // broker load remote code for a plugin.

  handle(IPC.SECURITY_PERMISSIONS, () => listGrants());

  handle(IPC.SECURITY_GRANT, (_event, request: unknown) => {
    if (!request || typeof request !== "object") {
      return { ok: false as const, reason: "permission request must be an object" };
    }
    const limit = consumeLimit("permission-prompt", "permissionPrompt");
    if (!limit.allowed) {
      securityLog().record({
        type: "RATE_LIMIT_TRIGGERED",
        permission: "permission-prompt",
        reason: "too many permission prompts",
      });
      return { ok: false as const, reason: "too many permission requests; try again later" };
    }
    const input = request as { pluginId?: unknown; category?: unknown; host?: unknown; methods?: unknown; trusted?: unknown };
    if (typeof input.pluginId !== "string") {
      return { ok: false as const, reason: "permission request has no plugin id" };
    }
    const result = grantPermission({
      pluginId: input.pluginId,
      category: typeof input.category === "string" ? input.category : "",
      host: typeof input.host === "string" ? input.host : "",
      methods: input.methods,
      // Only an explicit boolean true persists. An absent, string, or otherwise
      // malformed flag means a session-only grant — the safe direction.
      trusted: input.trusted === true,
    });
    if (!result.ok) return { ok: false as const, reason: result.reason };
    return { ok: true as const, grant: result.grant };
  });

  handle(IPC.SECURITY_REVOKE, (_event, key: unknown) => revokePermission(key));

  // Phase 5: the renderer reports egress it observed so the Security Center can
  // show the attempt. This channel is *reporting only* — it moves no data, and
  // the fixed field set (transport, host, reason, a size) means a compromised
  // page can at worst write noise into the log. A hostile page could also
  // fabricate events, which is a deliberate trade: showing nothing while data
  // leaves the machine would be worse.
  handle(IPC.REPORT_EGRESS, (_event, report: unknown) => {
    if (!report || typeof report !== "object") return;
    const r = report as { transport?: unknown; host?: unknown; reason?: unknown; detail?: unknown };
    const limit = consumeLimit("egress-report", "network");

    if (!limit.allowed) {
      // One record per cooldown, then silence.
      //
      // The limiter used to be consulted and then ignored for the write itself:
      // every refused call still reached `securityLog().record`, and each of
      // those is an event plus an append to the audit file. A page that reported
      // on a timer could therefore write thousands of identical lines, which is
      // exactly the I/O the rate limit exists to prevent — and it does it from
      // the one channel that is supposed to be cheap.
      //
      // `egressReportedFor` is keyed on the same bucket, so the suppression lasts
      // exactly as long as the cooldown and then resets.
      if (!egressReportedFor.has("egress-report")) {
        egressReportedFor.add("egress-report");
        securityLog().record({
          type: "RATE_LIMIT_TRIGGERED",
          reason: "egress report rate limit — further reports suppressed for this cooldown",
          origin: "renderer",
          count: limit.retryAfterMs,
        });
      }
      return;
    }
    egressReportedFor.delete("egress-report");

    // `EGRESS_OBSERVED`, not `NETWORK_BLOCKED`: the renderer observer passes
    // every request through. Labelling an observation as a block filled the
    // log with warnings about Discord's own Spotify and media traffic, which
    // trains the reader to ignore the entries that matter. Nothing is denied
    // here. The session layer is also observe-only; the Network Broker is the
    // layer that actually refuses unpermitted plugin traffic.
    securityLog().record({
      type: "EGRESS_OBSERVED",
      reason: typeof r.reason === "string" ? r.reason.slice(0, 200) : "observed",
      host: typeof r.host === "string" ? r.host.slice(0, 253) : undefined,
      channel: typeof r.transport === "string" ? r.transport.slice(0, 24) : undefined,
      origin: "renderer",
    });
  });

  handle(IPC.SECURITY_LOCKDOWN, (_event, locked: unknown) => {
    // Phase 14. Deliberately one-way for this session: once armed, page code
    // cannot silently disarm it. The renderer disables non-core plugins; the
    // network half is already effective in main, and survives a crash because
    // it does not live in the page.
    // Arm on any affirmative request, including a bare call with no argument.
    //
    // The bridge is `lockdown(): Promise<{locked:boolean}>` and invokes this
    // channel with *no* payload, so the old `locked === true` test saw
    // `undefined` and the Emergency Lockdown button in the Security Center did
    // nothing at all: a security control that silently never fires.
    //
    // Defaulting a missing argument to `true` is the safe direction — this
    // channel is one-way by design (there is no way to disarm it), so the only
    // question is whether a call is a request to arm, and the name says yes.
    // An explicit `false` is still refused.
    if (locked !== false) {
      cancelPendingUpdate();
      void cancelRecordingForSecurity();
      closePopoutChats();
      closeDrops();
      enableLockdown("Emergency Lockdown requested from the Security Center");
      forgetSecrets();
    }
    return { locked: isLockdown() };
  });

  handle(IPC.SECURITY_SAFE_MODE, (_event, enabled: unknown) => {
    // Phase 13. Safe Mode can be turned off from the UI (a user who started in
    // it may have fixed the problem), but it is never turned *on* by page code
    // outside a user action, and the request itself is rate limited.
    if (enabled === false) exitSafeMode();
    return { safeMode: isSafeMode() };
  });

  // ── Captcha solver ──────────────────────────────────────────────────────────
  // A paid third-party call carrying a credential the page never holds. Five
  // narrow channels rather than one "call this URL" channel: the request shape
  // is decided in `captchaSolver`, and nothing crossing here can name a host, a
  // header or a timeout.

  handle(CAPTCHA_IPC.STATUS, () => captchaKeyStatus());

  handle(CAPTCHA_IPC.SET_KEY, (_event, key: unknown) => {
    const result = saveCaptchaKey(key);
    if (!result.ok && result.reason !== undefined) throw new Error(result.reason);
    return result;
  });

  handle(CAPTCHA_IPC.CLEAR_KEY, () => clearCaptchaKey());

  handle(CAPTCHA_IPC.SOLVE, async (_event, input: unknown) => {
    // Rate limited before any work, and separately from the shared IPC bucket:
    // a solve costs the user money, so the ceiling belongs to this channel.
    const limit = consumeLimit("captcha:solve", "captchaSolve");
    if (!limit.allowed) {
      securityLog().record({
        type: "RATE_LIMIT_TRIGGERED",
        channel: CAPTCHA_IPC.SOLVE,
        reason: "captcha solve rate limit",
        count: limit.retryAfterMs,
      });
      return {
        ok: false as const,
        code: "rate_limited",
        message: "Too many captcha solves; try again shortly.",
        retryable: true,
        solveId: null,
      };
    }
    return solveCaptcha(input);
  });

  handle(CAPTCHA_IPC.FEEDBACK, (_event, input: unknown) => reportCaptchaFeedback(input));

  // ── Update service ─────────────────────────────────────────────────────────
  //
  // These are *not* plugin capabilities and deliberately do not go through the
  // Network Broker. The broker is the plugin permission model: a plugin needs a
  // declared host and a user grant. Auto-update is a first-class client
  // feature that has to keep working when Safe Mode or Lockdown has stopped
  // every plugin — a client that cannot be repaired from inside itself is
  // worse than one that can.
  //
  // The cost of that decision is that this is a privileged path the broker does
  // not see, so it is held to the same standard by construction instead of by
  // policy: the host is a constant in `src/shared/release.ts`, the payload is
  // Ed25519-signed, the digest in that signature is what the download is
  // checked against, and nothing here writes into a Discord install. See the
  // trust-model comment at the top of `src/main/security/updater.ts`.
  //
  // `UPDATE_CHECK`, `UPDATE_STAGE` and `UPDATE_HANDOFF` are rate limited by the
  // shared `handle` wrapper. `UPDATE_STATUS` is exempt, because the settings UI
  // polls it while a download is in progress and a tripped bucket would show
  // the user a stalled progress bar for a transfer that is still running.

  handle(IPC.UPDATE_CHECK, async (_event, channel: unknown) => {
    // Rate limited on its own key rather than the shared `ipc` bucket, so a
    // loop hammering this channel cannot starve the settings UI's status polls.
    const limit = consumeLimit("update:check", "network");
    if (!limit.allowed) {
      securityLog().record({
        type: "RATE_LIMIT_TRIGGERED",
        channel: IPC.UPDATE_CHECK,
        reason: "update check rate limit",
        count: limit.retryAfterMs,
      });
      return updateStatus();
    }
    return checkForUpdate({ channel });
  });

  handle(IPC.UPDATE_STATUS, () => updateStatus());

  handle(IPC.UPDATE_RESTART, () => restartForUpdate());

  handle(IPC.UPDATE_STAGE, async () => {
    const limit = consumeLimit("update:stage", "network");
    if (!limit.allowed) {
      securityLog().record({
        type: "RATE_LIMIT_TRIGGERED",
        channel: IPC.UPDATE_STAGE,
        reason: "update download rate limit",
        count: limit.retryAfterMs,
      });
      return updateStatus();
    }
    return stageUpdate();
  });

  handle(IPC.UPDATE_HANDOFF, (_event, injectorPath: unknown) => {
    const limit = consumeLimit("update:handoff", "network");
    if (!limit.allowed) {
      securityLog().record({
        type: "RATE_LIMIT_TRIGGERED",
        channel: IPC.UPDATE_HANDOFF,
        reason: "update hand-off rate limit",
        count: limit.retryAfterMs,
      });
      return updateStatus();
    }
    // `injectorPath` is the user's configured installer location, and it is
    // optional: when it is absent — or empty — `handOffToInjector` discovers the
    // Installer itself from a fixed list of read-only candidates. A supplied
    // value is validated there (absolute, resolves to a regular file). Either
    // way it is spawned with `shell: false` and an argument vector, never
    // through a shell string.
    return handOffToInjector(injectorPath);
  });

  // Turning automatic updates off has to clear what a previous check accepted,
  // or the Download button keeps offering a release the user has switched off
  // checking for. Not rate limited: it performs no network or process work, and
  // a tripped bucket would leave the UI showing a button that can no longer do
  // anything.
  handle(IPC.UPDATE_RESET, () => {
    resetUpdateState();
    return updateStatus();
  });

  // Where the Installer was found, or `null`. Read-only, and it exists so the
  // settings UI can say "found at …" instead of leaving the user to guess
  // whether one-click install will work.
  handle(IPC.UPDATE_INJECTOR, () => ({
    found: discoverInjector(),
    searched: injectorSearchPaths(),
  }));

  console.log(`${LOG_PREFIX} IPC handlers registered (sender validation on)`);
}
