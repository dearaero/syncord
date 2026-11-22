import { t as i18nText } from "../../i18n";
import { createLogger } from "../../api/logger";
import { planTargets, type GuildInput } from "./targets";

/**
 * Marking read state, through the client's own machinery.
 *
 * The read state belongs to Discord: it is held in `ReadStateStore`, mirrored to
 * the server by the acknowledgement the client performs when it opens a
 * channel, and drawn as the badges in the server list. Writing it from outside
 * — a hand-built HTTP call, a hand-written Flux action — would leave the
 * client's own copy behind and the badges would come straight back, so every
 * target here is acknowledged by a function the client itself exposes.
 *
 * Everything below is optional and guarded. Discord reshapes these modules
 * between releases, and the cost of a rename has to be a feature that reports
 * it did nothing, never a plugin that throws inside a click handler.
 */

const log = createLogger("mark-all-as-read:readstate");

/** Discord's `ChannelType.DM` and `ChannelType.GROUP_DM`. */
const DM_TYPES = new Set([1, 3]);

/**
 * Threads keep their own read state. The current BULK_ACK path includes active
 * joined threads explicitly; the legacy per-guild fallback keeps them separate.
 */
const THREAD_TYPES = new Set([10, 11, 12]);

type ChannelLike = {
  id?: string;
  type?: number;
  guild_id?: string;
};

type ReadStateStoreLike = {
  isGuildUnread?: (guildId: string) => boolean;
  isChannelUnread?: (channelId: string) => boolean;
  hasUnread?: (channelId: string) => boolean;
  lastMessageId?: (channelId: string) => string | undefined;
};

type ChannelStoreLike = {
  getChannels?: () => Record<string, ChannelLike>;
  getMutablePrivateChannels?: () => Record<string, ChannelLike>;
  getSortedPrivateChannels?: () => ChannelLike[];
};

type GuildStoreLike = {
  getGuilds?: () => Record<string, unknown>;
};

type GuildChannelBucket = {
  SELECTABLE?: Array<{ channel?: ChannelLike }>;
  VOCAL?: Array<{ channel?: ChannelLike }>;
};

type GuildChannelStoreLike = {
  getChannels?: (guildId: string) => GuildChannelBucket;
};

type ActiveJoinedThreadsStoreLike = {
  getActiveJoinedThreadsForGuild?: (
    guildId: string,
  ) => Record<
    string,
    Record<string, ChannelLike | { channel?: ChannelLike }>
  >;
};

type BulkAckState = {
  channelId: string;
  messageId: string;
  readStateType: 0;
};

type FluxDispatcherLike = {
  dispatch?: (action: {
    type: string;
    context: string;
    channels: BulkAckState[];
  }) => unknown;
};

/** A resolved acknowledgement, plus which shape it came from. */
type Ack = {
  source: string;
  channel?: (id: string) => unknown;
  guild?: (id: string) => unknown;
};

export type MarkOutcome = {
  ok: boolean;
  guilds: number;
  channels: number;
  /**
   * What the client said it knew about, before any unread check ran.
   *
   * Without this, "nothing was acknowledged" and "there was nothing to
   * acknowledge" are the same sentence, and only one of them is ever true.
   */
  considered: { guilds: number; dms: number };
  /** The acknowledgement used, or why nothing could be done. */
  detail: string;
};

/** Call through, turning a throw into `undefined`. */
function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function stores(): Record<string, unknown> | undefined {
  return window.Syncord?.common?.stores as
    | Record<string, unknown>
    | undefined;
}

function readStateStore(): ReadStateStoreLike | undefined {
  const fromCommon = stores()?.ReadStateStore as ReadStateStoreLike | undefined;
  if (fromCommon) return fromCommon;
  return window.Syncord?.webpack?.findByStoreName?.(
    "ReadStateStore",
  ) as ReadStateStoreLike | undefined;
}

