import {accountLimit} from '../../chat/messageLimit';
import {offerLongMessage,longMessagesEnabled} from '../../chat/longMessage';
import { canonicalMessage as i18nText } from "../../i18n";
import type {
  ChannelChoice,
  ChannelLike,
  MessageLike,
  ReplyTarget,
  UserLike,
} from "./types";

type MessageCollectionLike = {
  _array?: MessageLike[];
  hasMoreBefore?: boolean;
  loadingMore?: boolean;
  ready?: boolean;
  hasFetched?: boolean;
  error?: boolean;
};

type MessageStoreLike = {
  getMessages?: (channelId: string) => MessageCollectionLike | undefined;
  getMessage?: (
    channelId: string,
    messageId: string,
  ) => MessageLike | undefined;

  addChangeListener?: (listener: () => void) => void;
  removeChangeListener?: (listener: () => void) => void;
};

type MessageActionsLike = {
  fetchMessages?: (options: {
    channelId: string;
    limit?: number;
    before?: string;
    after?: string;
    around?: string;
  }) => Promise<unknown> | unknown;

  getSendMessageOptionsForReply?: (
    reply: unknown,
  ) => Record<string, unknown>;

  sendMessage?: (
    channelId: string,
    message: {
      content: string;
      invalidEmojis: unknown[];
      tts: boolean;
      validNonShortcutEmojis: unknown[];
    },
    waitForChannelReady?: boolean,
    options?: Record<string, unknown>,
  ) => Promise<unknown> | unknown;
};

type ChannelStoreLike = {
  getChannel?: (channelId: string) => ChannelLike | undefined;
  getChannelIds?: (guildId?: string | null) => string[];
  getSortedPrivateChannels?: () => ChannelLike[];
  getMutablePrivateChannels?: () => Record<string, ChannelLike>;
  getMutableBasicGuildChannelsForGuild?: (guildId: string) => Record<string, ChannelLike>;
  getMutableGuildChannelsForGuild?: (guildId: string) => Record<string, ChannelLike>;
  getAllThreadsForGuild?: (guildId: string) => ChannelLike[];
};

type GuildLike = {
  id: string;
  name?: string;
};

type GuildStoreLike = {
  getGuild?: (guildId: string) => GuildLike | undefined;
  getGuilds?: () => Record<string, GuildLike>;
  getGuildIds?: () => string[];
};

type PermissionStoreLike = {
  computePermissions?: (channel: ChannelLike) => unknown;
  can?: (permission: bigint, channel: ChannelLike) => boolean;
};

// Discord's protocol permission bits, also used by its native PermissionStore.
const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const SEND_MESSAGES_IN_THREADS = 1n << 38n;
const ADMINISTRATOR = 1n << 3n;

function channelPermission(channel: ChannelLike, permission: bigint): boolean | undefined {
  if (!guildIdOf(channel)) return true;
  const store = stores()?.PermissionStore as PermissionStoreLike | undefined;
  if (typeof store?.computePermissions === "function") {
    // Use computed permissions: ShowHiddenChannels intentionally patches `can`
    // for the channel list, but that must not expose inaccessible chats here.
    const bits = safeCall(() => store.computePermissions?.(channel), undefined);
    const value = typeof bits === "bigint" ? bits
      : typeof bits === "string" && /^\d+$/.test(bits) ? BigInt(bits)
      : typeof bits === "number" && Number.isSafeInteger(bits) ? BigInt(bits) : undefined;
    return value === undefined ? undefined
      : (value & ADMINISTRATOR) !== 0n || (value & permission) === permission;
  }
  const result = safeCall(() => store?.can?.(permission, channel), undefined);
  return typeof result === "boolean" ? result : undefined;
}

function selectableChannel(channel: ChannelLike | undefined): channel is ChannelLike {
  return Boolean(channel?.id && typeof channel.type === "number"
    && SUPPORTED_CHANNEL_TYPES.has(channel.type)
    && channelPermission(channel, VIEW_CHANNEL) === true);
}

/** View permission is independent of send permission (read-only chats still open). */
export function channelViewable(channelId:string):boolean {return selectableChannel(getChannel(channelId));}

