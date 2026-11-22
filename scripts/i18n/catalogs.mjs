/** Development-only catalog reader. No translator, network call or runtime dependency. */
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
export async function readCatalogs(){
 const dir=await mkdtemp(path.join(tmpdir(),'syncord-catalogs-'));
 try{
  const file=path.join(dir,'catalogs.mjs');
  await build({stdin:{resolveDir:process.cwd(),contents:"export {default as english} from './src/renderer/i18n/locales/en-US';export {default as loaders} from './src/renderer/i18n/locales';"},bundle:true,platform:'node',format:'esm',outfile:file,logLevel:'silent'});
  const {english,loaders}=await import(pathToFileURL(file).href);
  return {'en-US':english,...Object.fromEntries(Object.entries(loaders).map(([locale,load])=>[locale,load()]))};
 }finally{await rm(dir,{recursive:true,force:true});}
}
export function coverage(catalogs){
 const english=catalogs['en-US'];const placeholders=text=>[...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(m=>m[1]).sort().join('|');
 return Object.fromEntries(Object.entries(catalogs).map(([locale,catalog])=>{
  const missing=[],invalid=[];
  for(const [key,source]of Object.entries(english)){
   const value=catalog[key];if(!value){missing.push(key);continue;}
   if(typeof value!==typeof source){invalid.push(key);continue;}
   for(const [category,text]of Object.entries(typeof value==='string'?{other:value}:value)){
    const original=typeof source==='string'?source:source[category]??source.other;
    if(typeof text!=='string'||!text.trim()||placeholders(text)!==placeholders(original))invalid.push(key+':'+category);
   }
  }
  for(const key of Object.keys(catalog))if(!Object.hasOwn(english,key))invalid.push(key+':unknown');
  return [locale,{translated:Object.keys(english).length-missing.length,total:Object.keys(english).length,missing,invalid}];
 }));
}
