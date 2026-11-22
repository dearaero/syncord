import {longMessagesEnabled} from '../../chat/longMessage';
import {accountLimit} from '../../chat/messageLimit';
import {openChatPopout,popoutsAvailable,onPopoutAvailabilityChange} from "../popoutChats/service";
import { escapeHtml, escapeAttr, messageTimestamp, prefers12HourClock, formatTime, sameCalendarDay, dateSeparatorHtml, shortPreview, replaceMentions, renderContent, initials, guildIdForMessage, isCompactWith, replyPreviewHtml, attachmentsHtml, embedsHtml, messageHtml } from "../../chat/messageView";
import { getLocale, onLocaleChange, h, messageHtml as i18nHtml, setLocalizedAttribute, setLocalizedHtml, setLocalizedText, t as i18nText } from "../../i18n";
import {prepareUploadFiles} from "../../ui/uploadPreparation";
import { composerFragment, composerText, insertComposerText } from "./composerEmoji";
import { mountCanvasSurface } from "./surface";
import { closeCanvasDialog, mountCanvasDialog } from "./dialog";
import { clearStickerPreviews, renderStickerPreview } from "./stickerPreview";
import { addFiles, releaseFiles, renderMediaDraft } from "./mediaDraft";
import { createUploads, mediaError, safeMediaUrl, validateCustomEmojis } from "./mediaDiscord";
import { closeMediaPicker, openMediaPicker, type PickerKind } from "./mediaPicker";
import type { PluginContext } from "../../api/plugin";
import {
  avatarUrl,
  channelAvatarUrl,
  channelSendError,
  channelTitle,
  currentUserId,
  fetchInitialMessages,
  fetchOlderMessages,
  getChannel,
  getCurrentChannelId,
  getMessage,
  getMessages,
  hasMoreBefore,
  isLoadingMore,
  listChannelChoices,
  messageEditedAt,
  openChannelInDiscord,
  openUserProfile,
  referencedMessage,
  sendCanvasMessage,
  subscribeMessageStore,
  unreadInfo,
  userDisplayName,
} from "./discord";
import type {
  ChannelChoice,
  MessageLike,
  PaneCount,
  PaneRuntime,
  PersistedWorkspace,
  ReplyTarget,
} from "./types";

const ROOT_ID = "Syncord-multichat-root";
const WORKSPACE_KEY = "workspace";

const MAX_RENDERED_MESSAGES = 250;
const SAVE_DEBOUNCE_MS = 250;
const REFRESH_FALLBACK_MS = 1_500;

let root: HTMLDivElement | undefined;
let ctxRef: PluginContext | undefined;

let paneCount: PaneCount = 2;
let panes: PaneRuntime[] = [];
const activeUploads = new Map<PaneRuntime, ReturnType<typeof createUploads>>();
let focusedPaneId: string | undefined;
let activePaneId = "pane-1";
let workspaceResizeObserver: ResizeObserver | undefined;
let unmountSurface: (() => void) | undefined;
let unmountChannelPicker: (() => void) | undefined;

let saveTimer: number | undefined;
let fallbackTimer: number | undefined;
let refreshRaf: number | undefined;

let paneResizeObserver: ResizeObserver | undefined;
const paneWidths = new WeakMap<Element, number>();

let removeDispatcherListeners: (() => void) | undefined;
let removePopoutListener:(()=>void)|undefined;
let removeLocaleListener:(()=>void)|undefined;

function makePane(
  index: number,
  channelId?: string,
  draft = "",
): PaneRuntime {
  return {
    files: [],
    stickers: [],
    sending: false,
    id: `pane-${index + 1}`,
    channelId,
    draft,
    loading: false,
    loadingOlder: false,
    atBottom: true,
    newMessages: 0,
    fingerprint: "",
    initialScrollDone: false,
  };
}

function clampPaneCount(value: unknown): PaneCount {
  if (value === 3) return 3;
  if (value === 4) return 4;
  return 2;
}

function restoreWorkspace(ctx: PluginContext): void {
  // File objects stay in memory when the workspace is hidden/reopened.
  if (panes.length) return;
  const saved = ctx.settings.get<PersistedWorkspace | null>(
    WORKSPACE_KEY,
    null,
  );

  paneCount = clampPaneCount(saved?.paneCount);

  const current = getCurrentChannelId();

  panes = Array.from(
    { length: paneCount },
    (_, index) => {
      const persisted = saved?.panes?.[index];

      return makePane(
        index,
        persisted?.channelId ??
          (index === 0 ? current : undefined),
        persisted?.draft ?? "",
      );
    },
  );
}

function workspaceSnapshot(): PersistedWorkspace {
  return {
    version: 1,
    paneCount,
    panes: panes.slice(0, paneCount).map((pane) => ({
      id: pane.id,
      ...(pane.channelId ? { channelId: pane.channelId } : {}),
      ...(pane.draft ? { draft: pane.draft } : {}),
    })),
  };
}

function scheduleSave(): void {
  if (!ctxRef) return;

  if (saveTimer !== undefined) {
    window.clearTimeout(saveTimer);
  }

  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;

    ctxRef?.settings.set(
      WORKSPACE_KEY,
      workspaceSnapshot(),
    );
  }, SAVE_DEBOUNCE_MS);
}

function messageFingerprint(channelId: string): string {
  // Media (especially GIF embeds) can arrive after the message itself.
  return JSON.stringify(getMessages(channelId).slice(-MAX_RENDERED_MESSAGES).map(message => [
    message.id, message.content, messageEditedAt(message), message.attachments, message.embeds,
    message.stickerItems ?? message.sticker_items ?? message.stickers,
  ]));
}

function paneById(
  paneId: string | undefined,
): PaneRuntime | undefined {
  if (!paneId) return undefined;

  return panes.find(
    (pane) =>
      pane.id === paneId,
  );
}

function paneElement(
  pane: PaneRuntime,
): HTMLElement | undefined {
  return root?.querySelector<HTMLElement>(
    `[data-mc-pane="${pane.id}"]`,
  ) ?? undefined;
}

function scrollerElement(
  pane: PaneRuntime,
): HTMLElement | undefined {
  return paneElement(pane)
    ?.querySelector<HTMLElement>(
      "[data-mc-messages]",
    ) ?? undefined;
}

function isNearBottom(
  scroller: HTMLElement,
): boolean {
  return (
    scroller.scrollHeight -
      scroller.scrollTop -
      scroller.clientHeight <
    72
  );
}

function editorText(editor: HTMLElement): string {
  return composerText(editor);
}

function setEditorText(
  editor:
    HTMLElement,
  value:
    string,
): void {
  editor.replaceChildren(composerFragment(value));
}

function resizeEditor(
  editor:
    HTMLElement,
): void {
  const textArea =
    editor.closest<HTMLElement>(
      ".dion-mc-native-text-area",
    );

  editor.style.height =
    "auto";

  const editorHeight =
    Math.min(
      144,
      Math.max(
        22,
        editor.scrollHeight,
      ),
    );

  editor.style.height =
    `${editorHeight}px`;

  if (textArea) {
    const targetHeight =
      Math.min(
        176,
        Math.max(
          56,
          editorHeight,
        ),
      );

    textArea.style.height =
      `${targetHeight}px`;
  }

  textArea?.classList.toggle(
    "has-content",
    Boolean(
      editorText(
        editor,
      ).trim(),
    ),
  );
}

function updateSendButtonState(
  pane:
    PaneRuntime,
  editor:
    HTMLElement,
): void {
  const button =
    paneElement(pane)
      ?.querySelector<HTMLButtonElement>(
        "[data-mc-send]",
      );

  if (!button) return;

  button.disabled =
    pane.sending || !pane.channelId ||
    (!editorText(editor).trim() && !pane.files.length && !pane.stickers.length);

  button.setAttribute(
    "aria-disabled",
    button.disabled
      ? "true"
      : "false",
  );
}

function headerIcon(
  kind: "dm" | "server" | "empty",
): string {
  if (kind === "dm") {
    return `
      <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="currentColor"
          d="M12 3a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm-8 18c0-4.1 3.6-6 8-6s8 1.9 8 6H4Z"
        />
      </svg>
    `;
  }

  if (kind === "server") {
    return `
      <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="currentColor"
          d="M9 3 8.35 7H4v2h4.02l-.96 6H3v2h3.74L6 21h2l.65-4h5.09L13 21h2l.65-4H20v-2h-4.02l.96-6H21V7h-3.74L18 3h-2l-.65 4h-5.09L11 3H9Zm.94 6h5.09l-.97 6H8.97l.97-6Z"
        />
      </svg>
    `;
  }

  return `
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7V4Z"
      />
    </svg>
  `;
}

