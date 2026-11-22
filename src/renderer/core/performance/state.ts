import {settings} from '../../api/settings';

export const PERFORMANCE_KEY = 'ui.performanceMode';
let enabled = false;
const listeners = new Set<() => void>();
export const performanceModeEnabled = (): boolean => enabled;
export function onPerformanceModeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function setPerformanceMode(value: boolean, persist = true): void {
  if (persist) settings.set(PERFORMANCE_KEY, value);
  if (value === enabled) return;
  enabled = value;
  for (const listener of [...listeners]) listener();
}
export function loadPerformanceMode(): void {
  setPerformanceMode(settings.get<boolean>(PERFORMANCE_KEY, false) === true, false);
}
