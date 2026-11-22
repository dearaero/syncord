/**
 * Chat snapshot: main captures a rectangle of the *calling* Discord page and
 * writes it to the system clipboard. No other window, no pixels returned to the
 * page, no file path, no format choice.
 */
export const SNAPSHOT_IPC = { COPY: "Syncord_SNAPSHOT_COPY" } as const;
/** Largest edge accepted, in CSS pixels; well above any real chat viewport. */
export const SNAPSHOT_MAX_EDGE = 8192;
export type SnapshotRect = { x: number; y: number; width: number; height: number };
export type SnapshotResult = { width: number; height: number };
export type SnapshotBridge = { copy(rect: SnapshotRect): Promise<SnapshotResult> };

export function parseSnapshotRect(value: unknown): SnapshotRect {
  if (!value || typeof value !== "object") throw Error("Invalid snapshot area");
  const v = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of ["x", "y", "width", "height"] as const) {
    const n = v[key];
    if (typeof n !== "number" || !Number.isFinite(n)) throw Error("Invalid snapshot area");
    out[key] = Math.round(n);
  }
  if (out.x < 0 || out.y < 0 || out.width < 1 || out.height < 1 || out.width > SNAPSHOT_MAX_EDGE || out.height > SNAPSHOT_MAX_EDGE
    || out.x > SNAPSHOT_MAX_EDGE || out.y > SNAPSHOT_MAX_EDGE) throw Error("Invalid snapshot area");
  return { x: out.x, y: out.y, width: out.width, height: out.height };
}