function paneShellHtml(
  pane: PaneRuntime,
): string {
  const info =
    pane.channelId
      ? channelTitle(
          pane.channelId,
        )
      : {
          get title() { return i18nText("ui.choose_a_chat"); },

          subtitle:
            "",

          kind:
            "server" as const,
        };

  const unread =
    pane.channelId
      ? unreadInfo(
          pane.channelId,
        )
      : {
          unread:
            false,

          count:
            0,

          mentions:
            0,
        };

  const dmAvatar =
    pane.channelId &&
    info.kind === "dm"
      ? channelAvatarUrl(
          pane.channelId,
        )
      : undefined;

  const sendDisabled = pane.sending || !pane.channelId ||
    (!pane.draft.trim() && !pane.files.length && !pane.stickers.length);

  return `
    <section
      class="dion-mc-pane${focusedPaneId === pane.id ? " is-focused" : ""}"
      id="mc-panel-${pane.id}"
      data-mc-pane="${pane.id}"
    >
      <header class="dion-mc-pane-head">
        <button
          type="button"
          class="dion-mc-channel-button"
          data-mc-pick-channel="${pane.id}"
          title="${escapeAttr(`${info.title} · ${info.subtitle}`)}"
          aria-label="${h("ui.choose_chat")}" data-si18n-aria-label="ui.choose_chat"
        >
          <span
            class="dion-mc-channel-icon${info.kind === "dm" ? " is-dm" : ""}"
          >
            ${dmAvatar
                ? `
                  <img
                    src="${escapeAttr(dmAvatar)}"
                    alt=""
                    draggable="false"
                  />
                `
                : headerIcon(
                    pane.channelId
                      ? info.kind
                      : "empty",
                  )}
          </span>

          <span class="dion-mc-channel-name">
            ${escapeHtml(info.title)}
          </span>

          ${unread.unread
              ? `
                <span
                  class="dion-mc-unread-dot"
                  title="${
                    unread.mentions
                      ? i18nText("ui.value_mention_s", {v0: unread.mentions})
                      : i18nText("ui.unread")
                  }"
                ></span>
              `
              : ""}
        </button>

        <div class="dion-mc-head-actions">
          ${pane.channelId && popoutsAvailable() ? `<button type="button" class="dion-mc-icon-btn" data-mc-popout="${pane.id}" aria-label="${h("popout.open")}" data-si18n-aria-label="popout.open">↗</button>` : ""}
          ${pane.channelId
              ? `
                <button
                  type="button"
                  class="dion-mc-icon-btn"
                  data-mc-open-native="${pane.id}"
                  aria-label="${h("ui.open_in_discord")}" data-si18n-aria-label="ui.open_in_discord"
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      fill="currentColor"
                      d="M14 3h7v7h-2V6.41l-8.29 8.3-1.42-1.42L17.59 5H14V3ZM5 5h6v2H7v10h10v-4h2v6H5V5Z"
                    />
                  </svg>
                </button>
              `
              : ""}

          <button
            type="button"
            class="dion-mc-icon-btn"
            data-mc-focus-pane="${pane.id}"
            aria-label="${focusedPaneId === pane.id ? i18nText("ui.exit_focus") : i18nText("ui.focus_pane")}"
          >
            ${focusedPaneId === pane.id
                ? `
                  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="currentColor" d="M9 3v2H6.41L10 8.59 8.59 10 5 6.41V9H3V3h6Zm6 0h6v6h-2V6.41L15.41 10 14 8.59 17.59 5H15V3ZM8.59 14 10 15.41 6.41 19H9v2H3v-6h2v2.59L8.59 14ZM15.41 14 19 17.59V15h2v6h-6v-2h2.59L14 15.41 15.41 14Z"/>
                  </svg>
                `
                : `
                  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="currentColor" d="M3 3h7v2H5v5H3V3Zm11 0h7v7h-2V5h-5V3ZM3 14h2v5h5v2H3v-7Zm16 0h2v7h-7v-2h5v-5Z"/>
                  </svg>
                `}
          </button>

          ${pane.channelId
              ? `
                <button
                  type="button"
                  class="dion-mc-icon-btn"
                  data-mc-clear-pane="${pane.id}"
                  aria-label="${h("ui.clear_pane")}" data-si18n-aria-label="ui.clear_pane"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                  </svg>
                </button>
              `
              : ""}
        </div>
      </header>

      <div class="dion-mc-messages-wrap">
        <div
          class="dion-mc-messages"
          data-mc-messages="${pane.id}"
          dir="ltr"
          role="group"
          tabindex="-1"
        ></div>

        <button
          type="button"
          class="dion-mc-new-pill"
          data-mc-new-messages="${pane.id}"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="m7 10 5 5 5-5H7Z"/>
          </svg>

          <span data-mc-new-label>
            ${i18nHtml("ui.new_messages")}
          </span>
        </button>
      </div>

      <form
        class="dion-mc-composer-wrap"
        data-mc-form="${pane.id}"
      >
        <input type="file" multiple hidden data-mc-files="${pane.id}" aria-label="${h("ui.attach_files")}" data-si18n-aria-label="ui.attach_files" />
        <div class="dion-mc-media-draft" data-mc-media-draft></div>
        <div
          class="dion-mc-reply-strip${pane.reply ? " is-visible" : ""}"
          data-mc-reply-strip="${pane.id}"
        >
          <span>
            ${i18nHtml("ui.replying_to")}
            <strong data-mc-reply-author>
              ${escapeHtml(pane.reply?.authorName ?? "")}
            </strong>
          </span>

          <span
            class="dion-mc-reply-copy"
            data-mc-reply-preview
          >
            ${escapeHtml(pane.reply?.preview ?? "")}
          </span>

          <button
            type="button"
            data-mc-cancel-reply="${pane.id}"
            aria-label="${h("ui.cancel_reply")}" data-si18n-aria-label="ui.cancel_reply"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </button>
        </div>

        <div class="dion-mc-channel-bottom">
          <div class="dion-mc-channel-text-area">
            <div class="dion-mc-scrollable-container">
              <div class="dion-mc-composer">
                <button
                  type="button"
                  class="dion-mc-composer-btn dion-mc-attach-btn"
                  aria-label="${h("ui.upload_files")}" title="${h("ui.upload_files")}" data-mc-media-tool="Upload files"
                  ${pane.channelId ? "" : "disabled"} data-si18n-aria-label="ui.upload_files" data-si18n-title="ui.upload_files"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="currentColor" d="M13 3a1 1 0 1 0-2 0v8H3a1 1 0 1 0 0 2h8v8a1 1 0 0 0 2 0v-8h8a1 1 0 0 0 0-2h-8V3Z"/>
                  </svg>
                </button>

                <div
                  class="dion-mc-native-text-area${pane.draft.trim() ? " has-content" : ""}"
                  style="height:56px"
                >
                  <div class="dion-mc-editor-shell">
                    <div
                      class="dion-mc-native-placeholder"
                      aria-hidden="true"
                    >
                      ${pane.channelId
                          ? i18nHtml("ui.message_value", {v0: escapeHtml(info.title)})
                          : i18nHtml("ui.choose_a_chat_first")}
                    </div>

                    <div
                      role="textbox"
                      aria-multiline="true"
                      spellcheck="true"
                      class="dion-mc-editor"
                      contenteditable="${pane.channelId ? "plaintext-only" : "false"}"
                      data-mc-composer="${pane.id}"
                      aria-label="${pane.channelId
                          ? i18nText("ui.message_value", {v0: escapeAttr(info.title)})
                          : i18nText("ui.choose_a_chat_first")}"
                    >${escapeHtml(pane.draft)}</div>
                  </div>
                </div>

                <div class="dion-mc-composer-tools">
                  <button
                    type="button"
                    class="dion-mc-composer-btn"
                    aria-label="${h("ui.send_a_gift_in_discord")}" title="${h("ui.send_a_gift_in_discord_canvas_draft_is_kept_here")}" data-mc-native-tool="Send a gift"
                    ${pane.channelId ? "" : "disabled"} data-si18n-aria-label="ui.send_a_gift_in_discord" data-si18n-title="ui.send_a_gift_in_discord_canvas_draft_is_kept_here"
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                      <path fill="currentColor" d="M4 10h16v10H4V10Zm8-7c2.7 0 4 1.1 4 2.7 0 1-.6 1.8-1.5 2.3H20v2H4V8h5.5C8.6 7.5 8 6.7 8 5.7 8 4.1 9.3 3 12 3Zm-1 7H6v8h5v-8Zm7 0h-5v8h5v-8Z"/>
                    </svg>
                  </button>

                  <button
                    type="button"
                    class="dion-mc-composer-btn dion-mc-gif-btn"
                    aria-label="GIF" title="GIF" data-mc-media-tool="GIF"
                    ${pane.channelId ? "" : "disabled"}
                  >
                    <span>${i18nHtml("ui.gif")}</span>
                  </button>

                  <button
                    type="button"
                    class="dion-mc-composer-btn"
                    aria-label="${h("ui.stickers")}" title="${h("ui.stickers")}" data-mc-media-tool="Stickers"
                    ${pane.channelId ? "" : "disabled"} data-si18n-aria-label="ui.stickers" data-si18n-title="ui.stickers"
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                      <path fill="currentColor" d="M4 3h16v11l-7 7H4V3Zm2 2v14h6v-6h6V5H6Zm8 12 2-2h-2v2Z"/>
                    </svg>
                  </button>

                  <button
                    type="button"
                    class="dion-mc-composer-btn"
                    aria-label="${h("ui.emoji")}" title="${h("ui.emoji")}" data-mc-media-tool="Emoji"
                    ${pane.channelId ? "" : "disabled"} data-si18n-aria-label="ui.emoji" data-si18n-title="ui.emoji"
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                      <path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM8.5 9A1.5 1.5 0 1 1 8.5 12 1.5 1.5 0 0 1 8.5 9Zm7 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm-7.1 6h7.2a4.7 4.7 0 0 1-7.2 0Z"/>
                    </svg>
                  </button>

                  <button
                    type="button"
                    class="dion-mc-composer-btn"
                    aria-label="${h("ui.apps_in_discord")}" title="${h("ui.apps_in_discord_canvas_draft_is_kept_here")}" data-mc-native-tool="Apps"
                    ${pane.channelId ? "" : "disabled"} data-si18n-aria-label="ui.apps_in_discord" data-si18n-title="ui.apps_in_discord_canvas_draft_is_kept_here"
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                      <path fill="currentColor" d="M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h6v6h-6v-6Z"/>
                    </svg>
                  </button>

                  <span class="dion-mc-send-separator" aria-hidden="true"></span>

                  <button
                    type="submit"
                    class="dion-mc-send"
                    data-mc-send="${pane.id}"
                    aria-label="${h("ui.send_message")}"
                    aria-disabled="${sendDisabled ? "true" : "false"}"
                    ${sendDisabled ? "disabled" : ""} data-si18n-aria-label="ui.send_message"
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                      <path fill="currentColor" d="M6.6 10.02 14 11.4a.6.6 0 0 1 0 1.18L6.6 14l-2.94 5.87a1.48 1.48 0 0 0 1.99 1.98l17.03-8.52a1.48 1.48 0 0 0 0-2.64L5.65 2.16a1.48 1.48 0 0 0-1.99 1.98l2.94 5.88Z"/>
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </form>
    </section>
  `;
}

