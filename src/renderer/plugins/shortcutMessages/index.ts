import { t as i18nText } from "../../i18n";
import { definePlugin } from "../../api/plugin";
import { getFiber } from "../../ui/userNames";
import { matchShortcut, type Shortcut } from "./model";
import { SHORTCUTS_ID, shortcuts } from "./settings";

type Point = { path: number[]; offset: number };
type SlateEditor = {
  children: unknown[];
  selection: { anchor: Point; focus: Point } | null;
  apply: (operation: unknown) => void;
  deleteFragment: () => void;
  insertText: (text: string) => void;
};
type Hit = { editable: HTMLElement; editor: SlateEditor; path: number[]; offset: number; shortcut: Shortcut };

const TIP_ID = "syncord-shortcut-tip";
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";

function isEditor(value: unknown): value is SlateEditor {
  return object(value) && Array.isArray(value.children) && typeof value.apply === "function" &&
    typeof value.deleteFragment === "function" && typeof value.insertText === "function";
}

/** Discord's Slate editor, found on the composer's React props (as Long Messages does). */
function editorOf(editable: HTMLElement): SlateEditor | undefined {
  for (let f = getFiber(editable), n = 0; f && n < 48; n++, f = f.return ?? null) {
    const editor = (f.memoizedProps ?? f.pendingProps)?.editor;
    if (isEditor(editor)) return editor;
  }
  return undefined;
}

function leafText(editor: SlateEditor, path: number[]): string | undefined {
  let node: unknown = { children: editor.children };
  for (const i of path) {
    if (!object(node) || !Array.isArray(node.children)) return undefined;
    node = node.children[i];
  }
  return object(node) && typeof node.text === "string" ? node.text : undefined;
}

const samePoint = (a: Point, b: Point): boolean =>
  a.offset === b.offset && a.path.length === b.path.length && a.path.every((v, i) => v === b.path[i]);

function focusedComposer(): HTMLElement | undefined {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return undefined;
  const editable = active.closest<HTMLElement>('[data-slate-editor="true"]');
  return editable && !editable.closest("#Syncord-settings-root") ? editable : undefined;
}

function findHit(list: readonly Shortcut[]): Hit | undefined {
  const editable = focusedComposer();
  const editor = editable && editorOf(editable);
  const sel = editor?.selection;
  if (!editable || !editor || !sel || !samePoint(sel.anchor, sel.focus)) return undefined;
  const text = leafText(editor, sel.anchor.path);
  if (text === undefined) return undefined;
  const shortcut = matchShortcut(text, sel.anchor.offset, list);
  return shortcut && { editable, editor, path: [...sel.anchor.path], offset: sel.anchor.offset, shortcut };
}

/** The typed key on screen, falling back to the caret and then the composer. */
function anchorRect(hit: Hit): DOMRect {
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0).cloneRange();
    const node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE && range.startOffset >= hit.shortcut.key.length) {
      range.setStart(node, range.startOffset - hit.shortcut.key.length);
    }
    const rect = range.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) return rect;
  }
  return hit.editable.getBoundingClientRect();
}

const CSS = `
#${TIP_ID} {
  position: fixed;
  z-index: 10000;
  max-width: min(360px, calc(100vw - 16px));
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--background-floating, var(--background-surface-highest, #111214));
  color: var(--text-normal, #dbdee1);
  box-shadow: var(--shadow-high, var(--elevation-high, 0 8px 16px rgba(0, 0, 0, .24)));
  font: 500 14px/18px var(--font-primary, sans-serif);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  overflow: hidden;
  cursor: pointer;
  user-select: none;
}
#${TIP_ID}:hover, #${TIP_ID}:focus-visible {
  background: var(--brand-experiment, var(--brand-500, #5865f2));
  color: var(--white-500, #fff);
  outline: none;
}
@media (prefers-reduced-motion: no-preference) {
  #${TIP_ID} { animation: syncord-shortcut-in 90ms ease-out; }
}
@keyframes syncord-shortcut-in { from { opacity: 0; transform: translateY(4px); } }
`;

