import { getLocale, t as i18nText } from "../../i18n";
import { MIN_LEAD_MS } from "./presets";

/**
 * Time formatting and parsing for the schedule UI.
 *
 * Everything here works in the browser's local time, which is what the user
 * means by "tomorrow at 9". All functions are pure and take `now` where a
 * result depends on the current time, so they can be tested without a clock.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** `YYYY-MM-DD` in local time, for `<input type="date">`. */
export function toDateInputValue(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `HH:MM` in local time, for `<input type="time">`. */
export function toTimeInputValue(at: number): string {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;

/**
 * A time of day, as typed: `hh:mm`, 24-hour.
 *
 * Separate from `parseLocalDateTime` because the picker edits the time on its
 * own: the day is chosen from the calendar and only the clock is typed, so the
 * two halves are validated at different moments.
 */
const TIME_OF_DAY_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * A sensible starting point for the picker: the next quarter hour, at least a
 * minute out.
 *
 * Returns the day and the `hh:mm` together because they have to agree. Snapping
 * the clock up can cross midnight, and then the time belongs to tomorrow while
 * the calendar still shows today — a moment that is already in the past, so the
 * picker would open with nothing selectable and no obvious reason. Within a
 * quarter hour of midnight the day moves forward instead.
 */
export function defaultSelection(
  now: number,
): { day: number; timeText: string } {
  const startOf = (at: number): number => {
    const d = new Date(at);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };

  const today = startOf(now);
  const earliest = now + MIN_LEAD_MS;
  // Snapped against local midnight rather than the epoch, because local
  // midnight is what "a quarter hour" is measured from. For every real timezone
  // the two coincide — offsets are multiples of fifteen minutes, so both are
  // quarter-hour boundaries — which is exactly why the coincidence is not worth
  // relying on: it is a property of the zone database, not of this code.
  const intoDay = earliest - today;
  const remainder = intoDay % (15 * MINUTE);
  const at = remainder ? earliest + (15 * MINUTE - remainder) : earliest;

  const [hours, minutes] = toTimeInputValue(at).split(":").map(Number);
  const onToday = today + (hours * 60 + minutes) * MINUTE;

  if (onToday - now < MIN_LEAD_MS) {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return { day: tomorrow.getTime(), timeText: "09:00" };
  }
  return { day: today, timeText: toTimeInputValue(at) };
}

export function parseTimeOfDay(
  text: string,
): { hours: number; minutes: number } | undefined {
  const match = TIME_OF_DAY_RE.exec(text.trim());
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return undefined;
  return { hours, minutes };
}

/**
 * Read the two native inputs into an epoch timestamp.
 *
 * The result is round-tripped through `Date` and re-formatted, which is the
 * only reliable way to reject impossible values: `new Date(2026, 1, 31)` rolls
 * over into March, and a calendar lets the user type 31 February but a real
 * timestamp cannot represent it.
 *
 * Returns `undefined` for anything malformed so the caller can show one clear
 * message instead of guessing which field is wrong.
 */
export function parseLocalDateTime(
  dateValue: string,
  timeValue: string,
): number | undefined {
  const date = DATE_RE.exec(dateValue.trim());
  const time = TIME_RE.exec(timeValue.trim());
  if (!date || !time) return undefined;

  const year = Number(date[1]);
  const month = Number(date[2]);
  const day = Number(date[3]);
  const hour = Number(time[1]);
  const minute = Number(time[2]);

  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > 31) return undefined;
  if (hour > 23 || minute > 59) return undefined;

  const at = new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
  if (!Number.isFinite(at)) return undefined;

  // Reject rolled-over dates: 31 February became 3 March, so the parts differ.
  const check = new Date(at);
  if (
    check.getFullYear() !== year ||
    check.getMonth() !== month - 1 ||
    check.getDate() !== day
  ) {
    return undefined;
  }
  return at;
}

export type TimeProblem = { message: string; at?: number };

/**
 * Why a custom date/time cannot be scheduled, if it cannot.
 *
 * `at` comes back on the "too close" case so the caller can suggest the
 * earliest legal time instead of only complaining.
 */
export function customTimeProblem(
  dateValue: string,
  timeValue: string,
  now: number,
): TimeProblem | undefined {
  const at = parseLocalDateTime(dateValue, timeValue);
  if (at === undefined) {
    return { message: i18nText("ui.that_date_and_time_cannot_be_read") };
  }
  if (at <= now) {
    return { message: i18nText("ui.pick_a_time_in_the_future") };
  }
  if (at - now < MIN_LEAD_MS) {
    return {
      message: i18nText("ui.pick_a_time_at_least_a_minute_from_now"),
      at: now + MIN_LEAD_MS,
    };
  }
  return undefined;
}

/**
 * "in 5 minutes" / "in 2 hours" / "overdue".
 *
 * Deliberately coarse: a countdown that ticks every second in a list of cards
 * would mean re-rendering the whole section constantly for no benefit.
 */
export function formatCountdown(
  sendAt: number,
  now: number,
): string {
  const delta = sendAt - now;
  if (delta <= 0) return i18nText("ui.due_now");
  if (delta < MINUTE) return i18nText("ui.in_under_a_minute");
  if (delta < HOUR) return i18nText("ui.in_value_min", {v0: Math.round(delta / MINUTE)});
  if (delta < DAY) {
    const hours = Math.floor(delta / HOUR);
    const minutes = Math.round((delta % HOUR) / MINUTE);
    return minutes && hours < 6
      ? i18nText("ui.in_value_h_value_min", {v0: hours, v1: minutes})
      : i18nText("ui.in_value_h", {v0: hours});
  }
  const days = Math.round(delta / DAY);
  return days === 1 ? "tomorrow" : i18nText("ui.in_value_days", {v0: days});
}

function isSameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
}

/** The date and time as written in the calendar, e.g. "27 Sep 2026, 14:05". */
export function formatAbsolute(at: number): string {
  const date = new Date(at);
  const day = date.toLocaleDateString(getLocale(), {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `${day}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * A compact form for the card header: time today, "Tomorrow 09:00", or a date.
 */
export function formatWhen(
  at: number,
  now: number,
): string {
  if (isSameDay(at, now)) return i18nText("ui.today_value", {v0: toTimeInputValue(at)});
  if (isSameDay(at, now + DAY)) return i18nText("ui.tomorrow_value", {v0: toTimeInputValue(at)});
  return formatAbsolute(at);
}

/** Discord's message limit, mirrored here so the picker can show a counter. */
export function remainingChars(content: string, max: number): number {
  return max - content.length;
}
