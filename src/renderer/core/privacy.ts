import { beforeWebpackReady, type WebpackRequire } from "../webpack";

/** Local performance optimization; the actual request refusal lives in main. */
const state = { analytics: false, metrics: false };
const wrapped = new WeakSet<Function>();
const quietTrack = (): Promise<void> => Promise.resolve();
const quiet = (): void => {};
const response = (): Promise<unknown> => Promise.resolve({ ok: true, status: 204, body: null, text: "", headers: {} });
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function");
}
function handleTrack(event: unknown): false {
  if (record(event) && typeof event.resolve === "function") event.resolve();
  return false;
}

export function suppressAnalytics(exports: unknown): unknown {
  if (!record(exports) || typeof exports.analyticsTrackingStoreMaker !== "function" ||
      typeof exports.trackMaker !== "function" || !record(exports.AnalyticsActionHandlers)) return exports;
  const original = exports.analyticsTrackingStoreMaker;
  const handlers = exports.AnalyticsActionHandlers;
  const silenceHandlers = (): void => {
    for (const key of ["handleConnectionOpen", "handleConnectionClosed", "handleFingerprint", "handleTrack", "handleSetAnalyticsToken"]) {
      if (typeof handlers[key] === "function") handlers[key] = key === "handleTrack" ? handleTrack : () => false;
    }
  };
  // Keep Discord's real Flux Store and its dependency methods. Only telemetry
  // action handlers change; never patch the dispatcher or other stores.
  const maker = function (this: unknown, options: unknown): unknown {
    if (!record(options) || !record(options.actionHandler)) return Reflect.apply(original, this, [options]);
    const actionHandler = Object.fromEntries(Object.keys(options.actionHandler).map(key => [key, key === "TRACK" ? handleTrack : () => false]));
    const store = Reflect.apply(original, this, [{ ...options, actionHandler, submitEvents: response, sendUnloadRequest: () => false }]);
    silenceHandlers(); // The native maker assigns these methods during construction.
    if (record(store)) {
      store.requestDrain = quiet;
      store.submitEventsImmediately = response;
    }
    return store;
  };
  silenceHandlers();
  // Webpack exports are non-configurable getters. Replace the module's exports
  // object, preserving all unrelated descriptors; no eval or source rewriting.
  const descriptors = Object.getOwnPropertyDescriptors(exports);
  descriptors.analyticsTrackingStoreMaker = { configurable: true, enumerable: true, value: maker };
  descriptors.trackMaker = { configurable: true, enumerable: true, value: () => quietTrack };
  state.analytics = true;
  return Object.create(Object.getPrototypeOf(exports), descriptors) as unknown;
}

export function suppressMetrics(exports: unknown): void {
  if (!record(exports)) return;
  for (const value of Object.values(exports)) {
    if (!record(value) || typeof value.increment !== "function" || typeof value.distribution !== "function" ||
        typeof value._flush !== "function" || !Array.isArray(value._metrics) || !("_intervalId" in value)) continue;
    value.increment = quiet;
    value.distribution = quiet;
    value._flush = quiet;
    clearInterval(value._intervalId as ReturnType<typeof setInterval>);
    value._intervalId = undefined;
    value._metrics.length = 0;
    state.metrics = true;
  }
}

/** Wrap only two semantically identified modules; never execute a factory here. */
export function installPrivacyFactories(req: WebpackRequire): void {
  if (!req.m) return;
  for (const [id, factory] of Object.entries(req.m)) {
    if (typeof factory !== "function" || wrapped.has(factory)) continue;
    const source = Function.prototype.toString.call(factory);
    const analytics = source.includes("analyticsTrackingStoreMaker:") && source.includes("AnalyticsActionHandlers:") && source.includes("trackMaker:");
    const metrics = source.includes(".METRICS_V2") && source.includes("_metrics") && source.includes("_intervalId");
    if (!analytics && !metrics) continue;
    const apply = (module: { exports: unknown }): void => {
      try {
        if (analytics) module.exports = suppressAnalytics(module.exports);
        if (metrics) suppressMetrics(module.exports);
      } catch (error) {
        console.warn("[Syncord:privacy] Telemetry optimization unavailable; network filter remains active", error);
      }
    };
    const cached = req.c?.[id];
    if (cached?.loaded) apply(cached);
    const wrapper = function (this: unknown, module: unknown, exports: unknown, localRequire: WebpackRequire): void {
      factory.call(this, module, exports, localRequire);
      if (record(module) && "exports" in module) apply(module as { exports: unknown });
    };
    wrapped.add(wrapper);
    req.m[id] = wrapper;
  }
}

export function rendererPrivacyStatus(): Readonly<typeof state> { return { ...state }; }
beforeWebpackReady(installPrivacyFactories);