function rootShellHtml(): string {
  return `
    <header class="dion-mc-topbar">
      <div class="dion-mc-native-title">
        <span class="dion-mc-native-title-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24">
            <path
              fill="currentColor"
              d="M3 4h8v7H3V4Zm10 0h8v7h-8V4ZM3 13h8v7H3v-7Zm10 0h8v7h-8v-7Z"
            />
          </svg>
        </span>

        <h2>${i18nHtml("ui.multichat")}</h2>

        <span class="dion-mc-native-divider" aria-hidden="true"></span>

        <span class="dion-mc-native-subtitle">
          ${paneCount} conversations
        </span>
      </div>

      <div class="dion-mc-toolbar">
        <div
          class="dion-mc-segment"
          role="group"
          aria-label="${h("ui.number_of_chat_panes")}" data-si18n-aria-label="ui.number_of_chat_panes"
        >
          ${([2, 3, 4] as PaneCount[])
            .map(
              (count) => `
                <button
                  type="button"
                  data-mc-pane-count="${count}"
                  class="${paneCount === count ? "is-active" : ""}"
                  aria-pressed="${paneCount === count ? "true" : "false"}"
                >
                  ${count}
                </button>
              `,
            )
            .join("")}
        </div>

        <button
          type="button"
          class="dion-mc-icon-btn"
          data-mc-close
          aria-label="${h("ui.close_multichat")}" data-si18n-aria-label="ui.close_multichat"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M6 6l12 12M18 6 6 18"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>
    </header>

    <div class="dion-mc-tabs" data-mc-tabs role="tablist" aria-label="${h("ui.conversations")}" hidden data-si18n-aria-label="ui.conversations"></div>
    <main
      class="dion-mc-canvas${focusedPaneId ? " is-focused" : ""}"
      data-mc-canvas
      data-count="${paneCount}"
    >
      ${panes
        .slice(0, paneCount)
        .map(paneShellHtml)
        .join("")}
    </main>
  `;
}

function setToolbarOpen(value: boolean): void {
  const button = document.getElementById("Syncord-multichat-toolbar-btn");
  button?.setAttribute("data-open", String(value));
  button?.setAttribute("aria-pressed", String(value));
}

function refreshNativeToolIcons(): void {
  if (!root) return;
  const labels: Record<string, RegExp> = {
    "Upload files": /upload|attach|more message|yükle|dosya|daha fazla/i,
    "Send a gift": /gift|hediye/i,
    GIF: /gif/i,
    Stickers: /sticker|çıkartma/i,
    Emoji: /emoji/i,
    Apps: /apps|uygulama/i,
  };
  const editor = Array.from(document.querySelectorAll<HTMLElement>('[role="textbox"][contenteditable]'))
    .find(element => !root!.contains(element) && Boolean(element.closest("form")));
  const form = editor?.closest("form");
  if (!form) return;
  for (const button of root.querySelectorAll<HTMLElement>("[data-mc-native-tool], [data-mc-media-tool]")) {
    const matcher = labels[button.dataset.mcMediaTool ?? button.dataset.mcNativeTool ?? ""];
    const source = Array.from(form.querySelectorAll<HTMLElement>('button, [role="button"]'))
      .find(element => matcher?.test(element.getAttribute("aria-label") ?? ""));
    const svg = source?.querySelector("svg");
    if (!svg || svg.querySelector("defs, use, [id]")) continue;
    const clone = svg.cloneNode(true) as SVGElement;
    // Native button state/classes and inline dimensions belong to its original
    // composer. Copy geometry only, so an active picker cannot tint/enlarge ours.
    for (const node of [clone, ...clone.querySelectorAll("*")]) {
      node.removeAttribute("class");
      node.removeAttribute("style");
      node.removeAttribute("color");
      if (!node.closest("defs, mask, clipPath")) {
        for (const attribute of ["fill", "stroke"]) {
          const value = node.getAttribute(attribute);
          if (value && value !== "none" && !value.startsWith("url(")) node.setAttribute(attribute, "currentColor");
        }
      }
    }
    clone.removeAttribute("id");
    clone.setAttribute("width", "20");
    clone.setAttribute("height", "20");
    clone.setAttribute("aria-hidden", "true");
    button.replaceChildren(clone);
  }
}

function mountRoot(): void {
  if (root?.isConnected) return;

  root =
    document.createElement(
      "div",
    );

  root.id =
    ROOT_ID;
  setLocalizedAttribute(root, "aria-label", "ui.multichat_workspace");
  root.setAttribute("role", "region");

  setLocalizedHtml(root, rootShellHtml());

  bindRootEvents();

  unmountSurface = mountCanvasSurface(root, closeMultiChatCanvas);
  workspaceResizeObserver = new ResizeObserver(updateWorkspaceLayout);
  workspaceResizeObserver.observe(root);
  updateWorkspaceLayout();

  setToolbarOpen(true);
  root.querySelector<HTMLElement>("[data-mc-close]")?.focus({ preventScroll: true });

  refreshNativeToolIcons();

  for (const pane of panes) {
    bindPaneLocalEvents(pane);

    if (pane.channelId) {
      void loadPane(
        pane,
        true,
      );
    } else {
      renderPaneMessages(
        pane,
        "initial",
      );
    }
  }
}