export function channelSendError(channelId: string): string | undefined {
  const channel = getChannel(channelId);
  if (!selectableChannel(channel)) return i18nText("ui.this_chat_is_unavailable_or_you_do_not_have_permission_to_view_it_your");
  const permission = channelPermission(channel, channel.type !== undefined && [10, 11, 12].includes(channel.type)
    ? SEND_MESSAGES_IN_THREADS : SEND_MESSAGES);
  if (permission === false) return i18nText("ui.you_do_not_have_permission_to_send_messages_in_this_channel_your_draft");
  if (permission === undefined) return i18nText("ui.discord_s_channel_permissions_are_not_ready_your_draft_is_kept");
  return undefined;
}

type UserStoreLike = {
  getUser?: (userId: string) => UserLike | undefined;
  getCurrentUser?: () => UserLike | undefined;
};

type GuildMemberStoreLike = {
  getNick?: (guildId: string, userId: string) => string | null;
};

type SelectedChannelStoreLike = {
  getChannelId?: () => string | undefined;
};

type ReadStateStoreLike = {
  getUnreadCount?: (channelId: string) => number;
  getMentionCount?: (channelId: string) => number;
  hasUnread?: (channelId: string) => boolean;
};

type UserProfileActionsLike = {
  openUserProfileModal?: (options: {
    userId: string;
    guildId?: string;
    channelId?: string;
    analyticsLocation?: {
      page: string;
      section: string;
    };
  }) => void;
};

type NavigationRouterLike = {
  transitionTo?: (path: string) => void;
};

const SUPPORTED_CHANNEL_TYPES = new Set([
  0,  // GUILD_TEXT
  1,  // DM
  3,  // GROUP_DM
  5,  // GUILD_ANNOUNCEMENT
  10, // ANNOUNCEMENT_THREAD
  11, // PUBLIC_THREAD
  12, // PRIVATE_THREAD
]);

function stores() {
  return window.Syncord?.common?.stores;
}

function actions() {
  return window.Syncord?.common?.actions;
}

function messageStore(): MessageStoreLike | undefined {
  return stores()?.MessageStore as MessageStoreLike | undefined;
}

function channelStore(): ChannelStoreLike | undefined {
  return stores()?.ChannelStore as ChannelStoreLike | undefined;
}

function guildStore(): GuildStoreLike | undefined {
  return stores()?.GuildStore as GuildStoreLike | undefined;
}

function userStore(): UserStoreLike | undefined {
  return stores()?.UserStore as UserStoreLike | undefined;
}

function memberStore(): GuildMemberStoreLike | undefined {
  return stores()?.GuildMemberStore as GuildMemberStoreLike | undefined;
}

function readStateStore(): ReadStateStoreLike | undefined {
  return stores()?.ReadStateStore as ReadStateStoreLike | undefined;
}

function messageActions(): MessageActionsLike | undefined {
  return actions()?.MessageActions as MessageActionsLike | undefined;
}

/**
 * Discord's fetchMessages implementation calls sibling methods through `this`
 * (for example `this.fetchLocalMessages()`) in current builds. Keep the owner
 * object and invoke the method with that object as its context.
 */
function messageHistoryActions(): MessageActionsLike | undefined {
  const dedicated =
    window.Syncord?.webpack.findByProps(
      "fetchMessages",
      "jumpToMessage",
    ) as MessageActionsLike | undefined;

  if (typeof dedicated?.fetchMessages === "function") {
    return dedicated;
  }

  const common = messageActions();

  return typeof common?.fetchMessages === "function"
    ? common
    : undefined;
}

function guildIdOf(channel: ChannelLike | undefined): string | undefined {
  return channel?.guild_id ?? channel?.guildId ?? safeCall(() => channel?.getGuildId?.(), undefined) ?? undefined;
}

function safeCall<T>(
  fn: (() => T) | undefined,
  fallback: T,
): T {
  try {
    return fn ? fn() : fallback;
  } catch {
    return fallback;
  }
}

