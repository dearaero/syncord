import { createLogger } from "../api/logger";
import { LifecyclePhase, signal } from "../api/lifecycle";

const log = createLogger("webpack");

const CHUNK_KEY = "webpackChunkdiscord_app";

/** Discord Stable often has thousands of factories; refuse stripped stubs. */
const MIN_FACTORIES = 500;

export type WebpackRequire = ((id: PropertyKey) => unknown) & {
  c?: Record<
    string,
    { id: PropertyKey; loaded?: boolean; exports: unknown } | undefined
  >;
  m?: Record<
    string,
    | ((module: unknown, exports: unknown, require: WebpackRequire) => void)
    | undefined
  >;
  p?: string;
};

type Filter = (exports: unknown) => boolean;

let _wreq: WebpackRequire | undefined;
let patchedPrototypeM = false;

const propsCache = new Map<string, unknown>();
const codeCache = new Map<string, unknown>();
const storeCache = new Map<string, unknown>();

let resolveReady!: () => void;
const readyPromise = new Promise<void>((resolve) => {
  resolveReady = resolve;
});

const earlyHooks: Array<(req: WebpackRequire) => void> = [];

/**
 * Runs once webpack's factory map is captured, before Discord requires modules.
 * Use this to rewrite factory source. Do not call the factories here.
 */
export function beforeWebpackReady(hook: (req: WebpackRequire) => void): void {
  earlyHooks.push(hook);
  if (_wreq) {
    try {
      hook(_wreq);
    } catch (err) {
      log.error("early webpack hook:", err);
    }
  }
}

function runEarlyHooks(req: WebpackRequire): void {
  for (const hook of earlyHooks) {
    try {
      hook(req);
    } catch (err) {
      log.error("early webpack hook:", err);
    }
  }
}

const PROXY_PROBE = "__Syncord_proxy_probe__";

function factoryCount(req: WebpackRequire): number {
  try {
    return req.m ? Object.keys(req.m).length : 0;
  } catch {
    return 0;
  }
}

function cacheCount(req: WebpackRequire): number {
  try {
    return req.c ? Object.keys(req.c).length : 0;
  } catch {
    return 0;
  }
}

function isUsableRequire(req: unknown): req is WebpackRequire {
  if (typeof req !== "function") return false;
  const r = req as WebpackRequire;
  if (r.c == null || r.m == null) return false;
  if (factoryCount(r) < MIN_FACTORIES) return false;
  return true;
}

function acceptRequire(req: WebpackRequire, source: string): void {
  if (_wreq === req) return;

  if (_wreq) {
    // Allow upgrade from a weaker capture to a fuller one.
    if (factoryCount(req) <= factoryCount(_wreq)) return;
  }

  if (!isUsableRequire(req)) return;

  const first = !_wreq;
  _wreq = req;
  log.info(
    `webpack require via ${source} (${factoryCount(req)} factories, ${cacheCount(req)} cached)`,
  );

  runEarlyHooks(req);

  if (first) {
    signal(LifecyclePhase.WebpackReady);
    resolveReady();
  }
}

/**
 * Modern Discord (Rspack/webpack): the real `__webpack_require__` gets `.m`
 * (factory map) assigned during boot. Catch that without touching chunk.push
 * (mutating push froze Stable on "Starting…").
 *
 * Note: `.c` (module cache) is often assigned *after* `.m` — nest a setter.
 */
function patchFunctionPrototypeM(): void {
  if (patchedPrototypeM) return;
  patchedPrototypeM = true;

  Reflect.defineProperty(Function.prototype, "m", {
    configurable: true,
    enumerable: false,
    set(this: WebpackRequire, modules: WebpackRequire["m"]) {
      Reflect.defineProperty(this, "m", {
        value: modules,
        writable: true,
        configurable: true,
        enumerable: true,
      });

      try {
        if (typeof this !== "function") return;
        if (!modules || Object.keys(modules).length < MIN_FACTORIES) return;

        const stack = new Error().stack ?? "";
        if (!stack.includes("http") && !stack.includes("/assets/")) return;
        if (/sentry|libdiscore|fast-connect/i.test(stack)) return;

        const maybeAccept = () => {
          acceptRequire(this, "Function.prototype.m");
        };

        if (this.c != null) {
          maybeAccept();
          return;
        }

        // Cache object lands after factories — intercept first assignment.
        Reflect.defineProperty(this, "c", {
          configurable: true,
          enumerable: true,
          set(cache: WebpackRequire["c"]) {
            Reflect.defineProperty(this, "c", {
              value: cache,
              writable: true,
              configurable: true,
              enumerable: true,
            });
            maybeAccept();
          },
        });
      } catch (err) {
        log.error("prototype.m hook error:", err);
      }
    },
  });
}

