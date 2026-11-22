import {BodyMutationObserver} from "../../ui/bodyObserver";
import { setLocalizedAttribute, t as i18nText } from "../../i18n";
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
import { SCHEDULE_PRESETS, type PresetId } from "./presets";

/**
 * The clock button in the chat input, and its preset menu.
 *
 * The button borrows the class list and the inner structure of a control Discord
 * already rendered — the same approach the Hide Typing button uses, and for the
 * same reason: class names are rehashed every build, so nothing here may depend
 * on one. The menu is Discord's own `Menu` and `MenuItem`, opened through
 * `CONTEXT_MENU_OPEN`, so it animates, navigates and dismisses like the rest of
 * the client.
 *
 * Deliberately absent: any "click outside to close" listener. A real click runs
 * pointerdown before click, so a capture-phase handler on the document tears the
 * menu down before an item's own click arrives and the option is never chosen.
 * The native menu dismisses itself and reports it through `onClose`.
 */

const log = createLogger("scheduled-messages:composer");

const BUTTON_ID = "Syncord-schedule-button";
const STYLE_ID = "Syncord-schedule-button-css";
const NAV_ID = "Syncord-schedule";

const BAR = '[class*="channelBottomBarArea"]';
/** The send control is the one element in the bar that is always identifiable. */
const SEND_ICON = '[class*="sendIcon"]';

type Chrome = {
  buttonClass: string;
  wrapperClass: string;
  iconClass: string;
};

/**
 * Read the surrounding control's structure so ours can match it.
 *
 * Discord nests: container > button > wrapper > icon holder > svg. The classes
 * that decide the look sit on the button and the icon holder, not the container,
 * so the real button element is located rather than assumed.
 */