export function getCurrentChannelId(): string | undefined {
  const selected =
    stores()?.SelectedChannelStore as SelectedChannelStoreLike | undefined;

  const id = safeCall(
    () => selected?.getChannelId?.(),
    undefined,
  );

  return typeof id === "string" && id ? id : undefined;
}

export function getChannel(
  channelId: string | undefined,
): ChannelLike | undefined {
  if (!channelId) return undefined;

  return safeCall(
    () => channelStore()?.getChannel?.(channelId),
    undefined,
  );
}

export function getMessage(
  channelId: string,
  messageId: string,
): MessageLike | undefined {
  return safeCall(
    () => messageStore()?.getMessage?.(channelId, messageId),
    undefined,
  );
}

export function getMessages(channelId: string): MessageLike[] {
  const collection = safeCall(
    () => messageStore()?.getMessages?.(channelId),
    undefined,
  );

  if (!Array.isArray(collection?._array)) {
    return [];
  }

  /*
   * Discord's cache is normally ordered oldest -> newest. Clone it because
   * plugins must never mutate Discord's own array.
   */
  return collection._array
    .filter((message): message is MessageLike =>
      Boolean(message?.id),
    )
    .slice();
}

export function hasMoreBefore(channelId: string): boolean {
  const collection = safeCall(
    () => messageStore()?.getMessages?.(channelId),
    undefined,
  );

  return collection?.hasMoreBefore !== false;
}

export function isLoadingMore(channelId: string): boolean {
  const collection = safeCall(
    () => messageStore()?.getMessages?.(channelId),
    undefined,
  );

  return collection?.loadingMore === true;
}

async function waitForChannelMessages(
  channelId: string,
  timeoutMs = 6_000,
): Promise<void> {
  const started =
    Date.now();

  while (
    Date.now() - started <
    timeoutMs
  ) {
    const collection =
      safeCall(
        () =>
          messageStore()
            ?.getMessages?.(
              channelId,
            ),
        undefined,
      );

    if (
      collection?.ready ||
      collection?.hasFetched ||
      (collection?._array?.length ?? 0) > 0 ||
      collection?.error
    ) {
      return;
    }

    await new Promise<void>(
      (resolve) =>
        window.setTimeout(
          resolve,
          90,
        ),
    );
  }
}

export async function fetchInitialMessages(
  channelId: string,
): Promise<void> {
  const owner = messageHistoryActions();
  const action = owner?.fetchMessages;

  if (!owner || typeof action !== "function") {
    throw new Error("Discord message history actions are unavailable");
  }

  await Promise.resolve(
    action.call(owner, {
      channelId,
      limit: 50,
    }),
  );

  await waitForChannelMessages(
    channelId,
  );
}

export async function fetchOlderMessages(
  channelId: string,
  before: string,
): Promise<void> {
  const owner = messageHistoryActions();
  const action = owner?.fetchMessages;

  if (!owner || typeof action !== "function") {
    throw new Error("Discord message history actions are unavailable");
  }

  await Promise.resolve(
    action.call(owner, {
      channelId,
      limit: 50,
      before,
    }),
  );
}

type CanvasSendMedia={uploads?:unknown[];stickerIds?:string[];emojis?:unknown[];onRemaining?:(remaining:string,sent:number)=>void;valid?:()=>boolean};
export async function sendCanvasMessage(channelId:string,content:string,reply?:ReplyTarget,media:CanvasSendMedia={}):Promise<void>{
  const account=currentUserId();
  if(account&&content.length>2000&&longMessagesEnabled()){
    const long=offerLongMessage({accountId:account,channelId,text:content,limit:accountLimit(),valid:()=>currentUserId()===account&&(media.valid?.()??true),
      send:(part,index,nonce)=>sendCanvasMessageSingle(channelId,part,index===0?reply:undefined,index===0?media:{emojis:media.emojis},nonce,index>0),
      delivered:media.onRemaining});
    if(long){await long;return;}
  }
  await sendCanvasMessageSingle(channelId,content,reply,media);
}

