import { getDirection, getLocale, localizeError, messageKeyForLabel, onLocaleChange, setLocalizedAttribute, setLocalizedText, t as i18nText } from "../../i18n";
import type { PluginContext } from "../../api/plugin";
import { createNote, LIMITS, NotesStore, summarize, validateNote, type Note, type NoteSummary } from "./store";
import { EditHistory, formatSelection, type Edit } from "./editor";
import { renderMarkdown } from "./markdown";
function noteTemplate(kind: string): string {
  if(kind==='meeting')return '# '+i18nText('notes.meeting_title')+'\n\n## '+i18nText('notes.agenda')+'\n- \n\n## '+i18nText('ui.notes')+'\n\n## '+i18nText('notes.decisions')+'\n\n## '+i18nText('notes.action_items')+'\n- [ ] \n';
  if(kind==='tasks')return '# '+i18nText('ui.to_do_list')+'\n\n## '+i18nText('notes.today')+'\n- [ ] \n\n## '+i18nText('ui.later')+'\n- [ ] \n\n## '+i18nText('ui.completed')+'\n- [x] \n';
  return '';
}
function welcomeNote(): string {
  return '# '+i18nText('notes.welcome_title')+'\n\n'+i18nText('notes.welcome_intro')+'\n\n## '+i18nText('ui.getting_started')+'\n'+['notes.welcome_create','notes.welcome_autosave','notes.welcome_views','notes.welcome_shortcuts'].map(key=>'- '+i18nText(key)).join('\n')+'\n\n## '+i18nText('ui.checklist')+'\n'+['notes.welcome_first_note','notes.welcome_export','notes.welcome_backup'].map(key=>'- [ ] '+i18nText(key)).join('\n')+'\n\n## '+i18nText('ui.table')+'\n| '+i18nText('notes.feature')+' | '+i18nText('ui.status')+' |\n| --- | --- |\n| '+i18nText('notes.local_storage')+' | '+i18nText('ui.ready')+' |\n| Markdown | '+i18nText('ui.ready')+' |\n\n> '+i18nText('notes.welcome_no_cloud')+'\n\n```js\nconst idea = \'Build something new\';\n```\n';
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); el.className = cls; el.textContent = text; return el;
}
function localizedElement<K extends keyof HTMLElementTagNameMap>(tag:K,cls:string,key:string):HTMLElementTagNameMap[K] {const el=element(tag,cls);setLocalizedText(el,key);return el;}
function button(label: string, action: () => void, cls = ""): HTMLButtonElement {
  const el = element("button", cls, label); const key = messageKeyForLabel(label); if(key) setLocalizedText(el,key); el.type = "button"; el.addEventListener("click", action); return el;
}
function select(values: [string, string][], label: string): HTMLSelectElement {
  const el = element("select"); el.setAttribute("aria-label", label); const labelKey=messageKeyForLabel(label); if(labelKey)setLocalizedAttribute(el,"aria-label",labelKey);
  values.forEach(([value, text]) => { const option = element("option", "", text); const key=messageKeyForLabel(text); if(key)setLocalizedText(option,key); option.value = value; el.appendChild(option); }); return el;
}
function errorMessage(error: unknown): string { return error instanceof Error ? localizeError(error) : i18nText("notes.save_failed"); }
export class NotesWorkspace {
  readonly root = element("section", "sn-workspace");
  private notes: NoteSummary[] = [];
  private current?: Note;
  private revision = 0;
  private savedRevision = 0;
  private saving?: Promise<boolean>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private previewTimer?: ReturnType<typeof setTimeout>;
  private searchTimer?: ReturnType<typeof setTimeout>;
  private countTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private selectedTab?: string;
  private readonly tabObserver: ResizeObserver;
  private busy = false;
  private history = new EditHistory();
  private readonly list = element("div", "sn-list");
  private readonly document = element("div", "sn-document");
  private readonly content = element("div", "sn-document-content");
  private readonly empty = localizedElement("div", "sn-empty", "ui.create_a_note_or_select_a_tab_above");
  private readonly source = element("textarea", "sn-source");
  private readonly preview = element("article", "sn-preview");
  private readonly title = element("input", "sn-title");
  private readonly status = localizedElement("span", "sn-save-status", "ui.saved_local");
  private readonly banner = element("p", "sn-banner");
  private readonly count = element("span");
  private readonly search = element("input", "sn-search");
  private readonly filter = select([["all", i18nText("ui.all_notes")], ["pinned", i18nText("ui.pinned")], ["trash", i18nText("ui.trash")]], i18nText("ui.filter_notes"));
  private readonly sort = select([["updated", i18nText("ui.last_updated")], ["title", i18nText("ui.title_a_z")]], i18nText("ui.sort_notes"));
  private readonly outline = select([["", i18nText("ui.jump_to_heading")]], i18nText("ui.document_headings"));
  private readonly pin: HTMLButtonElement;
  private readonly trash: HTMLButtonElement;
  private readonly restore: HTMLButtonElement;
  private readonly permanent: HTMLButtonElement;
  private readonly modes = new Map<string, HTMLButtonElement>();
  private dialogs = new Set<HTMLDialogElement>();
  private downloads = new Map<string, ReturnType<typeof setTimeout>>();
  private fileInput = element("input");
  private stopLocale: (()=>void) | undefined;
  private readonly beforeUnload = (): void => { void this.flush(); };
  constructor(private readonly ctx: PluginContext, private readonly store: NotesStore, private readonly onClose: () => void) {
    setLocalizedAttribute(this.root, "aria-label", "ui.local_markdown_notes");
    this.root.dataset.mode = "edit";
    const header = element("header", "sn-header");
    header.append(localizedElement("strong", "", "ui.notes"), localizedElement("small", "", "ui.markdown_stored_on_this_device"), button(i18nText("ui.close"), onClose, "sn-close"));
    const body = element("div", "sn-body");
    const tabs = element("div", "sn-tabs");
    this.list.setAttribute("role", "tablist"); setLocalizedAttribute(this.list, "aria-label", "ui.notes");
    this.content.id = "syncord-notes-document"; this.content.setAttribute("role", "tabpanel"); setLocalizedAttribute(this.content, "aria-label", "ui.note_editor");
    this.tabObserver = new ResizeObserver(() => this.revealSelectedTab()); this.tabObserver.observe(this.list);
    this.list.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const buttons = [...this.list.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
      const index = buttons.findIndex(tab => tab === event.target); if (index < 0) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus(); buttons[next]?.click();
    });
    this.list.addEventListener("wheel", event => {
      if (event.ctrlKey || event.shiftKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const before = this.list.scrollLeft; this.list.scrollLeft += event.deltaY;
      if (before !== this.list.scrollLeft) event.preventDefault();
    }, { passive: false });
    const newTab = button("+", () => { void this.run(() => this.add(createNote(i18nText("ui.new_note")))); }, "sn-new-tab");
    setLocalizedAttribute(newTab, "title", "ui.create_a_blank_note"); setLocalizedAttribute(newTab, "aria-label", "ui.create_a_note");
    tabs.append(this.list, newTab);
    this.search.type = "search"; setLocalizedAttribute(this.search, "placeholder", "ui.search_note_titles"); setLocalizedAttribute(this.search, "aria-label", "ui.search_notes");
    this.search.addEventListener("input", () => { clearTimeout(this.searchTimer); this.searchTimer = setTimeout(() => this.renderList(), 100); });
    const templates = select([["blank", i18nText("ui.blank_note")], ["meeting", i18nText("ui.meeting")], ["tasks", i18nText("ui.task_list")]], i18nText("ui.new_note_template"));
    const tools = element("div", "sn-create-tools"); tools.append(templates, button(i18nText("notes.new_action"), () => { void this.run(() => this.add(createNote(templates.value === "meeting" ? i18nText("ui.meeting") : templates.value === "tasks" ? i18nText("ui.to_do_list") : i18nText("ui.new_note"), noteTemplate(templates.value)))); }));
    const filters = element("div", "sn-filter-tools"); filters.append(this.filter, this.sort);
    this.filter.addEventListener("change", () => this.renderList()); this.sort.addEventListener("change", () => { ctx.settings.set("sort", this.sort.value); this.renderList(); });
    this.sort.value = ctx.settings.get<string>("sort", "updated") === "title" ? "title" : "updated";
    const foot = element("div", "sn-file-tools"); foot.append(button(i18nText("ui.import"), () => this.fileInput.click()), button(i18nText("ui.back_up"), () => { void this.run(() => this.backup()); }));
    this.fileInput.type = "file"; this.fileInput.accept = ".md,.markdown,.txt,.json"; this.fileInput.multiple = true; this.fileInput.hidden = true;
    this.fileInput.addEventListener("change", () => { const files = [...(this.fileInput.files ?? [])]; this.fileInput.value = ""; void this.run(() => this.importFiles(files)); });
    const manager = element("div", "sn-manager"); manager.setAttribute("role", "region"); setLocalizedAttribute(manager, "aria-label", "ui.manage_notes");
    const createRow = element("div", "sn-manager-row"); createRow.append(tools, this.search);
    const organizeRow = element("div", "sn-manager-row"); organizeRow.append(filters, foot);
    manager.append(createRow, organizeRow, this.fileInput);
    const head = element("div", "sn-document-head"); this.title.maxLength = 200; setLocalizedAttribute(this.title, "aria-label", "ui.note_title"); setLocalizedAttribute(this.title, "placeholder", "ui.untitled_note");
    this.title.addEventListener("input", () => { if (!this.current || this.busy) return; this.current.title = this.title.value; this.changed(false); this.updateTabTitle(); });
    const actions = element("div", "sn-document-actions");
    this.pin = button(i18nText("ui.pin"), () => { if (this.current && !this.busy) { this.current.pinned = !this.current.pinned; this.changed(false); this.updateActions(); } });
    this.trash = button(i18nText("ui.move_to_trash"), () => { void this.run(() => this.moveToTrash()); });
    this.restore = button(i18nText("ui.restore"), () => { void this.run(() => this.restoreNote()); });
    this.permanent = button(i18nText("ui.delete_permanently"), () => { void this.run(() => this.deletePermanently()); });
    actions.append(this.pin, button(i18nText("ui.duplicate"), () => { void this.run(async () => { if (!this.current || !await this.flush()) return; const note = createNote(i18nText("ui.value_copy", {v0: this.current.title.slice(0, 180)}), this.current.content); note.tags = [...this.current.tags]; await this.add(note); }); }), button(i18nText("notes.export_markdown"), () => { if (this.current) this.download(this.current.content, `${this.current.title || "note"}.md`, "text/markdown;charset=utf-8"); }), this.trash, this.restore, this.permanent);
    const titleField = element("label", "sn-title-field"); titleField.append(localizedElement("span", "", "ui.note_title"), this.title);
    head.append(actions, titleField);
    const toolbar = element("div", "sn-toolbar"); toolbar.setAttribute("role", "toolbar"); setLocalizedAttribute(toolbar, "aria-label", "ui.markdown_formatting");
    const formats: [string, string, string][] = [["B", "bold", i18nText("ui.bold_ctrl_cmd_b")], ["I", "italic", i18nText("ui.italic_ctrl_cmd_i")], ["S̶", "strike", i18nText("ui.strikethrough")], ["H₂", "heading", i18nText("ui.heading")], ["•", "bullet", i18nText("ui.bullet_list")], ["☑", "task", i18nText("ui.checklist")], ["❯", "quote", i18nText("ui.quote")], ["<>", "code", i18nText("ui.inline_code")], ["```", "fence", i18nText("ui.code_block")], ["↗", "link", i18nText("ui.link_ctrl_cmd_k")], ["▦", "table", i18nText("ui.table")], ["—", "rule", i18nText("ui.divider")], [i18nText("ui.date"), "date", i18nText("ui.today_s_date")]];
    for (const [label, action, tooltip] of formats) {
      const control = button(label, () => this.apply(action)); control.title = tooltip; control.setAttribute("aria-label", tooltip); const key=messageKeyForLabel(tooltip);if(key){setLocalizedAttribute(control,"title",key);setLocalizedAttribute(control,"aria-label",key);}
      control.addEventListener("mousedown", e => e.preventDefault()); toolbar.appendChild(control);
    }
    const undo = button("↶", () => this.undo(-1)); setLocalizedAttribute(undo,"title","ui.undo_ctrl_cmd_z");setLocalizedAttribute(undo,"aria-label","ui.undo");
    const redo = button("↷", () => this.undo(1)); setLocalizedAttribute(redo,"title","ui.redo_ctrl_cmd_shift_z");setLocalizedAttribute(redo,"aria-label","ui.redo");
    toolbar.append(undo, redo);
    const modeBar = element("div", "sn-modes");
    for (const [mode, label] of [["edit", i18nText("ui.edit")], ["split", i18nText("ui.split")], ["preview", i18nText("ui.preview")]]) {
      const control = button(label, () => this.setMode(mode)); this.modes.set(mode, control); modeBar.appendChild(control);
    }
    toolbar.appendChild(modeBar);
    setLocalizedAttribute(this.source, "aria-label", "ui.markdown_editor"); this.source.spellcheck = false; this.source.maxLength = LIMITS.documentBytes;
    setLocalizedAttribute(this.preview, "aria-label", "ui.markdown_preview"); this.preview.tabIndex = 0;
    this.source.addEventListener("input", () => { if (!this.current || this.busy) return; this.current.content = this.source.value; this.history.record(this.snapshot(), true); this.changed(); });
    this.source.addEventListener("keydown", e => this.keydown(e));
    this.source.addEventListener("click", () => this.updateCount()); this.source.addEventListener("keyup", () => this.updateCount());
    const area = element("div", "sn-editor-area"); area.append(this.source, this.preview);
    const footer = element("footer", "sn-status"); this.status.setAttribute("role", "status"); this.status.setAttribute("aria-live", "polite");
    this.outline.className = "sn-outline"; this.outline.addEventListener("change", () => {
      if (this.root.dataset.mode === "edit") this.setMode("preview");
      this.preview.querySelector(`#${this.outline.value}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    footer.append(this.count, this.outline, this.status, button(i18nText("ui.save"), () => { void this.flush(); }));
    this.content.append(head, toolbar, area, footer); this.document.append(tabs, header, manager, this.content, this.empty); body.append(this.document); this.banner.hidden = true; this.banner.setAttribute("role", "alert"); this.root.append(this.banner, body);
    this.root.addEventListener("keydown", e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void this.flush(); }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") { e.preventDefault(); this.search.focus(); }
      if (e.key === "Escape" && !e.isComposing) { e.stopPropagation(); onClose(); }
    });
    const mode = ctx.settings.get("mode", "edit"); this.setMode(typeof mode === "string" ? mode : "edit");
    this.content.hidden = true;
    window.addEventListener("beforeunload", this.beforeUnload);
    const relocalize = ():void => { this.root.dir=getDirection();this.root.lang=getLocale();this.updateCount();this.renderList();this.updateTabTitle(); };
    this.stopLocale=onLocaleChange(relocalize);relocalize();
  }
  draft(): Note | undefined { return this.current ? { ...this.current, tags: [...this.current.tags] } : undefined; }
  recover(note: Note): void {
    if (this.disposed) return;
    this.current = { ...note, tags: [...note.tags] };
    if (!this.notes.some(n => n.id === note.id)) this.notes.push(summarize(note));
    this.source.value = note.content; this.title.value = note.title;
    this.revision = 1; this.savedRevision = 0; this.history.reset({ text: note.content, start: 0, end: 0 });
    this.content.hidden = false; this.empty.hidden = true; this.updateActions(); this.renderList(); this.renderPreview(); this.updateCount();
    setLocalizedText(this.status, "ui.unsaved_draft_recovered_save_it_or_export_it_as_md"); this.status.dataset.error = "true";
  }
  async initialize(): Promise<void> {
    this.notes = await this.store.list();
    if (this.disposed) return;
    if (!this.notes.length) { const welcome = createNote(i18nText("ui.getting_started"), welcomeNote()); await this.store.save(welcome); this.notes = [summarize(welcome)]; }
    if (this.disposed) return;
    const saved = this.ctx.settings.get<string>("selectedId");
    const note = this.notes.find(n => n.id === saved && !n.deletedAt) ?? this.notes.find(n => !n.deletedAt);
    if (note) await this.choose(note.id);
    else this.showEmpty();
    this.renderList();
  }
  private async run(action: () => Promise<void>): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true; this.source.disabled = true; this.title.disabled = true;
    try { await action(); } catch (error) { this.fail(error); }
    finally { this.busy = false; this.updateActions(); }
  }
  private fail(error: unknown): void { this.status.textContent = errorMessage(error); this.status.dataset.error = "true"; this.banner.textContent = errorMessage(error); this.banner.hidden = false; this.ctx.log.warn("notes:", error); }
  private async add(note: Note): Promise<void> {
    if (!await this.flush()) return;
    await this.store.save(note); this.notes.push(summarize(note)); this.filter.value = "all"; this.search.value = ""; await this.choose(note.id);
  }
  private async choose(id: string): Promise<void> {
    if (!await this.flush() || this.disposed) return;
    const note = await this.store.get(id);
    if (!note || this.disposed) return;
    this.current = note; this.revision = this.savedRevision = 0;
    this.source.value = note.content; this.title.value = note.title;
    this.history.reset({ text: note.content, start: 0, end: 0 });
    this.ctx.settings.set("selectedId", id); this.content.hidden = false; this.empty.hidden = true;
    setLocalizedText(this.status,"ui.saved_local"); this.status.dataset.error = "false"; this.banner.hidden = true;
    this.updateActions(); this.renderList(); this.updateCount(); this.renderPreview();
  }
  private showEmpty(): void { this.current = undefined; this.content.hidden = true; this.empty.hidden = false; this.renderList(); }
  private updateActions(): void {
    const deleted = !!this.current?.deletedAt;
    setLocalizedText(this.pin,this.current?.pinned?"ui.pinned":"ui.pin"); this.pin.setAttribute("aria-pressed", String(!!this.current?.pinned));
    this.trash.hidden = deleted; this.restore.hidden = this.permanent.hidden = !deleted;
    this.source.disabled = this.title.disabled = deleted || this.busy;
  }
  private changed(bodyChanged = true): void {
    if (!this.current) return;
    this.current.updatedAt = Date.now(); this.revision++;
    setLocalizedText(this.status, "ui.unsaved_changes"); this.status.dataset.error = "false";
    clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => { void this.flush(); }, 600);
    clearTimeout(this.previewTimer);
    if (bodyChanged && this.root.dataset.mode !== "edit") this.previewTimer = setTimeout(() => this.renderPreview(), 200);
    clearTimeout(this.countTimer); this.countTimer = setTimeout(() => this.updateCount(), 150);
  }
  async flush(): Promise<boolean> {
    clearTimeout(this.saveTimer);
    if (this.saving) { if (!await this.saving) return false; return this.flush(); }
    if (!this.current || this.savedRevision === this.revision) return true;
    const id = this.current.id; const revision = this.revision;
    setLocalizedText(this.status, "ui.saving");
    let snapshot: Note;
    try { snapshot = validateNote(this.current); } catch (error) { this.fail(error); return false; }
    this.saving = this.store.save(snapshot).then(() => {
      const index = this.notes.findIndex(n => n.id === id); if (index >= 0) this.notes[index] = summarize(snapshot);
      if (this.current?.id === id) {
        this.savedRevision = revision;
        setLocalizedText(this.status,this.revision===revision?"ui.saved_local":"ui.unsaved_changes");
        this.status.dataset.error = "false"; this.banner.hidden = true;
      }
      if (!this.disposed) this.renderList(); return true;
    }).catch(error => { this.fail(error); return false; });
    const result = await this.saving; this.saving = undefined;
    if (result && this.revision !== this.savedRevision) return this.flush();
    return result;
  }
  private renderList(): void {
    const query = this.search.value.trim().toLocaleLowerCase("en-US");
    const all = this.notes.map(n => this.current?.id === n.id ? { ...n, title: this.current.title, pinned: this.current.pinned, updatedAt: this.current.updatedAt, deletedAt: this.current.deletedAt } : n);
    const notes = all.filter(n => (this.filter.value === "trash" ? !!n.deletedAt : !n.deletedAt)
      && (this.filter.value !== "pinned" || n.pinned) && (!query || n.title.toLocaleLowerCase("en-US").includes(query)))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (this.sort.value === "title" ? a.title.localeCompare(b.title, "en-US") : b.updatedAt - a.updatedAt));
    const fragment = document.createDocumentFragment();
    const focused = document.activeElement instanceof HTMLElement && this.list.contains(document.activeElement) ? document.activeElement.dataset.noteId : undefined;
    const scroll = this.list.scrollLeft;
    const selected = notes.some(note => note.id === this.current?.id) ? this.current?.id : notes[0]?.id;
    for (const note of notes) {
      const row = button("", () => { void this.run(() => this.choose(note.id)); }, "sn-note-row"); row.setAttribute("aria-current", String(note.id === this.current?.id));
      row.setAttribute("role", "tab"); row.setAttribute("aria-selected", String(note.id === this.current?.id));
      row.setAttribute("aria-controls", this.content.id); row.id = `sn-note-${note.id}`; row.dataset.noteId = note.id;
      row.tabIndex = note.id === selected ? 0 : -1;
      row.title = [note.title || i18nText("ui.untitled_note"), new Date(note.updatedAt).toLocaleDateString(getLocale())].filter(Boolean).join(" · ");
      row.append(element("strong", "", `${note.pinned ? "📌 " : ""}${note.title || i18nText("ui.untitled_note")}`));
      fragment.appendChild(row);
    }
    if (!notes.length) fragment.appendChild(element("p", "sn-list-empty", this.filter.value === "trash" ? i18nText("ui.trash_is_empty") : i18nText("ui.no_notes_found")));
    this.list.replaceChildren(fragment); this.list.scrollLeft = scroll;
    const tabs = [...this.list.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    tabs.find(tab => tab.dataset.noteId === focused)?.focus({ preventScroll: true });
    const current = tabs.find(tab => tab.dataset.noteId === this.current?.id);
    if (current) this.content.setAttribute("aria-labelledby", current.id);
    else this.content.removeAttribute("aria-labelledby");
    if (current && this.selectedTab !== this.current?.id) this.revealSelectedTab();
    this.selectedTab = this.current?.id;
  }
  private updateTabTitle(): void {
    if (!this.current) return;
    const tab = this.list.querySelector<HTMLElement>('[aria-selected="true"]');
    const label = tab?.querySelector("strong");
    if (label) label.textContent = `${this.current.pinned ? "📌 " : ""}${this.current.title || i18nText("ui.untitled_note")}`;
    if (tab) tab.title = `${this.current.title || i18nText("ui.untitled_note")} · ${new Date(this.current.updatedAt).toLocaleDateString(getLocale())}`;
  }
  private revealSelectedTab(): void {
    const current = this.list.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!current || !this.list.clientWidth) return;
    const tab = current.getBoundingClientRect(), strip = this.list.getBoundingClientRect();
    if (tab.left < strip.left) this.list.scrollLeft += tab.left - strip.left;
    else if (tab.right > strip.right) this.list.scrollLeft += tab.right - strip.right;
  }
  private setMode(mode: string): void {
    if (!["edit", "split", "preview"].includes(mode)) mode = "edit";
    this.root.dataset.mode = mode; this.ctx.settings.set("mode", mode);
    this.modes.forEach((button, value) => button.setAttribute("aria-pressed", String(value === mode)));
    if (mode !== "edit") this.renderPreview();
    else this.outline.hidden = true;
  }
  private renderPreview(): void {
    if (!this.current || this.root.dataset.mode === "edit" || this.disposed) return;
    const headings = renderMarkdown(this.current.content, this.preview);
    const choice = localizedElement("option", "", "ui.jump_to_heading"); choice.value = ""; this.outline.replaceChildren(choice);
    headings.slice(0, 200).forEach(h => { const option = element("option", "", "· ".repeat(h.depth - 1) + h.title); option.value = h.id; this.outline.appendChild(option); });
    this.outline.hidden = headings.length === 0;
  }
  private updateCount(): void {
    if (!this.current) return;
    const text = this.source.value; const before = text.slice(0, this.source.selectionStart);
    const lines = before.split("\n");
    const words = text.trim() ? text.trim().split(/\s+/u).length : 0;
    this.count.textContent = i18nText('count.words',{count:words})+' · '+i18nText('count.characters',{count:text.length})+' · '+i18nText('notes.cursor',{line:lines.length,column:lines.at(-1)!.length+1});
  }
  private snapshot(): Edit { return { text: this.source.value, start: this.source.selectionStart, end: this.source.selectionEnd }; }
  private apply(action: string): void {
    if (!this.current || this.current.deletedAt || this.busy) return;
    this.setMode(this.root.dataset.mode === "preview" ? "edit" : this.root.dataset.mode!);
    const edit = formatSelection(this.source.value, this.source.selectionStart, this.source.selectionEnd, action);
    this.history.record(edit); this.applyEdit(edit);
  }
  private applyEdit(edit: Edit): void {
    if (!this.current) return;
    this.source.value = this.current.content = edit.text; this.source.focus(); this.source.setSelectionRange(edit.start, edit.end); this.changed();
  }
  private undo(delta: -1 | 1): void { if (!this.current || this.current.deletedAt || this.busy) return; const edit = this.history.move(delta); if (edit) this.applyEdit(edit); }
  private keydown(event: KeyboardEvent): void {
    if (event.isComposing || !this.current || this.current.deletedAt) return;
    const command = event.ctrlKey || event.metaKey;
    if (command && ["b", "i", "k"].includes(event.key.toLowerCase())) { event.preventDefault(); this.apply(({ b: "bold", i: "italic", k: "link" } as Record<string, string>)[event.key.toLowerCase()]); }
    else if (command && event.key.toLowerCase() === "z") { event.preventDefault(); this.undo(event.shiftKey ? 1 : -1); }
    else if (command && event.key.toLowerCase() === "y") { event.preventDefault(); this.undo(1); }
    else if (event.key === "Tab") { event.preventDefault(); this.apply(event.shiftKey ? "outdent" : "indent"); }
  }
  private async moveToTrash(): Promise<void> {
    if (!this.current || !await this.flush()) return;
    this.current.deletedAt = Date.now(); this.changed(false); if (!await this.flush()) return;
    const next = this.notes.find(n => !n.deletedAt && n.id !== this.current?.id);
    if (next) await this.choose(next.id); else this.showEmpty();
  }
  private async restoreNote(): Promise<void> { if (!this.current) return; this.current.deletedAt = null; this.changed(false); if (await this.flush()) { this.filter.value = "all"; this.updateActions(); this.renderList(); } }
  private confirm(message: string): Promise<boolean> {
    return new Promise(resolve => {
      const dialog = element("dialog", "sn-confirm"); this.dialogs.add(dialog); dialog.appendChild(element("p", "", message));
      const actions = element("div", "sn-confirm-actions");
      const close = (answer: boolean): void => { dialog.close(); dialog.remove(); this.dialogs.delete(dialog); resolve(answer); };
      actions.append(button(i18nText("ui.cancel"), () => close(false)), button(i18nText("ui.delete_permanently"), () => close(true))); dialog.appendChild(actions);
      dialog.addEventListener("cancel", e => { e.preventDefault(); close(false); });
      dialog.addEventListener("close", () => { dialog.remove(); this.dialogs.delete(dialog); resolve(false); }, { once: true });
      document.body.appendChild(dialog); dialog.showModal();
    });
  }
  private async deletePermanently(): Promise<void> {
    if (!this.current?.deletedAt || !await this.confirm(i18nText("ui.this_note_will_be_permanently_deleted_this_cannot_be_undone_continue")) || this.disposed) return;
    const id = this.current.id; await this.store.remove(id); this.notes = this.notes.filter(n => n.id !== id); this.showEmpty();
  }
  private download(text: string, name: string, type: string): void {
    const url = URL.createObjectURL(new Blob([text], { type })); const link = element("a");
    link.href = url; link.download = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 210); link.hidden = true;
    this.root.appendChild(link); link.click(); link.remove();
    const timer = setTimeout(() => { URL.revokeObjectURL(url); this.downloads.delete(url); }, 3000); this.downloads.set(url, timer);
  }
  private async backup(): Promise<void> {
    if (!await this.flush()) return;
    const documents: Note[] = [];
    for (const note of this.notes) { const document = await this.store.get(note.id); if (document) documents.push(document); }
    this.download(JSON.stringify({ format: "syncord-notes", version: 1, documents }, null, 2), `Syncord-notes-${new Date().toISOString().slice(0, 10)}.json`, "application/json");
  }
  private async importFiles(files: File[]): Promise<void> {
    if (!files.length || !await this.flush()) return;
    if (files.reduce((bytes, file) => bytes + file.size, 0) > LIMITS.totalBytes + 1024 * 1024) throw new Error("You can import up to 21 MB at a time.");
    if (files.length > 20) throw new Error("Select up to 20 files at a time.");
    const imported: Note[] = [];
    for (const file of files) {
      const backup = file.name.toLowerCase().endsWith(".json");
      if (file.size > (backup ? LIMITS.totalBytes + 1024 * 1024 : LIMITS.documentBytes)) throw new Error(`${file.name}: file is too large.`);
      const text = await file.text();
      if (backup) {
        const data = JSON.parse(text);
        if (data?.format !== "syncord-notes" || data?.version !== 1 || !Array.isArray(data.documents) || data.documents.length > LIMITS.documents) throw new Error("This file is not a Syncord notes backup.");
        for (const value of data.documents) { const note = validateNote(value); note.id = crypto.randomUUID(); imported.push(note); }
      } else {
        if (!/\.(md|markdown|txt)$/i.test(file.name)) throw new Error("Select .md, .markdown, .txt files or a Syncord .json backup.");
        imported.push(validateNote(createNote(file.name.replace(/\.[^.]+$/, "").slice(0, 200), text)));
      }
    }
    await this.store.importNotes(imported);
    this.notes = await this.store.list(); this.filter.value = "all"; this.search.value = "";
    const first = imported.find(n => !n.deletedAt); if (first) await this.choose(first.id); else this.renderList();
  }
  /** Used only when Discord removes the entire host or the plugin is stopped. */
  destroy(): void {
    this.disposed = true; this.stopLocale?.(); this.stopLocale=undefined; clearTimeout(this.saveTimer); clearTimeout(this.searchTimer); clearTimeout(this.previewTimer); clearTimeout(this.countTimer);
    this.tabObserver.disconnect(); window.removeEventListener("beforeunload", this.beforeUnload);
    for (const dialog of this.dialogs) { dialog.close(); dialog.remove(); } this.dialogs.clear();
    for (const [url, timer] of this.downloads) { clearTimeout(timer); URL.revokeObjectURL(url); } this.downloads.clear();
    this.root.remove();
  }
}
