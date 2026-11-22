import { setLocalizedAttribute } from "../../i18n";
import { stickerUrl } from "./mediaDiscord";
import type { StickerLike } from "./types";

type Root = { render(node: unknown): void; unmount(): void };
type ReactLike = {
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown;
  Component: new (props: { children?: unknown }) => { props: { children?: unknown }; state: { failed?: boolean } };
};
const mounted = new Map<HTMLElement, Root>();

export function clearStickerPreviews(scope: HTMLElement): void {
  for (const [element, root] of mounted) {
    if (element === scope || scope.contains(element)) {
      root.unmount();
      mounted.delete(element);
    }
  }
}

export function renderStickerPreview(host: HTMLElement, sticker: StickerLike, size: number): void {
  clearStickerPreviews(host);
  host.replaceChildren();
  if (sticker.format_type !== 3) {
    const image = document.createElement("img");
    image.src = stickerUrl(sticker); image.alt = sticker.name; image.loading = "lazy";
    image.addEventListener("error", () => { host.textContent = sticker.name; }, {once:true});
    host.append(image);
    return;
  }
  // Lottie assets are JSON, not PNGs. Reuse Discord's canvas/worker renderer.
  const react = window.Syncord?.common?.react?.React as ReactLike | undefined;
  const rootFactory = window.Syncord?.webpack.findByProps("createRoot") as { createRoot?: (element: HTMLElement) => Root } | undefined;
  const component = window.Syncord?.webpack.find(value => {
    if (typeof value !== "function") return false;
    const source = Function.prototype.toString.call(value);
    return ["enlargeOnInteraction", "assetData", "format_type"].every(part => source.includes(part));
  });
  if (!react?.Component || !rootFactory?.createRoot || !component) {
    host.textContent = sticker.name;
    setLocalizedAttribute(host, "title", "ui.animated_preview_is_not_available_yet_this_sticker_can_still_be_sent");
    return;
  }
  class Boundary extends react.Component {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    render() { return this.state.failed ? sticker.name : this.props.children; }
  }
  try {
    const root = rootFactory.createRoot(host);
    mounted.set(host, root);
    root.render(react.createElement(Boundary, null, react.createElement(component, {
      sticker, size, isInteracting:true, enlargeOnInteraction:false,
      disableAnimation:window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    })));
  } catch {
    clearStickerPreviews(host);
    host.textContent = sticker.name;
  }
}
