/** Local, dependency-free messages. Provider/user content never enters this catalog. */
import english from './locales/en-US';
import loaders from './locales';

import {normalizeLocale, type Locale} from '../../shared/i18nLocale';
export {SUPPORTED_LOCALES, normalizeLocale, type Locale} from '../../shared/i18nLocale';
export type PluralMessage = Readonly<Partial<Record<Intl.LDMLPluralRule, string>> & {other: string}>;
export type Message = string | PluralMessage;
export type Catalog = Readonly<Record<string, Message>>;
export type Params = Readonly<Record<string, string | number | bigint | boolean | null | undefined>>;
export type MessageKey = keyof typeof english;
export type MessageRef = Readonly<{key: string; params: Params}>;

/** Cache a message's identity, so presentation can follow later locale changes. */
export function messageRef(key: MessageKey | (string & {}), params: Params = {}): MessageRef {
  return Object.freeze({key, params:Object.freeze({...params})});
}
export function sameMessageRef(left: MessageRef, right: MessageRef): boolean {
  const keys=Object.keys(left.params);
  return left.key===right.key && keys.length===Object.keys(right.params).length
    && keys.every(key=>Object.hasOwn(right.params,key)&&Object.is(left.params[key],right.params[key]));
}


let locale: Locale = 'en-US';
let active: Catalog = english;
let activeLabelKeys: Map<string,string> | undefined;
let plural = new Intl.PluralRules(locale);
let relative = new Intl.RelativeTimeFormat(locale, {numeric:'always',style:'short'});
const listeners = new Set<() => void>();
const numbers = new Map<string, Intl.NumberFormat>();
const dates = new Map<string, Intl.DateTimeFormat>();
export const getLocale = (): Locale => locale;
export const getDirection = (): 'ltr' | 'rtl' => locale === 'fa' ? 'rtl' : 'ltr';

/** Called only by the Discord adapter; this is not a persisted language setting. */
export function setLocale(value: unknown): void {
  const next = normalizeLocale(value);
  if (next === locale) return;
  locale = next;
  active = next === 'en-US' ? english : loaders[next]();
  activeLabelKeys=undefined;
  plural = new Intl.PluralRules(next);
  relative = new Intl.RelativeTimeFormat(next,{numeric:'always',style:'short'});
  numbers.clear(); dates.clear();
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* One closed view cannot interrupt other views. */ }
  }
}
export function onLocaleChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function pattern(message: Message | undefined, count?: number, rules = plural): string | undefined {
  if (typeof message === 'string') return message.trim() ? message : undefined;
  if (!message) return undefined;
  const selected=count===undefined?undefined:message[rules.select(count)];
  return selected?.trim()?selected:message.other?.trim()?message.other:undefined;
}
function interpolate(text: string, params: Params): string {
  // Callback replacements keep '$&', braces and HTML in parameters literal.
  return text.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, key: string) =>
    Object.hasOwn(params, key) ? ((typeof params[key] === 'number' || typeof params[key] === 'bigint') ? number(params[key], {maximumFractionDigits:20}) : String(params[key] ?? '')) : match);
}
/** Stable diagnostics/state values; localization happens at the presentation edge. */
export function canonicalMessage(key: MessageKey | (string & {}), params: Params = {}): string {
  const catalog: Catalog = english;
  const count=typeof params.count==='number'?params.count:undefined;
  const text=pattern(catalog[key],count,englishPlural) ?? key;
  return text.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g,(match,name:string)=>Object.hasOwn(params,name)?String(params[name]??''):match);
}
export function t(key: MessageKey | (string & {}), params: Params = {}): string {
  const count = typeof params.count === 'number' && Number.isFinite(params.count) ? params.count : undefined;
  const fallback: Catalog = english;
  return interpolate(pattern(active[key], count) ?? pattern(fallback[key], count, englishPlural) ?? key, params);
}
const englishPlural = new Intl.PluralRules('en-US');
const sourceKeys = new Map<string, string>(Object.entries(english as Catalog).filter((entry): entry is [string,string] => typeof entry[1] === 'string').map(([key,value]) => [value,key]));
/** Canonical metadata stays stable in the plugin/security registry. */
export function localizeKnown(source: string): string {
  const key = sourceKeys.get(source);
  return key ? t(key) : source;
}
/** Resolve only product-owned labels, never user messages or account names. */
export function messageKeyForLabel(label: string): string | undefined {
  const source = sourceKeys.get(label);
  if (source) return source;
  activeLabelKeys ??= new Map(Object.entries(active).filter((entry):entry is [string,string]=>typeof entry[1]==='string').map(([key,value])=>[value,key]));
  return activeLabelKeys.get(label);
}
export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, char =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char] ?? char));
/** HTML text/attribute interpolation: translations and parameters remain text. */
export const h = (key: MessageKey | (string & {}), params: Params = {}): string => escapeHtml(t(key, params));

export function number(value: number | bigint, options: Intl.NumberFormatOptions = {}): string {
  const key = JSON.stringify(options);
  let formatter = numbers.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options);
    if (numbers.size >= 32) numbers.delete(numbers.keys().next().value ?? '');
    numbers.set(key, formatter);
  }
  return formatter.format(value);
}
export function date(value: number | Date, options: Intl.DateTimeFormatOptions = {}): string {
  const key = JSON.stringify(options);
  let formatter = dates.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    if (dates.size >= 32) dates.delete(dates.keys().next().value ?? '');
    dates.set(key, formatter);
  }
  try { return formatter.format(value); } catch { return '—'; }
}
export function dateFormatter(options: Intl.DateTimeFormatOptions = {}): {format:(value?:number|Date)=>string} {
  return {format:(value=Date.now())=>date(value,options)};
}

export function relativeTime(value: number, unit: Intl.RelativeTimeFormatUnit): string { return relative.format(value,unit); }
