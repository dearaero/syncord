import { messageKeyForLabel, setLocalizedText, setLocalizedAttribute, t as i18nText } from "../i18n";
import {inspectMenuContext as inspectMenu,watchNativeMenus,NATIVE_MENU_ROW,type MenuContext} from "../ui/nativeMenus";
import { definePlugin } from "../api/plugin";
import type { Logger } from "../api/logger";
import { toast, ToastType } from "../ui/toast";

/**
 * "Copy Avatar" — one extra row in Discord's own context menus.
 *
 * ## Why the row is added to the DOM rather than to React's tree
 *
 * Injecting into the tree means wrapping Discord's `Menu` component, and that
 * turned out to be impossible: webpack's `d()` defines every export as
 * `Object.defineProperty(exports, key, { enumerable: true, get })` with no
 * `configurable`, so the slot has no setter and cannot be redefined. The only
 * remaining route is rewriting the module factory before it runs, which is the
 * one approach that breaks on every Discord build and the one this file used to
 * rely on. Reading a menu does not need any of that: the menu, its rows and its
 * React fiber are all reachable from the page.
 *
 * So the row is a clone of a row Discord already rendered. Cloning is only safe
 * as long as the clone keeps that row's structure — an earlier version replaced
 * the clone's children with a bare `<span>` and then needed a hundred lines to
 * chase the focus classes and the marquee it had thrown away. Here the only edit
 * is the label text, so every class, the icon slot and the theme styling are the
 * client's own and survive a re-render.
 */

const ROW_MARKER = "data-dion-copy-avatar";
const ROW_ID = "dion-copy-avatar";

// ── what each menu is about ─────────────────────────────────────────────────

type TargetKind = "user" | "group" | "guild" | "banner" | "guild-banner";

/**
 * The menus this plugin answers to, keyed by the `navId` Discord puts on the
 * menu element. `user-context` is confirmed against the live client (its rows
 * are `user-context-user-profile`, `user-context-call`, …).
 *
 * A `navId` that is neither here nor in `IGNORED_NAVS` is logged once, so a
 * rename in a new build shows up in the console instead of the row quietly
 * vanishing. This map is the one part of the file that may be out of date.
 */
const AVATAR_NAVS = new Set(["user-context", "guild-context", "gdm-context", "group-dm-context"]);

const IGNORED_NAVS = new Set([
  "channel-context",
  "channel-link-context",
  "settings",
  "user-settings",
  "guild-settings",
]);

function isMessageNav(navId: string): boolean {
  return navId === "message" || navId.startsWith("message-");
}

// ── helpers ─────────────────────────────────────────────────────────────────

type Bag = Record<string, unknown>;

/**
 * A Discord store, from the shared resolution first and the raw lookup second.
 * `common.stores` resolves at boot and reports misses in `common.status`, so it
 * is the layer to ask; the fallback covers a store outside that snapshot.
 */
function store<T>(name: string): T | undefined {
  const common = window.Syncord?.common?.stores as unknown as Bag | undefined;
  const fromCommon = common?.[name];
  if (fromCommon) return fromCommon as T;
  return window.Syncord?.webpack?.findByStoreName?.(name) as T | undefined;
}

// ── reading the menu's context off its React fiber ──────────────────────────

/**
 * Which image the menu can offer.
 *
 * Derived from the context rather than from the menu's name, so a renamed navId
 * still produces the right row. A guild *channel* menu has a channel and a
 * guild and is therefore not a server-icon menu — the channel's own menu is
 * about the channel, and adding a server row there was the reason the old
 * version needed a `channel-context` special case.
 */
function kindOf(context: MenuContext): TargetKind | undefined {
  if (context.userId) return "user";
  if (context.channelType === 3) return "group";
  if (context.guildId && !context.channelId) return "guild";
  return undefined;
}

const LABELS: Record<TargetKind, string> = {
  get user() { return i18nText("ui.copy_avatar"); },
  get banner() { return i18nText("ui.copy_banner"); },
  get group() { return i18nText("ui.copy_group_icon"); },
  get guild() { return i18nText("ui.copy_server_icon"); },
  get "guild-banner"() { return i18nText("ui.copy_server_banner"); },
};

// ── image URLs ──────────────────────────────────────────────────────────────

/**
 * `a_` is Discord's animated-avatar prefix, and the CDN will not serve a WebP
 * without being told it is animated. Everything else is a plain PNG.
 */
function cdnUrl(path: string, hash: string): string {
  const animated = hash.startsWith("a_");
  return (
    `https://cdn.discordapp.com/${path}/${encodeURIComponent(hash)}` +
    `.${animated ? "webp" : "png"}?size=4096${animated ? "&animated=true" : ""}`
  );
}