function channelStore(): ChannelStoreLike | undefined {
  const fromCommon = stores()?.ChannelStore as ChannelStoreLike | undefined;
  if (fromCommon) return fromCommon;
  return window.Syncord?.webpack?.findByStoreName?.(
    "ChannelStore",
  ) as ChannelStoreLike | undefined;
}

function guildStore(): GuildStoreLike | undefined {
  const fromCommon = stores()?.GuildStore as GuildStoreLike | undefined;
  if (fromCommon) return fromCommon;
  return window.Syncord?.webpack?.findByStoreName?.(
    "GuildStore",
  ) as GuildStoreLike | undefined;
}

function guildChannelStore(): GuildChannelStoreLike | undefined {
  const fromCommon = stores()?.GuildChannelStore as GuildChannelStoreLike | undefined;
  if (fromCommon) return fromCommon;
  return window.Syncord?.webpack?.findByStoreName?.(
    "GuildChannelStore",
  ) as GuildChannelStoreLike | undefined;
}

function activeJoinedThreadsStore(): ActiveJoinedThreadsStoreLike | undefined {
  const fromCommon = stores()?.ActiveJoinedThreadsStore as
    | ActiveJoinedThreadsStoreLike
    | undefined;
  if (fromCommon) return fromCommon;
  return window.Syncord?.webpack?.findByStoreName?.(
    "ActiveJoinedThreadsStore",
  ) as ActiveJoinedThreadsStoreLike | undefined;
}

function fluxDispatcher(): FluxDispatcherLike | undefined {
  return window.Syncord?.common?.flux?.FluxDispatcher as
    | FluxDispatcherLike
    | undefined;
}

// ── legacy acknowledgement discovery fallback ───────────────────────────────

/**
 * Which names count as an acknowledgement.
 *
 * Vocabulary-based rather than a list of exact spellings: the whole point of
 * looking is not to care what the client happened to call it. A name that both
 * says "acknowledge" and says *what* it acknowledges cannot belong to anything
 * else, so it is taken as it stands. A bare `ack` says neither, and plenty of
 * unrelated modules have one, so it is only taken from a module that also
 * acknowledges guilds — that pairing is what identifies a module as the
 * read-state one rather than analytics, a socket or a voice connection.
 *
 * `SAYS_WHAT` deliberately leaves "guild" out: a method that names a server
 * acknowledges a server, and letting it answer for a channel as well would let
 * `acknowledgeGuild` be picked as the per-channel acknowledgement.
 */
const ACKISH = /ack|acknowledg/i;
const MARKED_READ = /mark.*read|read.*mark/i;
const SAYS_WHAT = /read|channel|dm|thread|message|state|bulk/i;
const SAYS_GUILD = /guild/i;

function isChannelAckName(name: string): boolean {
  return (ACKISH.test(name) || MARKED_READ.test(name)) && SAYS_WHAT.test(name);
}

function isGuildAckName(name: string): boolean {
  return (ACKISH.test(name) || MARKED_READ.test(name)) && SAYS_GUILD.test(name);
}

/** A bare `ack`: acknowledges something, but does not say what. */
function isBareAckName(name: string): boolean {
  return ACKISH.test(name) && !SAYS_WHAT.test(name);
}

/**
 * A method bound to its owner.
 *
 * Discord's own call sites reach sibling methods through `this`, so a detached
 * reference would throw inside the client rather than here. The prototype is
 * consulted first because a module exporting a bare class keeps its methods
 * there, where reading them off the export would find nothing at all.
 */
function method(
  owner: unknown,
  name: string,
): ((id: string) => unknown) | undefined {
  if (owner == null) return undefined;
  const proto =
    typeof owner === "function" ? (owner as { prototype?: object }).prototype : undefined;
  const fromProto = proto ? safe(() => (proto as Record<string, unknown>)[name]) : undefined;
  const value =
    typeof fromProto === "function"
      ? fromProto
      : safe(() => (owner as Record<string, unknown>)[name]);
  if (typeof value !== "function") return undefined;
  return (value as (id: string) => unknown).bind(owner);
}

