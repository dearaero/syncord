import { getLocale, t as i18nText } from "../../i18n";
import {RecentMessages} from "./recent";
import {canViewChannel} from "../../api/discordEvents/access";
import {acquireGuildCoverage, COVERAGE_STATUS_EVENT, guildCoverageStatus, interceptDiscordEvents} from "../../api/discordEvents";
import { definePlugin, definePluginSettings } from "../../api/plugin";
import {
  channelIdOf,
  deletedInRange,
  entry,
  liveMessage,
  loadLog,
  type DiscordMessage,
  type LogEntry,
  holdMessage,
  onLogReset,
  releaseMessage,
  rememberDelete,
  undoDelete,
  rememberEdit,
  rememberActivity,
  saveLogNow,
  setLogLimit,
} from "./log";

const EPHEMERAL = 64;

const settings = definePluginSettings({
  ignoreBots: {
    type: "boolean",
    default: false,
    get description() { return i18nText("ui.skip_messages_sent_by_bots"); },
  },
  ignoreSelf: {
    type: "boolean",
    default: false,
    get description() { return i18nText("ui.skip_your_own_messages"); },
  },
  ignoreUsers: {
    type: "string",
    default: "",
    get description() { return i18nText("ui.comma_or_space_separated_user_ids_to_skip"); },
  },
  ignoreChannels: {
    type: "string",
    default: "",
    get description() { return i18nText("ui.comma_or_space_separated_channel_ids_to_skip"); },
  },
  ignoreGuilds: {
    type: "string",
    default: "",
    get description() { return i18nText("ui.comma_or_space_separated_guild_ids_to_skip"); },
  },
  limit: {
    type: "number",
    default: 800,
    get description() { return i18nText("ui.maximum_logged_messages_0_keeps_everything"); },
  },
  onlyOpened: {
    type: "boolean",
    default: true,
    get description() { return i18nText("ui.log_opened_conversations_only_when_background_server_monitoring_is_dis"); },
  },
  ultimate: {
    type: "boolean",
    default: true,
    get description() { return i18nText("ui.subscribe_to_every_server_at_once_so_deletes_and_edits_are_logged_with"); },
  },
});

type DispatchAction = {
  type?: string;
  id?: string;
  ids?: string[];
  channelId?: string;
  channel_id?: string;
  message?: DiscordMessage;
};

type Dispatcher = {
  dispatch: (action: DispatchAction) => void;
};

type ChannelCache = {
  has?: (id: string) => boolean;
  get?: (id: string) => DiscordMessage | undefined;
  receiveMessage?: (message: DiscordMessage) => void;
  remove?: (id: string) => unknown;
  update?: (id: string, updater: (message: DiscordMessage) => DiscordMessage) => unknown;
  _array?: { id?: string }[];
};

type MessageStore = {
  getMessage?: (channelId: string, messageId: string) => DiscordMessage | undefined;
  getMessages?: (channelId: string) => ChannelCache | undefined;
  emitChange?: () => void;
};

type UserStore = {
  getCurrentUser?: () => { id?: string } | undefined;
};

const DM = 1;
const GROUP_DM = 3;
const ULTIMATE_EVENT = "Syncord-ml-ultimate";
const ULTIMATE_STATUS_EVENT = "Syncord-ml-ultimate-status";
let ultimateStatus = "";
const EMPTY_IDS: ReadonlySet<string> = new Set();
const idCache = new Map<string, { raw: string; ids: Set<string> }>();

type ChannelRecord = {
  id?: string;
  guild_id?: string;
  guildId?: string;
  type?: number;
};

let applying = false;
let loggerEpoch=0;
let selfId = "";
let bound: ReturnType<typeof settings.bind> | undefined;
const openedGuilds = new Set<string>();
const openedDms = new Set<string>();
const heldRecent=new Set<string>();
const seen=new RecentMessages(id=>{if(heldRecent.delete(id))releaseMessage(id);});

function dispatcher(): Dispatcher | undefined {
  const flux = window.Syncord?.common?.flux.FluxDispatcher as Dispatcher | undefined;
  if (typeof flux?.dispatch === "function") return flux;
  return undefined;
}

function messages(): MessageStore | undefined {
  const store = window.Syncord?.common?.stores.MessageStore as MessageStore | undefined;
  if (typeof store?.getMessage === "function") return store;
  const found = window.Syncord?.webpack.findByStoreName("MessageStore") as MessageStore | undefined;
  if (typeof found?.getMessage === "function") return found;
  return undefined;
}

