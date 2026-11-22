import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
const textAttributes=new Set(['title','placeholder','aria-label','aria-description','aria-valuetext','alt']);
/** Translation data must never become an identifier, geometry or a security attribute. */
export function scanLocaleSource(file,source,english){
 const issues=[],add=(offset,detail)=>issues.push({file,line:source.slice(0,offset).split('\n').length,detail});
 for(const match of source.matchAll(/["']((?:ui|error|notes|native|security|relationship|count)\.[a-z0-9_]+)["']/g))if(!Object.hasOwn(english,match[1]))add(match.index,'Unknown English message: '+match[1]);
 const names=new Set(['i18nText','i18nHtml','i18nNumber','canonicalMessage']);
 for(const imported of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)){
  if(!/\/i18n(?:\/core)?$/.test(imported[2])&&!(file.replaceAll('\\','/').includes('/i18n/')&&imported[2]==='./core'))continue;
  for(const specifier of imported[1].split(',')){const [name,alias]=specifier.trim().split(/\s+as\s+/);if(['t','h','messageHtml','number','canonicalMessage'].includes(name))names.add(alias??name);}
 }
 const call='\\b(?:'+[...names].join('|')+')\\s*\\(';
 const contract='(?:id|className|type|rel|href|src|navId|viewBox|d|points|fill|stroke|transform|fontFamily|width|height|left|top|right|bottom)';
 const properties=new RegExp('\\b'+contract+'\\s*:\\s*'+call,'g');
 for(const match of source.matchAll(properties))add(match.index,'Localized object property used as a code/DOM contract');
 // Follow a directly cached label into a contract too (for example className: headingClass).
 for(const declaration of source.matchAll(new RegExp('\\b(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*'+call,'g'))){
  const identifier=declaration[1].replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const use=new RegExp('(?:\\b'+contract+'\\s*:|\\.'+contract+'\\s*=(?!=|>))\\s*'+identifier+'\\b','g');
  for(const match of source.matchAll(use))add(match.index,'Cached localized label used as a code/DOM contract');
 }
 const assignments=new RegExp('\\.(?:id|className|type|rel|href|src|navId|viewBox|d|points|fill|stroke|transform|fontFamily|width|height|left|top|right|bottom)\\s*=(?!=|>)[^;\\n]*'+call,'g');
 for(const match of source.matchAll(assignments))add(match.index,'Localized value assigned to a code/DOM contract');
 const styles=new RegExp('\\.style(?:\\.[A-Za-z]+\\s*=|\\.setProperty\\()[^;\\n]*'+call,'g');
 for(const match of source.matchAll(styles))add(match.index,'Localized CSS value');
 const attributes=new RegExp('\\.setAttribute\\(\\s*["\']([^"\']+)["\']\\s*,[^;\\n]*'+call,'g');
 for(const match of source.matchAll(attributes))if(!textAttributes.has(match[1]))add(match.index,'Localized non-text attribute: '+match[1]);
 return issues;
}
export async function sourceIssues(english){
 const files=(await readdir('src',{recursive:true})).filter(file=>file.endsWith('.ts')&&!file.replaceAll('\\','/').includes('/i18n/locales/')&&!file.endsWith('nativeI18n.generated.ts'));
 const results=await Promise.all(files.map(async file=>{const name=path.join('src',file);return scanLocaleSource(name,await readFile(name,'utf8'),english);}));
 return results.flat();
}
