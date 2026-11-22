import { getLocale, h, t as i18nText, messageHtml as i18nHtml } from "../i18n";
import { avatarUrl, getChannel, getMessage, messageEditedAt, referencedMessage, userDisplayName } from "../plugins/multiChatCanvas/discord";
import { safeMediaUrl } from "../plugins/multiChatCanvas/mediaDiscord";
import type {MessageLike} from "../plugins/multiChatCanvas/types";

/** Shared chat markup. Discord data is resolved by the owning renderer, never by a child window. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function escapeAttr(value: unknown): string {
  return escapeHtml(value);
}

export function messageTimestamp(
  value: MessageLike["timestamp"],
): Date | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value;
  }

  if (
    typeof value !== "string" &&
    typeof value !== "number"
  ) {
    return undefined;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? undefined
    : date;
}

export function prefers12HourClock(): boolean | undefined {
  const nativeTime =
    Array.from(
      document.querySelectorAll<HTMLTimeElement>(
        'main[class*="chatContent_"] time[id^="message-timestamp-"]',
      ),
    ).find(
      (element) =>
        !element.closest(
          "#Syncord-multichat-root",
        ),
    );

  const text =
    nativeTime
      ?.textContent
      ?.trim() ??
    "";

  if (
    /\b(?:AM|PM)\b/i.test(
      text,
    )
  ) {
    return true;
  }

  if (
    /^\d{1,2}:\d{2}$/.test(
      text,
    )
  ) {
    return false;
  }

  return undefined;
}

export function formatTime(
  value: MessageLike["timestamp"],
): string {
  const date =
    messageTimestamp(
      value,
    );

  if (!date) return "";

  const hour12 =
    prefers12HourClock();

  return date.toLocaleTimeString(
    getLocale(),
    {
      hour:
        "2-digit",

      minute:
        "2-digit",

      ...(hour12 === undefined
        ? {}
        : {
            hour12,
          }),
    },
  );
}

export function sameCalendarDay(
  a: MessageLike["timestamp"],
  b: MessageLike["timestamp"],
): boolean {
  const left =
    messageTimestamp(a);

  const right =
    messageTimestamp(b);

  if (!left || !right) {
    return false;
  }

  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

export function dateSeparatorHtml(
  value: MessageLike["timestamp"],
): string {
  const date =
    messageTimestamp(
      value,
    );

  if (!date) return "";

  const label =
    date.toLocaleDateString(
      getLocale(),
      {
        day:
          "2-digit",

        month:
          "long",

        year:
          "numeric",
      },
    );

  return `
    <div
      class="dion-mc-date-separator"
      data-mc-day="${date.getTime()}"
      role="separator"
      aria-label="${escapeAttr(label)}"
    >
      <span
        class="dion-mc-date-line"
        aria-hidden="true"
      ></span>

      <span class="dion-mc-date-label">
        ${escapeHtml(label)}
      </span>

      <span
        class="dion-mc-date-line"
        aria-hidden="true"
      ></span>
    </div>
  `;
}

export function shortPreview(value: string | undefined): string {
  return (value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 96);
}

export function replaceMentions(
  text: string,
  message: MessageLike,
): string {
  const channelId =
    message.channel_id ??
    message.channelId;

  const channel =
    getChannel(channelId);

  const guildId =
    channel?.guild_id ??
    channel?.guildId;

  return text
    .replace(
      /<@!?(\d+)>/g,
      (_match, id: string) => {
        const user =
          window.Syncord?.common?.stores.UserStore as
            | {
                getUser?: (
                  userId: string,
                ) => {
                  id: string;
                  username?: string;
                  globalName?: string | null;
                } | undefined;
              }
            | undefined;

        let resolved:
          | {
              id: string;
              username?: string;
              globalName?: string | null;
            }
          | undefined;

        try {
          resolved = user?.getUser?.(id);
        } catch {
          resolved = undefined;
        }

        return resolved
          ? `@${userDisplayName(resolved, guildId)}`
          : "@unknown";
      },
    )
    .replace(
      /<#(\d+)>/g,
      (_match, id: string) => {
        const target =
          getChannel(id);

        return target?.name
          ? `#${target.name}`
          : "#unknown-channel";
      },
    );
}

export function renderContent(
  message: MessageLike,
): string {
  const raw =
    message.content ??
    "";

  const channelId =
    message.channel_id ??
    message.channelId;

  const channel =
    getChannel(
      channelId,
    );

  const guildId =
    channel?.guild_id ??
    channel?.guildId;

  const placeholders:
    string[] = [];

  const reserve =
    (
      html:
        string,
    ): string => {
      const index =
        placeholders.push(
          html,
        ) - 1;

      return `\u0000DION${index}\u0000`;
    };

  let tokenized = raw.replace(/<(a?):([\w]+):(\d+)>/g, (_match, animated: string, name: string, id: string) =>
    reserve(`<img class="dion-mc-inline-emoji" src="https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "png"}?size=48" alt=":${escapeAttr(name)}:" title=":${escapeAttr(name)}:" loading="lazy" />`),
  ).replace(
      /<@!?(\d+)>/g,
      (
        _match,
        id:
          string,
      ) => {
        const store =
          window.Syncord
            ?.common
            ?.stores
            .UserStore as
            | {
                getUser?: (
                  userId:
                    string,
                ) => {
                  id: string;
                  username?: string;
                  globalName?: string | null;
                } | undefined;
              }
            | undefined;

        let user:
          | {
              id: string;
              username?: string;
              globalName?: string | null;
            }
          | undefined;

        try {
          user =
            store
              ?.getUser?.(
                id,
              );
        } catch {
          user =
            undefined;
        }

        const name =
          user
            ? userDisplayName(
                user,
                guildId,
              )
            : "unknown-user";

        return reserve(
          `<span class="dion-mc-mention">@${escapeHtml(name)}</span>`,
        );
      },
    )
    .replace(
      /<#(\d+)>/g,
      (
        _match,
        id:
          string,
      ) => {
        const target =
          getChannel(
            id,
          );

        const name =
          target?.name ??
          "unknown-channel";

        return reserve(
          `<span class="dion-mc-mention">#${escapeHtml(name)}</span>`,
        );
      },
    );

  let html =
    escapeHtml(
      tokenized,
    );

  html =
    html.replace(
      /`([^`\n]+)`/g,
      "<code>$1</code>",
    );

  html =
    html.replace(
      /(https?:\/\/[^\s<]+)/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>',
    );

  html =
    html.replace(
      /\u0000DION(\d+)\u0000/g,
      (
        _match,
        index:
          string,
      ) =>
        placeholders[
          Number(index)
        ] ??
        "",
    );

  return html;
}

export function initials(
  name: string,
): string {
  const chars =
    name
      .trim()
      .split(/\s+/)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();

  return chars || "?";
}

export function guildIdForMessage(
  message: MessageLike,
  channelId: string,
): string | undefined {
  return (
    message.guild_id ??
    getChannel(channelId)?.guild_id ??
    getChannel(channelId)?.guildId
  );
}

export function isCompactWith(
  previous: MessageLike | undefined,
  current: MessageLike,
): boolean {
  if (!previous?.author?.id || !current.author?.id) {
    return false;
  }

  if (
    previous.author.id !==
    current.author.id
  ) {
    return false;
  }

  const before =
    messageTimestamp(previous.timestamp);

  const now =
    messageTimestamp(current.timestamp);

  if (!before || !now) {
    return false;
  }

  if (
    !sameCalendarDay(
      previous.timestamp,
      current.timestamp,
    )
  ) {
    return false;
  }

  /*
   * Discord starts a fresh visual group for replies even when the author and
   * timestamp would otherwise qualify as compact continuation.
   */
  if (
    referencedMessage(
      current,
    )
  ) {
    return false;
  }

  return (
    now.getTime() -
      before.getTime() <
    5 * 60 * 1000
  );
}

