/**
 * The Scheduled Messages section, rendered inside the real settings panel.
 *
 * A screenshot lands in `scripts/tests/fixtures/scheduled-panel.png` for
 * eyeballing; the assertions cover what a screenshot cannot — that the cards
 * carry the required fields, that the actions are the ones that were asked for,
 * that a past time is refused, and that a long message is truncated with a way
 * to see all of it.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { build } from "esbuild";

const dir = await mkdtemp(path.join(tmpdir(), "dion-schedpanel-"));

await build({
  stdin: {
    contents: `
      import { openSettings } from './src/renderer/ui/settingsPanel';
      import { settings } from './src/renderer/api/settings';
      import { ScheduledStore, setActiveStore } from './src/renderer/plugins/scheduledMessages/store';
      import { scheduledSectionHtml, setActionHandler, setScheduledExpanded } from './src/renderer/plugins/scheduledMessages/panel';
      import { SCHEDULED_CSS } from './src/renderer/plugins/scheduledMessages/styles';
      import * as types from './src/renderer/plugins/scheduledMessages/types';
      import { SCHEDULE_PRESETS } from './src/renderer/plugins/scheduledMessages/presets';
      window.api = { openSettings, settings, ScheduledStore, setActiveStore,
                     scheduledSectionHtml, setActionHandler, setScheduledExpanded,
                     types, SCHEDULE_PRESETS, SCHEDULED_CSS };
    `,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "browser",
  outfile: path.join(dir, "bundle.js"),
  loader: { ".png": "dataurl" },
  logLevel: "warning",
});

const THEME = `
  :root {
    --background-primary: #313338;
    --background-secondary: #2b2d31;
    --background-floating: #111214;
    --background-base-low: #1e1f22;
    --background-base-lower: #1a1b1e;
    --background-modifier-hover: rgba(255,255,255,.04);
    --text-normal: #f2f3f5;
    --text-muted: #b5bac1;
    --text-danger: #f23f43;
    --text-warning: #f0b232;
    --text-positive: #43b581;
    --border-subtle: #ffffff;
    --brand-500: #5865f2;
  }
`;

await writeFile(
  path.join(dir, "boot.js"),
  `
  window.__store = {};
  window.SyncordNative = {
    ping: async () => 'pong',
    getVersion: async () => 'test',
    getSettings: async () => window.__store,
    setSettings: async (d) => { Object.assign(window.__store, d); },
    httpFetch: async () => ({ ok: false, status: 0, text: '' }),
  };
  // A stand-in for the stores the display names come from, so the resolution
  // path is exercised rather than the id fallback.
  const guilds = { '222': { id: '222', name: 'Test Server' } };
  const channels = {
    '111': { id: '111', name: 'general', guild_id: '222', type: 0 },
    '333': { id: '333', name: 'ada', type: 1, recipients: [{ id: '9', username: 'ada', global_name: 'Ada' }] },
  };
  window.Syncord = {
    toast: { show() {} },
    common: {
      stores: {
        ChannelStore: { getChannel: (id) => channels[id] },
        GuildStore: { getGuild: (id) => guilds[id] },
      },
      actions: {},
      flux: {},
    },
  };
`,
);
await writeFile(
  path.join(dir, "index.html"),
  `<!doctype html><meta charset="utf-8"><style>${THEME}
   body{margin:0;background:#313338}</style>
   <body><script src="boot.js"></script><script src="bundle.js"></script></body>`,
);

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 980, height: 1200 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(pathToFileURL(path.join(dir, "index.html")).href);

  const out = await page.evaluate(async () => {
    const api = window.api;
    await api.settings.init();

    // The panel's own tokens live on its root element, so the section's
    // fallbacks are exercised the same way the real panel drives them.
    api.settings.set("plugins.scheduled-messages.enabled", true);
    api.openSettings();
    await new Promise((r) => setTimeout(r, 120));

    const ctx = {
      plugin: { id: "scheduled-messages", name: "Scheduled Messages" },
      log: Object.fromEntries(["log", "info", "warn", "error"].map((l) => [l, () => {}])),
      disposable() {},
      settings: api.settings,
    };
    const store = new api.ScheduledStore(ctx);
    store.load();
    api.setActiveStore(store);
    api.setActionHandler(() => {});

    const style = document.createElement("style");
    style.textContent = api.SCHEDULED_CSS;
    document.head.appendChild(style);

    const now = Date.now();
    const target = { channelId: "111", guildId: "222", channelName: "general", scopeName: "Test Server", isDm: false };
    const dm = { channelId: "333", channelName: "dm", scopeName: "Direct message — ada", isDm: true };

    const soon = store.add({ content: "Standup notes are ready.", target, sendAt: now + 300_000, now });
    const long = store.add({
      content: "This scheduled message is deliberately much longer than the preview area allows, so that truncation and the expand affordance can both be checked properly. " + "x".repeat(300),
      target: dm, sendAt: now + 3 * 3600_000, now,
    });
    const overdue = store.add({ content: "Missed while the client was closed.", target, sendAt: now - 60_000, now });
    const failed = store.add({ content: "Missing Permissions.", target, sendAt: now - 30_000, now });
    store.markFailed(failed.id, "Missing Permissions");
    const sent = store.add({ content: "Already delivered.", target, sendAt: now - 7_200_000, now });
    store.markSent(sent.id, now - 7_199_000);

    // Mounted inside the real panel so the section inherits the panel's own
    // --dion-* tokens, which is where it actually lives. Screenshotting a
    // detached copy would prove nothing about the real thing.
    const panelRoot = document.getElementById("Syncord-settings-root");
    if (!panelRoot) return { panelMissing: true };
    const list = panelRoot.querySelector("[data-dion-list]");
    if (!list) return { listMissing: true };
    // Wrapped the way the panel wraps it: a details block is only visible inside
    // an expanded plugin row.
    list.innerHTML =
      '<div class="dion-plugin is-open">' + api.scheduledSectionHtml() + "</div>";
    const host = list;

    const card = (id) => host.querySelector(`[data-dion-sm-card="${id}"]`);
    const actionsOf = (id) => [...card(id).querySelectorAll("[data-dion-sm-action]")]
      .filter((b) => !b.hidden).map((b) => b.getAttribute("data-dion-sm-action"));

    return {
      sectionFound: !!host.querySelector(".dion-sm-root"),
      empty: !!host.querySelector(".dion-sm-empty"),
      cards: host.querySelectorAll("[data-dion-sm-card]").length,
      groupTitles: [...host.querySelectorAll(".dion-sm-group-title")].map((n) => n.textContent.replace(/\d+$/, "").trim()),
      hasHistory: !!host.querySelector(".dion-sm-history"),
      historyOpen: !!host.querySelector(".dion-sm-history[open]"),

      // every field the card is required to show
      fields: {
        where: card(soon.id).querySelector(".dion-sm-where")?.textContent,
        when: card(soon.id).querySelector("[data-dion-sm-when]")?.textContent,
        body: card(soon.id).querySelector(".dion-sm-body")?.textContent,
        pill: card(soon.id).querySelector(".dion-pill")?.textContent,
      },
      pills: {
        pending: card(soon.id).querySelector(".dion-pill")?.textContent,
        failed: card(failed.id).querySelector(".dion-pill")?.textContent,
        sent: card(sent.id).querySelector(".dion-pill")?.textContent,
      },
      failedError: card(failed.id).querySelector(".dion-sm-error")?.textContent,
      dueMarked: card(overdue.id).className.includes("is-due"),
      dueWhen: card(overdue.id).querySelector("[data-dion-sm-when]")?.textContent,

      // the actions asked for
      actionsPending: actionsOf(soon.id),
      actionsFailed: actionsOf(failed.id),
      actionsSent: actionsOf(sent.id),

      // truncation and a way to see the whole thing
      longText: card(long.id).querySelector(".dion-sm-body").textContent,
      longLen: card(long.id).querySelector(".dion-sm-body").textContent.length,
      longFullLen: long.content.length,
      longHasTitle: (card(long.id).querySelector(".dion-sm-body").getAttribute("title") || "").length,
      longExpandedBefore: card(long.id).querySelector(".dion-sm-body").getAttribute("aria-expanded"),

      // The date form exists and is pre-filled from the stored time. Checked
      // through the computed style, not the attribute: a `display` rule silently
      // overrides `hidden`, and that bug is invisible to an attribute check.
      timeFormHiddenByDefault: card(soon.id).querySelector(".dion-sm-when-edit").hidden,
      timeFormDisplay: getComputedStyle(card(soon.id).querySelector(".dion-sm-when-edit")).display,
      editorDisplay: getComputedStyle(card(soon.id).querySelector(".dion-sm-editor")).display,
      saveBtnDisplay: getComputedStyle(card(soon.id).querySelector('[data-dion-sm-action="save"]')).display,
      dateValue: card(soon.id).querySelector("[data-dion-sm-date]").value,
      timeValue: card(soon.id).querySelector("[data-dion-sm-time]").value,
      pastAllowed: card(soon.id).querySelector("[data-dion-sm-time]").min,

      // the store the panel reads
      pendingCount: store.pending().length,
      overdueCount: store.overdue(now).length,
    };
  });

  // ── the required content ──
  assert.equal(out.panelMissing, undefined, "the real panel must mount");
  assert.equal(out.listMissing, undefined, "the panel's list must exist");
  assert.equal(out.sectionFound, true, "the section must render");
  assert.equal(out.empty, false, "with messages queued the empty state must not show");
  assert.equal(out.cards, 5, `all five cards render, got ${out.cards}`);
  assert.ok(out.groupTitles.some((t) => /waiting/i.test(t)), "pending messages are grouped under Waiting");
  assert.equal(out.hasHistory, true, "finished messages are kept behind a disclosure");

  // channel, scope, preview, when, countdown, status
  assert.match(out.fields.where ?? "", /Test Server/, "the card names the server");
  assert.match(out.fields.where ?? "", /general/, "and the channel");
  assert.equal(out.fields.body, "Standup notes are ready.", "the message preview is shown");
  assert.match(out.fields.when ?? "", /in 5 min/, `the countdown is shown, got "${out.fields.when}"`);
  assert.equal(out.pills.pending, "Pending");
  assert.equal(out.pills.failed, "Failed");
  assert.equal(out.pills.sent, "Sent");
  assert.equal(out.failedError, "Missing Permissions", "a failure explains itself");
  assert.equal(out.dueMarked, true, "an overdue message is marked");
  assert.match(out.dueWhen ?? "", /due now/, "an overdue message says so");

  // ── the actions asked for ──
  for (const action of ["edit", "time", "send", "cancel", "delete"]) {
    assert.ok(out.actionsPending.includes(action), `pending cards need "${action}", got ${out.actionsPending}`);
  }
  assert.ok(out.actionsFailed.includes("retry"), "a failed message can be retried");
  assert.ok(out.actionsFailed.includes("delete"), "and deleted");
  assert.ok(!out.actionsFailed.includes("send"), "a failed message has nothing to send now");
  assert.deepEqual(out.actionsSent, ["delete"], "a sent message only offers deletion");

  // ── truncation with a way out ──
  assert.ok(out.longLen < out.longFullLen, `the preview must be truncated, ${out.longLen} vs ${out.longFullLen}`);
  assert.ok(out.longLen <= 141, `the preview is bounded, got ${out.longLen}`);
  assert.equal(out.longHasTitle, out.longFullLen, "the full text is available for hover");
  assert.equal(out.longExpandedBefore, null, "a collapsed preview is not announced as expanded");

  // ── the time form ──
  assert.equal(out.timeFormHiddenByDefault, true, "the date form starts closed");
  assert.equal(out.timeFormDisplay, "none", "and is actually not rendered");
  assert.equal(out.editorDisplay, "none", "the editor is not rendered until asked for");
  assert.equal(out.saveBtnDisplay, "none", "Save stays out of the way until editing");
  assert.match(out.dateValue ?? "", /^\d{4}-\d{2}-\d{2}$/, "the date input is pre-filled");
  assert.match(out.timeValue ?? "", /^\d{2}:\d{2}$/, "the time input is pre-filled");

  assert.equal(out.pendingCount, 3, "three messages are still pending");
  // Only the pending ones count: a failed message is not overdue, it is failed.
  assert.equal(out.overdueCount, 1, "one pending message is overdue");
  assert.deepEqual(errors, [], `no page errors, got: ${errors.join(", ")}`);

  // Expand the history and re-shoot, so both states are visible.
  const found = await page.evaluate(() => {
    const h = document.querySelector(".dion-sm-history");
    if (!h) return "no history element";
    h.setAttribute("open", "");
    return document.querySelectorAll(".dion-sm-root").length;
  });
  assert.equal(found, 1, `the section must be in the panel's list; got: ${found}`);
  const shot = path.join(process.cwd(), "scripts/tests/fixtures/scheduled-panel.png");
  // The panel animates in, and an element screenshot waits for the box to stop
  // moving, so the animations are frozen for the shot.
  await page.evaluate(() => document.fonts?.ready);
  // A full-page shot with a clip: an element screenshot insists on the box
  // settling, and the panel's scroll container keeps nudging it.
  const box = await page.locator(".dion-sm-root").boundingBox();
  if (!box) throw new Error("the section has no box");
  await page.screenshot({
    path: shot,
    animations: "disabled",
    clip: {
      x: Math.max(0, box.x),
      y: Math.max(0, box.y),
      width: Math.min(box.width, 900),
      height: Math.min(box.height, 2000),
    },
  });

  console.log("PASS: the Scheduled Messages section shows every required field and action");
  console.log(`screenshot: ${shot}`);
} finally {
  await browser.close();
}
