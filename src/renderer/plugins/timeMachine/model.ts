/** Pure timeline logic over Message Logger rows. No DOM, no Discord. */
export type TmKind = "delete" | "edit" | "react" | "unreact" | "pin" | "unpin";
export type TmEvent = { at: number; kind: TmKind; messageId: string; actor: string; emoji?: string };
export type TmRow = {
  id: string;
  authorId: string;
  content: string;
  deleted?: number;
  edits?: { at: number; content: string }[];
  activity?: { at: number; kind: "react" | "unreact" | "pin" | "unpin"; emoji?: string; userId?: string }[];
};

/** Every event in one channel, oldest first. Ties keep a stable message order. */
export function buildTimeline(rows: readonly TmRow[]): TmEvent[] {
  const out: TmEvent[] = [];
  for (const row of rows) {
    for (const edit of row.edits ?? []) out.push({ at: edit.at, kind: "edit", messageId: row.id, actor: row.authorId });
    for (const item of row.activity ?? [])
      out.push({ at: item.at, kind: item.kind, messageId: row.id, actor: item.userId ?? "", emoji: item.emoji });
    if (row.deleted) out.push({ at: row.deleted, kind: "delete", messageId: row.id, actor: row.authorId });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Position `p` in 0..events.length: events before `p` have happened, the rest
 * have not. `events.length` is the present. The cut time is the moment just
 * before event `p`.
 */
export function cutAt(events: readonly TmEvent[], p: number): number {
  return p >= events.length ? Number.POSITIVE_INFINITY : events[Math.max(0, p)].at;
}

/** Text a message showed just before `cut`. Each edit stores the text it replaced. */
export function contentAt(row: TmRow, cut: number): string {
  const edits = [...(row.edits ?? [])].sort((a, b) => a.at - b.at);
  for (const edit of edits) if (edit.at >= cut) return edit.content;
  return row.content;
}

export function deletedBefore(row: TmRow, cut: number): boolean {
  return typeof row.deleted === "number" && row.deleted < cut;
}

const DISCORD_EPOCH = 1420070400000n;
/** Creation time from a snowflake; NaN for anything that is not one. */
export function createdAt(id: string): number {
  if (!/^\d{17,22}$/.test(id)) return Number.NaN;
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

/** The smallest snowflake for a moment; Discord's history API accepts it as an "around" point. */
export function snowflakeAt(ms: number): string {
  return ((BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH) << 22n).toString();
}

/** Event counts in `bins` equal slices of [first event, last event], scaled 0..1. */
export function density(events: readonly TmEvent[], bins: number): number[] {
  const out = new Array<number>(Math.max(1, bins)).fill(0);
  if (!events.length) return out;
  const start = events[0].at, span = Math.max(1, events[events.length - 1].at - start);
  for (const event of events) out[Math.min(out.length - 1, Math.floor(((event.at - start) / span) * out.length))]++;
  const peak = Math.max(...out);
  return out.map((n) => (peak ? n / peak : 0));
}

/** Playback delay per event, in ms, for a speed multiplier. */
export function stepDelay(speed: number): number {
  return Math.round(1200 / Math.max(1, speed));
}
