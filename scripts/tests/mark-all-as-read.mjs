/**
 * The Mark All As Read feature, without a client.
 *
 * Three things in this plugin are worth asserting offline, and all three are
 * decisions rather than rendering:
 *
 *  - `findDmHome` picks the Direct Messages button and nothing else, out of the
 *    rail, the DM channel list and a server pill. A stub cannot prove the
 *    button exists in Discord; it can prove that *if* a build marks the button
 *    the way any of the three signals says it does, the right element is the one
 *    that answers, and an unrelated gesture still returns nothing.
 *  - `planTargets` chooses which servers and DMs get acknowledged, including the
 *    case where the client cannot say what is unread.
 *  - `markAllAsRead` resolves an acknowledgement, acks every target, and reports
 *    honestly when it cannot.
 *
 * What this cannot cover is the menu that opens: that is Discord's own `Menu`
 * and `MenuItem` in a live client. See the live checklist in the plugin's
 * description.
 *
 * Usage: node --test scripts/tests/mark-all-as-read.mjs
 */
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const dir = await mkdtemp(path.join(tmpdir(), "dion-mark-read-"));

/** @type {any} */
let mod;

before(async () => {
  await build({
    stdin: {
      contents: `
        export { planTargets } from './src/renderer/plugins/markAllAsRead/targets';
        export { ackChannels, markAllAsRead, resetAckDiscovery } from './src/renderer/plugins/markAllAsRead/readState';
        export { findDmHome } from './src/renderer/plugins/markAllAsRead/menu';
      `,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    platform: "browser",
    format: "esm",
    outfile: path.join(dir, "bundle.mjs"),
  });
  mod = await import(pathToFileURL(path.join(dir, "bundle.mjs")).href);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ── a DOM just large enough for findDmHome ──────────────────────────────────

/** The smallest thing that behaves like an element for the walk. */
class FakeElement {
  constructor(attrs = {}, parent = null) {
    this.attrs = attrs;
    this.parentElement = parent;
    this.children = [];
    if (parent) parent.children.push(this);
  }
  getAttribute(name) {
    return name in this.attrs ? this.attrs[name] : null;
  }
}

globalThis.Element = FakeElement;
globalThis.Node = FakeElement;

function el(attrs, parent = null) {
  return new FakeElement(attrs, parent);
}

/**
 * The rail, built the way the real one is.
 *
 * The shape and the attributes are taken from the client markup this plugin
 * runs against, trimmed to the elements the walk can see. The parts that matter
 * are the list identifiers: the rail's tree carries `data-list-id="guildsnav"`
 * and the Direct Messages entry is addressed `guildsnav___home`, while servers
 * are addressed by snowflake and the footer buttons by fixed keys.
 */
function rail() {
  const nav = el({ "aria-label": "Servers sidebar" });
  const tree = el({ role: "tree", "data-list-id": "guildsnav" }, nav);
  const scroller = el({ class: "scroller" }, tree);
  const listItem = el({}, scroller);
  const overlay = el({ "aria-hidden": "true" }, listItem);

  // The Direct Messages button. The client nests the entry *inside* the
  // button's own <svg>/<foreignObject> pair, so a click on the visible icon —
  // or on that <svg> — lands on a descendant of the entry rather than on it,
  // and the walk has to climb out of the icon to reach the entry.
  const pill = el({ class: "listItemWrapper" }, listItem);
  const iconWrapper = el({}, pill);
  const homeSvg = el({ width: "48", height: "48" }, iconWrapper);
  const foreignObject = el({}, homeSvg);
  const home = el(
    {
      role: "treeitem",
      "aria-owns": "guild-list-unread-dms",
      "data-list-item-id": "guildsnav___home",
    },
    foreignObject,
  );
  const homeName = el({ class: "hiddenVisually" }, home);
  const homeChild = el({}, homeName);
  const homeIcon = el({ role: "img" }, homeChild);

  // The hidden group that holds the unread-DM pills. This one is labelled
  // "Direct Messages" as well, which is how an earlier version of this plugin
  // came to open its menu in the wrong place.
  const unreadDms = el(
    { id: "guild-list-unread-dms", role: "group", "aria-label": "Direct Messages", hidden: "" },
    scroller,
  );
  const unreadDmPill = el({ role: "treeitem" }, unreadDms);

  const guildPill = el(
    { role: "treeitem", "data-list-item-id": "guildsnav___1492479714638696639" },
    listItem,
  );
  const addServer = el(
    {
      role: "treeitem",
      "aria-label": "Add a Server",
      "data-list-item-id": "guildsnav___create-join-button",
    },
    scroller,
  );
  const discover = el(
    { role: "treeitem", "data-list-item-id": "guildsnav___guild-discover-button" },
    scroller,
  );
  const folder = el(
    { role: "treeitem", "data-list-item-id": "guildsnav___1" },
    scroller,
  );

  return {
    nav,
    tree,
    scroller,
    home,
    homeIcon,
    homeSvg,
    iconWrapper,
    pill,
    listItem,
    unreadDms,
    unreadDmPill,
    guildPill,
    addServer,
    discover,
    folder,
    overlay,
  };
}

test("findDmHome: the Direct Messages entry is found from whatever was clicked", () => {
  const r = rail();
  assert.equal(mod.findDmHome(r.home), r.home, "the entry itself is the button");
  assert.equal(mod.findDmHome(r.homeIcon), r.home, "the walk must climb to the entry");
  assert.equal(mod.findDmHome(r.overlay), null, "the unread pill is not the button");
});

test("findDmHome: a different list prefix still matches inside the rail", () => {
  // Canary and PTB builds have been seen addressing the same list differently.
  // The suffix is matched instead of the whole id, but only within the rail.
  const nav = el({ "aria-label": "Servers sidebar" });
  const tree = el({ role: "tree", "data-list-id": "guildsnav-canary" }, nav);
  const home = el({ role: "treeitem", "data-list-item-id": "guildsnav-canary___home" }, tree);
  assert.equal(mod.findDmHome(home), home);

  // Outside the rail, the same suffix is somebody else's "home" button and must
  // not open this menu.
  const elsewhere = el({ role: "treeitem", "data-list-item-id": "settings___home" });
  assert.equal(mod.findDmHome(elsewhere), null, "a suffix match is scoped to the rail");
});

test("findDmHome: the unread-DM group is not the Direct Messages button", () => {
  // Regression. The rail holds a second element labelled "Direct Messages" —
  // the hidden group the unread DM pills are rendered into — and matching on
  // the label opened the menu there instead of on the button.
  const r = rail();
  assert.equal(mod.findDmHome(r.unreadDms), null);
  assert.equal(mod.findDmHome(r.unreadDmPill), null);
  assert.equal(r.unreadDms.getAttribute("aria-label"), "Direct Messages",
    "the fixture must keep the label that caused it");
});

test("findDmHome: other rail entries are not the Direct Messages button", () => {
  const r = rail();
  for (const [name, node] of Object.entries({
    guildPill: r.guildPill,
    addServer: r.addServer,
    discover: r.discover,
    folder: r.folder,
  })) {
    assert.equal(mod.findDmHome(node), null, `${name} must not open the menu`);
  }
});

test("findDmHome: the entry is found from the far side of its own button", () => {
  // The client nests the entry inside the button's own <svg>/<foreignObject>
  // pair, so a click on the visible icon — or on that <svg> — is on a
  // descendant of the entry rather than on it. Both must open the menu.
  const r = rail();
  assert.equal(
    r.home.parentElement.parentElement,
    r.homeSvg,
    "the fixture must nest the entry inside the button's svg, as the client does",
  );

  // And the entry is eight levels below the rail, which is what the walk's
  // limit has to clear: a gesture on the button's own edge is further still.
  let up = 0;
  for (let node = r.home; node && node !== r.nav; node = node.parentElement) up++;
  assert.equal(up, 8, `the entry must sit inside the rail, got ${up} hops`);

  // Every level of the button, in both directions.
  assert.equal(mod.findDmHome(r.homeSvg), r.home, "a click on the button's own svg must open the menu");
  assert.equal(mod.findDmHome(r.iconWrapper), r.home, "and so must one on the box around it");
  assert.equal(mod.findDmHome(r.pill), r.home, "and so must one on the list item wrapper");
  assert.equal(mod.findDmHome(r.homeIcon), r.home, "and so must a click on the icon inside it");
});

test("findDmHome: the rail around the button does not open the menu", () => {
  // The line is drawn at the button's own box. One level above it sits the
  // rail's list row, and above that the scroller that holds every server — a
  // right-click on the empty space there must not open this menu, which is the
  // point of matching an identifier rather than a region.
  const r = rail();
  assert.equal(mod.findDmHome(r.listItem), null, "the rail row is not the button");
  assert.equal(mod.findDmHome(r.scroller), null, "nor is the scroller around every server");
});

test("findDmHome: a deep click stops climbing instead of matching the whole page", () => {
  // Past the limit the walk gives up rather than matching something it merely
  // happens to contain.
  let node = el({ role: "treeitem", "data-list-item-id": "guildsnav___home" });
  for (let i = 0; i < 20; i++) node = el({}, node);
  assert.equal(mod.findDmHome(node), null);
});

test("findDmHome: no event target is not a match", () => {
  assert.equal(mod.findDmHome(null), null);
  assert.equal(mod.findDmHome({}), null);
});

// ── target planning ─────────────────────────────────────────────────────────

const guilds = [
  { id: "g1", channels: ["c1", "c2"] },
  { id: "g2", channels: ["c3"] },
];

test("planTargets: a read server is left alone entirely", () => {
  const plan = mod.planTargets(
    guilds,
    ["dm1", "dm2"],
    {
      isGuildUnread: (id) => id === "g1",
      isChannelUnread: (id) => id === "dm1",
    },
    { guildAck: true },
  );
  assert.deepEqual(plan.guilds, ["g1"]);
  assert.deepEqual(plan.channels, ["dm1"]);
  assert.equal(plan.assumedUnread, false);
});

test("planTargets: without a server ack, the server's channels are taken", () => {
  const plan = mod.planTargets(
    guilds,
    ["dm1"],
    { isGuildUnread: (id) => id === "g1", isChannelUnread: () => true },
    { guildAck: false },
  );
  assert.deepEqual(plan.guilds, []);
  assert.deepEqual(plan.channels, ["c1", "c2", "dm1"]);
});

test("planTargets: an unread check that cannot answer never skips a target", () => {
  // undefined, null and a throwing store all mean "unknown", and unknown is
  // never "read": a server that was unread has to be acknowledged.
  const plan = mod.planTargets(
    guilds,
    ["dm1"],
    {
      isGuildUnread: () => undefined,
      isChannelUnread: () => undefined,
    },
    { guildAck: true },
  );
  assert.deepEqual(plan.guilds, ["g1", "g2"]);
  assert.deepEqual(plan.channels, ["dm1"]);
  assert.equal(plan.assumedUnread, false, "the check ran, it just could not answer");
});

test("planTargets: a missing unread check is recorded, and takes everything", () => {
  const plan = mod.planTargets(guilds, ["dm1"], {}, { guildAck: true });
  assert.deepEqual(plan.guilds, ["g1", "g2"]);
  assert.deepEqual(plan.channels, ["dm1"]);
  assert.equal(plan.assumedUnread, true);
});

test("planTargets: a channel is never acknowledged twice", () => {
  const plan = mod.planTargets(
    [
      { id: "g1", channels: ["c1"] },
      { id: "g2", channels: ["c1", "c2"] },
    ],
    ["c1", "dm1"],
    { isGuildUnread: () => true, isChannelUnread: () => true },
    { guildAck: false },
  );
  assert.deepEqual(plan.channels, ["c1", "c2", "dm1"]);
});

// ── the whole operation, against stub stores ────────────────────────────────

/**
 * A client-shaped `window.Syncord`.
 *
 * `common` is filled the way the boot sequence fills it; `webpack` is consulted
 * only when a store is missing, which is what makes the action-module fallback
 * and the module sweep reachable. `modules` becomes the client's module cache,
 * with `loaded: true` marking the factories that have run — the sweep is not
 * allowed to look at anything else.
 */
function client({ stores = {}, flux, findByProps, findByStoreName, modules } = {}) {
  // The legacy acknowledgement fallback is cached for the life of the client,
  // so a new stub client means a new cache.
  mod.resetAckDiscovery();
  const cache = {};
  for (const [id, exports] of Object.entries(modules ?? {})) {
    cache[id] = { id, loaded: true, exports };
  }
  globalThis.window = {
    Syncord: {
      common: { stores, flux: flux ?? {} },
      webpack: {
        findByProps: findByProps ?? (() => undefined),
        findByStoreName: findByStoreName ?? (() => undefined),
        getRequire: () => (modules ? { c: cache, m: {}, p: "" } : undefined),
      },
    },
  };
}

const CHANNELS = {
  c1: { id: "c1", type: 0, guild_id: "g1" },
  c2: { id: "c2", type: 0, guild_id: "g1" },
  c3: { id: "c3", type: 0, guild_id: "g2" },
  t1: { id: "t1", type: 11, guild_id: "g1" }, // thread
  dm1: { id: "dm1", type: 1 },
  gdm1: { id: "gdm1", type: 3 },
};

const GUILDS = { g1: { id: "g1" }, g2: { id: "g2" } };


test("markAllAsRead v1.1: dispatches Discord's BULK_ACK action for guilds, threads and DMs", () => {
  const actions = [];
  const unread = new Set(["c1", "t1", "dm1", "gdm1"]);

  client({
    stores: {
      GuildStore: { getGuilds: () => GUILDS },
      GuildChannelStore: {
        getChannels: (guildId) =>
          guildId === "g1"
            ? {
                SELECTABLE: [{ channel: CHANNELS.c1 }, { channel: CHANNELS.c2 }],
                VOCAL: [],
              }
            : {
                SELECTABLE: [{ channel: CHANNELS.c3 }],
                VOCAL: [],
              },
      },
      ActiveJoinedThreadsStore: {
        getActiveJoinedThreadsForGuild: (guildId) =>
          guildId === "g1" ? { c1: { t1: { channel: CHANNELS.t1 } } } : {},
      },
      ChannelStore: {
        getMutablePrivateChannels: () => ({
          dm1: CHANNELS.dm1,
          gdm1: CHANNELS.gdm1,
        }),
      },
      ReadStateStore: {
        hasUnread: (id) => unread.has(id),
        lastMessageId: (id) => `m-${id}`,
        // Decoys: v1 discovered ack-looking methods by name. v1.1 must not use
        // them while the explicit current-client BULK_ACK path is available.
        acknowledgeChannel: () => {
          throw new Error("wrong ack path");
        },
        acknowledgeGuild: () => {
          throw new Error("wrong ack path");
        },
      },
    },
    flux: {
      FluxDispatcher: {
        dispatch: (action) => actions.push(action),
      },
    },
  });

  const out = mod.markAllAsRead();
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, "BULK_ACK");
  assert.equal(actions[0].context, "APP");
  assert.deepEqual(
    actions[0].channels,
    [
      { channelId: "c1", messageId: "m-c1", readStateType: 0 },
      { channelId: "t1", messageId: "m-t1", readStateType: 0 },
      { channelId: "dm1", messageId: "m-dm1", readStateType: 0 },
      { channelId: "gdm1", messageId: "m-gdm1", readStateType: 0 },
    ],
  );
  assert.equal(out.ok, true);
  assert.equal(out.guilds, 1);
  assert.equal(out.channels, 2);
  assert.match(out.detail, /FluxDispatcher BULK_ACK/);
});

test("markAllAsRead v1.1: false unread probes cannot veto BULK_ACK", () => {
  const actions = [];

  client({
    stores: {
      GuildStore: { getGuilds: () => ({ g1: GUILDS.g1 }) },
      GuildChannelStore: {
        getChannels: () => ({
          SELECTABLE: [{ channel: CHANNELS.c1 }],
          VOCAL: [],
        }),
      },
      ActiveJoinedThreadsStore: {
        getActiveJoinedThreadsForGuild: () => ({}),
      },
      ChannelStore: {
        getMutablePrivateChannels: () => ({ dm1: CHANNELS.dm1 }),
      },
      ReadStateStore: {
        // This is the exact silent-failure class v1 hit: every advisory unread
        // check says "read" even though the UI can still show badges.
        hasUnread: () => false,
        lastMessageId: (id) => `m-${id}`,
      },
    },
    flux: {
      FluxDispatcher: {
        dispatch: (action) => actions.push(action),
      },
    },
  });

  const out = mod.markAllAsRead();
  assert.equal(actions.length, 1, "the run is not vetoed by a false unread probe");
  assert.deepEqual(actions[0].channels, [
    { channelId: "c1", messageId: "m-c1", readStateType: 0 },
    { channelId: "dm1", messageId: "m-dm1", readStateType: 0 },
  ]);
  assert.equal(out.ok, true);
});

test("markAllAsRead v1.1: falls back to legacy ack discovery only when BULK_ACK prerequisites are missing", () => {
  const dispatched = [];
  const legacy = [];

  client({
    stores: {
      GuildStore: { getGuilds: () => ({}) },
      ChannelStore: { getChannels: () => ({ dm1: CHANNELS.dm1 }) },
      ReadStateStore: {
        isChannelUnread: () => true,
        acknowledgeChannel: (id) => legacy.push(id),
        // No lastMessageId -> current BULK_ACK path is intentionally unavailable.
      },
    },
    flux: {
      FluxDispatcher: {
        dispatch: (action) => dispatched.push(action),
      },
    },
  });

  const out = mod.markAllAsRead();
  assert.deepEqual(dispatched, []);
  assert.deepEqual(legacy, ["dm1"]);
  assert.equal(out.ok, true);
});

test("markAllAsRead: acks the server and the DMs, and counts them", () => {
  const guilds = [];
  const channels = [];
  client({
    stores: {
      GuildStore: { getGuilds: () => GUILDS },
      ChannelStore: { getChannels: () => CHANNELS },
      ReadStateStore: {
        isGuildUnread: (id) => id === "g1",
        isChannelUnread: (id) => id !== "gdm1",
        acknowledgeGuild: (id) => guilds.push(id),
        acknowledgeChannel: (id) => channels.push(id),
      },
    },
  });

  const out = mod.markAllAsRead();
  assert.deepEqual(guilds, ["g1"], "only the unread server is acked, as a whole");
  assert.deepEqual(channels, ["dm1"], "the unread DM is acked, the read one is not");
  assert.equal(out.ok, true);
  assert.equal(out.guilds, 1);
  assert.equal(out.channels, 1);
  assert.match(out.detail, /1 server\(s\) and 1 DM\/channel\(s\)/);
});

test("markAllAsRead: threads are left out of a server's channels", () => {
  const channels = [];
  client({
    stores: {
      GuildStore: { getGuilds: () => GUILDS },
      ChannelStore: { getChannels: () => CHANNELS },
      ReadStateStore: {
        isGuildUnread: () => true,
        isChannelUnread: () => false,
        acknowledgeChannel: (id) => channels.push(id),
      },
    },
  });

  const out = mod.markAllAsRead();
  assert.deepEqual(channels, ["c1", "c2", "c3"], "t1 is a thread and keeps its own state");
  assert.equal(out.guilds, 0, "no server ack resolved, so channels stood in");
  assert.equal(out.channels, 3);
});

test("markAllAsRead: falls back to the action module when the store has no ack", () => {
  const channels = [];
  client({
    stores: {
      GuildStore: { getGuilds: () => GUILDS },
      ChannelStore: { getChannels: () => CHANNELS },
      ReadStateStore: { isGuildUnread: () => false, isChannelUnread: () => true },
    },
    findByProps: (name) =>
      name === "acknowledgeChannel"
        ? { acknowledgeChannel: (id) => channels.push(id) }
        : undefined,
  });

  const out = mod.markAllAsRead();
  assert.deepEqual(channels, ["dm1", "gdm1"], "both DMs, via the action module");
  assert.match(out.detail, /acknowledgeChannel/);
});

test("markAllAsRead: finds the acknowledgement by sweeping the loaded modules", () => {
  // The real client is not obliged to name it `acknowledgeChannel`, so the sweep
  // looks for the shape instead: something that acks a channel and something
  // that acks a guild, on the same module.
  const guilds = [];
  const channels = [];
  client({
    stores: {
      GuildStore: { getGuilds: () => GUILDS },
      ChannelStore: { getChannels: () => CHANNELS },
      ReadStateStore: { isGuildUnread: (id) => id === "g1", isChannelUnread: () => false },
    },
    modules: {
      1: { unrelated: () => {} },
      2: { ackReadState: (id) => channels.push(id), ackGuild: (id) => guilds.push(id) },
    },
  });

  const out = mod.markAllAsRead();
  assert.deepEqual(guilds, ["g1"], "the swept-up module acknowledged the server");
  assert.deepEqual(channels, [], "no DM was unread");
  assert.equal(out.ok, true);
});

test("markAllAsRead: a module with only a channel ack is still usable", () => {
  const channels = [];
  client({
    stores: {
      GuildStore: { getGuilds: () => GUILDS },
      ChannelStore: { getChannels: () => CHANNELS },
      ReadStateStore: { isGuildUnread: () => false, isChannelUnread: () => true },
    },
    modules: { 7: { acknowledgeChannel: (id) => channels.push(id) } },
  });

  const out = mod.markAllAsRead();
  assert.deepEqual(channels, ["dm1", "gdm1"]);
  assert.equal(out.ok, true);
});

test("markAllAsRead: a bare ack is not an acknowledgement", () => {
  // Plenty of unrelated modules have a method called `ack`. Taking one on its
  // own would report a success while marking nothing, so it is only accepted
  // from a module that also acknowledges guilds.
  const calls = [];
  client({
    stores: {
      GuildStore: { getGuilds: () => GUILDS },
      ChannelStore: { getChannels: () => CHANNELS },
      ReadStateStore: { isGuildUnread: () => true, isChannelUnread: () => true },
    },
    modules: { 3: { ack: (...args) => calls.push(args) } },
  });

  const out = mod.markAllAsRead();
  assert.equal(out.ok, false, "an unrelated ack must not count as success");
  assert.deepEqual(calls, [], "and must not be called");
});

test("markAllAsRead: a bare ack next to a guild ack is trusted", () => {
  const guilds = [];
  const channels = [];
  client({
    stores: {
      GuildStore: { getGuilds: () => GUILDS },
      ChannelStore: { getChannels: () => CHANNELS },
      ReadStateStore: { isGuildUnread: (id) => id === "g1", isChannelUnread: () => false },
    },
    modules: { 4: { ack: (id) => channels.push(id), acknowledgeGuild: (id) => guilds.push(id) } },
  });

  const out = mod.markAllAsRead();
  assert.deepEqual(guilds, ["g1"], "the pairing is what identifies the module");
  assert.equal(out.ok, true);
});

test("markAllAsRead: modules whose factory has not run are not touched", () => {
  const channels = [];
  client({
    stores: {
      GuildStore: { getGuilds: () => GUILDS },
      ChannelStore: { getChannels: () => CHANNELS },
      ReadStateStore: { isGuildUnread: () => false, isChannelUnread: () => true },
    },
    modules: { 5: { acknowledgeChannel: (id) => channels.push(id) } },
  });
  // Force the only candidate to look unrun, the way webpack records a module
  // that has not executed its factory.
  const cache = window.Syncord.webpack.getRequire().c;
  for (const entry of Object.values(cache)) entry.loaded = false;

  const out = mod.markAllAsRead();
  assert.equal(out.ok, false, "an unrun factory is not a candidate");
  assert.deepEqual(channels, [], "and running it here is exactly what must not happen");
});

test("markAllAsRead: an acknowledgement that loads late is still found", () => {
  // Regression. An earlier sweep stopped after 400 modules and reported "not
  // found" against a client whose cache holds thousands, because the read-state
  // module is not among the first few hundred to load. The ceiling is time now,
  // not a count — so the candidate goes last, past everything else.
  const channels = [];
  const modules = {};
  for (let i = 0; i < 2500; i++) modules[i] = { somethingElse: () => i, channelThing: () => i };
  modules[9999] = { acknowledgeChannel: (id) => channels.push(id) };

  client({
    stores: {
      GuildStore: { getGuilds: () => GUILDS },
      ChannelStore: { getChannels: () => CHANNELS },
      ReadStateStore: { isGuildUnread: () => false, isChannelUnread: () => true },
    },
    modules,
  });

  const out = mod.markAllAsRead();
  assert.deepEqual(channels, ["dm1", "gdm1"], "the late module is the one that acknowledges");
  assert.equal(out.ok, true);
});

test("markAllAsRead: an acknowledgement on a class prototype is found", () => {
  // A module exporting a bare class keeps its methods on the prototype rather
  // than on the export itself.
  const channels = [];
  class ReadStateActions {
    acknowledgeChannel(id) {
      channels.push(id);
    }
  }
  client({
    stores: {
      GuildStore: { getGuilds: () => GUILDS },
      ChannelStore: { getChannels: () => CHANNELS },
      ReadStateStore: { isGuildUnread: () => false, isChannelUnread: () => true },
    },
    modules: { 11: ReadStateActions },
  });

  const out = mod.markAllAsRead();
  assert.deepEqual(channels, ["dm1", "gdm1"]);
  assert.equal(out.ok, true);
});

test("markAllAsRead: an acknowledgement behind a default re-export is found", () => {
  const channels = [];
  client({
    stores: {
      GuildStore: { getGuilds: () => GUILDS },
      ChannelStore: { getChannels: () => CHANNELS },
      ReadStateStore: { isGuildUnread: () => false, isChannelUnread: () => true },
    },
    modules: { 12: { default: { acknowledgeChannel: (id) => channels.push(id) } } },
  });

  const out = mod.markAllAsRead();
  assert.deepEqual(channels, ["dm1", "gdm1"]);
  assert.equal(out.ok, true);
});

test("markAllAsRead: a second call reuses the resolved acknowledgement", () => {
  // The sweep costs a share of a click, so the answer is cached. What matters
  // here is that a second call still acknowledges.
  const channels = [];
  client({
    stores: {
      GuildStore: { getGuilds: () => GUILDS },
      ChannelStore: { getChannels: () => CHANNELS },
      ReadStateStore: { isGuildUnread: () => false, isChannelUnread: () => true },
    },
    modules: { 13: { acknowledgeChannel: (id) => channels.push(id) } },
  });

  assert.equal(mod.markAllAsRead().ok, true);
  assert.equal(mod.markAllAsRead().ok, true);
  assert.deepEqual(channels, ["dm1", "gdm1", "dm1", "gdm1"]);
});

test("markAllAsRead: reports failure when no acknowledgement exists", () => {
  client({
    stores: {
      GuildStore: { getGuilds: () => GUILDS },
      ChannelStore: { getChannels: () => CHANNELS },
      ReadStateStore: { isGuildUnread: () => true },
    },
  });

  const out = mod.markAllAsRead();
  assert.equal(out.ok, false);
  assert.equal(out.guilds, 0);
  assert.equal(out.channels, 0);
  assert.match(out.detail, /not found/);
});

test("markAllAsRead: unread checks claiming 'nothing unread' cannot veto the run", () => {
  // The failure that shipped: the checks answered "read" for everything, the
  // plan came out empty, and the feature reported success while the badges stayed
  // exactly where they were. Acknowledging a channel twice is a no-op the server
  // ignores, so the checks are dropped instead of trusted.
  const guilds = [];
  client({
    stores: {
      GuildStore: { getGuilds: () => GUILDS },
      ChannelStore: { getChannels: () => CHANNELS },
      ReadStateStore: {
        isGuildUnread: () => false,
        isChannelUnread: () => false,
        acknowledgeGuild: (id) => guilds.push(id),
        acknowledgeChannel: () => {},
      },
    },
  });

  const out = mod.markAllAsRead();
  assert.deepEqual(guilds, ["g1", "g2"], "both servers were acknowledged anyway");
  assert.equal(out.ok, true);
  assert.equal(out.guilds, 2);
});

test("markAllAsRead: a client with no channels or servers is reported as unreachable", () => {
  // "There is nothing to acknowledge" and "nothing could be read" are different
  // failures, and only one of them is ever true. Without this the second reported
  // itself as the first, which is how a store that never resolved managed to say
  // "Everything is already read".
  const acked = [];
  client({
    stores: {
      ChannelStore: { getChannels: () => ({}) },
      GuildStore: { getGuilds: () => ({}) },
      ReadStateStore: { acknowledgeChannel: (id) => acked.push(id) },
    },
  });

  const out = mod.markAllAsRead();
  assert.equal(out.ok, false);
  assert.equal(out.considered.guilds, 0);
  assert.equal(out.considered.dms, 0);
  assert.match(out.detail, /not reachable/);
  assert.notEqual(out.detail, "nothing was unread");
  assert.deepEqual(acked, []);
});

test("markAllAsRead: the outcome says what it looked at", () => {
  client({
    stores: {
      GuildStore: { getGuilds: () => GUILDS },
      ChannelStore: { getChannels: () => CHANNELS },
      ReadStateStore: {
        isGuildUnread: () => true,
        isChannelUnread: () => true,
        acknowledgeGuild: () => {},
        acknowledgeChannel: () => {},
      },
    },
  });

  const out = mod.markAllAsRead();
  assert.deepEqual(out.considered, { guilds: 2, dms: 2 });
});

test("markAllAsRead: a throwing acknowledgement is contained, not propagated", () => {
  let calls = 0;
  client({
    stores: {
      GuildStore: { getGuilds: () => GUILDS },
      ChannelStore: { getChannels: () => CHANNELS },
      ReadStateStore: {
        isGuildUnread: () => true,
        isChannelUnread: () => false,
        acknowledgeChannel: () => {},
        acknowledgeGuild: () => {
          calls += 1;
          if (calls === 1) throw new Error("client rejected the ack");
        },
      },
    },
  });

  const out = mod.markAllAsRead();
  assert.equal(calls, 2, "one failure does not stop the rest");
  assert.equal(out.ok, false, "a partial run is not reported as success");
});

test("markAllAsRead: survives a client with no stores at all", () => {
  client({ stores: {} });
  const out = mod.markAllAsRead();
  assert.equal(out.ok, false);
  assert.match(out.detail, /not found/);
});

test("ackChannels (Always read): acks only the given unread channels in one BULK_ACK", () => {
  const actions = [];
  const unread = new Set(["c1", "dm1", "c3"]);
  client({
    stores: {
      ReadStateStore: { hasUnread: (id) => unread.has(id), lastMessageId: (id) => `m-${id}` },
    },
    flux: { FluxDispatcher: { dispatch: (action) => actions.push(action) } },
  });

  // c2 is already read (open channel / own message); c3 is unread but got nothing new.
  assert.equal(mod.ackChannels(["c1", "c2", "dm1", "c1"]), 2);
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0], {
    type: "BULK_ACK",
    context: "APP",
    channels: [
      { channelId: "c1", messageId: "m-c1", readStateType: 0 },
      { channelId: "dm1", messageId: "m-dm1", readStateType: 0 },
    ],
  });

  // Nothing unread: no dispatch at all.
  assert.equal(mod.ackChannels(["c2"]), 0);
  assert.equal(actions.length, 1);
});
