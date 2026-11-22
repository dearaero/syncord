import {onLocaleChange, getDirection, getLocale} from '../i18n/core';
import { css } from "../api/css";

export type TooltipPosition = "top" | "bottom" | "left" | "right";

export type TooltipOptions = {
  position?: TooltipPosition;
  /** Milliseconds before the popup opens. Discord's icon tips use `0`. */
  delay?: number;
};

const HOST_ID = "Syncord-tooltip";
const GAP = 8;

// Keep the behaviour deliberately tiny: one shared tooltip host is reused for
// every bound element. The visuals below mirror Syncord's modern settings UI.
type Binding = {
  text: string | (() => string);
  position: TooltipPosition;
  delay: number;
  timer: number;
  dispose?: () => void;
};

const bindings = new WeakMap<HTMLElement, Binding>();

let host: HTMLDivElement | undefined;
let pointer: HTMLDivElement | undefined;
let label: HTMLDivElement | undefined;
let current: HTMLElement | undefined;
let pending: HTMLElement | undefined;
let styled = false;
let watching = false;

function ensureStyle(): void {
  if (styled) return;
  styled = true;

  css.inject(
    "tooltip",
    `
    #${HOST_ID} {
      --dion-tip-bg: color-mix(
        in srgb,
        var(--background-base-lowest, #111214) 94%,
        transparent
      );
      --dion-tip-border: color-mix(
        in srgb,
        var(--border-subtle, #ffffff) 11%,
        transparent
      );
      --dion-tip-text: var(--text-default, var(--text-normal, #f2f3f5));

      position: fixed;
      z-index: 100010;

      width: max-content;
      max-width: min(280px, calc(100vw - 16px));
      padding: 7px 10px;

      border: 1px solid var(--dion-tip-border);
      border-radius: 9px;

      background: var(--dion-tip-bg);
      color: var(--dion-tip-text);

      box-shadow:
        0 10px 30px rgba(0, 0, 0, 0.36),
        0 2px 8px rgba(0, 0, 0, 0.22),
        inset 0 1px 0 rgba(255, 255, 255, 0.035);

      -webkit-backdrop-filter: blur(14px) saturate(1.05);
      backdrop-filter: blur(14px) saturate(1.05);

      font-family:
        "gg sans",
        var(--font-primary),
        "Noto Sans",
        "Helvetica Neue",
        Helvetica,
        Arial,
        sans-serif;
      font-size: 12px;
      font-weight: 600;
      line-height: 16px;
      letter-spacing: 0.005em;
      text-align: center;

      box-sizing: border-box;
      pointer-events: none;
      user-select: none;

      opacity: 0;
      visibility: hidden;
      transform: scale(0.98);
      transform-origin: center;

      will-change: opacity, transform;

      transition:
        opacity 110ms ease,
        transform 140ms cubic-bezier(0.2, 0.8, 0.2, 1),
        visibility 0s linear 140ms;
    }

    #${HOST_ID}[data-open="measure"] {
      visibility: hidden;
      opacity: 0;
      transform: none;
      transition: none;
    }

    #${HOST_ID}[data-open="true"] {
      visibility: visible;
      opacity: 1;
      transform: translate3d(0, 0, 0) scale(1);
      transition:
        opacity 110ms ease,
        transform 140ms cubic-bezier(0.2, 0.8, 0.2, 1),
        visibility 0s linear 0s;
    }

    #${HOST_ID}[data-open="false"][data-position="top"] {
      transform: translateY(3px) scale(0.98);
    }

    #${HOST_ID}[data-open="false"][data-position="bottom"] {
      transform: translateY(-3px) scale(0.98);
    }

    #${HOST_ID}[data-open="false"][data-position="left"] {
      transform: translateX(3px) scale(0.98);
    }

    #${HOST_ID}[data-open="false"][data-position="right"] {
      transform: translateX(-3px) scale(0.98);
    }

    #${HOST_ID} .dion-tooltip-label {
      position: relative;
      z-index: 1;
      overflow-wrap: anywhere;
      text-wrap: pretty;
    }

    /*
     * Modern Discord-style diamond pointer.
     * It uses the same surface + subtle border as the tooltip body instead of
     * the older triangle-arrow look.
     */
    #${HOST_ID} .dion-tooltip-pointer {
      position: absolute;
      z-index: 0;

      width: 8px;
      height: 8px;

      background: var(--dion-tip-bg);
      pointer-events: none;
    }

    #${HOST_ID}[data-position="top"] .dion-tooltip-pointer {
      bottom: -5px;
      border-right: 1px solid var(--dion-tip-border);
      border-bottom: 1px solid var(--dion-tip-border);
      transform: translateX(-50%) rotate(45deg);
    }

    #${HOST_ID}[data-position="bottom"] .dion-tooltip-pointer {
      top: -5px;
      border-left: 1px solid var(--dion-tip-border);
      border-top: 1px solid var(--dion-tip-border);
      transform: translateX(-50%) rotate(45deg);
    }

    #${HOST_ID}[data-position="left"] .dion-tooltip-pointer {
      right: -5px;
      border-right: 1px solid var(--dion-tip-border);
      border-top: 1px solid var(--dion-tip-border);
      transform: translateY(-50%) rotate(45deg);
    }

    #${HOST_ID}[data-position="right"] .dion-tooltip-pointer {
      left: -5px;
      border-left: 1px solid var(--dion-tip-border);
      border-bottom: 1px solid var(--dion-tip-border);
      transform: translateY(-50%) rotate(45deg);
    }

    @media (prefers-reduced-motion: reduce) {
      #${HOST_ID} {
        transition: none;
        transform: none !important;
      }
    }
    `,
  );
}