/**
 * Fallback: classic self-installing chunk. On new Stable the callback may get
 * a stripped require — we refuse those via isUsableRequire.
 */
function pushCaptureChunk(): void {
  try {
    const w = window as unknown as Record<string, unknown>;
    const existing = w[CHUNK_KEY];
    const chunk: unknown[] = Array.isArray(existing) ? existing : [];
    if (!Array.isArray(existing)) w[CHUNK_KEY] = chunk;

    chunk.push([
      [Symbol.for("Syncord")],
      {},
      (req: WebpackRequire) => {
        acceptRequire(req, "chunk.push");
      },
    ]);
  } catch (err) {
    log.error("chunk.push capture failed:", err);
  }
}

/** Begin waiting for Discord's webpack (call once at boot). */
export function initWebpack(): void {
  patchFunctionPrototypeM();
  pushCaptureChunk();
}

export function waitReady(): Promise<void> {
  return readyPromise;
}

export function wreq(id: PropertyKey): unknown {
  if (!_wreq) throw new Error("webpack not ready");
  return _wreq(id);
}

export function getRequire(): WebpackRequire | undefined {
  return _wreq;
}

/** Quick console diagnostics. */
export function debug(): Record<string, unknown> {
  return {
    ready: Boolean(_wreq),
    factories: _wreq ? factoryCount(_wreq) : 0,
    cached: _wreq ? cacheCount(_wreq) : 0,
    bundlePath: _wreq?.p ?? null,
  };
}

function shouldIgnore(value: unknown): boolean {
  if (value == null) return true;
  if (
    value === window ||
    value === document ||
    value === document.documentElement
  ) {
    return true;
  }
  if (typeof value !== "object" && typeof value !== "function") return true;

  try {
    const obj = value as Record<PropertyKey, unknown>;
    if (obj[Symbol.toStringTag as keyof typeof obj] === "IntlMessagesProxy") {
      return true;
    }
    if (obj[PROXY_PROBE] !== undefined) {
      Reflect.deleteProperty(obj, PROXY_PROBE);
      return true;
    }
  } catch {
    return true;
  }

  return false;
}

function* iterateModuleExports(exports: unknown): Generator<unknown> {
  if (shouldIgnore(exports)) return;
  yield exports;

  if (typeof exports !== "object" || exports === null) return;

  for (const key of Object.keys(exports as object)) {
    let nested: unknown;
    try {
      nested = (exports as Record<string, unknown>)[key];
    } catch {
      continue;
    }
    if (shouldIgnore(nested)) continue;
    yield nested;
  }
}

function* iterateCacheExports(): Generator<unknown> {
  const cache = _wreq?.c;
  if (!cache) return;

  for (const id of Object.keys(cache)) {
    const mod = cache[id];
    if (!mod?.exports) continue;
    yield* iterateModuleExports(mod.exports);
  }
}

/** Find first module exports matching `filter`. Returns a live reference. */
export function find(filter: Filter): unknown {
  if (!_wreq?.c) return undefined;

  for (const exp of iterateCacheExports()) {
    try {
      if (filter(exp)) return exp;
    } catch {
      /* skip */
    }
  }
  return undefined;
}

function byPropsFilter(props: string[]): Filter {
  return (m) => {
    if (m == null || (typeof m !== "object" && typeof m !== "function")) {
      return false;
    }
    const obj = m as Record<string, unknown>;
    return props.every((p) => obj[p] !== undefined);
  };
}

function findByPropsInFactories(props: string[], filter: Filter): unknown {
  const factories = _wreq?.m;
  if (!factories) return undefined;

  for (const id of Object.keys(factories)) {
    const factory = factories[id];
    if (typeof factory !== "function") continue;

    let src: string;
    try {
      src = Function.prototype.toString.call(factory);
    } catch {
      continue;
    }
    if (!props.every((p) => src.includes(p))) continue;

    let exports: unknown;
    try {
      exports = _wreq!(id);
    } catch {
      continue;
    }

    for (const exp of iterateModuleExports(exports)) {
      try {
        if (filter(exp)) return exp;
      } catch {
        /* skip */
      }
    }
  }
  return undefined;
}

/** Cache-keyed by joined prop names. */
export function findByProps(...props: string[]): unknown {
  if (props.length === 0) return undefined;
  const key = props.join(",");
  if (propsCache.has(key)) return propsCache.get(key);

  const filter = byPropsFilter(props);
  // Only search the require cache. Force-loading factories here races Discord's
  // own init and has frozen the UI (unclickable window).
  const result = find(filter);

  if (result !== undefined) propsCache.set(key, result);
  return result;
}

