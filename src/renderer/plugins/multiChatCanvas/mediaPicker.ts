import {NATIVE_PICKER_CSS} from "../../chat/nativePickerStyles";
import {bindExpressionSurface,registerExpressionDraft} from '../../chat/expressionDraft';
import { t as i18nText } from "../../i18n";
import { createLogger } from "../../api/logger";
import { componentSource, reactNs, rootFactory, type ReactNs, type Root } from "../../discordKit";
import { registerCanvasDialog } from "./dialog";
import { getChannel } from "./discord";
import { emojiText, safeMediaUrl } from "./mediaDiscord";
import type { StickerLike } from "./types";

export type PickerKind = "Emoji" | "GIF" | "Stickers";
type PickerState = {
  activeView: string | null;
  activeViewType: unknown;
  activeChannelId: string | null;
  searchQuery: string;
};
type PickerStore = {
  getState(): PickerState;
  setState(state: Partial<PickerState>): void;
  subscribe(listener: (state: PickerState) => void): () => void;
};
type NativeReact = ReactNs & {
  Component: new (props: { children?: unknown }) => { props: { children?: unknown }; state: { failed: boolean } };
};
const log = createLogger("multichat-native-picker");


function nativePicker(): unknown {
  return window.Syncord?.webpack?.find(value => {
    const source = componentSource(value);
    return ["positionTargetRef", "onSelectGIF", "onSelectEmoji", "onSelectSticker", "hideGifFavorites"].every(signal => source.includes(signal));
  });
}
function nativeLayers(): { provider: unknown; container: unknown } | undefined {
  // Expression Picker's PositionLayer portals through App's layer context.
  // A separate React root does not inherit Discord's existing provider.
  const module = window.Syncord?.webpack?.find(value => {
    if (!value || typeof value !== "object") return false;
    const names = Object.values(value).map(item => (item as { displayName?: string } | null)?.displayName);
    return names.includes("AppLayerProvider") && names.includes("AppLayerContainer");
  });
  if (!module || typeof module !== "object") return undefined;
  const values = Object.values(module);
  return {
    provider: values.find(item => (item as { displayName?: string } | null)?.displayName === "AppLayerProvider"),
    container: values.find(item => (item as { displayName?: string } | null)?.displayName === "AppLayerContainer"),
  };
}
function pickerStore(): PickerStore | undefined {
  return window.Syncord?.webpack?.find(value => {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return false;
    const store = value as Partial<PickerStore>;
    if (typeof store.getState !== "function" || typeof store.setState !== "function" || typeof store.subscribe !== "function") return false;
    const state = store.getState();
    return state != null && ["activeView", "activeViewType", "activeChannelId", "searchQuery", "lastActiveView"].every(key => key in state);
  }) as PickerStore | undefined;
}
function unavailable(reason: string, onError?: (message: string) => void): void {
  log.warn("Native picker unavailable:", reason);
  const message = reason === "no visible/clickable dialog"
    ? i18nText("ui.discord_s_media_menu_could_not_be_displayed_your_draft_is_kept")
    : i18nText("ui.discord_s_native_media_picker_is_not_ready_open_a_discord_emoji_gif_pi");
  onError?.(message);
  window.Syncord?.toast?.show?.(message);
}

