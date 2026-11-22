export type PaneCount = 2 | 3 | 4;

export type PersistedPane = {
  id: string;
  channelId?: string;
  draft?: string;
};

export type PersistedWorkspace = {
  version: 1;
  paneCount: PaneCount;
  panes: PersistedPane[];
};

export type ReplyTarget = {
  messageId: string;
  authorName: string;
  preview: string;
};

export type PendingFile = { id: string; file: File; preview?: string; progress?: number };
export type StickerLike = { id: string; name: string; format_type?: number; tags?: string; description?: string; available?: boolean; guild_id?: string };

export type PaneRuntime = {
  files: PendingFile[];
  stickers: StickerLike[];
  sending: boolean;
  sendError?: string;

  id: string;
  channelId?: string;
  draft: string;
  reply?: ReplyTarget;

  loading: boolean;
  loadingOlder: boolean;

  atBottom: boolean;
  newMessages: number;

  /**
   * Used to avoid rebuilding message DOM when the underlying MessageStore did
   * not actually change.
   */
  fingerprint: string;

  /**
   * Whether this pane has completed its first message load. We only auto-scroll
   * to the bottom on the initial render, never on unrelated pane updates.
   */
  initialScrollDone: boolean;
};

export type UserLike = {
  id: string;
  username?: string;
  globalName?: string | null;
  avatar?: string | null;
  bot?: boolean;

  getAvatarURL?: (
    guildId?: string,
    size?: number,
    animate?: boolean,
  ) => string;
};

export type AttachmentLike = {
  id?: string;
  filename?: string;
  name?: string;
  url?: string;
  proxy_url?: string;
  proxyURL?: string;
  content_type?: string | null;
  contentType?: string | null;
  width?: number | null;
  height?: number | null;
  size?: number;
};

export type EmbedLike = {
  type?: string;
  video?: { url?: string; proxy_url?: string; proxyURL?: string };
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  image?: {
    url?: string;
    proxy_url?: string;
    proxyURL?: string;
  };
  thumbnail?: {
    url?: string;
    proxy_url?: string;
    proxyURL?: string;
  };
};

export type MessageReferenceLike = {
  message_id?: string;
  channel_id?: string;
  guild_id?: string;
};

export type MessageLike = {
  id: string;
  channel_id?: string;
  channelId?: string;
  guild_id?: string | null;

  author?: UserLike;

  content?: string;
  timestamp?: string | Date | number;
  edited_timestamp?: string | Date | number | null;
  editedTimestamp?: string | Date | number | null;

  sticker_items?: StickerLike[];
  stickerItems?: StickerLike[];
  stickers?: StickerLike[];
  attachments?: AttachmentLike[];
  embeds?: EmbedLike[];

  message_reference?: MessageReferenceLike | null;
  messageReference?: MessageReferenceLike | null;

  referenced_message?: MessageLike | null;
  referencedMessage?: MessageLike | null;

  type?: number;
};

export type ChannelLike = {
  id: string;
  name?: string;
  type?: number;

  guild_id?: string;
  guildId?: string;

  parent_id?: string;
  parentId?: string;

  recipients?: string[];

  getGuildId?: () => string | null | undefined;
  isDM?: () => boolean;
  isGroupDM?: () => boolean;
  isPrivate?: () => boolean;
};

export type ChannelChoice = {
  id: string;
  label: string;
  sublabel: string;
  search: string;
  kind: "dm" | "server";
  channel: ChannelLike;
};
