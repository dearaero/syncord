import { setLocalizedAttribute, setLocalizedText, t as i18nText } from "../../i18n";
const FRIENDS = "a[href=\"/channels/@me\"], a[href=\"/channels/@me/\"]";
export const NOTES_ICON = '<path fill="currentColor" d="M5 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8l-6-6H5Zm9 2 5 5h-5V4ZM7 12h10v2H7v-2Zm0 4h8v2H7v-2Z"/>';
function visible(el: Element): el is HTMLElement { return el instanceof HTMLElement && el.getBoundingClientRect().width > 0; }
export function findFriends(): HTMLAnchorElement | undefined {
  // Scope to private-channel navigation first: the home server icon has the same URL.
  const candidates = [...document.querySelectorAll<HTMLAnchorElement>(FRIENDS)].filter(visible);
  return candidates.find(a => a.closest('[class*="privateChannels"]'))
    ?? candidates.find(a => /^(Arkadaşlar|Friends)$/i.test(a.textContent?.trim() ?? ""));
}
export function findChatHost(friends: HTMLElement): HTMLElement | undefined {
  const sidebar = friends.closest<HTMLElement>('[class*="privateChannels"]') ?? friends.closest<HTMLElement>('nav');
  if (!sidebar) return;
  const side = sidebar.getBoundingClientRect();
  // The native content container is a sibling of the sidebar (possibly one level up).
  let branch: HTMLElement | null = sidebar;
  for (let depth = 0; branch?.parentElement && depth < 6; depth++, branch = branch.parentElement) {
    const siblings = [...branch.parentElement.children].filter((e): e is HTMLElement => e instanceof HTMLElement && e !== branch);
    const host = siblings.find(e => {
      const r = e.getBoundingClientRect();
      return r.left >= side.right - 4 && r.width >= 180 && r.height >= 180 && !e.matches('[class*="layerContainer"], [role="dialog"]');
    });
    if (host) return host;
  }
}
/** An owned row preserves Discord's native structure/classes; no React exports are rewritten. */
export function installNotesNavigation(onOpen: (friends: HTMLAnchorElement) => void, onNavigate: () => void): { selected: (active: boolean) => void; dispose: () => void } {
  let row: HTMLElement | undefined;
  let source: HTMLAnchorElement | undefined;
  let frame = 0;
  let active = false;
  let disposed = false;
  let navigation: HTMLElement | undefined;
  function updateSelection(): void {
    const next = active ? source?.closest<HTMLElement>('[class*="privateChannels"]') ?? source?.closest<HTMLElement>("nav") ?? undefined : undefined;
    if (navigation !== next) { navigation?.removeAttribute("data-syncord-notes-active"); navigation = next; }
    navigation?.setAttribute("data-syncord-notes-active", "true");
    row?.classList.toggle("sn-nav-selected", active);
    (row?.matches("a") ? row : row?.querySelector("a"))?.setAttribute("aria-pressed", String(active));
  }
  function scan(): void {
    frame = 0;
    const friends = findFriends();
    if (friends === source && row?.isConnected) return;
    row?.remove(); row = undefined; source = friends;
    if (!friends) { updateSelection(); return; }
    const wrapper = friends.closest<HTMLElement>('[class*="channel_"], [class*="channel__"], [role="listitem"]');
    const original = wrapper && wrapper.querySelectorAll("a").length === 1 ? wrapper : friends;
    const clone = original.cloneNode(true) as HTMLElement;
    clone.dataset.syncordNotesNav = "";
    for (const el of [clone, ...clone.querySelectorAll<HTMLElement>("*")]) {
      el.removeAttribute("id"); el.removeAttribute("data-list-item-id"); el.removeAttribute("aria-current");
      el.removeAttribute("aria-selected"); el.removeAttribute("data-selected"); el.removeAttribute("data-active");
      // Discord also uses interactiveSelected/linkButtonSelected, not just selected_<hash>.
      for (const c of [...el.classList]) if (/^(?:selected|active)(?:_|$)|Selected(?:_|$)/.test(c)) el.classList.remove(c);
    }
    const link = clone instanceof HTMLAnchorElement ? clone : clone.querySelector<HTMLAnchorElement>("a");
    if (!link) return;
    link.classList.add("sn-nav-link");
    link.removeAttribute("href"); link.setAttribute("role", "button"); link.tabIndex = 0;
    setLocalizedAttribute(link, "aria-label", "ui.notes"); link.setAttribute("aria-pressed", String(active));
    const label = link.querySelector<HTMLElement>('[class*="name_"], [class*="name__"]')
      ?? [...link.querySelectorAll<HTMLElement>("*")].find(e => e.children.length === 0 && /^(Friends|Arkadaşlar)$/.test(e.textContent?.trim() ?? ""));
    if (label) setLocalizedText(label, "ui.notes");
    else { setLocalizedText(link, "ui.notes"); }
    const svg = link.querySelector("svg");
    if (svg) { svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); svg.innerHTML = NOTES_ICON; }
    clone.classList.toggle("sn-nav-selected", active);
    const activate = (event: Event): void => { event.preventDefault(); event.stopPropagation(); onOpen(friends); };
    link.addEventListener("click", activate);
    link.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") activate(event); });
    original.parentElement?.insertBefore(clone, original); row = clone; updateSelection();
  }
  function schedule(): void { if (!frame) frame = requestAnimationFrame(scan); }
  const observer = new MutationObserver(records => {
    // No scanning on editor keystrokes or arriving messages. Only navigation remounts matter.
    if (source && (!source.isConnected || !row?.isConnected)) { schedule(); return; }
    if (source) return;
    if (records.some(r => [...r.addedNodes].some(n => n instanceof Element && (n.matches(FRIENDS) || !!n.querySelector(FRIENDS))))) schedule();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const click = (event: MouseEvent): void => {
    if (!active || !(event.target instanceof Element) || event.target.closest('[data-syncord-notes-nav], .sn-workspace')) return;
    const link = event.target.closest<HTMLAnchorElement>('a[href]');
    const privateNavigation = source?.closest('[class*="privateChannels"]') ?? source?.closest("nav");
    const nativePage = link && (link.getAttribute("href")?.startsWith("/channels/") || privateNavigation?.contains(link));
    if (nativePage || event.target.closest('[data-list-item-id^="guildsnav___"]')) onNavigate();
  };
  document.addEventListener("click", click, true);
  window.addEventListener("popstate", onNavigate);
  schedule();
  return {
    selected(value) { if (disposed) return; active = value; updateSelection(); },
    dispose() { disposed = true; navigation?.removeAttribute("data-syncord-notes-active"); navigation = undefined; observer.disconnect(); if (frame) cancelAnimationFrame(frame); row?.remove(); document.removeEventListener("click", click, true); window.removeEventListener("popstate", onNavigate); },
  };
}
export function mountNotesSurface(host: HTMLElement, root: HTMLElement): () => void {
  const positioned = getComputedStyle(host).position === "static";
  if (positioned) host.classList.add("sn-host");
  const covered = new Map<HTMLElement, boolean>();
  function cover(): void {
    for (const [child, wasInert] of covered) {
      if (child.parentElement === host) continue;
      child.inert = wasInert; child.classList.remove("sn-covered"); covered.delete(child);
    }
    for (const child of host.children) {
      if (!(child instanceof HTMLElement) || child === root || covered.has(child)
        || child.matches('[role="dialog"], [data-popover-layer], [class*="layerContainer"]')) continue;
      covered.set(child, child.inert); child.inert = true; child.classList.add("sn-covered");
    }
  }
  host.appendChild(root); cover();
  const observer = new MutationObserver(cover); observer.observe(host, { childList: true });
  return () => {
    observer.disconnect(); root.remove();
    for (const [child, wasInert] of covered) { child.inert = wasInert; child.classList.remove("sn-covered"); }
    if (positioned) host.classList.remove("sn-host");
  };
}