export function createMediaPicker(registerDialog: typeof registerCanvasDialog = registerCanvasDialog) {
let dispose: (() => void) | undefined;
function closeMediaPicker(): void { dispose?.(); }
/** Mount Discord's complete Expression Picker, including its own tabs/search/favorites.
 * A unique input type scopes the shared picker state to this Canvas session.
 * Native send/insert handlers are never used: only our draft callbacks are passed.
 */
function openMediaPicker(workspace: HTMLElement, channelId: string, kind: PickerKind, select: (item: string | StickerLike) => void, anchor?: HTMLElement, onError?: (message: string) => void, onClose?: () => void, onReady?: (size:{width:number;height:number}) => void): void {
  closeMediaPicker();
  const doc=workspace.ownerDocument,view=doc.defaultView??window;
  const focusElement=(value:Element|null):HTMLElement|null=>value&&typeof (value as HTMLElement).focus==='function'?value as HTMLElement:null;
  const component = nativePicker();
  const store = pickerStore();
  const layers = nativeLayers();
  const react = reactNs() as NativeReact | undefined;
  const createRoot = rootFactory();
  const channel = getChannel(channelId);
  const constants = window.Syncord?.webpack?.findByProps("EmojiIntention") as { EmojiIntention?: { CHAT?: number } } | undefined;
  const missing = [!component && "component", !store && "store", !layers && "App layer provider", !channel && "channel", !react?.Component && "React", !createRoot && "ReactDOM", constants?.EmojiIntention?.CHAT == null && "emoji intention"].filter(Boolean).join(", ");
  if (!component || !store || !layers || !channel || !react?.Component || !createRoot || constants?.EmojiIntention?.CHAT == null) { unavailable(missing, onError); onClose?.(); return; }

  const previousFocus = focusElement(doc.activeElement);
  const initial = store.getState();
  const previous = { activeView: initial.activeView, activeViewType: initial.activeViewType, activeChannelId: initial.activeChannelId, searchQuery: initial.searchQuery };
  const inputType = {
    analyticsName: "multichat_canvas",
    expressionPicker: { emojiIntention: constants.EmojiIntention.CHAT, onlyEmojis: false },
    gifs: { allowSending: true }, stickers: { allowSending: true }, soundmoji: { allowSending: false },
  };
  const owned = () => {
    const state = store.getState();
    return state.activeViewType === inputType && state.activeChannelId === channelId;
  };
  const style = doc.createElement("style");style.textContent=NATIVE_PICKER_CSS;doc.head.append(style);
  const alignmentStyle=doc.createElement('style');
  if(workspace.dataset.nativePickerWindow)doc.head.append(alignmentStyle);
  const host = doc.createElement("div");
  host.className = "dion-mc-native-picker-host";
  let active = true;
  let mounted: Root | undefined;
  let unsubscribe: (() => void) | undefined;
  let layoutObserver:ResizeObserver|undefined;
  let themeObserver: MutationObserver | undefined;
  let renderCheck: number | undefined;
  let releaseDialog: (() => void) | undefined;
  let releaseDraft:(()=>void)|undefined;
  let releaseSurface:(()=>void)|undefined;
  const close = () => {
    if (!active) return;
    active = false;
    unsubscribe?.();
    view.clearTimeout(renderCheck);
    themeObserver?.disconnect();layoutObserver?.disconnect();
    host.removeEventListener("keydown", keydown);
    releaseDialog?.();
    releaseDraft?.();releaseSurface?.();
    mounted?.unmount();
    if (host.matches(":popover-open")) host.hidePopover();
    host.remove();
    style.remove();
    alignmentStyle.remove();
    const current = store.getState();
    // Do not close/overwrite a picker that another native composer has opened.
    if (owned() || (current.activeView === null && current.activeViewType === null)) store.setState(previous);
    if (dispose === close) dispose = undefined;
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    onClose?.();
  };
  const keydown = (event: KeyboardEvent) => {
    // The picker now lives outside Canvas's DOM. Native handlers run first;
    // keep its keys out of Discord's underlying composer/global shortcuts.
    event.stopPropagation();
    if (event.key === "Escape" && !event.isComposing && !event.defaultPrevented) { event.preventDefault(); close(); }
  };
  const fail = () => { queueMicrotask(() => { if (active) { close(); unavailable(i18nText("ui.render_failed"), onError); } }); };
  class Boundary extends react.Component {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    componentDidCatch() { fail(); }
    render() { return this.state.failed ? null : this.props.children; }
  }
  const choose = (value: string | StickerLike, willClose = true) => {
    if (!active || !owned()) return;
    const focus = focusElement(doc.activeElement);
    if (willClose) close();
    select(value);
    if (!willClose && focus?.isConnected) focus.focus({ preventScroll: true });
  };
  try {
    const userStore=window.Syncord?.common?.stores.UserStore as {getCurrentUser?:()=>{id?:string}}|undefined;
    const accountAtOpen=userStore?.getCurrentUser?.()?.id;
    releaseDraft=registerExpressionDraft(inputType,{channelId,valid:()=>active&&owned()&&!!accountAtOpen&&userStore?.getCurrentUser?.()?.id===accountAtOpen,insertText:(text,willClose)=>choose(text,willClose)});
    releaseSurface=bindExpressionSurface(host);
    releaseDialog = registerDialog(close);
    dispose = close;
    // Native PositionLayer still owns menu geometry. A manual popover places
    // its host in Chromium's Top Layer: ancestor z-index, transform, overflow
    // and Canvas's stacking contexts cannot paint over it.
    const syncTheme = () => {
      const style = getComputedStyle(workspace);
      for (let index = 0; index < style.length; index++) {
        const property = style[index];
        if (property.startsWith("--")) host.style.setProperty(property, style.getPropertyValue(property));
      }
      host.style.fontFamily = style.fontFamily;
      host.style.color = style.color;
    };
    syncTheme();
    host.setAttribute("popover", "manual");
    workspace.ownerDocument.body.append(host);
    host.showPopover();
    themeObserver = new MutationObserver(syncTheme);
    for (let parent: HTMLElement | null = workspace; parent; parent = parent.parentElement) {
      themeObserver.observe(parent, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    }
    store.setState({activeView: kind === "GIF" ? "gif" : kind === "Stickers" ? "sticker" : "emoji", activeViewType: inputType, activeChannelId: channelId, searchQuery: ""});
    unsubscribe = store.subscribe(() => {
      if (!owned() || store.getState().activeView === null) queueMicrotask(() => { if (active && (!owned() || store.getState().activeView === null)) close(); });
    });
    mounted = createRoot(host);
    host.addEventListener("keydown", keydown);
    mounted.render(react.createElement(Boundary, null,
      react.createElement(layers.provider, null,
        react.createElement(layers.container, { className: "dion-mc-native-picker-container" }),
        react.createElement(component, {
          ...(workspace.dataset.nativePickerWindow?{positionLayerClassName:'syncord-native-picker-window-layer'}:{}),
          positionTargetRef: { current: anchor ?? previousFocus ?? workspace },
          type: inputType, channel, position: "top", align: "right",
          hideGifFavorites: false,
          onSelectGIF: (item: unknown) => {
            if (!item || typeof item !== "object") return;
            const url = safeMediaUrl((item as { url?: unknown }).url);
            if (url) choose(`\n${url}\n`);
          },
          onSelectEmoji: (selection: unknown) => {
            if (!selection || typeof selection !== "object") return;
            const { emoji, willClose } = selection as { emoji?: { id?: string; name?: string; animated?: boolean; surrogates?: string }; willClose?: boolean };
            if (!emoji || (emoji.id ? !/^\d+$/.test(emoji.id) || !emoji.name : !emoji.surrogates)) return;
            const text = emojiText({ ...emoji, name: emoji.name ?? "" });
            if (text) choose(text, willClose !== false);
          },
          onSelectSticker: (item: unknown) => {
            if (!item || typeof item !== "object") return;
            const sticker = item as StickerLike;
            if (typeof sticker.id === "string" && /^\d+$/.test(sticker.id) && typeof sticker.name === "string" && sticker.available !== false) choose(sticker);
          },
        }))));
    let surfaceElements:Element[]=[];
    const surfaceBounds=(dialog:HTMLElement,panel:HTMLElement)=>{
      if(!workspace.dataset.nativePickerWindow)return panel.getBoundingClientRect();
      // Native versions may split the dialog into header/body/footer siblings.
      // Measuring only the first child can report just a 48px search header.
      // Transparent positioning wrappers can be wider than the painted picker.
      // Measure the first painted, interactive surfaces, including sibling tabs
      // and footer, rather than treating those wrappers as visible content.
      const surfaces:DOMRect[]=[];
      surfaceElements=[];
      let visited=0;
      const visit=(element:Element,depth:number):void=>{
        if(++visited>256||depth>8)return;
        const rect=element.getBoundingClientRect(),css=view.getComputedStyle(element);
        const painted=css.backgroundColor!=='transparent'&&css.backgroundColor!=='rgba(0, 0, 0, 0)'&&!/\/\s*0(?:\.0+)?\s*\)$/.test(css.backgroundColor);
        if(rect.width>=160&&rect.height>=16&&css.visibility==='visible'&&css.pointerEvents!=='none'&&painted){surfaces.push(rect);surfaceElements.push(element);return;}
        for(const child of element.children){if(visited>=256)break;visit(child,depth+1);}
      };
      visit(dialog,0);
      const rects=surfaces.length?surfaces:[...dialog.children].map(child=>child.getBoundingClientRect()).filter(rect=>rect.width>0&&rect.height>0);
      if(!rects.length)return dialog.getBoundingClientRect();
      const left=Math.min(...rects.map(rect=>rect.left)),right=Math.max(...rects.map(rect=>rect.right));let top=Math.min(...rects.map(rect=>rect.top)),bottom=Math.max(...rects.map(rect=>rect.bottom));
      const shell=dialog.getBoundingClientRect();if(bottom-top<120&&shell.height>=120){top=Math.min(top,shell.top);bottom=Math.max(bottom,shell.bottom);}
      return {left,top,right,bottom,x:left,y:top,width:right-left,height:bottom-top};
    };
    let shiftX=0,shiftY=0;
    const alignedBounds=(dialog:HTMLElement,panel:HTMLElement)=>{
      let rect=surfaceBounds(dialog,panel);
      if(workspace.dataset.nativePickerWindow&&rect.width>=160&&rect.height>=120&&(Math.abs(rect.left)>.5||Math.abs(rect.top)>.5)){
        shiftX-=rect.left;shiftY-=rect.top;
        // Style our host's dialog through CSS; do not rewrite React-owned nodes
        // or the native emoji grid. The offset follows actual surface geometry.
        alignmentStyle.textContent=`.dion-mc-native-picker-host [role="dialog"]{translate:${shiftX}px ${shiftY}px!important;}`;
        rect=surfaceBounds(dialog,panel);
      }
      return rect;
    };
    const began=Date.now();
    const check=()=>{
      if (!active) return;
      const dialog = host.querySelector<HTMLElement>('[role="dialog"]');
      // Discord's dialog is a full-width positioning shell with pointer-events:
      // none. Its absolutely positioned drawer is the actual visible/hit target.
      const panel = focusElement(dialog?.firstElementChild??null) ?? dialog;
      const bounds = dialog&&panel?alignedBounds(dialog,panel):undefined;
      const hit = bounds && workspace.ownerDocument.elementFromPoint(
        Math.max(0, Math.min(view.innerWidth - 1, bounds.left + bounds.width / 2)),
        Math.max(0, Math.min(view.innerHeight - 1, bounds.top + Math.min(bounds.height / 2, 30))),
      );
      if (!dialog || !bounds?.width || !bounds.height || (!panel || getComputedStyle(panel).visibility !== "visible") || !host.contains(hit ?? null)) {
        if(onReady&&Date.now()-began<2000){renderCheck=view.setTimeout(check,25);return;}
        log.warn("Native picker geometry:", JSON.stringify({
          hasDialog: Boolean(dialog), hasPanel: Boolean(panel), topLayer: host.matches(":popover-open"),
          hostSize: [host.clientWidth, host.clientHeight], panelSize: bounds ? [bounds.x, bounds.y, bounds.width, bounds.height] : null,
          pointerEvents: panel ? getComputedStyle(panel).pointerEvents : null, hitInsideHost: host.contains(hit ?? null),
        }));
        close(); unavailable(i18nText("ui.no_visible_clickable_dialog"), onError);
      }else if(onReady&&panel){
        let previous='';
        const observed=new Set<Element>();
        const measured=()=>{
          if(!active)return;
          const rect=alignedBounds(dialog,panel),size={width:Math.ceil(rect.width),height:Math.ceil(rect.height)},signature=JSON.stringify(size);
          const targets=new Set<Element>([dialog,...dialog.children,...surfaceElements]);
          for(const element of observed)if(!targets.has(element)){layoutObserver?.unobserve(element);observed.delete(element);}
          for(const element of targets)if(!observed.has(element)){layoutObserver?.observe(element);observed.add(element);}
          if(size.width>=160&&size.height>=120&&signature!==previous){
            if(!previous)log.info('Native picker surface',JSON.stringify({viewport:[view.innerWidth,view.innerHeight],surface:[rect.left,rect.top,size.width,size.height],offset:[shiftX,shiftY],surfaces:surfaceElements.length}));
            previous=signature;onReady(size);
          }
        };
        // The owner Discord window may be hidden. Its ResizeObserver delivery
        // cannot drive layout updates in the visible picker document reliably.
        layoutObserver=new view.ResizeObserver(measured);measured();
      }
    };
    renderCheck=view.setTimeout(check,onReady?25:2000);
  } catch { close(); unavailable(i18nText("ui.render_failed"), onError); }
}

return {open:openMediaPicker,close:closeMediaPicker};
}
const canvasPicker = createMediaPicker();
export const openMediaPicker = canvasPicker.open;
export const closeMediaPicker = canvasPicker.close;
