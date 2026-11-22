import { clearStoredFiles, deleteStoredKeys, hasStoredFile, readStoredFile, writeStoredFile, type StoredFile } from "./db";

const MAX_FILES = 8;
const MAX_BYTES = 8 * 1024 * 1024;

export type FileSource = {
  id?: string;
  attachments?: { filename?: string; url?: string }[];
};

const jobs: Array<() => Promise<void>> = [];
let pumping = false;
// Only pending work is retained. Completed IDs must not accumulate all session.
const tried = new Map<string,number>();
const dropped = new Map<string,number>();
let dropRevision=0;
let activeDownload:AbortController|undefined;
let epoch = 0;
const pendingDeletes: string[] = [];
let deleteQueued = false;

export function invalidateDownloads(): void {
  epoch++;
  activeDownload?.abort();
  tried.clear();
  dropped.clear();
}

export function queueMessageFiles(message: FileSource): void {
  const id = message.id;
  if (!id || !Array.isArray(message.attachments)) return;
  dropped.delete(id);
  const stamp = epoch;
  let index = 0;
  for (const file of message.attachments) {
    if (index >= MAX_FILES) break;
    const url = file?.url;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) continue;
    const key = `${id}:${index}`;
    const name = file.filename || "file";
    index++;
    if (tried.has(key)) continue;
    tried.set(key,stamp);
    jobs.push(async()=>{
      try{await storeOne(stamp,id,key,name,url);}
      finally{if(tried.get(key)===stamp)tried.delete(key);}
    });
  }
  void pump();
}

export function forgetMessageFiles(messageId: string): void {
  if (!messageId) return;
  dropped.set(messageId,++dropRevision);
  for (let index = 0; index < MAX_FILES; index++) pendingDeletes.push(`${messageId}:${index}`);
  if (deleteQueued) return;
  deleteQueued = true;
  jobs.push(async () => {
    deleteQueued = false;
    const keys = pendingDeletes.splice(0, pendingDeletes.length);
    if (!keys.length) return;
    const retired=new Map<string,number>();
    for(const key of keys){const id=key.slice(0,key.lastIndexOf(':')),revision=dropped.get(id);if(revision!==undefined)retired.set(id,revision);}
    try{await deleteStoredKeys(keys);}
    catch(error){invalidateDownloads();throw error;}
    finally{for(const [id,revision] of retired)if(dropped.get(id)===revision)dropped.delete(id);}
  });
  void pump();
}

export function wipeSavedFiles(): Promise<void> {
  invalidateDownloads();
  pendingDeletes.length = 0;
  return runJob(() => clearStoredFiles());
}

export async function readSavedFile(messageId: string, index: number): Promise<StoredFile | undefined> {
  return readStoredFile(`${messageId}:${index}`);
}

async function storeOne(stamp: number, messageId: string, key: string, name: string, url: string): Promise<void> {
  if (stamp !== epoch || dropped.has(messageId)) return;
  try {
    const existing = await hasStoredFile(key);
    if (stamp !== epoch || dropped.has(messageId) || existing) return;
    const controller=new AbortController();activeDownload=controller;
    let blob:Blob;
    try{blob=await readBoundedAttachment(url,controller.signal,MAX_BYTES);}
    finally{if(activeDownload===controller)activeDownload=undefined;}
    if (stamp !== epoch || dropped.has(messageId)) return;
    await writeStoredFile(key, {
      name,
      type: blob.type || "application/octet-stream",
      blob,
    });
  } catch {
    /* url on the log entry still opens */
  }
}

function runJob(job: () => Promise<void>): Promise<void> {
  const task = new Promise<void>((resolve, reject) => {
    jobs.push(async () => {
      try {
        await job();
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
  void pump();
  return task;
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (jobs.length) {
      const job = jobs.shift();
      if (!job) break;
      try {
        await job();
      } catch {
        /* one file must not stop the queue */
      }
    }
  } finally {
    pumping = false;
    if (jobs.length) void pump();
  }
}

/** Logged attachment links are data, never executable or arbitrary navigation URLs. */
export function attachmentUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return;
    if (!["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)) return;
    return url.href;
  } catch { return; }
}

/** User-initiated download only; keep the response bounded even without Content-Length. */
export function readAttachmentBlob(value:string,signal:AbortSignal):Promise<Blob>{
  return readBoundedAttachment(value,signal,32*1024*1024);
}
async function readBoundedAttachment(value: string, signal: AbortSignal, cap:number): Promise<Blob> {
  const url = attachmentUrl(value);
  if (!url) throw new Error("Invalid Discord attachment link");
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(abort, 20_000);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" });
    if (!response.ok || !response.body) throw new Error("Attachment unavailable");
    if (Number(response.headers.get("content-length")) > cap) throw new Error("Attachment too large");
    const reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    try {
      while (true) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        size += chunk.byteLength;
        if (size > cap) throw new Error("Attachment too large");
        // Own the stream chunk without making a second byte-for-byte copy.
        chunks.push(chunk.buffer instanceof ArrayBuffer && chunk.byteOffset===0 && chunk.byteLength===chunk.buffer.byteLength
          ? chunk as Uint8Array<ArrayBuffer> : new Uint8Array(chunk));
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    return new Blob(chunks, { type: response.headers.get("content-type") || "application/octet-stream" });
  } finally {
    controller.abort();
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}


/** Numeric diagnostics only; no file paths, links, IDs or content. */
export function attachmentMemoryStats():{pending:number;downloads:number;tombstones:number;pendingDeletes:number}{
 return {pending:jobs.length,downloads:tried.size,tombstones:dropped.size,pendingDeletes:pendingDeletes.length};
}
