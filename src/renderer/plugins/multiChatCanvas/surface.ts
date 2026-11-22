import {BodyMutationObserver} from "../../ui/bodyObserver";
function isNativeOverlay(element: Element): boolean {
  return element.hasAttribute("data-popover-layer") || element.classList.contains("dion-mc-native-picker-host") ||
    Array.from(element.classList).some(name => /^layerContainer(?:_|$)/.test(name));
}

/** Hide only background branches. Native portals can share an ancestor with
 * the chat; making that ancestor inert also disables every menu it portals. */
function coverBackground(base: HTMLElement, root: HTMLElement): { update(): void; restore(): void } {
  const saved = new Map<HTMLElement, { inert: boolean; classes: string[] }>();
  const flags = ["dion-mc-covered-content", "dion-mc-native-overlay-path", "dion-mc-native-overlay-static-path", "dion-mc-exposed-native-overlay"];
  const remember = (element: HTMLElement) => {
    if (!saved.has(element)) saved.set(element, { inert: element.inert, classes: flags.filter(name => element.classList.contains(name)) });
  };
  const restore = () => {
    for (const [element, previous] of saved) {
      element.inert = previous.inert;
      element.classList.remove(...flags);
      element.classList.add(...previous.classes);
    }
    saved.clear();
  };
  const update = () => {
    restore();
    const overlays = Array.from(base.querySelectorAll('[data-popover-layer], [class*="layerContainer"], .dion-mc-native-picker-host')).filter(isNativeOverlay);
    const paths = new Set<Element>();
    for (const overlay of overlays) for (let parent = overlay.parentElement; parent && parent !== base; parent = parent.parentElement) paths.add(parent);
    const cover = (element: HTMLElement) => {
      if (element === root) return;
      remember(element);
      if (isNativeOverlay(element)) { element.classList.add("dion-mc-exposed-native-overlay"); return; }
      element.classList.add("dion-mc-covered-content");
      if (paths.has(element)) {
        element.classList.add("dion-mc-native-overlay-path");
        if (getComputedStyle(element).position === "static") element.classList.add("dion-mc-native-overlay-static-path");
        for (const child of Array.from(element.children)) if (child instanceof HTMLElement) cover(child);
      } else element.inert = true;
    };
    for (const child of Array.from(base.children)) if (child instanceof HTMLElement) cover(child);
  };
  update();
  return { update, restore };
}

/** Keep Canvas inside Discord's base layer, below native modal/popout siblings. */
export function mountCanvasSurface(root: HTMLElement, onDetached: () => void): () => void {
  let candidates: Element[] = [];
  try {
    const styles = window.Syncord?.webpack?.findByProps("baseLayer", "layer") as { baseLayer?: unknown } | undefined;
    if (typeof styles?.baseLayer === "string" && styles.baseLayer.trim()) {
      candidates = Array.from(document.getElementsByClassName(styles.baseLayer));
    }
  } catch { /* The visible semantic class fallback also works during module startup. */ }
  if (!candidates.length) {
    candidates = Array.from(document.querySelectorAll('[class*="baseLayer"]'))
      .filter(el => Array.from(el.classList).some(name => /^baseLayer(?:_|$)/.test(name)));
  }
  const base = candidates.find((el): el is HTMLElement => {
    if (!(el instanceof HTMLElement)) return false;
    const bounds = el.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0;
  });
  const host = base ?? document.getElementById("app-mount") ?? document.body;
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const positioned = getComputedStyle(host).position === "static" && host !== document.body;
  if (positioned) host.classList.add("dion-mc-surface-host");
  root.dataset.surface = base ? "native" : "fallback";
  if (!base) window.Syncord?.logger?.warn?.("MultiChat: native base layer unavailable; using app surface fallback.");
  const background = base ? coverBackground(base, root) : undefined;
  if (base) base.classList.add("dion-mc-native-surface-host");
  host.append(root);
  const updateBounds = () => {
    const chrome = document.querySelector<HTMLElement>('[data-window-chrome="true"]');
    const bounds = host.getBoundingClientRect();
    const chromeBounds = chrome?.getBoundingClientRect();
    root.style.top = `${chromeBounds && chromeBounds.height > 0 && chromeBounds.height <= 80 ? Math.max(0, chromeBounds.bottom - bounds.top) : 0}px`;
  };
  updateBounds();
  const resize = new ResizeObserver(updateBounds);
  resize.observe(host);
  const chrome = document.querySelector('[data-window-chrome="true"]');
  if (chrome) resize.observe(chrome);
  window.addEventListener("resize", updateBounds);
  const detached = new BodyMutationObserver(records => {
    if (!root.isConnected) { onDetached(); return; }
    // Portal containers may mount lazily after Canvas opened. Most mutations
    // are messages/editor text; only re-cover when a native layer changed.
    if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element &&
      (isNativeOverlay(node) || Array.from(node.querySelectorAll('[data-popover-layer], [class*="layerContainer"], .dion-mc-native-picker-host')).some(isNativeOverlay))))) background?.update();
  });
  detached.observe(document.body, { childList: true, subtree: true });
  return () => {
    resize.disconnect();
    detached.disconnect();
    window.removeEventListener("resize", updateBounds);
    background?.restore();
    base?.classList.remove("dion-mc-native-surface-host");
    if (positioned) host.classList.remove("dion-mc-surface-host");
    root.remove();
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  };
}