async function sendCanvasMessageSingle(
  channelId: string,
  content: string,
  reply?: ReplyTarget,
  media: { uploads?: unknown[]; stickerIds?: string[]; emojis?: unknown[] } = {},
  nonce?:string,continuation=false,
): Promise<unknown> {
  const permissionError = channelSendError(channelId);
  if (permissionError) throw new Error(permissionError);
  const owner = messageActions();
  const action = owner?.sendMessage;

  if (!owner || typeof action !== "function") {
    throw new Error("Discord MessageActions.sendMessage is unavailable");
  }

  const channel = getChannel(channelId);
  const guildId = guildIdOf(channel);

  let uploadError: Error | undefined;
  const options: Record<string, unknown> = {
    ...(nonce?{nonce}:{}),
    ...(continuation?{allowedMentions:{parse:[],users:[],roles:[],replied_user:false}}:{}),
    ...(media.uploads?.length ? {
      attachmentsToUpload: media.uploads,
      onAttachmentUploadError: (_file: unknown, code: unknown, reason: { msg?: string } | undefined) => {
        uploadError = new Error(reason?.msg || `File upload failed (${String(code ?? "unknown error")}). Your files have been kept.`);
      },
    } : {}),
    ...(media.stickerIds?.length ? { stickerIds: media.stickerIds } : {}),
  };

  if (reply) {
    options.messageReference = {
      message_id: reply.messageId,
      channel_id: channelId,
      ...(guildId ? { guild_id: guildId } : {}),
      fail_if_not_exists: false,
    };

    options.allowedMentions = {
      parse: ["users", "roles", "everyone"],
      replied_user: true,
    };
  }

  const result = await Promise.resolve(
    action.call(
      owner,
      channelId,
      {
        content,
        invalidEmojis: [],
        tts: false,
        validNonShortcutEmojis: media.emojis ?? [],
      },
      true,
      options,
    ),
  );
  if (uploadError) throw uploadError;
  // Discord can resolve (rather than reject) on upload cancellation or API failure.
  const response = result as { ok?: boolean; status?: number; body?: { id?: string; message?: string } } | undefined;
  if (!response || response.ok === false || (response.status ?? 200) >= 400 || (!response.ok && !response.body?.id)) {
    throw new Error(response?.body?.message ?? "Discord did not confirm this message. Your draft and attachments have been kept.");
  }
  return result;
}

export function currentUserId(): string | undefined {
  return safeCall(
    () => userStore()?.getCurrentUser?.()?.id,
    undefined,
  );
}

export function userDisplayName(
  user: UserLike | undefined,
  guildId?: string,
): string {
  if (!user) return i18nText("ui.unknown_user");

  if (guildId) {
    const nick = safeCall(
      () => memberStore()?.getNick?.(guildId, user.id),
      null,
    );

    if (nick?.trim()) return nick.trim();
  }

  return (
    user.globalName?.trim() ||
    user.username?.trim() ||
    i18nText("ui.unknown_user")
  );
}

