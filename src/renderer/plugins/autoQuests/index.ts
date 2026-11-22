import {simulateGame, type RunningGames} from '../../api/gameSimulation';
import { messageRef as i18nMessage, canonicalMessage, type MessageRef, localizeError, t as i18nText } from "../../i18n";
import { definePlugin } from "../../api/plugin";
import type { PluginContext } from "../../api/plugin/types";
import { startClaimWatcher, stopClaimWatcher } from "./claim";
import { startHcaptchaBridge, stopHcaptchaBridge } from "./hcaptcha";
import {
  currentQuest as current,
  enrollmentStatus,
  findModules,
  questsOf as quests,
  readServerQuests,
  serverQuest,
  shortError,
  wait,
  type Modules,
  type Quest,
  type QuestStore,
} from "./modules";

type TaskKey = "WATCH_VIDEO" | "WATCH_VIDEO_ON_MOBILE" | "PLAY_ON_DESKTOP" | "PLAY_ACTIVITY";

// STREAM_ON_DESKTOP needs a real voice call with a viewer, and ACHIEVEMENT_* needs
// in-game progress; neither can be credited from here, so they stay unsupported.
const KEYS: TaskKey[] = ["WATCH_VIDEO", "WATCH_VIDEO_ON_MOBILE", "PLAY_ON_DESKTOP", "PLAY_ACTIVITY"];
const CHANGE = "Syncord-auto-quests-change";
let context: PluginContext | undefined;
let controller: AbortController | undefined;
let status = i18nMessage("ui.ready");

export function questRunnerState(): { running: boolean; stopping: boolean; status: string } {
  const params=status.key==="ui.error_value"?{...status.params,v0:localizeError(status.params.v0)}
    :status.key==="ui.value_skipped_value"?{...status.params,v1:localizeError(status.params.v1)}:status.params;
  return { running: !!controller, stopping: !!controller?.signal.aborted, status:i18nText(status.key,params) };
}

function update(message: MessageRef): void {
  status = message;
  window.dispatchEvent(new Event(CHANGE));
  context?.log.info(canonicalMessage(message.key,message.params));
}

export const questRunnerChangeEvent = CHANGE;

function task(q: Quest): { key: TaskKey; target: number; appId?: string } | undefined {
  const entries = q.config?.taskConfigV2?.tasks ?? q.config?.taskConfig?.tasks ?? {};
  for (const key of KEYS) {
    const value = entries[key];
    const target = Number(value?.target);
    const appId = value?.applications?.[0]?.id ?? q.config?.application?.id;
    if (Number.isFinite(target) && target > 0 && (key !== "PLAY_ON_DESKTOP" || appId)) {
      return { key, target, appId };
    }
  }
  return undefined;
}

function progress(q: Quest | undefined, key: TaskKey): number {
  const raw = q?.userStatus?.progress;
  const entry = raw instanceof Map ? raw.get(key) : raw?.[key];
  return Math.max(0, Number(entry?.value ?? q?.userStatus?.streamProgressSeconds ?? 0));
}

function eligible(q: Quest): boolean {
  return Date.parse(q.config?.expiresAt ?? "") > Date.now() &&
    !q.userStatus?.completedAt && !!task(q);
}

function choice(store: QuestStore, skipped: Set<string>): Quest | undefined {
  const pool = quests(store).filter((q) => eligible(q) && !skipped.has(q.id));
  const existing = pool.filter((q) => !!q.userStatus?.enrolledAt);
  if (existing.length) return existing[0];
  if (!pool.length) return undefined;
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return pool[random[0]! % pool.length];
}

