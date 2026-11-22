import { t as i18nText } from "../../i18n";
/**
 * Schedule presets.
 *
 * Every preset is a pure function of "now", so they are testable without a
 * clock and always land in the future. The user's list is fixed:
 * 1 minute, 5, 15, 30, 1 hour, 3 hours, tomorrow at the same time, and a custom
 * date.
 */

export type PresetId =
  | "m1"
  | "m5"
  | "m15"
  | "m30"
  | "h1"
  | "h3"
  | "tomorrow"
  | "custom";

export type SchedulePreset = {
  id: PresetId;
  /** Menu label, shown in the composer menu. */
  label: string;
  /**
   * When this preset fires, or `null` for `custom`, which needs the user to
   * pick a time first.
   */
  resolve: ((now: number) => number) | null;
};

/** Smallest gap we accept, so "now" can never be scheduled by accident. */
export const MIN_LEAD_MS = 60_000;

const minute = 60_000;
const hour = 60 * minute;

function offset(ms: number): (now: number) => number {
  return (now: number) => now + ms;
}

/**
 * Tomorrow at the same clock time.
 *
 * Adding a calendar day rather than 24 hours keeps the wall-clock time across a
 * daylight-saving boundary, and is always ~24h out, so it can never resolve to
 * something in the past.
 */
function tomorrowSameTime(now: number): number {
  const date = new Date(now);
  date.setDate(date.getDate() + 1);
  return date.getTime();
}

export const SCHEDULE_PRESETS: readonly SchedulePreset[] = [
  { id: "m1", get label() { return i18nText("ui.in_1_minute"); }, resolve: offset(minute) },
  { id: "m5", get label() { return i18nText("ui.in_5_minutes"); }, resolve: offset(5 * minute) },
  { id: "m15", get label() { return i18nText("ui.in_15_minutes"); }, resolve: offset(15 * minute) },
  { id: "m30", get label() { return i18nText("ui.in_30_minutes"); }, resolve: offset(30 * minute) },
  { id: "h1", get label() { return i18nText("ui.in_1_hour"); }, resolve: offset(hour) },
  { id: "h3", get label() { return i18nText("ui.in_3_hours"); }, resolve: offset(3 * hour) },
  { id: "tomorrow", get label() { return i18nText("ui.tomorrow_at_this_time"); }, resolve: tomorrowSameTime },
  { id: "custom", get label() { return i18nText("ui.custom_date_time"); }, resolve: null },
];

export function presetById(id: PresetId): SchedulePreset | undefined {
  return SCHEDULE_PRESETS.find((preset) => preset.id === id);
}

export function isPresetId(value: unknown): value is PresetId {
  return (
    typeof value === "string" &&
    SCHEDULE_PRESETS.some((preset) => preset.id === value)
  );
}

/**
 * Resolve a preset to an absolute time.
 *
 * Every preset is at least `MIN_LEAD_MS` ahead by construction — `m1` is exactly
 * that, the rest are further — so there is nothing to clamp. The guarantee is
 * asserted in the tests rather than defended against here, because a clamp that
 * can never fire is a comment that lies about what the code does.
 */
export function resolvePreset(id: PresetId, now: number): number | undefined {
  const preset = presetById(id);
  const resolve = preset?.resolve;
  if (!resolve) return undefined;
  return resolve(now);
}
