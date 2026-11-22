/*
 * Syncord Injector — frontend.
 *
 * This file is the *untrusted* half of the application. It runs in a webview
 * that has no filesystem access, no process spawning and no network: the Tauri
 * capability file grants core events and explicit main-window controls, and no command
 * accepts a path — they take an index into a list Rust discovered before the
 * window opened.
 *
 * So the rules for this file are short:
 *
 *   - never build a path, and never send one;
 *   - never decide anything security-relevant;
 *   - render what it is told, and report honestly when something failed.
 *
 * Everything is inserted with `textContent`, never `innerHTML`. `path` comes
 * from the filesystem and could contain anything a directory name legally can;
 * interpolating it into markup would be a DOM injection sink that buys nothing,
 * because the correct way to display a path is as text.
 */

const invoke = window.__TAURI__?.core?.invoke ?? (() => Promise.reject(new Error("unavailable")));

/** @type {{ installs: any[], payloadVersion: string|null, payloadUnavailable: string|null, injectorVersion: string }|null} */
let startup = null;

const el = {
  version: document.getElementById("injector-version"),
  summary: document.getElementById("summary"),
  installs: document.getElementById("installs"),
  empty: document.getElementById("empty"),
  rescan: document.getElementById("rescan"),
  banner: document.getElementById("payload-banner"),
  bannerMessage: document.getElementById("payload-message"),
  toast: document.getElementById("toast"),
  toastMessage: document.getElementById("toast-message"),
  toastHelp: document.getElementById("toast-help"),
  toastClose: document.getElementById("toast-close"),
  confirm: document.getElementById("confirm"),
  confirmTitle: document.getElementById("confirm-title"),
  confirmBody: document.getElementById("confirm-body"),
  confirmCancel: document.getElementById("confirm-cancel"),
  confirmAccept: document.getElementById("confirm-accept"),
  permission: document.getElementById("permission"),
  permissionTitle: document.getElementById("permission-title"),
  permissionBody: document.getElementById("permission-body"),
  permissionClose: document.getElementById("permission-close"),
  permissionRecheck: document.getElementById("permission-recheck"),
  permissionOpen: document.getElementById("permission-open"),
};

/**
 * Install rows whose write access is blocked, by the name `WriteAccess::as_str`
 * sends. Kept as a list rather than a set of booleans so that adding a cause in
 * the core does not silently leave the frontend treating it as fine.
 */
const BLOCKED_ACCESS = new Set([
  "appManagement",
  "directoryPermissions",
  "readOnlyVolume",
  "missing",
]);

const isBlocked = (row) => BLOCKED_ACCESS.has(row.access);

/* One floating menu, with deterministic focus and no per-row document listeners. */
let openMenu = null;
let actionBusy = false;
function closeMenu(restoreFocus = false) {
  if (!openMenu) return;
  const { menu, trigger } = openMenu;
  openMenu = null;
  menu.hidden = true;
  trigger.setAttribute("aria-expanded", "false");
  if (restoreFocus && trigger.isConnected) trigger.focus({ preventScroll: true });
}
function showMenu(menu, trigger, last = false) {
  if (actionBusy || pendingConfirm) return;
  if (openMenu?.menu === menu) { closeMenu(true); return; }
  closeMenu();
  menu.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  openMenu = { menu, trigger };
  const box = trigger.getBoundingClientRect();
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(12, Math.min(box.right - rect.width + 26, innerWidth - rect.width - 12)) + "px";
  menu.style.top = Math.max(12, Math.min(box.bottom + 10, innerHeight - rect.height - 12)) + "px";
  const buttons = [...menu.querySelectorAll("button:not(:disabled)")];
  (last ? buttons.at(-1) : buttons[0])?.focus({ preventScroll: true });
}
document.addEventListener("pointerdown", event => {
  if (openMenu && !openMenu.menu.contains(event.target) && !openMenu.trigger.contains(event.target)) closeMenu();
});
document.addEventListener("keydown", event => {
  if (!openMenu) return;
  if (event.key === "Escape") { event.preventDefault(); closeMenu(true); return; }
  if (event.key === "Tab") { closeMenu(true); return; }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const buttons = [...openMenu.menu.querySelectorAll("button:not(:disabled)")];
  const current = buttons.indexOf(document.activeElement);
  const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
  buttons[index]?.focus();
});
window.addEventListener("resize", () => closeMenu(true));
document.addEventListener("scroll", event => { if (openMenu && !openMenu.menu.contains(event.target)) closeMenu(true); }, true);