async function enroll(q: Quest, m: Modules, signal: AbortSignal): Promise<void> {
  // İlk GET başarısızsa POST yapma: yanlış API modülünü seçmiş olabiliriz.
  const server = await readServerQuests(m.api);
  if (signal.aborted) return;
  if (q.userStatus?.enrolledAt || current(m.store, q.id)?.userStatus?.enrolledAt) return;
  // Önceki çalıştırmada POST başarılı olup yerel QuestStore eski kalmış olabilir.
  let verified = enrollmentStatus(serverQuest(server, q.id));
  if (signal.aborted) return;
  let responseStatus: number | undefined;
  if (!verified) {
    update(i18nMessage("ui.enrolling_value", {v0: q.config?.messages?.questName ?? q.id}));
    const response = await m.api.post({
      url: `/quests/${q.id}/enroll`,
      body: {
        location: 11,
        is_targeted: false,
        metadata_sealed: null,
        traffic_metadata_sealed: current(m.store, q.id)?.trafficMetadataSealed ?? null,
      },
    });
    responseStatus = response.status;
    verified = enrollmentStatus(response.body);
  }
  if (signal.aborted) return;
  // Ham POST, Discord'un Flux store'unu kendiliğinden güncellemez.
  // Bu yüzden başarıyı yerel store'dan değil sunucunun /quests/@me yanıtından doğrula.
  for (let attempt = 0; attempt < 3 && !verified; attempt++) {
    await wait(1000, signal);
    verified = enrollmentStatus(serverQuest(await readServerQuests(m.api), q.id));
  }
  if (!verified) throw new Error(`Enrollment could not be verified by the server (HTTP ${responseStatus ?? "?"})`);
  if (signal.aborted) return;
  // Discord'un kendi kabul eyleminin Flux sinyalini göndererek Quest arayüzünü yenile.
  // Sunucu doğrulaması başarısızsa bu sinyal hiçbir zaman gönderilmez.
  try {
    m.dispatcher.dispatch({
      type: "QUESTS_ENROLL_SUCCESS",
      enrolledQuestUserStatus: { ...verified, questId: verified.questId ?? q.id },
    });
  } catch (error) {
    context?.log.warn("Enrollment verified by the server, but QuestStore could not be updated:", error);
  }
  update(i18nMessage("ui.enrolled_value", {v0: q.config?.messages?.questName ?? q.id}));
}

async function video(q: Quest, key: TaskKey, target: number, m: Modules, signal: AbortSignal): Promise<boolean> {
  let done = progress(current(m.store, q.id) ?? q, key);
  let stalled = 0;
  while (!signal.aborted && done < target) {
    await wait(8000, signal);
    const next = Math.min(target, done + 8);
    const response = await m.api.post({
      url: `/quests/${q.id}/video-progress`,
      body: { timestamp: next },
    });
    if (signal.aborted) return false;
    const body = response.body;
    const credited = Number(body?.progress?.[key]?.value ?? progress(current(m.store, q.id), key));
    if (body?.completed_at || body?.completedAt) return true;
    if (Number.isFinite(credited) && credited > done) {
      done = credited;
      stalled = 0;
    } else if (++stalled >= 4) {
      throw new Error("Video progress is not increasing on the server");
    }
    update(i18nMessage("ui.value_value_value_seconds", {v0: q.config?.messages?.questName ?? q.id, v1: Math.floor(done), v2: target}));
  }
  return !signal.aborted && (done >= target || !!current(m.store, q.id)?.userStatus?.completedAt);
}

