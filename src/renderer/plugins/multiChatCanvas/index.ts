import { setLocalizedAttribute, t as i18nText } from "../../i18n";
import { definePlugin } from "../../api/plugin";
import { bindTooltip } from "../../ui/tooltip";
import {
  disposeMultiChatCanvas,
  isMultiChatCanvasOpen,
  toggleMultiChatCanvas,
} from "./canvas";
import { MULTICHAT_CSS } from "./styles";

const TOOLBAR_ID =
  "Syncord-multichat-toolbar-btn";

function findInbox():
  | HTMLElement
  | null {
  return (
    document.querySelector<HTMLElement>(
      '[aria-label="Inbox"]',
    ) ??
    document.querySelector<HTMLElement>(
      '[aria-label="Gelen Kutusu"]',
    )
  );
}

function createToolbarButton(
  inbox: HTMLElement,
  onToggle: () => void,
): HTMLElement {
  const button =
    document.createElement(
      "div",
    );

  button.id =
    TOOLBAR_ID;

  /*
   * Borrow Discord's current toolbar button class so spacing/hover remains
   * native even when Discord changes hashed class names.
   */
  button.className =
    inbox.className;

  button.setAttribute(
    "role",
    "button",
  );

  setLocalizedAttribute(button, "aria-label", "ui.multichat_canvas");

  button.setAttribute(
    "aria-pressed",
    "false",
  );

  button.dataset.open =
    "false";

  button.tabIndex =
    0;

  button.innerHTML = `
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 24 24"
    >
      <path
        fill="currentColor"
        d="M3 4h8v7H3V4Zm10 0h8v7h-8V4ZM3 13h8v7H3v-7Zm10 0h8v7h-8v-7Z"
      />
    </svg>
  `;

  const activate =
    (event: Event) => {
      event.preventDefault();
      event.stopPropagation();

      onToggle();

      button.setAttribute(
        "aria-pressed",
        isMultiChatCanvasOpen()
          ? "true"
          : "false",
      );
    };

  button.addEventListener(
    "click",
    activate,
  );

  button.addEventListener(
    "keydown",
    (event) => {
      if (
        event.key !== "Enter" &&
        event.key !== " "
      ) {
        return;
      }

      activate(
        event,
      );
    },
  );

  bindTooltip(
    button,
    () =>
      isMultiChatCanvasOpen()
        ? i18nText("ui.close_multichat_canvas")
        : i18nText("ui.open_multichat_canvas"),
    {
      position: "bottom",
      delay: 0,
    },
  );

  return button;
}

function tryMountToolbar(
  onToggle: () => void,
): boolean {
  if (
    document.getElementById(
      TOOLBAR_ID,
    )
  ) {
    return true;
  }

  const inbox =
    findInbox();

  if (!inbox) {
    return false;
  }

  const slot =
    inbox.closest(
      '[class*="iconWrapper"]',
    ) ??
    inbox.parentElement;

  if (!slot?.parentElement) {
    return false;
  }

  const wrap =
    document.createElement(
      "div",
    );

  if (
    slot.className &&
    slot !== inbox
  ) {
    wrap.className =
      slot.className;
  }

  wrap.appendChild(
    createToolbarButton(
      inbox,
      onToggle,
    ),
  );

  slot.parentElement.insertBefore(
    wrap,
    slot,
  );

  return true;
}

export const MultiChatCanvasPlugin =
  definePlugin({
    id:
      "multichat-canvas",

    name:
      i18nText("ui.multichat_canvas"),

    get description() { return i18nText("ui.open_2_4_independent_dms_or_server_chats_in_one_discord_workspace"); },

    author:
      i18nText("ui.syncord"),

    enabledByDefault:
      true,

    /**
     * Renders 2–4 chats side by side and attaches media to drafts.
     *
     * `media` is declared for the media picker and sticker preview — the
     * thumbnails come from Discord's own CDN, through Discord's own image
     * pipeline, not from a request this plugin makes. `media` also gates
     * `ctx.css`, which this plugin uses for its layout. No network permission:
     * anything the broker would refuse is exactly the thing this plugin must
     * not be able to do.
     */
    permissions: {
      media: true,
      discordStores: ["message", "channel", "guild", "user"],
      discordActions: ["message-send"],
    },

    start(ctx) {
      ctx.css.inject(MULTICHAT_CSS);

      const onToggle =
        () =>
          toggleMultiChatCanvas(
            ctx,
          );

      tryMountToolbar(
        onToggle,
      );

      let raf =
        0;

      const scheduleMount =
        () => {
          if (raf || document.getElementById(TOOLBAR_ID)) return;

          raf =
            requestAnimationFrame(
              () => {
                raf = 0;

                if (
                  !document.getElementById(
                    TOOLBAR_ID,
                  )
                ) {
                  tryMountToolbar(
                    onToggle,
                  );
                }
              },
            );
        };

      const observer =
        new MutationObserver(
          scheduleMount,
        );

      observer.observe(
        document.body,
        {
          childList: true,
          subtree: true,
        },
      );

      const bootTimer =
        window.setInterval(
          () => {
            if (
              tryMountToolbar(
                onToggle,
              )
            ) {
              window.clearInterval(
                bootTimer,
              );
            }
          },
          500,
        );

      const bootTimeout =
        window.setTimeout(
          () =>
            window.clearInterval(
              bootTimer,
            ),
          30_000,
        );

      const onKey =
        (
          event:
            KeyboardEvent,
        ) => {
          const mod =
            event.metaKey ||
            event.ctrlKey;

          if (
            !mod ||
            !event.shiftKey ||
            event.key.toLowerCase() !==
              "m"
          ) {
            return;
          }

          event.preventDefault();
          event.stopPropagation();

          onToggle();
        };

      window.addEventListener(
        "keydown",
        onKey,
        true,
      );

      ctx.disposable(
        () => {
          observer.disconnect();

          window.clearInterval(
            bootTimer,
          );

          window.clearTimeout(
            bootTimeout,
          );

          if (raf) {
            cancelAnimationFrame(
              raf,
            );
          }

          window.removeEventListener(
            "keydown",
            onKey,
            true,
          );

          document
            .getElementById(
              TOOLBAR_ID,
            )
            ?.parentElement
            ?.remove();

          disposeMultiChatCanvas();
        },
      );

      ctx.log.info(
        "MultiChat Canvas ready · Ctrl/⌘+Shift+M",
      );
    },
  });
