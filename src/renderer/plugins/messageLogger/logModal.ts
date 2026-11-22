import { setLocalizedText, getLocale, h, messageHtml as i18nHtml, setLocalizedHtml, t as i18nText } from "../../i18n";
import { mountWindowedList } from "../../ui/windowedList";
import { hideTooltip } from "../../ui/tooltip";
import { attachmentUrl, readAttachmentBlob, readSavedFile } from "./files";
import { closeImagePreview, isImageFile, openImagePreview } from "./imagePreview";
import { showToast, ToastType } from "../../ui/toast";
import { listLog, loadLog, onLogReset, whenLogReady, type LogEntry, type LogFile } from "./log";

const ROOT_ID = "Syncord-log-root";
const STYLE_ID = "Syncord-log-css";

let root: HTMLDivElement | undefined;
let urls: string[] = [];
let onKey: ((event: KeyboardEvent) => void) | undefined;
let fileRequest = 0;
let disposeRows: (()=>void)|undefined;

onLogReset(() => {
  fileRequest++;
  closeImagePreview();
  if (root?.isConnected) paint();
});

export function openMessageLog(): void {
  hideTooltip();
  loadLog();
  ensureStyle();

  if (!root?.isConnected) mount();

  paint();

  void whenLogReady().then(() => {
    if (root?.isConnected) paint();
  });

  root?.querySelector<HTMLButtonElement>("[data-dion-log-close]")?.focus();
}

function mount(): void {
  closeMessageLog();

  root = document.createElement("div");
  root.id = ROOT_ID;
  setLocalizedHtml(root, `
    <div class="dion-log-backdrop" data-dion-log-close></div>

    <section
      class="dion-log-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dion-log-title"
    >
      <header class="dion-log-header">
        <div class="dion-log-heading">
          <div class="dion-log-heading-icon" aria-hidden="true">
            <svg width="19" height="19" viewBox="0 0 24 24">
              <path fill="currentColor" d="M6 2h9l5 5v15a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm8 1.5V8h4.5L14 3.5ZM8 12h8v1.5H8V12Zm0 4h8v1.5H8V16Z"/>
            </svg>
          </div>

          <div class="dion-log-heading-copy">
            <span class="dion-log-eyebrow">${i18nHtml("ui.message_logger")}</span>
            <h2 class="dion-log-title" id="dion-log-title">${i18nHtml("ui.message_log")}</h2>
            <p>${i18nHtml("ui.review_locally_saved_messages_edits_deletes_and_attachments")}</p>
          </div>
        </div>

        <div class="dion-log-head-actions">
          <span class="dion-log-count" data-dion-log-count aria-live="polite"></span>

          <button
            type="button"
            class="dion-log-x"
            data-dion-log-close
            aria-label="${h("ui.close_message_log")}" data-si18n-aria-label="ui.close_message_log"
          >
            <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="m7.05 5.64 4.95 4.95 4.95-4.95 1.41 1.41L13.41 12l4.95 4.95-1.41 1.41L12 13.41l-4.95 4.95-1.41-1.41L10.59 12 5.64 7.05l1.41-1.41Z"/>
            </svg>
          </button>
        </div>
      </header>

      <div class="dion-log-divider"></div>

      <div class="dion-log-scroll">
        <section class="dion-log-section-head">
          <div>
            <h3>${i18nHtml("ui.saved_messages")}</h3>
            <p>${i18nHtml("ui.newest_captured_messages_appear_in_the_logger_list_below")}</p>
          </div>

          <span class="dion-log-local-badge">${i18nHtml("ui.local")}</span>
        </section>

        <div class="dion-log-surface">
          <div class="dion-log-list" data-dion-log-list></div>
        </div>
      </div>
    </section>`);

  root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    if (target.closest("[data-dion-log-close]")) {
      event.preventDefault();
      closeMessageLog();
    }
  });

  onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;

    event.preventDefault();
    event.stopPropagation();
    if (!closeImagePreview()) closeMessageLog();
  };

  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(root);
}

function closeMessageLog(): void {
  disposeRows?.();disposeRows=undefined;
  fileRequest++;
  closeImagePreview();
  if (onKey) document.removeEventListener("keydown", onKey, true);
  onKey = undefined;

  root?.remove();
  root = undefined;

  for (const url of urls) URL.revokeObjectURL(url);
  urls = [];
}

