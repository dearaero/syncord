import { relativeTime as i18nRelativeTime, h, messageHtml as i18nHtml, setLocalizedHtml, t as i18nText } from "../../i18n";
import type { SessionSnapshot } from "./types";

const ROOT_ID = "Syncord-session-restore-prompt";
const STYLE_ID = "Syncord-session-restore-prompt-css";

let activeRoot: HTMLDivElement | undefined;

export type SessionRestorePromptHandlers = {
  onRestore: () => void | Promise<void>;
  onFresh: () => void | Promise<void>;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function relativeTime(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return i18nText("ui.just_now");
  if (diff < hour) {
    const value = Math.floor(diff / minute);
    return i18nRelativeTime(-value,'minute');
  }
  if (diff < day) {
    const value = Math.floor(diff / hour);
    return i18nRelativeTime(-value,'hour');
  }

  const value = Math.floor(diff / day);
  return i18nRelativeTime(-value,'day');
}

function locationLabel(snapshot: SessionSnapshot): string {
  const guild = snapshot.guildName?.trim();
  const channel = snapshot.channelName?.trim();

  if (guild && channel) return `${guild} · #${channel}`;
  if (channel) return snapshot.guildId ? `#${channel}` : channel;
  if (guild) return guild;

  if (snapshot.guildId === undefined && snapshot.channelId) {
    return i18nText("ui.direct_messages");
  }

  return i18nText("ui.discord");
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${ROOT_ID} {
      position: fixed;
      right: 22px;
      bottom: 22px;
      z-index: 100006;

      width: min(390px, calc(100vw - 32px));

      box-sizing: border-box;

      font-family:
        "gg sans",
        "Noto Sans",
        "Helvetica Neue",
        Helvetica,
        Arial,
        sans-serif;

      color: var(--text-normal, #dbdee1);

      animation:
        dion-session-prompt-in
        220ms
        cubic-bezier(0.2, 0.8, 0.2, 1);
    }

    #${ROOT_ID},
    #${ROOT_ID} *,
    #${ROOT_ID} *::before,
    #${ROOT_ID} *::after {
      box-sizing: border-box;
    }

    #${ROOT_ID} .dion-session-card {
      position: relative;

      overflow: hidden;

      border:
        1px solid
        var(
          --background-modifier-accent,
          rgba(255, 255, 255, 0.075)
        );

      border-radius: 18px;

      background:
        linear-gradient(
          180deg,
          color-mix(
            in srgb,
            var(--modal-background, #202024)
            96%,
            white 4%
          ),
          var(--modal-background, #202024)
        );

      box-shadow:
        0 18px 52px rgba(0, 0, 0, 0.5),
        inset 0 1px 0 rgba(255, 255, 255, 0.035);

      backdrop-filter: blur(14px);
    }

    #${ROOT_ID} .dion-session-card::before {
      content: "";

      position: absolute;
      inset:
        0
        0
        auto;

      height: 1px;

      background:
        linear-gradient(
          90deg,
          transparent,
          color-mix(
            in srgb,
            var(--brand-500, #5865f2)
            65%,
            transparent
          ),
          transparent
        );

      pointer-events: none;
    }

    #${ROOT_ID} .dion-session-head {
      display: flex;
      align-items: flex-start;

      gap: 12px;

      padding:
        16px
        16px
        12px;
    }

    #${ROOT_ID} .dion-session-icon {
      width: 40px;
      height: 40px;

      flex: 0 0 40px;

      display: grid;
      place-items: center;

      border:
        1px solid
        color-mix(
          in srgb,
          var(--brand-500, #5865f2)
          23%,
          transparent
        );

      border-radius: 13px;

      background:
        color-mix(
          in srgb,
          var(--brand-500, #5865f2)
          13%,
          var(--background-secondary, #2b2d31)
        );

      color:
        color-mix(
          in srgb,
          var(--brand-500, #5865f2)
          72%,
          white 28%
        );
    }

    #${ROOT_ID} .dion-session-copy {
      min-width: 0;
      flex: 1;
    }

    #${ROOT_ID} .dion-session-title-line {
      min-width: 0;

      display: flex;
      align-items: center;

      gap: 7px;
    }

    #${ROOT_ID} .dion-session-title {
      min-width: 0;

      margin: 0;

      overflow: hidden;

      color:
        var(
          --header-primary,
          #f2f3f5
        );

      font-size: 15px;
      font-weight: 650;

      line-height: 20px;

      letter-spacing: -0.012em;

      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #${ROOT_ID} .dion-session-badge {
      flex-shrink: 0;

      height: 18px;

      display: inline-flex;
      align-items: center;

      padding:
        0 6px;

      border-radius: 999px;

      background:
        color-mix(
          in srgb,
          var(--brand-500, #5865f2)
          12%,
          transparent
        );

      color:
        color-mix(
          in srgb,
          var(--brand-500, #5865f2)
          70%,
          white 30%
        );

      font-size: 9px;
      font-weight: 700;

      line-height: 1;

      text-transform: uppercase;

      letter-spacing: 0.04em;
    }

    #${ROOT_ID} .dion-session-sub {
      margin:
        2px
        0
        0;

      color:
        var(
          --text-muted,
          #949ba4
        );

      font-size: 12px;

      line-height: 17px;
    }

    #${ROOT_ID} .dion-session-close {
      width: 28px;
      height: 28px;

      flex: 0 0 28px;

      display: grid;
      place-items: center;

      padding: 0;

      border: 0;
      border-radius: 9px;

      background: transparent;

      color:
        var(
          --interactive-normal,
          #b5bac1
        );

      cursor: pointer;

      transition:
        color 120ms ease,
        background-color 120ms ease,
        transform 100ms ease;
    }

    #${ROOT_ID} .dion-session-close:hover {
      background:
        var(
          --background-modifier-hover,
          rgba(255, 255, 255, 0.055)
        );

      color:
        var(
          --interactive-hover,
          #f2f3f5
        );
    }

    #${ROOT_ID} .dion-session-close:active {
      transform: scale(0.94);
    }

    #${ROOT_ID} .dion-session-meta {
      margin:
        0
        16px;

      overflow: hidden;

      border:
        1px solid
        var(
          --background-modifier-accent,
          rgba(255, 255, 255, 0.065)
        );

      border-radius: 12px;

      background:
        var(
          --background-secondary,
          #2b2d31
        );
    }

    #${ROOT_ID} .dion-session-location {
      min-width: 0;

      display: flex;
      align-items: center;

      gap: 9px;

      padding:
        10px
        11px;

      border-bottom:
        1px solid
        var(
          --background-modifier-accent,
          rgba(255, 255, 255, 0.055)
        );
    }

    #${ROOT_ID} .dion-session-location-icon {
      width: 28px;
      height: 28px;

      flex: 0 0 28px;

      display: grid;
      place-items: center;

      border-radius: 9px;

      background:
        var(
          --background-tertiary,
          #1e1f22
        );

      color:
        var(
          --interactive-normal,
          #b5bac1
        );
    }

    #${ROOT_ID} .dion-session-location-copy {
      min-width: 0;
      flex: 1;
    }

    #${ROOT_ID} .dion-session-location-name {
      overflow: hidden;

      color:
        var(
          --header-primary,
          #f2f3f5
        );

      font-size: 12px;
      font-weight: 600;

      line-height: 16px;

      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #${ROOT_ID} .dion-session-location-time {
      margin-top: 1px;

      color:
        var(
          --text-muted,
          #949ba4
        );

      font-size: 10px;

      line-height: 14px;
    }

    #${ROOT_ID} .dion-session-features {
      display: flex;
      align-items: center;

      gap: 6px;

      flex-wrap: wrap;

      padding:
        9px
        10px;
    }

    #${ROOT_ID} .dion-session-chip {
      height: 22px;

      display: inline-flex;
      align-items: center;

      gap: 5px;

      padding:
        0 8px;

      border:
        1px solid
        var(
          --background-modifier-accent,
          rgba(255, 255, 255, 0.055)
        );

      border-radius: 999px;

      background:
        rgba(255, 255, 255, 0.018);

      color:
        var(
          --text-muted,
          #949ba4
        );

      font-size: 10px;
      font-weight: 550;

      line-height: 1;
    }

    #${ROOT_ID} .dion-session-chip::before {
      content: "";

      width: 5px;
      height: 5px;

      border-radius: 50%;

      background:
        var(
          --status-positive,
          #23a55a
        );
    }

    #${ROOT_ID} .dion-session-actions {
      display: grid;

      grid-template-columns:
        minmax(0, 1fr)
        minmax(0, 1.25fr);

      gap: 8px;

      padding:
        14px
        16px
        16px;
    }

    #${ROOT_ID} .dion-session-btn {
      min-width: 0;
      min-height: 36px;

      display: inline-flex;
      align-items: center;
      justify-content: center;

      gap: 7px;

      padding:
        0 12px;

      border:
        1px solid
        transparent;

      border-radius: 10px;

      font-size: 12px;
      font-weight: 600;

      line-height: 16px;

      cursor: pointer;

      transition:
        background-color 120ms ease,
        border-color 120ms ease,
        color 120ms ease,
        transform 100ms ease,
        box-shadow 120ms ease;
    }

    #${ROOT_ID} .dion-session-btn:active {
      transform:
        translateY(1px)
        scale(0.99);
    }

    #${ROOT_ID} .dion-session-btn.is-secondary {
      border-color:
        var(
          --background-modifier-accent,
          rgba(255, 255, 255, 0.07)
        );

      background:
        var(
          --background-secondary,
          #2b2d31
        );

      color:
        var(
          --interactive-normal,
          #b5bac1
        );
    }

    #${ROOT_ID} .dion-session-btn.is-secondary:hover {
      background:
        var(
          --background-modifier-hover,
          rgba(255, 255, 255, 0.055)
        );

      color:
        var(
          --interactive-hover,
          #f2f3f5
        );
    }

    #${ROOT_ID} .dion-session-btn.is-primary {
      border-color:
        color-mix(
          in srgb,
          var(--brand-500, #5865f2)
          76%,
          white 24%
        );

      background:
        linear-gradient(
          180deg,
          color-mix(
            in srgb,
            var(--brand-500, #5865f2)
            90%,
            white 10%
          ),
          var(--brand-500, #5865f2)
        );

      color: #fff;

      box-shadow:
        0 5px 16px
        color-mix(
          in srgb,
          var(--brand-500, #5865f2)
          20%,
          transparent
        );
    }

    #${ROOT_ID} .dion-session-btn.is-primary:hover {
      box-shadow:
        0 7px 20px
        color-mix(
          in srgb,
          var(--brand-500, #5865f2)
          28%,
          transparent
        );
    }

    #${ROOT_ID} button:focus-visible {
      outline:
        2px solid
        var(
          --brand-500,
          #5865f2
        );

      outline-offset: 2px;
    }

    @keyframes dion-session-prompt-in {
      from {
        opacity: 0;

        transform:
          translateY(10px)
          scale(0.975);
      }

      to {
        opacity: 1;

        transform:
          translateY(0)
          scale(1);
      }
    }

    @media (max-width: 520px) {
      #${ROOT_ID} {
        right: 12px;
        bottom: 12px;

        width:
          calc(
            100vw - 24px
          );
      }

      #${ROOT_ID} .dion-session-actions {
        grid-template-columns: 1fr;
      }

      #${ROOT_ID} .dion-session-btn.is-primary {
        grid-row: 1;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      #${ROOT_ID} {
        animation: none;
      }

      #${ROOT_ID} .dion-session-close,
      #${ROOT_ID} .dion-session-btn {
        transition: none;
      }
    }
  `;

  document.documentElement.appendChild(style);
}

export function hideSessionRestorePrompt(): void {
  activeRoot?.remove();
  activeRoot = undefined;
}

export function removeSessionRestorePromptStyle(): void {
  document.getElementById(STYLE_ID)?.remove();
}

export function showSessionRestorePrompt(
  snapshot: SessionSnapshot,
  handlers: SessionRestorePromptHandlers,
): () => void {
  ensureStyle();
  hideSessionRestorePrompt();

  const root = document.createElement("div");
  root.id = ROOT_ID;

  const chips = [
    snapshot.draft?.trim() ? "Draft saved" : "",
    snapshot.scroll ? "Scroll position" : "",
  ].filter(Boolean);

  setLocalizedHtml(root, `
    <section
      class="dion-session-card"
      role="dialog"
      aria-labelledby="dion-session-title"
      aria-describedby="dion-session-desc"
    >
      <div class="dion-session-head">
        <div class="dion-session-icon" aria-hidden="true">
          <svg width="21" height="21" viewBox="0 0 24 24">
            <path
              fill="currentColor"
              d="M12 3a9 9 0 1 0 8.48 12H18.3A7 7 0 1 1 16.95 7.05L14 10h7V3l-2.62 2.62A8.96 8.96 0 0 0 12 3Zm-1 5v5.35l4.15 2.49 1.03-1.72L13 12.21V8h-2Z"
            />
          </svg>
        </div>

        <div class="dion-session-copy">
          <div class="dion-session-title-line">
            <h2
              class="dion-session-title"
              id="dion-session-title"
            >
              ${i18nHtml("ui.continue_where_you_left_off")}
            </h2>

            <span class="dion-session-badge">
              ${i18nHtml("ui.session")}
            </span>
          </div>

          <p
            class="dion-session-sub"
            id="dion-session-desc"
          >
            ${i18nHtml("ui.syncord_saved_your_previous_chat_session")}
          </p>
        </div>

        <button
          type="button"
          class="dion-session-close"
          data-dion-session-fresh
          aria-label="${h("ui.start_fresh")}" data-si18n-aria-label="ui.start_fresh"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
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

      <div class="dion-session-meta">
        <div class="dion-session-location">
          <div
            class="dion-session-location-icon"
            aria-hidden="true"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
            >
              <path
                fill="currentColor"
                d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v13a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 18.5v-13Zm4 2v2h8v-2H8Zm0 4v2h8v-2H8Zm0 4v2h5v-2H8Z"
              />
            </svg>
          </div>

          <div class="dion-session-location-copy">
            <div class="dion-session-location-name">
              ${escapeHtml(locationLabel(snapshot))}
            </div>

            <div class="dion-session-location-time">
              Saved ${escapeHtml(relativeTime(snapshot.savedAt))}
            </div>
          </div>
        </div>

        ${chips.length
            ? `
              <div class="dion-session-features">
                ${chips
                  .map(
                    (chip) => `
                      <span class="dion-session-chip">
                        ${escapeHtml(chip)}
                      </span>
                    `,
                  )
                  .join("")}
              </div>
            `
            : ""}
      </div>

      <div class="dion-session-actions">
        <button
          type="button"
          class="dion-session-btn is-secondary"
          data-dion-session-fresh
        >
          ${i18nHtml("ui.start_fresh")}
        </button>

        <button
          type="button"
          class="dion-session-btn is-primary"
          data-dion-session-restore
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              fill="currentColor"
              d="M12 4a8 8 0 1 0 7.75 10h-2.1A6 6 0 1 1 16.2 7.8L13 11h7V4l-2.35 2.35A7.96 7.96 0 0 0 12 4Z"
            />
          </svg>

          ${i18nHtml("ui.restore_session")}
        </button>
      </div>
    </section>
  `);

  let busy = false;

  const run = async (kind: "restore" | "fresh") => {
    if (busy) return;
    busy = true;

    root
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((button) => {
        button.disabled = true;
      });

    try {
      if (kind === "restore") {
        await handlers.onRestore();
      } else {
        await handlers.onFresh();
      }
    } finally {
      hideSessionRestorePrompt();
    }
  };

  root.addEventListener("click", (event) => {
    const target = event.target;

    if (!(target instanceof Element)) return;

    if (target.closest("[data-dion-session-restore]")) {
      event.preventDefault();
      void run("restore");
      return;
    }

    if (target.closest("[data-dion-session-fresh]")) {
      event.preventDefault();
      void run("fresh");
    }
  });

  document.documentElement.appendChild(root);
  activeRoot = root;

  root
    .querySelector<HTMLButtonElement>(
      "[data-dion-session-restore]",
    )
    ?.focus();

  return () => {
    if (activeRoot === root) {
      hideSessionRestorePrompt();
    } else {
      root.remove();
    }
  };
}