function updateWorkspaceLayout(): void {
  if (!root) return;
  const canvas = root.querySelector<HTMLElement>("[data-mc-canvas]");
  const tabs = root.querySelector<HTMLElement>("[data-mc-tabs]");
  if (!canvas || !tabs) return;
  const visible = panes.slice(0, paneCount);
  if (!visible.some(pane => pane.id === activePaneId)) activePaneId = visible[0].id;
  // Height never disables the grid: short desktop surfaces scroll their rows.
  const compact = root.clientWidth < 720;
  root.dataset.compact = String(compact);
  canvas.dataset.count = String(paneCount);
  canvas.classList.toggle("is-single", compact || Boolean(focusedPaneId));
  tabs.hidden = !compact && !focusedPaneId;
  const selected = focusedPaneId ?? activePaneId;
  const labels = visible.map(pane => pane.channelId ? channelTitle(pane.channelId).title : i18nText("ui.choose_chat"));
  const signature = JSON.stringify([visible.map(pane => pane.id), labels]);
  if (tabs.dataset.signature !== signature) {
    tabs.dataset.signature = signature;
    setLocalizedHtml(tabs, visible.map((pane, index) => `<button type="button" role="tab" id="mc-tab-${pane.id}" data-mc-tab="${pane.id}" aria-controls="mc-panel-${pane.id}" title="${escapeAttr(labels[index])}"><span class="dion-mc-tab-index">${index + 1}</span><span>${escapeHtml(labels[index])}</span></button>`).join(""));
  }
  for (const pane of panes) {
    const el = paneElement(pane);
    if (!el) continue;
    const hidden = !visible.includes(pane) || ((compact || Boolean(focusedPaneId)) && pane.id !== selected);
    el.hidden = hidden;
    el.classList.toggle("is-focused", pane.id === focusedPaneId);
    el.setAttribute("role", tabs.hidden ? "region" : "tabpanel");
    el.setAttribute("aria-label", pane.channelId ? channelTitle(pane.channelId).title : i18nText("ui.choose_chat"));
    const focus = el.querySelector<HTMLButtonElement>("[data-mc-focus-pane]");
    focus?.querySelector("path")?.setAttribute("d", pane.id === focusedPaneId
      ? "M9 3v2H6.41L10 8.59 8.59 10 5 6.41V9H3V3h6Zm6 0h6v6h-2V6.41L15.41 10 14 8.59 17.59 5H15V3ZM8.59 14 10 15.41 6.41 19H9v2H3v-6h2v2.59L8.59 14ZM15.41 14 19 17.59V15h2v6h-6v-2h2.59L14 15.41 15.41 14Z"
      : "M3 3h7v2H5v5H3V3Zm11 0h7v7h-2V5h-5V3ZM3 14h2v5h5v2H3v-7Zm16 0h2v7h-7v-2h5v-5Z");
    focus?.setAttribute("aria-label", pane.id === focusedPaneId ? i18nText("ui.exit_focus") : i18nText("ui.focus_pane"));
    focus?.setAttribute("aria-pressed", String(pane.id === focusedPaneId));
  }
  for (const tab of tabs.querySelectorAll<HTMLElement>("[data-mc-tab]")) {
    const active = tab.dataset.mcTab === selected;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  const subtitle = root.querySelector(".dion-mc-native-subtitle");
  if (subtitle) setLocalizedText(subtitle, "ui.value_conversations", {v0: paneCount});
}

function selectPane(id: string): void {
  if (!panes.slice(0, paneCount).some(pane => pane.id === id)) return;
  activePaneId = id;
  if (focusedPaneId) focusedPaneId = id;
  updateWorkspaceLayout();
  root?.querySelector<HTMLElement>(`[data-mc-tab="${id}"]`)?.focus();
}

function rerenderWorkspaceShell(changedPane?: PaneRuntime): void {
  if (!root) return;
  closeCanvasDialog();
  const canvas = root.querySelector<HTMLElement>("[data-mc-canvas]");
  if (!canvas) return;
  // Reconcile only changed destinations/new panes. Resizing, focus and count
  // changes must preserve editors, selection, pending uploads and scroll.
  for (const pane of panes.slice(0, paneCount)) {
    const existing = paneElement(pane);
    if (existing && pane !== changedPane) continue;
    if (existing) {
      paneResizeObserver?.unobserve(existing);
      const viewport = existing.querySelector(".dion-mc-messages-wrap");
      if (viewport) paneResizeObserver?.unobserve(viewport);
      clearStickerPreviews(existing);
      existing.remove();
    }
    const template = document.createElement("template");
    setLocalizedHtml(template, paneShellHtml(pane));
    const element = template.content.firstElementChild!;
    const next = panes.slice(panes.indexOf(pane) + 1).map(paneElement).find(Boolean);
    canvas.insertBefore(element, next ?? null);
    bindPaneLocalEvents(pane);
    if (pane.channelId) void loadPane(pane, !pane.initialScrollDone);
    else renderPaneMessages(pane, "initial");
  }
  for (const button of root.querySelectorAll<HTMLButtonElement>("[data-mc-pane-count]")) {
    const active = Number(button.dataset.mcPaneCount) === paneCount;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  refreshNativeToolIcons();
  updateWorkspaceLayout();
}

function ensurePaneCount(
  next: PaneCount,
): void {
  if (panes.some(pane => pane.sending)) return;
  paneCount = next;

  while (
    panes.length <
    paneCount
  ) {
    panes.push(
      makePane(
        panes.length,
      ),
    );
  }

  if (
    focusedPaneId &&
    !panes
      .slice(0, paneCount)
      .some(
        (pane) =>
          pane.id ===
          focusedPaneId,
      )
  ) {
    focusedPaneId =
      undefined;
  }

  scheduleSave();
  rerenderWorkspaceShell();
}

async function loadPane(
  pane: PaneRuntime,
  scrollToBottom: boolean,
): Promise<void> {
  if (
    !pane.channelId ||
    pane.loading
  ) {
    return;
  }

  pane.loading = true;

  renderPaneMessages(
    pane,
    "loading",
  );

  try {
    if (
      getMessages(
        pane.channelId,
      ).length === 0
    ) {
      await fetchInitialMessages(
        pane.channelId,
      );
    }
  } catch (error) {
    ctxRef?.log.warn(
      `MultiChat initial fetch failed for ${pane.channelId}:`,
      error,
    );
  } finally {
    pane.loading = false;

    renderPaneMessages(
      pane,
      scrollToBottom
        ? "initial"
        : "refresh",
    );
  }
}

function renderPaneMessages(
  pane: PaneRuntime,
  reason:
    | "initial"
    | "refresh"
    | "loading"
    | "older",
): void {
  const scroller =
    scrollerElement(pane);

  if (!scroller) return;

  if (!pane.channelId) {
    clearStickerPreviews(scroller);
    setLocalizedHtml(scroller, `
      <div class="dion-mc-empty">
        <div class="dion-mc-empty-icon">
          ${headerIcon("empty")}
        </div>

        <strong>${i18nHtml("ui.choose_a_chat")}</strong>

        <span>
          ${i18nHtml("ui.open_a_dm_server_channel_or_thread_in_this_pane")}
        </span>

        <button
          type="button"
          class="dion-mc-load-button"
          data-mc-pick-channel="${pane.id}"
        >
          ${i18nHtml("ui.select_chat")}
        </button>
      </div>
    `);

    return;
  }

  if (pane.loading) {
    clearStickerPreviews(scroller);
    setLocalizedHtml(scroller, `
      <div class="dion-mc-empty">
        <div class="dion-mc-empty-icon">
          <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="currentColor"
              d="M12 4a8 8 0 1 0 8 8h-2a6 6 0 1 1-6-6V4Z"
            />
          </svg>
        </div>

        <strong>${i18nHtml("ui.loading_messages")}</strong>

        <span>
          ${i18nHtml("ui.syncord_is_preparing_this_chat")}
        </span>
      </div>
    `);

    return;
  }

  const wasNearBottom =
    reason === "initial"
      ? true
      : paneElement(pane)?.hidden ? pane.atBottom : isNearBottom(scroller);

  const oldTop =
    scroller.scrollTop;

  const oldHeight =
    scroller.scrollHeight;

  const messages =
    getMessages(
      pane.channelId,
    );

  const visible =
    messages.length >
    MAX_RENDERED_MESSAGES
      ? messages.slice(
          -MAX_RENDERED_MESSAGES,
        )
      : messages;

  const canLoadOlder =
    hasMoreBefore(
      pane.channelId,
    );

  const loadingOlder =
    pane.loadingOlder ||
    isLoadingMore(
      pane.channelId,
    );

  const messageMarkup =
    visible
      .map(
        (
          message,
          index,
        ) => {
          const previous =
            visible[index - 1];

          const separator =
            !previous ||
            !sameCalendarDay(
              previous.timestamp,
              message.timestamp,
            )
              ? dateSeparatorHtml(
                  message.timestamp,
                )
              : "";

          return (
            separator +
            messageHtml(
              message,
              previous,
              pane.channelId!,
            )
          );
        },
      )
      .join("");

  clearStickerPreviews(scroller);
  setLocalizedHtml(scroller, `
    <div class="dion-mc-scroller-content">
      <ol
        class="dion-mc-message-list"
        role="list"
        aria-label="${h("ui.messages")}"
        data-list-id="chat-messages"
        tabindex="0"
        aria-orientation="vertical" data-si18n-aria-label="ui.messages"
      >
        <div class="dion-mc-load-row">
          ${canLoadOlder
              ? `
                <button
                  type="button"
                  class="dion-mc-load-button"
                  data-mc-load-older="${pane.id}"
                  ${loadingOlder ? "disabled" : ""}
                >
                  ${loadingOlder ? i18nHtml("ui.loading") : i18nHtml("ui.load_older")}
                </button>
              `
              : visible.length
                ? ""
                : ""}
        </div>

        ${visible.length
            ? messageMarkup
            : `
              <div
                class="dion-mc-empty"
                style="min-height:70%"
              >
                <div class="dion-mc-empty-icon">
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      fill="currentColor"
                      d="M4 4h16v12H7l-3 3V4Zm2 2v8.17L6.17 14H18V6H6Z"
                    />
                  </svg>
                </div>

                <strong>${i18nHtml("ui.no_messages_loaded")}</strong>

                <span>
                  ${i18nHtml("ui.send_the_first_message_or_load_this_chat_again")}
                </span>
              </div>
            `}

        <div
          class="dion-mc-native-bottom-spacer"
          aria-hidden="true"
        ></div>
      </ol>
    </div>
  `);

  for (const element of scroller.querySelectorAll<HTMLElement>("[data-mc-sticker-preview]")) {
    renderStickerPreview(element, {id:element.dataset.mcStickerPreview!, name:element.dataset.stickerName!, format_type:Number(element.dataset.stickerFormat)}, 160);
  }

  pane.fingerprint =
    messageFingerprint(
      pane.channelId,
    );

  if (reason === "older") {
    const newHeight =
      scroller.scrollHeight;

    scroller.scrollTop =
      oldTop +
      (
        newHeight -
        oldHeight
      );

    return;
  }

  if (
    reason === "initial" ||
    (
      wasNearBottom &&
      reason === "refresh"
    )
  ) {
    requestAnimationFrame(
      () => {
        if (!paneElement(pane)?.hidden) scroller.scrollTop = scroller.scrollHeight;

        pane.atBottom =
          true;

        pane.newMessages =
          0;

        pane.initialScrollDone =
          true;

        updateNewPill(
          pane,
        );
      },
    );

    return;
  }

  scroller.scrollTop =
    oldTop;

  if (!paneElement(pane)?.hidden) pane.atBottom = isNearBottom(scroller);

  if (
    reason === "refresh" &&
    !pane.atBottom
  ) {
    pane.newMessages +=
      1;
  }

  updateNewPill(
    pane,
  );
}

function updateNewPill(
  pane: PaneRuntime,
): void {
  const element =
    paneElement(pane)
      ?.querySelector<HTMLButtonElement>(
        "[data-mc-new-messages]",
      );

  if (!element) return;

  const visible =
    !pane.atBottom &&
    pane.newMessages > 0;

  element.classList.toggle(
    "is-visible",
    visible,
  );

  const label =
    element.querySelector<HTMLElement>(
      "[data-mc-new-label]",
    );

  if (label) {
    label.textContent =
      pane.newMessages > 1
        ? i18nText("ui.value_new_messages", {v0: pane.newMessages})
        : i18nText("ui.new_message");
  }
}

function scrollPaneBottom(
  pane: PaneRuntime,
): void {
  const scroller =
    scrollerElement(pane);

  if (!scroller) return;

  scroller.scrollTo({
    top:
      scroller.scrollHeight,
    behavior: "smooth",
  });

  pane.atBottom =
    true;

  pane.newMessages =
    0;

  updateNewPill(
    pane,
  );
}

async function loadOlder(
  pane: PaneRuntime,
): Promise<void> {
  if (
    !pane.channelId ||
    pane.loadingOlder
  ) {
    return;
  }

  const messages =
    getMessages(
      pane.channelId,
    );

  const oldest =
    messages[0];

  if (!oldest?.id) {
    return;
  }

  pane.loadingOlder =
    true;

  renderPaneMessages(
    pane,
    "refresh",
  );

  try {
    await fetchOlderMessages(
      pane.channelId,
      oldest.id,
    );
  } catch (error) {
    ctxRef?.log.warn(
      `MultiChat older fetch failed for ${pane.channelId}:`,
      error,
    );
  } finally {
    pane.loadingOlder =
      false;

    renderPaneMessages(
      pane,
      "older",
    );
  }
}

function setReply(
  pane: PaneRuntime,
  messageId: string,
): void {
  if (!pane.channelId) return;

  const message =
    getMessage(
      pane.channelId,
      messageId,
    );

  if (!message || pane.sending) return;

  const guildId =
    guildIdForMessage(
      message,
      pane.channelId,
    );

  pane.reply = {
    messageId,
    authorName:
      userDisplayName(
        message.author,
        guildId,
      ),
    preview:
      shortPreview(
        message.content,
      ) || i18nText("ui.attachment"),
  };

  updateReplyStrip(
    pane,
  );

  paneElement(pane)
    ?.querySelector<HTMLElement>(
      "[data-mc-composer]",
    )
    ?.focus();
}

function updateReplyStrip(
  pane: PaneRuntime,
): void {
  const paneEl =
    paneElement(pane);

  const strip =
    paneEl?.querySelector<HTMLElement>(
      "[data-mc-reply-strip]",
    );

  if (!strip) return;

  strip.classList.toggle(
    "is-visible",
    Boolean(pane.reply),
  );

  const author =
    strip.querySelector<HTMLElement>(
      "[data-mc-reply-author]",
    );

  const preview =
    strip.querySelector<HTMLElement>(
      "[data-mc-reply-preview]",
    );

  if (author) {
    author.textContent =
      pane.reply?.authorName ?? "";
  }

  if (preview) {
    preview.textContent =
      pane.reply?.preview ?? "";
  }
}

function refreshComposer(pane: PaneRuntime): void {
  const paneEl = paneElement(pane);
  const editor = paneEl?.querySelector<HTMLElement>("[data-mc-composer]");
  if (editor) {
    editor.contentEditable = pane.channelId && !pane.sending ? "plaintext-only" : "false";
    resizeEditor(editor);
    updateSendButtonState(pane, editor);
  }
  paneEl?.querySelectorAll<HTMLButtonElement>("[data-mc-media-tool], [data-mc-native-tool], [data-mc-pick-channel], [data-mc-clear-pane], [data-mc-open-native], [data-mc-cancel-reply]")
    .forEach(button => { button.disabled = pane.sending || (!pane.channelId && (button.hasAttribute("data-mc-media-tool") || button.hasAttribute("data-mc-native-tool"))); });
  const tray = paneEl?.querySelector<HTMLElement>("[data-mc-media-draft]");
  if (tray) renderMediaDraft(pane, tray, () => refreshComposer(pane));
}

async function receiveFiles(pane: PaneRuntime, files: File[]): Promise<void> {
  if (!pane.channelId || pane.sending || !files.length) return;
  const channelId=pane.channelId;
  const valid=():boolean=>pane.channelId===channelId&&!pane.sending&&!!paneElement(pane)?.isConnected;
  try {const prepared=await prepareUploadFiles(files,{channelId,valid});if(!prepared||!valid())return;addFiles(pane,prepared);} catch (error) { pane.sendError = mediaError(error); }
  refreshComposer(pane);
}

function openPaneMedia(pane: PaneRuntime, kind: string, anchor?: HTMLElement): void {
  if (!root || !pane.channelId || pane.sending) return;
  const editor = paneElement(pane)?.querySelector<HTMLElement>("[data-mc-composer]");
  if (!editor) return;
  if (kind === "Upload files") {
    paneElement(pane)?.querySelector<HTMLInputElement>("[data-mc-files]")?.click();
    return;
  }
  const selection = window.getSelection();
  const range = selection?.rangeCount && editor.contains(selection.getRangeAt(0).commonAncestorContainer)
    ? selection.getRangeAt(0).cloneRange() : undefined;
  const channelId = pane.channelId;
  openMediaPicker(root, channelId, kind as PickerKind, item => {
    if (pane.channelId !== channelId || pane.sending || !editor.isConnected) return;
    if (typeof item === "string") {
      insertComposerText(editor, item, range);
      pane.draft = editorText(editor);
      pane.sendError = undefined;
      scheduleSave();
    } else if (!pane.stickers.some(sticker => sticker.id === item.id)) {
      if (pane.stickers.length >= 3) pane.sendError = i18nText("ui.you_can_attach_up_to_3_stickers_to_one_message");
      else { pane.stickers.push(item); pane.sendError = undefined; }
    }
    refreshComposer(pane);
  }, anchor, message => {
    if (pane.channelId !== channelId || !editor.isConnected) return;
    pane.sendError = message;
    refreshComposer(pane);
  });
}

async function sendFromPane(pane: PaneRuntime): Promise<void> {
  if (!pane.channelId || pane.sending) return;
  const editor = paneElement(pane)?.querySelector<HTMLElement>("[data-mc-composer]");
  if (!editor) return;
  const raw = editorText(editor);
  const content = longMessagesEnabled()&&raw.length>2000&&raw.length>accountLimit()?raw:raw.trim();
  if (!content.trim() && !pane.files.length && !pane.stickers.length) return;
  const channelId = pane.channelId;
  pane.sending = true;
  pane.sendError = undefined;
  pane.draft = editorText(editor);
  closeMediaPicker();
  refreshComposer(pane);
  const uploads: ReturnType<typeof createUploads> = [];
  try {
    const permissionError = channelSendError(channelId);
    if (permissionError) throw new Error(permissionError);
    const emojis = validateCustomEmojis(channelId, content);
    uploads.push(...createUploads(pane.files.map(item => item.file), channelId, (index, progress) => {
      const file = pane.files[index];
      if (!file || !pane.sending) return;
      file.progress = progress;
      const label = paneElement(pane)?.querySelector<HTMLElement>(`[data-mc-file-progress="${file.id}"]`);
      if (label) label.textContent = ` · ${progress}%`;
    }));
    activeUploads.set(pane, uploads);
    await sendCanvasMessage(channelId, content, pane.reply, {
      uploads, stickerIds: pane.stickers.map(sticker => sticker.id), emojis,
      valid:()=>panes.includes(pane)&&pane.channelId===channelId,
      onRemaining:(remaining,sent)=>{
        if(!panes.includes(pane)||pane.channelId!==channelId)return;
        const current=paneElement(pane)?.querySelector<HTMLElement>('[data-mc-composer]');
        if(current&&editorText(current)===pane.draft){pane.draft=remaining;setEditorText(current,remaining);scheduleSave();}
        if(sent===1){pane.reply=undefined;pane.stickers=[];releaseFiles(pane);updateReplyStrip(pane);}
      },
    });
    if (!panes.includes(pane)) return;
    pane.draft = "";
    pane.reply = undefined;
    pane.stickers = [];
    releaseFiles(pane);
    // Re-query: the workspace may have been closed and reopened during the send.
    const currentEditor = paneElement(pane)?.querySelector<HTMLElement>("[data-mc-composer]");
    if (currentEditor) setEditorText(currentEditor, "");
    updateReplyStrip(pane);
    scheduleSave();
    refreshPaneIfChanged(pane, true);
    scrollPaneBottom(pane);
  } catch (error) {
    pane.sendError = mediaError(error);
    ctxRef?.log.error("MultiChat send failed:", error);
    for (const item of pane.files) item.progress = undefined;
  } finally {
    activeUploads.delete(pane);
    pane.sending = false;
    if (panes.includes(pane)) refreshComposer(pane);
  }
}

function refreshPaneIfChanged(
  pane: PaneRuntime,
  force = false,
): void {
  if (!pane.channelId) return;

  const next =
    messageFingerprint(
      pane.channelId,
    );

  if (
    !force &&
    next ===
      pane.fingerprint
  ) {
    return;
  }

  renderPaneMessages(
    pane,
    pane.initialScrollDone
      ? "refresh"
      : "initial",
  );
}

function scheduleRefresh(
  channelId?: string,
): void {
  if (!root) return;

  if (refreshRaf !== undefined) {
    return;
  }

  refreshRaf =
    requestAnimationFrame(
      () => {
        refreshRaf =
          undefined;

        for (
          const pane
          of panes.slice(
            0,
            paneCount,
          )
        ) {
          if (
            !pane.channelId ||
            (
              channelId &&
              pane.channelId !==
                channelId
            )
          ) {
            continue;
          }

          refreshPaneIfChanged(
            pane,
          );
        }
      },
    );
}

function dispatcherChannelId(
  payload: unknown,
): string | undefined {
  if (
    payload == null ||
    typeof payload !== "object"
  ) {
    return undefined;
  }

  const value =
    payload as Record<string, unknown>;

  const direct =
    value.channelId ??
    value.channel_id;

  if (
    typeof direct === "string"
  ) {
    return direct;
  }

  const message =
    value.message;

  if (
    message &&
    typeof message === "object"
  ) {
    const id =
      (
        message as
          Record<string, unknown>
      ).channel_id ??
      (
        message as
          Record<string, unknown>
      ).channelId;

    return typeof id ===
      "string"
      ? id
      : undefined;
  }

  return undefined;
}

function bindDispatcher(): () => void {
  const dispatcher =
    window.Syncord?.common?.flux
      ?.FluxDispatcher as
      | {
          subscribe?: (
            event: string,
            listener: (
              payload: unknown,
            ) => void,
          ) => void;

          unsubscribe?: (
            event: string,
            listener: (
              payload: unknown,
            ) => void,
          ) => void;
        }
      | undefined;

  if (
    typeof dispatcher?.subscribe !==
      "function"
  ) {
    return () => {};
  }

  const events = [
    "MESSAGE_CREATE",
    "MESSAGE_UPDATE",
    "MESSAGE_DELETE",
    "MESSAGE_DELETE_BULK",
    "LOAD_MESSAGES_SUCCESS",
    "LOAD_MESSAGES_AROUND_SUCCESS",
  ];

  const listener =
    (payload: unknown) => {
      scheduleRefresh(
        dispatcherChannelId(
          payload,
        ),
      );
    };

  const subscribed:
    string[] = [];

  for (
    const event
    of events
  ) {
    try {
      dispatcher.subscribe(
        event,
        listener,
      );

      subscribed.push(
        event,
      );
    } catch {
      /* Some Discord builds reject unknown dispatcher event names. */
    }
  }

  return () => {
    for (
      const event
      of subscribed
    ) {
      try {
        dispatcher.unsubscribe?.(
          event,
          listener,
        );
      } catch {
        /* cleanup best effort */
      }
    }
  };
}

function bindPaneLocalEvents(
  pane: PaneRuntime,
): void {
  const paneEl =
    paneElement(pane);

  if (!paneEl) return;

  const scroller =
    paneEl.querySelector<HTMLElement>(
      "[data-mc-messages]",
    );

  scroller?.addEventListener(
    "scroll",
    () => {
      if (paneEl.hidden) return;
      const atBottom =
        isNearBottom(
          scroller,
        );

      pane.atBottom =
        atBottom;

      if (atBottom) {
        pane.newMessages =
          0;
      }

      updateNewPill(
        pane,
      );

      if (
        scroller.scrollTop <
          54 &&
        pane.channelId &&
        !pane.loadingOlder &&
        hasMoreBefore(
          pane.channelId,
        )
      ) {
        void loadOlder(
          pane,
        );
      }
    },
    {
      passive:
        true,
    },
  );

  const form =
    paneEl.querySelector<HTMLFormElement>(
      "[data-mc-form]",
    );

  form?.addEventListener(
    "submit",
    (
      event,
    ) => {
      event.preventDefault();

      void sendFromPane(
        pane,
      );
    },
  );

  const fileInput = paneEl.querySelector<HTMLInputElement>("[data-mc-files]");
  fileInput?.addEventListener("change", () => {
    receiveFiles(pane, Array.from(fileInput.files ?? []));
    fileInput.value = "";
  });
  paneEl.addEventListener("dragover", event => {
    if (event.dataTransfer?.types.includes("Files")) {
      event.preventDefault(); event.stopPropagation();
      event.dataTransfer.dropEffect = pane.channelId && !pane.sending ? "copy" : "none";
    }
  });
  paneEl.addEventListener("drop", event => {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault(); event.stopPropagation();
    receiveFiles(pane, Array.from(event.dataTransfer.files));
  });
  paneEl.addEventListener("paste", event => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!files.length) return;
    event.preventDefault(); event.stopPropagation();
    receiveFiles(pane, files);
  });
  refreshComposer(pane);

  const editor = paneEl.querySelector<HTMLElement>("[data-mc-composer]");

  if (editor) {
    setEditorText(editor, pane.draft);
    resizeEditor(editor);
    editor.addEventListener("copy", event => {
      const selection = window.getSelection();
      if (!event.clipboardData || !selection?.rangeCount || selection.isCollapsed) return;
      const range = selection.getRangeAt(0);
      if (!editor.contains(range.commonAncestorContainer)) return;
      event.preventDefault();
      event.clipboardData.setData("text/plain", composerText(range.cloneContents()));
    });
    paneResizeObserver ??= new ResizeObserver(entries => {
      for (const entry of entries) {
        const element = entry.target.closest<HTMLElement>("[data-mc-pane]");
        if (!element || element.hidden) continue;
        if (entry.target.classList.contains("dion-mc-messages-wrap")) {
          const current = paneById(element.dataset.mcPane);
          const scroller = current && scrollerElement(current);
          if (scroller && current.atBottom) scroller.scrollTop = scroller.scrollHeight;
          continue;
        }
        const width = entry.contentRect.width;
        if (paneWidths.get(entry.target) === width) continue;
        paneWidths.set(entry.target, width);
        const input = entry.target.querySelector<HTMLElement>("[data-mc-composer]");
        if (input) resizeEditor(input);
      }
    });
    paneResizeObserver.observe(paneEl);
    const viewport = paneEl.querySelector(".dion-mc-messages-wrap");
    if (viewport) paneResizeObserver.observe(viewport);

    resizeEditor(
      editor,
    );

    updateSendButtonState(
      pane,
      editor,
    );

    editor.addEventListener(
      "input",
      () => {
        pane.sendError = undefined;
        pane.draft =
          editorText(
            editor,
          );

        resizeEditor(
          editor,
        );

        updateSendButtonState(
          pane,
          editor,
        );

        refreshComposer(pane);
        scheduleSave();
      },
    );

    editor.addEventListener(
      "keydown",
      (
        event,
      ) => {
        if (
          event.key ===
            "Escape" &&
          pane.reply
        ) {
          event.preventDefault();
          event.stopPropagation();

          pane.reply =
            undefined;

          updateReplyStrip(
            pane,
          );

          return;
        }

        if (
          event.key !==
            "Enter" ||
          event.shiftKey ||
          event.isComposing
        ) {
          return;
        }

        event.preventDefault();

        void sendFromPane(
          pane,
        );
      },
    );
  }
}