function paint(): void {
  const list = root?.querySelector<HTMLElement>("[data-dion-log-list]");
  const count = root?.querySelector<HTMLElement>("[data-dion-log-count]");
  if (!list) return;

  const rows = listLog();

  if (count) {
    setLocalizedText(count,"count.messages",{count:rows.length});
  }

  disposeRows?.();disposeRows=undefined;
  list.replaceChildren();

  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "dion-log-empty";
    setLocalizedHtml(empty, `
      <div class="dion-log-empty-icon" aria-hidden="true">
        <svg width="24" height="24" viewBox="0 0 24 24">
          <path fill="currentColor" d="M6 2h9l5 5v15a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm8 1.5V8h4.5L14 3.5ZM8 12h8v1.5H8V12Zm0 4h6v1.5H8V16Z"/>
        </svg>
      </div>
      <strong>${i18nHtml("ui.no_logged_messages")}</strong>
      <span>${i18nHtml("ui.captured_edits_and_deleted_messages_will_appear_here")}</span>`);
    list.appendChild(empty);
    return;
  }

  const scroller=root?.querySelector<HTMLElement>(".dion-log-scroll");
  if(scroller)disposeRows=mountWindowedList(list,scroller,rows,rowView);
}

function rowView(row: LogEntry): HTMLElement {
  const item = document.createElement("article");
  item.className = "dion-log-row";

  const avatar = document.createElement("div");
  avatar.className = "dion-log-avatar";
  avatar.setAttribute("aria-hidden", "true");

  const initial = document.createElement("span");
  initial.textContent = authorInitial(row.author);
  avatar.appendChild(initial);
  item.appendChild(avatar);

  const body = document.createElement("div");
  body.className = "dion-log-row-body";

  const top = document.createElement("div");
  top.className = "dion-log-top";

  const identity = document.createElement("div");
  identity.className = "dion-log-identity";

  const author = document.createElement("span");
  author.className = "dion-log-author";
  author.textContent = row.author || i18nText("ui.unknown");
  identity.appendChild(author);

  const meta = document.createElement("div");
  meta.className = "dion-log-meta";

  const channel = document.createElement("span");
  channel.className = "dion-log-channel";
  channel.textContent = channelLabel(row.channelId);
  meta.appendChild(channel);

  const separator = document.createElement("span");
  separator.className = "dion-log-dot";
  separator.textContent = "•";
  meta.appendChild(separator);

  const time = document.createElement("time");
  time.className = "dion-log-time";
  const date = new Date(row.timestamp);
  if (!Number.isNaN(date.getTime())) time.dateTime = date.toISOString();
  time.textContent = formatTime(row.timestamp);
  meta.appendChild(time);

  identity.appendChild(meta);
  top.appendChild(identity);

  const badges = document.createElement("div");
  badges.className = "dion-log-badges";

  if (row.deleted) badges.appendChild(badge(i18nText("ui.deleted"), "is-deleted"));
  if (row.edits?.length) badges.appendChild(badge(i18nText("ui.edited_7117f08"), "is-edited"));

  if (badges.childElementCount) top.appendChild(badges);

  body.appendChild(top);

  const content = document.createElement("div");
  content.className = "dion-log-content";
  content.textContent = row.content || "(empty)";
  body.appendChild(content);

  if (row.attachments?.length) body.appendChild(filesView(row));

  item.appendChild(body);
  return item;
}

function filesView(row: LogEntry): HTMLElement {
  const box = document.createElement("div");
  box.className = "dion-log-files";

  row.attachments?.forEach((file, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dion-log-file";
    button.title = file.name || "file";

    const icon = document.createElement("span");
    icon.className = "dion-log-file-icon";
    setLocalizedHtml(icon, `
      <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M16.5 6.5v10a4.5 4.5 0 0 1-9 0V5a3 3 0 0 1 6 0v10.5a1.5 1.5 0 0 1-3 0V6H12v9.5a.5.5 0 0 0 1 0V5a2 2 0 0 0-4 0v11.5a3 3 0 0 0 6 0v-10h1.5Z"/>
      </svg>`);

    const label = document.createElement("span");
    label.className = "dion-log-file-name";
    label.textContent = file.name || "file";

    button.append(icon, label);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void openFile(row.id, index, file);
    });

    box.appendChild(button);
  });

  return box;
}

