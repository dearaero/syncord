import { definePlugin } from "../../api/plugin";
import { settings } from "../../api/settings";
import { BodyMutationObserver } from "../../ui/bodyObserver";
import { showToast, ToastType } from "../../ui/toast";
import { canonicalMessage, getLocale, onLocaleChange, t } from "../../i18n";
import { channelLog, onLogChange, whenLogReady, type LogEntry } from "../messageLogger/log";
import { buildTimeline, contentAt, createdAt, cutAt, deletedBefore, density, snowflakeAt, stepDelay, type TmEvent } from "./model";
import { CSS, STRIP_ID } from "./styles";

/**
 * Time Machine: rewinds the open channel in place, event by event, from the
 * rows Message Logger already keeps. It owns no log of its own; with Logger
 * off the channel has no rows and the strip never appears.
 *
 * Painting follows Message Logger's pattern: classes and small marker nodes on
 * Discord's `li[id^=chat-messages-]` rows, reapplied after Discord re-renders,
 * and all removed on exit.
 */
const SPEEDS = [1, 4, 16] as const;
const BINS = 48;
const MARKERS = ".tm-note,.tm-text";
const ROW_CLASSES = ["tm-future", "tm-ghost", "tm-alive", "tm-focus"];

type UserLike = { globalName?: string; global_name?: string; username?: string };
type Stores = {
  MessageStore?: { getMessages?: (id: string) => { hasMoreAfter?: unknown } | undefined };
  UserStore?: { getUser?: (id: string) => UserLike | undefined };
  SelectedChannelStore?: { getChannelId?: () => string | undefined };
};
const stores = (): Stores => (window.Syncord?.common?.stores ?? {}) as Stores;
const loggerEnabled = (): boolean => settings.get<boolean>("plugins.message-logger.enabled", true) !== false;

function chatList(): HTMLOListElement | undefined {
  const list = document.querySelector('[data-list-id="chat-messages"]');
  return list instanceof HTMLOListElement ? list : undefined;
}

function composerFor(list: HTMLElement | undefined): HTMLFormElement | undefined {
  const scope = list?.closest('[class*="chatContent"]') ?? document;
  const form = scope.querySelector('[class*="channelTextArea"]')?.closest("form");
  return form instanceof HTMLFormElement ? form : undefined;
}

/** Discord's own jump loads history around a message, exactly like clicking a reply. */
function jumpTo(channelId: string, messageId: string): Promise<unknown> | undefined {
  const preferred = window.Syncord?.common?.actions.MessageActions as { jumpToMessage?: unknown } | undefined;
  const found = window.Syncord?.webpack?.findByProps?.("jumpToMessage", "fetchMessages") as { jumpToMessage?: unknown } | undefined;
  const jump = typeof preferred?.jumpToMessage === "function" ? preferred.jumpToMessage
    : typeof found?.jumpToMessage === "function" ? found.jumpToMessage : undefined;
  if (!jump) return undefined;
  try { return Promise.resolve((jump as (o: Record<string, unknown>) => unknown).call(preferred ?? found, { channelId, messageId, flash: false })).catch(() => undefined); }
  catch { return undefined; }
}

