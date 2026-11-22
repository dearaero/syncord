import { dateFormatter, onLocaleChange, preserveInputs, getLocale, h, messageHtml as i18nHtml, setLocalizedAttribute, setLocalizedHtml, t as i18nText } from "../../i18n";
import { createLogger } from "../../api/logger";
import { MIN_LEAD_MS } from "./presets";
import { defaultSelection, formatCountdown, parseTimeOfDay } from "./time";

/**
 * The custom date and time picker.
 *
 * Built by hand rather than from native date and time inputs, because those are
 * drawn by the operating system: they keep the platform's light dropdown in a
 * dark client, which is the mismatch the settings panel's own select had. This is
 * styled from Discord's theme variables instead, so it follows the client's
 * light and dark themes.
 *
 * The time is typed as `hh:mm` rather than picked from a list of every quarter
 * of the day. Ninety-six rows of slots was both cramped and awkward, and it made
 * the control taller than the calendar it belonged to. A field matches what
 * Discord's own time fields look like, and it lets someone type a time exactly.
 *
 * A time in the past is refused, whichever way it was entered: the field is
 * validated on every keystroke and the confirm button stays disabled until the
 * combination is a real, future moment.
 */

const log = createLogger("scheduled-messages:picker");

const HOST_ID = "Syncord-schedule-picker";
const STYLE_ID = `${HOST_ID}-css`;