function currentUserId(): string {
  if (selfId) return selfId;
  const store = window.Syncord?.common?.stores.UserStore as UserStore | undefined;
  selfId = store?.getCurrentUser?.()?.id ?? "";
  return selfId;
}

function textOf(action: DispatchAction, key: "channelId" | "channel_id" | "id"): string {
  const value = action[key];
  return typeof value === "string" ? value : "";
}

function channelFrom(action: DispatchAction, message?: DiscordMessage): string {
  return textOf(action, "channelId") || textOf(action, "channel_id") || (message ? channelIdOf(message) : "");
}

function asId(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "";
}

function collectDelete(action: DispatchAction): { channelId: string; ids: string[] } {
  const bag = action as DispatchAction & {
    messageId?: unknown;
    message_id?: unknown;
    messageIds?: unknown;
  };
  const ids: string[] = [];
  const push = (value: unknown) => {
    const id = asId(value);
    if (id && !ids.includes(id)) ids.push(id);
  };
  push(bag.id);
  push(bag.messageId);
  push(bag.message_id);
  push(bag.message?.id);
  if (Array.isArray(bag.ids)) for (const id of bag.ids) push(id);
  if (Array.isArray(bag.messageIds)) for (const id of bag.messageIds) push(id);
  return { channelId: channelFrom(action, bag.message), ids };
}

function selectedChannelId(): string {
  const store = window.Syncord?.common?.stores.SelectedChannelStore as
    | { getChannelId?: () => string }
    | undefined;
  const id = store?.getChannelId?.();
  return typeof id === "string" ? id : "";
}

function channelRecord(channelId: string): ChannelRecord | undefined {
  const store = window.Syncord?.common?.stores.ChannelStore as
    | { getChannel?: (id: string) => ChannelRecord | undefined }
    | undefined;
  return store?.getChannel?.(channelId);
}

function onlyOpened(): boolean {
  return !ultimateOn();
}

function ultimateOn(): boolean {
  return bound?.get("ultimate") === true;
}

function noteOpened(channelId: string): void {
  if (!channelId) return;
  const channel = channelRecord(channelId);
  const guildId = channel?.guild_id || channel?.guildId;
  if (guildId) {
    openedGuilds.add(guildId);
    return;
  }
  if (channel?.type === DM || channel?.type === GROUP_DM) openedDms.add(channel.id || channelId);
}

function inScope(channelId: string): boolean {
  if(!canViewChannel(channelId))return false;
  if (ultimateOn() || !onlyOpened()) return true;
  if (!channelId) return false;
  if (openedDms.has(channelId)) return true;
  const channel = channelRecord(channelId);
  const guildId = channel?.guild_id || channel?.guildId;
  if (guildId) return openedGuilds.has(guildId);
  return channel?.type === DM || channel?.type === GROUP_DM ? openedDms.has(channel.id || channelId) : false;
}

function rememberSeen(message:DiscordMessage):void {
  if(!message.id)return;
  seen.set(message.id,message);
  // Only a small recent native-message window is retained for inline restoration.
  if(isStoreMessage(message)&&seen.get(message.id)) {
    holdMessage(message);heldRecent.delete(message.id);heldRecent.add(message.id);
    while(heldRecent.size>512){const oldest=heldRecent.values().next();if(oldest.done)break;heldRecent.delete(oldest.value);releaseMessage(oldest.value);}
  }
}

function idSet(key: string, raw: unknown): ReadonlySet<string> {
  const text = typeof raw === "string" ? raw : "";
  if (!text.trim()) return EMPTY_IDS;
  const cached = idCache.get(key);
  if (cached?.raw === text) return cached.ids;
  const ids = new Set<string>();
  for (const part of text.split(/[\s,]+/)) {
    if (part) ids.add(part);
  }
  idCache.set(key, { raw: text, ids });
  return ids;
}

function ignored(message: DiscordMessage): boolean {
  if ((message.flags ?? 0) & EPHEMERAL) return true;
  if (bound?.get("ignoreBots") && message.author?.bot) return true;
  const authorId = message.author?.id ?? "";
  if (bound?.get("ignoreSelf") && authorId && authorId === currentUserId()) return true;
  if (authorId && idSet("users", bound?.get("ignoreUsers")).has(authorId)) return true;
  const channelId = channelIdOf(message);
  if (channelId && idSet("channels", bound?.get("ignoreChannels")).has(channelId)) return true;
  const guilds = idSet("guilds", bound?.get("ignoreGuilds"));
  if (channelId && guilds.size) {
    const channel = channelRecord(channelId);
    const guildId = channel?.guild_id || channel?.guildId || "";
    if (guildId && guilds.has(guildId)) return true;
  }
  return false;
}

