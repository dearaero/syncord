import { t as i18nText } from "../../i18n";
import {
  ensureReact,
  kit,
  kitReady,
  openNativeMenu,
  scanKit,
  type MenuViewProps,
  type ReactNs,
} from "../../discordKit";
import type { Logger } from "../../api/logger";

/**
 * The Direct Messages button at the top of the server list, and its menu.
 *
 * Right-clicking that button opens a menu whose only entry marks every server
 * and DM as read. The menu is Discord's own: its real `Menu` and `MenuItem`,
 * opened through `CONTEXT_MENU_OPEN`, so it has the client's animation, focus
 * handling, dismissal and keyboard navigation. A hand-built popover would look
 * close and never quite match, which is the whole reason `discordKit` exists.
 *
 * ## How the button is found
 *
 * By the list identifiers Discord itself puts on the rail, never by class names
 * and never by geometry — every class in the rail is rehashed per build, and the
 * rail is not a fixed width. The rail is a `role="tree"` with
 * `data-list-id="guildsnav"`, and its entries are addressed as
 * `data-list-item-id="<listId>___<key>"`. The Direct Messages entry is the one
 * with the key `home`; a server is addressed by its snowflake and the footer
 * buttons by fixed keys (`create-join-button`, `guild-discover-button`,
 * `app-download-button`).
 *
 * Two independent signals are tried, both taken from that scheme:
 *
 *  1. the exact id `guildsnav___home`;
 *  2. the same id under a different list prefix, for the channels where the
 *     prefix differs — the suffix match is still confined to the guilds tree.
 *
 * The gesture is looked for in *both* directions from the event target. That is
 * not belt and braces: the client draws the entry inside the button's own
 * `<svg>`/`<foreignObject>` pair, so a right-click on the visible icon lands on
 * an ancestor of the entry, and one on the name or the glyph lands below it.
 * Neither direction alone finds the button.
 *
 * The visible text is deliberately *not* a signal. Discord localises it, and the
 * rail contains a second element labelled "Direct Messages" — the hidden group
 * that holds the unread-DM pills — so matching on the label opened the menu in
 * the wrong place.
 */

const NAV_ID = "Syncord-mark-all-as-read";
const MENU_LABEL = () => i18nText("ui.direct_messages");
const ITEM_ID = "Syncord-mark-all-as-read-item";
const ITEM_LABEL = () => i18nText("ui.mark_all_as_read");
const GROUP_LABEL = () => i18nText("ui.unread");

/** The rail's list id. Present on the `role="tree"` that holds every entry. */
const RAIL_LIST_ID = "guildsnav";
/** The Direct Messages entry, addressed the way the rail addresses its items. */
const DM_HOME_ITEM_ID = `${RAIL_LIST_ID}___home`;
/** The same, as a suffix, for a build whose list prefix differs. */
const DM_HOME_ITEM_SUFFIX = "___home";

/**
 * How far up the tree to look before giving up.
 *
 * The entry sits eight levels below the rail's list, so a gesture on the far
 * edge of the button needs a limit that clears that, not one that fits the
 * typical case.
 *
 * Walking this far is safe because the signals are exact: nothing outside the
 * rail is an ancestor of the entry, so a click elsewhere simply never reaches it.
 */
const MAX_DEPTH = 12;

/**
 * How far *down* to look, and how much of the page that is allowed to cost.
 *
 * The entry is not only above the click target but below it: the client draws
 * the button as a 48×48 `<svg>` holding a `<foreignObject>`, and the entry is
 * the element *inside* that pair. A right-click therefore lands either on the
 * entry or on one of its ancestors — never below it — so climbing alone misses
 * the most likely gesture of all, the one on the button's own icon box.
 *
 * Four levels is the button's own box and stops there on purpose. The level
 * above is the rail's list row, and above that the scroller that holds every
 * server, so a larger reach would open this menu on a right-click in the empty
 * space of the rail — the exact complaint this plugin is meant to not have.
 *
 * The budget bounds the cost on a click inside something large: this is a small
 * breadth-first walk, not a subtree query, and it gives up rather than stalling
 * the UI.
 */
const MAX_DOWN = 4;
const MAX_DOWN_NODES = 256;

/**
 * Whether the element is inside the rail's list.
 *
 * Matched by prefix because the suffix signal is only safe when it is confined
 * to *this* list: a `___home` item in a channel tree would be a different thing
 * entirely, so the prefix is what keeps that from matching.
 */
function insideRailList(node: Element | null): boolean {
  for (let el = node; el; el = el.parentElement) {
    const listId = el.getAttribute("data-list-id");
    if (typeof listId === "string" && listId.startsWith(RAIL_LIST_ID)) return true;
  }
  return false;
}