function pickerChoiceIcon(
  choice: ChannelChoice,
): string {
  const avatar = choice.kind === "dm" ? safeMediaUrl(channelAvatarUrl(choice.id)) : undefined;
  const fallback = headerIcon(choice.kind);
  return avatar
    ? `${fallback}<img src="${escapeAttr(avatar)}" alt="" loading="lazy" decoding="async" data-mc-choice-avatar />`
    : fallback;
}

function renderPickerList(
  list: HTMLElement,
  pane: PaneRuntime,
  query: string,
): void {
  const matches = listChannelChoices(query);
  const dms = matches.filter(choice => choice.kind === "dm");
  const servers = matches.filter(choice => choice.kind === "server");
  // Keep both groups reachable even for accounts with hundreds of private chats.
  const choices = query.trim() ? matches.slice(0, 300) : [
    ...dms.slice(0, Math.max(150, 300 - servers.length)),
    ...servers.slice(0, Math.max(150, 300 - dms.length)),
  ];

  if (!choices.length) {
    setLocalizedHtml(list, `
      <div class="dion-mc-picker-empty">
        ${/^\s*(?:<#)?\d{17,20}>?\s*$/.test(query)
          ? i18nHtml("ui.channel_not_found_or_inaccessible_enter_the_id_of_a_text_channel_or_th")
          : i18nHtml("ui.no_matching_chats_found_search_by_chat_server_channel_name_or_channel_")}
      </div>
    `);

    return;
  }

  let currentKind:
    | "dm"
    | "server"
    | undefined;

  const html:
    string[] = [];

  for (
    const choice
    of choices
  ) {
    if (
      choice.kind !==
      currentKind
    ) {
      currentKind =
        choice.kind;

      html.push(`
        <div class="dion-mc-picker-group">
          ${
            currentKind === "dm"
              ? i18nHtml("ui.direct_messages")
              : i18nHtml("ui.server_channels")
          }
        </div>
      `);
    }

    html.push(`
      <button
        type="button"
        class="dion-mc-choice${choice.id === pane.channelId ? " is-current" : ""}"
        data-mc-channel-choice="${escapeAttr(choice.id)}"
      >
        <span class="dion-mc-choice-icon">
          ${pickerChoiceIcon(choice)}
        </span>

        <span class="dion-mc-choice-copy">
          <span class="dion-mc-choice-title">
            ${escapeHtml(choice.label)}
          </span>

          <span class="dion-mc-choice-sub">
            ${escapeHtml(choice.sublabel)}
          </span>
        </span>
      </button>
    `);
  }

  if (matches.length > choices.length) {
    html.push(`<div class="dion-mc-picker-group" role="status">${i18nHtml("ui.showing_chats_search_hint",{shown:choices.length,total:matches.length})}</div>`);
  }
  setLocalizedHtml(list, html.join(""));
}