async function openFile(messageId: string, index: number, file: LogFile): Promise<void> {
  const request = ++fileRequest;
  const owner = root;
  if (!owner?.isConnected) return;
  try {
    const saved = await readSavedFile(messageId, index);
    if (request !== fileRequest || root !== owner || !owner.isConnected) return;
    const name = saved?.name || file.name || "file";
    const url = attachmentUrl(file.url);
    if (isImageFile(name, saved?.type || saved?.blob.type) || (url && isImageFile(new URL(url).pathname))) {
      if (!saved?.blob && !url) throw new Error("Image unavailable");
      openImagePreview(owner, {
        name,
        blob: saved?.blob,
        url,
        readBlob: signal => readAttachmentBlob(url ?? "", signal),
      });
      return;
    }
    const anchor = document.createElement("a");
    if (saved?.blob) {
      const localUrl = URL.createObjectURL(saved.blob);
      urls.push(localUrl);
      anchor.href = localUrl;
      anchor.download = name;
    } else if (url) {
      anchor.href = url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
    } else {
      throw new Error("File unavailable");
    }
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } catch {
    if (request === fileRequest && owner.isConnected) {
      showToast(i18nText("ui.this_logged_file_is_unavailable_its_original_discord_link_may_have_exp"), { type: ToastType.FAILURE });
    }
  }
}

function badge(text: string, kind: string): HTMLElement {
  const node = document.createElement("span");
  node.className = `dion-log-badge ${kind}`;
  node.textContent = text;
  return node;
}

function authorInitial(author: string | undefined): string {
  const value = author?.trim();
  if (!value) return "?";
  return value.slice(0, 1).toUpperCase();
}

function channelLabel(channelId: string): string {
  const store = window.Syncord?.common?.stores.ChannelStore as
    | { getChannel?: (id: string) => { name?: string } | undefined }
    | undefined;

  try {
    const name = store?.getChannel?.(channelId)?.name;
    if (typeof name === "string" && name.trim()) return `#${name}`;
  } catch {
    /* store shape */
  }

  return channelId;
}

