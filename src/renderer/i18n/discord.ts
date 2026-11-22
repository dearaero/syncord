import {findByStoreName, waitFor} from '../webpack';
import {getCommon} from '../webpack/common';
import {clearLocaleRoots} from './dom';
import {setLocale} from './core';

type LocaleStore = {readonly locale?: unknown; getLocale?: () => unknown; addChangeListener: (callback: () => void) => void; removeChangeListener: (callback: () => void) => void};
function isLocaleStore(value: unknown): value is LocaleStore {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<LocaleStore>;
  return ('locale' in v || typeof v.getLocale === 'function') && typeof v.addChangeListener === 'function' && typeof v.removeChangeListener === 'function';
}
/** Observe the existing loaded Flux store; never require Discord factories. */
export function startI18n(): () => void {
  let stopped = false, store: LocaleStore | undefined;
  let cancelWait: (() => void) | undefined;
  // Current Discord exposes a locale getter, not getLocale(). Keep the method
  // guard only for compatible older stores, without consulting system language.
  const read = (): void => { try { setLocale(store && 'locale' in store ? store.locale : store?.getLocale?.()); } catch { setLocale(undefined); } };
  const attach = (candidate: unknown): void => {
    if (stopped || store || !isLocaleStore(candidate)) return;
    store = candidate;
    try { store.addChangeListener(read); read(); }
    catch { try { store.removeChangeListener(read); } catch { /* Drift. */ } store = undefined; setLocale(undefined); }
  };
  try { attach(getCommon()?.stores.LocaleStore ?? findByStoreName('LocaleStore')); } catch { setLocale(undefined); }
  if (!store) cancelWait = waitFor(value => isLocaleStore(value) &&
    (value as unknown as {constructor?: {displayName?: string}}).constructor?.displayName === 'LocaleStore', attach);
  return () => {
    stopped = true; cancelWait?.();
    try { store?.removeChangeListener(read); } catch { /* Native shutdown. */ }
    store = undefined; clearLocaleRoots();
  };
}
