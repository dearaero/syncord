import { canonicalMessage as i18nText } from "../../i18n";
import { createLogger } from "../../api/logger";
import type { CommonModules } from "../../webpack/common";
import type { ChannelTarget, ScheduledMessage } from "./types";

/**
 * The bridge to Discord: reading the composer, resolving a channel, and sending.
 *
 * Sending goes through `MessageActions.sendMessage` rather than the REST
 * endpoint, which is the same function Discord's own composer uses. That gets
 * the optimistic message, the local echo, rate-limit handling, reply and
 * notification flags, and the store update, none of which a hand-rolled request
 * would reproduce.
 *
 * Note that Discord's *own* scheduled messages (a `scheduledTimestamp` option on
 * the same call) is deliberately not used: it is behind a server-side experiment
 * and gated on Nitro Tier 2, so it is unavailable for most accounts and would
 * fail at send time rather than at schedule time.
 */

const log = createLogger("scheduled-messages:discord");

/** DraftStore's `ChannelMessage` slot. */
const CHANNEL_MESSAGE_DRAFT_TYPE = 0;

/**
 * Discord's MessageLocation.CHAT_INPUT, spelled out.
 *
 * Resolved from the client rather than hardcoded where possible, but the enum
 * lives in a module that is not part of the common set, and a stale value here
 * would only affect analytics — so it is written down, with a comment saying
 * where it came from.
 */
const CHAT_INPUT_LOCATION = i18nText("ui.chat_input");

type UserLike = {
  id?: string;
  username?: string;
  /** The client model is camelCase; the REST payload is snake_case. Both turn up. */
  globalName?: string;
  global_name?: string;
};

type ChannelLike = {
  id?: string;
  name?: string;
  guild_id?: string;
  type?: number;
  recipient_ids?: string[];
  /**
   * A DM's participants, as **user ids** rather than user objects. Reading the
   * names straight off these is what made a group DM render as "? , ? +3".
   */
  recipients?: (string | UserLike)[];
};

type GuildLike = { id?: string; name?: string };

