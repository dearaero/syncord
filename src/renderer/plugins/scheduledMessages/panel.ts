import { h, messageHtml as i18nHtml, t as i18nText } from "../../i18n";
import { resolveTarget } from "./discord";
import { activeStore } from "./store";
import {
  MAX_CONTENT_LENGTH,
  type ScheduledMessage,
  type ScheduledStatus,
} from "./types";
import { formatCountdown, formatWhen, toDateInputValue, toTimeInputValue } from "./time";

/**
 * The "Scheduled Messages" section inside the settings panel.
 *
 * It is rendered as HTML and wired by event delegation, like every other panel
 * section, and it reads its data through `activeStore()` so it shows nothing at
 * all while the plugin is stopped.
 *
 * The countdown is the one thing that has to keep moving on its own; everything
 * else redraws when the store announces a change. That is why the interval below
 * touches only the countdown spans instead of re-rendering the list, which
 * would fight the user's focus and scroll position.
 */

export const SCHEDULED_PLUGIN_ID = "scheduled-messages";

/** Set by the panel so this module can ask whether the section is open. */
let expanded = false;

export function isScheduledExpanded(): boolean {
  return expanded;
}

export function setScheduledExpanded(value: boolean): void {
  expanded = value;
}

const PREVIEW_LIMIT = 140;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STATUS_LABEL: Record<ScheduledStatus, string> = {
  get pending(){return i18nText("ui.pending");},
  get sent(){return i18nText("ui.sent");},
  get failed(){return i18nText("ui.failed");},
  get cancelled(){return i18nText("ui.cancelled_d353a99");},
};

/** Reuse the panel's own pill vocabulary, which is already themed. */
const STATUS_PILL: Record<ScheduledStatus, string> = {
  pending: "is-idle",
  sent: "is-on",
  failed: "is-off",
  cancelled: "is-off",
};

function preview(content: string): string {
  const flat = content.replace(/\s+/gu, " ").trim();
  return flat.length > PREVIEW_LIMIT
    ? `${flat.slice(0, PREVIEW_LIMIT)}…`
    : flat;
}

function channelLine(message: ScheduledMessage): string {
  const target = resolveNames(message);
  return `${target.channel} · ${target.scope}`;
}

/**
 * Names for display, resolved through the same bridge the sender uses.
 *
 * A channel the user has since left is still in Discord's store, so this keeps
 * working; when it really is gone the id is shown rather than an empty row.
 */
function resolveNames(message: ScheduledMessage): { channel: string; scope: string } {
  const target = resolveTarget(message.channelId);
  if (!target) return { channel: message.channelId, scope: i18nText("ui.unavailable") };
  return {
    channel: target.isDm ? target.channelName : `#${target.channelName}`,
    scope: target.scopeName,
  };
}

function cardHtml(message: ScheduledMessage, now: number): string {
  const isPending = message.status === "pending";
  const isDue = isPending && message.sendAt <= now;
  const names = channelLine(message);

  const when = isPending
    ? `${formatWhen(message.sendAt, now)} · ${formatCountdown(message.sendAt, now)}`
    : message.status === "sent" && message.sentAt
      ? i18nText("ui.sent_value", {v0: formatWhen(message.sentAt, now)})
      : i18nText("ui.scheduled_for_value_0959af1", {v0: formatWhen(message.sendAt, now)});

  return `
    <article class="dion-sm-card${isDue ? " is-due" : ""}" data-dion-sm-card="${escapeHtml(message.id)}">
      <header class="dion-sm-head">
        <span class="dion-pill ${STATUS_PILL[message.status]}">${STATUS_LABEL[message.status]}</span>
        <span class="dion-sm-where" title="${escapeHtml(names)}">${escapeHtml(names)}</span>
        <span class="dion-sm-when" data-dion-sm-when="${message.sendAt}">${escapeHtml(when)}</span>
      </header>

      <p class="dion-sm-body" data-dion-sm-body title="${escapeHtml(message.content)}">${escapeHtml(preview(message.content))}</p>
      <textarea
        class="dion-sm-editor"
        data-dion-sm-editor
        rows="3"
        maxlength="${MAX_CONTENT_LENGTH}"
        aria-label="${h("ui.message_text")}"
        hidden data-si18n-aria-label="ui.message_text"
      >${escapeHtml(message.content)}</textarea>

      ${message.lastError
          ? `<p class="dion-sm-error" role="alert">${escapeHtml(message.lastError)}</p>`
          : ""}

      ${isPending
          ? `<div class="dion-sm-when-edit" hidden>
               <input type="date" data-dion-sm-date value="${toDateInputValue(message.sendAt)}" aria-label="${h("ui.date")}" data-si18n-aria-label="ui.date" />
               <input type="time" data-dion-sm-time value="${toTimeInputValue(message.sendAt)}" aria-label="${h("ui.time")}" data-si18n-aria-label="ui.time" />
             </div>`
          : ""}

      <footer class="dion-sm-actions">
        ${isPending
            ? `<button type="button" class="dion-sm-btn" data-dion-sm-action="edit">${i18nHtml("ui.edit")}</button>
               <button type="button" class="dion-sm-btn" data-dion-sm-action="time">${i18nHtml("ui.change_time")}</button>
               <button type="button" class="dion-sm-btn is-primary" data-dion-sm-action="send">${i18nHtml("ui.send_now")}</button>
               <button type="button" class="dion-sm-btn" data-dion-sm-action="cancel">${i18nHtml("ui.cancel")}</button>`
            : message.status === "failed"
              ? `<button type="button" class="dion-sm-btn is-primary" data-dion-sm-action="retry">${i18nHtml("ui.retry")}</button>`
              : ""}
        <button type="button" class="dion-sm-btn is-danger" data-dion-sm-action="delete">${i18nHtml("ui.delete")}</button>
        <button type="button" class="dion-sm-btn dion-sm-save" data-dion-sm-action="save" hidden>${i18nHtml("ui.save")}</button>
        <button type="button" class="dion-sm-btn" data-dion-sm-action="revert" hidden>${i18nHtml("ui.revert")}</button>
      </footer>
    </article>`;
}

