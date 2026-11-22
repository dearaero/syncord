import { canonicalMessage as i18nText } from "../../i18n";
const DB_NAME = i18nText("ui.syncord");
const LOG_STORE = "message-logger";
const FILE_STORE = "message-logger-files";
const LOG_KEY = "entries";
const ROW_STORE = "message-logger-rows";

export type StoredFile = {
  name: string;
  type: string;
  blob: Blob;
};

let opening: Promise<IDBDatabase> | undefined;

function createStores(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(LOG_STORE)) db.createObjectStore(LOG_STORE);
  if (!db.objectStoreNames.contains(FILE_STORE)) db.createObjectStore(FILE_STORE);
  if (!db.objectStoreNames.contains(ROW_STORE)) db.createObjectStore(ROW_STORE);
}

function openDb(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onupgradeneeded = () => createStores(req.result);
    req.onsuccess = () => {
      const db = req.result;
      if (db.objectStoreNames.contains(LOG_STORE) && db.objectStoreNames.contains(FILE_STORE) && db.objectStoreNames.contains(ROW_STORE)) {
        db.onversionchange = () => { db.close(); opening = undefined; };
        resolve(db);
        return;
      }
      const next = db.version + 1;
      db.close();
      let abandoned=false;
      const again = indexedDB.open(DB_NAME, next);
      again.onupgradeneeded = () => createStores(again.result);
      again.onsuccess = () => { const db=again.result;if(abandoned){db.close();return;} db.onversionchange=()=>{db.close();opening=undefined;};resolve(db); };
      again.onblocked = () => {abandoned=true;reject(new Error("Close other Syncord windows to upgrade the local message log."));};
      again.onerror = () => reject(again.error ?? new Error("indexedDB"));
    };
    req.onerror = () => reject(req.error ?? new Error("indexedDB"));
  });
  opening = opening.catch((err) => {
    opening = undefined;
    throw err;
  });
  return opening;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB"));
  });
}

function settled(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("indexedDB"));
    tx.onabort = () => reject(tx.error ?? new Error("indexedDB"));
  });
}

/** Legacy migration is a separate atomic transaction. Its array is released
 * before streaming keyed rows; a failed put must leave the legacy array intact. */
async function migrateLogRows(db:IDBDatabase):Promise<void>{
  const tx=db.transaction([LOG_STORE,ROW_STORE],"readwrite"),done=settled(tx);
  const legacy=tx.objectStore(LOG_STORE).get(LOG_KEY);let failure:unknown;
  legacy.onsuccess=()=>{
    if(!Array.isArray(legacy.result))return;
    try{
      const rows=tx.objectStore(ROW_STORE);
      for(const value of legacy.result)if(value&&typeof value==='object'&&typeof value.id==='string')rows.put(value,value.id);
      tx.objectStore(LOG_STORE).delete(LOG_KEY);
    }catch(error){failure=error;tx.abort();}
  };
  try{await done;}catch(error){throw failure??error;}
}

/** Synchronous visitor, one stored record at a time. Return false to stop a
 * cancelled hydration; never retain a getAll array alongside the live index. */
export async function visitLogRows(visit:(value:unknown)=>boolean|void):Promise<void>{
  const db=await openDb();await migrateLogRows(db);
  const tx=db.transaction(ROW_STORE,"readonly"),done=settled(tx);let failure:unknown;
  const cursor=tx.objectStore(ROW_STORE).openCursor();
  cursor.onsuccess=()=>{
    const row=cursor.result;if(!row)return;
    try{if(visit(row.value)!==false)row.continue();}catch(error){failure=error;tx.abort();}
  };
  try{await done;}catch(error){throw failure??error;}
}

/** Explicit full-history reads for callers that actually need the complete list. */
export async function readLogRows():Promise<unknown>{
  const values:unknown[]=[];await visitLogRows(value=>{values.push(value);});return values;
}

/** Used only for one-time legacy localStorage import, not normal event writes. */
export async function writeLogRows(values: unknown[]): Promise<void> {
  const db=await openDb(),tx=db.transaction([LOG_STORE,ROW_STORE],"readwrite"),done=settled(tx);
  const rows=tx.objectStore(ROW_STORE);rows.clear();
  try{for(const value of values){if(value&&typeof value==='object'&&typeof (value as {id?:unknown}).id==='string')rows.put(value,(value as {id:string}).id);}
    tx.objectStore(LOG_STORE).delete(LOG_KEY);}
  catch(error){tx.abort();await done.catch(()=>{});throw error;}
  await done;
}

export async function writeLogChanges(values: ReadonlyArray<readonly [string,unknown|undefined]>): Promise<void> {
  if(!values.length)return;
  const db=await openDb(),tx=db.transaction(ROW_STORE,"readwrite"),done=settled(tx),rows=tx.objectStore(ROW_STORE);
  try{for(const [id,value] of values){if(value===undefined)rows.delete(id);else rows.put(value,id);}}
  catch(error){tx.abort();await done.catch(()=>{});throw error;}
  await done;
}

export async function clearLogRows(): Promise<void> {
  const db=await openDb(),tx=db.transaction([LOG_STORE,ROW_STORE],"readwrite"),done=settled(tx);
  tx.objectStore(ROW_STORE).clear();tx.objectStore(LOG_STORE).delete(LOG_KEY);await done;
}

/** A key-only lookup avoids materializing an already saved attachment Blob. */
export async function hasStoredFile(key:string):Promise<boolean>{
  const db=await openDb(),tx=db.transaction(FILE_STORE,"readonly"),done=settled(tx);
  const exists=await request(tx.objectStore(FILE_STORE).count(key));await done;return exists>0;
}

export async function readStoredFile(key: string): Promise<StoredFile | undefined> {
  const db = await openDb();
  const tx = db.transaction(FILE_STORE, "readonly");
  const done = settled(tx);
  const value = await request(tx.objectStore(FILE_STORE).get(key));
  await done;
  if (!value || typeof value !== "object") return undefined;
  const row = value as StoredFile;
  if (!(row.blob instanceof Blob)) return undefined;
  return {
    name: typeof row.name === "string" && row.name ? row.name : "file",
    type: typeof row.type === "string" ? row.type : row.blob.type,
    blob: row.blob,
  };
}

export async function writeStoredFile(key: string, file: StoredFile): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(FILE_STORE, "readwrite");
  const done = settled(tx);
  tx.objectStore(FILE_STORE).put(file, key);
  await done;
}

export async function deleteStoredKeys(keys: string[]): Promise<void> {
  if (!keys.length) return;
  const db = await openDb();
  const tx = db.transaction(FILE_STORE, "readwrite");
  const done = settled(tx);
  const store = tx.objectStore(FILE_STORE);
  for (const key of keys) store.delete(key);
  await done;
}

export async function clearStoredFiles(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(FILE_STORE, "readwrite");
  const done = settled(tx);
  tx.objectStore(FILE_STORE).clear();
  await done;
}
