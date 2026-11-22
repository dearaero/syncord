import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
const root=process.cwd();
const electron=['Electron.app/Contents/MacOS/Electron','electron.exe','electron'].map(n=>path.join(root,'node_modules/electron/dist',n)).find(existsSync);
test('i18n UI: live Flux getter, late discovery, 18 locales, owned text, drafts, safe HTML and cleanup',{skip:!electron&&'Electron is not installed',timeout:30000},async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'syncord-i18n-ui-'));
 try{
  await build({stdin:{resolveDir:root,loader:'ts',contents:`import * as api from './src/renderer/i18n';import {startI18n} from './src/renderer/i18n/discord';window.I={...api,startI18n};`},bundle:true,platform:'browser',outfile:dir+'/fixture.js',logLevel:'silent',plugins:[{name:'locale-store',setup(b){
   b.onResolve({filter:/\/webpack(?:\/common)?$/},a=>({path:a.path.endsWith('/common')?'common':'webpack',namespace:'locale-fixture'}));
   b.onLoad({filter:/.*/,namespace:'locale-fixture'},a=>({contents:a.path==='common'?`export const getCommon=()=>({stores:{LocaleStore:window.testStore}});`:`export const findByStoreName=()=>window.testStore;export const waitFor=(predicate,callback)=>{window.lateStore={predicate,callback};return ()=>{window.lateStore=undefined;};};`,loader:'js'}));
  }}]});
  writeFileSync(dir+'/index.html','<!doctype html><meta charset="utf-8"><script src="fixture.js"></script>');
  function driver(file){const {app,BrowserWindow}=require('electron');app.disableHardwareAcceleration();app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:900,height:600});try{await win.loadFile(file);const result=await win.webContents.executeJavaScript(`(async()=>{
   const {SUPPORTED_LOCALES,t,getLocale,setLocale,onLocaleChange,messageHtml,setLocalizedHtml,setLocalizedText,setLocalizedAttribute,preserveInputs,startI18n,canonicalMessage,productHtml,productAttribute}=I;
   const check=(ok,detail)=>{if(!ok)throw Error(detail);};
   const events=new Set();let locale='tr';window.testStore={get locale(){return locale;},addChangeListener:f=>events.add(f),removeChangeListener:f=>events.delete(f)};
   const stop=startI18n();check(getLocale()==='tr'&&events.size===1,'current Flux locale getter');
   const root=document.createElement('section');document.body.append(root);
   setLocalizedHtml(root,'<button>'+messageHtml('ui.cancel')+'</button><input value="initial"><p data-user>Cancel</p><p>'+messageHtml('ui.value_url_copied',{v0:'<img src=x onerror=alert(1)>$&'})+'</p>');
   const input=root.querySelector('input');input.value='my unsaved draft';input.focus();input.setSelectionRange(3,9);
   const attr=document.createElement('input');root.append(attr);setLocalizedAttribute(attr,'placeholder','ui.cancel');
   const nameKeys=['long.name','virtual.pluginName','ps.name','fd.name'],names=document.createElement('section');root.after(names);
   const paintNames=()=>setLocalizedHtml(names,nameKeys.map(key=>'<button '+productAttribute('aria-label',canonicalMessage(key))+'>'+productHtml(canonicalMessage(key))+'</button>').join(''));paintNames();
   let calls=0;const off=onLocaleChange(()=>calls++);
   for(const requested of SUPPORTED_LOCALES){locale=requested;for(const fn of events)fn();check(getLocale()===requested,'locale '+requested);check(root.querySelector('button').textContent===t('ui.cancel'),'live label '+requested);check(attr.placeholder===t('ui.cancel'),'live attribute '+requested);check(input.value==='my unsaved draft'&&input.selectionStart===3&&input.selectionEnd===9,'draft and cursor '+requested);check(root.querySelector('[data-user]').textContent==='Cancel','user content '+requested);check(!root.querySelector('img'),'HTML escaped '+requested);check(root.lang===requested&&root.dir===(requested==='fa'?'rtl':'ltr'),'direction '+requested);for(const [i,key]of nameKeys.entries()){check(names.children[i].textContent===t(key),'live plugin name '+key+' '+requested);check(names.children[i].getAttribute('aria-label')===t(key),'plugin accessible name '+key+' '+requested);}paintNames();check([...names.children].every((node,i)=>node.textContent===t(nameKeys[i])),'reopened plugin labels '+requested);}
   const before=calls;for(const fn of events)fn();check(calls===before,'no redundant event');locale='ar';for(const fn of events)fn();check(getLocale()==='en-US','unsupported fallback');
   const detached=document.createElement('button');root.append(detached);setLocalizedText(detached,'ui.close');detached.remove();locale='tr';for(const fn of events)fn();check(detached.textContent==='Close','closed nodes not retained');
   preserveInputs(root,()=>setLocalizedHtml(root,'<button>'+messageHtml('ui.cancel')+'</button><input value="reset">'));check(root.querySelector('input').value==='my unsaved draft','explicit repaint preserves draft');
   names.remove();off();stop();check(events.size===0,'Flux listener removed');locale='de';for(const fn of events)fn();check(getLocale()==='tr','stopped adapter');
   window.testStore=undefined;setLocale('en-US');const stopLate=startI18n();check(window.lateStore,'late discovery installed');window.testStore={constructor:{displayName:'LocaleStore'},get locale(){return 'ja'},addChangeListener:f=>events.add(f),removeChangeListener:f=>events.delete(f)};check(lateStore.predicate(testStore),'late store guard');lateStore.callback(testStore);check(getLocale()==='ja','late getter');stopLate();check(events.size===0&&!window.lateStore,'late listener cleanup');
   return {locales:SUPPORTED_LOCALES.length,passed:true};
  })()`);console.log('RESULT:'+JSON.stringify(result));app.exit(0);}catch(error){console.error(error);app.exit(1);}});}
  writeFileSync(dir+'/main.cjs','('+driver.toString()+')('+JSON.stringify(dir+'/index.html')+');');
  const child=spawnSync(electron,[dir+'/main.cjs'],{encoding:'utf8',timeout:25000,env:{...process.env,ELECTRON_RUN_AS_NODE:''}});
  assert.equal(child.status,0,child.stdout+'\n'+child.stderr);assert.match(child.stdout,/'?RESULT:.*"locales":18/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
