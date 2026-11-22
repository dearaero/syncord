import {BodyMutationObserver} from "./bodyObserver";
import { messageHtml as i18nHtml, setLocalizedAttribute, t as i18nText } from "../i18n";
import { compareVersions, normalizeVersion } from "../../shared/version";
import { createLogger } from "../api/logger";
import { onUpdate, updateState } from "../api/updater";
import { openSettings } from "./settingsPanel";
import { bindTooltip } from "./tooltip";

const log = createLogger("titlebar");

const BTN_ID = "Syncord-titlebar-btn";
const STYLE_ID = "Syncord-titlebar-css";
const BADGE_ATTR = "data-dion-titlebar-update";
const BADGE_SELECTOR = `[${BADGE_ATTR}]`;
const LAYOUT_ATTR = "data-syncord-titlebar-layout";
const CONTEXT_ATTR = "data-syncord-titlebar-context";

const UPDATE_ICON_PATH = "M12 4a1 1 0 0 1 1 1v8.6l3.3-3.3a1 1 0 1 1 1.4 1.4l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.4l3.3 3.3V5a1 1 0 0 1 1-1Zm-7 12a1 1 0 0 1 1 1v1h12v-1a1 1 0 1 1 2 0v2a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1Z";
const CURRENT_ICON_PATH = "M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z";

/** Timestamp of the last "could not mount" report, for throttling. */
let lastFailureReport = 0;
let addon:((button:HTMLButtonElement)=>()=>void)|undefined;
let addonButton:HTMLButtonElement|undefined,disposeAddon:(()=>void)|undefined;
function attachAddon(button:HTMLButtonElement):void {
  if(addonButton===button)return;
  disposeAddon?.();addonButton=button;disposeAddon=addon?.(button);
}
/** A titlebar extension follows the existing mount/remount and update badge. */
export function registerTitlebarAddon(mount:(button:HTMLButtonElement)=>()=>void):()=>void {
  if(addon)throw Error('Titlebar extension already registered');addon=mount;
  const button=document.getElementById(BTN_ID);if(button?.tagName === 'BUTTON'){addonButton=undefined;attachAddon(button as HTMLButtonElement);}
  return()=>{disposeAddon?.();disposeAddon=undefined;addonButton=undefined;addon=undefined;paintUpdateBadge();};
}

/** Update icon states. Opening settings does not resolve an available update. */
type BadgeState = "none" | "current" | "offered" | "ready" | "working" | "restart" | "pending";

export function badgeStateFor(phase: string, latest: string | null, current: string | null = null): BadgeState {
  // Main also uses up-to-date when a release has no asset for this platform.
  // A green check must never claim a newer, un-installable release is current.
  if (phase === "up-to-date") {
    const installed = normalizeVersion(current);
    const published = normalizeVersion(latest);
    return installed !== null && published !== null && compareVersions(published, installed) <= 0
      ? "current"
      : "none";
  }
  if (phase === "awaiting-restart") return "pending";
  if (phase === "handed-off") return "restart";
  if (phase === "downloading" || phase === "handing-off") return "working";
  if (latest === null) return "none";
  if (phase === "available") return "offered";
  if (phase === "ready") return "ready";
  return "none";
}

/** The sentence the update icon means, for the tooltip and for assistive technology. */
export function badgeMessage(state: BadgeState, version: string | null): string | null {
  switch (state) {
    case "current":
      return version === null ? i18nText("ui.syncord_is_up_to_date") : i18nText("ui.syncord_value_is_up_to_date", {v0: version});
    case "offered":
      return version === null ? null : i18nText("ui.syncord_value_is_available", {v0: version});
    case "ready":
      return version === null ? null : i18nText("ui.syncord_value_is_downloaded_and_ready_to_install", {v0: version});
    case "working":
      return i18nText("ui.installing_the_update");
    case "pending":
      return version === null ? i18nText("ui.restart_discord_to_install_the_verified_update") : i18nText("ui.restart_discord_to_install_syncord_value", {v0: version});
    case "restart":
      return version === null
        ? i18nText("ui.the_update_is_installed_quit_and_reopen_discord")
        : i18nText("ui.syncord_value_is_installed_quit_and_reopen_discord", {v0: version});
    case "none":
      return null;
  }
}

function currentBadge(): { state: BadgeState; version: string | null } {
  const status = updateState();
  const state = badgeStateFor(status.phase, status.latest, status.current);
  return {
    state,
    version: state === "current" ? status.current : status.latest ?? status.stagedVersion,
  };
}