/** Property names on an owner, without reading a single value. */
function nameOnly(owner: unknown): string[] {
  if (owner == null) return [];
  const names = new Set<string>();
  const add = (obj: object | null | undefined): void => {
    if (!obj) return;
    for (const key of Object.getOwnPropertyNames(obj)) {
      if (key !== "constructor") names.add(key);
    }
  };

  try {
    if (typeof owner === "function") {
      // A module exporting a bare class: its methods are on the prototype.
      add((owner as { prototype?: object }).prototype);
      return [...names];
    }
    let level: object | null = owner as object;
    const seen = new Set<object>();
    while (level && level !== Object.prototype && !seen.has(level)) {
      seen.add(level);
      add(level);
      level = Object.getPrototypeOf(level);
    }
  } catch {
    /* a module that refuses to be inspected is simply not a candidate */
  }
  return [...names];
}

/** The `default` re-export, which is where some modules keep the real thing. */
function defaultOf(owner: unknown): unknown {
  if (owner == null) return undefined;
  const value = safe(() => (owner as Record<string, unknown>).default);
  return value != null && (typeof value === "object" || typeof value === "function")
    ? value
    : undefined;
}

/** Every callable name on an owner, its prototype chain included. */
function callableNames(owner: unknown): string[] {
  const names = new Set<string>();

  const collect = (root: object | null | undefined): void => {
    const seen = new Set<object>();
    let level: object | null = root ?? null;
    while (level && level !== Object.prototype && level !== Function.prototype && !seen.has(level)) {
      seen.add(level);
      for (const key of Object.getOwnPropertyNames(level)) {
        if (key === "constructor") continue;
        // Read from the level rather than from the owner, so a class export's
        // prototype methods are found at all.
        if (typeof safe(() => (level as Record<string, unknown>)[key]) === "function") {
          names.add(key);
        }
      }
      level = safe(() => Object.getPrototypeOf(level)) ?? null;
    }
  };

  // A module exporting a bare class keeps its methods on the prototype, which a
  // walk from the export itself would never reach.
  if (typeof owner === "function") collect((owner as { prototype?: object }).prototype);
  collect(owner as object);
  return [...names];
}

type Picked = { name: string; call: (id: string) => unknown };

function pickNamed(
  owners: unknown[],
  test: (name: string) => boolean,
): Picked | undefined {
  for (const owner of owners) {
    if (owner == null) continue;
    const names = safe(() => callableNames(owner as object));
    if (!names) continue;
    for (const name of names) {
      if (!test(name)) continue;
      const call = method(owner, name);
      if (call) return { name, call };
    }
  }
  return undefined;
}

type Candidate = {
  ack: Ack;
  /** How much the shape says about itself; higher wins. */
  score: number;
  label: string;
};

/** The owner plus its `default` re-export, which is where a name may live. */
function ownerPair(owner: unknown): unknown[] {
  const nested = defaultOf(owner);
  return nested ? [owner, nested] : [owner];
}

function labelFor(owners: unknown[], moduleId: string, picks: string[]): string {
  const displayName = safe(
    () => (owners[0] as { constructor?: { displayName?: string } })?.constructor?.displayName,
  );
  const who = typeof displayName === "string" && displayName ? displayName : moduleId;
  return `${who}.${picks.join("/")}`;
}

/**
 * Read an acknowledgement off one module, or decide it is not one.
 *
 * A server ack is optional: DMs cannot be acknowledged as a group, so a module
 * with only a channel ack is still usable, and the per-channel fallback covers
 * servers too. What is *not* allowed is a bare `ack` on its own, because that
 * would report a success while marking nothing.
 */