export function replyPreviewHtml(
  message: MessageLike,
  channelId: string,
): string {
  const replied =
    referencedMessage(message);

  if (!replied) return "";

  const guildId =
    guildIdForMessage(
      replied,
      channelId,
    );

  const author =
    userDisplayName(
      replied.author,
      guildId,
    );

  const preview =
    shortPreview(
      replied.content,
    ) || i18nText("ui.attachment");

  return `
    <div class="dion-mc-reply-preview">
      <span class="dion-mc-reply-author">
        ${escapeHtml(author)}
      </span>

      <span class="dion-mc-reply-text">
        ${escapeHtml(preview)}
      </span>
    </div>
  `;
}

export function attachmentsHtml(
  message: MessageLike,
): string {
  const attachments =
    Array.isArray(message.attachments)
      ? message.attachments
      : [];

  if (!attachments.length) {
    return "";
  }

  const items =
    attachments
      .map((attachment) => {
        const url =
          attachment.proxy_url ??
          attachment.proxyURL ??
          attachment.url;

        if (!url) return "";

        const name =
          attachment.filename ??
          attachment.name ??
          i18nText("ui.attachment");

        const type =
          attachment.content_type ??
          attachment.contentType ??
          "";

        if (
          type.startsWith("image/") ||
          /\.(png|jpe?g|gif|webp|avif)$/i.test(name)
        ) {
          return `
            <a
              class="dion-mc-image"
              href="${escapeAttr(attachment.url ?? url)}"
              target="_blank"
              rel="noopener noreferrer"
            >
              <img
                src="${escapeAttr(url)}"
                alt="${escapeAttr(name)}"
                loading="lazy"
              />
            </a>
          `;
        }

        return `
          <a
            class="dion-mc-file"
            href="${escapeAttr(attachment.url ?? url)}"
            target="_blank"
            rel="noopener noreferrer"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="currentColor"
                d="M6 2h8l4 4v16H6V2Zm7 1.5V7h3.5L13 3.5ZM8 11v1.5h8V11H8Zm0 4v1.5h8V15H8Z"
              />
            </svg>

            <span>${escapeHtml(name)}</span>
          </a>
        `;
      })
      .filter(Boolean)
      .join("");

  return items
    ? `<div class="dion-mc-attachments">${items}</div>`
    : "";
}

