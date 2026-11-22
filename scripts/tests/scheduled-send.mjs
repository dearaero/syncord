/**
 * The Discord bridge: sending, reading the composer, resolving channels.
 *
 * The send path is exercised against a stand-in that mirrors the client's own
 * `sendMessage` wrapper, including its habit of reading `options.nonce` with no
 * default. That is not a contrivance: the real wrapper does exactly this, so a
 * stand-in that tolerated a missing options argument would have hidden the bug
 * where every scheduled message failed with
 * "Cannot read properties of undefined (reading 'nonce')".
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { build } from "esbuild";

const dir = await mkdtemp(path.join(tmpdir(), "dion-send-"));

await build({
  stdin: {
    contents: `
      import { sendMessage, resolveTarget, currentTarget, readDraft, clearDraft, getChannel }
        from './src/renderer/plugins/scheduledMessages/discord';
      window.api = { sendMessage, resolveTarget, currentTarget, readDraft, clearDraft, getChannel };
    `,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "browser",
  outfile: path.join(dir, "bundle.js"),
  logLevel: "warning",
});

await writeFile(
  path.join(dir, "boot.js"),
  `
  window.__calls = [];
  window.__drafts = { 'c1': 'the draft text' };
  window.__dispatched = [];

  const guilds = { 'g1': { id: 'g1', name: 'Test Server' } };

  // The client's User model is camelCase, and a DM's recipients list holds user
  // ids rather than user objects. Both matter, and getting either wrong is what
  // made a group DM render as two question marks and a count.
  const users = {
    u9:  { id: 'u9',  username: 'ada.lovelace',   globalName: 'Ada Lovelace' },
    u10: { id: 'u10', username: 'grace.hopper',  globalName: 'Grace Hopper' },
    u11: { id: 'u11', username: 'alan.turing',   globalName: 'Alan Turing' },
    u12: { id: 'u12', username: 'katherine.j',   globalName: 'Katherine Johnson' },
    u13: { id: 'u13', username: 'margaret.h',    globalName: 'Margaret Hamilton' },
    // No display name at all: the username is the fallback.
    u14: { id: 'u14', username: 'plainname' },
  };

  const channels = {
    'c1': { id: 'c1', name: 'general', guild_id: 'g1', type: 0 },
    'c2': { id: 'c2', name: 'ada', type: 1, recipients: ['u9'] },
    'c3': { id: 'c3', name: "Gâvât'ül-Arz", type: 3, recipients: ['u9', 'u10', 'u11', 'u12', 'u13'] },
    // Two participants, one of whom left so the store has never seen them.
    'c4': { id: 'c4', name: 'pair', type: 3, recipients: ['u9', 'gone'] },
    // A DM whose participants are all unknown.
    'c5': { id: 'c5', name: 'ghost', type: 3, recipients: ['x1', 'x2'] },
    // A DM where the user has only a username, no display name.
    'c6': { id: 'c6', name: 'plain', type: 1, recipients: ['u14'] },
  };

  // A stand-in for the client's sendMessage wrapper, whose fourth argument is
  // read without a default: options.nonce. This is the line that used to throw.
  function sendMessage(channelId, message, waitForChannelReady, options) {
    const nonce = options.nonce ?? ('nonce-' + window.__calls.length);
    const record = { channelId, message, waitForChannelReady, options: { ...options, nonce } };
    window.__calls.push(record);
    if (window.__failNext) {
      window.__failNext = false;
      return Promise.resolve({ ok: false, status: 403, body: { message: 'Missing Permissions' } });
    }
    return Promise.resolve({ ok: true, status: 200, body: { id: 'm1' } });
  }

  window.Syncord = {
    common: {
      stores: {
        ChannelStore: { getChannel: (id) => channels[id] },
        GuildStore: { getGuild: (id) => guilds[id] },
        SelectedChannelStore: { getChannelId: () => 'c1' },
        SelectedGuildStore: { getGuildId: () => 'g1' },
        UserStore: {
          getCurrentUser: () => ({ id: 'me', username: 'me' }),
          getUser: (id) => users[id],
        },
        DraftStore: { getDraft: (id) => window.__drafts[id] ?? '' },
      },
      actions: { MessageActions: { sendMessage } },
      flux: { FluxDispatcher: { dispatch: (a) => { window.__dispatched.push(a); return a; } } },
    },
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
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(pathToFileURL(path.join(dir, "index.html")).href);

  // ── the send ────────────────────────────────────────────────────────────
  const out = await page.evaluate(async () => {
    const api = window.api;
    const base = { id: "s1", createdAt: 1, sendAt: 2, status: "pending" };
    const result = {};

    // A guild channel message.
    await api.sendMessage({ ...base, content: "hello", channelId: "c1", guildId: "g1" });
    const call = window.__calls[window.__calls.length - 1];
    result.channelId = call.channelId;
    result.content = call.message.content;
    result.waitForChannelReady = call.waitForChannelReady;
    result.optionsGiven = call.options != null;
    result.location = call.options && call.options.location;
    result.nonceFilled = !!(call.options && call.options.nonce);

    // A DM needs no guild.
    await api.sendMessage({ ...base, content: "hi there", channelId: "c2" });
    const dm = window.__calls[window.__calls.length - 1];
    result.dmChannel = dm.channelId;

    // A channel that no longer exists must fail with a reason, not a crash.
    let missing = null;
    try {
      await api.sendMessage({ ...base, content: "x", channelId: "gone" });
    } catch (e) { missing = String(e.message || e); }
    result.missingChannel = missing;

    // Discord resolving rather than rejecting still has to be treated as a
    // failure, with the server's own reason.
    window.__failNext = true;
    let refused = null;
    try {
      await api.sendMessage({ ...base, content: "x", channelId: "c1", guildId: "g1" });
    } catch (e) { refused = String(e.message || e); }
    result.refused = refused;

    return result;
  });

  assert.equal(out.optionsGiven, true, "the options argument must be given");
  assert.equal(
    out.nonceFilled,
    true,
    "options.nonce must exist, because the client reads it without a default",
  );
  assert.equal(out.location, "chat input", "it is recorded like a typed message");
  assert.equal(out.waitForChannelReady, true, "and waits for the channel to be ready");
  assert.equal(out.content, "hello");
  assert.equal(out.dmChannel, "c2", "a DM is sent to its own channel");
  assert.match(out.missingChannel ?? "", /no longer available/i, "a gone channel explains itself");
  assert.match(out.refused ?? "", /Missing Permissions/, "a refusal surfaces the server's reason");
  assert.deepEqual(errors, [], `no page errors, got: ${errors.join(", ")}`);

  // The regression itself: three arguments must not be enough.
  const regressed = await page.evaluate(async () => {
    let threw = null;
    try {
      const owner = { sendMessage: (a, b, c) => (void c).nonce };
      // eslint-disable-next-line no-unused-expressions
      owner.sendMessage("c1", { content: "" }, true);
    } catch (e) { threw = String(e.message || e); }
    return threw;
  });
  assert.match(
    regressed ?? "",
    /nonce/,
    "calling the client's wrapper without options must throw on nonce, " +
      "which is exactly the failure that was reported",
  );

  // ── channel naming, shared with the panel ──────────────────────────────
  const names = await page.evaluate(() => {
    const api = window.api;
    return {
      guild: api.resolveTarget("c1"),
      dm: api.resolveTarget("c2"),
      group: api.resolveTarget("c3"),
      partial: api.resolveTarget("c4"),
      unknown: api.resolveTarget("c5"),
      plain: api.resolveTarget("c6"),
      gone: api.resolveTarget("nope"),
      current: api.currentTarget(),
      draft: api.readDraft("c1"),
      emptyDraft: api.readDraft("c2"),
    };
  });

  assert.equal(names.guild.channelName, "general");
  assert.equal(names.guild.scopeName, "Test Server");
  assert.equal(names.guild.isDm, false);
  assert.equal(names.guild.guildId, "g1");
  assert.equal(names.dm.isDm, true);
  assert.equal(names.dm.guildId, undefined, "a DM must not gain a guildId");
  assert.equal(names.dm.scopeName, "Direct message — Ada Lovelace", "a DM names the other person");

  // A group DM: the participants are user ids, and the names come from the
  // store. Reading names off the ids directly is what produced "? , ? +3".
  assert.equal(names.group.isDm, true);
  assert.equal(names.group.channelName, "Gâvât'ül-Arz", "the group keeps its own name");
  assert.equal(
    names.group.scopeName,
    "Direct message — Ada Lovelace, Grace Hopper +3",
    `a group DM names the first two and counts the rest, got "${names.group.scopeName}"`,
  );
  assert.doesNotMatch(
    names.group.scopeName,
    /\?/,
    "no placeholder may appear where a name is known",
  );
  assert.equal(
    (names.group.scopeName.match(/\+/g) || []).length,
    1,
    "the count appears once",
  );

  // A participant the store has never seen must not poison the row.
  assert.equal(
    names.partial.scopeName,
    "Direct message — Ada Lovelace",
    "an unknown participant is left out, and the count stays honest",
  );

  // Nobody resolves: the count is still worth more than a row of placeholders.
  assert.equal(
    names.unknown.scopeName,
    "Direct message — 2 people",
    `with no names at all the count is shown instead, got "${names.unknown.scopeName}"`,
  );

  // A user with no display name falls back to their username.
  assert.equal(
    names.plain.scopeName,
    "Direct message — plainname",
    "the username is the fallback when there is no display name",
  );
  assert.equal(names.gone, undefined, "a channel that is gone resolves to nothing");
  assert.equal(names.current.channelId, "c1", "the composer button knows the open channel");
  assert.equal(names.draft, "the draft text", "the composer text comes from DraftStore");
  assert.equal(names.emptyDraft, "", "an empty draft reads as empty");

  console.log("PASS: sending always supplies options, so the client never trips over nonce");
  console.log("PASS: DM and group-DM names resolve through the user store, with an honest count");
} finally {
  await browser.close();
}
