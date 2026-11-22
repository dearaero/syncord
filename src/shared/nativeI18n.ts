import {nativeCatalogs,nativeEnglish} from './nativeI18n.generated';
import type {Locale} from './i18nLocale';
export function nativeMessage(locale: Locale,key: string,params: Readonly<Record<string,string|number>> = {}): string {
 const english: Readonly<Record<string,string>>=nativeEnglish;
 const text=nativeCatalogs[locale]?.[key] || english[key] || key;
 return text.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g,(match,name:string)=>Object.hasOwn(params,name)?(typeof params[name]==='number'?new Intl.NumberFormat(locale).format(params[name]):String(params[name])):match);
}
export function nativeError(locale: Locale,message: string): string {
 for(const [key,value]of Object.entries(nativeEnglish))if(value===message)return nativeMessage(locale,key);
 return nativeMessage(locale,'native.recorder_capture_failed');
}