export function embedsHtml(
  message: MessageLike,
): string {
  const embeds =
    Array.isArray(message.embeds)
      ? message.embeds
      : [];

  if (!embeds.length) return "";

  return embeds
    .slice(0, 2)
    .map((embed) => {
      const title =
        embed.title?.trim();

      const description =
        embed.description?.trim();

      const url =
        embed.url?.trim();

      const image =
        embed.image?.proxy_url ??
        embed.image?.proxyURL ??
        embed.image?.url ??
        embed.thumbnail?.proxy_url ??
        embed.thumbnail?.proxyURL ??
        embed.thumbnail?.url;

      const video = embed.type === "gifv" ? safeMediaUrl(embed.video?.proxy_url ?? embed.video?.proxyURL ?? embed.video?.url) : undefined;
      if (video) return `<video class="dion-mc-gif-video" src="${escapeAttr(video)}" ${window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "controls" : "autoplay"} muted loop playsinline preload="metadata" aria-label="${escapeAttr(title ?? "GIF")}"></video>`;

      if (
        !title &&
        !description &&
        !image
      ) {
        return "";
      }

      return `
        <div class="dion-mc-embed">
          ${
            title
              ? url
                ? `
                  <a
                    class="dion-mc-embed-title"
                    href="${escapeAttr(url)}"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    ${escapeHtml(title)}
                  </a>
                `
                : `
                  <div class="dion-mc-embed-title">
                    ${escapeHtml(title)}
                  </div>
                `
              : ""
          }

          ${
            description
              ? `
                <div>
                  ${escapeHtml(
                    description.slice(0, 420),
                  )}
                </div>
              `
              : ""
          }

          ${
            image
              ? `
                <a
                  class="dion-mc-image"
                  href="${escapeAttr(image)}"
                  target="_blank"
                  rel="noopener noreferrer"
                  style="margin-top:6px"
                >
                  <img
                    src="${escapeAttr(image)}"
                    alt=""
                    loading="lazy"
                  />
                </a>
              `
              : ""
          }
        </div>
      `;
    })
    .filter(Boolean)
    .join("");
}

