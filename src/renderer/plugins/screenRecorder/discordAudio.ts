import type { RecordingOptions } from "../../../shared/recording";

type InputStore = {
  getInputDeviceId?: () => unknown;
  getInputDevices?: () => unknown;
};
/** Read Discord's selected input at each start; Chromium IDs are salted, native IDs are not interchangeable. */
export function discordRecordingOptions(options: RecordingOptions): RecordingOptions {
  const next = { ...options, microphoneDevice: "", outputDevice: "" };
  if (!options.microphone) return next;
  const common = window.Syncord?.common?.stores.MediaEngineStore;
  const store = (common ?? window.Syncord?.webpack?.findByStoreName("MediaEngineStore")) as InputStore | undefined;
  if (!store?.getInputDeviceId) throw new Error("Discord audio settings are not ready. Open Voice & Video once, then try recording again.");
  let id: unknown;
  try { id = store.getInputDeviceId(); } catch { throw new Error("Discord's microphone selection could not be read. Try again after Voice & Video settings load."); }
  if (id === "default" || id === "communications" || id === "-1" || id === -1 || id === "" || id == null) return next;
  let devices: unknown;
  try { devices = store.getInputDevices?.(); } catch { /* report unavailable below */ }
  if (!devices || typeof devices !== "object") throw new Error("Discord's selected microphone is unavailable. Check Discord Voice & Video settings.");
  const entries = Object.values(devices as Record<string, unknown>);
  const device = entries.find(item => item && typeof item === "object" && String((item as {id?:unknown}).id) === String(id));
  const indexed = (devices as Record<string, unknown>)[String(id)];
  const match = device ?? indexed;
  if (match && typeof match === "object" && (match as {index?:unknown}).index === -1) return next;
  const name = match && typeof match === "object" ? (match as {name?:unknown}).name : undefined;
  if (typeof name !== "string" || !name.trim() || name.length > 200) throw new Error("Discord's selected microphone is unavailable. Check Discord Voice & Video settings.");
  next.microphoneDevice = `label:${name}`;
  return next;
}
