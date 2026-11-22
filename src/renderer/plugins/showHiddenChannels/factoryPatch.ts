import { t as i18nText } from "../../i18n";
import { createLogger } from "../../api/logger";
import { settings } from "../../api/settings";
import { beforeWebpackReady, type WebpackRequire } from "../../webpack";

const log = createLogger("hidden-channels");

/** Minified identifier, same shape Vencord's `\i` matches. */
const IDENT = String.raw`[A-Za-z_$][\w$]*`;

let report = "pending";

export function factoryPatchReport(): string {
  return report;
}

function pluginEnabled(): boolean {
  return settings.get<boolean>("plugins.show-hidden-channels.enabled", true) !== false;
}

function compileFactory(source: string): ((...args: unknown[]) => unknown) | undefined {
  try {
    const fn = (0, eval)(`(${source})`) as unknown;
    return typeof fn === "function" ? (fn as (...args: unknown[]) => unknown) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `isChannelGated(...)&&` becomes `isChannelGated(...)&&false&&`, so gated
 * channels stay in GuildChannelStore. The check is a local inside that module,
 * so patching it after the module has already run does nothing.
 */
function patchGuildStore(src: string): string {
  return src.replace(/isChannelGated\([\s\S]+?\)(?=\s*&&)/g, (match: string, offset: number, whole: string) => {
    const after = whole.slice(offset + match.length);
    if (/^\s*&&\s*false\b/.test(after)) return match;
    return `${match}&&false`;
  });
}

type Step = (src: string) => string;

/**
 * Sidebar rows use getRenderLevel. Hidden channels get a level the list skips
 * unless this VIEW_CHANNEL branch is removed before the module evaluates.
 */
function renderSteps(): Step[] {
  const special = new RegExp(
    String.raw`if\(!${IDENT}\.${IDENT}\.can\(${IDENT}\.${IDENT}\.VIEW_CHANNEL[\s\S]+?\{if\(this\.id===${IDENT}\)[\s\S]+?threadIds:\[\]\}\}`,
  );
  const level = new RegExp(
    String.raw`(this\.record\)\?\{renderLevel:([\s\S]+?),threadIds[\s\S]+?renderLevel:)[\s\S]+?(?=,threadIds)`,
    "g",
  );
  const perm = new RegExp(
    String.raw`(getRenderLevel\(${IDENT}\)\{[\s\S]+?return)!${IDENT}\.${IDENT}\.can\(${IDENT}\.${IDENT}\.VIEW_CHANNEL,this\.record\)\|\|`,
  );
  return [
    (src) => src.replace(special, ""),
    (src) => src.replace(level, (_match, rest: string, defaultLevel: string) => `${rest}${defaultLevel}`),
    (src) => src.replace(perm, (_match, rest: string) => `${rest} `),
    // Minified `return!can(...)||next` must keep a space or `return` glues to the next word.
    (src) =>
      src.replace(
        /![A-Za-z0-9_$.]+\.can\([A-Za-z0-9_$.]+\.VIEW_CHANNEL,this\.record\)\|\|/g,
        " ",
      ),
  ];
}

/** Keep a rewrite only when the factory still parses. */
function applySafe(src: string, steps: Step[]): string {
  let current = src;
  for (const step of steps) {
    const next = step(current);
    if (next === current) continue;
    if (!compileFactory(next)) continue;
    current = next;
  }
  return current;
}

const NAME_EXPERIMENT = "2026-02-private-channel-hiding";

/**
 * Nightcord replaces the tiny getters that return `.enableObfuscation`.
 * Those getters decide the IDENTIFY capability bit. With the bit set, the
 * server sends the channel name as "No Access" instead of the real name.
 */
function patchObfuscation(src: string): string {
  const re = new RegExp(
    String.raw`(function ${IDENT}\(${IDENT}\))[\s\S]{0,200}?\.enableObfuscation\}`,
    "g",
  );
  return src.replace(re, "$1{return false;}");
}

function withoutObfuscation(definition: unknown): unknown {
  if (!definition || typeof definition !== "object") return definition;
  const def = definition as {
    name?: string;
    defaultConfig?: Record<string, unknown>;
    variations?: Record<string, Record<string, unknown> | undefined>;
  };
  if (def.name !== NAME_EXPERIMENT) return definition;
  const variations: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(def.variations ?? {})) {
    variations[key] = { ...value, enableObfuscation: false };
  }
  return {
    ...def,
    defaultConfig: { ...def.defaultConfig, enableObfuscation: false },
    variations,
  };
}

/** Proxies this module's require so the experiment is registered with names visible. */
function wrapNameFactory(factory: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown {
  return function (this: unknown, ...args: unknown[]) {
    const req = args[2] as WebpackRequire;
    const wrappedReq = new Proxy(req, {
      apply(target, thisArg, callArgs) {
        const loaded = Reflect.apply(target, thisArg, callArgs) as { mj?: unknown } | null;
        const mj = loaded?.mj;
        if (loaded == null || typeof loaded !== "object" || typeof mj !== "function") return loaded;
        const record = loaded as { mj: (this: unknown, definition: unknown) => unknown };
        return new Proxy(record, {
          get(obj, prop, recv) {
            if (prop !== "mj") return Reflect.get(obj, prop, recv);
            return function (this: unknown, definition: unknown) {
              return record.mj.call(this, withoutObfuscation(definition));
            };
          },
        });
      },
      get(target, prop, recv) {
        const value = Reflect.get(target, prop, recv) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    return factory.call(this, args[0], args[1], wrappedReq);
  };
}

function patchHiddenChannelFactories(req: WebpackRequire): void {
  if (!pluginEnabled()) {
    report = "skipped-disabled";
    log.info("factory patch skipped (plugin disabled)");
    return;
  }

  const modules = req.m;
  if (!modules) {
    report = "no-factories";
    return;
  }

  let guild = 0;
  let render = 0;
  let hide = 0;
  let applied = 0;
  let late = 0;
  let failed = 0;

  for (const id of Object.keys(modules)) {
    const factory = modules[id];
    if (typeof factory !== "function") continue;

    let src: string;
    try {
      src = Function.prototype.toString.call(factory);
    } catch {
      continue;
    }
    if (!src || src.includes("[native code]")) continue;

    const isGuild = src.includes("GuildChannelStore") && src.includes("isChannelGated");
    const isRender = src.includes("placeholder-channel-id");
    const isHide =
      src.includes("2026-02-private-channel-hiding") ||
      (src.includes("enableObfuscation") && src.includes("private-channel-hiding"));
    if (!isGuild && !isRender && !isHide) continue;

    let next = src;
    if (isGuild) {
      const patched = applySafe(next, [patchGuildStore]);
      if (patched !== next) guild += 1;
      next = patched;
    }
    if (isRender) {
      const patched = applySafe(next, renderSteps());
      if (patched !== next) render += 1;
      next = patched;
    }
    if (isHide) {
      if (req.c?.[id]?.loaded) {
        late += 1;
        continue;
      }
      const rewritten = patchObfuscation(next);
      const compiled = rewritten !== next ? compileFactory(rewritten) : undefined;
      modules[id] = wrapNameFactory((compiled ?? factory) as (...args: unknown[]) => unknown) as typeof factory;
      hide += 1;
      applied += 1;
      continue;
    }
    if (next === src) continue;

    if (req.c?.[id]?.loaded) {
      late += 1;
      continue;
    }

    const fn = compileFactory(next);
    if (!fn) {
      failed += 1;
      log.warn(`factory ${id} patch did not compile`);
      continue;
    }
    modules[id] = fn as typeof factory;
    applied += 1;
  }

  const cached = req.c ? Object.keys(req.c).length : 0;
  report = i18nText("ui.guild_value_render_value_hide_value_applied_value_late_value_failed_va", {v0: guild, v1: render, v2: hide, v3: applied, v4: late, v5: failed, v6: cached});
  log.info(`factory patch ${report}`);
}

beforeWebpackReady(patchHiddenChannelFactories);

/**
 * Variation 3 of this experiment has `enableObfuscation: false`. Pinning it
 * makes later IDENTIFY calls ask for real channel names. The store persists
 * the override, so the next launch applies it before the gateway connects.
 */
export function revealChannelNames(): boolean {
  const flux = window.Syncord?.common?.flux.FluxDispatcher as
    | { dispatch?: (action: unknown) => unknown }
    | undefined;
  const found = window.Syncord?.webpack.findByProps("dispatch", "subscribe") as
    | { dispatch?: (action: unknown) => unknown }
    | undefined;
  const dispatcher = typeof flux?.dispatch === "function" ? flux : found;
  if (typeof dispatcher?.dispatch !== "function") return false;
  const result = dispatcher.dispatch({
    type: "APEX_EXPERIMENT_OVERRIDE_CREATE",
    experimentName: NAME_EXPERIMENT,
    variantId: "3",
  });
  // Native dispatch returns a promise. Keep its receiver and handle startup rejection.
  void Promise.resolve(result).catch(error => log.warn("Channel name override failed", error));
  return true;
}
