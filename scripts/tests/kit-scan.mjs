/**
 * The module scan, driven with a fake `require` that mimics the client.
 *
 * This is the test that would have caught the bug it is written for: `menuItem`
 * was declared on the kit and read by the schedule menu, but `demangleMenu`
 * never assigned it, so the button was inert in the real client while every stub
 * test passed — a stub supplies the component, so it cannot notice that nothing
 * resolves it.
 *
 * The fakes are built with `new Function` so their *real* source text carries
 * the markers the scan looks for: `fnSource` calls
 * `Function.prototype.toString`, which bypasses an overridden `toString`.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { build } from "esbuild";

const dir = await mkdtemp(path.join(tmpdir(), "dion-kit-"));

await build({
  stdin: {
    contents: `export { kit, scanKit, kitReady } from './src/renderer/discordKit';`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile: path.join(dir, "kit.mjs"),
  logLevel: "warning",
});

/**
 * A real function whose own source text contains `body`.
 *
 * The parameter list matters: `factoryParams` is anchored at the start of the
 * source and reads the require off the third parameter, so a fake shaped like a
 * bare body would leave the demangler unable to find anything.
 */
function fake(body) {
  // eslint-disable-next-line no-new-func
  return new Function("e, t, n", body);
}

// ── the item components, each stamped with its devtools name ────────────────
const components = {
  Dr: fake('/* R("MenuItem") */ return null;'),
  sL: fake('/* R("MenuCheckboxItem") */ return null;'),
  iD: fake('/* R("MenuRadioItem") */ return null;'),
  bX: fake('/* R("MenuSeparator") */ return null;'),
  rX: fake('/* return null; */'), // MenuGroup carries no devtools name
};
const constantsModule = { ...components };

const TOOLTIP = fake(`
  /* tooltipPointer tooltipContent */
  return { onMouseEnter: function () {}, children: this.children };
`);

const MENU = fake(`
  /* navId path:["empty"] */
  return { navId: this.navId, empty: true };
`);

const OPEN = fake('/* renderLazy: "CONTEXT_MENU_OPEN" */ return 1;');
const CLOSE = fake('/* "CONTEXT_MENU_CLOSE" */ return 2;');

/** The menu's flattening code, reduced to what the demangler reads. */
function menuFactory(itemBranch) {
  return fake(`
    var L;
    function flatten(e, t, n) {
      L = n(4242);
      if (e.type === L.bX) return t.push({type:"separator"}), t;
      if (e.type === L.rX) return t.push({type:"groupstart"}), t;
      ${itemBranch}
      if (e.type === L.sL) return t.push({type:"checkbox"}), t;
      if (e.type === L.iD) return t.push({type:"radio"}), t;
      throw Error("Menu API only allows Items and groups of Items as children.");
    }
    return flatten;
  `);
}

/** A well-formed item branch, as shipped. */
const ITEM_BRANCH_OK = 'if (e.type === L.Dr) return t.push({type:"customitem", props:e.props}), t;';

/**
 * The same branch after a minifier restructures it: the type name is no longer
 * an inline literal, so pairing a `type:"..."` string with the check fails.
 * This is the shape that made MenuItem unresolvable in the field.
 */
const ITEM_BRANCH_RESTRUCTURED =
  'if (e.type === L.Dr) { var kind = "customitem"; return t.push({type:kind, props:e.props}), t; }';

function makeRequire(itemBranch) {
  const modules = {
    10: TOOLTIP,
    20: MENU,
    30: OPEN,
    40: menuFactory(itemBranch),
  };
  // The scan insists on a plausible module count before it starts.
  for (let i = 0; i < 600; i++) modules[1000 + i] = fake(`/* pad${i} */ return ${i};`);

  const exportsById = {
    10: { Tooltip: TOOLTIP },
    20: { Menu: MENU },
    30: { openContextMenu: OPEN, closeContextMenu: CLOSE },
    40: {},
    4242: constantsModule,
  };

  const req = (id) => exportsById[id];
  req.m = modules;
  req.c = {};
  return req;
}

/** A fresh copy of the kit module, so each run starts unscanned. */
async function freshKit() {
  const url = `${pathToFileURL(path.join(dir, "kit.mjs")).href}?n=${Math.random()}`;
  return import(url);
}

const SLOTS = [
  "menu",
  "menuItem",
  "menuRadio",
  "menuCheckbox",
  "menuSeparator",
  "menuGroup",
  "openContextMenu",
  "closeContextMenu",
];

function withWindow(req) {
  globalThis.window = { Syncord: { webpack: { getRequire: () => req } } };
}

// ── 1. the shipped shape ────────────────────────────────────────────────────
{
  const { kit, scanKit, kitReady } = await freshKit();
  withWindow(makeRequire(ITEM_BRANCH_OK));
  scanKit();

  assert.equal(kitReady(), true, "the scan must run");
  for (const slot of SLOTS) {
    assert.equal(
      kit[slot] != null,
      true,
      `kit.${slot} was never assigned — a declared-but-unassigned field is exactly ` +
        `how the schedule button ended up inert while every stub test passed`,
    );
  }
  assert.equal(kit.menuItem, components.Dr, "menuItem must be the MenuItem component");
  assert.equal(kit.menuRadio, components.iD, "menuRadio must be the MenuRadioItem component");
  assert.equal(kit.menuCheckbox, components.sL, "menuCheckbox must be MenuCheckboxItem");
  assert.equal(kit.menuSeparator, components.bX, "menuSeparator must be MenuSeparator");
  assert.equal(kit.menuGroup, components.rX, "menuGroup must be MenuGroup");
  assert.equal(kit.menu, MENU, "menu must be the Menu component");
  assert.equal(kit.openContextMenu, OPEN, "openContextMenu must be the open action");
  assert.equal(kit.closeContextMenu(), 2, "closeContextMenu must close");
}
console.log("PASS: the module scan assigns every menu component, including menuItem");

// ── 2. the item branch restructured ─────────────────────────────────────────
// The devtools names must carry the resolution on their own, because the
// type-string pairing is exactly what a minifier breaks.
{
  const { kit, scanKit } = await freshKit();
  withWindow(makeRequire(ITEM_BRANCH_RESTRUCTURED));
  scanKit();

  assert.equal(
    kit.menuItem,
    components.Dr,
    "menuItem must resolve from its devtools name when the type pairing breaks",
  );
  assert.equal(kit.menuRadio, components.iD, "menuRadio too");
  assert.equal(kit.menuCheckbox, components.sL, "menuCheckbox too");
  assert.equal(kit.menuSeparator, components.bX, "menuSeparator too");
  assert.equal(kit.menu, MENU, "and the menu itself");
  assert.equal(
    kit.menuGroup,
    components.rX,
    "MenuGroup has no devtools name, so the type pairing still has to cover it",
  );
}
console.log("PASS: the devtools names resolve the components without the type pairing");

console.log("\nAll discordKit scan checks passed.");