/** The last state drawn, so the boot log records a change rather than a poll. */
let lastPaintedState: BadgeState | undefined;

/**
 * Draw the update icon, or take it away.
 *
 * Looks the button up by id every time rather than closing over a node, because
 * Discord's re-renders can make `tryMount()` build a fresh button while this
 * subscription is still the one telling it what to show.
 */
function paintUpdateBadge(): void {
  const btn = document.getElementById(BTN_ID);
  if (btn === null) return;

  const badge = btn.querySelector<HTMLElement>(BADGE_SELECTOR);
  if (badge === null) return;

  const { state, version } = currentBadge();
  const message = badgeMessage(state, version);

  badge.hidden = state === "none";
  badge.dataset.dionState = state;
  badge.querySelector("path")?.setAttribute("d", state === "current" ? CURRENT_ICON_PATH : UPDATE_ICON_PATH);

  // The badge is decorative: the button's own label carries the same sentence, so
  // marking it `aria-hidden` stops a screen reader from announcing the news
  // twice from one element.
  btn.setAttribute(
    "aria-label",
    btn.dataset.syncordTitlebarLabel ? `${btn.dataset.syncordTitlebarLabel}${message?` · ${message}`:''}` : message === null ? i18nText("ui.open_syncord_settings") : i18nText("ui.value_open_syncord_settings", {v0: message}),
  );
  btn.dataset.dionUpdateState = state;

  // Transitions only. `onUpdate` fires on every poll — four hundred times a
  // second is not the number, but it is every 400 ms — and a line per poll
  // would bury the boot log this file already uses to explain a missing word.
  if (state !== lastPaintedState) {
    lastPaintedState = state;
    if (state === "none") {
      log.info("titlebar update icon cleared");
    } else {
      log.info(`titlebar update icon: ${state} (${version ?? "unknown version"})`);
    }
  }
}