type GuildMemberStoreLike = {
  getMember?: (guildId: string, userId: string) => { avatar?: string | null } | undefined;
};
type UserStoreLike = {
  getUser?: (userId: string) => { banner?: string | null; getAvatarURL?: (guildId: string | null, size: number) => string } | undefined;
};
type GuildStoreLike = { getGuild?: (guildId: string) => { icon?: string | null; banner?: string | null } | undefined };
type ChannelStoreLike = { getChannel?: (channelId: string) => { icon?: string | null } | undefined };

/**
 * A per-guild avatar wins over the global one, because that is the image the
 * menu is showing. A member with no `avatar` is not a failure — it means the
 * server has no override, and the global avatar is the right answer.
 */
function resolveUrl(context: MenuContext, kind: TargetKind): string | undefined {
  if (kind === "group") {
    const channelId = context.channelId;
    if (!channelId) return undefined;
    const icon = store<ChannelStoreLike>("ChannelStore")?.getChannel?.(channelId)?.icon;
    return icon ? cdnUrl(`channel-icons/${channelId}`, icon) : undefined;
  }

  if (kind === "guild") {
    const guildId = context.guildId;
    if (!guildId) return undefined;
    const icon = store<GuildStoreLike>("GuildStore")?.getGuild?.(guildId)?.icon;
    return icon ? cdnUrl(`icons/${guildId}`, icon) : undefined;
  }

  const userId = context.userId;
  if (!userId) return undefined;
  const guildId = context.guildId;

  if (guildId) {
    const hash = store<GuildMemberStoreLike>("GuildMemberStore")?.getMember?.(guildId, userId)?.avatar;
    if (hash) return cdnUrl(`guilds/${guildId}/users/${userId}/avatars`, hash);
  }

  return store<UserStoreLike>("UserStore")?.getUser?.(userId)?.getAvatarURL?.(guildId ?? null, 4096);
}

type ProfileStoreLike = {
  getUserProfile?: (userId: string) => { banner?: string | null } | undefined;
  getGuildMemberProfile?: (userId: string, guildId: string) => { banner?: string | null } | null | undefined;
};
function resolveBanner(context: MenuContext): {url?: string;known: boolean} {
  const id=context.userId;if(!id)return {known:false};
  const profiles=store<ProfileStoreLike>("UserProfileStore");
  const guildBanner=context.guildId?profiles?.getGuildMemberProfile?.(id,context.guildId)?.banner:undefined;
  if(guildBanner)return {url:cdnUrl(`guilds/${context.guildId}/users/${id}/banners`,guildBanner),known:true};
  const profile=profiles?.getUserProfile?.(id),user=store<UserStoreLike>("UserStore")?.getUser?.(id);
  // An explicit null in the loaded profile overrides an older UserStore banner.
  const banner=profile&&Object.hasOwn(profile,'banner')?profile.banner:user?.banner;
  return {url:banner?cdnUrl(`banners/${id}`,banner):undefined,known:!!profile||user?.banner!==undefined};
}

/** Guild banners use Discord's /banners/{guild_id}/{banner_hash} CDN route. */
function resolveServerBanner(context: MenuContext): {url?: string;known: boolean} {
  const id=context.guildId;if(!id)return {known:false};
  const guild=store<GuildStoreLike>("GuildStore")?.getGuild?.(id);
  if(!guild)return {known:false};
  const banner=guild.banner;
  // An invite splash is a different image and must not stand in for a banner.
  return {url:typeof banner==="string"&&banner?cdnUrl(`banners/${id}`,banner):undefined,
    known:banner==null||typeof banner==="string"};
}

// ── the row ─────────────────────────────────────────────────────────────────

/** A row to clone: a real action, with a real label and no submenu of its own. */
function referenceRow(menu: Element): HTMLElement | undefined {
  const preferred = menu.querySelector<HTMLElement>('[role="menuitem"][id*="user-profile"]');
  if (preferred) return preferred;
  for (const row of menu.querySelectorAll<HTMLElement>('[role="menuitem"]')) {
    if (row.hasAttribute(NATIVE_MENU_ROW)) continue;
    if (row.getAttribute("aria-haspopup") || row.getAttribute("aria-disabled") === "true") continue;
    return row;
  }
  return undefined;
}

/**
 * Retype the row without destroying it.
 *
 * The label lives in a marquee span; the fallback takes the deepest element that
 * actually carries text, which skips the icon's `<svg>`/`<path>` and keeps every
 * wrapper class the row is styled by.
 */
