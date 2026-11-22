import { app, shell } from "electron";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { recordingId, type RecordingItem, type RecordingPage } from "../../shared/recording";

export function recordingDirectory(): string {
  return path.join(app.getPath("videos"), "Syncord Recordings");
}
async function root(): Promise<string> {
  const dir = recordingDirectory();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Recording folder must be a real directory.");
  return fs.realpath(dir);
}
export function newRecordingId(): string { return `${Date.now()}-${randomBytes(16).toString("hex")}`; }
async function safeFile(id: unknown, extension: string): Promise<string> {
  return path.join(await root(), `${recordingId(id)}${extension}`);
}
async function regular(file: string): Promise<void> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Recording is not a regular file.");
}
export async function openRecording(id: string): Promise<fs.FileHandle> {
  return fs.open(await safeFile(id, ".webm.part"), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
}
export async function saveRecording(item: RecordingItem): Promise<void> {
  const pending = await safeFile(item.id, ".webm.part");
  if (item.bytes > 0) { await regular(pending); await fs.rename(pending, await safeFile(item.id, ".webm")); }
  else { await fs.unlink(pending).catch(() => undefined); return; }
  const temp = await safeFile(item.id, ".json.part");
  await fs.writeFile(temp, JSON.stringify(item), { flag: "wx", mode: 0o600 });
  await fs.rename(temp, await safeFile(item.id, ".json"));
}
export async function getRecording(id: unknown): Promise<{ item: RecordingItem; file: string }> {
  const valid = recordingId(id);
  const file = await safeFile(valid, ".webm");
  await regular(file);
  const stat = await fs.stat(file);
  const item: RecordingItem = { id: valid, name: `Recording ${new Date(Number(valid.slice(0,13))).toLocaleString()}`,
    createdAt: Number(valid.slice(0,13)), durationMs: 0, bytes: stat.size, width: 0, height: 0, fps: 0,
    microphone: false, output: false, recovered: true };
  try {
    const meta = await safeFile(valid, ".json"); await regular(meta);
    if ((await fs.stat(meta)).size < 4096) {
      const v: unknown = JSON.parse(await fs.readFile(meta, "utf8"));
      if (v && typeof v === "object") {
        const data = v as Record<string, unknown>;
        for (const key of ["durationMs", "width", "height", "fps"] as const) {
          if (typeof data[key] === "number" && Number.isFinite(data[key]) && data[key] >= 0) item[key] = data[key];
        }
        item.microphone = data.microphone === true; item.output = data.output === true; item.recovered = data.recovered !== false;
      }
    }
  } catch { /* A crash can leave a playable video without metadata. */ }
  return { item, file };
}
export async function listRecordings(before?: unknown): Promise<RecordingPage> {
  const cursor = before === undefined || before === "" ? null : recordingId(before);
  const dir = await root();
  const newest: string[] = [];
  // Keep only one page of names, regardless of library size.
  for await (const entry of await fs.opendir(dir)) {
    if (!entry.isFile() || !/^\d{13}-[a-f0-9]{32}\.webm$/.test(entry.name)) continue;
    const id = entry.name.slice(0,-5); if (cursor && id >= cursor) continue;
    newest.push(id); newest.sort((a,b) => b.localeCompare(a)); if (newest.length > 31) newest.pop();
  }
  const items: RecordingItem[] = [];
  for (const id of newest.slice(0,30)) { try { items.push((await getRecording(id)).item); } catch { /* deleted externally */ } }
  return { items, next: newest.length > 30 ? newest[29] : null, directory: dir };
}
export async function revealRecording(id?: unknown): Promise<void> {
  if (id === undefined || id === "") { const error = await shell.openPath(await root()); if (error) throw new Error("Could not open the recordings folder."); }
  else shell.showItemInFolder((await getRecording(id)).file);
}
