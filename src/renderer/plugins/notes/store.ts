import { canonicalMessage as i18nText } from "../../i18n";
/** Local document bodies are too large for the bounded native settings file. */
export const LIMITS = { documents: 200, documentBytes: 512 * 1024, totalBytes: 20 * 1024 * 1024 };
export type Note = {
  id: string; title: string; content: string; tags: string[]; pinned: boolean;
  createdAt: number; updatedAt: number; deletedAt: number | null;
};
export type NoteSummary = Omit<Note, "content"> & { excerpt: string; bytes: number };
const encoder = new TextEncoder();
export function validateNote(value: unknown): Note {
  const n = value as Partial<Note> | null;
  if (Array.isArray(n?.tags) && (n.tags.length > 12 || n.tags.some(t => typeof t !== "string" || t.length > 40))) {
    throw new Error("A note can have up to 12 tags, each up to 40 characters.");
  }
  if (!n || typeof n !== "object" || typeof n.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(n.id)
    || typeof n.title !== "string" || n.title.length > 200 || typeof n.content !== "string"
    || encoder.encode(n.content).length > LIMITS.documentBytes || !Array.isArray(n.tags)
    || n.tags.length > 12 || n.tags.some(t => typeof t !== "string" || t.length > 40)
    || typeof n.pinned !== "boolean" || !Number.isFinite(n.createdAt) || !Number.isFinite(n.updatedAt)
    || !(n.deletedAt === null || typeof n.deletedAt === "number" && Number.isFinite(n.deletedAt))) {
    throw new Error("Invalid note or file too large (up to 512 KB per note).");
  }
  return { id: n.id, title: n.title, content: n.content, tags: [...new Set(n.tags)], pinned: n.pinned,
    createdAt: n.createdAt!, updatedAt: n.updatedAt!, deletedAt: n.deletedAt! };
}
export function summarize(note: Note): NoteSummary {
  const { content, ...rest } = note;
  return { ...rest, excerpt: content.slice(0, 180).replace(/\s+/g, " "), bytes: encoder.encode(content).length };
}
export function createNote(title = i18nText("ui.new_note"), content = ""): Note {
  const now = Date.now();
  return { id: crypto.randomUUID(), title, content, tags: [], pinned: false, createdAt: now, updatedAt: now, deletedAt: null };
}
function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}
function settled(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("Could not complete the local save."));
  });
}
export class NotesStore {
  private opening?: Promise<IDBDatabase>;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private readonly account: string) {
    if (!/^\d{1,30}$/.test(account)) throw new Error("Your Discord account is not ready for Notes.");
  }
  private db(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(new Error("The notes store is closed."));
    return this.opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(`Syncord.plugins.notes.${this.account}`, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("documents", { keyPath: "id" });
        req.result.createObjectStore("metadata", { keyPath: "id" });
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); this.opening = undefined; };
        resolve(db);
      };
      req.onerror = () => { this.opening = undefined; reject(req.error ?? new Error("Could not open the local notes store.")); };
      req.onblocked = () => { this.opening = undefined; reject(new Error("The notes store is in use in another window. Close that window and try again.")); };
    });
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation);
    this.tail = next.catch(() => {});
    return next;
  }
  async list(): Promise<NoteSummary[]> {
    await this.tail;
    const db = await this.db();
    return request(db.transaction("metadata").objectStore("metadata").getAll());
  }
  async get(id: string): Promise<Note | undefined> {
    await this.tail;
    const db = await this.db();
    const note = await request(db.transaction("documents").objectStore("documents").get(id));
    return note ? validateNote(note) : undefined;
  }
  save(value: Note): Promise<void> {
    const note = validateNote(value);
    return this.enqueue(async () => {
      const db = await this.db();
      const tx = db.transaction(["documents", "metadata"], "readwrite");
      const done = settled(tx);
      // Perform writes in the request callback: no asynchronous gap can expire this transaction.
      const req = tx.objectStore("metadata").getAll();
      let failure: Error | undefined;
      req.onsuccess = () => {
        const all = req.result as NoteSummary[];
        const previous = all.find(n => n.id === note.id);
        const summary = summarize(note);
        if (!previous && all.length >= LIMITS.documents || all.reduce((s, n) => s + n.bytes, 0) - (previous?.bytes ?? 0) + summary.bytes > LIMITS.totalBytes) {
          failure = new Error("The notes store is full (200 notes / 20 MB). Empty the trash or export your notes.");
          tx.abort(); return;
        }
        tx.objectStore("documents").put(note);
        tx.objectStore("metadata").put(summary);
      };
      try { await done; } catch (error) { throw failure ?? error; }
    });
  }
  /** Validate the entire import before a single atomic transaction writes anything. */
  importNotes(values: Note[]): Promise<void> {
    const notes = values.map(validateNote);
    return this.enqueue(async () => {
      const db = await this.db();
      const tx = db.transaction(["documents", "metadata"], "readwrite");
      const done = settled(tx);
      let failure: Error | undefined;
      const req = tx.objectStore("metadata").getAll();
      req.onsuccess = () => {
        const all = req.result as NoteSummary[];
        const summaries = notes.map(summarize);
        if (new Set(notes.map(n => n.id)).size !== notes.length || notes.some(n => all.some(a => a.id === n.id))) {
          failure = new Error("Duplicate note ID."); tx.abort(); return;
        }
        if (all.length + notes.length > LIMITS.documents || [...all, ...summaries].reduce((s, n) => s + n.bytes, 0) > LIMITS.totalBytes) {
          failure = new Error("This import exceeds the limit (200 notes / 20 MB). No files were imported."); tx.abort(); return;
        }
        for (const note of notes) tx.objectStore("documents").put(note);
        for (const summary of summaries) tx.objectStore("metadata").put(summary);
      };
      try { await done; } catch (error) { throw failure ?? error; }
    });
  }
  remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      const db = await this.db();
      const tx = db.transaction(["documents", "metadata"], "readwrite");
      const done = settled(tx);
      tx.objectStore("documents").delete(id); tx.objectStore("metadata").delete(id);
      await done;
    });
  }
  async close(): Promise<void> {
    await this.tail;
    if (this.opening) (await this.opening.catch(() => undefined))?.close();
    this.opening = undefined; this.closed = true;
  }
}