/** Find a Flux store by `constructor.displayName`. */
export function findByStoreName(name: string): unknown {
  if (storeCache.has(name)) return storeCache.get(name);

  const result = find((m) => {
    if (m == null || typeof m !== "object") return false;
    const ctor = (m as { constructor?: { displayName?: string } }).constructor;
    return ctor?.displayName === name;
  });

  if (result !== undefined) storeCache.set(name, result);
  return result;
}

export function findByCode(...codes: string[]): unknown {
  if (!_wreq?.m || codes.length === 0) return undefined;
  const key = codes.join("\0");
  if (codeCache.has(key)) return codeCache.get(key);

  const factories = _wreq.m;
  for (const id of Object.keys(factories)) {
    const factory = factories[id];
    if (typeof factory !== "function") continue;
    let src: string;
    try {
      src = Function.prototype.toString.call(factory);
    } catch {
      continue;
    }
    if (!codes.every((c) => src.includes(c))) continue;

    let exports: unknown;
    try {
      exports = _wreq(id);
    } catch {
      continue;
    }

    for (const exp of iterateModuleExports(exports)) {
      codeCache.set(key, exp);
      return exp;
    }
  }

  return undefined;
}

export function clearFindCache(): void {
  propsCache.clear();
  codeCache.clear();
  storeCache.clear();
}

// ── waitFor (lazy modules) ──────────────────────────────────────────

type Waiter = {
  filter: Filter;
  done: (mod: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

const waiters = new Set<Waiter>();
let pollTimer: ReturnType<typeof setInterval> | undefined;

function propsFilter(props: string[]): Filter {
  return byPropsFilter(props);
}

function normalizeFilter(filter: Filter | string[]): Filter {
  return typeof filter === "function" ? filter : propsFilter(filter);
}

function stopWaitPoll(): void {
  if (pollTimer === undefined) return;
  clearInterval(pollTimer);
  pollTimer = undefined;
}

function tickWaiters(): void {
  if (waiters.size === 0) {
    stopWaitPoll();
    return;
  }
  for (const waiter of [...waiters]) {
    let mod: unknown;
    try {
      mod = find(waiter.filter);
    } catch {
      continue;
    }
    if (mod === undefined) continue;
    waiters.delete(waiter);
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    waiter.done(mod);
  }
  if (waiters.size === 0) stopWaitPoll();
}

function startWaitPoll(): void {
  if (pollTimer !== undefined) return;
  pollTimer = setInterval(tickWaiters, 100);
}

export type WaitForOptions = {
  /** ms; default 15s. Use 0 to never time out. */
  timeout?: number;
};

/**
 * Run `callback` when a matching module appears (lazy chunks).
 * Returns a cancel function. Polls only while waiters exist.
 */
export function waitFor(
  filter: Filter | string[],
  callback: (mod: unknown) => void,
  options: WaitForOptions = {},
): () => void {
  const fn = normalizeFilter(filter);
  const timeout = options.timeout ?? 15_000;

  try {
    const existing = find(fn);
    if (existing !== undefined) {
      callback(existing);
      return () => {};
    }
  } catch {
    /* wait */
  }

  let settled = false;
  const waiter: Waiter = {
    filter: fn,
    done(mod) {
      if (settled) return;
      settled = true;
      callback(mod);
    },
    timer: undefined,
  };

  waiters.add(waiter);
  startWaitPoll();

  if (timeout > 0) {
    waiter.timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      waiters.delete(waiter);
      if (waiters.size === 0) stopWaitPoll();
    }, timeout);
  }

  return () => {
    if (settled) return;
    settled = true;
    waiters.delete(waiter);
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    if (waiters.size === 0) stopWaitPoll();
  };
}

/** Promise wrapper around waitFor. */
export function waitForPromise(
  filter: Filter | string[],
  options: WaitForOptions = {},
): Promise<unknown> {
  const timeout = options.timeout ?? 15_000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cancel = waitFor(
      filter,
      (mod) => {
        if (settled) return;
        settled = true;
        resolve(mod);
      },
      { timeout: 0 },
    );

    if (timeout > 0) {
      setTimeout(() => {
        if (settled) return;
        settled = true;
        cancel();
        reject(new Error("waitFor timed out"));
      }, timeout);
    }
  });
}

export const webpack = {
  waitReady,
  wreq,
  getRequire,
  debug,
  find,
  findByProps,
  findByStoreName,
  findByCode,
  clearFindCache,
  waitFor,
  waitForPromise,
};