async function game(q: Quest, appId: string, target: number, m: Modules, signal: AbortSignal): Promise<boolean> {
  const wp = window.Syncord?.webpack;
  const running = wp?.findByStoreName("RunningGameStore") as RunningGames | undefined;
  if (!running?.getRunningGames || !running?.getGameForPID) throw new Error("RunningGameStore was not found");
  const publicApp = await m.api.get({ url: `/applications/public?application_ids=${encodeURIComponent(appId)}` });
  if (signal.aborted) return false;
  const app = publicApp.body?.[0];
  const name = app?.name ?? q.config?.applicationName ?? i18nText("ui.quest_game");
  const start=Date.now();
  const exeName=app?.executables?.find((x: {os?:string;name?:string})=>x.os==="win32")?.name?.split(/[\\/]/).pop();
  let release:(()=>void)|undefined;
  let subscribed = false;
  let lastBeat = Date.now();
  let credited = progress(current(m.store, q.id) ?? q, "PLAY_ON_DESKTOP");
  let failures = 0;
  let lastFailure = "";
  const onBeat = (payload: any) => {
    if (payload?.questId !== q.id) return;
    lastBeat = Date.now();
    failures = 0;
    credited = Math.max(credited, progress({ userStatus: payload.userStatus } as Quest, "PLAY_ON_DESKTOP"));
    update(i18nMessage("ui.value_value_value_seconds", {v0: name, v1: Math.floor(credited), v2: target}));
  };
  const onFailure = (payload: any) => {
    if (payload?.questId !== q.id) return;
    lastBeat = Date.now();
    failures++;
    const error = payload?.error ?? payload;
    lastFailure = i18nText("ui.http_value_value", {v0: error?.status ?? error?.httpStatus ?? "?", v1: error?.body?.message ?? localizeError(error) ?? i18nText("ui.heartbeat_rejected")});
    context?.log.warn(`${name}: ${lastFailure}`);
  };
  try {
    m.dispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", onBeat);
    m.dispatcher.subscribe("QUESTS_SEND_HEARTBEAT_FAILURE", onFailure);
    subscribed = true;
    release=simulateGame(context!,running,m.dispatcher,{id:appId,name,icon:app?.icon,exeName},start,'quest');
    while (!signal.aborted && credited < target) {
      await wait(5000, signal);
      credited = Math.max(credited, progress(current(m.store, q.id), "PLAY_ON_DESKTOP"));
      if (failures >= 3) throw new Error(`Heartbeat error: ${lastFailure}`);
      if (Date.now() - lastBeat > 150000) throw new Error("No heartbeat received for 150 seconds");
    }
    return !signal.aborted && credited >= target;
  } finally {
    if (subscribed) {
      m.dispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", onBeat);
      m.dispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_FAILURE", onFailure);
    }
    release?.();
  }
}

/** Discord Activity quests: credited by `/heartbeat` against any call-shaped stream key. */
async function activity(q: Quest, target: number, m: Modules, signal: AbortSignal): Promise<boolean> {
  const wp = window.Syncord?.webpack;
  const channels = wp?.findByStoreName("ChannelStore") as { getSortedPrivateChannels?: () => Array<{ id?: string }> } | undefined;
  const selected = wp?.findByStoreName("SelectedChannelStore") as { getChannelId?: () => string | null } | undefined;
  const channelId = channels?.getSortedPrivateChannels?.()?.[0]?.id ?? selected?.getChannelId?.();
  if (!channelId) throw new Error("No channel is available for an activity heartbeat");
  const streamKey = `call:${channelId}:1`;
  let done = progress(current(m.store, q.id) ?? q, "PLAY_ACTIVITY");
  let stalled = 0;
  while (!signal.aborted) {
    const response = await m.api.post({ url: `/quests/${q.id}/heartbeat`, body: { stream_key: streamKey, terminal: false } });
    if (signal.aborted) return false;
    const credited = Number(response.body?.progress?.PLAY_ACTIVITY?.value);
    if (response.body?.completed_at || response.body?.completedAt) return true;
    if (Number.isFinite(credited) && credited > done) { done = credited; stalled = 0; }
    else if (++stalled >= 4) throw new Error("Activity progress is not increasing on the server");
    update(i18nMessage("ui.value_value_value_seconds", {v0: q.config?.messages?.questName ?? q.id, v1: Math.floor(done), v2: target}));
    if (done >= target) {
      await m.api.post({ url: `/quests/${q.id}/heartbeat`, body: { stream_key: streamKey, terminal: true } });
      return !signal.aborted;
    }
    await wait(20000, signal);
  }
  return false;
}