function ensureCss(): void {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${BTN_ID} {
      position: relative;

      display: inline-flex;
      align-items: center;
      justify-content: center;

      height: 32px;
      min-width: 0;

      margin-left: 10px;
      padding: 0 7px;

      flex-shrink: 0;

      border: 0;
      border-radius: 0;

      background: transparent;

      color:
        var(
          --header-secondary,
          var(--interactive-normal, #b5bac1)
        );

      font-family:
        var(
          --font-primary,
          "gg sans",
          "Noto Sans",
          "Helvetica Neue",
          Helvetica,
          Arial,
          sans-serif
        );

      font-size: 15px;
      font-weight: 600;
      line-height: 20px;

      letter-spacing: -0.015em;

      cursor: pointer;
      user-select: none;
      -webkit-app-region: no-drag;

      transition:
        color 120ms ease,
        opacity 120ms ease,
        transform 100ms ease;
    }

    /* Keep Discord's context node in its React parent; only change its layout. */
    [${LAYOUT_ATTR}] > #${BTN_ID} {
      position: absolute;
      left: 50%;
      top: 50%;
      margin: 0;
      transform: translate(-50%, -50%);
      z-index: 2;
    }

    [${LAYOUT_ATTR}] > #${BTN_ID}:active {
      transform: translate(-50%, calc(-50% + 1px));
    }

    [${LAYOUT_ATTR}] > [${CONTEXT_ATTR}] {
      left: var(--syncord-context-left);
      right: auto;
      width: var(--syncord-context-width);
      min-width: 0;
      max-width: var(--syncord-context-width);
      justify-content: flex-start;
      overflow: hidden;
    }

    [${LAYOUT_ATTR}] > [${CONTEXT_ATTR}] > * {
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    #${BTN_ID} .dion-titlebar-text {
      position: relative;

      display: inline-flex;
      align-items: center;

      min-width: 0;

      white-space: nowrap;
    }

    /*
     * Tiny underline accent.
     *
     * Normalde görünmez. Hover/focus sırasında çok hafif belirir.
     * Böylece Discord'un titlebar yapısını bozup "button" hissi vermiyor.
     */
    #${BTN_ID} .dion-titlebar-text::after {
      content: "";

      position: absolute;

      left: 50%;
      bottom: -4px;

      width: 14px;
      height: 2px;

      border-radius: 999px;

      background:
        var(
          --brand-500,
          #5865f2
        );

      opacity: 0;

      transform:
        translateX(-50%)
        scaleX(0.45);

      transition:
        opacity 120ms ease,
        transform 150ms cubic-bezier(0.2, 0.8, 0.2, 1);
    }

    #${BTN_ID}:hover {
      color:
        var(
          --header-primary,
          var(--interactive-hover, #f2f3f5)
        );
    }

    #${BTN_ID}:hover .dion-titlebar-text::after,
    #${BTN_ID}:focus-visible .dion-titlebar-text::after {
      opacity: 0.85;

      transform:
        translateX(-50%)
        scaleX(1);
    }

    #${BTN_ID}:active {
      color:
        var(
          --interactive-active,
          #ffffff
        );

      transform: translateY(1px);
    }

    #${BTN_ID}:focus {
      outline: none;
    }

    #${BTN_ID}:focus-visible {
      color:
        var(
          --header-primary,
          #f2f3f5
        );
    }

    /*
     * Discord penceresi çok daraldığında title yazısının chrome'u
     * sıkıştırmasını önle.
     */
    @media (max-width: 720px) {
      #${BTN_ID} {
        margin-left: 6px;
        padding-inline: 5px;

        font-size: 14px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      #${BTN_ID},
      #${BTN_ID} .dion-titlebar-text::after {
        transition: none;
      }
    }

    /* Explicitly hide the icon even when Discord styles spans as flex. */
    #${BTN_ID} ${BADGE_SELECTOR}[hidden] {
      display: none !important;
    }

    #${BTN_ID} ${BADGE_SELECTOR} {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      margin-left: 6px;
      color: var(--brand-500, #5865f2);
      flex-shrink: 0;
      pointer-events: none;
    }

    #${BTN_ID} ${BADGE_SELECTOR} svg {
      display: block;
      width: 16px;
      height: 16px;
    }

    #${BTN_ID} ${BADGE_SELECTOR}[data-dion-state="current"],
    #${BTN_ID} ${BADGE_SELECTOR}[data-dion-state="ready"],
    #${BTN_ID} ${BADGE_SELECTOR}[data-dion-state="restart"] {
      color: #24a058;
    }

    #${BTN_ID} ${BADGE_SELECTOR}[data-dion-state="working"] {
      color: var(--header-secondary, #b5bac1);
    }

    /*
     * The wordmark takes a brighter colour with the update icon, so the mark and the
     * label read as one thing rather than as two adjacent things.
     */
    #${BTN_ID}[data-dion-update-state="offered"],
    #${BTN_ID}[data-dion-update-state="ready"],
    #${BTN_ID}[data-dion-update-state="restart"] {
      color: var(--header-primary, #f2f3f5);
    }
  `;

  document.documentElement.appendChild(style);
}

/**
 * Locate the back/forward group via stable aria-labels (class hashes change).
 */
/**
 * Discord's back/forward buttons, found without depending on the UI language.
 *
 * ## Why this is not a single selector
 *
 * The original version looked for `[aria-label="Go back"]` with a Turkish
 * fallback of `[aria-label="Geri"]`. On this machine Discord's client runs in
 * Turkish, where the labels are **"Geri dön"** and **"İleri git"** — so neither
 * matched, `tryMount()` returned false, and the label never appeared. There was
 * no error: the client was healthy, the plugins were running, and the only
 * symptom was a missing word. `describeChrome()` now prints the real shape
 * instead.
 *
 * This is the same class of bug as incident 004, in a different coordinate: a
 * rule derived from something we do not control (here, a localized string)
 * rather than from something stable, failing silently instead of loudly.
 *
 * Two strategies, in order:
 *
 *  1. **Accessible name**, across the locales we can name. Gets the exact
 *     intended position — immediately after the back/forward pair.
 *  2. **Structure.** `[data-window-chrome="true"]` is a data attribute, not a
 *     class hash and not a translated string, so it survives a build and a
 *     language change. A back/forward pair is the first group of small icon
 *     buttons in the chrome's left region, so the first button of the chrome's
 *     leading flex child is a good approximation and is only used when the name
 *     search has already failed.
 *
 * If both fail, the mount reports why instead of returning false in silence.
 */
export function findBackButton(): HTMLElement | null {
  // English, Turkish, and the locales Discord ships that we can name. A missing
  // entry costs a coarser placement (strategy 2), never a missing label.
  const NAMES = [
    "Go back",
    "Geri dön",
    "Geri",
    "Zurück",
    "Retour",
    "Atrás",
    "Indietro",
    "Voltar",
    "Назад",
    "戻る",
  ];

  for (const name of NAMES) {
    const found = document.querySelector<HTMLElement>(
      `[aria-label="${name.replace(/"/g, '\\"')}"]`,
    );
    if (found !== null) return found;
  }

  return findBackButtonStructurally();
}

