import {BodyMutationObserver} from "../../ui/bodyObserver";
import { t as i18nText } from "../../i18n";
import { createLogger } from "../../api/logger";
import {
  ensureReact,
  kit,
  kitReady,
  openNativeMenu,
  scanKit,
  type MenuViewProps,
  type ReactNs,
} from "../../discordKit";
import { TYPING_MODES, type TypingMode } from "./mode";

/**
 * The chat-input button and its options menu.
 *
 * The menu is Discord's own: its real `Menu` and `MenuRadioItem` components,
 * opened through `CONTEXT_MENU_OPEN`, so it has the client's animation, focus
 * handling, dismissal and keyboard navigation. A hand-built popover looked
 * close but never quite matched, which is exactly the complaint that prompted
 * this rewrite.
 *
 * The button is likewise a real element that borrows the class list of a button
 * Discord already rendered, wrapped in the same inner structure, so it inherits
 * sizing, hover and the lottie icon colour. Class names are rehashed on every
 * build, so only the un-hashed prefixes are ever matched.
 */

const log = createLogger("hide-typing:composer");

const HOST_ID = "Syncord-typing-mode-menu";
const BUTTON_ID = "Syncord-typing-mode-button";
const NAV_ID = "Syncord-typing-mode";
const STYLE_ID = `${HOST_ID}-css`;

/**
 * Tint the button while Always typing is live.
 *
 * Discord never renders your own typing back to you, so that mode has no
 * on-screen effect in this client and the tint is the only local sign of it.
 * Discord's own brand token is used so it matches the theme.
 */
