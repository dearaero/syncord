/** Slow-frame attribution, for Windows reports we cannot reproduce locally.
 * Chromium's Long Animation Frame API reports only frames over 50 ms, with the
 * entry-point script of each callback, so observing it costs ~nothing on a
 * healthy client. Positions inside Syncord's bundle are mapped to a source
 * module by the table `scripts/build.mjs` appends to renderer.js. In memory
 * only: no persistence, IPC or network.
 */
import {VERSION} from '../../../shared/constants';

export const RENDERER_SOURCE_URL = 'syncord-renderer.js';
export type ModuleMap = readonly (readonly [number, string])[];
export interface SourceStats { source: string; scriptMs: number; layoutMs: number; frames: number }
export interface FrameReport { supported: boolean; since: number; frames: number; blockingMs: number; worstMs: number; sources: SourceStats[] }

interface ScriptTiming { duration: number; forcedStyleAndLayoutDuration?: number; sourceURL?: string; sourceCharPosition?: number }
interface FrameTiming extends PerformanceEntry { blockingDuration?: number; scripts?: readonly ScriptTiming[] }

let observer: PerformanceObserver | undefined;
let supported = false, since = Date.now(), frames = 0, blockingMs = 0, worstMs = 0;
const sources = new Map<string, SourceStats>();

/** Pure: which source owns `position` in the renderer bundle. */
export function sourceFor(url: string | undefined, position: number | undefined, map: ModuleMap): string {
  if (!url) return 'unknown';
  if (!url.endsWith(RENDERER_SOURCE_URL)) return 'Discord';
  if (typeof position !== 'number' || position < 0) return 'Syncord';
  let lo = 0, hi = map.length - 1, hit = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (map[mid][0] <= position) { hit = mid; lo = mid + 1; } else hi = mid - 1; }
  return hit < 0 ? 'Syncord' : 'Syncord:' + map[hit][1];
}

const moduleMap = (): ModuleMap => {
  const map = (window as unknown as {__SyncordModuleMap?: unknown}).__SyncordModuleMap;
  return Array.isArray(map) ? map as ModuleMap : [];
};

export function recordFrame(entry: FrameTiming, map: ModuleMap = moduleMap()): void {
  frames++;
  worstMs = Math.max(worstMs, entry.duration);
  blockingMs += entry.blockingDuration ?? Math.max(0, entry.duration - 50);
  const seen = new Set<string>();
  for (const script of entry.scripts ?? []) {
    const key = sourceFor(script.sourceURL, script.sourceCharPosition, map);
    let stats = sources.get(key);
    if (!stats) sources.set(key, stats = {source: key, scriptMs: 0, layoutMs: 0, frames: 0});
    stats.scriptMs += script.duration;
    stats.layoutMs += script.forcedStyleAndLayoutDuration ?? 0;
    if (!seen.has(key)) { seen.add(key); stats.frames++; }
  }
}

export function resetFrameDiagnostics(): void {
  since = Date.now(); frames = blockingMs = worstMs = 0; sources.clear();
}

export function frameReport(): FrameReport {
  return {supported, since, frames, blockingMs, worstMs,
    sources: [...sources.values()].map(s => ({...s})).sort((a, b) => b.scriptMs - a.scriptMs)};
}

/** Plain text a tester can paste into a bug report. */
export function frameReportText(report: FrameReport = frameReport()): string {
  const ms = (n: number): string => `${Math.round(n)} ms`;
  return [
    `Syncord ${VERSION} slow frames since ${new Date(report.since).toISOString()}`,
    `${navigator.userAgent}`,
    `frames=${report.frames} blocking=${ms(report.blockingMs)} worst=${ms(report.worstMs)} supported=${report.supported}`,
    'source | script | forced layout | frames',
    ...report.sources.slice(0, 40).map(s => `${s.source} | ${ms(s.scriptMs)} | ${ms(s.layoutMs)} | ${s.frames}`),
  ].join('\n');
}

export function startFrameDiagnostics(): () => void {
  if (observer) return () => {};
  const types = typeof PerformanceObserver === 'function' ? PerformanceObserver.supportedEntryTypes ?? [] : [];
  const type = types.includes('long-animation-frame') ? 'long-animation-frame' : types.includes('longtask') ? 'longtask' : '';
  if (!type) return () => {};
  try {
    const live = new PerformanceObserver(list => { for (const entry of list.getEntries()) recordFrame(entry as FrameTiming); });
    live.observe({type, buffered: true});
    observer = live; supported = true;
  } catch { return () => {}; }
  return () => { observer?.disconnect(); observer = undefined; supported = false; };
}