function openChannelPicker(
  pane: PaneRuntime,
): void {
  if (!root) return;

  closeCanvasDialog();

  const backdrop =
    document.createElement(
      "div",
    );

  backdrop.className =
    "dion-mc-picker-backdrop";

  backdrop.dataset.mcPickerFor =
    pane.id;

  setLocalizedHtml(backdrop, `
    <section
      class="dion-mc-picker"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dion-mc-picker-title"
    >
      <header class="dion-mc-picker-head">
        <div>
          <h3 id="dion-mc-picker-title">
            ${i18nHtml("ui.choose_chat")}
          </h3>

          <p>
            ${i18nHtml("ui.pick_a_dm_server_text_channel_or_thread_you_can_also_paste_a_channel_i")}
          </p>
        </div>

        <button
          type="button"
          class="dion-mc-icon-btn"
          data-mc-picker-close
          aria-label="${h("ui.close_channel_picker")}" data-si18n-aria-label="ui.close_channel_picker"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M6 6l12 12M18 6 6 18"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </header>

      <label class="dion-mc-search-shell">
        <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M10.5 4a6.5 6.5 0 1 0 3.94 11.67L19.77 21l1.23-1.23-5.33-5.33A6.5 6.5 0 0 0 10.5 4Zm0 2a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Z"
          />
        </svg>

        <input
          type="text"
          data-mc-picker-search
          aria-label="${h("ui.search_chats")}"
          placeholder="${h("ui.search_dms_servers_channels_or_paste_a_channel_id")}"
          autocomplete="off"
          spellcheck="false" data-si18n-aria-label="ui.search_chats" data-si18n-placeholder="ui.search_dms_servers_channels_or_paste_a_channel_id"
        />
      </label>

      <div
        class="dion-mc-picker-list"
        data-mc-picker-list
      ></div>
    </section>
  `);

  unmountChannelPicker = mountCanvasDialog(root, backdrop, closeChannelPicker);

  const list =
    backdrop.querySelector<HTMLElement>(
      "[data-mc-picker-list]",
    );

  const input =
    backdrop.querySelector<HTMLInputElement>(
      "[data-mc-picker-search]",
    );

  if (list) {
    renderPickerList(
      list,
      pane,
      "",
    );
  }

  list?.addEventListener("error", event => {
    if (event.target instanceof HTMLImageElement && event.target.hasAttribute("data-mc-choice-avatar")) event.target.remove();
  }, true);

  input?.addEventListener(
    "input",
    () => {
      if (!list) return;

      renderPickerList(
        list,
        pane,
        input.value,
      );
    },
  );

  input?.focus();
}