function ensureHost(): void {
  ensureStyle();
  if (host?.isConnected && pointer && label) return;

  host = document.createElement("div");
  host.id = HOST_ID;
  host.setAttribute("role", "tooltip");
  host.dataset.open = "false";

  pointer = document.createElement("div");
  pointer.className = "dion-tooltip-pointer";
  pointer.setAttribute("aria-hidden", "true");

  label = document.createElement("div");
  label.className = "dion-tooltip-label";

  host.append(pointer, label);
  document.body.appendChild(host);

  if (watching) return;
  watching = true;
  window.addEventListener("scroll", () => {
    // Keyboard focus may scroll a control into view after its focus event.
    const focusedPending = pending === document.activeElement ? pending : undefined;
    hideTooltip();
    if (focusedPending?.isConnected) schedule(focusedPending);
  }, true);
  window.addEventListener("resize", () => hideTooltip());
}

function textOf(binding: Binding): string {
  const value = typeof binding.text === "function" ? binding.text() : binding.text;
  return value.trim();
}

function place(anchor: HTMLElement, preferred: TooltipPosition): void {
  if (!host || !pointer) return;

  host.dataset.position = preferred;
  host.style.left = "0px";
  host.style.top = "0px";

  const tip = host.getBoundingClientRect();
  const box = anchor.getBoundingClientRect();

  let position = preferred;
  let left = 0;
  let top = 0;

  if (preferred === "top" || preferred === "bottom") {
    left = box.left + box.width / 2 - tip.width / 2;
    top = preferred === "top" ? box.top - tip.height - GAP : box.bottom + GAP;

    if (preferred === "top" && top < 8) {
      position = "bottom";
      top = box.bottom + GAP;
    } else if (preferred === "bottom" && top + tip.height > window.innerHeight - 8) {
      position = "top";
      top = box.top - tip.height - GAP;
    }

    left = Math.max(8, Math.min(left, window.innerWidth - tip.width - 8));

    top = Math.max(8, Math.min(top, window.innerHeight - tip.height - 8));
    host.dataset.position = position;
    host.style.left = `${Math.round(left)}px`;
    host.style.top = `${Math.round(top)}px`;

    pointer.style.left = `${Math.round(box.left + box.width / 2 - left)}px`;
    pointer.style.top = "";
    return;
  }

  top = box.top + box.height / 2 - tip.height / 2;
  left = preferred === "left" ? box.left - tip.width - GAP : box.right + GAP;

  if (preferred === "left" && left < 8) {
    position = "right";
    left = box.right + GAP;
  } else if (preferred === "right" && left + tip.width > window.innerWidth - 8) {
    position = "left";
    left = box.left - tip.width - GAP;
  }

  top = Math.max(8, Math.min(top, window.innerHeight - tip.height - 8));

  host.dataset.position = position;
  host.style.left = `${Math.round(left)}px`;
  host.style.top = `${Math.round(top)}px`;

  pointer.style.top = `${Math.round(box.top + box.height / 2 - top)}px`;
  pointer.style.left = "";
}