// These operate only the current Tauri window. No custom Rust command or raw
// filesystem/process capability is exposed for titlebar interactions.
const appWindow = window.__TAURI__?.window?.getCurrentWindow?.();
for (const [id, method] of [["window-minimize", "minimize"], ["window-maximize", "toggleMaximize"], ["window-close", "close"]]) {
  const button = document.getElementById(id);
  if (!button) continue;
  button.disabled = !appWindow;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await appWindow[method](); }
    catch (err) { toast("Could not change the window.", { help: String(err), kind: "error" }); }
    finally { button.disabled = false; }
  });
}

/* ── Toast ────────────────────────────────────────────────────────────────── */

let toastTimer = null;

function toast(message, { help = null, kind = "info", duration = 9000 } = {}) {
  clearTimeout(toastTimer);
  el.toastMessage.textContent = message;
  el.toast.classList.remove("is-error", "is-success");
  if (kind !== "info") el.toast.classList.add(`is-${kind}`);

  if (help) {
    el.toastHelp.textContent = help;
    el.toastHelp.hidden = false;
  } else {
    el.toastHelp.hidden = true;
  }

  el.toast.hidden = false;
  toastTimer = setTimeout(hideToast, duration);
}

function hideToast() {
  el.toast.hidden = true;
  clearTimeout(toastTimer);
}

el.toastClose.addEventListener("click", hideToast);

/* ── Confirm dialog ────────────────────────────────────────────────────────── */

/** @type {{resolve:(ok:boolean)=>void}|null} */
let pendingConfirm = null;

/** A promise-based confirm, built on <dialog> so focus and Escape work. */
function confirmAction({ title, body, acceptLabel }) {
  if (pendingConfirm || actionBusy) return Promise.resolve(false);
  closeMenu(true);
  el.confirmTitle.textContent = title;
  el.confirmBody.textContent = body;
  el.confirmAccept.textContent = acceptLabel;

  return new Promise((resolve) => {
    pendingConfirm = { resolve };
    el.confirm.showModal();
  });
}

function settleConfirm(value) {
  const pending = pendingConfirm;
  pendingConfirm = null;
  if (el.confirm.open) el.confirm.close();
  pending?.resolve(value);
}

el.confirmCancel.addEventListener("click", () => settleConfirm(false));

// Without this the dialog opens, the button looks pressable, and pressing it
// does nothing — Uninject would silently never run. The DOM test in
// `injector/tests/frontend/` presses it for exactly this reason.
el.confirmAccept.addEventListener("click", () => settleConfirm(true));

// Native close events are queued: an event from a cancelled dialog can arrive
// after the next dialog opened. Only dismiss a confirmation that is still closed.
el.confirm.addEventListener("close", () => {
  if (pendingConfirm && !el.confirm.open) settleConfirm(false);
});

/* ── The permission helper ────────────────────────────────────────────────── */

/** The pane the open dialog is about. `null` means there is none. */
let pendingPane = null;

/**
 * A short title per cause, so the user sees what is wrong before they read how
 * to fix it. Written here rather than sent from Rust because this is wording for
 * a heading, not a diagnosis — the diagnosis is the `access` name itself.
 */
const ACCESS_TITLE = {
  appManagement: "macOS has not allowed this app to change Discord",
  directoryPermissions: "This Discord belongs to another account",
  readOnlyVolume: "That disk is read-only",
  missing: "This Discord is no longer there",
  unknown: "The Injector could not write to this Discord",
};

/**
 * Show the helper for a row whose write is refused.
 *
 * `pane` is a *name* the core chose, never a URL. The frontend cannot name an
 * address, so this window cannot be talked into opening one.
 */
function showPermission(row, pane = null) {
  pendingPane = pane ?? (row.access === "appManagement" ? "appManagement" : null);
  el.permissionTitle.textContent = ACCESS_TITLE[row.access] ?? ACCESS_TITLE.unknown;
  // The hint arrives already written for this cause, so there is one place
  // where the wording lives.
  el.permissionBody.textContent =
    row.accessHint ?? "The Injector could not write to this Discord.";
  el.permissionOpen.hidden = pendingPane === null;
  if (!el.permission.open) el.permission.showModal();
}

el.permissionClose.addEventListener("click", () => el.permission.close());

/**
 * Re-measure write access.
 *
 * Present because the alternative is worse: a user who grants a privacy
 * setting and returns to a window that still says the write is refused has no
 * way to tell "the setting did not work" from "the window never re-checked".
 */
