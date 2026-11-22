import { createLogger } from "./logger";

const log = createLogger("lifecycle");

export const LifecyclePhase = {
  Init: "Init",
  WebpackReady: "WebpackReady",
  DOMContentLoaded: "DOMContentLoaded",
} as const;

export type LifecyclePhase =
  (typeof LifecyclePhase)[keyof typeof LifecyclePhase];

type Listener = () => void;

const listeners = new Map<LifecyclePhase, Set<Listener>>();
const completed = new Set<LifecyclePhase>();

function runSafe(phase: LifecyclePhase, fn: Listener): void {
  try {
    fn();
  } catch (err) {
    log.error(`Listener error in ${phase}:`, err);
  }
}

/** Queue a callback for a phase. Runs immediately if the phase already passed. */
export function when(phase: LifecyclePhase, fn: Listener): void {
  if (completed.has(phase)) {
    runSafe(phase, fn);
    return;
  }
  let set = listeners.get(phase);
  if (!set) {
    set = new Set();
    listeners.set(phase, set);
  }
  set.add(fn);
}

/** Mark a phase complete and flush its listeners once. */
export function signal(phase: LifecyclePhase): void {
  if (completed.has(phase)) return;
  completed.add(phase);

  const set = listeners.get(phase);
  listeners.delete(phase);
  if (!set) return;

  for (const fn of set) runSafe(phase, fn);
}

export function hasCompleted(phase: LifecyclePhase): boolean {
  return completed.has(phase);
}

/** Watch DOM ready (or already-complete document). */
export function watchDomReady(): void {
  if (
    document.readyState === "complete" ||
    document.readyState === "interactive"
  ) {
    signal(LifecyclePhase.DOMContentLoaded);
    return;
  }
  document.addEventListener(
    "DOMContentLoaded",
    () => signal(LifecyclePhase.DOMContentLoaded),
    { once: true },
  );
}