function closeChannelPicker(): void {
  unmountChannelPicker?.();
  unmountChannelPicker = undefined;
}

async function assignChannel(
  pane: PaneRuntime,
  channelId: string,
): Promise<void> {
  if (pane.sending || pane.channelId === channelId) return;
  // A draft belongs to its destination; switching must not carry media to another chat.
  if (pane.files.length || pane.stickers.length || pane.draft.trim()) {
    pane.sendError = i18nText("ui.send_or_clear_this_draft_before_changing_the_chat");
    refreshComposer(pane);
    return;
  }
  if (!listChannelChoices(channelId).some(choice => choice.id === channelId)) {
    pane.sendError = i18nText("ui.this_chat_is_unavailable_or_you_do_not_have_permission_to_view_it");
    refreshComposer(pane);
    return;
  }
  closeMediaPicker();
  pane.sendError = undefined;
  pane.channelId = channelId;

  pane.reply =
    undefined;

  pane.newMessages =
    0;

  pane.atBottom =
    true;

  pane.fingerprint =
    "";

  pane.initialScrollDone =
    false;

  scheduleSave();

  rerenderWorkspaceShell(pane);

  const updated =
    paneById(
      pane.id,
    );

  if (updated) {
    await loadPane(
      updated,
      true,
    );
  }
}

function clearPane(
  pane: PaneRuntime,
): void {
  if (pane.sending) return;
  closeMediaPicker();
  releaseFiles(pane);
  pane.stickers = [];
  pane.sendError = undefined;
  pane.channelId =
    undefined;

  pane.draft = "";

  pane.reply =
    undefined;

  pane.newMessages =
    0;

  pane.fingerprint =
    "";

  pane.initialScrollDone =
    false;

  scheduleSave();

  rerenderWorkspaceShell(pane);
}

