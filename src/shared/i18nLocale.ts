export const SUPPORTED_LOCALES = ['en-US','es-ES','de','ja','fr','pt-BR','ru','it','nl','pl','tr','zh-CN','id','fa','cs','vi','ko','uk'] as const;
export type Locale = typeof SUPPORTED_LOCALES[number];
const aliases: Readonly<Record<string, Locale>> = {
  en:'en-US','en-us':'en-US','en-gb':'en-US',es:'es-ES','es-es':'es-ES','es-419':'es-ES',
  de:'de','de-de':'de',ja:'ja','ja-jp':'ja',fr:'fr','fr-fr':'fr',pt:'pt-BR','pt-br':'pt-BR',
  ru:'ru','ru-ru':'ru',it:'it','it-it':'it',nl:'nl','nl-nl':'nl',pl:'pl','pl-pl':'pl',
  tr:'tr','tr-tr':'tr',zh:'zh-CN','zh-cn':'zh-CN','zh-hans':'zh-CN',
  id:'id','id-id':'id',fa:'fa','fa-ir':'fa',cs:'cs','cs-cz':'cs',vi:'vi','vi-vn':'vi',
  ko:'ko','ko-kr':'ko',uk:'uk','uk-ua':'uk',
};
export function normalizeLocale(value: unknown): Locale {
  if (typeof value !== 'string' || value.length > 35) return 'en-US';
  const key=value.toLowerCase();
  return Object.hasOwn(aliases,key) ? aliases[key] ?? 'en-US' : 'en-US';
}

export function isSupportedLocale(value: unknown): value is Locale { return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value); }
