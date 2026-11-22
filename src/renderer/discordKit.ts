import type { SyncordApi } from "./api/types";
import {getLocale, messageKeyForLabel, onLocaleChange, t} from './i18n/core';

/**
 * Discord's own React components, resolved at runtime.
 *
 * A hand-rolled menu never quite matches the client: wrong shadow, wrong
 * padding, no keyboard navigation, no dismissal animation. Building the menu out
 * of Discord's real `Menu` and `MenuRadioItem` and opening it through
 * `CONTEXT_MENU_OPEN` gives the genuine article.
 *
 * Component names are obfuscated and change between builds, so the modules are
 * located by scanning factory sources for stable, distinctive strings, then
 * demangling the menu module's type checks back into module ids.
 *
 * Shared because more than one plugin needs it.
 */

export type ReactNs = {
  createElement: (
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ) => unknown;
  useState: <T>(init: T) => [T, (next: T | ((prev: T) => T)) => void];
  useSyncExternalStore?: <T>(subscribe: (callback: () => void) => () => void, snapshot: () => T, serverSnapshot?: () => T) => T;
};

export type Root = {
  render: (node: unknown) => void;
  unmount: () => void;
};

type Req = NonNullable<ReturnType<SyncordApi["webpack"]["getRequire"]>>;

/**
 * Menu child types, mapped to the export names the menu module uses for the
 * components that render them.
 */
const ITEM_NAMES: Record<string, string> = {
  radio: "MenuRadioItem",
  separator: "MenuSeparator",
  checkbox: "MenuCheckboxItem",
  groupstart: "MenuGroup",
  control: "MenuControlItem",
  compositecontrol: "MenuControlItem",
  item: "MenuItem",
  customitem: "MenuItem",
};

export type Kit = {
  react?: ReactNs;
  createRoot?: (el: HTMLElement) => Root;
  tooltip?: unknown;
  /** Current element-child Tooltip used by profile badges. */
  profileTooltip?: unknown;
  menu?: unknown;
  menuGroup?: unknown;
  menuCheckbox?: unknown;
  /** Exclusive choice; rendered with a radio tick. */
  menuRadio?: unknown;
  /** A plain row that runs an action and closes the menu. */
  menuItem?: unknown;
  menuSeparator?: unknown;
  openContextMenu?: (...args: unknown[]) => unknown;
  closeContextMenu?: () => void;
};

export const kit: Kit = {};
let kitScanned = false;

function fnSource(value: unknown): string {
  if (typeof value !== "function") return "";
  try {
    return Function.prototype.toString.call(value);
  } catch {
    return "";
  }
}

export function componentSource(value: unknown): string {
  const seen = new Set<unknown>();
  let current = value;
  while (current != null && !seen.has(current)) {
    seen.add(current);
    if (typeof current === "function") return fnSource(current);
    if (typeof current !== "object") break;
    const wrapped = current as { render?: unknown; type?: unknown };
    current = wrapped.render ?? wrapped.type;
  }
  return "";
}

function isComponent(value: unknown): boolean {
  if (typeof value === "function") return true;
  return componentSource(value).length > 0;
}