function readCandidate(owner: unknown, moduleId: string): Candidate | undefined {
  // Names only, no value reads: this is the filter that lets the whole cache be
  // examined without invoking a single lazy getter on a live client object.
  const owners = ownerPair(owner);
  const hinted = owners.flatMap((o) => nameOnly(o));
  if (!hinted.some((n) => isChannelAckName(n) || isGuildAckName(n) || isBareAckName(n))) {
    return undefined;
  }

  const guild = pickNamed(owners, isGuildAckName);
  const specific = pickNamed(owners, isChannelAckName);
  // A bare `ack` is the last resort, and only ever with a server ack beside it:
  // that pairing is what says the module is the read-state one. On its own it
  // would report a success while marking nothing.
  const bare = specific ? undefined : pickNamed(owners, isBareAckName);
  if (!specific && !(bare && guild)) return undefined;

  const channel = specific ?? bare;
  if (!channel) return undefined;

  const picks = [channel.name, ...(guild ? [guild.name] : [])];
  const label = labelFor(owners, moduleId, picks);
  return {
    ack: { source: label, channel: channel.call, guild: guild?.call },
    score: (specific ? 2 : 1) + (guild ? 1 : 0),
    label,
  };
}

/** The modules the client has already run, which is all this may look at. */
function* loadedModules(): Generator<{ id: string; exports: unknown }> {
  const cache = safe(() => window.Syncord?.webpack?.getRequire?.()?.c);
  if (!cache) return;
  for (const id of Object.keys(cache)) {
    const entry = safe(() => cache[id]);
    // `loaded !== true` means the factory has not run. Running it here would be
    // forcing Discord's own initialisation, which has frozen this UI before.
    if (!entry || entry.loaded !== true) continue;
    yield { id, exports: entry.exports };
  }
}

type Discovery = { ack: Ack | undefined; candidates: string[] };

/** The sweep's share of a click, and how many names it keeps for the log. */
const SWEEP_BUDGET_MS = 400;
const SWEEP_LABELS = 16;

/**
 * Find the acknowledgement by looking, rather than by guessing its name.
 *
 * Passes, cheapest first. The store, because it is resolved anyway for the
 * unread checks. Then one named property, for the build where the ack sits in
 * its own action module. Then every module the client has already run, filtered
 * by property *name* and scored by how much the shape says about itself.
 *
 * ## Why the budget is time and not a count
 *
 * The first version of this sweep stopped after 400 modules and found nothing,
 * in a client whose cache holds several thousand: the read-state module simply
 * is not among the first few hundred to load, and the number that was stopping
 * it had nothing to do with how long the search takes. So the ceiling is now
 * milliseconds, the filter reads no values at all, and the answer is cached —
 * a click must never turn into a stall, and while the client is running the
 * answer cannot change.
 */
let cachedAck: Ack | undefined;
let cachedCandidates: string[] = [];

function discoverAck(store: ReadStateStoreLike | undefined): Discovery {
  if (cachedAck) return { ack: cachedAck, candidates: cachedCandidates };

  const direct = readCandidate(store, "ReadStateStore");
  if (direct) {
    cachedAck = direct.ack;
    cachedCandidates = [direct.label];
    return { ack: cachedAck, candidates: cachedCandidates };
  }

  const byProps = safe(() => window.Syncord?.webpack?.findByProps?.("acknowledgeChannel"));
  const named = readCandidate(byProps, i18nText("ui.action_module"));
  if (named) {
    cachedAck = named.ack;
    cachedCandidates = [named.label];
    return { ack: cachedAck, candidates: cachedCandidates };
  }

  let best: Candidate | undefined;
  const labels: string[] = [];
  const started = Date.now();

  try {
    for (const { id, exports } of loadedModules()) {
      if (exports == null) continue;
      const found = readCandidate(exports, id);
      if (found) {
        if (labels.length < SWEEP_LABELS) labels.push(found.label);
        if (!best || found.score > best.score) best = found;
        // A named channel ack *and* a named server ack on one module is the whole
        // shape; nothing can score higher.
        if (best.score >= 3) break;
      }
      if (Date.now() - started > SWEEP_BUDGET_MS) break;
    }
  } catch (err) {
    log.warn("the module sweep failed:", err);
  }

  cachedCandidates = labels;
  cachedAck = best?.ack;
  return { ack: cachedAck, candidates: cachedCandidates };
}