/**
 * Locate the leading icon-button group in the titlebar without reading any
 * text.
 *
 * Conservative on purpose: it only looks inside the chrome, and only picks a
 * button that is genuinely a small icon button. Anything ambiguous returns
 * `null`, because placing the label wrongly is worse than placing it coarsely —
 * and the caller reports the failure either way.
 */
function findBackButtonStructurally(): HTMLElement | null {
  const chrome =
    document.querySelector<HTMLElement>('[data-window-chrome="true"]') ??
    document.querySelector<HTMLElement>("header");
  if (chrome === null) return null;

  // Walk the chrome's own descendants, shallowest first, and take the first
  // button in the left-most region. `compareDocumentPosition` gives a stable
  // document order without depending on class names.
  const buttons = [...chrome.querySelectorAll<HTMLElement>("button")];
  if (buttons.length === 0) return null;

  const isIconButton = (el: HTMLElement): boolean => {
    const rect = el.getBoundingClientRect();
    // Back/forward are small and square. A wide control is a search field, a
    // tab strip or a channel name, and inserting relative to one of those would
    // put the label in the wrong place.
    if (rect.width === 0 || rect.height === 0) return false;
    const square = rect.width <= rect.height * 1.6;
    const small = rect.width <= 48;
    return square && small;
  };

  return buttons.find(isIconButton) ?? null;
}

/**
 * The element to insert our label *after* — the shared wrapper around Discord's
 * back/forward pair, so the label lands where it is meant to sit.
 */
function findBackForwardGroup(): HTMLElement | null {
  const back = findBackButton();
  if (back === null) return null;
  return (back.closest('[class*="backForward"]') as HTMLElement | null) ?? back.parentElement;
}

interface TitlebarLayout {
  chrome: HTMLElement;
  group: HTMLElement;
  context: HTMLElement;
  trailing: HTMLElement;
}

/** Discord's native chrome has leading, title and trailing direct children. */
function findTitlebarLayout(group: HTMLElement): TitlebarLayout | null {
  const chrome = group.closest<HTMLElement>('[data-window-chrome="true"]');
  if (chrome === null) return null;

  // Match semantic class prefixes, never a build-specific hash or title text.
  const slot = (name: string): HTMLElement | undefined =>
    [...chrome.children].find((child) =>
      [...child.classList].some((cls) => cls.startsWith(`${name}_`)),
    ) as HTMLElement | undefined;
  const leading = slot("leading");
  const context = slot("title");
  const trailing = slot("trailing");
  if (leading === undefined || context === undefined || trailing === undefined
    || !leading.contains(group)) return null;

  return { chrome, group, context, trailing };
}

function clearTitlebarLayout(layout: TitlebarLayout): void {
  layout.chrome.removeAttribute(LAYOUT_ATTR);
  layout.context.removeAttribute(CONTEXT_ATTR);
  layout.chrome.style.removeProperty("--syncord-context-left");
  layout.chrome.style.removeProperty("--syncord-context-width");
}

/** Reserve only the space between navigation and the centered settings button. */
function positionTitlebarContext(layout: TitlebarLayout, btn: HTMLElement): void {
  const bar = layout.chrome.getBoundingClientRect();
  const navigation = layout.group.getBoundingClientRect();
  const button = btn.getBoundingClientRect();
  const start = Math.max(0, navigation.right - bar.left + 10);
  const width = Math.max(0, button.left - bar.left - start - 12);
  // ResizeObserver can fire after these writes; avoid a mutation/resize loop.
  const set = (name: string, value: number): void => {
    const next = `${Math.round(value * 100) / 100}px`;
    if (layout.chrome.style.getPropertyValue(name) !== next) {
      layout.chrome.style.setProperty(name, next);
    }
  };
  set("--syncord-context-left", start);
  set("--syncord-context-width", width);
}

/**
 * Why the label could not be placed, in words a reader can act on.
 *
 * The mount used to fail silently: `tryMount()` returned false, the 500 ms retry
 * loop kept returning false, and the log said nothing at all. The result was a
 * client that worked perfectly with no visible sign that Syncord was present.
 * A retry loop that cannot report why it is failing is a loop that hides a bug
 * for as long as it is willing to keep trying.
 */
