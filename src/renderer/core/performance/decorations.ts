import {onPerformanceModeChange, performanceModeEnabled} from './state';

/** Non-critical name decorations yield to input/scroll; messages never use this. */
export function decorationScheduler(work: () => void): {schedule: () => void; cancel: () => void; dispose: () => void} {
  let dirty = false, closed = false, frame = 0, timer = 0;
  const cancel = (): void => {
    if (frame) cancelAnimationFrame(frame);
    if (timer) clearTimeout(timer);
    frame = timer = 0;
  };
  const run = (): void => {
    frame = timer = 0;
    if (closed || !dirty) return;
    if (performanceModeEnabled() && document.hidden) return;
    dirty = false;
    work();
  };
  const queue = (): void => {
    if (closed || !dirty || frame || timer) return;
    if (performanceModeEnabled()) {
      if (!document.hidden) timer = window.setTimeout(run, 120);
    } else frame = requestAnimationFrame(run);
  };
  const change = (): void => { cancel(); queue(); };
  const off = onPerformanceModeChange(change);
  document.addEventListener('visibilitychange', change);
  return {
    schedule() { if (!closed) { dirty = true; queue(); } },
    cancel() { dirty = false; cancel(); },
    dispose() { closed = true; dirty = false; cancel(); off(); document.removeEventListener('visibilitychange', change); },
  };
}
