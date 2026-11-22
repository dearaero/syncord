/**
 * The chat-input clock button, its preset menu, and the custom picker.
 *
 * The menu is driven through a stand-in for Discord's own components, the way the
 * client would, and clicks are dispatched as the full pointer sequence a real
 * gesture produces — a capture-phase pointerdown handler that ate the click was a
 * real bug here once already, and `el.click()` cannot see it.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { build } from "esbuild";

const dir = await mkdtemp(path.join(tmpdir(), "dion-schedcomposer-"));

await build({
  stdin: {
    contents: `
      import { installScheduleButton } from './src/renderer/plugins/scheduledMessages/composer';
      import { installSchedulePicker } from './src/renderer/plugins/scheduledMessages/picker';
      import { kit } from './src/renderer/discordKit';
      import { SCHEDULE_PRESETS } from './src/renderer/plugins/scheduledMessages/presets';
      import { parseLocalDateTime, customTimeProblem, toDateInputValue, toTimeInputValue } from './src/renderer/plugins/scheduledMessages/time';
      window.api = { installScheduleButton, installSchedulePicker, kit, SCHEDULE_PRESETS,
                     parseLocalDateTime, customTimeProblem, toDateInputValue, toTimeInputValue };
    `,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "browser",
  outfile: path.join(dir, "bundle.js"),
  logLevel: "warning",
});

// A composer shaped like the client's, including the nested button structure the
// chrome is borrowed from.
const COMPOSER = `
  <div class="channelBottomBarArea_a1b3c">
    <div class="chatContent_a1b3c">
      <div class="textArea__74017 textAreaSlate__74017 slateContainer_ec4baf"></div>
      <div class="buttons__74017">
        <div class="container__5287f">
          <div class="buttonContainer__74017">
            <div class="button__74017 button__24af7 stickerButton__74017" role="button" aria-label="Open sticker picker">
              <div class="buttonWrapper__24af7 buttonWrapper__74017">
                <div class="lottieIcon__5eb9b lottieIconColors__5eb9b"><svg viewBox="0 0 24 24"></svg></div>
              </div>
            </div>
          </div>
        </div>
        <div class="separator_aa63ab"></div>
        <div class="container_aa63ab">
          <div class="button__74017 button__24af7" role="button" aria-label="Send Message">
            <svg class="sendIcon_aa63ab" viewBox="0 0 24 24"></svg>
          </div>
        </div>
      </div>
    </div>
  </div>`;

await writeFile(
  path.join(dir, "boot.js"),
  `
  window.__composer = ${JSON.stringify(COMPOSER)};
  window.__mountComposer = () => {
    if (document.querySelector('[class*="channelBottomBarArea"]')) return;
    document.body.insertAdjacentHTML('beforeend', window.__composer);
  };
  window.__clearComposer = () => {
    document.querySelector('[class*="channelBottomBarArea"]')?.remove();
    document.getElementById('Syncord-schedule-button')?.remove();
    document.getElementById('fake-menu')?.remove();
    document.getElementById('Syncord-schedule-picker')?.remove();
  };

  // A real click is pointerdown -> mousedown -> pointerup -> mouseup -> click.
  window.__realClick = (el) => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true }));
    }
  };

  // Stand-ins for Discord's menu components. Defined as a function because
  // boot.js runs before the bundle, so window.api does not exist yet.
  window.__stubKit = () => {
  window.__menu = { opened: 0, closed: 0, labels: [], badProps: [] };
  const KNOWN_ITEM = new Set(['key', 'id', 'label', 'action', 'disabled', 'leadingAccessory']);
  const h = (tag) => (props, ...kids) => {
    if (tag === 'MenuItem' && props && props.label) {
      for (const k of Object.keys(props)) {
        if (!KNOWN_ITEM.has(k)) window.__menu.badProps.push(k);
      }
      window.__menu.labels.push(props.label);
    }
    return { tag, props: props || {}, children: kids.flat().filter(Boolean) };
  };
  let repaint = () => {};
  let menuNode = null;
  const cells = new Map();
  let cell = 0;
  const kit = window.api.kit;
  kit.react = {
    createElement: (tag, props, ...kids) => h(tag)(props, ...kids),
    useState: (init) => {
      const key = cell++;
      if (!cells.has(key)) cells.set(key, init);
      return [cells.get(key), (next) => {
        cells.set(key, typeof next === 'function' ? next(cells.get(key)) : next);
        repaint();
      }];
    },
  };
  kit.menu = 'Menu';
  kit.menuItem = 'MenuItem';
  kit.menuSeparator = 'MenuSeparator';
  kit.closeContextMenu = () => {
    window.__menu.closed += 1;
    if (window.__dropAway) { window.__dropAway(); window.__dropAway = null; }
    const host = document.getElementById('fake-menu');
    if (!host) return;
    document.body.removeChild(host);
    const onClose = menuNode && menuNode.props && menuNode.props.onClose;
    if (typeof onClose === 'function') onClose();
  };
  kit.openContextMenu = (event, render) => {
    window.__menu.opened += 1;
    const host = document.createElement('div');
    host.id = 'fake-menu';
    host.setAttribute('role', 'menu');
    const walk = (node) => {
      if (!node) return;
      if (typeof node === 'function') throw new Error('Functions are not valid as a React child');
      if (typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (typeof node.tag === 'function') { walk(node.tag(node.props)); return; }
      if (node.tag === 'Menu') menuNode = node;
      if (node.tag === 'MenuItem') {
        const el = document.createElement('button');
        el.type = 'button';
        el.setAttribute('role', 'menuitem');
        el.dataset.label = node.props.label || '';
        el.addEventListener('click', () => node.props.action && node.props.action());
        host.appendChild(el);
      }
      walk(node.children);
    };
    cell = 0;
    repaint = () => { host.textContent = ''; menuNode = null; walk(render()); };
    repaint();
    document.body.appendChild(host);
    // The real layer dismisses itself on a click outside; ours must cope with
    // that rather than implement it.
    const away = (e) => { if (!host.contains(e.target)) kit.closeContextMenu(); };
    document.addEventListener('pointerdown', away, true);
    window.__dropAway = () => document.removeEventListener('pointerdown', away, true);
    return true;
  };
  };
`,
);
await writeFile(
  path.join(dir, "index.html"),
  `<!doctype html><meta charset="utf-8"><body><script src="boot.js"></script><script src="bundle.js"></script></body>`,
);

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(pathToFileURL(path.join(dir, "index.html")).href);

  // ── the button and the preset menu ──────────────────────────────────────
  const out = await page.evaluate(async () => {
    window.__clearComposer();
    window.__stubKit();
    window.__mountComposer();
    window.__menu = { opened: 0, closed: 0, labels: [], badProps: [] };

    const picked = [];
    let customAsked = 0;
    let can = true;

    const handle = window.api.installScheduleButton({
      canSchedule: () => can,
      onPreset: (id) => picked.push(id),
      onCustom: () => { customAsked += 1; },
    });
    await new Promise((r) => setTimeout(r, 150));

    const button = document.getElementById("Syncord-schedule-button");
    const res = {
      exists: !!button,
      barFound: !!document.querySelector('[class*="channelBottomBarArea"]'),
      sendIconFound: !!document.querySelector('[class*="sendIcon"]'),
      native: handle.native(),
      bodyHtml: document.body.innerHTML.slice(0, 300),
    };
    if (button) {
      res.inBar = !!button.closest('[class*="channelBottomBarArea"]');
      res.borrowsClasses = button.className.includes("button");
      res.hasWrapper = !!button.querySelector('[class*="buttonWrapper"]');
      res.hasIconHolder = !!button.querySelector('[class*="lottieIcon"]');
      res.hasClockPath = !!button.querySelector("svg path");
      res.ariaLabel = button.getAttribute("aria-label");
      res.role = button.getAttribute("role");

      // placed beside the send control, not inside it
      const sendRow = document.querySelector('[class*="sendIcon"]')?.closest('[class*="container"]');
      res.beforeSend = !!sendRow && sendRow.previousElementSibling === button;

      // greyed out when there is nothing to send
      can = false;
      handle.refresh();
      res.disabledAttr = button.getAttribute("aria-disabled");
      res.disabledOpacity = button.style.opacity;
      can = true;
      handle.refresh();
      res.enabledAttr = button.getAttribute("aria-disabled");

      if (!button) return res;
      window.__realClick(button);
      await new Promise((r) => setTimeout(r, 60));
      res.opened = window.__menu.opened;
      res.labels = [...window.__menu.labels];
      res.badProps = [...new Set(window.__menu.badProps)];
      res.menuRole = document.getElementById("fake-menu")?.getAttribute("role");
      res.itemRoles = [...document.querySelectorAll("#fake-menu button")].map((b) => b.getAttribute("role"));
      res.expanded = button.getAttribute("aria-expanded");

      res.menuHtml = document.getElementById("fake-menu")?.innerHTML.slice(0, 400) ?? "NO MENU";
      // pick a preset with a full gesture
      const one = [...document.querySelectorAll("#fake-menu button")]
        .find((b) => b.dataset.label === "In 1 minute");
      if (!one) return res;
      window.__realClick(one);
      await new Promise((r) => setTimeout(r, 80));
      res.picked = [...picked];
      res.stillOpen = !!document.getElementById("fake-menu");

      // and the custom row
      const custom = [...document.querySelectorAll("#fake-menu button")]
        .find((b) => /custom/i.test(b.dataset.label));
      window.__realClick(custom);
      await new Promise((r) => setTimeout(r, 80));
      res.customAsked = customAsked;
      res.pickedAfterCustom = [...picked];

      // dismissing resets the button
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
      await new Promise((r) => setTimeout(r, 60));
      res.expandedAfter = button.getAttribute("aria-expanded");

      handle.dispose();
      res.goneAfterDispose = !document.getElementById("Syncord-schedule-button");
    }
    return res;
  });

  assert.equal(out.exists, true, "the button must be created");
  assert.equal(out.inBar, true, "it must live in the chat input bar");
  assert.equal(out.borrowsClasses, true, "it must borrow Discord's button classes");
  assert.equal(out.hasWrapper, true, "and reuse the inner wrapper structure");
  assert.equal(out.hasIconHolder, true, "and the icon holder, for size and colour");
  assert.equal(out.hasClockPath, true, "and draw a clock");
  assert.equal(out.role, "button");
  assert.match(out.ariaLabel ?? "", /schedule/i);
  assert.equal(out.beforeSend, true, "it must sit beside the send control");

  assert.equal(out.disabledAttr, "true", "with nothing to send it reports itself disabled");
  assert.notEqual(out.disabledOpacity, "", "and is visibly dimmed");
  assert.equal(out.enabledAttr, "false", "and comes back when there is something");

  assert.equal(out.opened, 1, "the menu must open through CONTEXT_MENU_OPEN");
  assert.equal(out.menuRole, "menu");
  assert.deepEqual(out.itemRoles, new Array(8).fill("menuitem"),
    "all eight options are plain menu items");
  assert.deepEqual(out.labels, [
    "In 1 minute", "In 5 minutes", "In 15 minutes", "In 30 minutes",
    "In 1 hour", "In 3 hours", "Tomorrow at this time", "Custom date & time",
  ], "exactly the presets that were asked for");
  assert.deepEqual(out.badProps, [], `only real MenuItem props, got ${out.badProps}`);

  assert.deepEqual(out.picked, ["m1"], "picking a preset must reach the plugin");
  assert.deepEqual(out.pickedAfterCustom, ["m1"], "the custom row must not be read as a preset");
  assert.equal(out.customAsked, 1, "the custom row must open the picker");
  assert.equal(out.stillOpen, true, "the menu stays open, as a pick list should");
  assert.equal(out.expandedAfter, "false", "dismissing resets the button");
  assert.equal(out.goneAfterDispose, true, "disposing removes the button");
  assert.deepEqual(errors, [], `no page errors, got: ${errors.join(", ")}`);
  console.log("PASS: the clock button borrows Discord's chrome and drives a native preset menu");

  // ── a button that cannot open must say why ────────────────────────────
  // The exact failure that was reported: the button rendered, and clicking it
  // did nothing at all, with nothing in the console to explain it.
  const inert = await page.evaluate(async () => {
    window.__clearComposer();
    window.__stubKit();
    window.__mountComposer();
    window.__menu = { opened: 0, closed: 0, labels: [], badProps: [] };

    const kit = window.api.kit;
    const saved = { menu: kit.menu, menuItem: kit.menuItem };
    kit.menuItem = undefined;

    const why = [];
    const handle = window.api.installScheduleButton({
      canSchedule: () => true,
      onPreset: () => {},
      onCustom: () => {},
      onUnavailable: (reason) => why.push(reason),
    });
    await new Promise((r) => setTimeout(r, 120));

    const button = document.getElementById("Syncord-schedule-button");
    window.__realClick(button);
    await new Promise((r) => setTimeout(r, 60));
    const out = {
      why: [...why],
      menuOpened: window.__menu.opened,
      expanded: button.getAttribute("aria-expanded"),
      repeat: null,
    };

    // A second click must not repeat the same complaint.
    window.__realClick(button);
    await new Promise((r) => setTimeout(r, 60));
    out.repeat = why.length;

    handle.dispose();
    kit.menu = saved.menu;
    kit.menuItem = saved.menuItem;
    return out;
  });

  assert.equal(inert.menuOpened, 0, "with a missing component nothing may open");
  assert.equal(inert.why.length, 1, `the user must be told, got ${JSON.stringify(inert.why)}`);
  assert.match(
    inert.why[0] ?? "",
    /MenuItem/,
    `the reason must name what is missing, got "${inert.why[0]}"`,
  );
  assert.equal(inert.expanded, "false", "and the button must not claim to be open");
  assert.equal(inert.repeat, 1, "the same reason is not repeated on every click");
  assert.deepEqual(errors, [], `no page errors, got: ${errors.join(", ")}`);
  console.log("PASS: a button that cannot open says which component is missing");

  // ── the custom picker ──────────────────────────────────────────────────
  const pick = await page.evaluate(async () => {
    window.__clearComposer();
    window.__stubKit();
    window.__mountComposer();

    const confirmed = [];
    const cancelled = [];
    const handle = window.api.installSchedulePicker({
      onConfirm: (at) => confirmed.push(at),
      onCancel: () => cancelled.push(true),
    });

    const anchor = document.createElement("div");
    anchor.id = "anchor";
    anchor.style.cssText = "position:fixed;left:400px;top:600px;width:20px;height:20px";
    document.body.appendChild(anchor);
    try {
      handle.open(anchor);
    } catch (e) {
      return { openThrew: String(e && e.stack || e) };
    }
    await new Promise((r) => setTimeout(r, 80));

    const startOfDayMs = (ms) => { const d = new Date(ms); d.setHours(0,0,0,0); return d.getTime(); };
    const host = document.getElementById("Syncord-schedule-picker");
    if (!host) return { noHost: true, isOpen: handle.isOpen() };
    const q = (sel) => host.querySelector(sel);
    const qa = (sel) => [...host.querySelectorAll(sel)];

    const out = { opened: handle.isOpen() && !!host };
    out.role = host.getAttribute("role");
    out.weekdays = qa(".dion-sched-pick-week span").map((n) => n.textContent);
    out.dayCount = qa(".dion-sched-pick-day").length;
    out.todayMarked = qa(".dion-sched-pick-day.is-today").length;
    out.pastDisabled = qa(".dion-sched-pick-day:disabled").length;
    out.selectedDay = qa(".dion-sched-pick-day.is-selected").length;
    out.month = q(".dion-sched-pick-month").textContent;

    // the time is typed as hh:mm
    const field = q('[data-dick="time"]');
    out.timeField = !!field;
    out.timeType = field && field.getAttribute("type");
    out.inputMode = field && field.getAttribute("inputmode");
    out.timeValue = field && field.value;
    out.timePrefilled = /^([01]?\d|2[0-3]):[0-5]\d$/.test(field && field.value);
    // Whether the prefill is actually sendable is covered by noteValid and
    // confirmDisabled below; recomputing it here ignored which day the time
    // belonged to, which is exactly the case that used to break near midnight.
    out.prefillSendable = !q('[data-dick="confirm"]').disabled;
    out.confirmDisabled = q('[data-dick="confirm"]').disabled;
    out.note = q(".dion-sched-pick-note").textContent;
    out.noteValid = !q(".dion-sched-pick-note").classList.contains("is-invalid");

    // navigate a month forward and back
    const before = q(".dion-sched-pick-month").textContent;
    q('[data-dick="next"]').click();
    await new Promise((r) => setTimeout(r, 40));
    const after = q(".dion-sched-pick-month").textContent;
    q('[data-dick="prev"]').click();
    await new Promise((r) => setTimeout(r, 40));
    out.monthMoves = before !== after;
    out.monthReturns = q(".dion-sched-pick-month").textContent === before;

    // Times are derived from the clock: a hard-coded one is a test that passes
    // at 09:00 and fails at 22:00. The minute offsets are chosen so none of them
    // lands on a quarter hour, which is what the field is for.
    const clockAt = (hoursAhead, minute) => {
      const d = new Date(Date.now() + hoursAhead * 3600_000);
      d.setMinutes(minute, 0, 0);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    const arbitrary = clockAt(3, 7);
    const recovered = clockAt(5, 23);
    out.times = { arbitrary, recovered };
    out.times = { arbitrary, recovered };

    // Move to a day that has not happened yet, which is what someone schedules
    // a specific time for. On a future day every hh:mm is legal, so the field's
    // behaviour can be judged on its own.
    const futureDay = qa(".dion-sched-pick-day:not(:disabled)").find((n) => {
      const dayAt = Number(n.getAttribute("data-day"));
      return dayAt > Date.now() - 12 * 3600_000 && !n.classList.contains("is-selected");
    });
    futureDay.click();
    await new Promise((r) => setTimeout(r, 40));
    out.movedToFutureDay = q(".dion-sched-pick-day.is-selected") === futureDay
      || qa(".dion-sched-pick-day.is-selected").length === 1;

    const type = async (value) => {
      const f = q('[data-dick="time"]');
      // Focused first, because that is how it is used: the caret-survival check
      // below is meaningless if nothing was ever focused.
      f.focus();
      f.value = value;
      f.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
      return {
        value: q('[data-dick="time"]').value,
        note: q(".dion-sched-pick-note").textContent,
        invalid: q('[data-dick="time"]').classList.contains("is-invalid"),
        ariaInvalid: q('[data-dick="time"]').getAttribute("aria-invalid"),
        confirmDisabled: q('[data-dick="confirm"]').disabled,
        // the field must survive the update, caret and all
        focused: document.activeElement === q('[data-dick="time"]'),
        stillOpen: handle.isOpen(),
      };
    };

    out.typed = {};
    out.typed.arbitrary = await type(arbitrary);
    out.typed.garbage = await type("99:99");
    out.typed.halfTyped = await type("7:");
    out.typed.empty = await type("");
    out.typed.recovered = await type(recovered);
    out.timeSurvivesDayChange = q('[data-dick="time"]').value;

    out.summary = q(".dion-sched-pick-note").textContent;
    q('[data-dick="confirm"]').click();
    await new Promise((r) => setTimeout(r, 40));
    out.confirmed = confirmed;
    out.closedAfterConfirm = !document.getElementById("Syncord-schedule-picker");
    if (confirmed.length) {
      const when = new Date(confirmed[0]);
      out.confirmedClock =
        String(when.getHours()).padStart(2, "0") + ":" + String(when.getMinutes()).padStart(2, "0");
      out.confirmedInFuture = confirmed[0] > Date.now();
      out.confirmedDayOffset = Math.round(
        (when.getTime() - when.getTime() + startOfDayMs(confirmed[0]) - startOfDayMs(Date.now())) / 86400000,
      );
    }

    // ── the rule that has to keep holding ───────────────────────────────
    // A fresh picker, because the one above remembers a future day and a
    // re-open would not be looking at today at all.
    handle.dispose();
    const fresh = window.api.installSchedulePicker({
      onConfirm: (at2) => confirmed.push(at2),
      onCancel: () => cancelled.push(true),
    });
    fresh.open(anchor);
    await new Promise((r) => setTimeout(r, 60));
    const freshHost = document.getElementById("Syncord-schedule-picker");
    const fq = (sel2) => freshHost.querySelector(sel2);
    const fqa = (sel2) => [...freshHost.querySelectorAll(sel2)];

    const typeOn = async (value) => {
      const f = fq('[data-dick="time"]');
      f.focus();
      f.value = value;
      f.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
      return {
        value: fq('[data-dick="time"]').value,
        note: fq(".dion-sched-pick-note").textContent,
        invalid: fq('[data-dick="time"]').classList.contains("is-invalid"),
        ariaInvalid: fq('[data-dick="time"]').getAttribute("aria-invalid"),
        confirmDisabled: fq('[data-dick="confirm"]').disabled,
        focused: document.activeElement === fq('[data-dick="time"]'),
        stillOpen: fresh.isOpen(),
      };
    };

    out.pastPrefillWasValid = /^([01]?\d|2[0-3]):[0-5]\d$/.test(fresh.timeText());
    out.pastPrefillConfirmable = !fq('[data-dick="confirm"]').disabled;
    out.selectedIsToday =
      fq(".dion-sched-pick-day.is-selected") === fq(".dion-sched-pick-day.is-today");
    void fqa;

    // 00:01 today: in the past unless the test runs in the first minute of the
    // day, and too close to now in that case. Either way it must not be sendable.
    out.pastToday = await typeOn("00:01");
    out.pastSendableAnyway = await (async () => {
      const before = confirmed.length;
      fq('[data-dick="confirm"]').click();
      await new Promise((r) => setTimeout(r, 40));
      return confirmed.length > before;
    })();
    // And the picker must still be standing, not dismissed by the refusal.
    out.stillOpenAfterRefusal = fresh.isOpen();

    // A valid time on today must become sendable again.
    const laterToday = new Date(Date.now() + 3 * 3600_000);
    const okTime =
      laterToday.getDate() === new Date().getDate()
        ? `${String(laterToday.getHours()).padStart(2, "0")}:${String(laterToday.getMinutes()).padStart(2, "0")}`
        : "23:59";
    out.okTime = okTime;
    out.recoveredToday = await typeOn(okTime);
    fresh.dispose();
    out.freshStyleGone = !document.getElementById("Syncord-schedule-picker-css");
    out.styleGone = out.freshStyleGone;

    // Escape closes without confirming. A third handle, because the others are
    // spent by now and a disposed one silently does nothing.
    const esc = window.api.installSchedulePicker({
      onConfirm: (at2) => confirmed.push(at2),
      onCancel: () => cancelled.push(true),
    });
    out.beforeEscape = confirmed.length;
    esc.open(anchor);
    await new Promise((r) => setTimeout(r, 40));
    out.openBeforeEscape = esc.isOpen();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
    out.closedOnEscape = !document.getElementById("Syncord-schedule-picker");
    out.confirmedAfterEscape = confirmed.length;
    out.cancelledCount = cancelled.length;

    // dispose removes the style it injected
    esc.dispose();
    handle.dispose();
    out.styleGone = !document.getElementById("Syncord-schedule-picker-css");
    return out;
  });

  assert.equal(pick.opened, true, "the picker must open");
  assert.equal(pick.role, "dialog", "it is a dialog, labelled for assistive tech");
  assert.deepEqual(pick.weekdays, ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]);
  assert.equal(pick.dayCount, 42, "a fixed six-week grid, so it never resizes between months");
  assert.equal(pick.todayMarked, 1, "today is marked");
  assert.ok(pick.pastDisabled > 0, "days already gone are not selectable");
  assert.equal(pick.selectedDay, 1, "one day is chosen");
  assert.equal(pick.timeField, true, "the time is entered in a field");
  assert.equal(pick.timeType, "text", "a text field, not a native time widget");
  assert.equal(pick.inputMode, "numeric", "a numeric keypad on touch");
  assert.equal(pick.timePrefilled, true, "it opens on a valid hh:mm");
  assert.equal(
    pick.prefillSendable,
    true,
    "and on a day and time that agree, so it opens sendable even near midnight",
  );
  assert.equal(pick.noteValid, true, "the note is not in its error state to begin with");
  assert.equal(pick.confirmDisabled, false, "a valid future time can be confirmed");
  assert.equal(pick.monthMoves, true, "the month can be moved forward");
  assert.equal(pick.monthReturns, true, "and back again");

  // The field is the point: any time goes in, not only quarter hours.
  assert.equal(pick.typed.arbitrary.value, pick.times.arbitrary, "an arbitrary time is accepted");
  assert.notEqual(
    Number(pick.times.arbitrary.split(":")[1]) % 15,
    0,
    "the test time is not a quarter hour, so it proves arbitrary times work",
  );
  assert.equal(pick.typed.arbitrary.invalid, false, "and is not flagged");
  assert.equal(pick.typed.arbitrary.confirmDisabled, false, "so it can be confirmed");
  assert.equal(pick.typed.arbitrary.stillOpen, true, "typing does not close the picker");
  assert.equal(
    pick.typed.arbitrary.focused,
    true,
    "the caret must survive, so nobody loses their place while typing",
  );

  assert.equal(pick.typed.garbage.invalid, true, "an impossible time is refused");
  assert.match(pick.typed.garbage.note ?? "", /hh:mm/i, "and the format is spelled out");
  assert.equal(pick.typed.garbage.confirmDisabled, true, "so it cannot be sent");
  assert.equal(pick.typed.halfTyped.invalid, true, "a half-typed time is not accepted yet");
  assert.equal(pick.typed.empty.invalid, true, "an empty field is refused");
  assert.match(pick.typed.empty.note ?? "", /enter a time/i, "and says so");
  assert.equal(pick.typed.recovered.invalid, false, "the field recovers once the time is valid");
  assert.equal(pick.typed.recovered.confirmDisabled, false, "and can be confirmed again");

  assert.equal(
    pick.timeSurvivesDayChange,
    pick.times.recovered,
    "picking a day keeps the typed time",
  );

  // The rule the whole thing exists to keep: a time that has passed is refused.
  assert.equal(pick.pastPrefillWasValid, true, "the picker opened on a valid time");
  assert.equal(pick.pastToday.invalid, true, "a time earlier today is refused");
  assert.equal(pick.pastToday.ariaInvalid, "true", "and is announced as invalid");
  assert.equal(pick.pastToday.confirmDisabled, true, "so it cannot be sent");
  assert.match(
    pick.pastToday.note ?? "",
    /later than now|at least a minute/i,
    "with a reason",
  );
  assert.equal(pick.pastSendableAnyway, false, "clicking confirm must not send it anyway");
  assert.equal(pick.stillOpenAfterRefusal, true, "and the picker stays open to be corrected");
  assert.equal(pick.selectedIsToday, true, "a fresh picker starts on today");
  assert.equal(pick.pastPrefillConfirmable, true, "on a time that is sendable");
  assert.equal(pick.recoveredToday.invalid, false, "a valid time later today is accepted again");
  assert.equal(
    pick.recoveredToday.confirmDisabled,
    false,
    "so the control recovers once the time is legal",
  );

  assert.equal(pick.closedAfterConfirm, true, "confirming closes the picker");
  assert.equal(pick.closedOnEscape, true, "escape closes it");
  assert.equal(pick.openBeforeEscape, true, "the picker was open before Escape");
  assert.equal(
    pick.confirmedAfterEscape,
    pick.beforeEscape,
    "escape does not confirm",
  );
  assert.equal(pick.cancelledCount, 1, "escape is reported as a cancel");
  assert.equal(pick.styleGone, true, "disposing removes the injected style");
  assert.deepEqual(errors, [], `no page errors, got: ${errors.join(", ")}`);

  const shot = path.join(process.cwd(), "scripts/tests/fixtures/scheduled-picker.png");
  await page.evaluate(async () => {
    const h = window.api.installSchedulePicker({ onConfirm() {}, onCancel() {} });
    const a = document.createElement("div");
    a.style.cssText = "position:fixed;left:40px;top:40px;width:20px;height:20px";
    document.body.appendChild(a);
    h.open(a);
    await new Promise((r) => setTimeout(r, 80));
  });
  await page.screenshot({
    path: shot,
    animations: "disabled",
    clip: { x: 20, y: 20, width: 340, height: 460 },
  });

  console.log("PASS: the picker takes any hh:mm, refuses a time that has passed, and keeps the caret");
  console.log("PASS: the confirmed time is exactly the one that was entered");
  console.log(`screenshot: ${shot}`);
} finally {
  await browser.close();
}
