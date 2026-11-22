import { t as i18nText } from "../../i18n";
import { showToast } from "../../ui/toast";
import { clearLogRows, visitLogRows, writeLogRows, writeLogChanges } from "./db";
import { forgetMessageFiles, queueMessageFiles, wipeSavedFiles } from "./files";

const STORAGE_KEY = "Syncord.message-logger.v1";
const FULL_NOTICE_GAP = 60_000;
const CONTENT_CAP = 8000;
const FALLBACK_CAP = 240;

export type LogEdit = {
  at: number;
  content: string;
};

/** Reactions and pins seen while logging. Newest kept, capped per message. */
export type LogActivity = {
  at: number;
  kind: "react" | "unreact" | "pin" | "unpin";
  emoji?: string;
  userId?: string;
};
const ACTIVITY_CAP = 24;

export type LogFile = {
  name: string;
  url: string;
};

export type LogEntry = {
  id: string;
  channelId: string;
  authorId: string;
  author: string;
  content: string;
  timestamp: number;
  deleted?: number;
  edits?: LogEdit[];
  activity?: LogActivity[];
  attachments?: LogFile[];
};

export type DiscordMessage = {
  id: string;
  channel_id?: string;
  channelId?: string;
  content?: string;
  flags?: number;
  timestamp?: Date | string | number;
  author?: {
    id?: string;
    username?: string;
    globalName?: string;
    global_name?: string;
    bot?: boolean;
  };
  attachments?: { filename?: string; url?: string }[];
  embeds?: { title?: string; description?: string }[];
  stickerItems?: { name?: string }[];
  stickers?: { name?: string }[];
  deleted?: boolean;
  pinned?: boolean;
};

const channels = new Map<string, Map<string, LogEntry>>();
const live = new Map<string, DiscordMessage>();
let total = 0;
let limit = 800;
let saveQueued = false;
let hydrating = false;
let hydrated = false;
let loadStarted = false;
let generation = 0;
let dirty = false;
const pendingRows = new Map<string,LogEntry|undefined>();
const WRITE_BATCH = 128;
let lastFullNotice = 0;
let lastSaveNotice = 0;
const resetHooks = new Set<() => void>();
const changeHooks = new Set<(channelId: string) => void>();

let resolveReady = (): void => {};
const ready = new Promise<void>((resolve) => {
  resolveReady = resolve;
});

let tail: Promise<void> = Promise.resolve();

function enqueue(task: () => Promise<void>): void {
  tail = tail.then(task).catch(() => {
    /* the task reports its own failure */
  });
}

/** `0` keeps every entry. Any other value is a hard cap. */
export function setLogLimit(value: number): void {
  if (!Number.isFinite(value)) return;
  limit = Math.max(0, Math.floor(value));
  evict();
  scheduleSave();
}

export function logCount(): number {
  return total;
}

export function logLimit(): number {
  return limit;
}

export function listLog(): LogEntry[] {
  const rows: LogEntry[] = [];
  for (const bucket of channels.values()) {
    for (const item of bucket.values()) rows.push(item);
  }
  rows.sort((a, b) => b.timestamp - a.timestamp || compareId(b.id, a.id));
  return rows;
}

export function whenLogReady(): Promise<void> {
  return ready;
}

/** Drop every saved message. The numeric limit stays. */
export function clearLog(): void {
  generation++;
  channels.clear();
  live.clear();
  pendingRows.clear();
  total = 0;
  dirty = false;
  saveQueued = false;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* unavailable */
  }
  const gen = generation;
  enqueue(async () => {
    if (generation !== gen) return;
    try {
      await clearLogRows();
      await wipeSavedFiles();
    } catch {
      notifySaveFailed();
    }
  });
  for (const hook of resetHooks) hook();
}

export function onLogReset(hook: () => void): () => void {
  resetHooks.add(hook);
  return () => resetHooks.delete(hook);
}

/** Fires after any logged row of a channel changes (not on hydration). */
export function onLogChange(hook: (channelId: string) => void): () => void {
  changeHooks.add(hook);
  return () => changeHooks.delete(hook);
}

/** Every logged row of one channel, oldest message first. */
export function channelLog(channelId: string): LogEntry[] {
  const bucket = channels.get(channelId);
  return bucket ? [...bucket.values()].sort((a, b) => compareId(a.id, b.id)) : [];
}

export function channelIdOf(message: DiscordMessage): string {
  return message.channel_id || message.channelId || "";
}