export function avatarUrl(
  user: UserLike | undefined,
): string | undefined {
  if (!user?.id) return undefined;

  if (typeof user.getAvatarURL === "function") {
    const url = safeCall(
      () => user.getAvatarURL?.(undefined, 80, true),
      undefined,
    );

    if (typeof url === "string" && url) {
      return url;
    }
  }

  if (user.avatar) {
    const ext = user.avatar.startsWith("a_") ? "gif" : "png";

    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=80`;
  }

  return undefined;
}

export function getUser(
  userId: string | undefined,
): UserLike | undefined {
  if (!userId) return undefined;

  return safeCall(
    () => userStore()?.getUser?.(userId),
    undefined,
  );
}

export function channelAvatarUrl(
  channelId: string,
): string | undefined {
  const channel = getChannel(channelId);

  if (!channel) return undefined;

  const recipients =
    Array.isArray(channel.recipients)
      ? channel.recipients
      : [];

  if (!recipients.length) {
    return undefined;
  }

  /*
   * DMs have one recipient. Group DMs may have several; using the first
   * recipient gives us a stable native-looking header fallback without
   * depending on Discord's group icon internals.
   */
  return avatarUrl(
    getUser(recipients[0]),
  );
}

export function subscribeMessageStore(
  listener: () => void,
): () => void {
  const store = messageStore();

  if (
    typeof store?.addChangeListener !== "function"
  ) {
    return () => {};
  }

  store.addChangeListener(listener);

  return () => {
    try {
      store.removeChangeListener?.(
        listener,
      );
    } catch {
      /* best effort */
    }
  };
}


function dmLabel(channel: ChannelLike): string {
  if (channel.name?.trim()) {
    return channel.name.trim();
  }

  const ids = Array.isArray(channel.recipients)
    ? channel.recipients
    : [];

  const names = ids
    .map((id) => {
      const user = safeCall(
        () => userStore()?.getUser?.(id),
        undefined,
      );

      return userDisplayName(user);
    })
    .filter(Boolean);

  return names.join(", ") || i18nText("ui.direct_message");
}

export function channelTitle(channelId: string): {
  title: string;
  subtitle: string;
  kind: "dm" | "server";
} {
  const channel = getChannel(channelId);

  if (!channel) {
    return {
      get title() { return i18nText("ui.unknown_channel"); },
      subtitle: channelId,
      kind: "server",
    };
  }

  const guildId = guildIdOf(channel);

  if (!guildId || channel.type === 1 || channel.type === 3) {
    return {
      title: dmLabel(channel),
      subtitle: channel.type === 3 ? i18nText("ui.group_dm") : i18nText("ui.direct_message"),
      kind: "dm",
    };
  }

  const guild = safeCall(
    () => guildStore()?.getGuild?.(guildId),
    undefined,
  );

  return {
    title: channel.name?.trim()
      ? `#${channel.name.trim()}`
      : i18nText("ui.unnamed_channel"),
    subtitle: guild?.name?.trim() || i18nText("ui.server"),
    kind: "server",
  };
}

export function listChannelChoices(query = ""): ChannelChoice[] {
  const store = channelStore();
  if (!store) return [];

  const trimmed = query.trim();
  const channelId = /^\d{17,20}$/.test(trimmed) ? trimmed : /^<#(\d{17,20})>$/.exec(trimmed)?.[1];
  const normalized = (channelId ?? trimmed).toLowerCase();
  const seen = new Set<string>();
  const channels: ChannelLike[] = [];
  const add = (channel: ChannelLike | undefined) => {
    if (!channel?.id || seen.has(channel.id) || !selectableChannel(channel)) return;
    seen.add(channel.id);
    channels.push(channel);
  };
  const addIds = (ids: string[] | undefined) => {
    if (Array.isArray(ids)) for (const id of ids) {
      if (!seen.has(id)) add(getChannel(id));
    }
  };
  const addMap = (map: Record<string, ChannelLike> | undefined) => {
    for (const channel of Object.values(map ?? {})) {
      // Basic guild records may be partial; resolve the full native channel.
      if (channel && !seen.has(channel.id) && typeof channel.type === "number" && SUPPORTED_CHANNEL_TYPES.has(channel.type)) {
        add(getChannel(channel.id) ?? channel);
      }
    }
  };

  if (channelId) {
    // Exact lookup is independent of enumeration and its result limit. Threads
    // already cached by Discord can be selected even when absent from its list.
    add(getChannel(channelId));
  } else {
    const privateChannels = safeCall(() => store.getSortedPrivateChannels?.(), []);
    if (Array.isArray(privateChannels)) privateChannels.forEach(add);
    addIds(safeCall(() => store.getChannelIds?.(), []));
    addMap(safeCall(() => store.getMutablePrivateChannels?.(), {}));

    const guilds = guildStore();
    const guildIds = new Set([
      ...(safeCall(() => guilds?.getGuildIds?.(), []) ?? []),
      ...Object.keys(safeCall(() => guilds?.getGuilds?.(), {}) ?? {}),
    ]);
    for (const guildId of guildIds) {
      // Without a guild ID getChannelIds returns only private chats in current
      // Discord builds. Basic records cover guilds not yet opened in the UI.
      addIds(safeCall(() => store.getChannelIds?.(guildId), []));
      addMap(safeCall(() => store.getMutableBasicGuildChannelsForGuild?.(guildId), {}));
      addMap(safeCall(() => store.getMutableGuildChannelsForGuild?.(guildId), {}));
      const threads = safeCall(() => store.getAllThreadsForGuild?.(guildId), []);
      if (Array.isArray(threads)) threads.forEach(add);
    }
  }

  const out: ChannelChoice[] = [];
  for (const channel of channels) {
    const info = channelTitle(channel.id);
    const parentId = channel.parent_id ?? channel.parentId;
    const parentName = parentId ? getChannel(parentId)?.name?.trim() : undefined;
    const sublabel = info.kind === "server" && parentName
      ? `${info.subtitle} · ${parentName}` : info.subtitle;
    const choice: ChannelChoice = {
      id: channel.id,
      label: info.title,
      sublabel,
      search: `${channel.id} ${info.title} ${sublabel}`.toLowerCase(),
      kind: info.kind,
      channel,
    };
    if (!normalized || choice.search.includes(normalized)) out.push(choice);
  }

  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dm" ? -1 : 1;
    return a.sublabel.localeCompare(b.sublabel, undefined, { sensitivity: "base" })
      || a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  });
  return out;
}

