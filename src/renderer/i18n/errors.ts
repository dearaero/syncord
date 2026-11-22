import english from './locales/en-US';
import {getLocale, t, type Catalog, type Params} from './core';

const sources = Object.entries(english as Catalog).filter((entry): entry is [string,string] => typeof entry[1] === 'string');
const exact = new Map(sources.map(([key,source]) => [source,key]));
type Template = {key:string; literals:string[]; parameters:string[]};
const templates: Template[] = [];
for (const [key,source] of sources) {
  const parameters = [...source.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1]!);
  if (!parameters.length || parameters.length > 12 || !/[A-Za-z]{3}/.test(source.replace(/\{[^}]+\}/g,''))) continue;
  const literals = source.split(/\{[A-Za-z][A-Za-z0-9_]*\}/g);
  // Adjacent placeholders have no recoverable boundary. Never guess one.
  if (literals.slice(1,-1).some(part => !part)) continue;
  templates.push({key,literals,parameters});
}
let previousLocale = getLocale();
const cache = new Map<string,string>();
function matchTemplate(source:string, template:Template): Params | undefined {
  if (!source.startsWith(template.literals[0]!)) return undefined;
  let position = template.literals[0]!.length;
  const params: Record<string,string> = {};
  for (let index=0;index<template.parameters.length;index++) {
    const next = template.literals[index+1]!;
    const end = !next ? source.length : index === template.parameters.length-1
      ? (source.endsWith(next) ? source.length-next.length : -1)
      : source.indexOf(next,position);
    if (end < position) return undefined;
    params[template.parameters[index]!] = source.slice(position,end);
    position = end+next.length;
  }
  return position === source.length ? params : undefined;
}
/** Product-owned status/diagnostic text only. Do not pass user-authored content. */
export function localizeMessage(source:string): string {
  if (getLocale() === 'en-US' || source.length > 8192) return source;
  if (previousLocale !== getLocale()) { previousLocale=getLocale();cache.clear(); }
  const cached = cache.get(source); if (cached !== undefined) return cached;
  let result = source;
  const key = exact.get(source);
  if (key) result = t(key);
  else for (const template of templates) {
    const params = matchTemplate(source,template);
    if (params) { result=t(template.key,params);break; }
  }
  // The cache cannot retain unbounded paths/provider bodies between views.
  if (source.length <= 512) {
    if (cache.size >= 128) cache.delete(cache.keys().next().value ?? '');
    cache.set(source,result);
  }
  return result;
}
/** Electron's IPC wrapper is diagnostic framing, not part of the UI message. */
export function localizeError(error: unknown): string {
  let source: string;
  try { source = error instanceof Error ? error.message : typeof error === 'string' ? error : ''; }
  catch { source=''; }
  source = source.replace(/^Error invoking remote method 'Syncord_[A-Z0-9_]+': (?:Error: )?/, '').replace(/^Error: /,'');
  if (!source || source.length > 8192) return t('error.the_operation_could_not_be_completed_please_try_again');
  const localized = localizeMessage(source);
  // Unknown runtime/provider diagnostics remain available to existing logs;
  // a translated generic failure is safer than treating them as message keys.
  if (getLocale() !== 'en-US' && localized === source && !exact.has(source)) return t('error.the_operation_could_not_be_completed_please_try_again');
  return localized;
}