type ReactionAction = DispatchAction & { messageId?: unknown; userId?: unknown; emoji?: { id?: unknown; name?: unknown } };

function logReaction(store: MessageStore, action: ReactionAction, added: boolean): void {
  const channelId = channelFrom(action);
  const messageId = asId(action.messageId);
  if (!channelId || !messageId || !inScope(channelId)) return;
  const message = store.getMessage?.(channelId, messageId) ?? seen.get(messageId);
  if (!message || ignored(message)) return;
  const userId = asId(action.userId);
  if (bound?.get("ignoreSelf") && userId && userId === currentUserId()) return;
  const id = asId(action.emoji?.id), name = typeof action.emoji?.name === "string" ? action.emoji.name.slice(0, 64) : "";
  const emoji = id ? `:${name || "emoji"}:` : name;
  rememberActivity(message, { at: Date.now(), kind: added ? "react" : "unreact", emoji: emoji || undefined, userId: userId || undefined });
}

function oldestId(cache: ChannelCache | undefined): string | undefined {
  const first = cache?._array?.[0]?.id;
  if (typeof first === "string") return first;
  return undefined;
}

function restore(store: MessageStore, channelId: string): void {
  const cache = store.getMessages?.(channelId);
  if (!cache) return;
  const rows = deletedInRange(channelId, oldestId(cache));
  let changed = false;
  for (const row of rows) {
    if (cache.has?.(row.id)) {
      markDeleted(cache, row.id);
      continue;
    }
    const message = liveMessage(row.id) ?? plainMessage(row);
    if (putBack(cache, message)) changed = true;
  }
  if (!changed) return;
  const epoch=loggerEpoch;
  queueMicrotask(() => {
    if(epoch!==loggerEpoch)return;
    try {
      store.emitChange?.();
    } catch {
      /* a listener dispatched again */
    }
  });
}

function plainMessage(row: LogEntry): DiscordMessage {
  return {
    id: row.id,
    channel_id: row.channelId,
    content: row.content,
    timestamp: new Date(row.timestamp),
    type: 0,
    flags: 0,
    pinned: false,
    tts: false,
    deleted: true,
    attachments: (row.attachments ?? []).map((file, index) => ({
      id: `${row.id}:${index}`,
      filename: file.name,
      url: file.url,
      proxy_url: file.url,
      size: 0,
      content_type: "application/octet-stream",
    })),
    embeds: [],
    mentions: [],
    mentionRoles: [],
    mentionChannels: [],
    reactions: [],
    author: {
      id: row.authorId || "0",
      username: row.author || i18nText("ui.unknown"),
      globalName: row.author || i18nText("ui.unknown"),
      discriminator: "0",
      bot: false,
      avatar: null,
    },
  } as DiscordMessage;
}

function markDeleted(cache: ChannelCache, id: string): void {
  const message = cache.get?.(id);
  try {
    if (message) message.deleted = true;
  } catch {
    /* immutable record */
  }
  if (typeof cache.update !== "function") return;
  try {
    cache.update(id, (current) => {
      const record = current as unknown as { set?: (key: string, value: unknown) => DiscordMessage };
      if (current && typeof record.set === "function") return record.set("deleted", true);
      if (current) current.deleted = true;
      return current;
    });
  } catch {
    /* cache shape does not support update */
  }
}