function bindRootEvents(): void {
  if (!root) return;
  root.addEventListener("keydown", event => {
    if (event.defaultPrevented) return;
    // Keys from the native picker must not also switch/close the workspace.
    if (event.target instanceof Element && event.target.closest(".dion-mc-native-picker-host, .dion-mc-native-picker-layer")) {
      if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); event.stopPropagation(); closeMediaPicker(); }
      return;
    }
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-mc-tab]") : null;
    if (target && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const index = panes.findIndex(pane => pane.id === target.dataset.mcTab);
      const next = event.key === "Home" ? 0 : event.key === "End" ? paneCount - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + paneCount) % paneCount;
      selectPane(panes[next].id);
    } else if (event.key === "Escape" && !event.isComposing) {
      event.preventDefault(); event.stopPropagation();
      if (focusedPaneId) { focusedPaneId = undefined; updateWorkspaceLayout(); }
      else closeMultiChatCanvas();
    }
  });
  root.addEventListener("focusin", event => {
    const pane = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-mc-pane]") : null;
    if (pane?.dataset.mcPane) activePaneId = pane.dataset.mcPane;
  });

  root.addEventListener(
    "click",
    (event) => {
      const target =
        event.target;

      if (
        !(target instanceof Element)
      ) {
        return;
      }

      if (
        target.closest(
          "[data-mc-close]",
        )
      ) {
        event.preventDefault();
        closeMultiChatCanvas();
        return;
      }

      const tab = target.closest<HTMLElement>("[data-mc-tab]");
      if (tab?.dataset.mcTab) { selectPane(tab.dataset.mcTab); return; }
      const mediaTool = target.closest<HTMLElement>("[data-mc-media-tool]");
      if (mediaTool) {
        event.preventDefault();
        const pane = paneById(mediaTool.closest<HTMLElement>("[data-mc-pane]")?.dataset.mcPane);
        if (pane) openPaneMedia(pane, mediaTool.dataset.mcMediaTool ?? "", mediaTool);
        return;
      }
      const nativeTool = target.closest<HTMLElement>("[data-mc-native-tool]");
      if (nativeTool) {
        const pane = paneById(nativeTool.closest<HTMLElement>("[data-mc-pane]")?.dataset.mcPane);
        if (pane?.channelId) {
          // Keep drafts in Canvas; never overwrite a native draft
          // or auto-send media when switching to Discord's own composer.
          openChannelInDiscord(pane.channelId);
          closeMultiChatCanvas();
          window.Syncord?.toast?.show?.(
            i18nText("ui.value_use_the_discord_message_box_your_canvas_draft_is_saved_in_multic", {v0: nativeTool.dataset.mcNativeTool}),
          );
        }
        return;
      }

      const countButton =
        target.closest<HTMLElement>(
          "[data-mc-pane-count]",
        );

      if (countButton) {
        const next =
          Number(
            countButton.dataset.mcPaneCount,
          );

        if (
          next === 2 ||
          next === 3 ||
          next === 4
        ) {
          ensurePaneCount(
            next,
          );
        }

        return;
      }

      const pickerButton =
        target.closest<HTMLElement>(
          "[data-mc-pick-channel]",
        );

      if (pickerButton) {
        const pane =
          paneById(
            pickerButton.dataset.mcPickChannel,
          );

        if (pane) {
          openChannelPicker(
            pane,
          );
        }

        return;
      }

      const pickerClose =
        target.closest(
          "[data-mc-picker-close]",
        );

      if (pickerClose) {
        closeChannelPicker();
        return;
      }

      const pickerBackdrop =
        target.classList.contains(
          "dion-mc-picker-backdrop",
        );

      if (pickerBackdrop) {
        closeChannelPicker();
        return;
      }

      const choice =
        target.closest<HTMLElement>(
          "[data-mc-channel-choice]",
        );

      if (choice) {
        const picker =
          choice.closest<HTMLElement>(
            "[data-mc-picker-for]",
          );

        const pane =
          paneById(
            picker?.dataset.mcPickerFor,
          );

        const channelId =
          choice.dataset.mcChannelChoice;

        if (
          pane &&
          channelId
        ) {
          closeChannelPicker();

          void assignChannel(
            pane,
            channelId,
          );
        }

        return;
      }

      const loadOlderButton =
        target.closest<HTMLElement>(
          "[data-mc-load-older]",
        );

      if (loadOlderButton) {
        const pane =
          paneById(
            loadOlderButton.dataset.mcLoadOlder,
          );

        if (pane) {
          void loadOlder(
            pane,
          );
        }

        return;
      }

      const newButton =
        target.closest<HTMLElement>(
          "[data-mc-new-messages]",
        );

      if (newButton) {
        const pane =
          paneById(
            newButton.dataset.mcNewMessages,
          );

        if (pane) {
          scrollPaneBottom(
            pane,
          );
        }

        return;
      }

      const sendButton =
        target.closest<HTMLElement>(
          "[data-mc-send]",
        );

      if (sendButton) {
        event.preventDefault();
        const pane =
          paneById(
            sendButton.dataset.mcSend,
          );

        if (pane) {
          void sendFromPane(
            pane,
          );
        }

        return;
      }

      const replyButton =
        target.closest<HTMLElement>(
          "[data-mc-reply-message]",
        );

      if (replyButton) {
        const paneEl =
          replyButton.closest<HTMLElement>(
            "[data-mc-pane]",
          );

        const pane =
          paneById(
            paneEl?.dataset.mcPane,
          );

        const messageId =
          replyButton.dataset.mcReplyMessage;

        if (
          pane &&
          messageId
        ) {
          setReply(
            pane,
            messageId,
          );
        }

        return;
      }

      const cancelReply =
        target.closest<HTMLElement>(
          "[data-mc-cancel-reply]",
        );

      if (cancelReply) {
        const pane =
          paneById(
            cancelReply.dataset.mcCancelReply,
          );

        if (pane) {
          pane.reply =
            undefined;

          updateReplyStrip(
            pane,
          );
        }

        return;
      }

      const clearButton =
        target.closest<HTMLElement>(
          "[data-mc-clear-pane]",
        );

      if (clearButton) {
        const pane =
          paneById(
            clearButton.dataset.mcClearPane,
          );

        if (pane) {
          clearPane(
            pane,
          );
        }

        return;
      }

      const focusButton =
        target.closest<HTMLElement>(
          "[data-mc-focus-pane]",
        );

      if (focusButton) {
        const paneId =
          focusButton.dataset.mcFocusPane;

        focusedPaneId =
          focusedPaneId === paneId
            ? undefined
            : paneId;

        rerenderWorkspaceShell();
        return;
      }

      const popoutButton=target.closest<HTMLElement>("[data-mc-popout]");
      if(popoutButton){const pane=paneById(popoutButton.dataset.mcPopout);if(pane?.channelId)openChatPopout(pane.channelId);return;}
      const nativeButton =
        target.closest<HTMLElement>(
          "[data-mc-open-native]",
        );

      if (nativeButton) {
        const pane =
          paneById(
            nativeButton.dataset.mcOpenNative,
          );

        if (
          pane?.channelId
        ) {
          const channelId =
            pane.channelId;

          closeMultiChatCanvas();

          openChannelInDiscord(
            channelId,
          );
        }

        return;
      }

      const userButton =
        target.closest<HTMLElement>(
          "[data-mc-user-id]",
        );

      if (userButton) {
        const userId =
          userButton.dataset.mcUserId;

        const paneEl =
          userButton.closest<HTMLElement>(
            "[data-mc-pane]",
          );

        const pane =
          paneById(
            paneEl?.dataset.mcPane,
          );

        if (
          userId &&
          pane?.channelId
        ) {
          openUserProfile(
            userId,
            pane.channelId,
          );
        }
      }
    },
  );
}

export function openMultiChatCanvas(
  ctx: PluginContext,
): void {
  if (root?.isConnected) {
    return;
  }

  ctxRef =
    ctx;

  restoreWorkspace(
    ctx,
  );

  mountRoot();
  removePopoutListener=onPopoutAvailabilityChange(()=>{
    for(const pane of panes){
      const head=paneElement(pane)?.querySelector<HTMLElement>('.dion-mc-head-actions');if(!head)continue;
      const existing=head.querySelector('[data-mc-popout]');
      if(!pane.channelId||!popoutsAvailable()){existing?.remove();continue;}
      if(existing)continue;const button=document.createElement('button');button.type='button';button.className='dion-mc-icon-btn';button.dataset.mcPopout=pane.id;button.textContent='↗';setLocalizedAttribute(button,'aria-label','popout.open');head.prepend(button);
    }
  });
  removeLocaleListener=onLocaleChange(()=>{
    if(!root)return;
    updateWorkspaceLayout();
    for(const time of root.querySelectorAll<HTMLElement>('[data-mc-time]')){
      if(time.dataset.mcTime)time.textContent=formatTime(Number(time.dataset.mcTime));
    }
    for(const separator of root.querySelectorAll<HTMLElement>('[data-mc-day]')){
      const timestamp=Number(separator.dataset.mcDay);
      if(!Number.isFinite(timestamp))continue;
      const label=new Date(timestamp).toLocaleDateString(getLocale(),{day:'2-digit',month:'long',year:'numeric'});
      separator.setAttribute('aria-label',label);
      const text=separator.querySelector('.dion-mc-date-label');if(text)text.textContent=label;
    }
  });

  const removeStoreListener =
    subscribeMessageStore(
      () =>
        scheduleRefresh(),
    );

  const removeFluxListener =
    bindDispatcher();

  removeDispatcherListeners =
    () => {
      removeStoreListener();
      removeFluxListener();
    };

  fallbackTimer =
    window.setInterval(
      () => {
        if (!root) return;

        scheduleRefresh();
      },
      REFRESH_FALLBACK_MS,
    );
}

export function closeMultiChatCanvas(): void {
  removePopoutListener?.();removePopoutListener=undefined;
  removeLocaleListener?.();removeLocaleListener=undefined;
  closeCanvasDialog();
  workspaceResizeObserver?.disconnect();
  workspaceResizeObserver = undefined;
  paneResizeObserver?.disconnect();
  paneResizeObserver = undefined;
  if (saveTimer !== undefined) {
    window.clearTimeout(
      saveTimer,
    );

    saveTimer =
      undefined;
  }

  if (ctxRef) {
    ctxRef.settings.set(
      WORKSPACE_KEY,
      workspaceSnapshot(),
    );
  }

  if (fallbackTimer !== undefined) {
    window.clearInterval(
      fallbackTimer,
    );

    fallbackTimer =
      undefined;
  }

  if (refreshRaf !== undefined) {
    cancelAnimationFrame(
      refreshRaf,
    );

    refreshRaf =
      undefined;
  }

  removeDispatcherListeners?.();
  removeDispatcherListeners =
    undefined;

  closeChannelPicker();

  if (root) clearStickerPreviews(root);
  unmountSurface?.();
  unmountSurface = undefined;
  root?.remove();
  root =
    undefined;

  focusedPaneId =
    undefined;

  setToolbarOpen(false);
}

export function toggleMultiChatCanvas(
  ctx: PluginContext,
): void {
  if (root?.isConnected) {
    closeMultiChatCanvas();
  } else {
    openMultiChatCanvas(
      ctx,
    );
  }
}

export function isMultiChatCanvasOpen(): boolean {
  return Boolean(
    root?.isConnected,
  );
}

/** Plugin shutdown releases in-memory File/Blob resources; ordinary hide preserves drafts. */
export function disposeMultiChatCanvas(): void {
  closeMultiChatCanvas();
  for (const uploads of activeUploads.values()) for (const upload of uploads) {
    try { upload.cancel(); } catch { /* uploader may already have completed */ }
  }
  activeUploads.clear();
  for (const pane of panes) releaseFiles(pane);
  panes = [];
  ctxRef = undefined;
}
