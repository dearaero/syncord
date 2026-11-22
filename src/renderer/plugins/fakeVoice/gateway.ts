import type { PluginContext } from "../../api/plugin";

type Gateway = {
  getSocket: () => unknown;
};

type VoiceFlags = {
  mute: boolean;
  deaf: boolean;
};

export type GatewayHandle = {
  /** Tell the voice server the configured fake mute/deafen. No-op outside a channel. */
  pushFake: () => void;
  /** Tell the voice server the real local mute/deafen. Call only after fake mode is off. */
  pushReal: () => void;
};


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

function callBool(target: object | undefined, method: string): boolean | undefined {
  if (!target) return undefined;
  const fn = (target as Record<string, unknown>)[method];
  if (typeof fn !== "function") return undefined;
  try {
    const value = (fn as () => unknown).call(target);
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

function flag(
  source: Record<string, unknown> | undefined,
  ...keys: string[]
): boolean | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function currentUserId(): string | undefined {
  const users = store("UserStore");
  const get = users?.getCurrentUser;
  if (typeof get !== "function") return undefined;
  try {
    const me = (get as () => { id?: string } | null).call(users);
    return me?.id;
  } catch {
    return undefined;
  }
}

function myVoice(): Record<string, unknown> | undefined {
  const id = currentUserId();
  if (!id) return undefined;
  const voices = store("VoiceStateStore");
  const get = voices?.getVoiceStateForUser;
  if (typeof get !== "function") return undefined;
  try {
    const state = (get as (userId: string) => unknown).call(voices, id);
    if (state != null && typeof state === "object") {
      return state as Record<string, unknown>;
    }
  } catch {
    /* store shape differs */
  }
  return undefined;
}

function voiceChannelId(): string | null {
  const selected = store("SelectedChannelStore");
  const get = selected?.getVoiceChannelId;
  if (typeof get === "function") {
    try {
      const id = (get as () => unknown).call(selected);
      if (typeof id === "string" && id) return id;
    } catch {
      /* fall through */
    }
  }
  const channelId = myVoice()?.channelId ?? myVoice()?.channel_id;
  return typeof channelId === "string" && channelId ? channelId : null;
}

function guildId(channelId: string): string | null {
  const channels = store("ChannelStore");
  const get = channels?.getChannel;
  if (typeof get !== "function") return null;
  try {
    const channel = (get as (id: string) => unknown).call(channels, channelId);
    if (channel == null || typeof channel !== "object") return null;
    const rec = channel as Record<string, unknown>;
    const id = rec.guild_id ?? rec.guildId;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

function localFlags(): VoiceFlags | undefined {
  const media = store("MediaEngineStore");
  const mute = callBool(media, "isSelfMute") ?? callBool(media, "isSelfMuted");
  const deaf = callBool(media, "isSelfDeaf") ?? callBool(media, "isSelfDeafened");
  if (mute === undefined || deaf === undefined) return undefined;
  return { mute, deaf };
}

function videoEnabled(voice: Record<string, unknown> | undefined): boolean {
  return (
    flag(voice, "selfVideo", "self_video") ??
    callBool(store("MediaEngineStore"), "isVideoEnabled") ??
    false
  );
}

type Socket = {
  send: (op: number, data: unknown) => unknown;
};

type Dispatcher = {
  subscribe?: (
    type: string,
    cb: (action: Record<string, unknown>) => void,
  ) => void;
  unsubscribe?: (
    type: string,
    cb: (action: Record<string, unknown>) => void,
  ) => void;
};

/** Same lookup Nightcord uses: the module that owns `getSocket()`. */
function findGateway(): Gateway | undefined {
  const found = window.Syncord?.webpack.findByProps("getSocket");
  if (found == null || typeof found !== "object") return undefined;
  if (typeof (found as Gateway).getSocket !== "function") return undefined;
  return found as Gateway;
}

function liveSocket(mod: Gateway): Socket | undefined {
  let socket: unknown;
  try {
    socket = mod.getSocket();
  } catch {
    return undefined;
  }
  if (socket == null || typeof socket !== "object") return undefined;
  if (typeof WebSocket !== "undefined" && socket instanceof WebSocket) return undefined;
  const send = (socket as { send?: unknown }).send;
  if (typeof send !== "function") return undefined;
  return socket as Socket;
}

function dispatcher(): Dispatcher | undefined {
  const fromCommon = window.Syncord?.common?.flux?.FluxDispatcher;
  if (fromCommon != null && typeof fromCommon === "object") {
    return fromCommon as Dispatcher;
  }
  const found = window.Syncord?.webpack.findByProps("dispatch", "subscribe");
  if (found != null && typeof found === "object") return found as Dispatcher;
  return undefined;
}

function boolField(
  source: Record<string, unknown> | undefined,
  ...keys: string[]
): boolean | undefined {
  return flag(source, ...keys);
}

function ownVoiceUpdate(
  action: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const list = action.voiceStates;
  if (!Array.isArray(list)) return undefined;
  const id = currentUserId();
  if (!id) return undefined;
  for (const item of list) {
    if (item == null || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const userId = rec.userId ?? rec.user_id;
    if (userId === id) return rec;
  }
  return undefined;
}

const REASSERT = [
  "AUDIO_TOGGLE_SELF_MUTE",
  "AUDIO_TOGGLE_SELF_DEAF",
  "VOICE_STATE_UPDATES",
] as const;

/**
 * Send gateway op 4 the way Nightcord does, then re-send after Discord's own
 * mute/deafen packet. Patching `send` missed this module: `getSocket` and
 * `voiceStateUpdate` are not on the same export.
 */
export function attachGateway(
  ctx: PluginContext,
  read: () => { active: boolean; mute: boolean; deaf: boolean },
): GatewayHandle {
  let lastSent = 0;
  let pending = false;
  let missingSocket = false;

  function payload(flags: VoiceFlags): Record<string, unknown> | undefined {
    const channelId = voiceChannelId();
    if (!channelId) return undefined;
    const voice = myVoice();
    const stream = flag(voice, "selfStream", "self_stream");
    const body: Record<string, unknown> = {
      guild_id: guildId(channelId),
      channel_id: channelId,
      self_mute: flags.mute,
      self_deaf: flags.deaf,
      self_video: videoEnabled(voice),
    };
    if (stream !== undefined) body.self_stream = stream;
    return body;
  }

  function send(body: Record<string, unknown>): boolean {
    const mod = findGateway();
    const socket = mod ? liveSocket(mod) : undefined;
    if (!socket) {
      if (!missingSocket) {
        missingSocket = true;
        ctx.log.warn("gateway socket unavailable");
      }
      return false;
    }
    missingSocket = false;
    try {
      socket.send(4, body);
      lastSent = Date.now();
      ctx.log.info(
        "voice state sent",
        body.self_mute === true ? "muted" : "unmuted",
        body.self_deaf === true ? "deafened" : "undeafened",
      );
      return true;
    } catch (err) {
      ctx.log.error("voice state send failed:", err);
      return false;
    }
  }

  function push(mode: "fake" | "real"): void {
    const flags =
      mode === "fake" ? { mute: read().mute, deaf: read().deaf } : localFlags();
    if (!flags) {
      if (mode === "real") {
        ctx.log.warn("local mute state unavailable; left the server voice state as-is");
      }
      return;
    }
    const body = payload(flags);
    if (!body) {
      ctx.log.info("not in a voice channel");
      return;
    }
    send(body);
  }

  const scheduleFake = () => {
    if (pending || !read().active) return;
    pending = true;
    window.setTimeout(() => {
      pending = false;
      if (!read().active) return;
      push("fake");
    }, 0);
  };

  const onAction =
    (type: (typeof REASSERT)[number]) => (action: Record<string, unknown>) => {
      if (!read().active) return;
      if (type === "VOICE_STATE_UPDATES") {
        const mine = ownVoiceUpdate(action);
        if (!mine) return;
        const prefs = read();
        const mute = boolField(mine, "selfMute", "self_mute");
        const deaf = boolField(mine, "selfDeaf", "self_deaf");
        if (mute === prefs.mute && deaf === prefs.deaf) return;
        if (Date.now() - lastSent < 800) return;
      }
      scheduleFake();
    };

  const handlers = REASSERT.map((type) => ({ type, cb: onAction(type) }));

  const flux = dispatcher();
  if (flux?.subscribe) {
    for (const handler of handlers) flux.subscribe!(handler.type, handler.cb);
    ctx.log.info("listening for voice state updates");
  } else {
    ctx.log.warn("FluxDispatcher unavailable");
  }

  ctx.disposable(() => {
    flux?.unsubscribe &&
      handlers.forEach((handler) => flux.unsubscribe!(handler.type, handler.cb));
  });

  return {
    pushFake: () => push("fake"),
    pushReal: () => push("real"),
  };
}
