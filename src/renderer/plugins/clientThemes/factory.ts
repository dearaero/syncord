import { createLogger } from "../../api/logger";
import { beforeWebpackReady, type WebpackRequire } from "../../webpack";

const log = createLogger("client-themes");
type Factory = NonNullable<NonNullable<WebpackRequire["m"]>[string]>;
const record = (v: unknown): v is Record<PropertyKey, unknown> => v !== null && typeof v === "object";

let unlocked = false;
let nativeGate: ((...args: unknown[]) => unknown) | undefined;
let report: "pending" | "installed" | "missing" | "late" = "pending";
const wrappers = new WeakSet<Factory>();

export const setClientThemesUnlocked = (value: boolean): void => { unlocked = value; };
export const clientThemeFactoryReport = (): typeof report => report;
/** Discord's own answer (real Nitro), ignoring the plugin; undefined before the module ran. */
export function nativeThemeAccess(user: unknown): boolean | undefined {
  try { return nativeGate ? nativeGate(user) === true : undefined; } catch { return undefined; }
}

/** A copy of Discord's frozen premium-perks object whose theme gate also consults the plugin. */
export function unlockedPerks(perks: Record<PropertyKey, unknown>): Record<PropertyKey, unknown> | undefined {
  const original = perks.canUseClientThemes;
  if (typeof original !== "function") return undefined;
  nativeGate = original as (...args: unknown[]) => unknown;
  const copy = {
    ...perks,
    canUseClientThemes(this: unknown, ...args: unknown[]): unknown {
      return unlocked || Reflect.apply(original, this, args);
    },
  };
  return Object.isFrozen(perks) ? Object.freeze(copy) : copy;
}

/**
 * The perks object is frozen, so neither it nor its read-only ESM getter can be
 * patched. Rebuild the module's export object instead, swapping only that export.
 */
export function wrapPerksExports(exports: unknown): unknown {
  if (!record(exports)) return exports;
  const descriptors = Object.getOwnPropertyDescriptors(exports);
  let changed = false;
  for (const key of Reflect.ownKeys(descriptors)) {
    const d = descriptors[key as string];
    if (!d) continue;
    let value: unknown;
    try { value = d.get ? d.get.call(exports) : d.value; } catch { continue; }
    if (!record(value) || typeof value.isPremium !== "function") continue;
    const copy = unlockedPerks(value);
    if (!copy) continue;
    descriptors[key as string] = { enumerable: d.enumerable, configurable: true, get: () => copy };
    changed = true;
  }
  return changed ? Object.defineProperties(Object.create(Object.getPrototypeOf(exports)), descriptors) : exports;
}

/** Wrap only the perks factory, before Discord runs it; never force-load anything. */
export function installClientThemeFactory(req: WebpackRequire): void {
  const modules = req.m;
  if (!modules) return;
  let status: typeof report = "missing";
  for (const [id, factory] of Object.entries(modules)) {
    if (typeof factory !== "function") continue;
    if (wrappers.has(factory)) { status = "installed"; continue; }
    const source = Function.prototype.toString.call(factory);
    if (!source.includes("canUseClientThemes:") || !source.includes("isPremiumAtLeast:") || !source.includes("Object.freeze(")) continue;
    if (req.c?.[id]) { status = "late"; log.warn("Premium perks module already ran; restart Discord to unlock themes"); continue; }
    const wrapper: Factory = function (this: unknown, module, exports, localRequire) {
      factory.call(this, module, exports, localRequire);
      try {
        if (record(module)) module.exports = wrapPerksExports(module.exports);
      } catch (error) {
        log.warn("Could not adapt the premium perks module", error);
      }
    };
    wrappers.add(wrapper);
    modules[id] = wrapper;
    status = "installed";
  }
  report = status;
}

beforeWebpackReady(installClientThemeFactory);