function formatTime(stamp: number): string {
  try {
    return new Date(stamp).toLocaleString(getLocale());
  } catch {
    return "";
  }
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${ROOT_ID} {
      --dlog-bg: var(--background-base-low, var(--background-primary, #1a1a1e));
      --dlog-bg-low: var(--background-base-lower, var(--background-secondary, #151518));
      --dlog-bg-high: var(--background-base-high, #242429);
      --dlog-surface: color-mix(in srgb, var(--background-base-high, #242429) 82%, transparent);
      --dlog-surface-hover: color-mix(in srgb, var(--background-modifier-hover, #34343a) 78%, transparent);
      --dlog-border: color-mix(in srgb, var(--border-subtle, #ffffff) 9%, transparent);
      --dlog-border-strong: color-mix(in srgb, var(--border-strong, #ffffff) 16%, transparent);
      --dlog-text: var(--text-default, var(--text-normal, #f2f3f5));
      --dlog-muted: var(--text-muted, #a6a6ad);
      --dlog-brand: var(--brand-500, #5865f2);

      position: fixed;
      inset: 0;
      z-index: 100002;
      display: grid;
      place-items: center;
      padding: 22px;
      box-sizing: border-box;
      color: var(--dlog-text);
      font-family: "gg sans", "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
      isolation: isolate;
    }

    #${ROOT_ID} *,
    #${ROOT_ID} *::before,
    #${ROOT_ID} *::after {
      box-sizing: border-box;
    }

    #${ROOT_ID} button {
      font: inherit;
    }

    #${ROOT_ID} .dion-log-backdrop {
      position: absolute;
      inset: 0;
      z-index: -1;
      background:
        radial-gradient(circle at 50% 38%, rgba(88, 101, 242, 0.08), transparent 34%),
        rgba(0, 0, 0, 0.72);
      backdrop-filter: blur(7px) saturate(0.9);
      animation: dion-log-backdrop-in 150ms ease-out;
    }

    #${ROOT_ID} .dion-log-panel {
      width: min(860px, 100%);
      height: min(760px, calc(100dvh - 44px));
      min-height: 520px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid var(--dlog-border-strong);
      border-radius: 22px;
      background:
        radial-gradient(circle at 92% -8%, rgba(88,101,242,.055), transparent 27%),
        var(--dlog-bg);
      box-shadow:
        0 30px 80px rgba(0, 0, 0, 0.52),
        0 10px 30px rgba(0, 0, 0, 0.24),
        inset 0 1px 0 rgba(255,255,255,.025);
      animation: dion-log-panel-in 180ms cubic-bezier(.2,.8,.2,1);
    }

    #${ROOT_ID} .dion-log-header {
      min-height: 102px;
      flex-shrink: 0;
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 22px;
      padding: 20px 24px 17px;
    }

    #${ROOT_ID} .dion-log-heading {
      min-width: 0;
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }

    #${ROOT_ID} .dion-log-heading-icon {
      width: 40px;
      height: 40px;
      flex: 0 0 40px;
      display: grid;
      place-items: center;
      border: 1px solid var(--dlog-border);
      border-radius: 12px;
      color: color-mix(in srgb, var(--dlog-brand) 82%, white 18%);
      background: color-mix(in srgb, var(--dlog-brand) 13%, var(--dlog-bg-high));
      box-shadow: inset 0 1px 0 rgba(255,255,255,.04);
    }

    #${ROOT_ID} .dion-log-heading-copy {
      min-width: 0;
    }

    #${ROOT_ID} .dion-log-eyebrow {
      display: inline-block;
      color: color-mix(in srgb, var(--dlog-brand) 78%, white 22%);
      font-size: 10px;
      font-weight: 700;
      line-height: 14px;
      letter-spacing: .045em;
      text-transform: uppercase;
    }

    #${ROOT_ID} .dion-log-title {
      margin: 2px 0 0;
      color: var(--dlog-text);
      font-size: 22px;
      font-weight: 680;
      line-height: 28px;
      letter-spacing: -.025em;
    }

    #${ROOT_ID} .dion-log-heading-copy p {
      margin: 3px 0 0;
      color: var(--dlog-muted);
      font-size: 13px;
      line-height: 18px;
    }

    #${ROOT_ID} .dion-log-head-actions {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    #${ROOT_ID} .dion-log-count,
    #${ROOT_ID} .dion-log-local-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 24px;
      padding: 2px 8px;
      border: 1px solid var(--dlog-border);
      border-radius: 999px;
      background: rgba(255,255,255,.025);
      color: var(--dlog-muted);
      font-size: 10px;
      font-weight: 600;
      line-height: 15px;
      white-space: nowrap;
    }

    #${ROOT_ID} .dion-log-x {
      width: 34px;
      height: 34px;
      flex: 0 0 34px;
      display: grid;
      place-items: center;
      padding: 0;
      border: 1px solid var(--dlog-border);
      border-radius: 11px;
      background: rgba(255,255,255,.025);
      color: var(--dlog-muted);
      cursor: pointer;
      transition: color 120ms ease, border-color 120ms ease, background-color 120ms ease, transform 120ms ease;
    }

    #${ROOT_ID} .dion-log-x:hover {
      border-color: var(--dlog-border-strong);
      background: rgba(255,255,255,.06);
      color: var(--dlog-text);
    }

    #${ROOT_ID} .dion-log-x:active {
      transform: scale(.96);
    }

    #${ROOT_ID} .dion-log-x:focus-visible,
    #${ROOT_ID} .dion-log-file:focus-visible {
      outline: 2px solid color-mix(in srgb, var(--dlog-brand) 75%, white 10%);
      outline-offset: 2px;
    }

    #${ROOT_ID} .dion-log-divider {
      height: 1px;
      flex-shrink: 0;
      margin: 0 24px;
      background: var(--dlog-border);
    }

    #${ROOT_ID} .dion-log-scroll {
      min-height: 0;
      flex: 1;
      overflow-x: hidden;
      overflow-y: auto;
      padding: 20px 24px 26px;
      overscroll-behavior: contain;
      scrollbar-gutter: stable;
    }

    #${ROOT_ID} .dion-log-scroll::-webkit-scrollbar {
      width: 10px;
    }

    #${ROOT_ID} .dion-log-scroll::-webkit-scrollbar-track {
      background: transparent;
    }

    #${ROOT_ID} .dion-log-scroll::-webkit-scrollbar-thumb {
      min-height: 44px;
      border: 3px solid transparent;
      border-radius: 999px;
      background: color-mix(in srgb, var(--dlog-muted) 42%, transparent);
      background-clip: padding-box;
    }

    #${ROOT_ID} .dion-log-section-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 10px;
      padding: 0 2px;
    }

    #${ROOT_ID} .dion-log-section-head h3 {
      margin: 0;
      color: var(--dlog-text);
      font-size: 14px;
      font-weight: 620;
      line-height: 19px;
    }

    #${ROOT_ID} .dion-log-section-head p {
      margin: 2px 0 0;
      color: var(--dlog-muted);
      font-size: 12px;
      line-height: 17px;
    }

    #${ROOT_ID} .dion-log-surface {
      overflow: hidden;
      border: 1px solid var(--dlog-border);
      border-radius: 15px;
      background:
        linear-gradient(180deg, rgba(255,255,255,.018), transparent 70%),
        var(--dlog-surface);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.018);
    }

    #${ROOT_ID} .dion-log-list {
      min-height: 180px;
    }

    #${ROOT_ID} .dion-log-row {
      position: relative;
      display: flex;
      align-items: flex-start;
      gap: 11px;
      padding: 13px 14px;
      border-bottom: 1px solid var(--dlog-border);
      transition: background-color 120ms ease;
    }

    #${ROOT_ID} .dion-log-row:last-child {
      border-bottom: 0;
    }

    #${ROOT_ID} .dion-log-row:hover {
      background: var(--dlog-surface-hover);
    }

    #${ROOT_ID} .dion-log-avatar {
      width: 38px;
      height: 38px;
      flex: 0 0 38px;
      display: grid;
      place-items: center;
      overflow: hidden;
      border: 1px solid var(--dlog-border);
      border-radius: 12px;
      background:
        linear-gradient(145deg, rgba(255,255,255,.035), transparent),
        color-mix(in srgb, var(--dlog-brand) 12%, var(--dlog-bg-high));
      color: color-mix(in srgb, var(--dlog-brand) 70%, white 30%);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.035);
      user-select: none;
    }

    #${ROOT_ID} .dion-log-avatar span {
      font-size: 14px;
      font-weight: 700;
      line-height: 1;
      text-transform: uppercase;
    }

    #${ROOT_ID} .dion-log-row-body {
      min-width: 0;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding-top: 1px;
    }

    #${ROOT_ID} .dion-log-top {
      min-width: 0;
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }

    #${ROOT_ID} .dion-log-identity {
      min-width: 0;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    #${ROOT_ID} .dion-log-author {
      min-width: 0;
      overflow: hidden;
      color: var(--dlog-text);
      font-size: 14px;
      font-weight: 610;
      line-height: 18px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #${ROOT_ID} .dion-log-meta {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 5px;
      overflow: hidden;
      color: color-mix(in srgb, var(--dlog-muted) 78%, transparent);
      font-size: 10px;
      line-height: 14px;
    }

    #${ROOT_ID} .dion-log-channel {
      min-width: 0;
      max-width: 42ch;
      overflow: hidden;
      color: color-mix(in srgb, var(--dlog-muted) 92%, transparent);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #${ROOT_ID} .dion-log-dot {
      flex: 0 0 auto;
      opacity: .6;
    }

    #${ROOT_ID} .dion-log-time {
      flex: 0 0 auto;
      color: inherit;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    #${ROOT_ID} .dion-log-badges {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 5px;
      padding-top: 1px;
    }

    #${ROOT_ID} .dion-log-badge {
      min-height: 19px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 1px 7px;
      border: 1px solid transparent;
      border-radius: 999px;
      font-size: 9px;
      font-weight: 700;
      line-height: 15px;
      white-space: nowrap;
    }

    #${ROOT_ID} .dion-log-badge.is-deleted {
      border-color: color-mix(in srgb, var(--status-danger, #f23f43) 19%, transparent);
      color: var(--status-danger, #f23f43);
      background: color-mix(in srgb, var(--status-danger, #f23f43) 11%, transparent);
    }

    #${ROOT_ID} .dion-log-badge.is-edited {
      border-color: color-mix(in srgb, var(--text-link, #00a8fc) 18%, transparent);
      color: var(--text-link, #00a8fc);
      background: color-mix(in srgb, var(--text-link, #00a8fc) 10%, transparent);
    }

    #${ROOT_ID} .dion-log-content {
      max-width: 100%;
      color: color-mix(in srgb, var(--dlog-text) 90%, var(--dlog-muted));
      font-size: 13px;
      line-height: 19px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    #${ROOT_ID} .dion-log-files {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      padding-top: 2px;
    }

    #${ROOT_ID} .dion-log-file {
      min-width: 0;
      max-width: min(320px, 100%);
      height: 30px;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 0 9px 0 7px;
      border: 1px solid var(--dlog-border);
      border-radius: 9px;
      background: rgba(255,255,255,.035);
      color: var(--dlog-muted);
      cursor: pointer;
      transition: color 120ms ease, border-color 120ms ease, background-color 120ms ease, transform 120ms ease;
    }

    #${ROOT_ID} .dion-log-file:hover {
      border-color: var(--dlog-border-strong);
      background: rgba(255,255,255,.065);
      color: var(--dlog-text);
    }

    #${ROOT_ID} .dion-log-file:active {
      transform: scale(.98);
    }

    #${ROOT_ID} .dion-log-file-icon {
      width: 20px;
      height: 20px;
      flex: 0 0 20px;
      display: grid;
      place-items: center;
      border-radius: 6px;
      background: color-mix(in srgb, var(--dlog-brand) 12%, transparent);
      color: color-mix(in srgb, var(--dlog-brand) 76%, white 24%);
    }

    #${ROOT_ID} .dion-log-file-name {
      min-width: 0;
      overflow: hidden;
      font-size: 11px;
      font-weight: 570;
      line-height: 15px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #${ROOT_ID} .dion-log-empty {
      min-height: 310px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px 24px;
      text-align: center;
    }

    #${ROOT_ID} .dion-log-empty-icon {
      width: 52px;
      height: 52px;
      display: grid;
      place-items: center;
      margin-bottom: 12px;
      border: 1px solid var(--dlog-border);
      border-radius: 16px;
      background: color-mix(in srgb, var(--dlog-brand) 10%, var(--dlog-bg-high));
      color: color-mix(in srgb, var(--dlog-brand) 68%, white 32%);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.04);
    }

    #${ROOT_ID} .dion-log-empty strong {
      color: var(--dlog-text);
      font-size: 14px;
      font-weight: 620;
      line-height: 19px;
    }

    #${ROOT_ID} .dion-log-empty span {
      max-width: 340px;
      margin-top: 4px;
      color: var(--dlog-muted);
      font-size: 12px;
      line-height: 17px;
    }

    #${ROOT_ID} .dion-log-preview {
      width: min(1000px, calc(100vw - 32px));
      max-width: none;
      max-height: calc(100dvh - 32px);
      margin: auto;
      padding: 16px;
      overflow: auto;
      border: 1px solid var(--dlog-border-strong);
      border-radius: 16px;
      background: var(--dlog-bg);
      color: var(--dlog-text);
      box-shadow: 0 24px 80px rgba(0,0,0,.5);
    }
    #${ROOT_ID} .dion-log-preview::backdrop {
      background: rgba(0,0,0,.85);
    }
    #${ROOT_ID} .dion-log-preview-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;
    }
    #${ROOT_ID} .dion-log-preview-head h3 {
      min-width: 0;
      margin: 0;
      font-size: 14px;
      overflow-wrap: anywhere;
    }
    #${ROOT_ID} .dion-log-preview-actions {
      display: flex;
      flex-shrink: 0;
      align-items: center;
      gap: 8px;
    }
    #${ROOT_ID} .dion-log-download {
      min-height: 34px;
      padding: 6px 12px;
      border: 0;
      border-radius: 9px;
      background: var(--dlog-brand);
      color: #fff;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    #${ROOT_ID} .dion-log-download:disabled { opacity: .6; cursor: wait; }
    #${ROOT_ID} .dion-log-download:focus-visible {
      outline: 2px solid var(--dlog-text);
      outline-offset: 2px;
    }
    #${ROOT_ID} .dion-log-preview-media {
      display: grid;
      place-items: center;
      min-height: 120px;
      background: var(--dlog-bg-low);
      border-radius: 10px;
      overflow: hidden;
    }
    #${ROOT_ID} .dion-log-preview-media img {
      display: block;
      max-width: 100%;
      max-height: max(120px, calc(100dvh - 180px));
      object-fit: contain;
    }
    #${ROOT_ID} .dion-log-preview-status {
      margin: 10px 0 0;
      color: var(--dlog-muted);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    #${ROOT_ID} .dion-log-preview-status:empty { display: none; }
    @media (max-width: 430px) {
      #${ROOT_ID} .dion-log-preview { padding: 12px; }
      #${ROOT_ID} .dion-log-preview-head { flex-wrap: wrap; }
      #${ROOT_ID} .dion-log-preview-head h3 { flex: 1 1 100%; }
      #${ROOT_ID} .dion-log-preview-actions { margin-left: auto; }
      #${ROOT_ID} .dion-log-preview-media img { max-height: max(120px, calc(100dvh - 220px)); }
    }

    @keyframes dion-log-backdrop-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes dion-log-panel-in {
      from {
        opacity: 0;
        transform: scale(.978) translateY(5px);
      }
      to {
        opacity: 1;
        transform: scale(1) translateY(0);
      }
    }

    @media (max-width: 720px) {
      #${ROOT_ID} {
        padding: 12px;
      }

      #${ROOT_ID} .dion-log-panel {
        width: 100%;
        height: calc(100dvh - 24px);
        min-height: 0;
        border-radius: 18px;
      }

      #${ROOT_ID} .dion-log-header {
        min-height: 90px;
        padding: 17px 18px 14px;
      }

      #${ROOT_ID} .dion-log-divider {
        margin-inline: 18px;
      }

      #${ROOT_ID} .dion-log-scroll {
        padding: 17px 18px 22px;
      }
    }

    @media (max-width: 560px) {
      #${ROOT_ID} {
        padding: 0;
      }

      #${ROOT_ID} .dion-log-panel {
        width: 100vw;
        height: 100dvh;
        border: 0;
        border-radius: 0;
      }

      #${ROOT_ID} .dion-log-header {
        min-height: 76px;
        align-items: center;
        padding: 13px 14px 11px;
      }

      #${ROOT_ID} .dion-log-heading {
        align-items: center;
        gap: 10px;
      }

      #${ROOT_ID} .dion-log-heading-icon {
        width: 36px;
        height: 36px;
        flex-basis: 36px;
        border-radius: 11px;
      }

      #${ROOT_ID} .dion-log-eyebrow,
      #${ROOT_ID} .dion-log-heading-copy p,
      #${ROOT_ID} .dion-log-count {
        display: none;
      }

      #${ROOT_ID} .dion-log-title {
        margin-top: 0;
        font-size: 18px;
        line-height: 22px;
      }

      #${ROOT_ID} .dion-log-divider {
        margin-inline: 14px;
      }

      #${ROOT_ID} .dion-log-scroll {
        padding: 14px 14px 20px;
      }

      #${ROOT_ID} .dion-log-section-head {
        align-items: center;
      }

      #${ROOT_ID} .dion-log-section-head p {
        display: none;
      }

      #${ROOT_ID} .dion-log-row {
        gap: 9px;
        padding: 12px 11px;
      }

      #${ROOT_ID} .dion-log-avatar {
        width: 34px;
        height: 34px;
        flex-basis: 34px;
        border-radius: 10px;
      }

      #${ROOT_ID} .dion-log-top {
        gap: 8px;
      }

      #${ROOT_ID} .dion-log-badges {
        flex-wrap: wrap;
      }

      #${ROOT_ID} .dion-log-meta {
        flex-wrap: wrap;
      }
    }

    @media (max-width: 390px) {
      #${ROOT_ID} .dion-log-local-badge {
        display: none;
      }

      #${ROOT_ID} .dion-log-top {
        flex-direction: column;
        gap: 5px;
      }

      #${ROOT_ID} .dion-log-badges {
        justify-content: flex-start;
      }

      #${ROOT_ID} .dion-log-file {
        width: 100%;
        max-width: 100%;
      }
    }

    @media (max-height: 600px) and (min-width: 561px) {
      #${ROOT_ID} {
        padding: 10px;
      }

      #${ROOT_ID} .dion-log-panel {
        height: calc(100dvh - 20px);
        min-height: 0;
      }

      #${ROOT_ID} .dion-log-header {
        min-height: 78px;
        padding-top: 14px;
        padding-bottom: 12px;
      }

      #${ROOT_ID} .dion-log-heading-copy p {
        display: none;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      #${ROOT_ID} .dion-log-backdrop,
      #${ROOT_ID} .dion-log-panel {
        animation: none;
      }

      #${ROOT_ID} .dion-log-row,
      #${ROOT_ID} .dion-log-x,
      #${ROOT_ID} .dion-log-file {
        transition: none;
      }
    }
  `;

  document.head.appendChild(style);
}