function compareId(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Nightcord skips removal inside MessageStore. This keeps `remove` from dropping logged ids while the rest of the dispatch still runs. */
function guardRemove(cache: ChannelCache, keep: Set<string>): () => void {
  const original = cache.remove;
  if (typeof original !== "function") return () => {};
  const wrapped = function (this: ChannelCache, id: string) {
    if (!keep.has(id)) return original.call(this, id);
    const message = this.get?.(id);
    if (message) {
      try {
        message.deleted = true;
      } catch {
        /* immutable record */
      }
    }
    return this;
  };
  cache.remove = wrapped;
  return () => {
    if (cache.remove === wrapped) cache.remove = original;
  };
}

function isStoreMessage(message: DiscordMessage): boolean {
  return typeof (message as { hasFlag?: unknown }).hasFlag === "function";
}

function snowflake(id: string): boolean {
  return /^\d{17,22}$/.test(id);
}

/** Nonce removals and lookups that return a different message are not user deletes. */
function placeholderDelete(actionId: string, message: DiscordMessage): boolean {
  if (!snowflake(actionId) || message.id !== actionId) return true;
  const state = (message as { state?: string }).state;
  return state === "SENDING" || state === "SEND_FAILED";
}

function clearDeletedFlag(message: DiscordMessage | undefined): void {
  if (!message?.deleted) return;
  try {
    message.deleted = false;
  } catch {
    /* immutable record */
  }
}

function clearStuckDeleted(): void {
  const store = messages();
  const channelId = selectedChannelId();
  const cache = channelId ? store?.getMessages?.(channelId) : undefined;
  const list = cache?._array;
  if (!cache || !Array.isArray(list)) return;
  for (const item of list) {
    const message = item as DiscordMessage;
    if (!message?.id || !message.deleted) continue;
    clearDeletedFlag(message);
    try {
      cache.update?.(message.id, (current) => {
        const record = current as unknown as { set?: (key: string, value: unknown) => DiscordMessage };
        if (current && typeof record.set === "function") return record.set("deleted", false);
        if (current) current.deleted = false;
        return current;
      });
    } catch {
      /* cache shape does not support update */
    }
  }
}

function putBack(cache: ChannelCache, message: DiscordMessage): boolean {
  if (!isStoreMessage(message)) return false;
  message.deleted = true;
  const attachments = message.attachments;
  if (Array.isArray(attachments)) {
    for (const file of attachments) {
      if (file && typeof file === "object") (file as { deleted?: boolean }).deleted = true;
    }
  }
  const bag = cache as ChannelCache & { _map?: Map<string, DiscordMessage> };
  try {
    if (typeof cache.receiveMessage === "function") {
      cache.receiveMessage(message);
      if (cache.has?.(message.id) !== false) return true;
    }
  } catch {
    /* try the raw lists */
  }
  try {
    if (bag._map instanceof Map) bag._map.set(message.id, message);
    if (Array.isArray(cache._array)) {
      if (!cache._array.some((item) => item.id === message.id)) {
        const index = cache._array.findIndex((item) => typeof item.id === "string" && compareId(item.id, message.id) > 0);
        cache._array.splice(index === -1 ? cache._array.length : index, 0, message);
      }
      return true;
    }
  } catch {
    /* renderer rejected the row */
  }
  return typeof cache.has === "function" && cache.has(message.id);
}

function paintItem(el: HTMLElement): void {
  if (!el.id.startsWith("chat-messages-")) return;
  const rest = el.id.slice("chat-messages-".length);
  const split = rest.indexOf("-");
  if (split < 0) return;
  const channelId = rest.slice(0, split);
  const messageId = rest.slice(split + 1);
  const logged = entry(channelId, messageId);
  const deleted = !!logged?.deleted;
  const edited = !!logged?.edits?.length;
  el.classList.toggle("dion-ml-deleted", deleted);
  el.classList.toggle("dion-ml-edited", edited && !deleted);
  const found = el.querySelector(":scope > .dion-ml-note");
  el.querySelector(":scope > .dion-ml-history")?.remove();
  if (!deleted && !edited) {
    found?.remove();
    el.querySelector(":scope > .dion-ml-versions")?.remove();
    el.classList.remove("dion-ml-hidden");
    return;
  }
  const key = `${channelId}-${messageId}`;
  let note: HTMLElement;
  if (found instanceof HTMLElement) note = found;
  else {
    note = document.createElement("div");
    note.className = "dion-ml-note";
    el.prepend(note);
  }
  if (note.dataset.mid !== key) {
    note.dataset.mid = key;
    el.classList.remove("dion-ml-hidden");
    el.querySelector(":scope > .dion-ml-versions")?.classList.remove("dion-ml-hidden");
  }
  if (edited && !deleted) el.classList.remove("dion-ml-hidden");
  const label = deleted
    ? edited
      ? i18nText("ui.deleted_edited")
      : i18nText("ui.deleted")
    : i18nText("ui.edited_value", {v0: logged?.edits?.length ?? 0});
  if (note.textContent !== label) note.textContent = label;
  paintVersions(el, logged, note);
}

function paintVersions(row: HTMLElement, logged: LogEntry | undefined, note: HTMLElement): void {
  const edits = logged?.edits ?? [];
  const found = row.querySelector(":scope > .dion-ml-versions");
  if (!edits.length) {
    found?.remove();
    return;
  }
  let box: HTMLElement;
  if (found instanceof HTMLElement) box = found;
  else {
    box = document.createElement("div");
    box.className = "dion-ml-versions";
    note.after(box);
  }
  const key = edits.map((edit) => `${edit.at}\0${edit.content}`).join("\n");
  if (box.dataset.key === key) return;
  const source = messageBody(row);
  if (!source) return;
  box.replaceChildren();
  for (const edit of edits) box.appendChild(cloneVersion(source, edit.content, edit.at, logged?.content ?? ""));
  if (!box.childElementCount) return;
  box.dataset.key = key;
}

function messageBody(row: HTMLElement): HTMLElement | undefined {
  for (const child of row.children) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.classList.contains("dion-ml-note") || child.classList.contains("dion-ml-versions")) continue;
    return child;
  }
  return undefined;
}