/**
 * Forget the cached acknowledgement.
 *
 * For tests, which stand up a different client per case. The same idea exists in
 * the webpack layer as `clearFindCache`.
 */
export function resetAckDiscovery(): void {
  cachedAck = undefined;
  cachedCandidates = [];
}

/**
 * What the store actually exposes, for the failure log.
 *
 * This is the diagnostic that turns "it did nothing" into something actionable:
 * the names are what the sweep would be narrowed against, so one run is enough
 * to fix this against the real client instead of against a guess.
 */
function describeStore(store: ReadStateStoreLike | undefined): string {
  if (!store) return i18nText("ui.no_readstatestore");
  const names = new Set<string>();
  const callables = safe(() => callableNames(store as object));
  if (callables) for (const key of callables) names.add(key);
  const list = [...names].sort();
  return list.length > 0 ? list.join(", ") : i18nText("ui.no_callable_members");
}

// ── preferred current-client path: Discord's own BULK_ACK action ────────────

type BulkCandidate = {
  id: string;
  guildId?: string;
  dm: boolean;
};

function currentBulkCandidates(): {
  guilds: number;
  dms: number;
  channels: BulkCandidate[];
} {
  const guildIds = Object.keys(safe(() => guildStore()?.getGuilds?.()) ?? {});
  const candidates = new Map<string, BulkCandidate>();

  const add = (channel: ChannelLike | undefined, guildId?: string): void => {
    const id = channel?.id;
    if (!id) return;
    candidates.set(id, {
      id,
      guildId,
      dm: typeof channel.type === "number" && DM_TYPES.has(channel.type),
    });
  };

  const guildChannels = guildChannelStore();
  const activeThreads = activeJoinedThreadsStore();

  for (const guildId of guildIds) {
    const bucket = safe(() => guildChannels?.getChannels?.(guildId));
    for (const entry of bucket?.SELECTABLE ?? []) add(entry?.channel, guildId);
    for (const entry of bucket?.VOCAL ?? []) add(entry?.channel, guildId);

    const threadGroups = safe(() =>
      activeThreads?.getActiveJoinedThreadsForGuild?.(guildId),
    );
    if (threadGroups) {
      for (const group of Object.values(threadGroups)) {
        for (const entry of Object.values(group ?? {})) {
          const thread =
            entry && typeof entry === "object" && "channel" in entry
              ? entry.channel
              : entry as ChannelLike;
          add(thread, guildId);
        }
      }
    }
  }

  const channels = channelStore();
  const privateMap = safe(() => channels?.getMutablePrivateChannels?.());
  if (privateMap) {
    for (const channel of Object.values(privateMap)) {
      if (typeof channel?.type === "number" && DM_TYPES.has(channel.type)) {
        add(channel);
      }
    }
  } else {
    const privateList = safe(() => channels?.getSortedPrivateChannels?.());
    if (Array.isArray(privateList)) {
      for (const channel of privateList) {
        if (typeof channel?.type === "number" && DM_TYPES.has(channel.type)) {
          add(channel);
        }
      }
    }
  }

  // Compatibility fallback for older Discord builds where the specialised
  // stores do not expose the current helpers. This is intentionally secondary:
  // current Stable/Canary use the GuildChannelStore/private-channel shapes
  // above, which match Discord's own read-all path.
  if (candidates.size === 0) {
    const all = safe(() => channels?.getChannels?.()) ?? {};
    for (const channel of Object.values(all)) {
      const guildId = channel?.guild_id;
      if (typeof channel?.type === "number" && THREAD_TYPES.has(channel.type)) {
        add(channel, guildId);
        continue;
      }
      if (typeof channel?.type === "number" && DM_TYPES.has(channel.type)) {
        add(channel);
        continue;
      }
      if (guildId) add(channel, guildId);
    }
  }

  let dms = 0;
  for (const candidate of candidates.values()) {
    if (candidate.dm) dms += 1;
  }
  return { guilds: guildIds.length, dms, channels: [...candidates.values()] };
}