function sectionInnerHtml(messages: readonly ScheduledMessage[], now: number): string {
  if (!messages.length) {
    return `
      <div class="dion-sm-empty">
        <p class="dion-sm-empty-title">${i18nHtml("ui.nothing_scheduled")}</p>
        <p class="dion-sm-empty-hint">
          ${i18nHtml("ui.write_a_message_then_use_the_clock_button_next_to_the_send_button_to_s")}
        </p>
      </div>`;
  }

  const pending = messages.filter((m) => m.status === "pending");
  const done = messages.filter((m) => m.status !== "pending");

  const group = (title: string, rows: readonly ScheduledMessage[]): string =>
    rows.length
      ? `<div class="dion-sm-group">
           <h5 class="dion-sm-group-title">${title}<span class="dion-sm-count">${rows.length}</span></h5>
           ${rows.map((m) => cardHtml(m, now)).join("")}
         </div>`
      : "";

  return (
    group(i18nText("ui.waiting"), pending) +
    (done.length
      ? `<details class="dion-sm-history">
           <summary>${i18nHtml("ui.history")}<span class="dion-sm-count">${done.length}</span></summary>
           ${group(i18nText("ui.sent_failed_and_cancelled"), done)}
         </details>`
      : "")
  );
}

/** The plugin's details block, dropped into the panel's plugin row. */
export function scheduledSectionHtml(): string {
  // Undefined while the plugin is stopped, which is what makes this section
  // render as empty rather than as a stale list.
  const messages = activeStore()?.all() ?? [];
  const now = Date.now();

  return `
    <div class="dion-plugin-details dion-sm-root">
      <div class="dion-details-head">
        <div>
          <span class="dion-eyebrow">${i18nHtml("ui.scheduled_messages")}</span>
          <h4>${i18nHtml("ui.your_queue")}</h4>
        </div>
        <span class="dion-details-note">${i18nHtml("ui.sent_while_discord_is_open")}</span>
      </div>
      <div class="dion-settings-group dion-sm-list" data-dion-sm-list>
        ${sectionInnerHtml(messages, now)}
      </div>
    </div>`;
}

export function scheduledExpandButtonHtml(): string {
  return `
    <button
      type="button"
      class="dion-icon-btn dion-expand"
      data-dion-sm-expand
      aria-expanded="${expanded ? "true" : "false"}"
      aria-label="${h("ui.scheduled_messages")}" data-si18n-aria-label="ui.scheduled_messages"
    >
      <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="m7.41 8.59 4.59 4.58 4.59-4.58L18 10l-6 6-6-6 1.41-1.41Z"/>
      </svg>
    </button>`;
}

export type ActionHandler = (action: string, message: ScheduledMessage, card: HTMLElement) => void;

let onAction: ActionHandler | undefined;

export function setActionHandler(handler: ActionHandler | undefined): void {
  onAction = handler;
}

export function scheduledActionHandler(): ActionHandler | undefined {
  return onAction;
}

/**
 * True while a card has an open editor or time form.
 *
 * The settings panel redraws on every store change, and doing that mid-edit
 * would throw away whatever was being typed. The panel asks this first and
 * postpones the redraw instead.
 */
export function isEditing(root: ParentNode): boolean {
  return (
    root.querySelector("[data-dion-sm-editor]:not([hidden])") !== null ||
    root.querySelector(".dion-sm-when-edit:not([hidden])") !== null
  );
}

/**
 * Refresh only the countdowns.
 *
 * A full re-render every 30 seconds would fight focus and scroll; the relative
 * time is the only part that goes stale on its own.
 */
export function refreshCountdowns(root: ParentNode, now: number): void {
  for (const node of root.querySelectorAll<HTMLElement>("[data-dion-sm-when]")) {
    const sendAt = Number(node.getAttribute("data-dion-sm-when"));
    if (!Number.isFinite(sendAt)) continue;
    node.textContent = `${formatWhen(sendAt, now)} · ${formatCountdown(sendAt, now)}`;
  }
}

export { sectionInnerHtml, cardHtml, PREVIEW_LIMIT };
