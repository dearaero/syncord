import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(tmpdir()+'/syncord-plugin-bulk-');
await build({stdin:{resolveDir:process.cwd(),contents:`export * from './src/renderer/api/plugin/bulk';export * from './src/renderer/api/plugin/manager';export {createPluginContext} from './src/renderer/api/plugin/context';export {settings} from './src/renderer/api/settings';`},bundle:true,format:'esm',platform:'browser',outfile:dir+'/fixture.mjs',logLevel:'silent'});
test.after(()=>rmSync(dir,{recursive:true,force:true}));let serial=0;
async function fixture(saved={}){
 let persisted=structuredClone(saved),network=0;
 globalThis.window={SyncordNative:{getSettings:async()=>structuredClone(persisted),setSettings:async value=>{persisted=structuredClone(value);},security:{requestNetwork:async()=>{network++;return {ok:true,status:200,text:'',truncated:false};}}}};
 const api=await import(pathToFileURL(dir+'/fixture.mjs').href+'?v='+ ++serial);await api.settings.init();
 const counts=new Map(),order=[];
 const add=(id,on=false,extra={})=>{const count={starts:0,stops:0,cleanups:0};counts.set(id,count);api.definePlugin({id,name:id,permissions:{},enabledByDefault:on,start(ctx){count.starts++;ctx.disposable(()=>count.cleanups++);},stop(){count.stops++;order.push(id);},...extra});};
 return {api,counts,order,add,persisted:()=>persisted,network:()=>network};
}
test('bulk: seven active plugins restore exactly, redundant disable preserves snapshot and off plugins never start',async()=>{
 const f=await fixture();for(let i=0;i<10;i++)f.add('fixture-'+i,i<7);await f.api.startAll();
 assert.equal(f.api.list().filter(p=>p.started).length,7);assert.equal(f.api.hasPreviousPluginState(),false);
 assert.deepEqual(await f.api.applyBulkPlugins('disable'),{incomplete:[]});assert(f.api.list().every(p=>!p.enabled&&!p.started));
 assert.deepEqual(f.order,Array.from({length:7},(_,i)=>'fixture-'+(6-i)));
 await f.api.applyBulkPlugins('disable');await f.api.applyBulkPlugins('restore');
 assert.deepEqual(f.api.list().filter(p=>p.started).map(p=>p.id),Array.from({length:7},(_,i)=>'fixture-'+i));
 for(let i=7;i<10;i++)assert.equal(f.counts.get('fixture-'+i).starts,0);
 await f.api.applyBulkPlugins('disable');
 const reopened=await fixture(f.persisted());for(let i=0;i<10;i++)reopened.add('fixture-'+i);reopened.add('new-plugin',true);
 await reopened.api.applyBulkPlugins('restore');assert.equal(reopened.api.list().filter(p=>p.started).length,7);assert.equal(reopened.counts.get('new-plugin').starts,0);
 await reopened.api.applyBulkPlugins('disable');
});
test('bulk: enable all is explicit, restore disables formerly off plugins, data is untouched and corrupt snapshots are refused',async()=>{
 const f=await fixture({'plugins.fixture-b.data.value':'keep'});f.add('fixture-a',true);f.add('fixture-b');await f.api.startAll();
 await f.api.applyBulkPlugins('enable');assert.equal(f.api.list().filter(p=>p.started).length,2);
 await f.api.applyBulkPlugins('restore');assert.equal(f.api.get('fixture-b').enabled,false);assert.equal(f.counts.get('fixture-b').cleanups,1);assert.equal(f.api.settings.get('plugins.fixture-b.data.value'),'keep');
 f.api.settings.set('ui.plugins.previousState',{version:1,states:{'fixture-a':'true'}});assert.equal(f.api.hasPreviousPluginState(),false);await assert.rejects(f.api.applyBulkPlugins('restore'),/No previous/);
 await f.api.stopAll();await f.api.settings.flush();
});
test('bulk: Safe Mode and Lockdown do not grant permission to enable blocked plugins; failed starts are reported',async()=>{
 for(const mode of ['safe','lockdown']){
  const f=await fixture();f.add('fixture-blocked');if(mode==='safe')f.api.setSafeMode(true);else f.api.armLockdown();
  assert.deepEqual((await f.api.applyBulkPlugins('enable')).incomplete,['fixture-blocked']);assert.equal(f.api.get('fixture-blocked').enabled,false);assert.equal(f.counts.get('fixture-blocked').starts,0);
 }
 const f=await fixture();let cleaned=0;f.add('fixture-fails',false,{start(ctx){ctx.disposable(()=>cleaned++);throw Error('fixture');}});
 assert.deepEqual((await f.api.applyBulkPlugins('enable')).incomplete,['fixture-fails']);assert.equal(cleaned,1);assert.equal(f.api.get('fixture-fails').started,false);await f.api.applyBulkPlugins('disable');
});
test('bulk: concurrent clicks/toggles cannot replace snapshot or overlap an async start',async()=>{
 const f=await fixture();let release;const gate=new Promise(resolve=>release=resolve);f.add('fixture-async',false,{async start(ctx){await gate;ctx.disposable(()=>{});}});
 const operation=f.api.applyBulkPlugins('enable');assert.equal(f.api.pluginOperationBusy(),true);
 await assert.rejects(f.api.applyBulkPlugins('disable'),/already running/);await assert.rejects(f.api.setPluginEnabled('fixture-async',false),/already running/);
 release();await operation;assert.equal(f.api.pluginOperationBusy(),false);await f.api.applyBulkPlugins('restore');assert.equal(f.api.get('fixture-async').started,false);
});
test('disposed contexts immediately clean late resources and cannot install patches, styles or broker requests',async()=>{
 const f=await fixture(),ctx=f.api.createPluginContext({id:'fixture-context',name:'fixture',permissions:{webpackPatch:true,media:true},start(){}});
 const target={call:()=>1},original=target.call;ctx.patch.instead(target,'call',()=>2);assert.equal(target.call(),2);
 await ctx.network.request({url:'https://example.test/'});assert.equal(f.network(),1);
 let cleaned=0;ctx.disposable(()=>cleaned++);ctx._disposeAll();ctx._disposeAll();assert.equal(cleaned,1);assert.equal(target.call,original);
 ctx.patch.instead(target,'call',()=>3);ctx.css.inject('body{}');assert.equal(target.call,original);
 const timer=setTimeout(()=>{throw Error('Stopped plugin timer fired');},100);ctx.disposable(()=>{clearTimeout(timer);cleaned++;});assert.equal(cleaned,2);
 const result=await ctx.network.request({url:'https://example.test/'});assert.equal(result.ok,false);assert.equal(f.network(),1);
});
test('factory-level changes truthfully request restart when disabled, without forcing a reload',async()=>{
 const f=await fixture();f.add('fixture-early',true,{restartOnDisable:true});await f.api.startAll();assert.equal(f.api.pluginsNeedRestart(),false);
 await f.api.applyBulkPlugins('disable');assert.equal(f.api.pluginsNeedRestart(),true);assert.equal(f.api.get('fixture-early').started,false);
 await f.api.applyBulkPlugins('restore');assert.equal(f.api.pluginsNeedRestart(),false);await f.api.setPluginEnabled('fixture-early',false);assert.equal(f.api.pluginsNeedRestart(),true);await f.api.settings.flush();
});