function readChrome(bar: Element): Chrome {
  const container =
    bar.querySelector('[class*="stickerButton"]')?.closest(
      '[class*="buttonContainer"]',
    ) ??
    bar.querySelector('[class*="buttonContainer"]') ??
    bar.querySelector(SEND_ICON)?.closest('[class*="button__"]') ??
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

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${BUTTON_ID}:hover { color: var(--interactive-hover, #b5bac1); }
  `;
  document.documentElement.appendChild(style);
}

/**
 * A clock, drawn to match the client's icon set: 24-unit grid, `currentColor`,
 * rendered at the same 20px as every other control in the bar.
 */
const CLOCK_PATH =
  "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 1.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17Zm-.75 3.25v5.06l4.02 2.32.75-1.3-3.27-1.89V6.75h-1.5Z";

function clockIcon(): SVGSVGElement {
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
  path.setAttribute("d", CLOCK_PATH);
  svg.appendChild(path);
  return svg;
}

function buildButton(chrome: Chrome, onOpen: (event: Event) => void): HTMLDivElement {
  const button = document.createElement("div");
  button.id = BUTTON_ID;
  button.className = chrome.buttonClass;
  button.tabIndex = 0;
  button.setAttribute("role", "button");
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  setLocalizedAttribute(button, "aria-label", "ui.schedule_this_message");
  setLocalizedAttribute(button, "title", "ui.schedule_this_message");

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
  holder.appendChild(clockIcon());

  wrapper.appendChild(holder);
  button.appendChild(wrapper);
  // Both gestures, as the Hide Typing button does: a plain click is not the only
  // way this control gets activated in the client.
  button.addEventListener("click", onOpen);
  button.addEventListener("contextmenu", onOpen);
  return button;
}

/**
 * Put the button in the bar, beside the send control.
 *
 * `insertBefore` throws when the reference is not a child of the parent, which is
 * easy to get wrong because the send icon sits a couple of levels below the row
 * that holds it. Every step is guarded, so a layout change costs the button and
 * never the plugin.
 */
function placeButton(button: HTMLElement, bar: Element): void {
  const icon = bar.querySelector(SEND_ICON);
  const anchor = icon?.closest('[class*="container"]') ?? icon?.parentElement ?? null;
  try {
    if (anchor?.parentElement) {
      anchor.parentElement.insertBefore(button, anchor);
      return;
    }
    bar.appendChild(button);
  } catch (err) {
    log.warn("could not place the schedule button:", err);
  }
}

export type ComposerHandlers = {
  /** A preset was chosen. */
  onPreset: (id: PresetId) => void;
  /** "Custom date & time" was chosen; the menu has closed by then. */
  onCustom: () => void;
  /** False when there is nothing to schedule, which greys the button out. */
  canSchedule: () => boolean;
  /** The menu could not be built; `reason` names the missing piece. */
  onUnavailable?: (reason: string) => void;
};

export type ComposerHandle = {
  refresh: () => void;
  /** True once Discord's menu components were found. */
  native: () => boolean;
  dispose: () => void;
};

export function installScheduleButton(
  handlers: ComposerHandlers,
): ComposerHandle {
  ensureStyle();
  let button: HTMLDivElement | undefined;
  let frame = 0;
  /** Last reason the menu could not be built, for de-duplicated reporting. */
  let warned: string | undefined;
  let open = false;

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

  const MenuView = ({ navId, label, onClose }: MenuViewProps): unknown => {
    const react = kit.react as ReactNs;
    const rows = SCHEDULE_PRESETS.map((preset) =>
      react.createElement(kit.menuItem, {
        key: preset.id,
        id: `Syncord-schedule-${preset.id}`,
        label: preset.label,
        action: () => {
          if (preset.id === "custom") handlers.onCustom();
          else handlers.onPreset(preset.id);
        },
      }),
    );
    return react.createElement(
      kit.menu,
      { navId, "aria-label": label, onClose: () => { dismissed(); onClose(); } },
      ...rows,
    );
  };

  /**
   * Why the menu cannot be built, or undefined when it can.
   *
   * Reported per distinct reason rather than latched once, so a component that
   * resolves later lets the button recover instead of staying dead for the
   * session.
   */
  function blockedBecause(): string | undefined {
    if (!kit.react) return i18nText("ui.react_was_not_found");
    if (!kit.menu) return i18nText("ui.menu_was_not_found");
    if (!kit.menuItem) return i18nText("ui.menuitem_was_not_found");
    if (!kit.openContextMenu) return i18nText("ui.opencontextmenu_was_not_found");
    return undefined;
  }

  const openMenu = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    ensureReact();
    scanKit();

    const blocked = blockedBecause();
    if (blocked) {
      // The console alone is not enough: a button that does nothing looks
      // broken, and the person using it has no reason to open devtools.
      if (warned !== blocked) {
        warned = blocked;
        log.warn(`cannot open the schedule menu: ${blocked}`);
        handlers.onUnavailable?.(blocked);
      }
      return;
    }
    if (open) {
      close();
      return;
    }
    open = true;
    button?.setAttribute("aria-expanded", "true");
    const opened = openNativeMenu(event, MenuView, NAV_ID, i18nText("ui.schedule_this_message"));
    if (!opened) {
      dismissed();
      log.warn("the native context menu could not be opened");
      handlers.onUnavailable?.(i18nText("ui.the_menu_failed_to_open"));
      return;
    }
    reportOutcome();
  };

  /**
   * Say what actually happened, in one line.
   *
   * `openContextMenu` returning true only means the call did not throw; the menu
   * is rendered by React afterwards and can still be refused, or land somewhere
   * invisible. Without this, "the button does nothing" and "the menu opened
   * off-screen" look identical from the outside.
   */
  function reportOutcome(): void {
    const inspect = (): void => {
      // The last one in document order: menus are portalled to the end of the
      // body, so an earlier match would be some other menu already on screen.
      const layers = document.querySelectorAll('[role="menu"]');
      const layer = layers[layers.length - 1];
      if (!layer) {
        dismissed();
        log.warn(
          "openContextMenu returned but no [role=menu] exists — the client refused it",
        );
        return;
      }
      const box = layer.getBoundingClientRect();
      const style = getComputedStyle(layer);
      log.info(
        `menu open: ${Math.round(box.width)}x${Math.round(box.height)} at ` +
          `${Math.round(box.left)},${Math.round(box.top)} ` +
          `display=${style.display} visibility=${style.visibility} ` +
          `opacity=${style.opacity} items=${layer.querySelectorAll("[data-menu-item]").length}`,
      );
    };
    requestAnimationFrame(() => requestAnimationFrame(inspect));
  }

  function sync(): void {
    const bar = document.querySelector(BAR);
    if (!bar) return;

    if (!button || !button.isConnected) {
      button = buildButton(readChrome(bar), openMenu);
      placeButton(button, bar);
      if (!kitReady()) scanKit();
    }

    const enabled = handlers.canSchedule();
    button.setAttribute("aria-disabled", enabled ? "false" : "true");
    button.style.opacity = enabled ? "" : "0.45";
    button.style.cursor = enabled ? "" : "not-allowed";
  }

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") close();
  };
  const onLayout = (): void => close();

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
    native: () => kit.menu != null && kit.menuItem != null,
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
      document.getElementById(STYLE_ID)?.remove();
    },
  };
}
