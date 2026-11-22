import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(path.join(tmpdir(),'syncord-platform-spoofer-'));
await build({stdin:{resolveDir:process.cwd(),contents:`export * from './src/renderer/plugins/platformSpoofer/model';export * from './src/renderer/plugins/platformSpoofer/runtime';export * from './src/renderer/plugins/platformSpoofer/presence';export * from './src/renderer/plugins/platformSpoofer/state';export * from './src/renderer/plugins/platformSpoofer';export {platformSpooferCatalog} from './src/renderer/i18n/platformSpoofer';export {SUPPORTED_LOCALES} from './src/shared/i18nLocale';`},bundle:true,format:'esm',platform:'neutral',outfile:path.join(dir,'model.mjs'),logLevel:'silent',plugins:[{name:'native-fixtures',setup(b){b.onResolve({filter:/\/webpack$/},()=>({path:'webpack',namespace:'fixture'}));b.onResolve({filter:/api\/plugin$/},()=>({path:'plugin',namespace:'fixture'}));b.onResolve({filter:/api\/discordEvents$/},()=>({path:'events',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:path==='webpack'?`export const beforeWebpackReady=()=>{};`:path==='plugin'?`export const definePlugin=p=>p;export const isSafeModeActive=()=>globalThis.safeMode;export const isLockdownActive=()=>globalThis.lockdown;`:`export const sharedDispatcher=()=>globalThis.flux;`}));}}]});
const M=await import(pathToFileURL(path.join(dir,'model.mjs')));
const A='1554184140704841939',B='1554184140704841940';
const active={desktop:'online',mobile:'idle',web:'dnd',vr:'online'};
function harness(){
 let account=A,allowed=true,observation=M.observe('online',{desktop:'online'},undefined),state;
 const data={},writes=[],timers=new Map();let serial=0;
 const ctx={settings:{get:key=>data[key],set:(key,v)=>{data[key]=v;writes.push(v);}}};
 const env={account:()=>account,allowed:()=>allowed,observe:()=>observation,publish:v=>{state=v;},set:(fn,ms)=>{assert.equal(ms,250);timers.set(++serial,fn);return serial;},clear:id=>timers.delete(id)};
 const engine=M.startObserver(ctx,env);
 return{engine,ctx,data,writes,timers,env,get state(){return state;},set account(v){account=v;},set allowed(v){allowed=v;},set observation(v){observation=v;},flush(){const list=[...timers.values()];timers.clear();list.forEach(fn=>fn());}};
}
try{
 test('platform choices validate, deduplicate and remain separate from actual native evidence',()=>{
  assert.deepEqual(M.selection(['mobile','desktop','mobile']),['desktop','mobile']);
  for(const v of [null,'mobile',['macos'],['android'],['xbox'],['__proto__']])assert.throws(()=>M.selection(v),/ps.invalid/);
  assert.deepEqual(M.preferences({[A]:{selectedPlatforms:['made-up']}},A),[]);
  assert.deepEqual(M.preferences({[A]:{selectedPlatforms:['mobile']}},B),[]);
  const observed=M.observe('online',{desktop:'dnd'},[{clientInfo:{client:'mobile'},status:'idle'}]);
  assert.equal(observed.evidence.desktop.status,'dnd');assert.equal(observed.evidence.mobile.source,'session');
  assert.equal(M.rowState(observed,'desktop'),'reported');assert.equal(M.rowState(observed,'mobile'),'verification');
  assert.equal(M.rowState(observed,'web'),'requiresSession');assert.equal(M.rowState(observed,'console'),'unsupported');
  assert.equal(M.rowState(observed,'vr'),'unsupported');
 });
 test('all genuine native categories, independent statuses and aliases are read without OS or activity inference',()=>{
  const frozen=Object.freeze({...active,embedded:'dnd'}),result=M.observe('dnd',frozen,undefined);
  assert.deepEqual(Object.keys(result.evidence),M.PLATFORMS);
  assert.equal(result.evidence.console.source,'presence');assert.equal(result.evidence.mobile.status,'idle');
  const byOS=M.observe('online',{},[{clientInfo:{os:'Android'},status:'online'},{clientInfo:{client:'unknown',os:'Windows'},status:'online'}]);
  assert.deepEqual(byOS.evidence,{});assert.deepEqual(frozen,{...active,embedded:'dnd'});
 });
 test('offline/invisible suppress stale clients and sessions; unknown visibility never becomes remotely confirmed',()=>{
  for(const state of ['offline','invisible'])assert.deepEqual(M.observe(state,active,[{status:'online',clientInfo:{client:'mobile'}}]).evidence,{});
  assert.deepEqual(M.observe('online',active,[{status:'invisible',clientInfo:{client:'desktop'}}]).evidence,{});
  assert.equal(M.rowState(M.observe(undefined,active,undefined),'mobile'),'verification');
  assert.deepEqual(M.observe('online',{mobile:'offline',web:123},{}).evidence,{});
  assert.equal(M.observe(undefined,undefined,undefined).available,false);
 });
 test('native store adapters preserve receivers and never access session identifiers or unrelated fields',()=>{
  const never=()=>{throw Error('sensitive getter accessed');};let reads=0;
  const session={status:'online',clientInfo:{client:'mobile'}};Object.defineProperty(session,'sessionId',{get:never});Object.defineProperty(session,'credential',{get:never});
  const users={getCurrentUser(){assert.equal(this,users);return{id:A};}};
  const presence={getStatus(id){assert.equal(this,presence);assert.equal(id,A);return'online';},getClientStatus(id){assert.equal(this,presence);reads++;return{desktop:'online'};}};
  globalThis.window={Syncord:{common:{stores:{UserStore:users,PresenceStore:presence,SessionsStore:{getSessions:()=>({one:session})}}}}};
  assert.equal(M.ownAccount(),A);const value=M.ownObservation(A);assert.equal(reads,1);assert.equal(value.evidence.mobile.status,'online');assert.ok(!JSON.stringify(value).includes('sessionId'));
  assert.equal(M.ownObservation(B).available,false);
  presence.getClientStatus=()=>{users.getCurrentUser=()=>({id:B});return{mobile:'online'};};assert.equal(M.ownObservation(A).available,false);
 });
 test('Apply stores account-scoped preferences once after debounce, never reports a presence change or writes platform stores',()=>{
  const h=harness(),native=structuredClone(h.state.evidence);assert.equal(h.writes.length,0);
  assert.equal(h.engine.apply(['mobile'],A),true);assert.equal(h.engine.apply(['desktop','mobile','vr','console'],A),true);assert.equal(h.timers.size,1);
  h.flush();assert.equal(h.writes.length,1);assert.deepEqual(h.data.accounts[A].selectedPlatforms,['desktop','mobile','vr','console']);assert.deepEqual(h.state.evidence,native);assert.equal(h.state.result,'saved');
  h.engine.apply([],A,true);h.flush();assert.deepEqual(h.data.accounts[A].selectedPlatforms,[]);assert.deepEqual(h.state.evidence,native);assert.equal(h.state.result,'restored');h.engine.dispose();
 });
 test('account switch, logout, disconnect, Safe Mode, Lockdown and disable cancel pending writes and clear stale evidence',async()=>{
  for(const event of ['switch','LOGOUT','CONNECTION_CLOSED','CONNECTION_LOST','safety','disable']){
   const h=harness();h.engine.apply(['mobile'],A);
   if(event==='switch'){h.account=B;h.engine.event({type:'CURRENT_USER_UPDATE'});assert.deepEqual(h.state.selected,[]);}
   else if(event==='safety'){h.allowed=false;h.engine.refresh();}
   else if(event==='disable')h.engine.dispose();else h.engine.event({type:event});
   h.flush();assert.equal(h.writes.length,0,event);assert.equal(h.engine.apply(['web'],A),false,event);
   if(event!=='switch')assert.deepEqual(h.state.evidence,{},event);h.engine.dispose();
  }
  const h=harness();h.engine.event({type:'CONNECTION_CLOSED'});assert.equal(h.state.available,false);h.engine.event({type:'CONNECTION_RESUMED'});await Promise.resolve();assert.equal(h.state.evidence.desktop.status,'online');h.engine.dispose();
 });
 test('unrelated presence traffic does no observation work; bursts coalesce after native dispatch',async()=>{
  const h=harness();let reads=0;h.env.observe=()=>{reads++;return M.observe('idle',{mobile:'idle'},undefined);};
  for(let n=0;n<100;n++)h.engine.event({type:'PRESENCE_UPDATE',user:{id:B}});await Promise.resolve();assert.equal(reads,0);
  for(let n=0;n<100;n++)h.engine.event({type:'PRESENCE_UPDATES',updates:[{user:{id:A}}]});await Promise.resolve();assert.equal(reads,1);assert.equal(h.state.evidence.mobile.status,'idle');h.engine.dispose();
 });
 test('failed persistence is reported without claiming applied changes',()=>{
  const h=harness();h.ctx.settings.set=()=>{throw Error('disk failure');};h.engine.apply(['web'],A);h.flush();assert.equal(h.state.result,'failed');assert.equal(h.writes.length,0);h.ctx.settings.get=()=>{throw Error('unreadable settings');};assert.doesNotThrow(()=>h.engine.refresh());assert.equal(h.state.result,'failed');h.engine.dispose();
 });
 test('plugin defaults off and uses a scoped identity capability with no socket, privileged bridge or idle timers',()=>{
  const subscriptions=new Map(),timers=new Map(),disposers=[];let n=0,account=A;globalThis.safeMode=false;globalThis.lockdown=false;
  globalThis.window={setTimeout:(fn)=>{timers.set(++n,fn);return n;},clearTimeout:id=>timers.delete(id),Syncord:{common:{stores:{UserStore:{getCurrentUser:()=>({id:account})},PresenceStore:{getStatus:()=> 'online',getClientStatus:()=>({desktop:'online'})}}}}};
  globalThis.flux={subscribe:(name,fn)=>subscriptions.set(name,fn),unsubscribe:(name)=>subscriptions.delete(name)};
  const data={};M.PlatformSpooferPlugin.start({plugin:M.PlatformSpooferPlugin,permissions:M.PlatformSpooferPlugin.permissions,patch:{after(){throw Error('No native builder in this fixture');}},settings:{get:k=>data[k],set:(k,v)=>{data[k]=v;}},disposable:fn=>disposers.push(fn)});
  assert.equal(M.PlatformSpooferPlugin.enabledByDefault,false);assert.equal(M.PlatformSpooferPlugin.core,undefined);assert.deepEqual(M.PlatformSpooferPlugin.permissions,{webpackPatch:true,userData:true,discordStores:['UserStore','PresenceStore','SessionsStore','AuthenticationStore','GatewayConnectionStore']});
  assert.equal(timers.size,0);assert.equal(M.spooferState().account,A);assert.equal(M.saveSelection(['mobile'],A),true);assert.equal(timers.size,1);
  account=B;subscriptions.get('CURRENT_USER_UPDATE')({type:'CURRENT_USER_UPDATE'});assert.equal(timers.size,0);assert.deepEqual(M.spooferState().selected,[]);
  globalThis.lockdown=true;assert.equal(M.saveSelection(['mobile'],B),false);
  disposers.reverse().forEach(fn=>fn());assert.equal(subscriptions.size,0);assert.equal(timers.size,0);assert.equal(M.spooferState().running,false);assert.equal(M.saveSelection(['mobile'],B),false);
 });
 test('all 18 catalogs are complete and the plugin contains no socket, credential, presence-store or reconnect mutation path',()=>{
  const english=Object.keys(M.platformSpooferCatalog('en-US'));
  for(const locale of M.SUPPORTED_LOCALES){const catalog=M.platformSpooferCatalog(locale);assert.deepEqual(Object.keys(catalog),english);assert.ok(Object.values(catalog).every(v=>typeof v==='string'&&v.trim()));}
  for(const name of ['index','runtime','presence','model','state','panel']){const source=readFileSync('src/renderer/plugins/platformSpoofer/'+name+'.ts','utf8');assert.doesNotMatch(source,/new WebSocket|\.send\(|\.sessionId\s*=|\.seq\s*=|client_status\s*=|getToken|SyncordNative|ctx\.patch|setInterval|fetch\(/);}
 });
}finally{rmSync(dir,{recursive:true,force:true});}