export function entry(channelId: string, messageId: string): LogEntry | undefined {
  return channels.get(channelId)?.get(messageId);
}

export function liveMessage(id: string): DiscordMessage | undefined {
  return live.get(id);
}

export function deletedInRange(channelId: string, oldestId: string | undefined): LogEntry[] {
  const bucket = channels.get(channelId);
  if (!bucket) return [];
  const out: LogEntry[] = [];
  for (const item of bucket.values()) {
    if (!item.deleted) continue;
    if (oldestId && compareId(item.id, oldestId) < 0) continue;
    out.push(item);
  }
  out.sort((a, b) => compareId(a.id, b.id));
  return out;
}

/** A delete followed at once by the same message arriving again was Discord replacing a placeholder. */
export function undoDelete(channelId: string, messageId: string): boolean {
  const bucket = channels.get(channelId);
  const row = bucket?.get(messageId);
  if (!bucket || !row?.deleted || Date.now() - row.deleted > 2000) return false;
  if (row.edits?.length || row.activity?.length) {
    delete row.deleted;
    write(row);
    return true;
  }
  bucket.delete(messageId);
  pendingRows.set(messageId,undefined);
  if (bucket.size === 0) channels.delete(channelId);
  live.delete(messageId);
  forgetMessageFiles(messageId);
  total = Math.max(0, total - 1);
  scheduleSave();
  return true;
}

export function rememberDelete(message: DiscordMessage): LogEntry | undefined {
  const channelId = channelIdOf(message);
  if (!channelId || !message.id) return undefined;
  const prev = entry(channelId, message.id);
  const next = base(message, prev);
  next.deleted = Date.now();
  next.content = prev?.content || next.content;
  next.edits = prev?.edits;
  next.activity = prev?.activity;
  write(next);
  // Only native records can be restored into MessageStore. Raw gateway payloads
  // already have a compact LogEntry; retaining their unused object graphs leaks RAM.
  if (hasFlag(message)) live.set(message.id, message);
  queueMessageFiles(message);
  return next;
}

export function holdMessage(message: DiscordMessage): void {
  if (!message.id || !hasFlag(message)) return;
  live.set(message.id, message);
}

export function releaseMessage(id: string): void {
  for (const bucket of channels.values()) {
    if (bucket.get(id)?.deleted) return;
  }
  live.delete(id);
}

function hasFlag(message: DiscordMessage): boolean {
  return typeof (message as { hasFlag?: unknown }).hasFlag === "function";
}

export function rememberEdit(message: DiscordMessage, nextContent: string): LogEntry | undefined {
  const channelId = channelIdOf(message);
  if (!channelId || !message.id) return undefined;
  const prev = entry(channelId, message.id);
  const previous = clip(prev?.content ?? message.content ?? "");
  const incoming = clip(nextContent);
  const stored = incoming.trim() ? incoming : fallbackText(message) || incoming;
  if (previous === stored) return prev;
  const edits = prev?.edits?.slice() ?? [];
  edits.push({ at: Date.now(), content: previous });
  const next = base(message, prev);
  next.content = stored;
  next.edits = edits;
  next.activity = prev?.activity;
  next.deleted = prev?.deleted;
  write(next);
  queueMessageFiles(message);
  return next;
}

export function rememberActivity(message: DiscordMessage, item: LogActivity): LogEntry | undefined {
  const channelId = channelIdOf(message);
  if (!channelId || !message.id) return undefined;
  const prev = entry(channelId, message.id);
  const next = base(message, prev);
  next.content = prev?.content || next.content;
  next.edits = prev?.edits;
  next.deleted = prev?.deleted;
  next.activity = [...(prev?.activity ?? []), item].slice(-ACTIVITY_CAP);
  write(next);
  return next;
}

export function loadLog(): void {
  if (loadStarted) return;
  loadStarted = true;
  hydrating = true;
  enqueue(async () => {
    const gen = generation;
    try {
      await hydrate(gen);
    } catch {
      notifySaveFailed();
    } finally {
      hydrating = false;
      hydrated = true;
      resolveReady();
      // Clear resets dirty/pending rows; any remaining dirty state belongs to
      // the current generation, including events received during cancelled hydration.
      if (dirty) scheduleSave();
    }
  });
}

export function saveLogNow(): void {
  scheduleSave();
}

function base(message: DiscordMessage, prev: LogEntry | undefined): LogEntry {
  const author = message.author;
  return {
    id: message.id,
    channelId: channelIdOf(message),
    authorId: author?.id ?? prev?.authorId ?? "",
    author: authorName(author) || prev?.author || i18nText("ui.unknown"),
    content: textOf(message, prev),
    timestamp: prev?.timestamp ?? timeOf(message),
    attachments: prev?.attachments ?? filesOf(message),
  };
}

