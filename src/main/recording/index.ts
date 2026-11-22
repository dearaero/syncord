import {isSupportedLocale} from "../../shared/i18nLocale";
import {nativeMessage} from "../../shared/nativeI18n";
import type {RecordingLocale} from "../../shared/recording";
/** Isolated capture session: never replaces Discord's screen-share/permission handlers. */
import { app, BrowserWindow, desktopCapturer, session, type IpcMainInvokeEvent, type WebContents } from "electron";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { isSafeMode, isLockdown } from "../security/modes";
import { readSettings } from "../security/settings";
import { RECORDING_ARGUMENT, RECORDING_IPC, RECORDING_ORIGIN, parseRecordingOptions, recordingId,
  type RecordingDevice, type RecordingOptions, type RecordingStatus, type RecordingItem, type RecordingWorkerInit } from "../../shared/recording";
import { openRecordingPlayback, closeRecordingPlayback } from "./playback";
import { prepareWebmHeader } from "./webm";
import { getRecording, listRecordings, newRecordingId, openRecording, recordingDirectory, revealRecording, saveRecording } from "./store";

// Retain the original constructor before Discord's global BrowserWindow patch.
const RecorderWindow = BrowserWindow;
const MAX_CHUNK = 8 * 1024 * 1024;
const MAX_RECORDING = 32 * 1024 * 1024 * 1024;
type Active = { window: Electron.BrowserWindow; owner: WebContents; options: RecordingOptions;
  sources: Electron.DesktopCapturerSource[]; selected?: Electron.DesktopCapturerSource;
  file?: FileHandle; id: string | null; bytes: number; startedAt: number | null;
  detail: string; phase: RecordingStatus["phase"]; width: number; height: number; fps: number;
  finishing?: Promise<void>; writeBusy: boolean; sequence: number; completedAt?: number; duration?: {offset:number;length:4|8;scale:number}; timer?: ReturnType<typeof setTimeout>; closing: boolean };
const sessionOwners = new Map<Electron.Session, Electron.BrowserWindow>();
let active: Active | undefined;
let audioDevices: { window: Electron.BrowserWindow; owner: WebContents; resolve: (devices: RecordingDevice[]) => void } | undefined;
let lastDetail = "Ready to record.";
let lastError = false;
let lifecycleInstalled = false;
let quitAfterRecording = false;

const ownerLocales = new WeakMap<WebContents, RecordingLocale>();
function localeFor(owner: WebContents): RecordingLocale { return ownerLocales.get(owner) ?? {locale:'en-US',revision:0}; }
/** Trusted Discord main-frame callers can update only their own existing worker UI. */
export function setRecordingLocale(owner: WebContents, value: unknown): void {
  if (!isSupportedLocale(value)) throw new Error("Invalid recording locale.");
  const previous=localeFor(owner);if(previous.locale===value)return;
  const current={locale:value,revision:previous.revision+1};ownerLocales.set(owner,current);
  for(const worker of [active,audioDevices]) if(worker?.owner===owner && !worker.window.isDestroyed()) {
    worker.window.setTitle(nativeMessage(value,worker===audioDevices?'native.recorder_title_devices':'native.recorder_title_capture'));
    worker.window.webContents.send(RECORDING_IPC.LOCALE,current);
  }
}