function describeAnchorFailure(): string {
  const back = findBackButton();
  if (back === null) {
    return i18nText("ui.no_back_forward_anchor_found_value", {v0: describeChrome()});
  }
  const group = (back.closest('[class*="backForward"]') as HTMLElement | null) ?? back.parentElement;
  if (group === null) {
    return i18nText("ui.back_forward_button_found_but_it_has_no_parent_element_to_insert_after");
  }
  let display = "?";
  let visibility = "?";
  try {
    const style = getComputedStyle(group);
    display = style.display;
    visibility = style.visibility;
  } catch {
    /* detached */
  }
  if (group.parentElement === null) {
    return `anchor group <${group.tagName.toLowerCase()}> is itself detached (display=${display} visibility=${visibility})`;
  }
  return i18nText("ui.anchor_group_found_but_insertion_was_rejected_display_value_visibility", {v0: display, v1: visibility});
}

/**
 * A structural description of Discord's titlebar, for the boot log.
 *
 * When a selector stops matching, guessing at the replacement in a loop is how
 * this broke in the first place — the accessible names are localised, so an
 * English selector matches nothing on a Turkish client and there is no error to
 * notice. Printing the actual shape turns the next failure into a one-line fix.
 *
 * Reports tag names, a class-name *shape* (hashes collapsed, since Discord
 * rotates them every build), and accessible names. No user content, no settings.
 */
function describeChrome(): string {
  const chrome =
    document.querySelector<HTMLElement>('[data-window-chrome="true"]') ??
    document.querySelector<HTMLElement>('header');

  const labels = [...document.querySelectorAll("[aria-label]")]
    .map((el) => el.getAttribute("aria-label") ?? "")
    .filter((value) => value.length > 0)
    .slice(0, 12);

  if (chrome === null) {
    return `${i18nHtml("ui.no_data_window_chrome_true_and_no")} <header>; aria-labels: ${JSON.stringify(labels)}`;
  }

  const shape = (el: Element, depth: number): string => {
    // Discord's class hashes change every build, so keep only the stable
    // leading name and the tag.
    const cls = [...el.classList]
      .map((c) => c.split("-")[0])
      .filter((c) => /^[a-zA-Z]{3,}$/.test(c))
      .slice(0, 3)
      .join(".");
    const id = el.id !== "" ? `#${el.id}` : "";
    const self = `${el.tagName.toLowerCase()}${id}${cls !== "" ? `.${cls}` : ""}`;
    if (depth <= 0) return self;
    const kids = [...el.children].slice(0, 4).map((c) => shape(c, depth - 1));
    return `${self}[${kids.join(" ")}]`;
  };

  return `chrome=${shape(chrome, 2)}; aria-labels: ${JSON.stringify(labels)}`;
}

function createButton(): HTMLButtonElement {
  const btn = document.createElement("button");

  btn.id = BTN_ID;
  btn.type = "button";
  setLocalizedAttribute(btn, "aria-label", "ui.open_syncord_settings");

  const text = document.createElement("span");
  text.className = "dion-titlebar-text";
  text.textContent = i18nText("ui.syncord");

  const badge = document.createElement("span");
  badge.className = "dion-titlebar-update";
  badge.setAttribute(BADGE_ATTR, "");
  badge.setAttribute("aria-hidden", "true");
  badge.hidden = true;

  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "16");
  icon.setAttribute("height", "16");
  icon.setAttribute("focusable", "false");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", UPDATE_ICON_PATH);
  icon.appendChild(path);
  badge.appendChild(icon);

  btn.append(text, badge);

  // A function, not a string: the sentence changes when a release is found, and
  // re-binding on every status change would add a listener per change. The
  // tooltip reads the state when it is about to be shown, so it can never
  // describe a version that has already been superseded.
  bindTooltip(btn, () => {
    if(btn.dataset.syncordTitlebarLabel)return '';
    const { state, version } = currentBadge();
    const message = badgeMessage(state, version);
    return message === null ? i18nText("ui.open_syncord_settings") : i18nText("ui.value_open_settings", {v0: message});
  }, {
    position: "bottom",
    delay: 250,
  });

  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();

    // Keep the update visible until the updater reports it resolved.
    openSettings();
  });

  return btn;
}