function setRowLabel(row: HTMLElement, text: string): void {
  const key=messageKeyForLabel(text);const apply=(element:HTMLElement):void=>{if(key)setLocalizedText(element,key);else element.textContent=text;};
  const span = row.querySelector("[data-marquee-overflow] span");
  if (span instanceof HTMLElement) {
    apply(span);
    return;
  }
  for (const node of row.querySelectorAll<HTMLElement>("*")) {
    if (node.children.length === 0 && (node.textContent ?? "").trim() !== "") {
      apply(node);
      return;
    }
  }
  apply(row);
}

/**
 * The class Discord uses to paint a row as focused.
 *
 * It is not a `:hover` rule: the client toggles this class from its own
 * `onMouseEnter` handler, so a row keeps it until *it* is told otherwise. A
 * clone carries the class but not the handler, which is why the name has to be
 * found and managed by hand. Read off a live row rather than by walking
 * `document.styleSheets`, and cached because every row in a menu shares it.
 */
let focusClassName: string | undefined;

function focusClassIn(menu: Element): string | undefined {
  if (focusClassName) return focusClassName;
  for (const row of menu.querySelectorAll('[role="menuitem"]')) {
    for (const className of row.classList) {
      if (/focus/i.test(className)) return (focusClassName = className);
    }
  }
  return undefined;
}

async function copyUrl(url: string, log: Logger, label=i18nText("ui.image")): Promise<void> {
  try {
    // `clipboard-sanitized-write` is granted to the Discord origin in
    // `src/main/security/permissions.ts`, so the renderer clipboard is the
    // sanctioned route here.
    await navigator.clipboard.writeText(url);
    toast.show(i18nText("ui.value_url_copied", {v0: label}), { type: ToastType.SUCCESS });
  } catch (err) {
    log.error("copy image URL failed:", err);
    toast.show(i18nText("ui.couldn_t_copy_value_url", {v0: label.toLowerCase()}), { type: ToastType.FAILURE });
  }
}

function closeContextMenu(): void {
  const flux = window.Syncord?.common?.flux.FluxDispatcher as
    | { dispatch?: (action: unknown) => void }
    | undefined;
  flux?.dispatch?.({ type: "CONTEXT_MENU_CLOSE" });
}

type MountOptions = {
  log: Logger;
  report: (navId: string) => void;
};

/**
 * Put one row into one menu.
 *
 * Idempotent on purpose: Discord re-renders a menu when focus moves, and a React
 * re-render can drop a node that was inserted behind its back. Re-adding on the
 * next scan is cheaper than fighting the reconciler.
 */