function escapeReg(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function factoryParams(src: string): string[] {
  const match = src.match(/^(?:function\s*)?(?:\w+\s*)?\(([^)]*)\)/);
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseModuleId(raw: string): string | number {
  if (/^\d+$/.test(raw)) return Number(raw);
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

function loadModule(req: Req, id: PropertyKey): Record<string, unknown> | undefined {
  const key = String(id);
  const cached = req.c?.[key]?.exports;
  const loaded = cached ?? safeRequire(req, id);
  if (loaded == null || (typeof loaded !== "object" && typeof loaded !== "function")) {
    return undefined;
  }
  return loaded as Record<string, unknown>;
}

function safeRequire(req: Req, id: PropertyKey): unknown {
  try {
    return req(id);
  } catch {
    return undefined;
  }
}

function readProp(mod: Record<string, unknown> | undefined, prop: string): unknown {
  if (!mod) return undefined;
  let value: unknown;
  try {
    value = mod[prop];
  } catch {
    return undefined;
  }
  if (isComponent(value)) return value;
  const fallback = mod.default;
  if (fallback != null && typeof fallback === "object") {
    try {
      const nested = (fallback as Record<string, unknown>)[prop];
      if (isComponent(nested)) return nested;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function componentsOf(mod: Record<string, unknown> | undefined): unknown[] {
  if (!mod) return [];
  const out: unknown[] = [];
  for (const key of Object.keys(mod)) {
    let value: unknown;
    try {
      value = mod[key];
    } catch {
      continue;
    }
    if (isComponent(value)) out.push(value);
  }
  return out;
}

function pickComponent(
  mod: Record<string, unknown> | undefined,
  test: (src: string) => boolean,
): unknown {
  const matches = componentsOf(mod).filter((value) => test(componentSource(value)));
  if (matches.length === 0) return undefined;
  return matches.sort(
    (a, b) => componentSource(b).length - componentSource(a).length,
  )[0];
}

function moduleIdForAlias(src: string, reqName: string, alias: string): string | number | undefined {
  const id = "(\\d+|\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*')";
  const aliasSrc = escapeReg(alias);
  const reqSrc = escapeReg(reqName);
  const patterns = [
    `\\b${aliasSrc}\\s*=\\s*${reqSrc}\\(\\s*${id}\\s*\\)`,
    `\\b${aliasSrc}\\s*=\\s*${reqSrc}\\.n\\(\\s*${reqSrc}\\(\\s*${id}\\s*\\)\\s*\\)`,
  ];
  for (const pattern of patterns) {
    const match = src.match(new RegExp(pattern));
    if (match?.[1]) return parseModuleId(match[1]);
  }
  return undefined;
}

/**
 * The kit slot each component's devtools name identifies.
 *
 * Discord stamps its devtools display name into every menu component
 * (`R("MenuItem")` and friends), which is a far steadier signal than pairing
 * the menu's flattening code with a `type:"..."` string. The item branch is the
 * biggest one — submenus, custom renders, labels — so it is the part the
 * minifier restructures between builds, and it is exactly what went missing
 * when MenuItem stopped resolving.
 *
 * MenuGroup carries no display name, so it is still found by the type pairing.
 */
/** The kit fields that hold a resolved menu component. */
type MenuSlot =
  | "menu"
  | "menuItem"
  | "menuRadio"
  | "menuCheckbox"
  | "menuSeparator"
  | "menuGroup";

const MENU_COMPONENT_SLOTS: Record<string, MenuSlot> = {
  Menu: "menu",
  MenuItem: "menuItem",
  MenuRadioItem: "menuRadio",
  MenuCheckboxItem: "menuCheckbox",
  MenuSeparator: "menuSeparator",
};

function assignMenuComponent(slot: MenuSlot, value: unknown): void {
  // First match wins and an existing one is never replaced: a later, weaker
  // heuristic must not undo a component a stronger one already found.
  if (kit[slot] !== undefined) return;
  kit[slot] = value;
}

function demangleMenu(src: string, req: Req): void {
  const reqName = factoryParams(src)[2];
  if (!reqName) return;

  // ── by devtools name ────────────────────────────────────────────────────
  // Walks the module the menu imports its components from and identifies each
  // one by the name inside its own body. The quotes matter: `"MenuItem"` cannot
  // match inside `"MenuRadioItem"`.
  // Whitespace is tolerated even though the shipped code is minified without
  // any: this alias is the only way into the constants module, and losing the
  // whole menu over a space would be a poor trade.
  // Group 1 is the element being tested; group 2 is the constants alias that
  // holds the component table.
  const aliasFrom = /\(\s*\w+\s*\.\s*type\s*===\s*(\w+)\s*\./.exec(src);
  if (aliasFrom?.[1]) {
    const moduleId = moduleIdForAlias(src, reqName, aliasFrom[1]);
    const constants =
      moduleId === undefined ? undefined : loadModule(req, moduleId);
    if (constants) {
      for (const value of componentsOf(constants)) {
        if (!isComponent(value)) continue;
        const body = fnSource(value);
        if (!body) continue;
        for (const [name, slot] of Object.entries(MENU_COMPONENT_SLOTS)) {
          if (body.includes(`"${name}"`)) assignMenuComponent(slot, value);
        }
      }
    }
  }

  // ── by the flattening code's type names ─────────────────────────────────
  // Kept for what the devtools names do not cover, currently MenuGroup, and as
  // a second opinion on everything else.
  const ident = "[A-Za-z_$][\\w$]*";
  // Tolerates whitespace, which the shipped minified code does not have. Both
  // patterns are the only way into the component table, and the item names they
  // read are the last line of defence for MenuGroup, which carries no devtools
  // name of its own.
  const typeCheckRe = new RegExp(
    `\\(\\s*${ident}\\s*\\.\\s*type\\s*===\\s*(${ident})\\s*\\.\\s*(${ident})\\s*\\)`,
    "g",
  );
  const pushTypeRe = /type\s*:\s*"(\w+)"/g;
  let typeMatch: RegExpExecArray | null;

  while ((typeMatch = typeCheckRe.exec(src)) !== null) {
    const alias = typeMatch[1];
    const prop = typeMatch[2];
    if (!alias || !prop) continue;
    pushTypeRe.lastIndex = typeCheckRe.lastIndex;
    const type = pushTypeRe.exec(src)?.[1];
    if (!type || !(type in ITEM_NAMES)) continue;

    const name = ITEM_NAMES[type];
    const moduleId = moduleIdForAlias(src, reqName, alias);
    if (moduleId === undefined) continue;
    const component = readProp(loadModule(req, moduleId), prop);
    if (!component) continue;

    if (name === "MenuCheckboxItem") assignMenuComponent("menuCheckbox", component);
    if (name === "MenuRadioItem") assignMenuComponent("menuRadio", component);
    if (name === "MenuItem") assignMenuComponent("menuItem", component);
    if (name === "MenuSeparator") assignMenuComponent("menuSeparator", component);
    if (name === "MenuGroup") assignMenuComponent("menuGroup", component);
  }
}

export function ensureReact(): boolean {
  kit.react = kit.react ?? reactNs();
  kit.createRoot = kit.createRoot ?? rootFactory();
  return kit.react != null && kit.createRoot != null;
}

/** Resolve the same render-prop Tooltip used by Discord's badge/icon rows.
 * Profile hover must never force-load unrelated webpack factories. */
export function resolveTooltip(): unknown {
  if (kit.tooltip) return kit.tooltip;
  const req = window.Syncord?.webpack?.getRequire?.();
  for (const [id, module] of Object.entries(req?.c ?? {})) {
    if (module?.loaded === false) continue;
    const source = fnSource(req?.m?.[id]);
    if (!source.includes("tooltipPointer") || !source.includes("tooltipContent")) continue;
    try {
      const exported = module?.exports;
      const matches = (body: string): boolean => body.includes("onMouseEnter") && body.includes("children");
      if (isComponent(exported) && matches(componentSource(exported))) return kit.tooltip = exported;
      if (!exported || typeof exported !== "object") continue;
      const component = pickComponent(exported as Record<string, unknown>, matches);
      if (component) return kit.tooltip = component;
    } catch { /* Optional exports must not interrupt the profile row. */ }
  }
  return undefined;
}

/** Current badge tooltips own their trigger, delayed entrance and exit spring.
 * Keep this separate from the older render-prop API used by other controls. */
export function resolveProfileTooltip(): unknown {
  if (kit.profileTooltip) return kit.profileTooltip;
  const req = window.Syncord?.webpack?.getRequire?.();
  const matches = (body: string): boolean => body.includes("__unsupportedReactNodeAsText") && body.includes("keyboardShortcut") && body.includes("anchorRef") && body.includes("caretConfig") && body.includes("isValidElement");
  for (const module of Object.values(req?.c ?? {})) {
    if (module?.loaded === false) continue;
    try {
      const exported = module?.exports;
      if (isComponent(exported) && matches(componentSource(exported))) return kit.profileTooltip = exported;
      if (!exported || typeof exported !== "object") continue;
      const component = pickComponent(exported as Record<string, unknown>, matches);
      if (component) return kit.profileTooltip = component;
    } catch { /* Ignore unrelated lazy exports. */ }
  }
  return undefined;
}

export function scanKit(): void {
  if (kitScanned) return;
  // Optional chaining has to cover every step. `Syncord?.webpack.getRequire()`
  // throws if the bridge exists but webpack does not, and scanKit runs from
  // click handlers, so that would take the whole control down.
  const req = window.Syncord?.webpack?.getRequire?.();
  if (!req?.m || Object.keys(req.m).length < 500) return;
  kitScanned = true;

  for (const id of Object.keys(req.m)) {
    const factory = req.m[id];
    if (typeof factory !== "function") continue;
    const src = fnSource(factory);
    if (!src) continue;

    try {
      if (!kit.tooltip && src.includes("tooltipPointer") && src.includes("tooltipContent")) {
        kit.tooltip = pickComponent(
          loadModule(req, id),
          (body) => body.includes("onMouseEnter") && body.includes("children"),
        );
      }
      if (!kit.menu && (src.includes('path:["empty"]') || src.includes("path:['empty']"))) {
        kit.menu = pickComponent(
          loadModule(req, id),
          (body) => body.includes("navId") || body.includes("empty"),
        );
      }
      if (!kit.openContextMenu && src.includes("CONTEXT_MENU_OPEN")) {
        const fns = componentsOf(loadModule(req, id)).filter(
          (value): value is (...args: unknown[]) => unknown => typeof value === "function",
        );
        const open = fns.find((fn) => fnSource(fn).includes("renderLazy:"));
        const close = fns.find((fn) => fnSource(fn).includes("CONTEXT_MENU_CLOSE"));
        if (open) {
          kit.openContextMenu = open;
          if (typeof close === "function") kit.closeContextMenu = () => close();
        }
      }
      if (!kit.menuCheckbox && src.includes("Menu API only allows Items")) {
        demangleMenu(src, req);
      }
    } catch {
      /* one bad factory should not hide the button */
    }

    // Stop once there is something to build with. Which item component is
    // present varies by need — Fake voice wants checkboxes, the typing modes
    // want radios — so neither alone is a reason to keep scanning.
    if (
      kit.tooltip &&
      kit.menu &&
      kit.openContextMenu &&
      (kit.menuCheckbox || kit.menuRadio || kit.menuItem)
    ) {
      break;
    }
  }
}

export function reactNs(): ReactNs | undefined {
  const fromCommon = window.Syncord?.common?.react?.React as ReactNs | undefined;
  if (typeof fromCommon?.createElement === "function" && typeof fromCommon.useState === "function") {
    return fromCommon;
  }
  const found = window.Syncord?.webpack?.findByProps?.(
    "createElement",
    "useState",
    "useEffect",
  );
  if (found == null || typeof found !== "object") return undefined;
  const react = found as ReactNs;
  if (typeof react.createElement !== "function" || typeof react.useState !== "function") return undefined;
  return react;
}

export function rootFactory(): ((el: HTMLElement) => Root) | undefined {
  const fromCommon = window.Syncord?.common?.react?.ReactDOM as
    | { createRoot?: (el: HTMLElement) => Root; render?: (node: unknown, el: HTMLElement) => void; unmountComponentAtNode?: (el: HTMLElement) => void }
    | undefined;
  if (typeof fromCommon?.createRoot === "function") {
    return (el) => fromCommon.createRoot!(el);
  }
  // `find` is part of the API but a caller can legitimately run before webpack
  // is ready, so every step is guarded: an exception here would be thrown from
  // a click handler and take the whole control down.
  const found = window.Syncord?.webpack?.find?.(
    (mod) =>
      !!mod &&
      typeof mod === "object" &&
      typeof (mod as { createRoot?: unknown }).createRoot === "function",
  ) as { createRoot?: (el: HTMLElement) => Root } | undefined;
  if (typeof found?.createRoot === "function") return (el) => found.createRoot!(el);
  if (typeof fromCommon?.render === "function") {
    return (el) => ({
      render: (node) => fromCommon.render!(node, el),
      unmount: () => fromCommon.unmountComponentAtNode?.(el),
    });
  }
  return undefined;
}

/** The props a menu view is handed, so the caller renders the real `Menu`. */
export type MenuViewProps = {
  navId: string;
  label: string;
  onClose: () => void;
};

/**
 * Open a native context menu anchored to an event.
 *
 * `view` is a *component*, not a finished element, and that is deliberate. It
 * has to be a component for two reasons: the items are stateful, so React must
 * be able to re-invoke it to move a tick, and only a component element may use
 * hooks. Handing it to `Menu` as a plain child instead gives React a function
 * where it expects a node.
 *
 * The view renders the `Menu` itself, using the `navId`, `label` and `onClose` it
 * is given. Wiring the close is the view's job because a menu dismissed without
 * it can be left half-applied.
 */
export function openNativeMenu(
  event: unknown,
  view: (props: MenuViewProps) => unknown,
  navId: string,
  label: string,
): boolean {
  ensureReact();
  scanKit();
  const { openContextMenu, closeContextMenu, react } = kit;
  if (!react || !kit.menu || !openContextMenu) return false;
  const labelKey = messageKeyForLabel(label);
  const LocalizedMenu = (props: MenuViewProps): unknown => {
    // Use Discord's React instance. React owns subscription cleanup and keeps
    // checkbox/radio state when the language changes while a menu is open.
    react.useSyncExternalStore?.(onLocaleChange, getLocale, getLocale);
    return react.createElement(view, {...props, label: labelKey ? t(labelKey) : props.label});
  };
  try {
    openContextMenu(event, () =>
      react.createElement(LocalizedMenu, {
        navId,
        label,
        onClose: () => {
          if (typeof closeContextMenu === "function") closeContextMenu();
        },
      }),
    );
    return true;
  } catch (err) {
    // Swallowing this is what made a failure look like "the button does
    // nothing", so the reason is logged even though the caller only needs a
    // boolean.
    console.warn("[Syncord]:discordKit openNativeMenu failed:", err);
    return false;
  }
}

/** True once the scan has run, whatever it found. */
export function kitReady(): boolean {
  return kitScanned;
}