function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${BUTTON_ID}[data-live="true"] {
      color: var(--brand-experiment, #5865f2);
    }
    #${BUTTON_ID}[data-live="true"] svg {
      color: var(--brand-experiment, #5865f2);
    }
  `;
  document.documentElement.appendChild(style);
}

const BAR = '[class*="channelBottomBarArea"]';
/** The send control is the one element in the bar that is always identifiable. */
const SEND_ICON = '[class*="sendIcon"]';

type Chrome = {
  /** Class list for our own button. */
  buttonClass: string;
  /** Class list for the inner wrapper that carries sizing and hover. */
  wrapperClass: string;
  /** Class list for the icon holder, which supplies size and colour. */
  iconClass: string;
};

/**
 * Read the surrounding button's structure so ours can match it.
 *
 * The reference is a real sibling control; the wrappers are looked up by
 * shape rather than by name, because Discord's names change.
 */
function readChrome(bar: Element): Chrome {
  // Discord nests: container > button > wrapper > icon holder > svg. The classes
  // that decide the look sit on the button and the icon holder, not the
  // container, so the real button element is located rather than assumed.
  const container =
    bar.querySelector('[class*="stickerButton"]')?.closest(
      '[class*="buttonContainer"]',
    ) ??
    bar.querySelector('[class*="buttonContainer"]') ??
    sendIconOf(bar)?.closest('[class*="button__"]') ??
    bar;

  const button =
    container.querySelector('[class*="button__"]') ??
    (container.matches?.('[class*="button__"]') ? container : null) ??
    container;
  const wrapper =
    button.querySelector('[class*="buttonWrapper"]') ??
    container.querySelector('[class*="buttonWrapper"]');
  const iconHolder =
    wrapper?.querySelector('[class*="lottieIcon"]') ??
    button.querySelector('[class*="lottieIcon"]') ??
    wrapper;

  return {
    buttonClass: button instanceof Element ? button.className : "",
    wrapperClass: wrapper instanceof Element ? wrapper.className : "",
    iconClass: iconHolder instanceof Element ? iconHolder.className : "",
  };
}

/** Element, not HTMLElement: the send control is an <svg>. */
function sendIconOf(bar: Element): Element | null {
  return bar.querySelector(SEND_ICON);
}

/**
 * Put the button in the bar, next to the send control.
 *
 * `insertBefore` throws when the reference node is not a child of the parent,
 * which is easy to get wrong because the send icon sits a couple of levels
 * below the row that holds it. Everything is guarded, so a layout change costs
 * the button, never the plugin.
 */
function placeButton(button: HTMLElement, bar: Element): void {
  const icon = sendIconOf(bar);
  const sendControl =
    icon?.closest('[class*="buttonContainer"], [class*="button__"]') ??
    icon?.parentElement ??
    null;
  const sendRow = icon?.closest('[class*="container"]') ?? null;
  const anchor = sendRow ?? sendControl;

  try {
    if (anchor?.parentElement) {
      anchor.parentElement.insertBefore(button, anchor);
      return;
    }
    if (sendControl?.parentElement) {
      sendControl.parentElement.insertBefore(button, sendControl.nextSibling);
      return;
    }
    // Last resort: the end of the bar. Ugly, but harmless.
    bar.appendChild(button);
  } catch (err) {
    log.warn("could not place the chat input button:", err);
  }
}

const ICON_PATH =
  "M4 7h9.5a2.5 2.5 0 0 1 4.9.8 1 1 0 1 0 0 1 0 .2 1.5 1 0 1 0 0-1.4 1.1 1 0 1 0 1.1-1.5H20a1 1 0 1 0 0-2h-2.1a1.1 1.1 0 0 0-1.1-1.5 1 1 0 0 0 0-1.4 1 1 0 0 0-.8 1A2.5 2.5 0 0 0 13.5 3H4a1 1 0 1 0 0 4Zm0 6h9.5a2.5 2.5 0 0 1 2.4 1.8 1 1 0 0 0 0 .2 1.5 1 0 0 1-1.5 1.1 1 0 0 1-1.1 1.5 1 1 0 0 0 0 1.4 1 1 0 0 0 .8 1 2.5 2.5 0 0 1-2.4 1H4a1 1 0 1 1 0-2Z";

function slidersIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.style.width = "100%";
  svg.style.height = "100%";
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", ICON_PATH);
  svg.appendChild(path);
  return svg;
}

/** The nested structure Discord uses, so the icon inherits size and colour. */
function buildButton(chrome: Chrome, onOpen: (event: Event) => void): HTMLDivElement {
  const button = document.createElement("div");
  button.id = BUTTON_ID;
  button.className = chrome.buttonClass;
  button.tabIndex = 0;
  button.setAttribute("role", "button");
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");

  const wrapper = document.createElement("div");
  wrapper.className = chrome.wrapperClass;
  if (!chrome.wrapperClass) wrapper.style.display = "flex";

  const holder = document.createElement("div");
  holder.className = chrome.iconClass;
  if (!chrome.iconClass) {
    holder.style.display = "flex";
    holder.style.width = "20px";
    holder.style.height = "20px";
  }
  holder.appendChild(slidersIcon());

  wrapper.appendChild(holder);
  button.appendChild(wrapper);

  // Both, so it opens on click and on the context-menu gesture.
  button.addEventListener("click", onOpen);
  button.addEventListener("contextmenu", onOpen);
  return button;
}

export type ComposerHandlers = {
  onSelect: (mode: TypingMode) => void;
  getMode: () => TypingMode;
};

export type ComposerHandle = {
  /** Re-read the mode and refresh the label. */
  refresh: () => void;
  /** True when Discord's menu components were found. */
  native: () => boolean;
  dispose: () => void;
};

export function installComposerButton(
  handlers: ComposerHandlers,
): ComposerHandle {
  ensureStyle();
  let button: HTMLDivElement | undefined;
  let frame = 0;
  let warned = false;
  let open = false;

  /**
   * Forget that the menu is open, whether we closed it or Discord did.
   *
   * Idempotent, because both paths run: our `close` asks Discord to close, and
   * Discord's own close calls back into the menu's `onClose`. Leaving `open` set
   * after the menu has gone made the next click on the button merely close a
   * menu that was no longer there, so the button felt dead.
   */
  const dismissed = (): void => {
    if (!open) return;
    open = false;
    button?.setAttribute("aria-expanded", "false");
  };

  const close = (): void => {
    if (!open) return;
    dismissed();
    kit.closeContextMenu?.();
  };

  /**
   * A component, not a finished tree.
   *
   * These options are an exclusive choice, so the menu stays open after a pick
   * and the tick moves to it — which is what Discord's own radio menus do, and
   * what the Fake voice menu does. A static tree could not show the move: React
   * has to re-invoke this, which the state bump forces it to do.
   */
  const MenuView = ({ navId, label, onClose }: MenuViewProps): unknown => {
    const react = kit.react as ReactNs;
    const [, repaint] = react.useState(0);
    const active = handlers.getMode();
    const pick = (value: TypingMode) => {
      handlers.onSelect(value);
      repaint((n: number) => n + 1);
    };
    const items = TYPING_MODES.map((option) =>
      react.createElement(kit.menuRadio, {
        key: option.value,
        id: `Syncord-typing-mode-${option.value}`,
        label: option.label,
        // `checked` is what draws the tick and sets aria-checked. There is no
        // `value` prop and no `onChange`: an unknown prop is silently ignored,
        // so getting this wrong leaves every circle empty.
        checked: option.value === active,
        action: () => pick(option.value),
      }),
    );
    const body = kit.menuGroup
      ? react.createElement(kit.menuGroup, { label: "Typing indicator" }, ...items)
      : items;
    return react.createElement(
      kit.menu,
      {
        navId,
        "aria-label": label,
        // Discord closes the menu itself on a click outside or on Escape, and
        // only tells us through here.
        onClose: () => {
          dismissed();
          onClose();
        },
      },
      ...(Array.isArray(body) ? body : [body]),
    );
  };

  const openMenu = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    ensureReact();
    scanKit();

    if (!kit.menu || !kit.menuRadio) {
      if (!warned) {
        warned = true;
        log.warn("Discord's menu components were not found; the button stays inert");
      }
      return;
    }

    if (open) {
      close();
      return;
    }
    open = true;
    button?.setAttribute("aria-expanded", "true");
    if (!openNativeMenu(event, MenuView, NAV_ID, i18nText("ui.typing_indicator_mode"))) {
      open = false;
      button?.setAttribute("aria-expanded", "false");
      log.warn("the native context menu could not be opened");
    }
  };

  function sync(): void {
    const bar = document.querySelector(BAR);
    if (!bar) return;

    if (!button || !button.isConnected) {
      button = buildButton(readChrome(bar), openMenu);
      placeButton(button, bar);
      if (!kitReady()) scanKit();
    }

    const active = handlers.getMode();
    const current = TYPING_MODES.find((m) => m.value === active);
    const label = i18nText("ui.typing_indicator_mode_value", {v0: current?.label ?? active});
    if (button) {
      button.title = current?.description ?? label;
      button.setAttribute("aria-label", label);
      // Only Always typing changes anything others can see, so only it is
      // marked as live.
      button.dataset.live = String(active === "always");
    }
  }

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };
  // Deliberately no "click outside to dismiss" listener. A real click runs
  // pointerdown, then mousedown, mouseup and finally click, so a capture-phase
  // pointerdown handler on the document tears the menu down before the item's
  // own click ever fires — the option is never selected. The native menu
  // dismisses itself and reports it through `onClose`.
  const onLayout = () => close();

  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", onLayout);
  window.addEventListener("scroll", onLayout, true);

  const observer = new BodyMutationObserver(() => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      sync();
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });

  sync();

  // The composer mounts after boot, so keep trying briefly.
  const retry = window.setInterval(() => {
    if (button?.isConnected) return;
    sync();
    if (button?.isConnected) window.clearInterval(retry);
  }, 500);
  const giveUp = window.setTimeout(() => window.clearInterval(retry), 20_000);

  return {
    refresh: sync,
    native: () => kit.menu != null && kit.menuRadio != null,
    dispose() {
      window.clearInterval(retry);
      window.clearTimeout(giveUp);
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onLayout);
      window.removeEventListener("scroll", onLayout, true);
      close();
      button?.remove();
      document.getElementById(HOST_ID)?.remove();
      document.getElementById(STYLE_ID)?.remove();
    },
  };
}