function supportsNativeAudio(): boolean {
  if (process.platform === "win32") return true;
  const electronMajor = Number(process.versions.electron?.split(".")[0] ?? 0);
  if (electronMajor < 39) return false;
  // CoreAudio Tap requires macOS 14.2 (Darwin 23.2) or newer.
  if (process.platform === "darwin") {
    const [major, minor] = os.release().split(".").map(Number);
    return major > 23 || (major === 23 && minor >= 2);
  }
  return process.platform === "linux";
}
function permitted(): void {
  const data = readSettings();
  const enabled = data.ok ? (data.data.plugins as Record<string, {enabled?:unknown}> | undefined)?.["screen-recorder"]?.enabled : undefined;
  if (isSafeMode() || isLockdown() || enabled === false) throw new Error("Screen Recorder is disabled.");
}
export function recordingStatus(): RecordingStatus {
  return { phase: active?.phase ?? (lastError ? "error" : "idle"), startedAt: active?.startedAt ?? null,
    bytes: active?.bytes ?? 0, detail: active?.detail ?? lastDetail, id: active?.id ?? null,
    systemAudio: supportsNativeAudio(), directory: recordingDirectory() };
}
function ownWindow(owner: WebContents, role: "capture" | "devices"): Electron.BrowserWindow {
  const target = session.fromPartition(`syncord-recording-${role === "devices" ? "capture" : role}`);
  const win = new RecorderWindow({ width: 740, height: 570,
    minWidth: 400, minHeight: 340, title: nativeMessage(localeFor(owner).locale, role === "devices" ? "native.recorder_title_devices" : "native.recorder_title_capture"),
    parent: BrowserWindow.fromWebContents(owner) ?? undefined, show: false, backgroundColor: "#1e1f22", autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), session: target,
      contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
      additionalArguments: [RECORDING_ARGUMENT] } });
  // No remote page, script, image or socket can enter the capture/device realm.
  target.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(`${RECORDING_ORIGIN}/`) }));
  // A just-closed chooser may still be delivering its native closed event.
  // Replace only our own handler; stale cleanup must not tear down a new one.
  if(sessionOwners.has(target))target.protocol.unhandle("https");
  sessionOwners.set(target,win);
  target.protocol.handle("https", async request => {
    const url = new URL(request.url);
    if (url.origin !== RECORDING_ORIGIN) return new Response(null,{status:403});
    if (url.pathname !== `/${role}`) return new Response(null,{status:404});
    return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src 'self' blob:; connect-src 'none'; frame-src 'none'; script-src 'none'"></head><body><main id="recording-app"></main></body></html>`,{headers:{"Content-Type":"text/html"}});
  });
  const allowed = (wc: WebContents | null | undefined, permission: string): boolean =>
    !isLockdown() && !isSafeMode() && wc === win.webContents && (
      (role === "capture" && active?.window === win && active.selected !== undefined && ["media","audioCapture","display-capture"].includes(permission))
      || (role === "devices" && audioDevices?.window === win && ["media","audioCapture"].includes(permission)));
  target.setPermissionRequestHandler((wc,permission,callback,details) => callback(allowed(wc,permission) && details.isMainFrame !== false
    && (!("mediaTypes" in details) || !details.mediaTypes?.includes("video"))));
  target.setPermissionCheckHandler((wc,permission,origin) => allowed(wc,permission) && origin === RECORDING_ORIGIN);
  win.webContents.setWindowOpenHandler(() => ({action:"deny"}));
  win.webContents.on("will-navigate",event => event.preventDefault());
  target.setDisplayMediaRequestHandler((request,callback) => {
    const a = active;
    if (role !== "capture" || !a || a.window !== win || !a.selected || request.frame !== win.webContents.mainFrame || isSafeMode() || isLockdown()) { (callback as (streams: Electron.Streams | null) => void)(null); return; }
    callback({ video: a.selected, ...(a.options.output && !a.options.outputDevice ? { audio: "loopback" } : {}) });
  });
  win.once("ready-to-show",() => win.show());
  win.once("closed",() => { if(sessionOwners.get(target)!==win)return;sessionOwners.delete(target);target.setDisplayMediaRequestHandler(null); target.setPermissionRequestHandler(null); target.setPermissionCheckHandler(null);
    target.protocol.unhandle("https"); });
  return win;
}
export async function startRecording(owner: WebContents, raw: unknown): Promise<RecordingStatus> {
  permitted();
  if (audioDevices) throw new Error("Close the audio-device chooser before starting a recording.");
  if (active) { if (!active.window.isDestroyed() && active.phase === "choosing") active.window.focus(); return recordingStatus(); }
  const options = parseRecordingOptions(raw);
  if (options.output && !options.outputDevice && !supportsNativeAudio()) throw new Error("Native output audio capture needs a supported Discord/Electron and operating system version. Turn off Record output audio to record video and microphone.");
  if (options.microphone && options.output && options.outputDevice && options.outputDevice === options.microphoneDevice) throw new Error("Choose separate microphone and output audio inputs.");
  lastError = false;
  const win = ownWindow(owner,"capture");
  const a: Active = { window:win, owner, options, sources:[], id:null, bytes:0, startedAt:null, detail:"Choose a screen or window.", phase:"choosing", width:0,height:0,fps:0,writeBusy:false,sequence:0,closing:false };
  active = a;
  win.on("close",event => { if (a.closing || active !== a) return; event.preventDefault(); void stopRecording(owner); });
  const onDestroyed = (): void => { if (active === a) void finalize(a,true,"Discord closed; recording saved."); };
  owner.once("destroyed", onDestroyed);
  const onNavigation = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>, _url: string, isInPlace: boolean, isMainFrame: boolean): void => {
    // Discord routes chats via history without replacing the document. Only a
    // main-frame document replacement invalidates the recording owner. Older
    // Electron builds expose these flags through the positional arguments.
    const mainFrame = details.isMainFrame ?? isMainFrame;
    const sameDocument = details.isSameDocument ?? isInPlace;
    if (mainFrame && !sameDocument && active === a) void stopRecording(owner);
  };
  owner.on("did-start-navigation",onNavigation);
  win.once("closed",() => {owner.removeListener("did-start-navigation",onNavigation);owner.removeListener("destroyed",onDestroyed);});
  win.webContents.once("render-process-gone",() => { void finalize(a,true,"Capture stopped unexpectedly; available video saved."); });
  if (!lifecycleInstalled) { lifecycleInstalled=true;
    app.on("before-quit",event => { if (!active) return; event.preventDefault(); quitAfterRecording=true; void stopRecording(active.owner); });
  }
  try {
    a.sources = await desktopCapturer.getSources({ types:["screen","window"], thumbnailSize:{width:240,height:135}, fetchWindowIcons:false });
    a.sources = a.sources.slice(0,128);
    if (active !== a) return recordingStatus();
    if (!a.sources.length) throw new Error("No screen source is available. Check operating system screen-recording permissions.");
    await win.loadURL(`${RECORDING_ORIGIN}/capture`);
    return recordingStatus();
  } catch (error) { await finalize(a,true,error instanceof Error ? error.message : "Screen capture is unavailable."); throw error; }
}
export async function stopRecording(owner?: WebContents, release = false): Promise<RecordingStatus> {
  if (release) await closeRecordingPlayback(owner);
  if (audioDevices && (!owner || audioDevices.owner === owner)) audioDevices.window.close();
  const a = active; if (!a) return recordingStatus();
  if (owner && a.owner !== owner) throw new Error("This recording belongs to another Discord window.");
  if (a.phase === "choosing") { await finalize(a,false,"Recording cancelled."); return recordingStatus(); }
  if (a.phase !== "stopping") { a.phase="stopping";a.detail="Saving recording…";
    a.window.webContents.send(RECORDING_IPC.WORKER_STOP);
    clearTimeout(a.timer); a.timer=setTimeout(() => { void finalize(a,true,"Recording interrupted; available video saved."); },15_000);
  }
  // The worker continues writing its final chunk before FINISH acknowledges.
  return recordingStatus();
}
export async function cancelRecordingForSecurity(): Promise<void> { if (active) await stopRecording(active.owner); audioDevices?.window.close(); await closeRecordingPlayback(); }
function assertWorker(event: IpcMainInvokeEvent): Active | undefined {
  const a = active;
  const win = a?.window.webContents === event.sender ? a.window : (audioDevices?.window.webContents === event.sender ? audioDevices.window : undefined);
  if (!win || win.isDestroyed() || event.senderFrame !== event.sender.mainFrame
    || ![`${RECORDING_ORIGIN}/capture`,`${RECORDING_ORIGIN}/devices`].includes(event.senderFrame.url)) throw new Error("Untrusted recording worker.");
  return a?.window === win ? a : undefined;
}
export function assertRecordingWorker(event: IpcMainInvokeEvent): void { assertWorker(event); }
export async function recordingWorkerInit(event: IpcMainInvokeEvent): Promise<RecordingWorkerInit> {
  const a=assertWorker(event);
  if (audioDevices?.window.webContents === event.sender) return {role:"devices",...localeFor(audioDevices.owner)};
  if (a) return { role:"capture", ...localeFor(a.owner), options:a.options, systemAudio:supportsNativeAudio(), sources:a.sources.map(source=>({id:source.id,name:source.name,thumbnail:source.thumbnail.toDataURL()})) };
  throw new Error("Recording worker closed.");
}
export async function recordingSelect(event: IpcMainInvokeEvent, raw: unknown): Promise<void> {
  const a=assertWorker(event); permitted();
  if (!a || a.phase!=="choosing" || typeof raw!=="string") throw new Error("No source picker is active.");
  const selected=a.sources.find(source=>source.id===raw); if (!selected) throw new Error("Screen source no longer exists.");
  a.selected=selected; a.sources=[]; a.phase="starting";a.detail="Starting recording…";a.id=newRecordingId();
  const file = await openRecording(a.id);
  if (active !== a || a.finishing) { await file.close(); return; }
  a.file=file;
  a.timer=setTimeout(()=>{void finalize(a,true,"Capture did not start. Check screen and microphone permissions.");},90_000);
  // A fixed local button in our own window supplies getDisplayMedia's user gesture.
  setImmediate(()=>{ if (active===a && !a.window.isDestroyed()) void a.window.webContents.executeJavaScript("document.getElementById('recording-begin').click()",true).catch(()=>finalize(a,true,"Capture could not start.")); });
}
export function recordingReady(event: IpcMainInvokeEvent, raw: unknown): void {
  const a=assertWorker(event); if (!a || a.phase!=="starting" || !raw || typeof raw!=="object") throw new Error("Recording is not starting.");
  const v=raw as Record<string,unknown>;
  for (const key of ["width","height","fps"] as const) if (typeof v[key]!=="number" || !Number.isFinite(v[key]) || v[key]<0 || v[key]>8192) throw new Error("Invalid capture settings.");
  if (v.microphone!==a.options.microphone || v.output!==a.options.output) throw new Error("Requested audio tracks are unavailable.");
  a.width=v.width as number;a.height=v.height as number;a.fps=v.fps as number;
  clearTimeout(a.timer);a.timer=undefined;a.startedAt=Date.now();a.phase="recording";a.detail="Recording…";a.window.hide();
}
export async function recordingChunk(event: IpcMainInvokeEvent, sequence: unknown, raw: unknown): Promise<void> {
  const a=assertWorker(event);
  if (!a || !a.file || a.finishing || a.writeBusy || !["starting","recording","stopping"].includes(a.phase)
      || sequence!==a.sequence || !(raw instanceof Uint8Array) || !raw.byteLength || raw.byteLength>MAX_CHUNK) throw new Error("Invalid recording chunk.");
  const prepared = a.sequence === 0 ? prepareWebmHeader(raw) : { bytes: raw };
  const bytes = prepared.bytes;
  if (prepared.duration) a.duration = prepared.duration;
  if (a.bytes+bytes.byteLength>MAX_RECORDING) { await stopRecording(); throw new Error("Recording reached the 32 GB safety limit."); }
  a.writeBusy=true;
  try { let offset=0; while (offset<bytes.byteLength) { const written=await a.file.write(bytes,offset,bytes.byteLength-offset,null);
      if (!written.bytesWritten) throw new Error("Recording disk write failed."); offset+=written.bytesWritten; }
    a.bytes+=bytes.byteLength;a.sequence+=1;
  } finally { a.writeBusy=false; }
}
export async function recordingFinish(event: IpcMainInvokeEvent, failed: unknown, durationMs?: unknown, reason?: unknown): Promise<void> {
  const a=assertWorker(event); if (a) { if(a.startedAt && typeof durationMs==="number" && Number.isFinite(durationMs) && durationMs>=0 && durationMs<=Date.now()-a.startedAt+3000)a.completedAt=a.startedAt+durationMs;
    await finalize(a,failed===true,failed===true ? (typeof reason==="string"?reason.slice(0,220):"Capture failed; available video saved.") : "Recording saved."); }
}
export async function recordingFailure(event: IpcMainInvokeEvent, reason: unknown): Promise<void> {
  const a=assertWorker(event); if (a) await finalize(a,true,typeof reason==="string"?reason.slice(0,220):"Recording failed.");
}
async function finalize(a: Active, recovered: boolean, detail: string): Promise<void> {
  if (a.finishing) return a.finishing;
  a.finishing=(async()=>{
    clearTimeout(a.timer);
    // A crash/timeout can race a bounded write; finish it before closing the file.
    while (a.writeBusy) await new Promise(resolve=>setTimeout(resolve,10));
    try { if (a.file) {
      if(a.duration && a.startedAt){const value=Buffer.alloc(a.duration.length);const duration=((a.completedAt??Date.now())-a.startedAt)*1_000_000/a.duration.scale;
        if(a.duration.length===8)value.writeDoubleBE(duration);else value.writeFloatBE(duration);await a.file.write(value,0,value.length,a.duration.offset);}
      await a.file.sync();await a.file.close();a.file=undefined; }
      if (a.id) { const item: RecordingItem={id:a.id,name:"",createdAt:Number(a.id.slice(0,13)),durationMs:a.startedAt?(a.completedAt??Date.now())-a.startedAt:0,
        bytes:a.bytes,width:a.width,height:a.height,fps:a.fps,microphone:a.options.microphone,output:a.options.output,recovered}; await saveRecording(item); }
      lastDetail=detail;lastError=recovered;
    } catch { lastDetail="Recording could not be finalized. Check free disk space; the partial video remains in the recordings folder.";lastError=true; }
    finally { if(active===a)active=undefined;a.closing=true;if(!a.window.isDestroyed())a.window.destroy();if(quitAfterRecording){quitAfterRecording=false;app.quit();} }
  })();
  return a.finishing;
}
export async function playRecording(owner: WebContents, id: unknown): Promise<import("../../shared/recording").RecordingPlayback> {
  permitted();return openRecordingPlayback(owner,recordingId(id));
}
export {listRecordings,revealRecording};