function cloneVersion(source: HTMLElement, content: string, at: number, current: string): HTMLElement {
  const copy = source.cloneNode(true) as HTMLElement;
  copy.classList.add("dion-ml-version");
  const body = copy.querySelector('[id^="message-content-"]');
  if (body) body.textContent = content || "(empty)";
  else replaceBody(copy, content, current);
  const time = copy.querySelector("time");
  if (time instanceof HTMLTimeElement) {
    const date = new Date(at);
    time.dateTime = date.toISOString();
    const label = date.toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" });
    const slot = time.querySelector("span") ?? time;
    slot.textContent = label;
  }
  copy.removeAttribute("id");
  copy.removeAttribute("data-list-item-id");
  copy.removeAttribute("aria-labelledby");
  for (const node of copy.querySelectorAll("[id]")) node.removeAttribute("id");
  return copy;
}

function replaceBody(copy: HTMLElement, content: string, current: string): void {
  if (!current) return;
  for (const node of copy.querySelectorAll("div, span")) {
    if (node.children.length > 1) continue;
    if (!(node.textContent ?? "").includes(current)) continue;
    node.textContent = content || "(empty)";
    return;
  }
}

function stripPaint(): void {
  for (const note of document.querySelectorAll(".dion-ml-note, .dion-ml-history, .dion-ml-versions")) note.remove();
  for (const row of document.querySelectorAll("li.dion-ml-deleted, li.dion-ml-edited, li.dion-ml-hidden")) {
    row.classList.remove("dion-ml-deleted", "dion-ml-edited", "dion-ml-hidden");
  }
}

function toggleMessage(note: HTMLElement): void {
  const row = note.parentElement;
  if (!(row instanceof HTMLElement)) return;
  if (row.classList.contains("dion-ml-edited")) {
    row.querySelector(":scope > .dion-ml-versions")?.classList.toggle("dion-ml-hidden");
    return;
  }
  row.classList.toggle("dion-ml-hidden");
}

let coverageLease:ReturnType<typeof acquireGuildCoverage>|undefined;
function paintUltimate(text:string):void {ultimateStatus=text;showUltimateStatus();}
function showUltimateStatus():void {
  const node=document.querySelector("[data-dion-ml-ultimate-status]");
  if(node)node.textContent=ultimateOn()?ultimateStatus:i18nText("ui.opened_conversations_only");
}
function syncUltimate(on:boolean):void {
  if(!on){coverageLease?.release();coverageLease=undefined;paintUltimate("");return;}
  if(!coverageLease)coverageLease=acquireGuildCoverage({threads:true});
  const status=guildCoverageStatus();
  paintUltimate(status.connected?i18nText("ui.shared_monitoring_value_serversvalue", {v0: status.guilds, v1: status.pending?" · preparing":""}):i18nText("ui.waiting_for_discord_to_reconnect"));
}

function snapshotChannel(channelId: string): void {
  const list = messages()?.getMessages?.(channelId)?._array;
  if (!Array.isArray(list)) return;
  for (const item of list) {
    const message = item as DiscordMessage;
    if (!message?.id || !isStoreMessage(message) || ignored(message)) continue;
    if (!inScope(channelId)) continue;
    rememberSeen(message);
  }
}