async function run(signal: AbortSignal): Promise<void> {
  const m = findModules();
  const skipped = new Set<string>();
  while (!signal.aborted) {
    const q = choice(m.store, skipped);
    if (!q) {
      const unsupported = quests(m.store).filter((x) => Date.parse(x.config?.expiresAt ?? "") > Date.now() && !x.userStatus?.completedAt && !task(x));
      for (const x of unsupported) {
        context?.log.info(`Quest ${x.config?.messages?.questName ?? x.id} skipped: unsupported task ${Object.keys(x.config?.taskConfigV2?.tasks ?? x.config?.taskConfig?.tasks ?? {}).join(", ") || "?"}`);
      }
      update(i18nMessage("ui.no_eligible_quests_remaining"));
      return;
    }
    const t = task(q)!;
    try {
      await enroll(q, m, signal);
      if (signal.aborted) return;
      update(i18nMessage("ui.value_value_started", {v0: q.config?.messages?.questName ?? q.id, v1: t.key}));
      const complete = t.key === "PLAY_ON_DESKTOP"
        ? await game(q, t.appId!, t.target, m, signal)
        : t.key === "PLAY_ACTIVITY"
          ? await activity(q, t.target, m, signal)
          : await video(q, t.key, t.target, m, signal);
      if (signal.aborted) return;
      if (!complete) throw new Error("The server did not confirm completion");
      update(i18nMessage("ui.value_completed", {v0: q.config?.messages?.questName ?? q.id}));
    } catch (error) {
      if (signal.aborted) return;
      context?.log.error(`Quest ${q.id}: ${shortError(error)}`);
      update(i18nMessage("ui.value_skipped_value", {v0: q.config?.messages?.questName ?? q.id, v1: shortError(error)}));
      // Temel API erişimi yoksa kalan görevler de ilerleyemez.
      if (shortError(error).includes("Quest API")) return;
    }
    skipped.add(q.id); // Aynı oturumda başarısız görevi sonsuza kadar deneme.
    await wait(1500, signal);
  }
}

export function stopQuestRunner(): void {
  if (!controller) return;
  controller.abort();
  update(i18nMessage("ui.stopping"));
}

export function toggleQuestRunner(): void {
  if (controller) {
    if (!controller.signal.aborted) stopQuestRunner();
    return;
  }
  if (!context) { update(i18nMessage("ui.enable_the_plugin_first")); return; }
  const next = new AbortController();
  controller = next;
  update(i18nMessage("ui.scanning_quests"));
  void run(next.signal).catch((error) => {
    if (!next.signal.aborted) {
      context?.log.error(`Quest runner failed: ${shortError(error)}`);
      update(i18nMessage("ui.error_value", {v0: shortError(error)}));
    }
  }).finally(() => {
    if (controller === next) {
      controller = undefined;
      if (next.signal.aborted) update(i18nMessage("ui.stopped"));
      else window.dispatchEvent(new Event(CHANGE));
    }
  });
}

export const AutoQuestsPlugin = definePlugin({
  id: "auto-quests",
  name: i18nText("ui.auto_quests"),
  get description() { return i18nText("ui.process_eligible_video_and_desktop_game_quests_one_at_a_time"); },
  author: i18nText("ui.syncord"),
  enabledByDefault: false,

  /**
   * Drives Discord's own quest UI through the click action, and stores its
   * progress. Every request the *runner* induces is Discord's own — it declares
   * no network permission, so the broker would refuse anything it tried to send
   * itself.
   *
   * The auto-claimer is the one part of this plugin that talks to something
   * that is not Discord, and it does so through `ctx.captcha` rather than
   * `ctx.network`: the solver needs a paid credential the page must not hold,
   * so the request is made in the main process against one fixed host. The
   * capability is also pinned to this plugin id in the context factory, so the
   * declaration below cannot become a general-purpose captcha oracle.
   */
  permissions: {
    // The quest runner wraps Discord's own quest click handler, so it needs
    // webpack patching. Without this declaration `ctx.patch` is a no-op and the
    // whole plugin is silently inert — which is what happened until Phase 31's
    // manual pass caught it.
    webpackPatch: true,
    discordStores: ["quest", "RunningGameStore", "ChannelStore", "SelectedChannelStore"],
    discordActions: ["LOCAL_ACTIVITY_UPDATE", "RUNNING_GAMES_CHANGE"],
    native: ["captcha-solve"],
  },

  start(ctx) {
    context = ctx;
    // Independent of the Start/Stop runner: auto-claiming is a switch, not a
    // job the user launches, and it has to survive the runner being idle.
    startClaimWatcher(ctx);
    // Discord's own captcha flows are answered the same way, so a captcha that
    // comes from Discord's UI rather than from our requests is also click-free.
    startHcaptchaBridge(ctx);
    update(i18nMessage("ui.ready"));
  },
  stop() {
    stopHcaptchaBridge();
    stopClaimWatcher();
    stopQuestRunner();
    context = undefined;
  },
});