function mountMenu(menu: Element, options: MountOptions): void {
  const navId = menu.id;
  if (!navId || isMessageNav(navId) || IGNORED_NAVS.has(navId)) return;

  if (!AVATAR_NAVS.has(navId)) {
    options.report(navId);
    return;
  }

  const context = inspectMenu(menu);
  if (!context) return;
  const kind = kindOf(context);
  if (!kind) return;

  const target=JSON.stringify([kind,context.userId,context.guildId,context.channelId]);
  for(const row of menu.querySelectorAll<HTMLElement>(`[${ROW_MARKER}]`))if(row.dataset.copyTarget!==target)row.remove();
  const actions:TargetKind[]=kind==='user'?[kind,'banner']:kind==='guild'?[kind,'guild-banner']:[kind];
  for(const action of actions)mountCopyRow(menu,options,context,action,target);
}
function mountCopyRow(menu:Element,options:MountOptions,context:MenuContext,kind:TargetKind,target:string):void {
  const isBanner=kind==='banner'||kind==='guild-banner';
  const serverBanner=kind==='guild-banner';
  const marker=isBanner?kind:'avatar';
  if(menu.querySelector(`[${ROW_MARKER}="${marker}"]`))return;
  const navId=menu.id;
  const sample = referenceRow(menu);
  if (!sample?.parentElement) return;

  const row = sample.cloneNode(true);
  if (!(row instanceof HTMLElement)) return;

  row.id = serverBanner?"dion-copy-server-banner":isBanner?"dion-copy-banner":ROW_ID;
  row.setAttribute(ROW_MARKER, marker);row.setAttribute(NATIVE_MENU_ROW,"");row.dataset.copyTarget=target;
  const labelKey=messageKeyForLabel(LABELS[kind]);
  if(labelKey)setLocalizedAttribute(row,"aria-label",labelKey);else row.setAttribute("aria-label",LABELS[kind]);
  row.removeAttribute("aria-describedby");
  row.removeAttribute("aria-labelledby");
  // A clone inherits the sample's danger styling; the copy row is never one.
  for (const className of [...row.classList]) {
    if (/danger|focus/i.test(className)) row.classList.remove(className);
  }
  setRowLabel(row, LABELS[kind]);

  let done = false;
  const copy = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (done) return;
    done = true;

    // Resolved here, not when the row was built: the member's per-guild avatar
    // can arrive after the menu opened, and resolving here is the only moment
    // that matters to the user.
    let url:string|undefined;
    try {
      if(isBanner){
        const banner=serverBanner?resolveServerBanner(context):resolveBanner(context);url=banner.url;
        if(!url){
          closeContextMenu();
          const message=serverBanner
            ? banner.known?i18nText("ui.this_server_has_no_banner"):i18nText("ui.server_banner_data_is_not_available_yet_reopen_this_server_s_menu_and_")
            : banner.known?i18nText("ui.this_user_has_no_banner"):i18nText("ui.banner_data_is_not_available_yet_open_the_user_s_profile_and_try_again");
          toast.show(message,{type:ToastType.FAILURE});
          return;
        }
      }else url=resolveUrl(context,kind);
    }catch(error){
      options.log.error("Image lookup failed",error);closeContextMenu();
      toast.show(serverBanner?i18nText("ui.couldn_t_read_this_server_s_banner"):isBanner?i18nText("ui.couldn_t_read_this_user_s_banner"):i18nText("ui.couldn_t_read_image_url"),{type:ToastType.FAILURE});return;
    }
    if (!url) {
      options.log.warn(`nothing to copy for the "${navId}" menu`);
      toast.show(i18nText("ui.nothing_to_copy_here"), { type: ToastType.FAILURE });
      return;
    }
    closeContextMenu();
    void copyUrl(url, options.log,serverBanner?i18nText("ui.server_banner"):isBanner?i18nText("ui.banner"):i18nText("ui.image"));
  };

  row.addEventListener("pointerdown", copy, true);
  row.addEventListener("click", copy, true);
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") copy(event);
  }, true);

  // Discord paints a focused row with a class it toggles from its own mouse
  // handler, and the marquee stays collapsed until the row is the active one.
  // The clone carries the class but not the handler, so both are managed here —
  // and the neighbours are cleared too, or the row the pointer came from stays
  // lit underneath the row the pointer is now on.
  row.setAttribute("data-marquee-active", "false");
  const setFocus = (on: boolean): void => {
    const className = focusClassIn(menu);
    for (const other of menu.querySelectorAll<HTMLElement>('[role="menuitem"]')) {
      if (className) other.classList.toggle(className, on && other === row);
      other.setAttribute("data-marquee-active", String(on && other === row));
    }
    if (!on) row.setAttribute("data-marquee-active", "false");
  };
  row.addEventListener("pointerenter", () => setFocus(true));
  row.addEventListener("pointerleave", () => setFocus(false));

  const anchor=isBanner?menu.querySelector(`[${ROW_MARKER}="avatar"]`)??sample:sample;
  anchor.insertAdjacentElement("afterend", row);
}

// ── the plugin ──────────────────────────────────────────────────────────────

const reportedNavIds = new Set<string>();

/**
 * Copies a user's avatar/banner, a server icon/banner or a group DM icon from
 * Discord's own context menus.
 */
export const CopyAvatarPlugin = definePlugin({
  id: "copy-avatar",
  name: i18nText("ui.copy_avatar"),
  get description() { return i18nText("ui.copy_user_avatar_banner_server_icon_banner_or_group_icon_urls_from_dis"); },
  author: i18nText("ui.syncord"),
  enabledByDefault: true,

  /**
   * Reads native stores: the user for the avatar URL and the profile for banners,
   * the member for a per-guild override, the guild for the server icon/banner and the
   * channel for a group icon. Nothing is patched and no request is made — the
   * URLs point at Discord's own CDN and the plugin never fetches them, so
   * `webpackPatch`, `media` and `network` are all absent on purpose.
   */
  permissions: {
    clipboard: true,
    discordStores: ["user", "guild", "channel", "member", "profile"],
  },

  start(ctx) {
    const options: MountOptions = {
      log: ctx.log,
      report: (navId) => {
        if (reportedNavIds.has(navId)) return;
        reportedNavIds.add(navId);
        ctx.log.warn(`context menu "${navId}" is not in AVATAR_NAVS — no avatar row was added`);
      },
    };

    const reset=():void=>{for(const node of document.querySelectorAll(`[${ROW_MARKER}]`))node.remove();};
    const unwatch=watchNativeMenus({menu:menu=>mountMenu(menu,options),reset,log:ctx.log});
    ctx.disposable(()=>{unwatch();focusClassName=undefined;});

    ctx.log.info("ready");
  },
});
