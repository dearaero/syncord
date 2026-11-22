import {css} from '../../api/css';
import {instead} from '../../api/patcher';
import {find} from '../../webpack';
import {accelerateSpring, springPrototype} from './native';
import {loadPerformanceMode, onPerformanceModeChange, performanceModeEnabled} from './state';
export {performanceModeEnabled, setPerformanceMode, onPerformanceModeChange} from './state';

const ATTRIBUTE = 'data-syncord-performance';
// Decoder-driven GIF/APNG/WebP, video, stickers and canvas are untouched.
const MEDIA = 'img,video,canvas,.emoji,[data-type="emoji"],[data-emoji-id],[data-emoji-name]';
export const PERFORMANCE_CSS = `
html[${ATTRIBUTE}="true"] :where(*):not(${MEDIA}):not(:where(${MEDIA}) *) {
  animation-duration: .001ms !important; animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  transition-duration: .001ms !important; transition-delay: 0s !important;
  scroll-behavior: auto !important; backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}
html[${ATTRIBUTE}="true"] :where(*):not(${MEDIA}):not(:where(${MEDIA}) *)::before,
html[${ATTRIBUTE}="true"] :where(*):not(${MEDIA}):not(:where(${MEDIA}) *)::after,
html[${ATTRIBUTE}="true"] details::details-content {
  animation-duration: .001ms !important; animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  transition-duration: .001ms !important; transition-delay: 0s !important;
}
`;
let stopRuntime: (() => void) | undefined;
let nativeSpring = false;
export const nativeMotionAvailable = (): boolean => nativeSpring;
const isMedia = (element: Element): boolean => !!element.closest(MEDIA);
function finishVisualAnimations(): void {
  for (const animation of document.getAnimations()) {
    const effect = animation.effect;
    if (!(effect instanceof KeyframeEffect) || !effect.target || isMedia(effect.target)) continue;
    try {
      effect.updateTiming({duration: .001, delay: 0, endDelay: 0, iterations: 1});
      animation.finish();
    } catch { /* A detached animation must not prevent the mode from starting. */ }
  }
}
/** Core appearance feature: no plugin entry, native preferences or IPC changes. */
export function startPerformanceMode(): () => void {
  stopRuntime?.();
  loadPerformanceMode();
  let undo: Array<() => void> = [];
  const clear = (): void => {
    for (const dispose of undo.reverse()) dispose();
    undo = [];
    nativeSpring = false;
    document.documentElement.removeAttribute(ATTRIBUTE);
  };
  const apply = (): void => {
    clear();
    if (!performanceModeEnabled()) return;
    undo.push(css.inject('performance-mode', PERFORMANCE_CSS));
    document.documentElement.setAttribute(ATTRIBUTE, 'true');
    try {
      undo.push(instead(Element.prototype, 'animate', function(this: unknown, args, original) {
        if (!(this instanceof Element) || isMedia(this)) return original(...args);
        const options = args[1];
        const timing = options && typeof options === 'object' ? options : {};
        return original(args[0], {...timing, duration: .001, delay: 0, endDelay: 0, iterations: 1}, ...args.slice(2));
      }));
    } catch { /* CSS still works on clients without a writable WAAPI method. */ }
    for (const target of [Element.prototype, window]) {
      for (const method of ['scroll', 'scrollTo', 'scrollBy']) {
        if (typeof (target as unknown as Record<string, unknown>)[method] !== 'function') continue;
        try {
          undo.push(instead(target, method, (args, original) => {
            const options = args[0];
            if (options && typeof options === 'object' && (options as ScrollToOptions).behavior === 'smooth') {
              return original({...options, behavior: 'auto'}, ...args.slice(1));
            }
            return original(...args);
          }));
        } catch { /* Preserve native scrolling if this client seals a method. */ }
      }
    }
    // Only already-loaded exports. Never require a Discord factory or poll.
    try {
      const native = find(value => !!springPrototype(value));
      const restore = accelerateSpring(native);
      if (restore) { undo.push(restore); nativeSpring = true; }
    } catch { /* Version drift leaves CSS and Syncord's own motion reduction. */ }
    finishVisualAnimations();
  };
  const off = onPerformanceModeChange(apply);
  apply();
  const stop = (): void => { off(); clear(); if (stopRuntime === stop) stopRuntime = undefined; };
  stopRuntime = stop;
  return stop;
}