el.permissionRecheck.addEventListener("click", async () => {
  const button = el.permissionRecheck;
  button.disabled = true;
  try {
    const state = await invoke("check_write_access");
    render(state);
    const stillBlocked = state.installs.filter(isBlocked);
    if (stillBlocked.length > 0) {
      // Keep the dialog open, now saying what is still wrong. Closing it would
      // leave the user with a window that silently still refuses.
      showPermission(stillBlocked[0]);
    } else {
      el.permission.close();
      toast("The Injector can write to this Discord now.", { kind: "success" });
    }
  } catch (err) {
    toast("Could not check again.", { help: String(err), kind: "error" });
  } finally {
    button.disabled = false;
  }
});

el.permissionOpen.addEventListener("click", async () => {
  const button = el.permissionOpen;
  button.disabled = true;
  try {
    const result = await invoke("open_settings", { pane: pendingPane });
    if (!result.ok) {
      toast(result.message, { help: result.help ?? null, kind: "error" });
    }
  } catch (err) {
    toast("Could not open System Settings.", { help: String(err), kind: "error" });
  } finally {
    button.disabled = false;
  }
});

/* ── Rendering ─────────────────────────────────────────────────────────────── */

/** Build one element. Text only — see the file header. */
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/**
 * The badge tells the user three different things, and conflating them would be
 * the worst possible bug in this window:
 *
 *   not installed     nothing to act on
 *   installed         Syncord is there and its bundles match a signed manifest
 *   installed, unverified
 *                     Syncord is there but the bundles did **not** verify
 *
 * The third deliberately does not say "modified". A failed verification means we
 * could not confirm, not that someone changed anything — and a development
 * install is unsigned by construction, so "Modified" would accuse a developer of
 * tampering with their own machine. What the user needs to know is that this
 * build cannot vouch for what is installed, and that installing again is the fix.
 */
function badgeFor(row) {
  if (!row.injected) return { text: "Not installed", className: "badge" };
  if (!row.verified) return { text: "Unverified — reinstall", className: "badge is-pending" };
  if (row.launchReady === false) return { text: "Repair required", className: "badge is-pending" };

  const version = row.version ? `v${row.version}` : "version unknown";
  return { text: `Installed · ${version}`, className: "badge is-installed" };
}

function renderInstalls(state) {
  const focusedIndex = openMenu?.trigger.dataset.installIndex;
  closeMenu();
  el.installs.replaceChildren();

  if (state.installs.length === 0) {
    el.empty.hidden = false;
    // The list is a bordered card. Empty, it is a 1px rectangle above the empty
    // state, which looks like a rendering fault rather than like "none found".
    el.installs.hidden = true;
    el.summary.textContent = "Nothing found.";
    return;
  }

  el.empty.hidden = true;
  el.installs.hidden = false;
  const injected = state.installs.filter((row) => row.injected && row.launchReady !== false && row.verified).length;
  const repairs = state.installs.filter((row) => row.injected && (row.launchReady === false || !row.verified)).length;
  el.summary.textContent = repairs > 0
    ? `Found ${state.installs.length} · Ready in ${injected} · Repair needed in ${repairs}.`
    : injected === 0
      ? `Found ${state.installs.length} · Syncord not installed.`
      : `Found ${state.installs.length} · Syncord installed in ${injected}.`;

  for (const row of state.installs) {
    el.installs.appendChild(renderRow(row, state));
  }
  if (focusedIndex !== undefined) [...el.installs.querySelectorAll(".more-button")].find(button => button.dataset.installIndex === focusedIndex)?.focus();
}