/**
 * Prefer Discord's current explicit BULK_ACK Flux action instead of guessing
 * an acknowledgement function by its minified/name-shaped export.
 *
 * Current client integrations dispatch:
 *   { type: "BULK_ACK", context: "APP", channels: [...] }
 *
 * The name-based resolver remains below only as a compatibility fallback for a
 * future/older build where the current dispatcher/read-state shape is absent.
 */
function tryBulkAck(store: ReadStateStoreLike | undefined): MarkOutcome | undefined {
  const dispatcher = fluxDispatcher();
  if (
    typeof dispatcher?.dispatch !== "function" ||
    typeof store?.lastMessageId !== "function"
  ) {
    return undefined;
  }

  const targets = currentBulkCandidates();
  const considered = { guilds: targets.guilds, dms: targets.dms };
  if (targets.channels.length === 0) return undefined;

  const unread = typeof store.hasUnread === "function"
    ? targets.channels.filter((target) => safe(() => store.hasUnread?.(target.id)) === true)
    : targets.channels;

  // A false-negative unread probe may cost redundant idempotent ACKs if ignored;
  // trusting it may leave every badge untouched. If it vetoes the whole run,
  // acknowledge every known target instead.
  const selected = unread.length > 0 ? unread : targets.channels;
  if (unread.length === 0 && targets.channels.length > 0) {
    log.info("hasUnread reported nothing unread; BULK_ACK will acknowledge all known targets");
  }

  const states: BulkAckState[] = [];
  const selectedMeta = new Map<string, BulkCandidate>();
  for (const target of selected) {
    const messageId = safe(() => store.lastMessageId?.(target.id));
    if (typeof messageId !== "string" || messageId.length === 0) continue;
    states.push({ channelId: target.id, messageId, readStateType: 0 });
    selectedMeta.set(target.id, target);
  }

  if (states.length === 0) {
    log.warn("BULK_ACK was available, but no target had a usable lastMessageId");
    return undefined;
  }

  try {
    dispatcher.dispatch({
      type: "BULK_ACK",
      context: "APP",
      channels: states,
    });
  } catch (err) {
    log.warn("Discord rejected the BULK_ACK dispatch:", err);
    return {
      ok: false,
      guilds: 0,
      channels: 0,
      considered,
      detail: i18nText("ui.discord_s_bulk_ack_action_failed"),
    };
  }

  const guildsAcked = new Set<string>();
  let dmsAcked = 0;
  for (const state of states) {
    const meta = selectedMeta.get(state.channelId);
    if (!meta) continue;
    if (meta.dm) dmsAcked += 1;
    else if (meta.guildId) guildsAcked.add(meta.guildId);
  }

  const detail =
    i18nText("ui.value_server_s_and_value_dm_s_via_fluxdispatcher_bulk_ack", {v0: guildsAcked.size, v1: dmsAcked});
  log.info(`mark all as read: ${detail}; ${states.length} read state(s) dispatched`);

  return {
    ok: true,
    guilds: guildsAcked.size,
    channels: dmsAcked,
    considered,
    detail,
  };
}

// ── the work ────────────────────────────────────────────────────────────────

/** The servers and DM channels the client currently knows about. */
function readTargets(): { guilds: GuildInput[]; dms: string[] } {
  const channels = safe(() => channelStore()?.getChannels?.()) ?? {};
  const guildIds = Object.keys(safe(() => guildStore()?.getGuilds?.()) ?? {});

  const byGuild = new Map<string, string[]>();
  const dms: string[] = [];

  for (const channel of Object.values(channels)) {
    const id = channel?.id;
    if (!id) continue;
    if (typeof channel.type === "number" && DM_TYPES.has(channel.type)) {
      dms.push(id);
      continue;
    }
    const guildId = channel.guild_id;
    if (!guildId) continue;
    if (typeof channel.type === "number" && THREAD_TYPES.has(channel.type)) {
      continue;
    }
    const list = byGuild.get(guildId);
    if (list) list.push(id);
    else byGuild.set(guildId, [id]);
  }

  return {
    guilds: guildIds.map((id) => ({ id, channels: byGuild.get(id) ?? [] })),
    dms,
  };
}

