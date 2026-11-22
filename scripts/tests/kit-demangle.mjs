/**
 * Checks discordKit's menu resolution against a real client bundle.
 *
 * A stub in a test cannot answer "will this actually resolve in the client",
 * because a stub supplies the component instead of resolving it. This runs the
 * same heuristics over the shipped bundle, offline.
 *
 * It checks two things, because the kit uses two strategies:
 *
 *  - the devtools display names, which are the primary signal. Each must appear
 *    exactly once in the menu module, or two components could claim one slot;
 *  - the flattening code's type names, kept as a fallback for MenuGroup, which
 *    carries no devtools name.
 *
 * Usage: node scripts/tests/kit-demangle.mjs [path/to/bundle.js]
 *        node scripts/tests/kit-demangle.mjs /Applications/Discord.app/.../bundle.js
 */
import { readFile } from "node:fs/promises";

const path = process.argv[2] ?? "/tmp/web.js";
const bundle = await readFile(path, "utf-8");

const MARKER = "Menu API only allows Items and groups of Items as children.";

// ── the kit's helpers, kept in step with src/renderer/discordKit.ts ──────────
const ITEM_NAMES = {
  radio: "MenuRadioItem",
  separator: "MenuSeparator",
  checkbox: "MenuCheckboxItem",
  groupstart: "MenuGroup",
  control: "MenuControlItem",
  compositecontrol: "MenuControlItem",
  item: "MenuItem",
  customitem: "MenuItem",
};

/** The kit fields that hold a resolved menu component. */
const SLOTS = {
  Menu: "menu",
  MenuItem: "menuItem",
  MenuRadioItem: "menuRadio",
  MenuCheckboxItem: "menuCheckbox",
  MenuSeparator: "menuSeparator",
};

const ident = "[A-Za-z_$][\\w$]*";
const typeCheckRe = new RegExp(`\\(${ident}\\.type===(${ident})\\.(${ident})\\)`, "g");
const pushTypeRe = /type:"(\w+)"/g;

// Verbatim from src/renderer/discordKit.ts
function factoryParams(src) {
  const match = src.match(/^(?:function\s*)?(?:\w+\s*)?\(([^)]*)\)/);
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

// ── locate the menu module ───────────────────────────────────────────────────
const markerAt = bundle.indexOf(MARKER);
if (markerAt < 0) {
  console.error(`marker not found in ${path}`);
  process.exit(2);
}
const modHeader = /\},(\d+)\((\w+),(\w+),(\w+)\)\{/g;
let header = null;
let hm;
while ((hm = modHeader.exec(bundle)) !== null) {
  if (hm.index > markerAt) break;
  header = hm;
}
if (!header) {
  console.error("could not find the menu module header");
  process.exit(2);
}
const src = bundle.slice(
  header.index + header[0].indexOf("("),
  markerAt + 4000,
);

const params = factoryParams(src);
console.log(`bundle: ${path}`);
console.log(`menu module ${header[1]}, factory params ${JSON.stringify(params)}`);
if (!params[2]) {
  console.error("no third factory param: the demangler would bail out immediately");
  process.exit(1);
}

// ── strategy 1: the devtools display names ───────────────────────────────────
console.log("\ndevtools display names (primary strategy):");
const ambiguous = [];
for (const [name] of Object.entries(SLOTS)) {
  const count = (src.match(new RegExp(`"${name}"`, "g")) ?? []).length;
  const unique = count === 1;
  console.log(
    `  ${String(unique).padEnd(6)} ${name.padEnd(18)} ${count} occurrence(s)` +
      (unique ? "" : "  <- ambiguous"),
  );
  if (!unique) ambiguous.push(`${name} appears ${count} times`);
}
const groupCount = (src.match(/"MenuGroup"/g) ?? []).length;
console.log(
  `  n/a    MenuGroup            ${groupCount}  (no devtools name; found by type pairing)`,
);

// ── strategy 2: the flattening code's type names ────────────────────────────
console.log("\ntype-name pairing (fallback, and all that MenuGroup has):");
const paired = new Map();
let typeMatch;
while ((typeMatch = typeCheckRe.exec(src)) !== null) {
  const alias = typeMatch[1];
  const prop = typeMatch[2];
  if (!alias || !prop) continue;
  pushTypeRe.lastIndex = typeCheckRe.lastIndex;
  const type = pushTypeRe.exec(src)?.[1];
  if (!type || !(type in ITEM_NAMES)) continue;
  const name = ITEM_NAMES[type];
  if (paired.has(name)) continue;
  paired.set(name, { alias, prop, type });
}
for (const [name, info] of paired) {
  console.log(`  ${name.padEnd(20)} <- ${info.alias}.${info.prop}  (type:"${info.type}")`);
}

// ── the other scan branches ──────────────────────────────────────────────────
console.log("\nscan heuristics (distinctive strings, searched across the bundle):");
const heuristics = {
  tooltip: "tooltipPointer",
  tooltipContent: "tooltipContent",
  menu: 'path:["empty"]',
  openContextMenu: "CONTEXT_MENU_OPEN",
};
const missingHeuristics = [];
for (const [name, needle] of Object.entries(heuristics)) {
  const present = bundle.includes(needle);
  console.log(
    `  ${String(present).padEnd(6)} ${name.padEnd(18)} ${JSON.stringify(needle)}`,
  );
  if (!present) missingHeuristics.push(`${name} (${needle})`);
}

// ── verdict for what the schedule menu needs ────────────────────────────────
console.log("\nthe schedule menu needs Menu, MenuItem and openContextMenu:");
const problems = [];
if (ambiguous.length) problems.push(`ambiguous display names: ${ambiguous.join("; ")}`);
if (!paired.has("MenuItem") && !ambiguous.includes("MenuItem was missing")) {
  // The display names are checked above; this only reports the fallback.
  if (!ambiguous.length) problems.push("MenuItem found by neither strategy");
}
if (missingHeuristics.length) {
  problems.push(`missing scan strings: ${missingHeuristics.join(", ")}`);
}
if (problems.length) {
  console.error(`FAIL: ${problems.join("; ")}`);
  process.exit(1);
}
console.log("all resolvable");