function write(item: LogEntry): void {
  let bucket = channels.get(item.channelId);
  if (!bucket) {
    bucket = new Map();
    channels.set(item.channelId, bucket);
  }
  const isNew = !bucket.has(item.id);
  if (isNew) total++;
  bucket.set(item.id, item);
  pendingRows.set(item.id,item);
  evict();
  scheduleSave();
  for (const hook of changeHooks) {
    try { hook(item.channelId); } catch { /* a viewer's failure must not break logging */ }
  }
  if (!hydrating && isNew && limit > 0 && total >= limit) notifyLimitFull();
}

function notifyLimitFull(): void {
  const now = Date.now();
  if (now - lastFullNotice < FULL_NOTICE_GAP) return;
  lastFullNotice = now;
  window.setTimeout(() => showToast(i18nText("ui.log_limit_is_full")), 0);
}

function notifySaveFailed(): void {
  const now = Date.now();
  if (now - lastSaveNotice < FULL_NOTICE_GAP) return;
  lastSaveNotice = now;
  window.setTimeout(() => showToast(i18nText("ui.could_not_save_the_message_log")), 0);
}

function evict(): void {
  if (limit <= 0) return;
  while (total > limit) {
    let oldest: LogEntry | undefined;
    for (const bucket of channels.values()) {
      for (const item of bucket.values()) {
        if (!oldest || item.timestamp < oldest.timestamp) oldest = item;
      }
    }
    if (!oldest) return;
    channels.get(oldest.channelId)?.delete(oldest.id);
    live.delete(oldest.id);
    pendingRows.set(oldest.id,undefined);
    dirty=true;
    forgetMessageFiles(oldest.id);
    total--;
    if (channels.get(oldest.channelId)?.size === 0) channels.delete(oldest.channelId);
  }
}

function scheduleSave(): void {
  dirty = true;
  if (!hydrated || saveQueued) return;
  saveQueued = true;
  enqueue(flush);
}

async function flush(): Promise<void> {
  saveQueued = false;
  const gen = generation;
  if (!hydrated || !dirty) return;
  const batch:Array<readonly [string,LogEntry|undefined]>=[];
  for(const change of pendingRows){batch.push(change);if(batch.length===WRITE_BATCH)break;}
  for(const [id] of batch)pendingRows.delete(id);
  dirty = pendingRows.size>0;
  if(!batch.length)return;
  try {
    await writeLogChanges(batch);
  } catch {
    if(generation===gen){
      for(const [id,value] of batch)if(!pendingRows.has(id))pendingRows.set(id,value);
      dirty=true;
    }
    notifySaveFailed();return;
  }
  if(pendingRows.size && generation===gen)scheduleSave();
}

async function hydrate(gen: number): Promise<void> {
  let found=false;
  await visitLogRows(value=>{
    if(generation!==gen)return false;
    const row=normalize(value);if(!row)return;
    found=true;
    // Events received while IndexedDB is opening win over older stored rows.
    if(!entry(row.channelId,row.id))writeQuiet(row);
  });
  if(generation!==gen||found)return;
  const legacy=readLegacy();
  if(!legacy.length)return;
  legacy.sort((a,b)=>b.timestamp-a.timestamp);
  try{
    await writeLogRows(limit>0?legacy.slice(0,limit):legacy);
    if(generation!==gen)return;
    localStorage.removeItem(STORAGE_KEY);
  }catch{notifySaveFailed();}
  for(const row of legacy){
    if(generation!==gen)return;
    if(!entry(row.channelId,row.id))writeQuiet(row);
  }
}

function readLegacy(): LogEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: LogEntry[] = [];
    for (const row of parsed) {
      const item = normalize(row);
      if (item) out.push(item);
    }
    return out;
  } catch {
    return [];
  }
}

function writeQuiet(item: LogEntry): void {
  let bucket = channels.get(item.channelId);
  if (!bucket) {
    bucket = new Map();
    channels.set(item.channelId, bucket);
  }
  if (!bucket.has(item.id)) total++;
  bucket.set(item.id, item);
  evict();
}

function authorName(author: DiscordMessage["author"]): string {
  return author?.globalName || author?.global_name || author?.username || "";
}