export function markAllAsRead(): MarkOutcome {
  const store = readStateStore();

  // Current Discord uses one explicit BULK_ACK Flux action. Prefer that exact
  // contract; name-based ack discovery is only a compatibility fallback.
  const bulk = tryBulkAck(store);
  if (bulk) return bulk;

  const { ack, candidates } = discoverAck(store);
  if (!ack?.channel) {
    const detail = i18nText("ui.discord_s_read_state_acknowledgement_was_not_found");
    // The candidates are the point of the line: they say what the client *does*
    // expose, which is what this would be narrowed against. One run is enough.
    log.warn(`${detail}. ReadStateStore exposes: ${describeStore(store)}`);
    log.warn(
      `acknowledgement-shaped callables in loaded modules: ${
        candidates.length > 0 ? candidates.join(" · ") : "none"
      }`,
    );
    return { ok: false, guilds: 0, channels: 0, considered: { guilds: 0, dms: 0 }, detail };
  }

  const { guilds, dms } = readTargets();
  const considered = { guilds: guilds.length, dms: dms.length };
  log.info(`the client knows about ${considered.guilds} server(s) and ${considered.dms} DM(s)`);
  if (considered.guilds === 0 && considered.dms === 0) {
    const detail = i18nText("ui.discord_s_channel_and_guild_stores_were_not_reachable");
    log.warn(`${detail}. ChannelStore and GuildStore resolved to nothing`);
    return { ok: false, guilds: 0, channels: 0, considered, detail };
  }

  const probe = {
    isGuildUnread: (id: string) => safe(() => store?.isGuildUnread?.(id)),
    isChannelUnread: (id: string) =>
      safe(() => store?.isChannelUnread?.(id)) ?? safe(() => store?.hasUnread?.(id)),
  };
  const guildAck = typeof ack.guild === "function";
  let plan = planTargets(guilds, dms, probe, { guildAck });

  /**
   * The unread checks are advisory, and must not be allowed to veto the run.
   *
   * A plan of nothing has two possible causes and this code cannot tell them
   * apart: the account really has nothing unread, or the check means something
   * other than what it is being asked. Guessing wrong in the first direction is
   * silent and total — the badges stay and the feature does nothing, which is
   * exactly the failure that shipped. Acknowledging a channel that was already
   * read is a no-op the server ignores, so when the checks report nothing to do
   * they are dropped for this run and everything is acknowledged instead.
   */
  if (plan.guilds.length === 0 && plan.channels.length === 0) {
    log.info("the unread checks reported nothing unread; acknowledging everything instead");
    plan = planTargets(guilds, dms, {}, { guildAck });
  }

  if (plan.assumedUnread) {
    log.info("the client could not report unread servers; treating all of them as unread");
  }

  let guildsAcked = 0;
  let channelsAcked = 0;
  const failed: string[] = [];

  const run = (id: string, fn?: (id: string) => unknown): void => {
    if (!fn) return;
    try {
      fn(id);
    } catch (err) {
      if (failed.length < 5) failed.push(id);
      log.warn(`acknowledging ${id} failed:`, err);
    }
  };

  for (const id of plan.guilds) {
    run(id, ack.guild);
    guildsAcked += 1;
  }
  for (const id of plan.channels) {
    run(id, ack.channel);
    channelsAcked += 1;
  }

  const total = guildsAcked + channelsAcked;
  const detail =
    total === 0
      ? i18nText("ui.nothing_was_unread")
      : i18nText("ui.value_server_s_and_value_dm_channel_s_via_value", {v0: guildsAcked, v1: channelsAcked, v2: ack.source});

  log.info(`mark all as read: ${detail}`);
  if (failed.length > 0) {
    log.warn(`${failed.length} acknowledgement(s) did not go through`);
  }
  return {
    ok: total > 0 && failed.length === 0,
    guilds: guildsAcked,
    channels: channelsAcked,
    considered,
    detail,
  };
}
