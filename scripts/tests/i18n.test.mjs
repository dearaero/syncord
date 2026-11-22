import {sourceIssues,scanLocaleSource} from '../i18n/source.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const dir=mkdtempSync(path.join(tmpdir(),'syncord-i18n-'));
const output=path.join(dir,'i18n.mjs');
await build({stdin:{resolveDir:process.cwd(),contents:"export * from './src/renderer/ui/ecosystem/transactionReason';export * from './src/renderer/i18n/core';export * from './src/renderer/i18n/errors';export {default as english} from './src/renderer/i18n/locales/en-US';export {default as loaders} from './src/renderer/i18n/locales';"},bundle:true,platform:'node',format:'esm',outfile:output,logLevel:'silent'});
const I=await import(pathToFileURL(output).href);
test.after(()=>rmSync(dir,{recursive:true,force:true}));
const placeholders=text=>[...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(m=>m[1]).sort();

test('i18n: exactly the requested 18 languages; unsupported, malformed and unavailable locales use English',()=>{
 assert.deepEqual(I.SUPPORTED_LOCALES,['en-US','es-ES','de','ja','fr','pt-BR','ru','it','nl','pl','tr','zh-CN','id','fa','cs','vi','ko','uk']);
 for(const value of [undefined,null,{},[],42,'',' tr ','__proto__','constructor','prototype','zh-TW','ar','en-INVALID','tr<script>','a'.repeat(100)])assert.equal(I.normalizeLocale(value),'en-US');
 for(const [value,expected]of [['EN-us','en-US'],['en-GB','en-US'],['pt-BR','pt-BR'],['es-419','es-ES'],['zh-Hans','zh-CN'],['fa-IR','fa'],['uk-UA','uk']])assert.equal(I.normalizeLocale(value),expected);
});
test('i18n: every language has every message, nonempty text and identical interpolation parameters',()=>{
 const keys=Object.keys(I.english).sort();assert.ok(keys.length>1000);
 for(const locale of I.SUPPORTED_LOCALES){const catalog=locale==='en-US'?I.english:I.loaders[locale]();
  const missing=keys.filter(key=>!Object.hasOwn(catalog,key)),unexpected=Object.keys(catalog).filter(key=>!Object.hasOwn(I.english,key));
  assert.equal(missing.length,0,locale+' missing '+missing.length+' messages: '+missing.slice(0,6).join(', '));assert.deepEqual(unexpected,[],locale+' unexpected messages');
  for(const key of keys){const source=I.english[key],value=catalog[key];
   assert.equal(typeof value,typeof source,locale+' '+key);
   const variants=typeof value==='string'?{other:value}:value;
   for(const [category,text]of Object.entries(variants)){assert.ok(text.trim(),locale+' '+key+' '+category);assert.deepEqual(placeholders(text),placeholders(typeof source==='string'?source:source[category]??source.other),locale+' '+key+' '+category);}
  }
 }
});
test('i18n: interpolation treats replacement tokens and hostile HTML as text',()=>{
 I.setLocale('en-US');const malicious='"><svg onload=alert(1)>$&{v1}</svg>';
 const key='ui.value_url_copied';assert.equal(I.t(key,{v0:malicious}),malicious+' URL copied');
 assert.ok(!I.h(key,{v0:malicious}).includes('<svg'));assert.ok(I.h(key,{v0:malicious}).includes('&lt;svg'));
 assert.equal(I.t('unknown.key'),'unknown.key');assert.doesNotThrow(()=>I.t(key));
});
test('i18n: missing or empty translations fall back to English; one failed view cannot stop locale propagation',()=>{
 const original=I.loaders.tr;I.loaders.tr=()=>({'ui.cancel':'  '});
 let notifications=0;const first=I.onLocaleChange(()=>{throw Error('closed view');}),second=I.onLocaleChange(()=>notifications++);
 I.setLocale('tr');assert.equal(I.t('ui.cancel'),'Cancel');assert.equal(I.t('ui.close'),'Close');
 I.setLocale('tr-TR');assert.equal(notifications,1);first();second();I.setLocale('en-US');assert.equal(notifications,1);I.loaders.tr=original;
});
test('i18n: locale-specific numbers, dates and direction follow the selected Discord locale',()=>{
 for(const locale of ['en-US','de','tr','fa','ja']){I.setLocale(locale);assert.equal(I.number(12345.6),new Intl.NumberFormat(locale).format(12345.6));assert.equal(I.date(0,{timeZone:'UTC',dateStyle:'short'}),new Intl.DateTimeFormat(locale,{timeZone:'UTC',dateStyle:'short'}).format(0));assert.equal(I.getDirection(),locale==='fa'?'rtl':'ltr');}
 I.setLocale('en-US');
});

test('i18n: plural forms follow each language instead of English suffixes',()=>{
 for(const [locale,counts]of Object.entries({ru:[1,2,5,21],pl:[1,2,5,22],cs:[1,3,5,1.5],tr:[1,5],ja:[1,5]})){
  I.setLocale(locale);const catalog=I.loaders[locale]();for(const count of counts){const forms=catalog['count.messages'];const category=new Intl.PluralRules(locale).select(count);const expected=(forms[category]??forms.other).replace('{count}',I.number(count));assert.equal(I.t('count.messages',{count}),expected);}
 }
 I.setLocale('en-US');assert.equal(I.t('count.plugins',{count:1}),'1 plugin');assert.equal(I.t('count.plugins',{count:2}),'2 plugins');
});
test('i18n: errors unwrap only the fixed IPC framing and safely handle unknown diagnostics',()=>{
 I.setLocale('tr');assert.equal(I.localizeError("Error invoking remote method 'Syncord_ECO_POLL': Error: The Ecosystem request failed. Please retry."),I.t('error.the_ecosystem_request_failed_please_retry'));
 assert.equal(I.localizeError('provider-private-diagnostic'),I.t('error.the_operation_could_not_be_completed_please_try_again'));
 assert.equal(I.localizeError('x'.repeat(10000)),I.t('error.the_operation_could_not_be_completed_please_try_again'));
 I.setLocale('en-US');assert.equal(I.localizeError(Error('specific detail')),'specific detail');
});

test('i18n: CSS units, selectors, SVG paths, executable paths and link protections are never message data',()=>{
 for(const [key,value]of Object.entries(I.english))if(typeof value==='string'){
  assert.doesNotMatch(value,/^(?:C:\/Program Files|\[class\*|noopener noreferrer|M\{v|translate\(|\{v\d+\}px$)/,key);
 }
});

test('i18n: every source message exists in English and no code/security contract is translated',async()=>{
 assert.deepEqual(await sourceIssues(I.english),[]);
 for(const code of ['anchor.rel = i18nText("ui.cancel");','node.style.width = i18nText("ui.cancel");','path.setAttribute("d", i18nText("ui.cancel"));','node.id = i18nNumber(1234);','const headingClass=i18nText("ui.cancel"); react.createElement("h2",{className:headingClass});','react.createElement("h2",{className:i18nText("ui.cancel")});'])assert.ok(scanLocaleSource('fixture.ts',code,I.english).length,code);
 assert.equal(scanLocaleSource('fixture.ts','node.setAttribute("aria-label", i18nText("ui.cancel"));',I.english).length,0);
 assert.ok(scanLocaleSource('fixture.ts','t("ui.missing_test_key")',I.english).some(issue=>issue.detail.includes('Unknown English')));
});


test('i18n: cached message references snapshot parameters and render in the current locale',()=>{
 const params={count:2};const message=I.messageRef('count.events',params);params.count=3;
 assert.equal(message.params.count,2);assert.ok(Object.isFrozen(message));assert.ok(Object.isFrozen(message.params));
 assert.ok(I.sameMessageRef(message,I.messageRef('count.events',{count:2})));
 assert.ok(!I.sameMessageRef(message,I.messageRef('count.events',{count:3})));
 assert.ok(!I.sameMessageRef(message,I.messageRef('count.events',{count:2,extra:undefined})));
 I.setLocale('de');assert.equal(I.t(message.key,message.params),'2 Ereignisse');I.setLocale('en-US');
});


test('i18n: built-in transaction reasons follow the locale and custom rule names stay literal',()=>{
 I.setLocale('tr');assert.equal(I.transactionReason('Badge purchase'),I.t('ui.badge_purchase'));
 for(const value of ['Cancel','constructor','__proto__','Community <img>'])assert.equal(I.transactionReason(value),value);
 I.setLocale('en-US');
});