export function messageHtml(
  message: MessageLike,
  previous: MessageLike | undefined,
  channelId: string,
): string {
  const guildId =
    guildIdForMessage(
      message,
      channelId,
    );

  const authorName =
    userDisplayName(
      message.author,
      guildId,
    );

  const avatar =
    avatarUrl(
      message.author,
    );

  const compact =
    isCompactWith(
      previous,
      message,
    );

  const edited =
    Boolean(
      messageEditedAt(
        message,
      ),
    );

  const content =
    renderContent(
      message,
    );

  const hasContent =
    Boolean(
      (message.content ?? "")
        .trim(),
    );

  const time =
    escapeHtml(
      formatTime(
        message.timestamp,
      ),
    );

  const avatarMarkup =
    avatar
      ? `
        <img
          aria-hidden="true"
          class="dion-mc-message-avatar"
          alt=" "
          src="${escapeAttr(avatar)}"
          data-mc-user-id="${escapeAttr(message.author?.id ?? "")}"
          loading="lazy"
          draggable="false"
        />
      `
      : `
        <span
          class="dion-mc-message-avatar dion-mc-avatar-fallback"
          data-mc-user-id="${escapeAttr(message.author?.id ?? "")}"
          aria-hidden="true"
        >
          ${escapeHtml(initials(authorName))}
        </span>
      `;

  const headerMarkup =
    compact
      ? `
        <time
          class="dion-mc-compact-time"
          data-mc-time="${messageTimestamp(message.timestamp)?.getTime()??''}"
          aria-hidden="true"
        >
          ${time}
        </time>
      `
      : `
        ${avatarMarkup}

        <h3 class="dion-mc-message-header">
          <button
            type="button"
            class="dion-mc-author"
            tabindex="${message.author?.id ? "0" : "-1"}"
            data-mc-user-id="${escapeAttr(message.author?.id ?? "")}"
          >
            ${escapeHtml(authorName)}
          </button>

          ${
            message.author?.bot
              ? `
                <span class="dion-mc-bot-badge">
                  ${i18nHtml("ui.app")}
                </span>
              `
              : ""
          }

          <time class="dion-mc-inline-time" data-mc-time="${messageTimestamp(message.timestamp)?.getTime()??''}">
            ${time}
          </time>
        </h3>
      `;

  // Do not add template whitespace inside pre-wrap: it becomes message lines.
  const contentMarkup = hasContent
    ? `<div class="dion-mc-content">${content}${edited ? `<span class="dion-mc-edited"> ${i18nHtml("ui.edited")}</span>` : ""}</div>`
    : "";

  const accessories =
    `${attachmentsHtml(message)}${embedsHtml(message)}${(message.stickerItems ?? message.sticker_items ?? message.stickers ?? []).map(sticker =>
      `<div class="dion-mc-message-sticker" data-mc-sticker-preview="${escapeAttr(sticker.id)}" data-sticker-name="${escapeAttr(sticker.name ?? "Sticker")}" data-sticker-format="${sticker.format_type ?? 1}"></div>`,
    ).join("")}`;

  return `
    <li
      class="dion-mc-message-list-item"
      data-mc-message-id="${escapeAttr(message.id)}"
      role="listitem"
    >
      <article
        class="dion-mc-message${compact ? " is-compact" : " is-group-start"}"
        data-mc-message-id="${escapeAttr(message.id)}"
      >
        ${headerMarkup}

        ${compact
            ? ""
            : replyPreviewHtml(
                message,
                channelId,
              )}

        ${contentMarkup}

        ${accessories
            ? `
              <div class="dion-mc-accessories">
                ${accessories}
              </div>
            `
            : ""}

        <div
          class="dion-mc-message-actions"
          role="group"
          aria-label="${h("ui.message_actions")}" data-si18n-aria-label="ui.message_actions"
        >
          <button
            type="button"
            class="dion-mc-message-action"
            data-mc-reply-message="${escapeAttr(message.id)}"
            aria-label="${h("ui.reply")}" data-si18n-aria-label="ui.reply"
          >
            <svg
              aria-hidden="true"
              role="img"
              width="20"
              height="20"
              viewBox="0 0 24 24"
            >
              <path
                fill="currentColor"
                d="M10 7V3l-7 7 7 7v-4c5 0 8.5 1.5 11 5-1-5-4-10-11-11Z"
              />
            </svg>
          </button>
        </div>
      </article>
    </li>
  `;
}

