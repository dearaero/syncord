import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
const dir=mkdtempSync(tmpdir()+'/syncord-experiments-');after(()=>{delete globalThis.window;delete globalThis.document;rmSync(dir,{recursive:true,force:true});});
await build({stdin:{resolveDir:process.cwd(),contents:`export * from './src/renderer/plugins/experiments/model';export * from './src/renderer/i18n/experiments';export * from './src/renderer/plugins/experiments';export * from './src/renderer/plugins/experiments/nativeAccess';export * from './src/renderer/plugins/experiments/nativeLoader';export * from './src/renderer/plugins/experiments/state';export {after as patchAfter} from './src/renderer/api/patcher';`},bundle:true,format:'esm',platform:'node',outfile:dir+'/test.mjs',logLevel:'silent',plugins:[{name:'discord-fixture',setup(b){
 b.onResolve({filter:/\/webpack$/},()=>({path:'webpack',namespace:'fixture'}));
 b.onResolve({filter:/\/api\/plugin$/},()=>({path:'plugin',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path==='plugin'?'export const definePlugin=x=>x;':`export const find=filter=>window.exports?.find(filter);export const findByProps=(...keys)=>[window.router,window.navigation,window.modals].find(value=>value&&keys.every(key=>value[key]!==undefined));export const findByStoreName=name=>window.stores?.[name];export const beforeWebpackReady=()=>{};`}));
}}]});
const api=await import(dir+'/test.mjs');
test('reads real registered user definitions and assignments without evaluating experiments or accepting guild/unknown models',()=>{
 let reads=0;
 const store={getRegisteredExperiments(){return{b:{type:'user',title:'Second',buckets:[-1,0,2,'9',Infinity],description:['Off','On']},a:{type:'user',buckets:[0,1]},guild:{type:'guild',buckets:[0]},unknown:{buckets:[0]},broken:null};},getAllExperimentAssignments(){reads++;return{a:0,b:2};},getUserExperimentDescriptor(){throw Error('must not evaluate');}};
 const result=api.snapshot(store);assert.equal(result.available,true);assert.equal(reads,1);assert.deepEqual(result.experiments.map(x=>x.name),['a','b']);assert.equal(result.experiments[0].assignment,0);assert.deepEqual(result.experiments[1].buckets,[-1,0,2]);assert.deepEqual(result.experiments[1].descriptions,['Off','On']);
 store.getAllExperimentAssignments=()=>({b:NaN});assert.equal(api.snapshot(store).experiments[0].assignment,null);
 store.getAllExperimentOverrideDescriptors=()=>({a:{type:'user',bucket:1,override:true},b:{type:'guild',bucket:9,override:true}});
 assert.equal(api.snapshot(store).experiments[0].assignment,1);assert.equal(api.snapshot(store).experiments[1].assignment,null);
});
test('missing, throwing and changed stores fail closed; listener cleanup survives partial subscriptions',()=>{
 for(const store of [null,{}, {getRegisteredExperiments:()=>null,getAllExperimentAssignments:()=>({})},{getRegisteredExperiments(){throw Error('version drift');},getAllExperimentAssignments:()=>({})}])assert.deepEqual(api.snapshot(store),{available:false,experiments:[]});
 const listeners=new Set();const fn=()=>{};const store={addChangeListener:f=>listeners.add(f),removeChangeListener:f=>listeners.delete(f)};
 const off=api.watch(store,fn);assert.equal(listeners.size,1);off();assert.equal(listeners.size,0);
 store.addChangeListener=f=>{listeners.add(f);throw Error('partial');};api.watch(store,fn)();assert.equal(listeners.size,0);
 api.watch({get addChangeListener(){throw Error('version drift');}},fn)();
 globalThis.window={stores:{ExperimentStore:store}};assert.equal(api.discover(),store);
});
test('native routing tries ordinary accounts and confirms actual panel selection instead of trusting a void router result',async()=>{
 const calls=[],developer=Object.freeze({isDeveloper:false}),state={currentPanelKey:'account_panel',currentCategoryKey:null,scrollPositionSnapshots:new Map()};
 globalThis.window={stores:{DeveloperExperimentStore:developer},exports:[{getState:()=>state}],router:{openUserSettings:t=>{calls.push(t);state.currentPanelKey=t;}}};
 globalThis.document={querySelector:()=>({})};
 assert.equal(await api.openNative(),true);assert.deepEqual(calls,['experiments_panel']);assert.equal(developer.isDeveloper,false);
 state.currentPanelKey='account_panel';window.router.openUserSettings=t=>{calls.push(t);};
 const abort=new AbortController();const pending=api.openNative(abort.signal);queueMicrotask(()=>abort.abort());assert.equal(await pending,false);
 window.router.openUserSettings=()=>Promise.reject(Error('unavailable'));assert.equal(await api.openNative(),false);
 delete window.router;assert.equal(await api.openNative(),false);
});
test('scoped native tree exposes only Experiments, preserves real developer access, and restores on disable',async()=>{
 const panel=Object.freeze({key:'experiments_panel',type:3});
 const experiments=Object.freeze({key:'experiments_sidebar_item',type:2,buildLayout:()=>[panel]});
 const options=Object.freeze({key:'developer_options_sidebar_item',type:2});
 const developer=Object.freeze({isDeveloper:false});
 const section=Object.freeze({key:'developer_section',type:1,usePredicate:()=>developer.isDeveloper,buildLayout:()=>[experiments,options]});
 const ordinary=Object.freeze({key:'account_section',type:1});
 const sections=Object.freeze([ordinary,section]);const root={key:'$Root',type:0,analyticsKey:'user_settings',buildLayout:()=>sections};const original=root.buildLayout;
 let nativeUpdates=0;const state={currentPanelKey:'account_panel',currentCategoryKey:null,scrollPositionSnapshots:new Map()};
 globalThis.window={Syncord:{common:{react:{React:{useSyncExternalStore:(subscribe,get)=>{subscribe(()=>nativeUpdates++);return get();}}}}},stores:{DeveloperExperimentStore:developer},exports:[root,{getState:()=>state}],router:{openUserSettings:target=>{const native=root.buildLayout()[1];if(native.usePredicate()&&native.buildLayout().includes(experiments))state.currentPanelKey=target;}}};
 globalThis.document={querySelector:()=>state.currentPanelKey==='experiments_panel'?{}:null};
 const disposals=[];const ctx={disposable:fn=>disposals.push(fn),patch:{after:(...args)=>{const off=api.patchAfter(...args);disposals.push(off);return off;}},log:{warn(){}}};
 api.Experiments.start(ctx);assert.notEqual(root.buildLayout,original);
 const exposed=root.buildLayout();assert.equal(exposed[0],ordinary);assert.equal(exposed[1].usePredicate(),true);assert.deepEqual(exposed[1].buildLayout(),[experiments]);assert.equal(developer.isDeveloper,false);assert.deepEqual(section.buildLayout(),[experiments,options]);assert.equal(await api.openNative(),true);
 for(const off of disposals.reverse())off();assert.equal(root.buildLayout,original);assert.equal(exposed[1].usePredicate(),false);assert.equal(section.usePredicate(),false);const stoppedUpdates=nativeUpdates;api.setRunning(true);assert.equal(nativeUpdates,stoppedUpdates);api.setRunning(false);
 window.stores.DeveloperExperimentStore={isDeveloper:true};assert.equal(api.experimentsSections(sections,(_subscribe,get)=>get()),sections);
 const changed=[{...section,buildLayout:()=>[{...experiments,buildLayout:()=>[{key:'unknown',type:3}]}]}];assert.equal(api.experimentsSections(changed,(_subscribe,get)=>get())[0],changed[0]);
});
test('lazy native settings install the single scoped hook and retry routing once after Discord loads its own exports',async()=>{
 const panel={key:'experiments_panel',type:3},section={key:'developer_section',type:1,usePredicate:()=>false,buildLayout:()=>[{key:'experiments_sidebar_item',type:2,buildLayout:()=>[panel]}]};
 const root={key:'$Root',type:0,analyticsKey:'user_settings',buildLayout:()=>[section]},original=root.buildLayout;
 const state={currentPanelKey:'account_panel',currentCategoryKey:null,scrollPositionSnapshots:new Map()};let calls=0;
 globalThis.window={Syncord:{common:{react:{React:{useSyncExternalStore:(_subscribe,get)=>get()}}}},stores:{DeveloperExperimentStore:Object.freeze({isDeveloper:false})},exports:[{getState:()=>state}],router:{openUserSettings:target=>{calls++;if(!window.exports.includes(root))window.exports.push(root);if(root.buildLayout()[0].usePredicate())state.currentPanelKey=target;}}};
 globalThis.document={querySelector:()=>state.currentPanelKey==='experiments_panel'?{}:null};
 const disposals=[];api.Experiments.start({disposable:fn=>disposals.push(fn),patch:{after:(...args)=>{const off=api.patchAfter(...args);disposals.push(off);return off;}},log:{warn(){}}});
 assert.equal(await api.openNative(),true);assert.equal(calls,2);assert.equal(disposals.length,4);
 for(const off of disposals.reverse())off();assert.equal(root.buildLayout,original);
});
test('an already-mounted native settings tree refreshes through unsaved-change validation without raw modal closing',async()=>{
 const section={key:'developer_section',type:1,usePredicate:()=>false,buildLayout:()=>[{key:'experiments_sidebar_item',type:2,buildLayout:()=>[{key:'experiments_panel',type:3}]}]},root={key:'$Root',type:0,analyticsKey:'user_settings',buildLayout:()=>[section]};
 const state={currentPanelKey:'account_panel',currentCategoryKey:null,scrollPositionSnapshots:new Map()};let modal=true,validations=0,opens=0,unsaved=false;
 globalThis.window={Syncord:{common:{react:{React:{useSyncExternalStore:(_subscribe,get)=>get()}}}},stores:{DeveloperExperimentStore:{isDeveloper:false}},exports:[root,{getState:()=>state}],navigation:{navigate(){},maybeWaitForAccordionExpansion(){},reset(){},accessibleDirectory:{entry:()=>null},closeWithValidation(){validations++;if(!unsaved){modal=false;window.navigation.accessibleDirectory=null;}}},modals:{hasModalOpen:()=>modal,openModalLazy(){},closeModal(){throw Error('raw close must never be used');}},router:{openUserSettings:target=>{assert.equal(modal,false);opens++;modal=true;state.currentPanelKey=target;}}};
 globalThis.document={querySelector:()=>state.currentPanelKey==='experiments_panel'?{}:null};
 const disposals=[];api.Experiments.start({disposable:fn=>disposals.push(fn),patch:{after:(...args)=>{const off=api.patchAfter(...args);disposals.push(off);return off;}},log:{warn(){}}});
 assert.equal(await api.openNative(),true);assert.equal(validations,1);assert.equal(opens,1);
 unsaved=true;window.navigation.accessibleDirectory={entry:()=>null};state.currentPanelKey='account_panel';const abort=new AbortController(),pending=api.openNative(abort.signal);queueMicrotask(()=>abort.abort());assert.equal(await pending,false);assert.equal(modal,true);assert.equal(opens,1);
 for(const off of disposals.reverse())off();
});
function lazyRouter(modals){
 const namespace={};for(const key of Object.keys(modals))Object.defineProperty(namespace,key,{enumerable:true,get:()=>modals[key]});
 const factory=function(module,exports,req){
  // openUserSettings USER_SETTINGS_MODAL_OPEN openModalLazy closeWithValidation
  const dependency=req('modals');module.exports={open:(...args)=>dependency.openModalLazy(...args)};
 };
 const req=id=>namespace;req.m={router:factory};req.c={};api.captureSettingsLoader(req);
 const adapted=req.m.router;assert.notEqual(adapted,factory);api.captureSettingsLoader(req);assert.equal(req.m.router,adapted);
 const module={exports:{}};adapted(module,module.exports,req);assert.equal(req.m.router,factory);return module.exports;
}
test('native loader discovery fails closed for unknown, ambiguous or already initialized factories',()=>{
 let calls=0;
 const factory=function(){/* openUserSettings USER_SETTINGS_MODAL_OPEN openModalLazy closeWithValidation */calls++;};
 for(const req of [()=>{},Object.assign(()=>{},{m:{other:()=>{calls++;}},c:{}}),Object.assign(()=>{},{m:{a:factory,b:factory},c:{}}),Object.assign(()=>{},{m:{router:factory},c:{router:{exports:{}}}})]){
  const before=req.m&&{...req.m};api.captureSettingsLoader(req);assert.deepEqual(req.m,before);assert.equal(calls,0);
 }
});
test('enabled at cold startup: ordinary native settings opening patches lazy exports before the first sidebar render',async()=>{
 const section={key:'developer_section',type:1,usePredicate:()=>false,buildLayout:()=>[{key:'experiments_sidebar_item',type:2,buildLayout:()=>[{key:'experiments_panel',type:3}]},{key:'developer_options_sidebar_item',type:2}]};
 const root={key:'$Root',type:0,analyticsKey:'user_settings',buildLayout:()=>[section]},original=root.buildLayout;
 const modals={hasModalOpen(){return false;},closeModal(){},async openModalLazy(loader,options){const render=await loader('native-loader-argument');return render(options);}},originalOpen=modals.openModalLazy;
 const ctxFor=disposals=>({disposable:fn=>disposals.push(fn),patch:{after:(...args)=>{const off=api.patchAfter(...args);disposals.push(off);return off;}},log:{warn(){}}});
 globalThis.window={Syncord:{common:{react:{React:{useSyncExternalStore:(_subscribe,get)=>get()}}}},stores:{DeveloperExperimentStore:Object.freeze({isDeveloper:false})},exports:[],modals};
 const router=lazyRouter(modals);const disposals=[];api.Experiments.start(ctxFor(disposals));assert.equal(root.buildLayout,original);assert.equal(api.running(),true);
 const unrelated=async()=>()=>42;await router.open(unrelated,{modalKey:'OTHER_MODAL'});assert.equal(root.buildLayout,original);
 const load=async arg=>{assert.equal(arg,'native-loader-argument');await Promise.resolve();window.exports=[root];return()=>root.buildLayout()[0];};
 const native=await router.open(load,{modalKey:'USER_SETTINGS_MODAL_MODAL_KEY'});
 assert.equal(native.usePredicate(),true);assert.deepEqual(native.buildLayout().map(x=>x.key),['experiments_sidebar_item']);assert.equal(section.usePredicate(),false);
 const patched=root.buildLayout,count=disposals.length;
 for(let i=0;i<4;i++){assert.equal((await router.open(load,{modalKey:'USER_SETTINGS_MODAL_MODAL_KEY'})).usePredicate(),true);assert.equal(root.buildLayout,patched);assert.equal(disposals.length,count);}
 await assert.rejects(router.open(async()=>{throw Error('native load failed');},{modalKey:'USER_SETTINGS_MODAL_MODAL_KEY'}),/native load failed/);
 for(const off of disposals.reverse())off();assert.equal(root.buildLayout,original);assert.equal(modals.openModalLazy,originalOpen);assert.equal(api.running(),false);
 // A second cold boot must not depend on any root cached in the first boot.
 window.exports=[];const next=[];api.Experiments.start(ctxFor(next));assert.equal((await router.open(load,{modalKey:'USER_SETTINGS_MODAL_MODAL_KEY'})).usePredicate(),true);
 for(const off of next.reverse())off();assert.equal(root.buildLayout,original);assert.equal(modals.openModalLazy,originalOpen);
 let received;modals.openModalLazy=(...args)=>{received=args;return 42;};
 const loader=async()=>{},options={modalKey:'USER_SETTINGS_MODAL_MODAL_KEY'};
 assert.equal(router.open(loader,options),42);assert.deepEqual(received,[loader,options]);
});
test('disabling while native settings import is pending cannot install a late hook',async()=>{
 const root={key:'$Root',type:0,analyticsKey:'user_settings',buildLayout:()=>[]},original=root.buildLayout;
 let resolve;const loaded=new Promise(done=>{resolve=done;});
 const modals={hasModalOpen(){},closeModal(){},async openModalLazy(loader){return(await loader())();}},originalOpen=modals.openModalLazy;
 globalThis.window={Syncord:{common:{react:{React:{useSyncExternalStore:(_subscribe,get)=>get()}}}},exports:[],modals};
 const router=lazyRouter(modals);const disposals=[];api.Experiments.start({disposable:fn=>disposals.push(fn),patch:{after(){assert.fail('late patch after stop');}},log:{warn(){}}});
 const pending=router.open(async()=>{await loaded;window.exports=[root];return()=>17;},{modalKey:'USER_SETTINGS_MODAL_MODAL_KEY'});
 for(const off of disposals.reverse())off();resolve();assert.equal(await pending,17);assert.equal(root.buildLayout,original);assert.equal(modals.openModalLazy,originalOpen);assert.equal(api.nativeAccessInstalled(),false);
});
test('default-off non-core plugin lifecycle and 18 complete local catalogs',()=>{
 assert.equal(api.Experiments.id,'experiments');assert.equal(api.Experiments.enabledByDefault,false);assert.notEqual(api.Experiments.core,true);
 assert.deepEqual(api.Experiments.permissions,{webpackPatch:true,discordStores:['ExperimentStore','DeveloperExperimentStore'],discordActions:['user-settings']});
 globalThis.window={};const disposals=[];api.Experiments.start({disposable:fn=>disposals.push(fn)});assert.equal(disposals.length,3);for(const off of disposals.reverse())off();
 assert.equal(Object.keys(api.experimentMessages).length,18);for(const [locale,values]of Object.entries(api.experimentMessages)){assert.equal(values.length,api.experimentKeys.length,locale);assert.ok(values.every(x=>typeof x==='string'&&x.trim()),locale);}
 const imports=readFileSync('src/renderer/plugins/index.ts','utf8');assert.equal((imports.match(/import "\.\/experiments"/g)||[]).length,1);
});
