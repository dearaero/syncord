import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=process.cwd(),electron=['Electron.app/Contents/MacOS/Electron','electron.exe','electron'].map(n=>path.join(root,'node_modules/electron/dist',n)).find(existsSync);

async function checks(){
 const tick=()=>new Promise(r=>setTimeout(r,30));
 let natives=0;const Native=MutationObserver;
 window.MutationObserver=class extends Native{constructor(cb){super(cb);natives++;}};
 const {BodyMutationObserver}=window.api;
 const child=[],attr=[],text=[],bad=[];
 const a=new BodyMutationObserver(r=>child.push(r.map(x=>x.type).join()));
 const b=new BodyMutationObserver(r=>attr.push(r.map(x=>x.type+':'+x.attributeName).join()));
 const c=new BodyMutationObserver(r=>text.push(r.map(x=>x.type).join()));
 const d=new BodyMutationObserver(()=>{bad.push(1);throw new Error('boom');});
 a.observe(document.body,{childList:true,subtree:true});
 b.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['id']});
 c.observe(document.body,{childList:true,subtree:true,characterData:true});
 d.observe(document.body,{childList:true,subtree:true});
 const el=document.createElement('p');el.textContent='x';document.body.append(el);await tick();
 el.setAttribute('id','one');el.setAttribute('title','ignored');await tick();
 el.firstChild.data='y';await tick();
 const shared=natives;
 b.disconnect();a.disconnect();c.disconnect();d.disconnect();
 el.setAttribute('id','two');el.append('z');await tick();
 const late=[child.length,attr.length,text.length].join();
 const other=document.createElement('div');document.body.append(other);
 const fb=[];const e=new BodyMutationObserver(r=>fb.push(r.length));e.observe(other,{childList:true});other.append(document.createElement('i'));await tick();e.disconnect();
 return {shared,child,attr,text,bad:bad.length,late,fallbackNative:natives-shared,fb};
}
test('shared body observer: one native observer, per-subscriber record filtering, isolation and cleanup',{skip:!electron,timeout:20000},async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'syncord-body-observer-'));
 try{
  await build({stdin:{resolveDir:root,contents:`import {BodyMutationObserver} from './src/renderer/ui/bodyObserver';window.api={BodyMutationObserver};`},bundle:true,platform:'browser',format:'iife',outfile:dir+'/fixture.js',logLevel:'silent'});
  writeFileSync(dir+'/index.html','<!doctype html><html><body><script src="fixture.js"></script></body></html>');
  writeFileSync(dir+'/main.cjs',`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(dir+'/profile')});app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:800,height:600,webPreferences:{backgroundThrottling:false}});try{await win.loadFile(${JSON.stringify(dir+'/index.html')});console.log('BODY_OBSERVER:'+JSON.stringify(await win.webContents.executeJavaScript('('+${JSON.stringify(checks.toString())}+')()')));win.destroy();app.exit(0)}catch(e){console.error(e);win.destroy();app.exit(1)}});`);
  const run=spawnSync(electron,[dir+'/main.cjs'],{encoding:'utf8',timeout:15000,env:{...process.env,ELECTRON_RUN_AS_NODE:''}});
  assert.equal(run.status,0,run.stdout+'\n'+run.stderr);const line=run.stdout.split('\n').find(s=>s.startsWith('BODY_OBSERVER:'));assert.ok(line,run.stdout);
  const r=JSON.parse(line.slice('BODY_OBSERVER:'.length));
  assert.equal(r.shared,1,'four subscribers share one native observer');
  assert.deepEqual(r.child,['childList'],'childList-only subscriber never sees attribute/text records');
  assert.deepEqual(r.attr,['childList:null','attributes:id'],'attribute filter is honored');
  assert.deepEqual(r.text,['childList','characterData']);
  assert.ok(r.bad>=1,'a throwing subscriber still ran');
  assert.equal(r.late,'1,2,2','disconnected subscribers receive nothing further');
  assert.equal(r.fallbackNative,1);assert.deepEqual(r.fb,[1]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