function weekdays(): string[] {
  const formatter=dateFormatter({weekday:'short',calendar:'gregory',timeZone:'UTC'});
  return Array.from({length:7},(_,index)=>formatter.format(Date.UTC(2024,0,1+index)));
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * Keystrokes on the time field are the expected way in, and Enter confirms, so
 * the field is treated as the control it is rather than a dropdown.
 */

export type PickerHandlers = {
  /** Called with an absolute time. Only called for a valid, future slot. */
  onConfirm: (sendAt: number) => void;
  onCancel: () => void;
};

export type PickerHandle = {
  /** Open, anchored to an element. Re-anchors if already open. */
  open: (anchor: Element) => void;
  close: () => void;
  isOpen: () => boolean;
  /** The time currently shown, for tests and for the caller to inspect. */
  timeText: () => string;
  dispose: () => void;
};

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function addDays(at: number, days: number): number {
  const date = new Date(at);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

function addMonths(at: number, months: number): number {
  const date = new Date(at);
  date.setDate(1);
  date.setMonth(date.getMonth() + months);
  return date.getTime();
}

/** Monday-first index, matching the WEEKDAYS row. */
function mondayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

export function installSchedulePicker(
  handlers: PickerHandlers,
): PickerHandle {
  ensureStyle();

  let host: HTMLElement | undefined;
  let anchorEl: Element | undefined;
  let open = false;
  let closed = false;
  let disposeLocale: (()=>void)|undefined;

  /** The day the grid is showing, and the day chosen. */
  let viewMonth: number;
  let chosenDay: number;
  /** The `hh:mm` text, kept as typed so a half-finished entry is not fought. */
  let timeText = "";
  /** Bumped to redraw after an in-place change, e.g. a typed time. */
  let repaint: () => void = () => {};

  const now = (): number => Date.now();

  /**
   * Land on a day and a time that agree — see `defaultSelection`, which is where
   * the midnight rule lives and is tested at several times of day.
   */
  function resetTo(nowAt: number): void {
    const pick = defaultSelection(nowAt);
    chosenDay = pick.day;
    viewMonth = pick.day;
    timeText = pick.timeText;
  }

  resetTo(now());

  /** The moment the current day and time text describe, if it describes one. */
  function chosenAt(): number | undefined {
    const clock = parseTimeOfDay(timeText);
    if (!clock) return undefined;
    return chosenDay + clock.hours * 60 * MINUTE_MS + clock.minutes * MINUTE_MS;
  }

  /** Why the entry cannot be used, if it cannot. */
  function problem(): string | undefined {
    const text = timeText.trim();
    if (!text) return i18nText("ui.enter_a_time");
    if (!parseTimeOfDay(text)) return i18nText("ui.use_24_hour_hh_mm_for_example_09_30");
    const at = chosenAt();
    if (at === undefined) return i18nText("ui.use_24_hour_hh_mm_for_example_09_30");
    const current = now();
    if (at <= current) return i18nText("ui.pick_a_time_later_than_now");
    if (at - current < MIN_LEAD_MS) return i18nText("ui.pick_a_time_at_least_a_minute_away");
    return undefined;
  }

  function monthLabel(at: number): string {
    return new Date(at).toLocaleDateString(getLocale(), {
      calendar: "gregory",
      month: "long",
      year: "numeric",
    });
  }

  /** Days in the month shown, padded to whole weeks. */
  function gridCells(month: number): { at: number; inMonth: boolean }[] {
    const first = new Date(month);
    first.setDate(1);
    const lead = mondayIndex(first);
    const start = addDays(startOfDay(month), -lead);
    const cells: { at: number; inMonth: boolean }[] = [];
    // Six weeks always fits, so the grid does not resize between months and
    // the popover never jumps while the user is clicking.
    for (let i = 0; i < 42; i++) {
      const at = addDays(start, i);
      cells.push({
        at,
        inMonth: new Date(at).getMonth() === new Date(month).getMonth(),
      });
    }
    return cells;
  }

  function close(): void {
    if (!open) return;
    open = false;
    disposeLocale?.();disposeLocale=undefined;
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onOutside, true);
    window.removeEventListener("resize", onLayout);
    window.removeEventListener("scroll", onScroll, true);
    host?.remove();
    host = undefined;
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      handlers.onCancel();
    }
  }

  function onOutside(event: Event): void {
    const target = event.target as Node | null;
    if (!host || !target) return;
    if (host.contains(target)) return;
    // Let the anchor's own click handler decide; it will re-open us if it wants.
    if (anchorEl?.contains(target)) return;
    close();
  }

  /**
   * Close because the page moved under the popover.
   *
   * Scroll from inside the picker is ignored: the calendar is scrollable and
   * treating that as the layout moving would close it on the first scroll.
   */
  function onScroll(event: Event): void {
    const from = event.target;
    if (host && from instanceof Node && host.contains(from)) return;
    close();
  }

  const onLayout = (): void => close();

  function position(): void {
    if (!host || !anchorEl) return;
    const anchorRect = anchorEl.getBoundingClientRect();
    const box = host.getBoundingClientRect();
    const margin = 8;

    // Prefer below the button, flip above when there is not enough room.
    const below = window.innerHeight - anchorRect.bottom;
    const top =
      below >= box.height + margin
        ? anchorRect.bottom + 6
        : Math.max(margin, anchorRect.top - box.height - 6);

    const maxLeft = window.innerWidth - box.width - margin;
    const left = Math.max(margin, Math.min(anchorRect.left, maxLeft));
    host.style.left = `${Math.round(left)}px`;
    host.style.top = `${Math.round(top)}px`;
  }

  function render(): void {
    if (!host) return;
    const today = startOfDay(now());
    const at = chosenAt();
    const issue = problem();
    const ok = issue === undefined && at !== undefined;

    setLocalizedHtml(host, `
      <div class="dion-sched-pick-head">
        <button type="button" class="dion-sched-pick-nav" data-dick="prev" aria-label="${h("ui.previous_month")}" data-si18n-aria-label="ui.previous_month">
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z"/></svg>
        </button>
        <span class="dion-sched-pick-month">${escapeText(monthLabel(viewMonth))}</span>
        <button type="button" class="dion-sched-pick-nav" data-dick="next" aria-label="${h("ui.next_month")}" data-si18n-aria-label="ui.next_month">
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8.6 7.4 10 6l6 6-6 6-1.4-1.4L13.2 12z"/></svg>
        </button>
      </div>

      <div class="dion-sched-pick-week" aria-hidden="true">
        ${weekdays().map((d) => `<span>${d}</span>`).join("")}
      </div>

      <div class="dion-sched-pick-grid" role="grid">
        ${gridCells(viewMonth)
          .map((cell) => {
            const date = new Date(cell.at);
            const isPast = cell.at < today;
            const cls = [
              "dion-sched-pick-day",
              cell.inMonth ? "" : "is-outside",
              cell.at === today ? "is-today" : "",
              cell.at === chosenDay ? "is-selected" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return `<button type="button" class="${cls}" data-day="${cell.at}"${
              isPast ? " disabled" : ""
            } aria-pressed="${cell.at === chosenDay}" aria-label="${date.toDateString()}">${date.getDate()}</button>`;
          })
          .join("")}
      </div>

      <div class="dion-sched-pick-when">
        <label class="dion-sched-pick-label" for="dion-sched-pick-time">${i18nHtml("ui.time")}</label>
        <input
          id="dion-sched-pick-time"
          class="dion-sched-pick-time${issue ? " is-invalid" : ""}"
          data-dick="time"
          type="text"
          inputmode="numeric"
          autocomplete="off"
          spellcheck="false"
          maxlength="5"
          placeholder="hh:mm"
          value="${escapeText(timeText)}"
          aria-invalid="${issue ? "true" : "false"}"
          aria-describedby="dion-sched-pick-note"
        />
        <p class="dion-sched-pick-note${issue ? " is-invalid" : ""}" id="dion-sched-pick-note" role="status">
          ${issue
              ? escapeText(issue)
              : i18nHtml("ui.value_from_now", {v0: formatCountdown(at!, now())})}
        </p>
      </div>

      <div class="dion-sched-pick-foot">
        <button type="button" class="dion-sched-pick-btn" data-dick="cancel">${i18nHtml("ui.cancel")}</button>
        <button type="button" class="dion-sched-pick-btn is-primary" data-dick="confirm"${ok ? "" : " disabled"}>${i18nHtml("ui.schedule")}</button>
      </div>`);
  }

  function confirm(): void {
    const at = chosenAt();
    if (at === undefined || problem()) return;
    close();
    handlers.onConfirm(at);
  }

  function onClick(event: Event): void {
    const target = event.target as HTMLElement | null;
    if (!host || !target) return;

    const nav = target.closest<HTMLElement>("[data-dick]");
    if (nav) {
      const kind = nav.getAttribute("data-dick");
      if (kind === "prev") viewMonth = addMonths(viewMonth, -1);
      else if (kind === "next") viewMonth = addMonths(viewMonth, 1);
      else if (kind === "cancel") {
        close();
        handlers.onCancel();
        return;
      } else if (kind === "confirm") {
        confirm();
        return;
      }
      render();
      return;
    }

    const day = target.closest<HTMLElement>("[data-day]");
    if (day) {
      const at = Number(day.getAttribute("data-day"));
      if (!Number.isFinite(at)) return;
      chosenDay = at;
      render();
    }
  }

  /**
   * Keystrokes on the time field.
   *
   * Only redrawn, never retyped: replacing the input on every character would
   * move the caret and stop anyone entering a time. The field is left alone and
   * only the note and the button are updated.
   */
  function onInput(event: Event): void {
    const field = event.target as HTMLInputElement | null;
    if (!field || field.getAttribute("data-dick") !== "time") return;
    timeText = field.value;
    refreshValidity();
  }

  /** Update the note and the button without touching the field. */
  function refreshValidity(): void {
    if (!host) return;
    const at = chosenAt();
    const issue = problem();
    const note = host.querySelector<HTMLElement>(".dion-sched-pick-note");
    const field = host.querySelector<HTMLInputElement>(".dion-sched-pick-time");
    const confirm = host.querySelector<HTMLButtonElement>('[data-dick="confirm"]');

    if (note) {
      note.textContent = issue
        ? issue
        : i18nText("ui.value_from_now", {v0: formatCountdown(at!, now())});
      note.classList.toggle("is-invalid", Boolean(issue));
    }
    if (field) {
      field.classList.toggle("is-invalid", Boolean(issue));
      field.setAttribute("aria-invalid", issue ? "true" : "false");
    }
    if (confirm) confirm.disabled = Boolean(issue) || at === undefined;
  }

  function openPicker(anchor: Element): void {
    if (closed) return;
    anchorEl = anchor;
    // Never open on a moment that has gone by.
    if (problem()) resetTo(now());

    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      host.className = "dion-sched-pick";
      host.setAttribute("role", "dialog");
      setLocalizedAttribute(host, "aria-label", "ui.choose_a_date_and_time");
      host.addEventListener("click", onClick);
      host.addEventListener("input", onInput);
      document.documentElement.appendChild(host);
    }

    open = true;
    host.hidden = false;
    repaint = render;
    disposeLocale?.();
    disposeLocale=onLocaleChange(()=>{if(host)preserveInputs(host,()=>{render();position();});});
    render();
    position();

    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onOutside, true);
    window.addEventListener("resize", onLayout);
    window.addEventListener("scroll", onScroll, true);
  }

  return {
    open: openPicker,
    close,
    isOpen: () => open,
    timeText: () => timeText,
    dispose() {
      closed = true;
      close();
      document.getElementById(STYLE_ID)?.remove();
    },
  };
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = SCHEDULED_PICKER_CSS;
  document.documentElement.appendChild(style);
}