function when(at: number): string {
  const date = new Date(at), today = new Date().toDateString() === date.toDateString();
  return date.toLocaleString(getLocale(), today ? { hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export const TimeMachinePlugin = definePlugin({
  id: "time-machine",
  name: canonicalMessage("tm.name"),
  get description() { return t("tm.description"); },
  enabledByDefault: false,
  permissions: {
    media: true,
    native: ["chat-snapshot"],
    discordStores: ["UserStore", "SelectedChannelStore", "message"],
  },

  start(ctx) {
    ctx.css.inject(CSS);
    let stopped = false, channelId = "", rows = new Map<string, LogEntry>(), events: TmEvent[] = [], pos = 0;
    let speed: number = SPEEDS[1], timer = 0, frame = 0, lastFocus = "";
    // Scrolling target for the current position: "moment" shows the chat as it
    // stood at the cut; "event" shows the message the event happened to.
    let want: "moment" | "event" | "" = "", jumpedFor = -1, loading = false, loadedAt = 0;
    /** One history load at a time; playback waits for it instead of racing ahead. */
    const load_ = (messageId: string): boolean => {
      if (loading) return true;
      const pending = jumpTo(channelId, messageId);
      if (!pending) return false;
      loading = true;
      void pending.finally(() => { loading = false; loadedAt = Date.now(); schedule(); window.setTimeout(schedule, 1600); });
      return true;
    };
    const active = (): boolean => pos < events.length;

    // ── strip ──
    const strip = document.createElement("div");
    strip.id = STRIP_ID;
    strip.setAttribute("role", "group");
    strip.innerHTML = `<span class="tm-badge" hidden></span><button type="button" data-tm="play"></button>
      <div class="tm-track"><input type="range" min="0" step="1"><div class="tm-heat" aria-hidden="true"></div></div>
      <div class="tm-info"><span class="tm-label" aria-live="polite"></span><span class="tm-hint"></span></div>
      <button type="button" data-tm="speed"></button><button type="button" data-tm="snap">📷</button><button type="button" data-tm="now">⟳</button>`;
    const q = <T extends Element>(sel: string): T => strip.querySelector(sel) as T;
    const badge = q<HTMLElement>(".tm-badge"), range = q<HTMLInputElement>("input"), heat = q<HTMLElement>(".tm-heat");
    const label = q<HTMLElement>(".tm-label"), hint = q<HTMLElement>(".tm-hint");
    const play = q<HTMLButtonElement>('[data-tm="play"]'), speedBtn = q<HTMLButtonElement>('[data-tm="speed"]');
    const snap = q<HTMLButtonElement>('[data-tm="snap"]'), now = q<HTMLButtonElement>('[data-tm="now"]');

    const userName = (id: string, fallback = ""): string => {
      const user = id ? stores().UserStore?.getUser?.(id) : undefined;
      return user?.globalName || user?.global_name || user?.username || fallback || t("tm.someone");
    };
    const describe = (event: TmEvent): string => {
      const user = userName(event.actor, rows.get(event.messageId)?.author), emoji = event.emoji ?? "";
      const text = { delete: t("tm.evDelete", { user }), edit: t("tm.evEdit", { user }), react: t("tm.evReact", { user, emoji }),
        unreact: t("tm.evUnreact", { user, emoji }), pin: t("tm.evPin"), unpin: t("tm.evUnpin") }[event.kind];
      return `${when(event.at)} · ${text}`;
    };

    const renderStrip = (): void => {
      const on = active(), event = events[pos];
      range.max = String(events.length);
      range.value = String(pos);
      range.setAttribute("aria-label", t("tm.slider"));
      range.setAttribute("aria-valuetext", event ? describe(event) : t("tm.present"));
      label.textContent = event ? describe(event) : "";
      hint.textContent = on ? t("tm.locked") : "";
      badge.hidden = !on;
      badge.textContent = event ? `⏪ ${when(event.at)}` : "";
      play.textContent = timer ? "❚❚" : "▶";
      play.title = play.ariaLabel = timer ? t("tm.pause") : t("tm.play");
      speedBtn.textContent = `${speed}×`;
      speedBtn.title = speedBtn.ariaLabel = t("tm.speed");
      snap.title = snap.ariaLabel = t("tm.snapshot");
      now.title = now.ariaLabel = t("tm.present");
      now.hidden = !on;
    };
    const renderHeat = (): void => {
      heat.replaceChildren(...density(events, BINS).map((level) => {
        const bin = document.createElement("span");
        bin.style.opacity = String(level ? 0.2 + level * 0.8 : 0.06);
        return bin;
      }));
    };

    // ── in-place painting ──
    const clearRow = (li: HTMLElement): void => {
      li.classList.remove(...ROW_CLASSES);
      for (const node of li.querySelectorAll(MARKERS)) node.remove();
      for (const node of li.querySelectorAll(".tm-hidden")) node.classList.remove("tm-hidden");
    };
    const paintRow = (li: HTMLElement, cut: number, prefix: string): void => {
      const id = li.id.slice(prefix.length), row = rows.get(id), created = createdAt(id);
      const future = Number.isFinite(created) && created >= cut, ghost = !!row && !future && deletedBefore(row, cut);
      li.classList.toggle("tm-future", future);
      li.classList.toggle("tm-ghost", ghost);
      li.classList.toggle("tm-alive", !!row?.deleted && !ghost);
      li.classList.toggle("tm-focus", events[pos]?.messageId === id);
      let note = li.querySelector<HTMLElement>(":scope > .tm-note");
      if (ghost && row?.deleted) {
        if (!note) { note = document.createElement("div"); note.className = "tm-note"; li.prepend(note); }
        // Unconditional writes would re-trigger our own body observer every frame.
        const label = t("tm.deletedAt", { time: when(row.deleted) });
        if (note.textContent !== label) note.textContent = label;
      } else note?.remove();
      const body = li.querySelector<HTMLElement>('[id^="message-content-"]');
      const old = row && !future && row.edits?.length ? contentAt(row, cut) : undefined;
      let text = body?.parentElement?.querySelector<HTMLElement>(":scope > .tm-text");
      if (body && old !== undefined && old !== row?.content) {
        if (!text) { text = document.createElement("div"); text.className = "tm-text"; body.after(text); }
        if (text.textContent !== old) text.textContent = old;
        body.classList.add("tm-hidden");
      } else { text?.remove(); body?.classList.remove("tm-hidden"); }
    };
    const paint = (): void => {
      const list = chatList();
      if (!list) return;
      const on = active();
      list.classList.toggle("tm-active", on);
      composerFor(list)?.classList.toggle("tm-locked", on);
      const prefix = `chat-messages-${channelId}-`;
      const cut = cutAt(events, pos);
      for (const li of list.querySelectorAll<HTMLElement>(`li[id^="${prefix}"]`)) {
        if (on) paintRow(li, cut, prefix); else clearRow(li);
      }
      lastFocus = on ? events[pos]?.messageId ?? "" : "";
      if (on && want) reveal(list, prefix, cut);
    };
    /**
     * Brings the rewound moment on screen. The last message written before the
     * cut goes to the bottom of the view, as the chat looked then. When the
     * loaded window does not reach that moment, Discord loads history around
     * the event's message once; the next paint after it renders finishes this.
     */
    const reveal = (list: HTMLElement, prefix: string, cut: number): void => {
      const items = [...list.querySelectorAll<HTMLElement>(`li[id^="${prefix}"]`)];
      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      const focus = events[pos]?.messageId ?? "";
      if (want === "event") {
        const target = document.getElementById(prefix + focus);
        if (target) { target.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" }); want = ""; }
        else if (jumpedFor !== pos && focus) { jumpedFor = pos; if (!load_(focus)) want = ""; }
        return;
      }
      // Message Logger re-inserts deleted rows at the edge of whatever window is
      // loaded, so only live rows say which stretch of history Discord has.
      const live = items.filter((li) => !rows.get(li.id.slice(prefix.length))?.deleted);
      const times = live.map((li) => createdAt(li.id.slice(prefix.length)));
      const atPresent = stores().MessageStore?.getMessages?.(channelId)?.hasMoreAfter === false;
      const covers = times.length > 0 && times[0] < cut && (times[times.length - 1] >= cut || atPresent);
      let anchor: HTMLElement | undefined;
      for (const li of items) if (createdAt(li.id.slice(prefix.length)) < cut) anchor = li;
      // A synthetic id for the moment itself: never cached, so Discord always fetches around it.
      if (loading) return;
      if (!covers && jumpedFor !== pos) { jumpedFor = pos; if (load_(snowflakeAt(cut))) return; }
      // Discord renders the fetched page a little after its action settles; keep the target until it does.
      if (!covers && Date.now() - loadedAt < 1500) return;
      anchor?.scrollIntoView({ block: "end", behavior: reduce ? "auto" : "smooth" });
      want = "";
    };
    const clearAll = (): void => {
      for (const list of document.querySelectorAll("ol.tm-active")) list.classList.remove("tm-active");
      for (const form of document.querySelectorAll("form.tm-locked")) form.classList.remove("tm-locked");
      for (const node of document.querySelectorAll(MARKERS)) node.remove();
      for (const node of document.querySelectorAll(".tm-hidden")) node.classList.remove("tm-hidden");
      for (const li of document.querySelectorAll<HTMLElement>(ROW_CLASSES.map((c) => `li.${c}`).join(","))) li.classList.remove(...ROW_CLASSES);
      lastFocus = "";
    };

    // ── state ──
    const stopPlay = (): void => { if (timer) window.clearTimeout(timer); timer = 0; };
    const seek = (next: number): void => {
      const target = Math.max(0, Math.min(events.length, next));
      if (target !== pos) want = "moment";
      pos = target;
      if (!active()) stopPlay();
      renderStrip();
      paint();
    };
    const toPresent = (): void => {
      const wasActive = active();
      stopPlay();
      seek(events.length);
      if (wasActive) chatList()?.querySelector("li:last-of-type")?.scrollIntoView({ block: "end" });
    };
    const tick = (): void => {
      timer = 0;
      if (stopped) return;
      if (loading) { timer = window.setTimeout(tick, 150); return; }
      seek(pos + 1);
      if (active()) timer = window.setTimeout(tick, stepDelay(speed));
      renderStrip();
    };
    const load = (): void => {
      const wasPresent = !active();
      const list = channelId && loggerEnabled() ? channelLog(channelId) : [];
      rows = new Map(list.map((row) => [row.id, row]));
      events = buildTimeline(list);
      pos = wasPresent ? events.length : Math.min(pos, events.length);
      renderHeat();
      renderStrip();
    };

    const mount = (): void => {
      const list = chatList(), form = composerFor(list);
      if (!events.length || !form) { if (strip.isConnected) { toPresent(); strip.remove(); } return; }
      if (strip.parentElement !== form) form.prepend(strip);
    };
    const sync = (): void => {
      frame = 0;
      if (stopped) return;
      const selected = stores().SelectedChannelStore?.getChannelId?.() ?? "";
      if (selected !== channelId) { stopPlay(); clearAll(); channelId = selected; pos = Number.MAX_SAFE_INTEGER; load(); }
      mount();
      if (active()) paint();
    };
    const schedule = (): void => { if (!frame && !stopped) frame = requestAnimationFrame(sync); };

    // ── controls ──
    range.addEventListener("input", () => { stopPlay(); seek(Number(range.value)); });
    play.addEventListener("click", () => {
      if (timer) { stopPlay(); renderStrip(); return; }
      if (!active()) seek(0);
      timer = window.setTimeout(tick, stepDelay(speed));
      renderStrip();
    });
    speedBtn.addEventListener("click", () => {
      speed = SPEEDS[(SPEEDS.indexOf(speed as (typeof SPEEDS)[number]) + 1) % SPEEDS.length];
      renderStrip();
    });
    now.addEventListener("click", toPresent);
    label.addEventListener("click", () => { if (active()) { want = "event"; jumpedFor = -1; paint(); } });
    snap.addEventListener("click", () => {
      const area = chatList()?.closest('[class*="scroller"]') ?? chatList();
      if (!area) return;
      const r = area.getBoundingClientRect();
      const x = Math.max(0, r.left), y = Math.max(0, r.top);
      const rect = { x, y, width: Math.min(innerWidth, r.right) - x, height: Math.min(innerHeight, r.bottom) - y };
      void ctx.snapshot.copy(rect).then(
        () => showToast(t("tm.copied"), { type: ToastType.SUCCESS }),
        (error: unknown) => { ctx.log.warn("snapshot failed:", error); showToast(t("tm.snapshotFailed"), { type: ToastType.FAILURE }); },
      );
    });
    // Visually locked composer: any attempt to write returns to the present first.
    const onKey = (event: KeyboardEvent): void => {
      if (!active() || strip.contains(event.target as Node)) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); toPresent(); return; }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) toPresent();
    };
    const onFocus = (event: FocusEvent): void => {
      if (active() && event.target instanceof Element && event.target.closest("form.tm-locked")
        && !strip.contains(event.target)) toPresent();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocus, true);

    const observer = new BodyMutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    const offLog = onLogChange((changed) => { if (changed === channelId) { load(); schedule(); } });
    const offLocale = onLocaleChange(() => { renderStrip(); if (active()) paint(); });
    void whenLogReady().then(() => { if (!stopped) { channelId = ""; schedule(); } });
    schedule();

    ctx.disposable(() => {
      stopped = true;
      stopPlay();
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      offLog();
      offLocale();
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocus, true);
      clearAll();
      strip.remove();
    });
  },
});