type MessageActionsLike = {
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

type DraftStoreLike = {
  getDraft?: (channelId: string, draftType: number) => string | undefined;
};

type ChannelStoreLike = {
  getChannel?: (id: string) => ChannelLike | undefined;
};

type GuildStoreLike = {
  getGuild?: (id: string) => GuildLike | undefined;
};

type SelectedChannelStoreLike = { getChannelId?: () => string | undefined };
type SelectedGuildStoreLike = { getGuildId?: () => string | undefined };
type UserStoreLike = {
  getCurrentUser?: () => UserLike | null;
  getUser?: (id: string) => UserLike | undefined;
};

type DispatcherLike = { dispatch?: (action: unknown) => unknown };

/** Channel types that are direct messages rather than guild channels. */
const DM_CHANNEL_TYPE = 1;
const GROUP_DM_CHANNEL_TYPE = 3;

function common(): CommonModules | undefined {
  return window.Syncord?.common;
}

function safeCall<T>(fn: () => T | undefined, fallback: T): T {
  try {
    return fn() ?? fallback;
  } catch (err) {
    log.warn("read failed:", err);
    return fallback;
  }
}

function channelStore(): ChannelStoreLike | undefined {
  return common()?.stores?.ChannelStore as ChannelStoreLike | undefined;
}

function guildStore(): GuildStoreLike | undefined {
  return common()?.stores?.GuildStore as GuildStoreLike | undefined;
}

function draftStore(): DraftStoreLike | undefined {
  return common()?.stores?.DraftStore as DraftStoreLike | undefined;
}

function messageActions(): MessageActionsLike | undefined {
  return common()?.actions?.MessageActions as MessageActionsLike | undefined;
}

function userStore(): UserStoreLike | undefined {
  return common()?.stores?.UserStore as UserStoreLike | undefined;
}

function fluxDispatcher(): DispatcherLike | undefined {
  return common()?.flux?.FluxDispatcher as DispatcherLike | undefined;
}

export function getChannel(channelId: string): ChannelLike | undefined {
  return safeCall(() => channelStore()?.getChannel?.(channelId), undefined);
}

function guildName(guildId: string | undefined): string | undefined {
  if (!guildId) return undefined;
  return safeCall(() => guildStore()?.getGuild?.(guildId)?.name, undefined);
}

function currentUser(): UserLike | null | undefined {
  return safeCall(() => userStore()?.getCurrentUser?.(), undefined);
}

/**
 * A user's name, in the shape the client uses.
 *
 * `globalName` is the display name and `global_name` the REST spelling; which
 * one is present depends on where the object came from, so both are read.
 */
function displayName(user: UserLike | undefined): string {
  if (!user) return "";
  const name = (user.globalName ?? user.global_name ?? user.username ?? "").trim();
  return name || "";
}

/** Resolve one entry of a DM's `recipients` list to a name, or nothing. */
function recipientName(entry: string | UserLike): string {
  if (typeof entry === "string") {
    const user = safeCall(() => userStore()?.getUser?.(entry), undefined);
    return displayName(user);
  }
  return displayName(entry);
}

function isDm(channel: ChannelLike): boolean {
  return channel.type === DM_CHANNEL_TYPE || channel.type === GROUP_DM_CHANNEL_TYPE;
}

/**
 * A human description of a DM.
 *
 * `recipients` holds user ids, so every name is looked up. The first couple are
 * named and the rest are counted, which is what Discord itself does for a group;
 * the count is the real one either way, so it stays even when a name is missing.
 *
 * When nothing resolves at all — nobody left, or a user the store has never seen
 * — the count is still worth showing, so it says how many people rather than
 * filling the row with placeholders.
 */
function dmScopeName(channel: ChannelLike): string {
  const recipients = Array.isArray(channel.recipients) ? channel.recipients : [];
  if (!recipients.length) return i18nText("ui.direct_message_cd3e160");

  const names = recipients.map(recipientName).filter(Boolean);

  if (!names.length) {
    return recipients.length > 1
      ? i18nText("ui.direct_message_value_people", {v0: recipients.length})
      : i18nText("ui.direct_message_cd3e160");
  }
  if (names.length === 1) return i18nText("ui.direct_message_value", {v0: names[0]});

  const head = names.slice(0, 2).join(", ");
  const rest = names.length - 2;
  return i18nText("ui.direct_message_valuevalue", {v0: head, v1: rest > 0 ? ` +${rest}` : ""});
}

/**
 * Resolve a channel into everything the UI and the sender need.
 *
 * Returns `undefined` when the channel is genuinely gone, which is different
 * from "not loaded yet": a channel the user left is still resolvable from the
 * store, so an unresolvable id means it is gone for good and the message should
 * fail with a reason rather than retry forever.
 */
export function resolveTarget(channelId: string): ChannelTarget | undefined {
  const channel = getChannel(channelId);
  if (!channel?.id) return undefined;

  const guildId = channel.guild_id || undefined;
  const target: ChannelTarget = {
    channelId,
    channelName: channel.name || "unknown-channel",
    scopeName: isDm(channel)
      ? dmScopeName(channel)
      : (guildName(guildId) ?? i18nText("ui.unknown_server")),
    isDm: isDm(channel),
  };
  if (guildId) target.guildId = guildId;
  return target;
}

/** The channel the user is looking at, for the composer button. */
export function currentTarget(): ChannelTarget | undefined {
  const selected = common()?.stores?.SelectedChannelStore as
    | SelectedChannelStoreLike
    | undefined;
  const selectedGuild = common()?.stores?.SelectedGuildStore as
    | SelectedGuildStoreLike
    | undefined;

  const channelId = safeCall(() => selected?.getChannelId?.(), undefined);
  if (!channelId) return undefined;

  const target = resolveTarget(channelId);
  if (!target) return undefined;
  // Fall back to the selected guild for a channel the store has not labelled.
  if (!target.guildId) {
    const guildId = safeCall(() => selectedGuild?.getGuildId?.(), undefined);
    if (guildId && !target.isDm) {
      target.guildId = guildId;
      target.scopeName = guildName(guildId) ?? target.scopeName;
    }
  }
  return target;
}

/**
 * The text currently in the composer.
 *
 * DraftStore first, because it is the composer's real state; the DOM is only a
 * fallback for when the store has not caught up with the last keystroke.
 */
export function readDraft(channelId: string): string {
  const stored = safeCall(
    () => draftStore()?.getDraft?.(channelId, CHANNEL_MESSAGE_DRAFT_TYPE),
    undefined,
  );
  if (typeof stored === "string" && stored) return stored;
  return readComposerFromDom();
}

function readComposerFromDom(): string {
  const selectors = [
    "[class*=\"channelTextArea\"] textarea",
    "[class*=\"channelTextArea\"] [role=\"textbox\"][contenteditable=\"true\"]",
    "[class*=\"channelTextArea\"] [contenteditable=\"true\"]",
    "[data-list-id=\"chat-content\"] [contenteditable=\"true\"]",
  ];
  for (const selector of selectors) {
    const element = document.querySelector<HTMLTextAreaElement | HTMLElement>(
      selector,
    );
    if (!element) continue;
    if (element instanceof HTMLTextAreaElement) return element.value;
    const text = element.textContent;
    if (typeof text === "string") return text;
  }
  return "";
}

/**
 * Empty the composer.
 *
 * This dispatches the same `DRAFT_SAVE` that Discord's own draft actions do, so
 * the store and anything watching it stay consistent. The composer is a
 * controlled editor, so the write is verified by reading it back rather than
 * assumed: if the box is still full the caller can tell the user instead of
 * leaving them to send the message twice.
 *
 * Returns true when the box was confirmed empty.
 */
export function clearDraft(channelId: string): boolean {
  const dispatch = fluxDispatcher()?.dispatch;
  if (typeof dispatch !== "function") {
    // No dispatcher means we cannot write the store; fall back to the editor.
    return clearComposerFromDom();
  }
  try {
    dispatch({
      type: "DRAFT_SAVE",
      channelId,
      draft: "",
      draftType: CHANNEL_MESSAGE_DRAFT_TYPE,
    });
  } catch (err) {
    log.warn("could not clear the draft:", err);
    return clearComposerFromDom();
  }

  const stored = safeCall(
    () => draftStore()?.getDraft?.(channelId, CHANNEL_MESSAGE_DRAFT_TYPE),
    "",
  );
  if (stored) return clearComposerFromDom();
  return !readComposerFromDom().trim();
}

/**
 * Last resort: edit the contenteditable directly.
 *
 * Slate is controlled, so this is not guaranteed to stick, which is why the
 * caller treats a false return as "tell the user" rather than as success.
 */
function clearComposerFromDom(): boolean {
  const element = document.querySelector<HTMLElement>(
    '[class*="channelTextArea"] [contenteditable="true"], [data-list-id="chat-content"] [contenteditable="true"]',
  );
  if (!element) return false;
  try {
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const ok =
      typeof document.execCommand === "function"
        ? document.execCommand("delete")
        : false;
    if (!ok) element.textContent = "";
    return !element.textContent?.trim();
  } catch (err) {
    log.warn("could not clear the editor:", err);
    return false;
  }
}

type SendResponse = {
  ok?: boolean;
  status?: number;
  body?: { id?: string; message?: string };
};

/**
 * Send one scheduled message.
 *
 * Always resolves or rejects with a readable reason: the caller turns a
 * rejection into the `failed` state, and a message that fails for a reason the
 * user can act on (no permission, channel gone) must say so.
 */
export async function sendMessage(
  message: ScheduledMessage,
): Promise<void> {
  const target = resolveTarget(message.channelId);
  if (!target) {
    throw new Error("That channel is no longer available.");
  }

  const owner = messageActions();
  const action = owner?.sendMessage;
  if (!owner || typeof action !== "function") {
    throw new Error("Discord's send action is unavailable right now.");
  }

  /*
   * The options argument is not optional in practice.
   *
   * Discord's sendMessage wrapper reads `options.nonce` with no default, so
   * calling it with three arguments throws "Cannot read properties of undefined
   * (reading 'nonce')" and the message never goes out. Every internal caller
   * passes it, which is why the bug only shows up from here.
   *
   * `location` is the same value the composer uses, so a scheduled send is
   * recorded the way a typed one is rather than as something out of band.
   */
  const options: Record<string, unknown> = { location: CHAT_INPUT_LOCATION };

  const result = (await Promise.resolve(
    action.call(
      owner,
      message.channelId,
      {
        content: message.content,
        invalidEmojis: [],
        tts: false,
        validNonShortcutEmojis: [],
      },
      true,
      options,
    ),
  )) as SendResponse | undefined;

  // Discord resolves rather than rejects for some failures, so a resolved call
  // still has to be checked.
  const status = result?.status ?? 200;
  if (!result || result.ok === false || status >= 400) {
    throw new Error(
      result?.body?.message ??
        `Discord refused the message (status ${status}).`,
    );
  }
  if (!result.ok && !result.body?.id) {
    throw new Error("Discord did not confirm the message was sent.");
  }
}