/**
 * Sized to the client's own popouts: 8px radius, the floating background, the
 * high elevation shadow and a 1px elevation stroke. Every colour is a Discord
 * theme token, so light and dark both come for free.
 */
const SCHEDULED_PICKER_CSS = `
.dion-sched-pick {
  position: fixed;
  z-index: 1002;
  /* Set here rather than relied on from the client's global reset: the popover
     is also mounted outside the app tree, and a field that overflows its card
     because of a missing border-box rule is not worth depending on. */
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 268px;
  max-width: calc(100vw - 16px);
  padding: 12px;
  border-radius: 8px;
  background: var(--background-elevated, var(--background-floating, #111214));
  box-shadow:
    var(--elevation-stroke, 0 0 0 1px rgba(0,0,0,.15)),
    var(--elevation-high, 0 8px 16px rgba(0,0,0,.24));
  color: var(--text-normal, #dbdee1);
  font-family: var(--font-primary, gg sans, "Noto Sans", Helvetica, Arial, sans-serif);
  font-size: 14px;
  line-height: 20px;
  user-select: none;
}

.dion-sched-pick[hidden] {
  display: none;
}

.dion-sched-pick-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  height: 24px;
}

.dion-sched-pick-month {
  color: var(--header-primary, #f2f3f5);
  font-size: 14px;
  font-weight: 600;
  line-height: 24px;
}

.dion-sched-pick-nav {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--interactive-normal, #b5bac1);
  cursor: pointer;
  transition: background-color 100ms ease, color 100ms ease, opacity 100ms ease;
}

.dion-sched-pick-nav:hover {
  background: var(--background-modifier-hover, rgba(255,255,255,.04));
  color: var(--interactive-hover, #dbdee1);
}

.dion-sched-pick-nav:active {
  opacity: .7;
}

.dion-sched-pick-week,
.dion-sched-pick-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
}

.dion-sched-pick-week {
  margin-bottom: 2px;
}

.dion-sched-pick-week span {
  color: var(--text-muted, #949ba4);
  font-size: 11px;
  font-weight: 700;
  line-height: 20px;
  text-align: center;
  text-transform: uppercase;
}

.dion-sched-pick-day {
  display: grid;
  place-items: center;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-normal, #dbdee1);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: background-color 100ms ease, color 100ms ease;
}

.dion-sched-pick-day:hover:not(:disabled):not(.is-selected) {
  background: var(--background-modifier-hover, rgba(255,255,255,.04));
  color: var(--interactive-hover, #fff);
}

.dion-sched-pick-day.is-outside {
  color: var(--text-muted, #949ba4);
  opacity: .45;
}

/* Today is marked by its colour and a ring, so a filled selection still
   reads as the selection. */
.dion-sched-pick-day.is-today {
  box-shadow: inset 0 0 0 1px var(--brand-experiment, #5865f2);
  color: var(--text-brand, #00a8fc);
  font-weight: 600;
}

.dion-sched-pick-day.is-selected {
  background: var(--brand-experiment, #5865f2);
  color: #fff;
}

.dion-sched-pick-day:disabled {
  color: var(--text-disabled, #4f545c);
  cursor: not-allowed;
}

.dion-sched-pick-when {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 4px;
  border-top: 1px solid var(--background-modifier-accent, rgba(255,255,255,.06));
}

.dion-sched-pick-label {
  color: var(--text-muted, #949ba4);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .02em;
  text-transform: uppercase;
}

.dion-sched-pick-time {
  box-sizing: border-box;
  width: 100%;
  height: 36px;
  padding: 8px 10px;
  border: 1px solid var(--input-border, var(--background-modifier-accent, rgba(255,255,255,.1)));
  border-radius: 4px;
  outline: none;
  background: var(--input-background, var(--background-secondary, #2b2d31));
  color: var(--text-normal, #dbdee1);
  font: inherit;
  font-size: 16px;
  font-variant-numeric: tabular-nums;
  letter-spacing: .02em;
  user-select: text;
  transition: border-color 100ms ease;
}

.dion-sched-pick-time::placeholder {
  color: var(--text-placeholder, #6d6f78);
}

.dion-sched-pick-time:hover {
  border-color: var(--input-border-hover, rgba(255,255,255,.16));
}

.dion-sched-pick-time:focus {
  border-color: var(--brand-experiment, #5865f2);
}

.dion-sched-pick-time.is-invalid,
.dion-sched-pick-time.is-invalid:focus {
  border-color: var(--text-danger, #f23f43);
}

.dion-sched-pick-note {
  margin: 0;
  min-height: 16px;
  color: var(--text-muted, #949ba4);
  font-size: 12px;
  line-height: 16px;
  overflow-wrap: anywhere;
}

.dion-sched-pick-note.is-invalid {
  color: var(--text-danger, #f23f43);
}

.dion-sched-pick-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 4px;
}

.dion-sched-pick-btn {
  min-height: 32px;
  padding: 2px 16px;
  border: 0;
  border-radius: 3px;
  background: var(--background-secondary, #2b2d31);
  color: var(--text-normal, #dbdee1);
  font: inherit;
  font-size: 14px;
  font-weight: 500;
  line-height: 18px;
  cursor: pointer;
  transition: background-color 100ms ease, color 100ms ease, opacity 100ms ease;
}

.dion-sched-pick-btn:hover:not(:disabled) {
  background: var(--background-modifier-hover, rgba(255,255,255,.06));
  color: var(--interactive-hover, #fff);
}

.dion-sched-pick-btn.is-primary {
  background: var(--brand-experiment, #5865f2);
  color: #fff;
}

.dion-sched-pick-btn.is-primary:hover:not(:disabled) {
  background: var(--brand-experiment-hover, #4752c4);
  color: #fff;
}

.dion-sched-pick-btn:disabled {
  opacity: .5;
  cursor: not-allowed;
}
`;

export { DAY_MS };