export async function recordingDevices(owner: WebContents): Promise<RecordingDevice[]> {
  permitted();if(active)throw new Error("Stop recording before changing audio devices.");
  if(audioDevices){audioDevices.window.focus();throw new Error("An audio-device chooser is already open.");}
  const win=ownWindow(owner,"devices");
  const closeOnDestroy=():void=>{if(!win.isDestroyed())win.close();};
  owner.once("destroyed",closeOnDestroy);win.once("closed",()=>owner.removeListener("destroyed",closeOnDestroy));
  const promise=new Promise<RecordingDevice[]>(resolve=>{audioDevices={window:win,owner,resolve};});
  win.once("closed",()=>{if(audioDevices?.window===win){audioDevices.resolve([]);audioDevices=undefined;}});
  try{await win.loadURL(`${RECORDING_ORIGIN}/devices`);return await promise;}catch(error){win.destroy();throw error;}
}
export function recordingDevicesResult(event:IpcMainInvokeEvent,raw:unknown):void {
  assertWorker(event);const d=audioDevices;if(!d||d.window.webContents!==event.sender||!Array.isArray(raw)||raw.length>128)throw new Error("Invalid audio device list.");
  const devices:RecordingDevice[]=[];
  for(const item of raw){if(!item||typeof item!=="object"||typeof item.label!=="string"||!item.label||item.label.length>200)throw new Error("Invalid audio device.");
    // Device IDs are salted per origin and session. Persist a label, then resolve
    // the current capture-origin ID at startup, including after an app restart.
    devices.push({id:`label:${item.label}`,label:item.label});}
  d.resolve(devices);audioDevices=undefined;d.window.close();
}