function renderRow(row, state) {
  const item = node("li", "install");

  const tile = node("img", "client-tile");
  tile.src = "assets/discord-client-tile.png";
  tile.alt = "";
  tile.width = tile.height = 118;
  item.appendChild(tile);
  const main = node("div", "install-main");
  const title = node("div", "install-title");
  title.appendChild(node("span", "install-name", row.label));

  const badge = badgeFor(row);
  title.appendChild(node("span", badge.className, badge.text));
  main.appendChild(title);
  main.appendChild(node("div", "install-path", row.path));

  if (row.injected && row.fingerprint) {
    main.appendChild(
      node("p", "install-note", `Build ${row.fingerprint} · ${row.verified ? "signature verified" : "could not be verified"}`),
    );
  }

  if (row.injected && row.launchReady === false) {
    main.appendChild(node("p", "install-note", "Discord's startup files changed. Close Discord completely, then choose Repair."));
  }

  const progress = node("p", "install-note action-status");
  progress.hidden = true;
  progress.setAttribute("role", "status");
  main.appendChild(progress);
  const actions = node("div", "install-actions");
  actions.id = `install-actions-${row.index}`;
  actions.hidden = true;
  actions.setAttribute("role", "menu");
  actions.setAttribute("aria-label", `${row.label} actions`);
  const more = node("button", "more-button");
  more.type = "button";
  more.dataset.installIndex = String(row.index);
  more.setAttribute("aria-label", `${row.label} actions`);
  more.setAttribute("aria-haspopup", "menu");
  more.setAttribute("aria-expanded", "false");
  more.setAttribute("aria-controls", actions.id);
  const dots = node("span", "control-icon icon-more");
  dots.setAttribute("aria-hidden", "true");
  more.appendChild(dots);
  more.addEventListener("click", () => showMenu(actions, more));
  more.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      showMenu(actions, more, event.key === "ArrowUp");
    }
  });
  const canWrite = state.releaseVersion != null || state.payloadVersion !== null;
  // Refused write access is a known, fixable cause, so the action is withheld
  // rather than left to fail — and the row says why, so a disabled button is
  // never just "disabled". Removing Syncord does not need write access to the
  // payload, so Uninject stays available regardless.
  const blocked = isBlocked(row);

  if (row.injected) {
    const repair = row.launchReady === false || !row.verified;
    const update = node("button", "primary", canWrite ? (repair ? "Repair" : "Update") : "Install");
    update.disabled = !canWrite || blocked;
    update.addEventListener("click", () => void runInstall(row, update, item));
    actions.appendChild(update);

    const remove = node("button", "ghost", "Uninject");
    remove.addEventListener("click", () => void runUninject(row, remove, item));
    actions.appendChild(remove);
  } else {
    const install = node("button", "primary", "Inject");
    install.disabled = !canWrite || blocked;
    install.addEventListener("click", () => void runInstall(row, install, item));
    actions.appendChild(install);
  }

  item.appendChild(main);
  item.appendChild(more);
  item.appendChild(actions);

  if (blocked) {
    item.classList.add("is-blocked");
    const note = node("p", "access-note");
    note.appendChild(node("span", null, ACCESS_TITLE[row.access] ?? ACCESS_TITLE.unknown));
    const fix = node("button", "ghost", "What do I do?");
    fix.addEventListener("click", () => showPermission(row));
    note.appendChild(fix);
    item.appendChild(note);
  }

  if (state.payloadVersion && !blocked) {
    const offline = node("button", "secondary", `Install bundled ${state.payloadVersion}`);
    offline.addEventListener("click", async () => {
      const ok = await confirmAction({ title: "Install bundled client?", body: `This installs the verified ${state.payloadVersion} payload bundled with this Injector, without checking GitHub.`, acceptLabel: "Install bundled" });
      if (ok) await withBusy(item, offline, "Installing…", () => invoke("install_bundled", { index: row.index }));
    });
    actions.appendChild(offline);
  }
  for (const button of actions.querySelectorAll("button")) {
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.tabIndex = -1;
    const art = node("span", "action-icon " + (button.classList.contains("primary") ? (row.injected ? "icon-repair" : "icon-install") : button.classList.contains("ghost") ? "icon-uninject" : "icon-install"));
    art.setAttribute("aria-hidden", "true");
    button.prepend(art);
  }
  return item;
}

function renderBanner(state) {
  if (state.releaseError) {
    el.bannerMessage.textContent = `GitHub update check failed: ${state.releaseError} The bundled client is available separately.`;
    el.banner.hidden = false;
    return;
  }
  if (state.payloadVersion || state.releaseVersion) {
    el.banner.hidden = true;
    return;
  }
  el.bannerMessage.textContent =
    state.payloadUnavailable ?? "No verified payload is available to install.";
  el.banner.hidden = false;
}

function render(state) {
  if (actionBusy) return;
  startup = state;
  el.version.textContent = `v${state.injectorVersion}`;
  renderBanner(state);
  renderInstalls(state);
}

/* ── Actions ───────────────────────────────────────────────────────────────── */

/**
 * Disable a row for the duration of an action.
 *
 * The action is a filesystem write in another process's directory. Two clicks
 * would be two concurrent writes to the same install, and the second would
 * either fail confusingly or — worse — race the directory swap.
 */
