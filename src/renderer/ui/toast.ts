import { createLogger } from "../api/logger";
import { css } from "../api/css";
import { getRequire } from "../webpack";

const log = createLogger("toast");

/**
 * Discord's toast types. `show` renders them with the client's own toast
 * (icon, motion, colors). Strings match the enums in the client bundle.
 */
export const ToastType = {
  MESSAGE: "message",
  SUCCESS: "success",
  FAILURE: "failure",
  CUSTOM: "custom",
  CLIP: "clip",
  LINK: "link",
  FORWARD: "forward",
  INVITE: "invite",
  BOOKMARK: "bookmark",
  CLOCK: "clock",
  AI: "ai",
  FAVORITE: "favorite",
} as const;

export type ToastTypeName = (typeof ToastType)[keyof typeof ToastType];

export type ToastOptions = {
  type?: ToastTypeName;
  /** Discord's own default is the top of the window. */
  position?: "top" | "bottom";
  /** Milliseconds. Discord's default is 3000. */
  duration?: number;
};

type NativeToast = {
  // Current Discord's dispatcher passes these flat props to its toast renderer.
  text: string;
  variant: "default" | "success" | "critical";
  position: "top" | "bottom";
  duration: number;
  surface: "app";
  // Older desktop bundles still consume the legacy message/type/options shape.
  message: string;
  id: string;
  type: string;
  options?: {
    position?: number;
    duration?: number;
    component?: null;
  };
};

type NativeShow = (toast: NativeToast) => void;
type NativePop = (appContext?: unknown) => void;

const POSITION = { top: 0, bottom: 1 } as const;

let nativeShow: NativeShow | undefined;
let nativePop: NativePop | undefined;
let scannedFactories = false;

function sourceOf(fn: unknown): string {
  try {
    return Function.prototype.toString.call(fn);
  } catch {
    return "";
  }
}

function findIn(root: unknown, needle: string, exclude?: unknown): ((...args: unknown[]) => unknown) | undefined {
  if (root !== exclude && typeof root === "function" && sourceOf(root).includes(needle)) {
    return root as (...args: unknown[]) => unknown;
  }
  if (!root || typeof root !== "object") return undefined;
  for (const key of Object.keys(root as object)) {
    let value: unknown;
    try {
      value = (root as Record<string, unknown>)[key];
    } catch {
      continue;
    }
    if (value !== exclude && typeof value === "function" && sourceOf(value).includes(needle)) {
      return value as (...args: unknown[]) => unknown;
    }
  }
  return undefined;
}

function moduleWith(needle: string): unknown {
  const req = getRequire();
  if (!req) return undefined;

  if (req.c) {
    for (const id of Object.keys(req.c)) {
      const exports = req.c[id]?.exports;
      if (findIn(exports, needle)) return exports;
    }
  }

  if (scannedFactories || !req.m) return undefined;
  scannedFactories = true;

  for (const id of Object.keys(req.m)) {
    const factory = req.m[id];
    if (typeof factory !== "function") continue;
    if (!sourceOf(factory).includes(needle)) continue;
    try {
      return req(id);
    } catch (err) {
      log.error("toast module:", err);
      return undefined;
    }
  }
  return undefined;
}

function bindNative(): void {
  if (nativeShow) return;
  const exports = moduleWith(".currentToastMap.has(");
  const show = findIn(exports, ".currentToastMap.has(");
  if (!show) return;
  nativeShow = show as NativeShow;
  // Both show and pop reference the queue; never bind show as the dismiss API.
  const pop = findIn(exports, "queuedToastsMap", show);
  if (pop) nativePop = pop as NativePop;
}

function showFallback(message: string, type: ToastTypeName, position: "top" | "bottom", duration: number): void {
  css.inject(
    "toast-style",
    `
    #Syncord-toast {
      position: fixed;
      left: 50%;
      z-index: 100003;
      display: flex;
      align-items: center;
      gap: 8px;
      max-width: min(480px, calc(100vw - 32px));
      margin: 0;
      padding: 10px 16px 10px 12px;
      border-radius: 8px;
      background: var(--background-floating);
      color: var(--text-default);
      box-shadow: var(--shadow-high);
      font-family: var(--font-primary);
      font-size: 16px;
      font-weight: 400;
      line-height: 20px;
      pointer-events: none;
      transform: translateX(-50%);
    }
    #Syncord-toast[data-position="top"] { top: 16px; }
    #Syncord-toast[data-position="bottom"] { bottom: 16px; }
    #Syncord-toast[data-type="success"] svg { color: var(--status-positive); }
    #Syncord-toast[data-type="failure"] svg { color: var(--text-danger); }
    `,
  );

  let host = document.getElementById("Syncord-toast");
  if (!host) {
    host = document.createElement("div");
    host.id = "Syncord-toast";
    host.setAttribute("role", "status");
    document.body.appendChild(host);
  }
  host.dataset.position = position;
  host.dataset.type = type;
  host.replaceChildren();
  if (type === ToastType.SUCCESS || type === ToastType.FAILURE) {
    host.appendChild(toastIcon(type === ToastType.SUCCESS));
  }
  const text = document.createElement("span");
  text.textContent = message;
  host.append(text);

  const token = String(Date.now());
  host.dataset.token = token;
  window.setTimeout(() => {
    if (host?.dataset.token === token) host.remove();
  }, duration);
}

function toastIcon(success: boolean): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "20");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute(
    "d",
    success
      ? "M9.7 16.2 5.5 12l1.4-1.4 2.8 2.8 7.4-7.4L18.5 7.4 9.7 16.2Z"
      : "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 13h-2v-2h2v2Zm0-4h-2V7h2v4Z",
  );
  svg.appendChild(path);
  return svg;
}

/** Show a Discord toast. Safe to call from any plugin. */
export function showToast(message: string, options: ToastOptions = {}): void {
  const type = options.type ?? ToastType.MESSAGE;
  const position = options.position ?? "top";
  const duration = options.duration ?? 3000;

  bindNative();
  const covered =
    document.getElementById("Syncord-settings-root")?.isConnected === true ||
    document.getElementById("Syncord-log-root")?.isConnected === true;
  if (nativeShow && !covered) {
    try {
      nativeShow({
        text: message,
        variant: type === ToastType.SUCCESS ? "success" : type === ToastType.FAILURE ? "critical" : "default",
        position,
        duration,
        surface: "app",
        message,
        id: (Math.random() || Math.random()).toString(36).slice(2),
        type,
        options: {
          position: POSITION[position],
          duration,
          component: null,
        },
      });
      return;
    } catch (error) {
      log.warn("native toast unavailable, using fallback", error);
    }
  }

  if (!nativeShow) log.warn("native toast missing, using fallback");
  showFallback(message, type, position, duration);
}

/** Dismiss the current Discord toast. */
export function popToast(): void {
  bindNative();
  try {
    nativePop?.();
  } catch (error) {
    log.warn("native toast dismissal unavailable", error);
  } finally {
    document.getElementById("Syncord-toast")?.remove();
  }
}

export const toast = {
  show: showToast,
  pop: popToast,
  Type: ToastType,
};
