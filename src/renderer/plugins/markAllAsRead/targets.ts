/**
 * Which servers and DMs "mark all as read" has to acknowledge.
 *
 * Deliberately free of DOM and Discord access. The part of this feature worth
 * asserting is the target *selection* — which guilds and channels get touched
 * when the client can answer whether something is unread, and which get touched
 * when it cannot — and that has to be checkable without an account, a gateway
 * connection or a running client.
 *
 * The rule throughout: an unread answer of `false` is trusted, and anything
 * else (unknown, missing method, throwing method) is treated as "might be
 * unread". A store that cannot answer may cost some redundant acknowledgements,
 * which are idempotent; it may never silently skip a server that was unread.
 */

/** A server, with the channels that can carry its read state. */
export type GuildInput = {
  id: string;
  /** Non-thread channel ids, in the order the client reports them. */
  channels: readonly string[];
};

/**
 * The client's own unread checks, both optional.
 *
 * `ReadStateStore` is reshaped between Discord releases, so a missing method is
 * a normal state rather than an error.
 */
export type ReadStateProbe = {
  isGuildUnread?: (guildId: string) => boolean | undefined;
  isChannelUnread?: (channelId: string) => boolean | undefined;
};

export type TargetPlan = {
  /** Servers to acknowledge as a whole, when a server-level ack resolved. */
  guilds: string[];
  /** Channels to acknowledge one by one. Always carries the DMs. */
  channels: string[];
  /** True when server unread-ness could not be read, so every server was taken. */
  assumedUnread: boolean;
};

export type PlanOptions = {
  /**
   * Whether a server-level acknowledgement was resolved.
   *
   * Without one, a server's channels are acknowledged individually instead,
   * which is many more calls but the same visible result.
   */
  guildAck: boolean;
};

/** True when the probe answered "read" with confidence. */
function knownRead(
  check: ((id: string) => boolean | undefined) | undefined,
  id: string,
): boolean {
  if (!check) return false;
  return check(id) === false;
}

export function planTargets(
  guilds: readonly GuildInput[],
  dms: readonly string[],
  probe: ReadStateProbe,
  options: PlanOptions,
): TargetPlan {
  const guildCheck =
    typeof probe.isGuildUnread === "function" ? probe.isGuildUnread : undefined;
  const channelCheck =
    typeof probe.isChannelUnread === "function" ? probe.isChannelUnread : undefined;

  const plan: TargetPlan = {
    guilds: [],
    channels: [],
    assumedUnread: guildCheck === undefined,
  };
  // A DM is also reachable through the guild-less path above in some clients,
  // so ids are de-duplicated rather than trusted to arrive once.
  const seen = new Set<string>();
  const addChannel = (id: string): void => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    plan.channels.push(id);
  };

  for (const guild of guilds) {
    if (knownRead(guildCheck, guild.id)) continue;
    if (options.guildAck) {
      plan.guilds.push(guild.id);
      continue;
    }
    for (const id of guild.channels) addChannel(id);
  }

  // DMs are never acknowledged as a group, so each one is judged on its own.
  for (const id of dms) {
    if (knownRead(channelCheck, id)) continue;
    addChannel(id);
  }

  return plan;
}
