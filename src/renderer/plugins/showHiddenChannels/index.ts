import {BodyMutationObserver} from "../../ui/bodyObserver";
import {nativeUiMutationRelevant} from "../../ui/mutations";
import { setLocalizedText, t as i18nText } from "../../i18n";
import type { PluginContext } from "../../api/plugin";
import { definePlugin } from "../../api/plugin";
import { factoryPatchReport, revealChannelNames } from "./factoryPatch";
import {
  type Channel,
  capturePermissions,
  clearHiddenCache,
  getChannel,
  guildChannels,
  hiddenInGuild,
  isCategory,
  isHiddenChannel,
  isHiddenId,
  isVoice,
  parentIdOf,
  permissionState,
  selectedChannel,
  viewBit,
  viewersOf,
} from "./access";

const LOCK_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17 11V8a5 5 0 0 0-10 0v3H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-1zm-8-3a3 3 0 1 1 6 0v3H9V8z"/></svg>`;

type Row = { channel?: Channel; comparator?: number };

type Dispatcher = {
  subscribe?: (type: string, cb: () => void) => void;
  unsubscribe?: (type: string, cb: () => void) => void;
};

let renderingLevel = false;
let voiceLock: Channel | undefined;

function fnSource(value: unknown): string {
  if (typeof value !== "function") return "";
  try {
    return Function.prototype.toString.call(value);
  } catch {
    return "";
  }
}

function cacheExports(): unknown[] {
  const cache = window.Syncord?.webpack.getRequire()?.c;
  if (!cache) return [];
  const out: unknown[] = [];
  for (const id of Object.keys(cache)) {
    try {
      const exp = cache[id]?.exports;
      if (exp != null) out.push(exp);
    } catch {
      /* broken module */
    }
  }
  return out;
}

function eachValue(exp: unknown, visit: (holder: object, key: string, value: unknown) => void): void {
  if (typeof exp === "function") visit({ fn: exp }, "fn", exp);
  if (!exp || typeof exp !== "object") return;
  for (const key of Object.keys(exp as object)) {
    try {
      visit(exp, key, (exp as Record<string, unknown>)[key]);
    } catch {
      /* getter */
    }
  }
}

