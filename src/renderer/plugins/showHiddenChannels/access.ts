type Channel = {
  id?: string;
  name?: string;
  type?: number;
  topic?: string | null;
  nsfw?: boolean;
  position?: number;
  guild_id?: string;
  guildId?: string;
  parent_id?: string | null;
  parentId?: string | null;
  permissionOverwrites?: unknown;
  permission_overwrites?: unknown;
  isDM?: () => boolean;
  isGroupDM?: () => boolean;
  isMultiUserDM?: () => boolean;
  isThread?: () => boolean;
  isCategory?: () => boolean;
  isVocal?: () => boolean;
};

type PermStore = {
  can?: (permission: unknown, channel: unknown) => unknown;
};

const VIEW_CHANNEL = 1n << 10n;
const CONNECT = 1n << 20n;

const hiddenByGuild = new Map<string, Channel[]>();
let rawCan: ((permission: unknown, channel: unknown) => unknown) | undefined;
let permTarget: PermStore | undefined;
let permOrder: "perm-first" | "channel-first" = "perm-first";
let permBit: unknown = VIEW_CHANNEL;
let calibrated = false;
let permissionBroken = false;

export type { Channel };

function store(name: string): Record<string, unknown> | undefined {
  const common = window.Syncord?.common?.stores as
    | Record<string, unknown>
    | undefined;
  const fromCommon = common?.[name];
  if (fromCommon != null && typeof fromCommon === "object") {
    return fromCommon as Record<string, unknown>;
  }
  const live = window.Syncord?.webpack.findByStoreName(name);
  if (live != null && typeof live === "object") return live as Record<string, unknown>;
  return undefined;
}

function call<T>(target: object | undefined, method: string, ...args: unknown[]): T | undefined {
  if (!target) return undefined;
  const fn = (target as Record<string, unknown>)[method];
  if (typeof fn !== "function") return undefined;
  try {
    return (fn as (...inner: unknown[]) => T).apply(target, args);
  } catch {
    return undefined;
  }
}

export function viewBit(): bigint {
  const found = window.Syncord?.webpack.findByProps("VIEW_CHANNEL", "CONNECT") as
    | { VIEW_CHANNEL?: unknown; CONNECT?: unknown }
    | undefined;
  const value = found?.VIEW_CHANNEL;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  return VIEW_CHANNEL;
}

export function connectBit(): bigint {
  const found = window.Syncord?.webpack.findByProps("VIEW_CHANNEL", "CONNECT") as
    | { CONNECT?: unknown }
    | undefined;
  const value = found?.CONNECT;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  return CONNECT;
}

export function channelStore(): Record<string, unknown> | undefined {
  return store("ChannelStore");
}

export function getChannel(id: string): Channel | undefined {
  const channel = call<unknown>(channelStore(), "getChannel", id);
  if (channel != null && typeof channel === "object") return channel as Channel;
  return undefined;
}

export function selectedChannelId(): string | undefined {
  const selected = store("SelectedChannelStore");
  const id =
    call<unknown>(selected, "getChannelId") ??
    call<unknown>(selected, "getCurrentlySelectedChannelId");
  return typeof id === "string" && id ? id : undefined;
}

export function selectedChannel(): Channel | undefined {
  const id = selectedChannelId();
  return id ? getChannel(id) : undefined;
}

function guildIdOf(channel: Channel): string | undefined {
  const id = channel.guild_id ?? channel.guildId;
  return typeof id === "string" && id ? id : undefined;
}

export function parentIdOf(channel: Channel): string | null {
  const id = channel.parent_id ?? channel.parentId;
  return typeof id === "string" && id ? id : null;
}

function isDm(channel: Channel): boolean {
  if (channel.isDM?.() || channel.isGroupDM?.() || channel.isMultiUserDM?.()) return true;
  return channel.type === 1 || channel.type === 3;
}

function isThread(channel: Channel): boolean {
  if (channel.isThread?.()) return true;
  return channel.type === 10 || channel.type === 11 || channel.type === 12;
}

export function isCategory(channel: Channel): boolean {
  if (channel.isCategory?.()) return true;
  return channel.type === 4;
}

export function isVoice(channel: Channel): boolean {
  if (channel.isVocal?.()) return true;
  return channel.type === 2 || channel.type === 13;
}

function skipped(channel: Channel): boolean {
  if (!channel.id || channel.id === "null") return true;
  if (channel.id === "browse" || channel.id === "customize" || channel.id === "guide") {
    return true;
  }
  return isDm(channel) || isThread(channel);
}

function bindPermission(): void {
  if (rawCan) return;
  const found = store("PermissionStore") as PermStore | undefined;
  if (typeof found?.can !== "function") return;
  permTarget = found;
  rawCan = found.can;
}

/** Keep the real permission check before `can` is patched. */
export function capturePermissions(): void {
  bindPermission();
}

