import type {Locale} from "./i18nLocale";
/** Fixed capabilities: no caller-supplied file paths, URLs or IPC names. */
export const RECORDING_ORIGIN = "https://syncord-recorder.invalid";
export const RECORDING_ARGUMENT = "--syncord-recording-window";
export type RecordingOptions = {
  resolution: 720 | 1080 | 1440 | 2160;
  fps: 15 | 24 | 30;
  microphone: boolean;
  microphoneDevice: string;
  output: boolean;
  /** Empty means native system loopback. Legacy callers can still pass a virtual input; the settings UI never selects devices. */
  outputDevice: string;
};
export const DEFAULT_RECORDING_OPTIONS: RecordingOptions = {
  resolution: 1080, fps: 30, microphone: false, microphoneDevice: "", output: false, outputDevice: "",
};
export type RecordingPhase = "idle" | "choosing" | "starting" | "recording" | "stopping" | "error";
export type RecordingStatus = {
  phase: RecordingPhase; startedAt: number | null; bytes: number; detail: string;
  id: string | null; systemAudio: boolean; directory: string;
};
export type RecordingItem = {
  id: string; name: string; createdAt: number; durationMs: number; bytes: number;
  width: number; height: number; fps: number; microphone: boolean; output: boolean;
  recovered: boolean;
};
export type RecordingPage = { items: RecordingItem[]; next: string | null; directory: string };
export type RecordingPlayback = { token: string; size: number; mimeType: string; duration: number;
  header: ArrayBuffer; points: { offset: number; time: number }[] };
export type RecordingDevice = { id: string; label: string };
export type RecordingBridge = {
  setLocale?(locale: Locale): Promise<void>;
  devices(): Promise<RecordingDevice[]>;
  start(options: RecordingOptions): Promise<RecordingStatus>;
  /** Release also closes this caller’s file preview and device windows on plugin stop. */
  stop(release?: boolean): Promise<RecordingStatus>;
  status(): Promise<RecordingStatus>;
  list(before?: string): Promise<RecordingPage>;
  /** Open one sender-bound file stream for the client preview, never a native window. */
  play(id: string): Promise<RecordingPlayback>;
  readPlayback(token: string, offset: number): Promise<ArrayBuffer>;
  closePlayback(token: string): Promise<void>;
  reveal(id?: string): Promise<void>;
};
export type RecordingSource = { id: string; name: string; thumbnail: string };
export type RecordingLocale = {locale: Locale; revision: number};
export type RecordingWorkerInit = RecordingLocale & (
  | { role: "capture"; options: RecordingOptions; sources: RecordingSource[]; systemAudio: boolean }
  | { role: "devices" });
export const RECORDING_IPC = {
  LOCALE: "Syncord_RECORDING_LOCALE",
  DEVICES: "Syncord_RECORDING_DEVICES", DEVICES_RESULT: "Syncord_RECORDING_DEVICES_RESULT",
  START: "Syncord_RECORDING_START", STOP: "Syncord_RECORDING_STOP", STATUS: "Syncord_RECORDING_STATUS",
  PLAYBACK_READ: "Syncord_RECORDING_PLAYBACK_READ", PLAYBACK_CLOSE: "Syncord_RECORDING_PLAYBACK_CLOSE",
  LIST: "Syncord_RECORDING_LIST", PLAY: "Syncord_RECORDING_PLAY", REVEAL: "Syncord_RECORDING_REVEAL",
  INIT: "Syncord_RECORDING_WORKER_INIT", SELECT: "Syncord_RECORDING_WORKER_SELECT",
  READY: "Syncord_RECORDING_WORKER_READY", CHUNK: "Syncord_RECORDING_WORKER_CHUNK",
  FINISH: "Syncord_RECORDING_WORKER_FINISH", ERROR: "Syncord_RECORDING_WORKER_ERROR",
  WORKER_STOP: "Syncord_RECORDING_WORKER_STOP",
} as const;
export function parseRecordingOptions(raw: unknown): RecordingOptions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid recording options.");
  const v = raw as Record<string, unknown>;
  if (![720,1080,1440,2160].includes(v.resolution as number) || ![15,24,30].includes(v.fps as number)
      || typeof v.microphone !== "boolean" || typeof v.output !== "boolean"
      || typeof v.microphoneDevice !== "string" || v.microphoneDevice.length > 256
      || typeof v.outputDevice !== "string" || v.outputDevice.length > 256) throw new Error("Invalid recording options.");
  return { resolution: v.resolution as RecordingOptions["resolution"], fps: v.fps as RecordingOptions["fps"],
    microphone: v.microphone, microphoneDevice: v.microphoneDevice, output: v.output, outputDevice: v.outputDevice };
}
export function recordingId(raw: unknown): string {
  if (typeof raw !== "string" || !/^\d{13}-[a-f0-9]{32}$/.test(raw)) throw new Error("Invalid recording ID.");
  return raw;
}
/** Single byte range; supports Chromium's seeking without reading the whole video. */
export function recordingRange(header: string | null, size: number): { start: number; end: number; partial: boolean } | null {
  if (size <= 0) return null;
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
  return { start, end, partial: true };
}