function asBit(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    try {
      return BigInt(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function bitCount(value: bigint): number {
  let count = 0;
  let bits = value < 0n ? -value : value;
  while (bits > 0n) {
    count += Number(bits & 1n);
    bits >>= 1n;
  }
  return count;
}

/** View-channel checks, including small combinations Discord passes as one bitfield. */
function isListPermission(value: unknown): boolean {
  if (value === "VIEW_CHANNEL") return true;
  const bits = asBit(value);
  if (bits == null) return false;
  const views = [viewBit(), 1024n];
  for (const view of views) {
    if (bits === view) return true;
    if ((bits & view) === view && bitCount(bits) <= 4) return true;
  }
  return false;
}

function rowChannel(row: unknown): Channel | undefined {
  if (!row || typeof row !== "object") return undefined;
  const channel = (row as Row).channel;
  if (channel && typeof channel === "object" && typeof channel.id === "string") return channel;
  return undefined;
}

function looksLikeChannelMap(result: unknown): result is Record<string, unknown> {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const values = Object.values(result as object);
  if (values.length === 0) return true;
  return values.some((value) => {
    if (!Array.isArray(value)) return false;
    return value.length === 0 || rowChannel(value[0]) != null;
  });
}

function presentIds(result: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  for (const value of Object.values(result)) {
    if (!Array.isArray(value)) continue;
    for (const row of value) {
      const id = rowChannel(row)?.id;
      if (id) ids.add(id);
    }
  }
  return ids;
}

function uncategorizedKey(result: Record<string, unknown>): string {
  if (Array.isArray(result.null)) return "null";
  for (const [key, rows] of Object.entries(result)) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const channel = rowChannel(row);
      if (channel?.id === "null" || channel?.name === "Uncategorized") return key;
    }
  }
  return "null";
}

function signature(guildId: string, result: Record<string, unknown>, hidden: Channel[]): string {
  const ids = [...presentIds(result)].sort();
  const extra = hidden.map((channel) => channel.id).sort();
  return `${guildId}|${ids.join(",")}|${extra.join(",")}`;
}

const stableLists = new Map<string, { sig: string; value: Record<string, unknown> }>();

function withHidden(result: Record<string, unknown>, guildId: string): Record<string, unknown> | undefined {
  if (guildId.startsWith("@")) return undefined;
  if (guildChannels(guildId).length === 0) return undefined;
  const hidden = hiddenInGuild(guildId);
  if (hidden.length === 0) return undefined;

  const sig = signature(guildId, result, hidden);
  const hit = stableLists.get(guildId);
  if (hit?.sig === sig) return hit.value;

  const present = presentIds(result);
  const next: Record<string, unknown> = { ...result };
  let added = false;
  for (const channel of hidden) {
    if (!channel.id || present.has(channel.id) || isCategory(channel)) continue;
    const key = parentIdOf(channel) ?? uncategorizedKey(next);
    const current = Array.isArray(next[key]) ? (next[key] as unknown[]) : [];
    const position = typeof channel.position === "number" ? channel.position : 0;
    const rows = [...current];
    const index = rows.findIndex((row) => ((row as Row).comparator ?? 0) > position);
    rows.splice(index === -1 ? rows.length : index, 0, { channel, comparator: position });
    next[key] = rows;
    present.add(channel.id);
    added = true;
  }
  if (!added) return undefined;
  stableLists.set(guildId, { sig, value: next });
  return next;
}

function channelIdFromArgs(args: unknown[]): string | undefined {
  const first = args[0];
  if (typeof first === "string" && /^\d{15,22}$/.test(first)) return first;
  if (!first || typeof first !== "object") return undefined;
  const record = first as { channelId?: unknown; channel_id?: unknown; id?: unknown };
  const id = record.channelId ?? record.channel_id ?? record.id;
  return typeof id === "string" ? id : undefined;
}

function channelFromVoiceArgs(args: unknown[]): Channel | undefined {
  const first = args[0];
  if (typeof first === "string") return getChannel(first);
  if (first && typeof first === "object" && typeof (first as Channel).id === "string") {
    return first as Channel;
  }
  return undefined;
}

function considerRenderProto(best: { proto?: object; score: number }, value: unknown): void {
  if (typeof value !== "function") return;
  const proto = (value as { prototype?: { getRenderLevel?: unknown } }).prototype;
  if (!proto || typeof proto.getRenderLevel !== "function") return;
  const src = fnSource(proto.getRenderLevel);
  const score = (src.includes("VIEW_CHANNEL") ? 2 : 0) + (src.includes("renderLevel") ? 1 : 0);
  if (score > best.score) {
    best.proto = proto;
    best.score = score;
  }
}

function findRenderProto(): object | undefined {
  const best: { proto?: object; score: number } = { score: 0 };
  for (const exp of cacheExports()) {
    eachValue(exp, (_holder, _key, value) => considerRenderProto(best, value));
  }

  const row = document.querySelector('[data-list-item-id*="channels"]');
  const fiberKey = row
    ? Object.keys(row).find((key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"))
    : undefined;
  let fiber = fiberKey && row ? (row as unknown as Record<string, unknown>)[fiberKey] : undefined;
  for (let depth = 0; fiber && depth < 40; depth += 1) {
    const node = fiber as {
      return?: unknown;
      stateNode?: unknown;
      memoizedProps?: unknown;
    };
    const state = node.stateNode;
    if (state && typeof state === "object") {
      considerRenderProto(best, (state as { constructor?: unknown }).constructor);
      if (typeof (state as { getRenderLevel?: unknown }).getRenderLevel === "function") {
        const proto = Object.getPrototypeOf(state) as { getRenderLevel?: unknown };
        if (proto && typeof proto.getRenderLevel === "function") {
          considerRenderProto(best, proto.constructor ?? function Render() {});
          if ((best.score ?? 0) < 1) {
            best.proto = proto;
            best.score = 1;
          }
        }
      }
    }
    fiber = node.return;
  }
  return best.proto;
}

function patchGated(ctx: PluginContext): boolean {
  let patched = false;
  for (const exp of cacheExports()) {
    if (!exp || typeof exp !== "object") continue;
    eachValue(exp, (holder, key, value) => {
      if (holder !== exp || typeof value !== "function") return;
      if (key !== "isChannelGated" && value.name !== "isChannelGated") return;
      ctx.patch.instead(holder, key, () => false);
      patched = true;
    });
  }
  return patched;
}

function patchMessageFetches(ctx: PluginContext): number {
  const seen = new Set<object>();
  let patched = 0;
  for (const exp of cacheExports()) {
    if (!exp || typeof exp !== "object") continue;
    eachValue(exp, (holder, key, value) => {
      if (key !== "fetchMessages" || typeof value !== "function") return;
      if (seen.has(holder)) return;
      const record = holder as Record<string, unknown>;
      if (typeof record.sendMessage !== "function" && typeof record.jumpToMessage !== "function") {
        return;
      }
      seen.add(holder);
      for (const method of ["fetchMessages", "jumpToMessage", "fetchMessagesNewer", "loadMessages"]) {
        if (typeof record[method] !== "function") continue;
        ctx.patch.instead(holder, method, (args, original) => {
          const id = channelIdFromArgs(args);
          if (isHiddenId(id) || (voiceLock?.id && id === voiceLock.id)) return;
          return original.apply(holder, args);
        });
      }
      patched += 1;
    });
  }
  return patched;
}

function patchVoiceSelect(ctx: PluginContext): boolean {
  for (const exp of cacheExports()) {
    if (!exp || typeof exp !== "object") continue;
    let found = false;
    eachValue(exp, (holder, key, value) => {
      if (found || key !== "selectVoiceChannel" || typeof value !== "function") return;
      found = true;
      ctx.patch.instead(holder, key, (args, original) => {
        const channel = channelFromVoiceArgs(args);
        if (channel && isHiddenChannel(channel)) {
          voiceLock = channel;
          paint();
          return;
        }
        voiceLock = undefined;
        return original.apply(holder, args);
      });
    });
    if (found) return true;
  }
  return false;
}

function disableObfuscation(ctx: PluginContext): boolean {
  let patched = false;
  for (const exp of cacheExports()) {
    if (!exp || typeof exp !== "object") continue;
    eachValue(exp, (target, key, value) => {
      if (target !== exp || typeof value !== "function") return;
      const src = fnSource(value);
      if (!src.includes("enableObfuscation") || src.length > 250) return;
      ctx.patch.instead(target, key, () => false);
      patched = true;
    });
  }
  if (patched) ctx.log.info("private channel obfuscation off");
  return patched;
}

function channelIdFromRow(row: Element): string | undefined {
  const raw = row.getAttribute("data-list-item-id");
  if (!raw) return undefined;
  const id = raw.split("___").pop();
  return id && /^\d{15,22}$/.test(id) ? id : undefined;
}

function markRows(): void {
  for (const row of document.querySelectorAll("[data-list-item-id]")) {
    const id = channelIdFromRow(row);
    if (!id) continue;
    const hidden = isHiddenId(id);
    row.classList.toggle("dion-shc-hidden", hidden);
    let icon = row.querySelector(":scope > .dion-shc-lock-icon");
    if (hidden && !(icon instanceof HTMLElement)) {
      icon = document.createElement("span");
      icon.className = "dion-shc-lock-icon";
      icon.innerHTML = LOCK_SVG;
      row.appendChild(icon);
    } else if (!hidden && icon) {
      icon.remove();
    }
  }
}

function messageHost(): HTMLElement | null {
  const wrap = document.querySelector('[class*="messagesWrapper_"]');
  if (wrap?.parentElement instanceof HTMLElement) return wrap.parentElement;
  const call = document.querySelector('[class*="callContainer_"]');
  if (call?.parentElement instanceof HTMLElement) return call.parentElement;
  const chat = document.querySelector('[class*="chatContent_"]');
  return chat instanceof HTMLElement ? chat : null;
}

function fillScreen(screen: HTMLElement, channel: Channel): void {
  screen.replaceChildren();
  screen.dataset.channelId = channel.id ?? "";

  const mark = document.createElement("div");
  mark.className = "dion-shc-mark";
  mark.innerHTML = LOCK_SVG;

  const title = document.createElement("h2");
  title.textContent = channel.name ? `#${channel.name}` : i18nText("ui.hidden_channel");

  const body = document.createElement("p");
  setLocalizedText(body, "ui.you_don_t_have_permission_to_view_this_channel");

  screen.append(mark, title, body);

  if (channel.nsfw) {
    const nsfw = document.createElement("div");
    nsfw.className = "dion-shc-nsfw";
    setLocalizedText(nsfw, "ui.nsfw");
    screen.append(nsfw);
  }

  if (typeof channel.topic === "string" && channel.topic.trim()) {
    const topic = document.createElement("div");
    topic.className = "dion-shc-topic";
    topic.textContent = channel.topic;
    screen.append(topic);
  }

  const viewers = viewersOf(channel);
  if (viewers.length > 0) {
    const box = document.createElement("div");
    box.className = "dion-shc-who";
    const label = document.createElement("div");
    label.className = "dion-shc-who-label";
    setLocalizedText(label, "ui.can_view");
    const list = document.createElement("div");
    list.textContent = viewers.join(", ");
    box.append(label, list);
    screen.append(box);
  }
}

function paint(): void {
  markRows();
  const host = messageHost();
  if (!host) return;

  const selected = voiceLock ?? selectedChannel();
  const hidden = selected != null && isHiddenChannel(selected);
  let screen = host.querySelector(":scope > .dion-shc-screen");

  if (!hidden || !selected) {
    host.classList.remove("dion-shc-active");
    screen?.remove();
    return;
  }

  host.classList.add("dion-shc-active");
  if (!(screen instanceof HTMLElement)) {
    const created = document.createElement("div");
    created.className = "dion-shc-screen";
    created.setAttribute("role", "status");
    host.appendChild(created);
    screen = created;
  }
  if (screen instanceof HTMLElement && screen.dataset.channelId !== selected.id) {
    fillScreen(screen, selected);
  }
}

function clearUi(): void {
  voiceLock = undefined;
  for (const row of document.querySelectorAll(".dion-shc-hidden")) {
    row.classList.remove("dion-shc-hidden");
  }
  for (const icon of document.querySelectorAll(".dion-shc-lock-icon")) icon.remove();
  for (const screen of document.querySelectorAll(".dion-shc-screen")) screen.remove();
  for (const host of document.querySelectorAll(".dion-shc-active")) {
    host.classList.remove("dion-shc-active");
  }
}

/**
 * Shows guild channels the account cannot view.
 * Message history is not loaded; opening one shows a lock screen.
 */
export const ShowHiddenChannelsPlugin = definePlugin({
  id: "show-hidden-channels",
  restartOnDisable: true,
  name: i18nText("ui.show_hidden_channels"),
  get description() { return i18nText("ui.show_channels_you_can_t_view_opening_one_shows_who_can_see_it_without_"); },
  author: i18nText("ui.syncord"),
  enabledByDefault: true,

  /**
   * The most powerful built-in: it rewrites Discord's permission check, so
   * `webpackPatch` is declared explicitly and the Security Center lists it as
   * such. It performs no network requests of its own — every read goes through
   * Discord's own stores — so the network permission stays absent.
   */
  permissions: {
    webpackPatch: true,
    media: true,
    discordStores: ["channel", "guild", "message"],
  },

  start(ctx) {
    ctx.css.inject(`
      .dion-shc-hidden [class*="name_"] {
        opacity: 0.55;
      }
      .dion-shc-lock-icon {
        display: inline-flex;
        align-items: center;
        margin-left: auto;
        margin-right: 8px;
        color: var(--channels-default);
        flex-shrink: 0;
        pointer-events: none;
      }
      .dion-shc-lock-icon svg {
        width: 16px;
        height: 16px;
        display: block;
      }
      .dion-shc-hidden [class*="iconMention_"],
      .dion-shc-hidden [class*="mentionsBadge_"],
      .dion-shc-hidden [class*="numberBadge_"] {
        display: none !important;
      }
      .dion-shc-active [class*="messagesWrapper_"],
      .dion-shc-active [class*="channelTextArea_"],
      .dion-shc-active [class*="form_"],
      .dion-shc-active form,
      .dion-shc-active [class*="callContainer_"],
      .dion-shc-active [class*="jumpToPresent_"],
      .dion-shc-active [class*="newMessagesBar_"] {
        display: none !important;
      }
      .dion-shc-screen {
        flex: 1 1 auto;
        min-height: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 10px;
        text-align: center;
        padding: 32px 24px;
        color: var(--text-normal, var(--text-default));
      }
      .dion-shc-mark {
        width: 72px;
        height: 72px;
        color: var(--text-muted);
      }
      .dion-shc-mark svg { width: 100%; height: 100%; display: block; }
      .dion-shc-screen h2 {
        margin: 0;
        font-size: 20px;
        font-weight: 700;
        line-height: 1.2;
      }
      .dion-shc-screen p {
        margin: 0;
        max-width: 420px;
        color: var(--text-muted);
        font-size: 14px;
        line-height: 1.4;
      }
      .dion-shc-nsfw {
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.04em;
        color: var(--status-danger);
      }
      .dion-shc-topic,
      .dion-shc-who {
        max-width: min(560px, 86%);
        background: var(--background-base-lower, var(--background-secondary));
        border-radius: 8px;
        padding: 12px 16px;
        color: var(--text-normal, var(--text-default));
        font-size: 14px;
        line-height: 1.4;
      }
      .dion-shc-who-label {
        margin-bottom: 6px;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.02em;
        text-transform: uppercase;
        color: var(--text-muted);
      }
    `);

    let channelsPatched = false;
    let renderPatched = false;
    let fetchesPatched = false;
    let voicePatched = false;
    let obfuscationPatched = false;
    let namesPinned = false;
    let gatedPatched = false;
    let logged = false;
    let refreshed = false;
    let getChannelsSource = "";

    const refresh = () => {
      clearHiddenCache();
      stableLists.clear();
      const guilds = window.Syncord?.common?.stores.GuildChannelStore as
        | { emitChange?: () => void }
        | undefined;
      guilds?.emitChange?.();
      paint();
    };

    const apply = (): boolean => {
      const guilds = window.Syncord?.common?.stores.GuildChannelStore as
        | { getChannels?: unknown; emitChange?: () => void }
        | undefined;
      const live =
        typeof guilds?.getChannels === "function"
          ? guilds
          : (window.Syncord?.webpack.findByStoreName("GuildChannelStore") as
              | { getChannels?: unknown; emitChange?: () => void }
              | undefined);
      const perms = window.Syncord?.common?.stores.PermissionStore as
        | { can?: unknown }
        | undefined;
      if (!live || typeof live.getChannels !== "function" || typeof perms?.can !== "function") {
        return false;
      }

      if (!channelsPatched) {
        capturePermissions();
        getChannelsSource = fnSource(live.getChannels);
        ctx.patch.instead(perms, "can", function (this: unknown, args, original) {
          if (isListPermission(args[0])) return true;
          return original.apply(this, args);
        });
        ctx.patch.after(live, "getChannels", (args, result) => {
          const guildId = args[0];
          if (typeof guildId !== "string" || !looksLikeChannelMap(result)) return;
          return withHidden(result, guildId);
        });
        channelsPatched = true;
      }

      if (!gatedPatched) gatedPatched = patchGated(ctx);

      if (!renderPatched) {
        const proto = findRenderProto();
        if (proto) {
          let visibleLevel: number | undefined;
          ctx.patch.instead(
            proto,
            "getRenderLevel",
            function (this: { record?: Channel }, args, original) {
              renderingLevel = true;
              try {
                const result = original.apply(this, args);
                const hidden = isHiddenChannel(this?.record);
                if (
                  result != null &&
                  typeof result === "object" &&
                  typeof (result as { renderLevel?: unknown }).renderLevel === "number"
                ) {
                  const level = (result as { renderLevel: number }).renderLevel;
                  if (!hidden) visibleLevel = Math.max(visibleLevel ?? level, level);
                  else if (visibleLevel != null && level < visibleLevel) {
                    return { ...(result as Record<string, unknown>), renderLevel: visibleLevel };
                  }
                }
                return result;
              } finally {
                renderingLevel = false;
              }
            },
          );
          renderPatched = true;
        }
      }

      if (!fetchesPatched) fetchesPatched = patchMessageFetches(ctx) > 0;
      if (!voicePatched) voicePatched = patchVoiceSelect(ctx);
      if (!obfuscationPatched) obfuscationPatched = disableObfuscation(ctx);
      if (!namesPinned) {
        namesPinned = revealChannelNames();
        if (namesPinned) ctx.log.info("channel names requested");
      }

      if (channelsPatched && !refreshed) {
        refreshed = true;
        live.emitChange?.();
      }

      if (!logged && channelsPatched && permissionState() !== "waiting") {
        const guilds = window.Syncord?.common?.stores.SelectedGuildStore as
          | { getGuildId?: () => unknown; getLastSelectedGuildId?: () => unknown }
          | undefined;
        const guildId = guilds?.getGuildId?.() ?? guilds?.getLastSelectedGuildId?.();
        if (typeof guildId === "string" && guildId) {
          logged = true;
          let listed = 0;
          try {
            const result = (live.getChannels as (id: string) => unknown)(guildId);
            if (looksLikeChannelMap(result)) listed = presentIds(result).size;
          } catch {
            /* store shape differs */
          }
          const stored = guildChannels(guildId).length;
          const hidden = hiddenInGuild(guildId).length;
          ctx.log.info(
            `hidden channels guild=${guildId} listed=${listed} stored=${stored} hidden=${hidden} perms=${permissionState()} render=${renderPatched} gated=${gatedPatched} gateInGetChannels=${getChannelsSource.includes("isChannelGated")} factories=${factoryPatchReport()}`,
          );
        }
      }

      paint();
      return true;
    };

    const onFlux = () => {
      voiceLock = undefined;
      refresh();
    };
    const onSelect = () => {
      voiceLock = undefined;
      paint();
    };

    const flux = window.Syncord?.common?.flux.FluxDispatcher as Dispatcher | undefined;
    const dispatcher =
      flux?.subscribe != null
        ? flux
        : (window.Syncord?.webpack.findByProps("dispatch", "subscribe") as Dispatcher | undefined);
    const fluxEvents = [
      "CHANNEL_CREATE",
      "CHANNEL_DELETE",
      "CHANNEL_UPDATE",
      "CHANNEL_UPDATES",
      "GUILD_CREATE",
      "OVERWRITE_UPDATE",
    ];
    if (dispatcher?.subscribe) {
      for (const event of fluxEvents) dispatcher.subscribe(event, onFlux);
      dispatcher.subscribe("CHANNEL_SELECT", onSelect);
    }

    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const row = target.closest("[data-list-item-id]");
      if (!(row instanceof HTMLElement)) return;
      const id = channelIdFromRow(row);
      const channel = id ? getChannel(id) : undefined;
      if (!channel || !isHiddenChannel(channel) || !isVoice(channel)) return;
      event.preventDefault();
      event.stopPropagation();
      voiceLock = channel;
      paint();
    };
    document.addEventListener("click", onClick, true);

    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        paint();
      });
    };
    const observer = new BodyMutationObserver(records => {
      if(nativeUiMutationRelevant(records,'.dion-shc-lock-icon,.dion-shc-screen'))schedule();
    });
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });

    apply();
    const timer = window.setInterval(() => {
      if (apply() && renderPatched) window.clearInterval(timer);
    }, 500);
    const giveUp = window.setTimeout(() => {
      window.clearInterval(timer);
      if (!channelsPatched) ctx.log.warn("GuildChannelStore not found");
      else if (!renderPatched) ctx.log.warn("channel render level not found");
    }, 20_000);

    ctx.disposable(() => {
      observer.disconnect();
      document.removeEventListener("click", onClick, true);
      if (raf) cancelAnimationFrame(raf);
      window.clearInterval(timer);
      window.clearTimeout(giveUp);
      if (dispatcher?.unsubscribe) {
        for (const event of fluxEvents) dispatcher.unsubscribe(event, onFlux);
        dispatcher.unsubscribe("CHANNEL_SELECT", onSelect);
      }
      clearHiddenCache();
      stableLists.clear();
      clearUi();
    });
  },
  stop() {
    const guilds = window.Syncord?.common?.stores.GuildChannelStore as
      | { emitChange?: () => void }
      | undefined;
    guilds?.emitChange?.();
  },
});