function canView(channel: Channel, bit: unknown, order: "perm-first" | "channel-first"): boolean | undefined {
  if (!rawCan || !permTarget) return undefined;
  try {
    const value =
      order === "perm-first"
        ? rawCan.call(permTarget, bit, channel)
        : rawCan.call(permTarget, channel, bit);
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

function calibrate(): void {
  if (calibrated || permissionBroken) return;
  bindPermission();
  if (!rawCan) return;
  const current = selectedChannel();
  if (!current || skipped(current) || !guildIdOf(current)) return;

  const bits = [viewBit(), VIEW_CHANNEL, 1024n, 1024];
  for (const bit of bits) {
    for (const order of ["perm-first", "channel-first"] as const) {
      if (canView(current, bit, order) !== true) continue;
      permBit = bit;
      permOrder = order;
      calibrated = true;
      return;
    }
  }
  permissionBroken = true;
}

/** True when this client cannot view the channel. DMs and threads are ignored. */
export function isHiddenChannel(channel: Channel | undefined): boolean {
  if (!channel || skipped(channel) || !guildIdOf(channel)) return false;
  calibrate();
  if (!calibrated || permissionBroken || !rawCan) return false;
  return canView(channel, permBit, permOrder) === false;
}

export function permissionReady(): boolean {
  calibrate();
  return calibrated && !permissionBroken;
}

export function permissionState(): "ready" | "waiting" | "broken" {
  calibrate();
  if (permissionBroken) return "broken";
  if (calibrated) return "ready";
  return "waiting";
}

export function isHiddenId(id: string | undefined): boolean {
  if (!id) return false;
  return isHiddenChannel(getChannel(id));
}

function asChannels(value: unknown): Channel[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.filter((item): item is Channel => !!item && typeof item === "object");
  }
  if (typeof value !== "object") return [];
  const record = value as { toArray?: () => unknown; values?: () => Iterable<unknown> };
  if (typeof record.toArray === "function") return asChannels(record.toArray());
  if (typeof record.values === "function") return asChannels([...record.values()]);
  return Object.values(value).filter((item): item is Channel => !!item && typeof item === "object");
}

export function guildChannels(guildId: string): Channel[] {
  const channels = channelStore();
  if (!channels) return [];
  const names = [
    "getMutableGuildChannelsForGuild",
    "getMutableBasicGuildChannelsForGuild",
    "getGuildChannels",
    "getChannels",
  ];
  let best: Channel[] = [];
  for (const name of names) {
    const list = asChannels(call(channels, name, guildId)).filter(
      (channel) => guildIdOf(channel) === guildId,
    );
    if (list.length > best.length) best = list;
  }
  return best;
}

export function hiddenInGuild(guildId: string): Channel[] {
  if (!permissionReady()) return [];
  const hit = hiddenByGuild.get(guildId);
  if (hit) return hit;
  const all = guildChannels(guildId);
  if (all.length === 0) return [];
  const hidden = all.filter((channel) => isHiddenChannel(channel) && !isCategory(channel));
  hiddenByGuild.set(guildId, hidden);
  return hidden;
}

export function clearHiddenCache(): void {
  hiddenByGuild.clear();
}

type Overwrite = {
  id?: string;
  type?: number | string;
  allow?: unknown;
  deny?: unknown;
};

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

function hasBit(value: unknown, flag: bigint): boolean {
  const bits = asBit(value);
  if (bits == null) return false;
  return (bits & flag) === flag;
}

function overwrites(channel: Channel): Overwrite[] {
  const raw = channel.permissionOverwrites ?? channel.permission_overwrites;
  return asChannels(raw) as Overwrite[];
}

function roleName(guildId: string, roleId: string): string | undefined {
  const roles = store("GuildRoleStore");
  const one = call<{ name?: string }>(roles, "getRole", guildId, roleId);
  if (typeof one?.name === "string" && one.name) return one.name;
  const map = call<Record<string, { name?: string }>>(roles, "getRoles", guildId);
  const name = map?.[roleId]?.name;
  return typeof name === "string" && name ? name : undefined;
}

function userName(userId: string): string | undefined {
  const user = call<{ username?: string; globalName?: string; global_name?: string }>(
    store("UserStore"),
    "getUser",
    userId,
  );
  const name = user?.globalName ?? user?.global_name ?? user?.username;
  return typeof name === "string" && name ? name : undefined;
}

/** Role and member names that are explicitly allowed to view the channel. */
export function viewersOf(channel: Channel): string[] {
  const guildId = guildIdOf(channel);
  if (!guildId) return [];
  const names: string[] = [];
  const flag = viewBit();
  for (const row of overwrites(channel)) {
    if (!row.id || !hasBit(row.allow, flag) || hasBit(row.deny, flag)) continue;
    if (row.id === guildId) {
      names.push("@everyone");
      continue;
    }
    const member = row.type === 1 || row.type === "member";
    const name = member ? userName(row.id) : roleName(guildId, row.id);
    if (name) names.push(name);
  }
  return names;
}