export function unreadInfo(channelId: string): {
  unread: boolean;
  count: number;
  mentions: number;
} {
  const store = readStateStore();

  const count = safeCall(
    () => store?.getUnreadCount?.(channelId),
    0,
  );

  const mentions = safeCall(
    () => store?.getMentionCount?.(channelId),
    0,
  );

  const unread = safeCall(
    () => store?.hasUnread?.(channelId),
    false,
  );

  return {
    unread: Boolean(unread),
    count: typeof count === "number" ? count : 0,
    mentions: typeof mentions === "number" ? mentions : 0,
  };
}

export function openUserProfile(
  userId: string,
  channelId: string,
): void {
  const channel = getChannel(channelId);
  const guildId = guildIdOf(channel);

  const profileActions =
    actions()?.UserProfileActions as UserProfileActionsLike | undefined;

  try {
    profileActions?.openUserProfileModal?.({
      userId,
      ...(guildId ? { guildId } : {}),
      channelId,
      analyticsLocation: {
        page: guildId ? i18nText("ui.guild_channel") : i18nText("ui.dm_channel"),
        section: i18nText("ui.syncord_multichat_canvas"),
      },
    });
  } catch {
    /* Discord changed the profile action shape. */
  }
}

function navigationRouter(): NavigationRouterLike | undefined {
  const webpack = window.Syncord?.webpack;

  if (!webpack) return undefined;

  const exact = webpack.findByProps(
    "transitionTo",
    "back",
    "forward",
  ) as NavigationRouterLike | undefined;

  if (typeof exact?.transitionTo === "function") {
    return exact;
  }

  const loose = webpack.findByProps(
    "transitionTo",
  ) as NavigationRouterLike | undefined;

  return typeof loose?.transitionTo === "function"
    ? loose
    : undefined;
}

export function openChannelInDiscord(
  channelId: string,
): void {
  const channel = getChannel(channelId);

  if (!channel) return;

  const guildId = guildIdOf(channel) ?? "@me";
  const route = `/channels/${guildId}/${channelId}`;

  const router = navigationRouter();

  if (typeof router?.transitionTo === "function") {
    router.transitionTo(route);
    return;
  }

  history.pushState(null, "", route);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function messageChannelId(
  message: MessageLike,
): string | undefined {
  return message.channel_id ?? message.channelId;
}

export function messageEditedAt(
  message: MessageLike,
): string | Date | number | null | undefined {
  return message.edited_timestamp ?? message.editedTimestamp;
}

export function referencedMessage(
  message: MessageLike,
): MessageLike | undefined {
  const direct =
    message.referenced_message ??
    message.referencedMessage;

  if (direct) return direct;

  const ref =
    message.message_reference ??
    message.messageReference;

  const messageId = ref?.message_id;

  if (!messageId) return undefined;

  const channelId =
    ref?.channel_id ??
    messageChannelId(message);

  if (!channelId) return undefined;

  return getMessage(channelId, messageId);
}