async function withBusy(item, button, label, work, onRefused = null) {
  if (actionBusy || pendingConfirm) return { ok: false };
  actionBusy = true;
  closeMenu(true);
  const previous = button.textContent;
  item.classList.add("is-busy");
  item.setAttribute("aria-busy", "true");
  const progress = item.querySelector(".action-status");
  progress.textContent = label;
  progress.hidden = false;
  for (const control of el.installs.querySelectorAll("button")) control.disabled = true;
  el.rescan.disabled = true;
  button.textContent = label;
  try {
    const result = await work();
    if (result.ok) {
      toast(result.message, { kind: "success" });
    } else {
      toast(result.message, { help: result.help ?? null, kind: "error" });
      // A refusal that names a settings screen is not finished being reported
      // by a toast. Toast disappears; a permission the user has to go and change
      // should not.
      if (result.pane && onRefused) onRefused(result);
    }
    return result;
  } catch (err) {
    // A rejected invoke means the command itself failed, which is a bug rather
    // than a refusal. Say so rather than showing a blank.
    toast("The Injector could not complete that action.", { help: String(err), kind: "error" });
    return { ok: false, message: String(err), help: null, pane: null };
  } finally {
    actionBusy = false;
    item.classList.remove("is-busy");
    item.removeAttribute("aria-busy");
    progress.hidden = true;
    el.rescan.disabled = false;
    button.textContent = previous;
    if (startup) await refresh();
    [...el.installs.querySelectorAll(".more-button")].find(trigger=>trigger.dataset.installIndex===String(item.querySelector(".more-button")?.dataset.installIndex))?.focus();
  }
}

async function runInstall(row, button, item) {
  await withBusy(
    item,
    button,
    "Checking and downloading…",
    () => invoke("inject_into", { index: row.index }),
    // The row may not know the cause yet — the refusal is what revealed it.
    (result) => {
      const fresh = startup?.installs?.find((entry) => entry.index === row.index);
      showPermission(
        fresh ?? { access: "unknown", accessHint: result.help ?? result.message },
        result.pane,
      );
    },
  );
}

async function runUninject(row, button, item) {
  const ok = await confirmAction({
    title: "Remove Syncord?",
    body: `Syncord will be removed from ${row.label} and Discord will be restored to its own files. Your Discord settings and messages are not affected.`,
    acceptLabel: "Uninject",
  });
  if (!ok) return;

  await withBusy(
    item,
    button,
    "Working…",
    () => invoke("uninject_from", { index: row.index }),
    (result) => {
      const fresh = startup?.installs?.find((entry) => entry.index === row.index);
      showPermission(
        fresh ?? { access: "unknown", accessHint: result.help ?? result.message },
        result.pane,
      );
    },
  );
}

/* ── Boot ──────────────────────────────────────────────────────────────────── */

/**
 * Put the window into the state that cannot be wrong.
 *
 * `render` can fail part-way through, and a half-applied state is worse than an
 * empty one: the previous scan's rows stay on screen looking current, so a user
 * could press Uninject on a Discord that was uninstalled since. Starting from
 * nothing is the state that cannot be stale.
 *
 * The banner goes down for the same reason. `renderBanner` runs before
 * `renderInstalls`, so a response that carries a usable payload field but a
 * broken list leaves the banner up asserting "no verified payload is available"
 * — a confident, specific diagnosis the user would go and act on, for a problem
 * that is not the one they have. When the state did not render, the payload
 * state is *unknown*, and unknown is not the same as absent.
 *
 * Shared by `refresh` and the Rescan button, because both call `render` and both
 * can be left half-applied. Two copies of this would drift, and the second one
 * would be the one nobody tests.
 */
function reportUnreadable(message, err) {
  closeMenu();
  el.installs.replaceChildren();
  el.installs.hidden = true;
  el.empty.hidden = true;
  el.banner.hidden = true;
  el.summary.textContent = message;
  toast(message, { help: String(err), kind: "error" });
}

async function refresh() {
  try {
    render(await invoke("startup"));
  } catch (err) {
    reportUnreadable("Could not read the Discord list.", err);
  }
}

el.rescan.addEventListener("click", () => {
  if (actionBusy || pendingConfirm || el.rescan.disabled) return;
  closeMenu();
  el.rescan.disabled = true;
  invoke("rescan")
    .then(render)
    .catch((err) => reportUnreadable("Rescan failed.", err))
    .finally(() => {
      el.rescan.disabled = false;
    });
});

void refresh().then(() => invoke("check_updates").then((state) => {
  render(state);
  if (state.releaseError) toast(state.releaseError, { kind: "error" });
}).catch((err) => toast(`Could not check GitHub: ${err}`, { kind: "error" })));