function tryMount(): boolean {
  if (document.getElementById(BTN_ID)) return true;

  const group = findBackForwardGroup();
  if (group === null || group.parentElement === null) {
    // Say *why*. Previously this returned false in silence and the label simply
    // never appeared, with a perfectly healthy client and no explanation.
    //
    // Throttled, because the retry loop calls this twice a second for thirty
    // seconds: sixty identical warnings would bury the one line that matters.
    const now = Date.now();
    if (now - lastFailureReport > 2_000) {
      lastFailureReport = now;
      log.warn(`titlebar button not mounted: ${describeAnchorFailure()}`);
    }
    return false;
  }

  ensureCss();

  const btn = createButton();

  // Görseldeki gibi back / forward oklarının hemen sonrasına yerleşir.
  group.insertAdjacentElement("afterend", btn);

  // A button built now has to show the state that already exists. The first
  // status change is twenty seconds away, and a release that was found before
  // the titlebar mounted would otherwise be silent until the next check — six
  // hours away, by which point the user has long since concluded there is no
  // update.
  paintUpdateBadge();
  attachAddon(btn);

  lastFailureReport = 0;
  log.info("titlebar button mounted");

  return true;
}

/** Keep the native context on the left and Syncord centered across re-renders. */
export function installTitlebarButton(): () => void {
  ensureCss();

  let raf = 0;
  let activeLayout: TitlebarLayout | null = null;
  let observedButton: HTMLElement | null = null;
  const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => schedule());

  const maintainLayout = (): boolean => {
    if (!tryMount()) return false;
    const btn = document.getElementById(BTN_ID);
    const group = findBackForwardGroup();
    if (btn === null || group === null) return false;
    if(addon && btn.tagName === 'BUTTON')attachAddon(btn as HTMLButtonElement);
    const layout = findTitlebarLayout(group);

    if (activeLayout !== null && (layout === null
      || activeLayout.chrome !== layout.chrome || activeLayout.context !== layout.context
      || activeLayout.group !== layout.group || activeLayout.trailing !== layout.trailing)) {
      clearTitlebarLayout(activeLayout);
      resizeObserver?.disconnect();
      observedButton = null;
      activeLayout = null;
    }
    if (layout === null) {
      // A changed/older chrome can still expose settings beside navigation.
      if (btn.parentElement !== group.parentElement) group.insertAdjacentElement("afterend", btn);
      return true;
    }

    if (btn.parentElement !== layout.chrome) layout.chrome.appendChild(btn);
    if (activeLayout === null) {
      activeLayout = layout;
      layout.chrome.setAttribute(LAYOUT_ATTR, "");
      layout.context.setAttribute(CONTEXT_ATTR, "");
      resizeObserver?.observe(layout.chrome);
      resizeObserver?.observe(layout.group);
      resizeObserver?.observe(layout.trailing);
      log.info("titlebar layout: context left, Syncord centered");
    }
    // Discord may have replaced only our button, leaving the other slots intact.
    if (observedButton !== btn) {
      if (observedButton !== null) resizeObserver?.unobserve(observedButton);
      resizeObserver?.observe(btn);
      observedButton = btn;
    }
    positionTitlebarContext(layout, btn);
    return true;
  };

  const schedule = (): void => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      maintainLayout();
    });
  };

  maintainLayout();

  const observer = new BodyMutationObserver((records) => {
    if (activeLayout === null || !activeLayout.chrome.isConnected
      || document.getElementById(BTN_ID) === null
      || records.some((record) => activeLayout?.chrome.contains(record.target))) schedule();
  });
  // Observe the stable parent as well, so replacing the whole chrome is detected.
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", schedule);

  const bootTries = window.setInterval(() => {
    if (maintainLayout()) window.clearInterval(bootTries);
  }, 500);
  const bootTimeout = window.setTimeout(() => window.clearInterval(bootTries), 30_000);

  const unsubscribe = onUpdate(() => {
    const previousState = lastPaintedState;
    paintUpdateBadge();
    // Recalculate on badge changes, not on the updater's unchanged 400ms polls.
    if (activeLayout !== null && previousState !== lastPaintedState) schedule();
  });

  return () => {
    disposeAddon?.();disposeAddon=undefined;addonButton=undefined;
    observer.disconnect();
    resizeObserver?.disconnect();
    window.removeEventListener("resize", schedule);
    unsubscribe();
    window.clearInterval(bootTries);
    window.clearTimeout(bootTimeout);
    if (raf) cancelAnimationFrame(raf);
    if (activeLayout !== null) clearTitlebarLayout(activeLayout);
    document.getElementById(BTN_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
  };
}