function open(anchor: HTMLElement): void {
  if(pending===anchor)pending=undefined;
  const binding = bindings.get(anchor);
  if (!binding || !anchor.isConnected) return;

  try { if(anchor.matches('select:open')) return; } catch { /* Older Chromium lacks :open. */ }
  const box = anchor.getBoundingClientRect();
  if (box.bottom <= 0 || box.top >= window.innerHeight || box.right <= 0 || box.left >= window.innerWidth) return;

  const text = textOf(binding);
  if (!text) return;

  ensureHost();
  if (!host || !label) return;

  label.textContent = text;
  host.lang=getLocale();host.dir=getDirection();
  current = anchor;

  // Measure at the final unscaled size so positioning stays pixel-perfect while
  // still allowing the tooltip to animate in/out.
  host.dataset.open = "measure";
  place(anchor, binding.position);

  void host.offsetWidth;
  host.dataset.open = "true";
}

function schedule(anchor: HTMLElement): void {
  const binding = bindings.get(anchor);
  if (!binding) return;
  if(pending&&pending!==anchor){const previous=bindings.get(pending);if(previous)window.clearTimeout(previous.timer);}
  pending=anchor;

  window.clearTimeout(binding.timer);
  binding.timer = window.setTimeout(() => open(anchor), binding.delay);
}

function cancel(anchor: HTMLElement): void {
  const binding = bindings.get(anchor);
  if (binding) window.clearTimeout(binding.timer);
  hideTooltip(anchor);
}

/** Close the shared popup. Pass an anchor to ignore hides from other elements. */
export function hideTooltip(anchor?: HTMLElement): void {
  if(pending&&(!anchor||pending===anchor)){
    const binding=bindings.get(pending);if(binding)window.clearTimeout(binding.timer);pending=undefined;
  }
  if (anchor && current !== anchor) return;

  current = undefined;
  if (host) host.dataset.open = "false";
}

/**
 * Show Syncord's tooltip on hover and focus.
 * Returns a remover. Safe to call again after the node is recreated.
 */
export function bindTooltip(
  anchor: HTMLElement,
  text: string | (() => string),
  options: TooltipOptions = {},
): () => void {
  const previous = bindings.get(anchor);
  previous?.dispose?.();

  const binding: Binding = {
    text,
    position: options.position ?? "top",
    delay: options.delay ?? 0,
    timer: 0,
  };

  bindings.set(anchor, binding);
  ensureHost();

  if (!anchor.getAttribute("aria-describedby")) {
    anchor.setAttribute("aria-describedby", HOST_ID);
  }

  const enter = () => schedule(anchor);
  const leave = () => cancel(anchor);

  anchor.addEventListener("mouseenter", enter);
  anchor.addEventListener("mouseleave", leave);
  anchor.addEventListener("focus", enter);
  anchor.addEventListener("blur", leave);
  if(document.activeElement===anchor)schedule(anchor);

  let disposed=false;
  const dispose=():void => {
    if(disposed)return;disposed=true;
    if(pending===anchor)pending=undefined;
    window.clearTimeout(binding.timer);
    anchor.removeEventListener("mouseenter", enter);
    anchor.removeEventListener("mouseleave", leave);
    anchor.removeEventListener("focus", enter);
    anchor.removeEventListener("blur", leave);
    if(bindings.get(anchor)===binding){
      bindings.delete(anchor);
      if(anchor.getAttribute("aria-describedby")===HOST_ID)anchor.removeAttribute("aria-describedby");
    }

    if (current === anchor) hideTooltip();
  };
  binding.dispose=dispose;return dispose;
}

export const tooltip = {
  bind: bindTooltip,
  hide: hideTooltip,
};

// Label attributes are localized by sibling subscribers in the same dispatch.
// Read them after all subscribers finish, including when a tooltip is open.
onLocaleChange(()=>{queueMicrotask(()=>{if(current)open(current);});});
