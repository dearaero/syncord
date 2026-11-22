import { t as i18nText } from "../../i18n";
import { definePlugin } from "../../api/plugin";
import { toast, ToastType } from "../../ui/toast";
import { findChatHost, installNotesNavigation, mountNotesSurface } from "./navigation";
import { NotesStore, type Note } from "./store";
import { NotesWorkspace } from "./workspace";
import { NOTES_CSS } from "./styles";
type Session = { workspace: NotesWorkspace; store: NotesStore; detach: () => void; account: string };
let finishStop: Promise<void> | undefined;
// A failed write can be retried after closing/re-enabling; at most one unsaved document is retained.
let recovery: { account: string; note: Note } | undefined;
export const NotesPlugin = definePlugin({
  id: "notes",
  name: i18nText("ui.notes"),
  get description() { return i18nText("ui.local_markdown_notes_from_your_dm_sidebar_with_previews_templates_and_"); },
  author: i18nText("ui.syncord"),
  enabledByDefault: true,
  permissions: { media: true, discordStores: ["user"] },
  start(ctx) {
    ctx.css.inject(NOTES_CSS);
    let session: Session | undefined;
    let closing: Promise<boolean> | undefined;
    let forceClose = false;
    let stopped = false;
    let opening = false;
    let epoch = 0;
    const report = (error: unknown): void => {
      ctx.log.warn("Notes:", error);
      toast.show(error instanceof Error ? error.message : i18nText("ui.could_not_open_notes_please_try_again"), { type: ToastType.FAILURE, duration: 7000 });
    };
    const close = (force = false): Promise<boolean> => {
      epoch++;
      if (closing) { forceClose ||= force; if (force && session) session.workspace.root.hidden = true; return closing; }
      const active = session;
      if (!active) return Promise.resolve(true);
      forceClose = force;
      if (force) active.workspace.root.hidden = true;
      closing = (async () => {
        const saved = await active.workspace.flush();
        if (!saved && !forceClose) return false;
        if (!saved) { const draft = active.workspace.draft(); if (draft) recovery = { account: active.account, note: draft }; report(new Error("Could not save the note. Your draft is kept in memory; reopen Notes and export it.")); }
        else if (recovery?.account === active.account) recovery = undefined;
        active.workspace.destroy(); active.detach(); await active.store.close();
        if (session === active) session = undefined;
        nav.selected(false); return true;
      })().finally(() => { closing = undefined; });
      return closing;
    };
    const open = async (friends: HTMLAnchorElement): Promise<void> => {
      if (stopped || opening) return;
      if (closing && !await closing) return;
      if (session) return;
      opening = true; const token = ++epoch;
      try {
        const userStore = window.Syncord?.common?.stores.UserStore as { getCurrentUser?: () => { id?: string } | null } | undefined;
        const account = userStore?.getCurrentUser?.()?.id;
        if (!account) throw new Error("Your Discord account is not ready yet. Please try again in a few seconds.");
        const host = findChatHost(friends);
        if (!host) throw new Error("Could not find the Discord chat area. Reopen the DM page and try again.");
        const store = new NotesStore(account);
        const workspace = new NotesWorkspace(ctx, store, () => { void close(); });
        const detach = mountNotesSurface(host, workspace.root);
        session = { workspace, store, detach, account }; nav.selected(true);
        await workspace.initialize();
        if (token !== epoch || stopped) return;
        if (recovery?.account === account) workspace.recover(recovery.note);
      } catch (error) { report(error); await close(true); }
      finally { opening = false; }
    };
    const nav = installNotesNavigation(friends => { void open(friends); }, () => { void close(); });
    const observer = new MutationObserver(() => {
      if (!session || opening) return;
      const userStore = window.Syncord?.common?.stores.UserStore as { getCurrentUser?: () => { id?: string } | null } | undefined;
      if (userStore?.getCurrentUser?.()?.id !== session.account) {
        session.workspace.root.hidden = true; void close(true);
      } else if (!session.workspace.root.isConnected) void close(true);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    ctx.disposable(() => {
      stopped = true; observer.disconnect(); nav.dispose();
      finishStop = close(true).then(() => {});
    });
  },
  async stop() { await finishStop; finishStop = undefined; },
});