/** The exact signals, on one element. */
function isDmHome(node: Element): boolean {
  const id = node.getAttribute("data-list-item-id");
  if (id === DM_HOME_ITEM_ID) return true;
  return (
    typeof id === "string" &&
    id.endsWith(DM_HOME_ITEM_SUFFIX) &&
    insideRailList(node)
  );
}

function childrenOf(node: Element): Element[] {
  try {
    // `children` skips text nodes, which is what is wanted here.
    return node.children ? Array.from(node.children) : [];
  } catch {
    return [];
  }
}

/** The entry inside a container, at most `MAX_DOWN` levels down. */
function findBelow(container: Element): Element | null {
  let frontier: Element[] = [container];
  let budget = MAX_DOWN_NODES;

  for (let depth = 0; depth < MAX_DOWN && frontier.length > 0 && budget > 0; depth++) {
    const next: Element[] = [];
    for (const node of frontier) {
      for (const child of childrenOf(node)) {
        if (--budget <= 0) return null;
        if (isDmHome(child)) return child;
        next.push(child);
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * The Direct Messages button, or null when the event was somewhere else.
 *
 * The gesture can land on either side of the entry, because the client draws
 * the entry *inside* its own icon: below it are the name and the glyph, above it
 * are the `<foreignObject>`, the `<svg>` and the wrappers. So the entry is
 * searched for by climbing from the target first — the specific direction, since
 * a click on the name or the glyph is the most common one — and then by looking
 * a few levels down from the target, which is what catches a click on the icon
 * box itself.
 */
export function findDmHome(start: EventTarget | null): Element | null {
  const target: Element | null =
    start instanceof Element
      ? start
      : start instanceof Node
        ? start.parentElement
        : null;
  if (!target) return null;

  for (
    let node: Element | null = target, depth = 0;
    node && depth < MAX_DEPTH;
    node = node.parentElement, depth++
  ) {
    if (isDmHome(node)) return node;
  }

  return findBelow(target);
}

export type DmHomeMenuHandle = {
  dispose: () => void;
};

export type DmHomeMenuOptions = {
  /** Run the action. Kept separate so the menu does not know what it marks. */
  onRun: () => void;
  log: Logger;
};

export function installDmHomeMenu(options: DmHomeMenuOptions): DmHomeMenuHandle {
  let open = false;
  let warned = false;

  /**
   * Forget the menu, whether we closed it or Discord did.
   *
   * Both paths run — our close asks Discord to close, and Discord's own
   * dismissal calls back through the menu's `onClose` — so this is idempotent.
   * Leaving `open` set after the menu has gone would make the next gesture only
   * try to close a menu that is no longer there, and the button would feel dead.
   */
  const dismissed = (): void => {
    open = false;
  };

  /**
   * A component, not a finished tree.
   *
   * `openNativeMenu` takes a component so the items can be stateful and so React
   * is free to re-invoke it. The one item here closes the menu after it runs,
   * which is what a plain `MenuItem` is for — a tick that stayed behind would
   * be a lie, since there is nothing to un-tick.
   */
  const MenuView = ({ navId, label, onClose }: MenuViewProps): unknown => {
    const react = kit.react as ReactNs;
    const item = react.createElement(kit.menuItem, {
      key: ITEM_ID,
      id: ITEM_ID,
      label: ITEM_LABEL(),
      action: () => {
        // Close even if the action throws, or the menu hangs open with the
        // work half done.
        try {
          options.onRun();
        } finally {
          onClose();
        }
      },
    });
    const body = kit.menuGroup
      ? react.createElement(kit.menuGroup, { label: GROUP_LABEL() }, item)
      : [item];
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
    ensureReact();
    scanKit();

    if (!kit.menu || !kit.menuItem) {
      if (!warned) {
        warned = true;
        options.log.warn(
          "Discord's menu components were not found; the Direct Messages menu stays inert",
        );
      }
      return;
    }

    if (open) {
      dismissed();
      kit.closeContextMenu?.();
      return;
    }

    open = true;
    if (!openNativeMenu(event, MenuView, NAV_ID, MENU_LABEL())) {
      open = false;
      options.log.warn("the native context menu could not be opened");
    }
  };

  const onContextMenu = (event: MouseEvent): void => {
    if (!findDmHome(event.target)) return;
    // The Direct Messages button has no context menu of its own, so taking the
    // event here costs nothing — and it also stops the browser's own menu from
    // appearing over Discord's. Capture phase, so it lands before the rail's.
    event.preventDefault();
    event.stopPropagation();
    openMenu(event);
  };

  document.addEventListener("contextmenu", onContextMenu, true);
  if (!kitReady()) scanKit();

  return {
    dispose() {
      document.removeEventListener("contextmenu", onContextMenu, true);
      if (!open) return;
      open = false;
      kit.closeContextMenu?.();
    },
  };
}