function filesOf(message: DiscordMessage): LogFile[] | undefined {
  if (!Array.isArray(message.attachments) || message.attachments.length === 0) return undefined;
  const files: LogFile[] = [];
  for (const file of message.attachments) {
    if (!file?.url) continue;
    files.push({ name: file.filename || "file", url: file.url });
    if (files.length >= 8) break;
  }
  return files.length ? files : undefined;
}

function textOf(message: DiscordMessage, prev: LogEntry | undefined): string {
  const raw = typeof message.content === "string" ? message.content : "";
  if (raw.trim()) return clip(raw);
  const fallback = fallbackText(message);
  if (fallback) return fallback;
  return clip(prev?.content ?? "");
}

function fallbackText(message: DiscordMessage): string {
  const embeds = message.embeds;
  if (Array.isArray(embeds)) {
    for (const embed of embeds) {
      if (!embed) continue;
      const title = typeof embed.title === "string" ? embed.title.trim() : "";
      const description = typeof embed.description === "string" ? embed.description.trim() : "";
      const text = title && description ? `${title} — ${description}` : title || description;
      if (text) return short(text);
    }
  }
  const stickers = [
    ...(Array.isArray(message.stickerItems) ? message.stickerItems : []),
    ...(Array.isArray(message.stickers) ? message.stickers : []),
  ];
  for (const sticker of stickers) {
    const name = typeof sticker?.name === "string" ? sticker.name.trim() : "";
    if (name) return short(name);
  }
  if (Array.isArray(message.attachments) && message.attachments.some((file) => file && (file.url || file.filename))) {
    return i18nText("ui.attachment");
  }
  if (Array.isArray(embeds) && embeds.length > 0) return i18nText("ui.embed");
  return "";
}

function clip(text: string): string {
  return text.length > CONTENT_CAP ? text.slice(0, CONTENT_CAP) : text;
}

function short(text: string): string {
  return text.length > FALLBACK_CAP ? `${text.slice(0, FALLBACK_CAP)}…` : text;
}

function timeOf(message: DiscordMessage): number {
  const stamp = message.timestamp;
  if (stamp instanceof Date) return stamp.getTime();
  if (typeof stamp === "number") return stamp;
  if (typeof stamp === "string") {
    const parsed = Date.parse(stamp);
    if (!Number.isNaN(parsed)) return parsed;
  }
  try {
    return Number((BigInt(message.id) >> 22n) + 1420070400000n);
  } catch {
    return Date.now();
  }
}

function compareId(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function isEdit(value: unknown): value is LogEdit {
  if (!value || typeof value !== "object") return false;
  const row = value as LogEdit;
  return typeof row.at === "number" && typeof row.content === "string";
}

const ACTIVITY_KINDS: ReadonlySet<string> = new Set(["react", "unreact", "pin", "unpin"]);
function isActivity(value: unknown): value is LogActivity {
  if (!value || typeof value !== "object") return false;
  const row = value as LogActivity;
  return typeof row.at === "number" && ACTIVITY_KINDS.has(row.kind)
    && (row.emoji === undefined || typeof row.emoji === "string")
    && (row.userId === undefined || typeof row.userId === "string");
}

function isFile(value: unknown): value is LogFile {
  if (!value || typeof value !== "object") return false;
  const row = value as LogFile;
  return typeof row.url === "string" && row.url.length > 0;
}

function normalize(value: unknown): LogEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as LogEntry;
  if (typeof row.id !== "string" || typeof row.channelId !== "string") return undefined;
  const edits = Array.isArray(row.edits) ? row.edits.filter(isEdit) : undefined;
  const activity = Array.isArray(row.activity) ? row.activity.filter(isActivity).slice(-ACTIVITY_CAP) : undefined;
  const attachments = Array.isArray(row.attachments)
    ? row.attachments.filter(isFile).slice(0, 8).map((file) => ({
        name: typeof file.name === "string" && file.name ? file.name : "file",
        url: file.url,
      }))
    : undefined;
  return {
    id: row.id,
    channelId: row.channelId,
    authorId: typeof row.authorId === "string" ? row.authorId : "",
    author: typeof row.author === "string" && row.author ? row.author : i18nText("ui.unknown"),
    content: typeof row.content === "string" ? clip(row.content) : "",
    timestamp: typeof row.timestamp === "number" ? row.timestamp : Date.now(),
    deleted: typeof row.deleted === "number" ? row.deleted : undefined,
    edits: edits?.length ? edits : undefined,
    activity: activity?.length ? activity : undefined,
    attachments: attachments?.length ? attachments : undefined,
  };
}