export const ShortcutMessagesPlugin = definePlugin({
  id: SHORTCUTS_ID,
  get name() { return i18nText("shortcuts.name"); },
  get description() { return i18nText("shortcuts.description"); },
  author: i18nText("ui.syncord"),
  enabledByDefault: true,

  /**
   * Reads and edits only the focused composer's own Slate editor and shows one
   * floating element; `media` covers its stylesheet. No stores, actions or network.
   */
  permissions: { media: true },

  start(ctx) {
    ctx.css.inject(CSS);

    let current: Hit | undefined;
    let tip: HTMLDivElement | undefined;
    let frame = 0;
    // Escape hides the tip until the caret or text changes.
    let dismissed = "";
    const signature = (hit: Hit): string => `${hit.path.join(".")}:${hit.offset}:${hit.shortcut.key}`;

    const hide = (): void => {
      current = undefined;
      tip?.remove();
      tip = undefined;
    };

    const apply = (): void => {
      const hit = current;
      hide();
      if (!hit || !hit.editable.isConnected) return;
      const sel = hit.editor.selection;
      const at = { path: hit.path, offset: hit.offset };
      // Only replace what the tip promised: the caret and the key must be unchanged.
      if (!sel || !samePoint(sel.anchor, at) || !samePoint(sel.focus, at)) return;
      const text = leafText(hit.editor, hit.path);
      const start = hit.offset - hit.shortcut.key.length;
      if (text === undefined || start < 0 || text.slice(start, hit.offset) !== hit.shortcut.key) return;
      try {
        hit.editor.apply({
          type: "set_selection",
          properties: sel,
          newProperties: { anchor: { path: hit.path, offset: start }, focus: at },
        });
        hit.editor.deleteFragment();
        hit.editor.insertText(hit.shortcut.value);
        hit.editable.focus();
      } catch (err) {
        ctx.log.warn("could not insert the shortcut", err);
      }
    };

    const show = (hit: Hit): void => {
      current = hit;
      if (!tip) {
        tip = document.createElement("div");
        tip.id = TIP_ID;
        tip.setAttribute("role", "button");
        tip.tabIndex = -1;
        // mousedown would move focus out of the composer and lose its selection.
        tip.addEventListener("mousedown", (e) => e.preventDefault());
        tip.addEventListener("click", (e) => { e.preventDefault(); apply(); });
        document.body.append(tip);
      }
      tip.textContent = hit.shortcut.value;
      tip.setAttribute("aria-label", hit.shortcut.value);
      tip.title = i18nText("shortcuts.tip_hint", { key: hit.shortcut.key });
      const rect = anchorRect(hit);
      const box = tip.getBoundingClientRect();
      const left = Math.min(Math.max(8, rect.left + rect.width / 2 - box.width / 2), window.innerWidth - box.width - 8);
      tip.style.left = `${Math.round(left)}px`;
      tip.style.top = `${Math.round(Math.max(8, rect.top - box.height - 8))}px`;
    };

    const evaluate = (): void => {
      frame = 0;
      const list = shortcuts();
      const hit = list.length > 0 ? findHit(list) : undefined;
      if (!hit || signature(hit) === dismissed) { hide(); return; }
      dismissed = "";
      show(hit);
    };
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(evaluate);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && current) {
        dismissed = signature(current);
        hide();
      }
    };

    document.addEventListener("selectionchange", schedule);
    document.addEventListener("input", schedule, true);
    document.addEventListener("focusout", schedule, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", hide);
    document.addEventListener("scroll", schedule, true);
    ctx.disposable(() => {
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("input", schedule, true);
      document.removeEventListener("focusout", schedule, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", hide);
      document.removeEventListener("scroll", schedule, true);
      cancelAnimationFrame(frame);
      hide();
    });
  },
});
