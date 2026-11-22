import {instead} from '../../api/patcher';

type Spring = {finish: () => unknown};
/** Public SpringValue methods plus its resume/idle contract; no export IDs. */
export function springPrototype(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'function') return;
  const proto: unknown = value.prototype;
  if (!proto || typeof proto !== 'object') return;
  const p = proto as Record<string, unknown>;
  if (!['advance', '_resume', 'finish', 'start', 'update', 'set', 'pause', 'resume'].every(k => typeof p[k] === 'function')) return;
  if (typeof Object.getOwnPropertyDescriptor(p, 'idle')?.get !== 'function') return;
  return p;
}
/** finish() resolves native onRest/promise lifecycle; it does not cancel it. */
export function accelerateSpring(value: unknown): (() => void) | undefined {
  const proto = springPrototype(value);
  if (!proto) return;
  if (Object.getOwnPropertyDescriptor(proto, 'advance')?.writable !== true) return;
  try {
    // Keep native scheduling: finishing in _resume could turn looping springs
    // into an unbounded microtask chain. Advance finishes on the next frame.
    return instead(proto, 'advance', function(this: unknown, args, original) {
      if (!this || typeof (this as Spring).finish !== 'function') return original(...args);
      return (this as Spring).finish();
    });
  } catch {
    return undefined;
  }
}