export const MessageLoggerPlugin = definePlugin({
  id: "message-logger",
  name: i18nText("ui.message_logger"),
  get description() { return i18nText("ui.keep_deleted_messages_in_place_and_remember_edits_without_caching_whol"); },
  author: i18nText("ui.syncord"),
  enabledByDefault: true,

  /**
   * Reads message and channel stores and keeps a local log under the
   * Syncord profile. `userData` is declared because the plugin writes files;
   * it is a named capability, not a raw path, so the plugin still cannot reach
   * outside its own directory. No network — the log never leaves the machine.
   */
  permissions: {
    media: true,
    userData: true,
    webpackPatch: true,
    discordActions: ["guild-subscriptions"],
    discordStores: ["message", "channel", "guild", "user", "permission"],
  },

  start(ctx) {
    const instance=++loggerEpoch;
    bound = settings.bind("message-logger");
    if(ctx.settings.get<number>("coverageVersion",0)!==1) {
      bound.set("ultimate",true);ctx.settings.set("coverageVersion",1);
    }
    bound.set("onlyOpened", !ultimateOn());
    setLogLimit(bound.get("limit"));
    loadLog();
    ctx.disposable(
      onLogReset(() => {
        clearStuckDeleted();
        stripPaint();
      }),
    );
    let undoDispatch: (() => void) | undefined;
    const onUltimate = () => {
      if(!undoDispatch)return;
      bound?.set("onlyOpened", !ultimateOn());
      syncUltimate(ultimateOn());
    };
    const onStatus = () => {if(ultimateOn()&&coverageLease){const state=guildCoverageStatus();paintUltimate(state.connected?i18nText("ui.shared_monitoring_value_servers", {v0: state.guilds}):i18nText("ui.waiting_for_discord_to_reconnect"));}};
    window.addEventListener(ULTIMATE_EVENT, onUltimate);
    window.addEventListener(ULTIMATE_STATUS_EVENT, showUltimateStatus);
    window.addEventListener(COVERAGE_STATUS_EVENT, onStatus);
    ctx.disposable(() => {
      window.removeEventListener(ULTIMATE_EVENT, onUltimate);
      window.removeEventListener(ULTIMATE_STATUS_EVENT, showUltimateStatus);
      window.removeEventListener(COVERAGE_STATUS_EVENT, onStatus);
      syncUltimate(false);
    });
    // Coverage is acquired only after the shared event hook is ready.

    ctx.css.inject(`
      li.dion-ml-deleted {
        background-color: color-mix(in srgb, var(--status-danger, #f23f43) 16%, transparent);
        border-radius: 4px;
      }
      li.dion-ml-edited:not(.dion-ml-deleted) {
        background-color: color-mix(in srgb, var(--text-link, #00a8fc) 16%, transparent);
        border-radius: 4px;
      }
      .dion-ml-note {
        margin: 0 16px 2px 56px;
        color: var(--status-danger, #f23f43);
        font-size: 12px;
        font-weight: 600;
        line-height: 16px;
        cursor: pointer;
        user-select: none;
      }
      li.dion-ml-edited:not(.dion-ml-deleted) .dion-ml-note {
        color: var(--text-link, #00a8fc);
      }
      .dion-ml-versions {
        display: flex;
        flex-direction: column;
        margin: 0;
        padding: 0;
      }
      .dion-ml-versions.dion-ml-hidden {
        display: none;
      }
      .dion-ml-version [class*="hoverBar"],
      .dion-ml-version [class*="buttonContainer"] {
        display: none !important;
      }
      li.dion-ml-hidden > :not(.dion-ml-note) {
        display: none;
      }
    `);

    const dirty = new Set<HTMLElement>();
    let paintFrame = 0;
    const flushPaint = () => {
      paintFrame = 0;
      if(instance!==loggerEpoch){dirty.clear();return;}
      for (const item of dirty) paintItem(item);
      dirty.clear();
    };
    const mark = (node: EventTarget | null) => {
      if(instance!==loggerEpoch)return;
      if (!(node instanceof HTMLElement)) return;
      const row = node.id.startsWith("chat-messages-")
        ? node
        : node.closest?.('li[id^="chat-messages-"]');
      if (!(row instanceof HTMLElement)) return;
      dirty.add(row);
      if (!paintFrame) paintFrame = requestAnimationFrame(flushPaint);
    };

    let list: HTMLElement | undefined;
    let listObserver: MutationObserver | undefined;
    const onListClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const note = target.closest(".dion-ml-note");
      if (note instanceof HTMLElement) toggleMessage(note);
    };

    const bindList = () => {
      const next = document.querySelector('[data-list-id="chat-messages"]');
      if (!(next instanceof HTMLElement) || next === list) return;
      listObserver?.disconnect();
      list?.removeEventListener("click", onListClick);
      list = next;
      list.addEventListener("click", onListClick);
      listObserver = new MutationObserver((records) => {
        for (const record of records) {
          mark(record.target);
          for (const node of record.addedNodes) mark(node);
        }
      });
      listObserver.observe(list, { childList: true, subtree: true, attributeFilter: ["id"] });
      for (const row of list.querySelectorAll('li[id^="chat-messages-"]')) mark(row);
    };

    bindList();
    const listTimer = window.setInterval(bindList, 1000);

    let warned = false;

    const install = (): boolean => {
      if (undoDispatch) return true;
      const flux = dispatcher();
      const store = messages();
      if (!flux || !store) return false;
      const wrapped = function (action: DispatchAction, next:(action:DispatchAction)=>unknown) {
        const original=next;
        if (applying || !action || typeof action.type !== "string") {
          return original.call(flux, action);
        }
        const type = action.type;
        if (type === "CHANNEL_SELECT") {
          const selected = textOf(action, "channelId") || asId(action.channelId);
          if (selected) noteOpened(selected);
          return original.call(flux, action);
        }
        if (type === "CONNECTION_OPEN" || type === "CONNECTION_RESUMED") {
          const result = original.call(flux, action);
          return result;
        }
        if (type === "MESSAGE_CREATE") {
          const created = action.message;
          const createdChannel = created ? channelFrom(action, created) : "";
          if (created?.id && createdChannel && !applying && undoDelete(createdChannel, created.id)) {
            clearDeletedFlag(created);
            clearDeletedFlag(store.getMessage?.(createdChannel, created.id));
          }
          if (created && createdChannel && inScope(createdChannel) && !ignored(created)) rememberSeen(created);
          const createdResult = original.call(flux, action);
          if (created?.id && createdChannel) mark(document.getElementById(`chat-messages-${createdChannel}-${created.id}`));
          return createdResult;
        }
        if (type === "MESSAGE_DELETE" || type === "MESSAGE_DELETE_BULK") {
          const undo: Array<() => void> = [];
          let paintChannel = "";
          const paintIds: string[] = [];
          try {
            const parsed = collectDelete(action);
            let channelId = parsed.channelId;
            const keep = new Set<string>();
            for (const id of parsed.ids) {
              let inStore = false;
              let message = channelId ? store.getMessage?.(channelId, id) : undefined;
              if (message) inStore = true;
              if (!message) {
                const held = liveMessage(id);
                if (held && isStoreMessage(held)) {
                  message = held;
                  if (!channelId) channelId = channelIdOf(held);
                } else {
                  const cached = seen.get(id);
                  if (cached) {
                    message = cached;
                    if (!channelId) channelId = channelIdOf(cached);
                  }
                }
              }
              if (!message) {
                const selected = selectedChannelId();
                if (selected) message = store.getMessage?.(selected, id);
                if (message) {
                  channelId = selected;
                  inStore = true;
                }
              }
              if (!message || !channelId || !inScope(channelId) || ignored(message)) continue;
              if (placeholderDelete(id, message)) continue;
              rememberDelete(message);
              seen.delete(id);
              if (!inStore) {
                paintIds.push(id);
                paintChannel = channelId;
                continue;
              }
              try {
                message.deleted = true;
              } catch {
                /* immutable record */
              }
              keep.add(id);
              paintIds.push(id);
              paintChannel = channelId;
            }
            const cache = paintChannel ? store.getMessages?.(paintChannel) : undefined;
            if (cache && keep.size) undo.push(guardRemove(cache, keep));
          } catch (err) {
            ctx.log.error("delete log failed:", err);
          }
          try {
            return original.call(flux, action);
          } finally {
            for (const restoreRemove of undo) restoreRemove();
            if (paintIds.length && paintChannel) {
              const channel = paintChannel;
              const ids = paintIds.slice();
              queueMicrotask(() => {
                if(instance!==loggerEpoch)return;
                applying = true;
                try {
                  const cache = store.getMessages?.(channel);
                  for (const id of ids) {
                    if (!entry(channel, id)?.deleted) {
                      const message = store.getMessage?.(channel, id);
                      clearDeletedFlag(message);
                      mark(document.getElementById(`chat-messages-${channel}-${id}`));
                      continue;
                    }
                    const message = store.getMessage?.(channel, id);
                    if (!message && cache) {
                      const row = entry(channel, id);
                      const saved = row ? liveMessage(id) ?? plainMessage(row) : undefined;
                      if (saved) putBack(cache, saved);
                    } else if (message) {
                      try {
                        message.deleted = true;
                      } catch {
                        /* immutable record */
                      }
                    }
                    mark(document.getElementById(`chat-messages-${channel}-${id}`));
                  }
                } catch (err) {
                  ctx.log.error("delete refresh failed:", err);
                } finally {
                  applying = false;
                }
              });
            }
          }
        }
        if (type === "MESSAGE_REACTION_ADD" || type === "MESSAGE_REACTION_REMOVE") {
          try { logReaction(store, action as ReactionAction, type === "MESSAGE_REACTION_ADD"); }
          catch (err) { ctx.log.error("reaction log failed:", err); }
          return original.call(flux, action);
        }
        if (type === "MESSAGE_UPDATE") {
          const incoming = action.message;
          const channelId = incoming ? channelFrom(action, incoming) : "";
          const stored = incoming && channelId ? store.getMessage?.(channelId, incoming.id) : undefined;
          const previous = stored ?? (incoming ? seen.get(incoming.id) : undefined);
          try {
            if (
              previous &&
              incoming &&
              channelId &&
              inScope(channelId) &&
              typeof incoming.content === "string" &&
              !ignored(previous)
            ) {
              if ((previous.content ?? "") !== incoming.content) rememberEdit(previous, incoming.content);
              if (typeof incoming.pinned === "boolean" && typeof previous.pinned === "boolean" && incoming.pinned !== previous.pinned)
                rememberActivity(previous, { at: Date.now(), kind: incoming.pinned ? "pin" : "unpin" });
              rememberSeen({ ...previous, ...incoming, content: incoming.content });
            }
          } catch (err) {
            ctx.log.error("edit log failed:", err);
          }
          const result = original.call(flux, action);
          if (previous && channelId) {
            try {
              const fresh = store.getMessage?.(channelId, previous.id);
              const logged = entry(channelId, previous.id);
              if (fresh && logged?.deleted) fresh.deleted = true;
            } catch {
              /* immutable record */
            }
            mark(document.getElementById(`chat-messages-${channelId}-${previous.id}`));
          }
          return result;
        }
        if (type.startsWith("LOAD_MESSAGES")) {
          const result = original.call(flux, action);
          const channelId = channelFrom(action);
          if (channelId) {
            snapshotChannel(channelId);
            applying = true;
            try {
              restore(store, channelId);
            } catch (err) {
              ctx.log.error("restore failed:", err);
            } finally {
              applying = false;
            }
          }
          return result;
        }
        return original.call(flux, action);
      };
      try {
        undoDispatch = interceptDiscordEvents((action,next)=>wrapped(action as DispatchAction,next));
        if(ultimateOn())syncUltimate(true);
      } catch (err) {
        undoDispatch?.();undoDispatch=undefined;
        ctx.log.error("dispatch wrap failed:", err);
        return false;
      }
      noteOpened(selectedChannelId());
      ctx.log.info("logging deletes and edits");
      return true;
    };

    if (!install()) {
      const timer = window.setInterval(() => {
        if (install()) window.clearInterval(timer);
      }, 500);
      const giveUp = window.setTimeout(() => {
        window.clearInterval(timer);
        if (!undoDispatch && !warned) {
          warned = true;
          ctx.log.warn("MessageStore or FluxDispatcher not found");
        }
      }, 20_000);
      ctx.disposable(() => {
        window.clearInterval(timer);
        window.clearTimeout(giveUp);
      });
    }

    ctx.disposable(() => {
      if(instance===loggerEpoch)loggerEpoch++;
      dirty.clear();
      syncUltimate(false);
      undoDispatch?.();
      seen.clear();heldRecent.clear();openedGuilds.clear();openedDms.clear();idCache.clear();selfId="";bound=undefined;
      window.clearInterval(listTimer);
      if (paintFrame) cancelAnimationFrame(paintFrame);
      listObserver?.disconnect();
      list?.removeEventListener("click", onListClick);
      saveLogNow();
      stripPaint();
    });
  },
});
