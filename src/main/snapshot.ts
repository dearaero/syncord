import { clipboard, ClipboardItem, type IpcMainInvokeEvent } from "electron";
import { parseSnapshotRect, type SnapshotResult } from "../shared/snapshot";

/**
 * Captures only `event.sender` — the trusted Discord page that asked — so a
 * caller can never reach another window's pixels. The image goes straight to
 * the clipboard; nothing is returned to the renderer but its size.
 */
export async function copySnapshot(event: IpcMainInvokeEvent, raw: unknown): Promise<SnapshotResult> {
  const rect = parseSnapshotRect(raw);
  const contents = event.sender;
  // The page measures in CSS pixels; capturePage takes DIPs, which differ by Discord's zoom setting.
  const zoom = typeof contents.getZoomFactor === "function" ? contents.getZoomFactor() : 1;
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const image = await contents.capturePage({
    x: Math.round(rect.x * scale), y: Math.round(rect.y * scale),
    width: Math.max(1, Math.round(rect.width * scale)), height: Math.max(1, Math.round(rect.height * scale)),
  });
  if (image.isEmpty()) throw Error("Snapshot unavailable");
  // Electron 44 replaced writeImage with the W3C-shaped async clipboard.
  await clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(image.toPNG())], { type: "image/png" }) })]);
  return image.getSize();
}
