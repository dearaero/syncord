import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';
const dir=mkdtempSync(tmpdir()+'/syncord-game-');
await build({stdin:{resolveDir:process.cwd(),contents:`export * from './src/renderer/api/gameSimulation';export * from './src/renderer/plugins/customGamePresence/settings';export * from './src/renderer/plugins/customGamePresence/search';export * from './src/renderer/plugins/customGamePresence/discord';export * from './src/renderer/plugins/customGamePresence/state';export * from './src/renderer/plugins/customGamePresence';`},bundle:true,platform:'node',format:'esm',outfile:dir+'/test.mjs',logLevel:'silent',plugins:[{name:'fixture',setup(b){b.onResolve({filter:/api\/plugin$/},()=>({path:'plugin',namespace:'fixture'}));b.onResolve({filter:/api\/settings$/},()=>({path:'settings',namespace:'fixture'}));b.onResolve({filter:/globalMessageSearch\/discord$/},()=>({path:'account',namespace:'fixture'}));b.onResolve({filter:/multiChatCanvas\/discord$/},()=>({path:'user',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:({plugin:'export const definePlugin=p=>p;',settings:'export const settings={get:(k,f)=>globalThis.saved[k]??f,set:(k,v)=>{globalThis.saved[k]=v;}};',account:'export function watchAccount(fn){globalThis.accounts.add(fn);return()=>globalThis.accounts.delete(fn);}',user:'export const currentUserId=()=>globalThis.account;'}[a.path])}));}}]});
const G=await import(dir+'/test.mjs');test.after(()=>rmSync(dir,{recursive:true,force:true}));
const A='100000000000000001',B='100000000000000002',ID='200000000000000001',ID2='200000000000000002',game={id:ID,name:'Game <img>',icon:'a'.repeat(32)},game2={id:ID2,name:'Second'};
function fixture(real=[]){
 const hooks=new Map(),events=[];let games=[...real];
 const store={getRunningGames:()=>games,getGameForPID:pid=>games.find(g=>g.pid===pid),getVisibleGame:()=>games[0]??null,getVisibleRunningGames:()=>games,getCandidateGames:()=>games,getRunningDiscordApplicationIds:()=>new Set(games.map(g=>g.id))};const originals={...store};
 const dispatcher={subscribe:(e,fn)=>{if(!hooks.has(e))hooks.set(e,new Set());hooks.get(e).add(fn);},unsubscribe:(e,fn)=>{hooks.get(e)?.delete(fn);if(!hooks.get(e)?.size)hooks.delete(e);},dispatch:e=>{events.push(e);if(e.type==='RUNNING_GAMES_CHANGE')games=e.games;for(const fn of hooks.get(e.type)??[])fn(e);}};
 const context=()=>{const off=[];return{permissions:{webpackPatch:true},log:{warn(){}},disposable:f=>off.push(f),off,stop(){for(const fn of off.splice(0).reverse())fn();}};};return{store,dispatcher,events,hooks,context,originals};
}
const flush=()=>new Promise(setImmediate);
test('shared game lease sets one timestamp, preserves real/new games, returns typed lists/PIDs, and removes only its own activity',async()=>{
 const real={id:'300000000000000001',name:'Real',pid:15},later={id:'300000000000000002',name:'Later',pid:16};const f=fixture([real]),ctx=f.context(),start=Date.now()-1000000;
 const release=G.simulateGame(ctx,f.store,f.dispatcher,game,start,'custom');const fake=f.store.getVisibleGame();assert.equal(fake.start,start);assert.notEqual(fake.pid,15);assert.deepEqual(f.store.getRunningGames(),[real,fake]);assert.equal(f.store.getGameForPID(fake.pid),fake);assert.equal(f.store.getGameForPID(15),real);assert.equal(f.store.getCandidateGames().filter(g=>g.id===ID).length,1);assert.ok(f.store.getRunningDiscordApplicationIds() instanceof Set);
 const activity=f.events.find(e=>e.type==='LOCAL_ACTIVITY_UPDATE'&&e.activity);assert.equal(activity.activity.timestamps.start,start);assert.equal(activity.socketId,'Syncord-game-custom');assert.notEqual(activity.socketId,null);
 const n=f.events.length;await flush();assert.equal(f.events.length,n,'no periodic publication');
 f.dispatcher.dispatch({type:'RUNNING_GAMES_CHANGE',games:[real,later,fake],removed:[],added:[later]});await flush();release();release();assert.deepEqual(f.store.getRunningGames(),[real,later]);assert.equal(f.hooks.size,0);for(const k of Object.keys(f.originals))assert.equal(f.store[k],f.originals[k]);ctx.stop();
});
test('quests preempt only custom simulation; stopping either owner never unpatches the other, and resume retains original time',()=>{
 for(const stopCustom of [true,false]){const f=fixture(),custom=f.context(),quest=f.context(),states=[],start=Date.now()-1000000;
 const off=G.simulateGame(custom,f.store,f.dispatcher,game,start,'custom',false,(on,why)=>states.push([on,why]));const customPid=f.store.getVisibleGame().pid;
 const offQuest=G.simulateGame(quest,f.store,f.dispatcher,game2,Date.now(),'quest');const questPid=f.store.getVisibleGame().pid;assert.notEqual(customPid,questPid);assert.equal(f.store.getRunningGames().length,1);assert.equal(f.store.getVisibleGame().id,ID2);assert.deepEqual(states.at(-1),[false,'quest']);
 if(stopCustom){custom.stop();assert.equal(f.store.getVisibleGame().id,ID2);offQuest();}else{quest.stop();assert.equal(f.store.getVisibleGame().id,ID);assert.equal(f.store.getVisibleGame().start,start);off();}
 custom.stop();quest.stop();assert.deepEqual(f.store.getRunningGames(),[]);assert.equal(f.hooks.size,0);
 }
});
test('real-game priority pauses/restarts on native events; repeated switches retain one disposer and no duplicate virtual games',async()=>{
 const f=fixture(),ctx=f.context();G.simulateGame(ctx,f.store,f.dispatcher,game,Date.now(),'custom',true);const real={id:ID2,name:'Real',pid:123};f.dispatcher.dispatch({type:'RUNNING_GAMES_CHANGE',games:[real],added:[real],removed:[]});await flush();assert.equal(f.store.getVisibleGame(),real);assert.deepEqual(f.store.getRunningGames(),[real]);f.dispatcher.dispatch({type:'RUNNING_GAMES_CHANGE',games:[],added:[],removed:[real]});await flush();assert.equal(f.store.getVisibleGame().id,ID);
 for(let n=0;n<100;n++)G.simulateGame(ctx,f.store,f.dispatcher,n%2?game:game2,Date.now(),'custom');assert.equal(f.store.getRunningGames().length,1);assert.equal(ctx.off.length,1);ctx.stop();assert.deepEqual(f.store.getRunningGames(),[]);assert.equal(f.hooks.size,0);
});
test('invalid durations/settings and absent permissions fail closed; account preferences are isolated and runtime fields never persisted',()=>{
 globalThis.saved={};globalThis.window=new EventTarget();
 assert.equal(G.seconds(1000,'seconds'),1000);assert.equal(G.seconds(30,'minutes'),1800);assert.equal(G.seconds(8,'hours'),28800);for(const value of [-1,NaN,Infinity,Number.MAX_VALUE,0.1])assert.throws(()=>G.seconds(value,'seconds'));
 G.saveConfig(A,{selected:game,initialSeconds:1000,timeUnit:'seconds',favorites:[game],recent:[game]});assert.equal(G.config(A).selected.id,ID);assert.equal(G.config(B).selected,undefined);assert.equal(G.config(A).initialSeconds,1000);assert.ok(!JSON.stringify(saved).includes('pid'));assert.ok(!JSON.stringify(saved).includes('start'));
 const f=fixture();assert.throws(()=>G.simulateGame({...f.context(),permissions:{}},f.store,f.dispatcher,game,Date.now(),'custom'),/game.unavailable/);assert.equal(f.hooks.size,0);
});
test('catalog uses bounded native cached stores, case-insensitive UI search and verified exact IDs; unsupported manual input never publishes',async()=>{
 const calls=[];const api={get:async args=>{calls.push(args);return{status:200,body:[game]};},post(){},put(){},patch(){},del(){}};
 globalThis.window={Syncord:{webpack:{findByStoreName:name=>name==='ApplicationStore'?{getApplications:()=>[game,game,game2,{id:'bad',name:'bad'}]}:undefined,find:fn=>fn(api)?api:undefined}}};
 assert.deepEqual(G.cachedGames().map(g=>g.id),[ID,ID2]);assert.equal((await G.resolveGame(ID,new AbortController().signal)).name,game.name);assert.equal(calls.length,1);await G.resolveGame(ID,new AbortController().signal);assert.equal(calls.length,1);await assert.rejects(G.resolveGame('bad',new AbortController().signal),/game.invalid_id/);await assert.rejects(G.resolveGame(ID2,new AbortController().signal),/game.lookup_failed/);
 assert.equal(G.iconUrl({id:ID,name:'x',icon:undefined}),'');assert.equal(G.gameValue({id:ID,name:'Catalog game',icon_hash:'b'.repeat(32)}).icon,'b'.repeat(32));assert.equal(G.gameValue({id:ID,name:'Bad icon',icon_hash:'https://untrusted.invalid/x'}).icon,undefined);assert.match(G.iconUrl(game),/^https:\/\/cdn.discordapp.com\/app-icons\//);
});
test('plugin ignores stale lookups, switches accounts, does not reset time for favorites, and fully stops without quest APIs',async()=>{
 const f=fixture(),ctx=f.context();globalThis.saved={};globalThis.account=A;globalThis.accounts=new Set();const target=new EventTarget();globalThis.window=target;
 let resolve;const api={get:args=>{assert.ok(args.url.startsWith('/applications/public?application_ids='));return new Promise(r=>resolve=r);},post(){throw Error('no quests');},put(){},patch(){},del(){}};
 target.Syncord={common:{stores:{RunningGameStore:f.store}},webpack:{findByStoreName:()=>undefined,findByProps:()=>f.dispatcher,find:fn=>fn(api)?api:undefined}};
 G.saveConfig(A,{selected:game2,initialSeconds:1000});G.CustomGamePresencePlugin.start(ctx);await flush();assert.equal(G.gameState().status,'game.switching');account=B;for(const fn of accounts)fn();resolve({body:[game2]});await flush();assert.deepEqual(f.store.getRunningGames(),[]);
 G.saveConfig(B,{selected:game,initialSeconds:1000,realPriority:false});await flush();assert.equal(G.gameState().status,'game.playing');const start=f.store.getVisibleGame().start;assert.ok(Math.abs(Date.now()-start-1000000)<100);
 G.saveConfig(B,{favorites:[game]});await flush();assert.equal(f.store.getVisibleGame().start,start);assert.equal(f.store.getRunningGames().length,1);
 ctx.stop();assert.equal(G.gameState().status,'game.disabled');assert.equal(accounts.size,0);assert.equal(f.hooks.size,0);assert.deepEqual(f.store.getRunningGames(),[]);delete globalThis.window;
});
test('missing Discord modules report unavailable, stop cancels discovery, and re-enable resets the configured starting duration',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:2000000});globalThis.saved={};globalThis.account=A;globalThis.accounts=new Set();const target=new EventTarget();globalThis.window=target;target.Syncord={common:{stores:{}},webpack:{findByStoreName:()=>undefined,findByProps:()=>undefined}};
 const f=fixture(),ctx=f.context();G.saveConfig(A,{selected:game,initialSeconds:1000});G.CustomGamePresencePlugin.start(ctx);
 for(let n=0;n<8;n++){t.mock.timers.tick(1000);await flush();}assert.equal(G.gameState().status,'game.unavailable');ctx.stop();assert.equal(accounts.size,0);
 const pending=f.context();G.CustomGamePresencePlugin.start(pending);pending.stop();t.mock.timers.tick(10000);await flush();assert.equal(G.gameState().status,'game.disabled');assert.equal(accounts.size,0);
 target.Syncord.common.stores.RunningGameStore=f.store;target.Syncord.webpack.findByProps=()=>f.dispatcher;
 for(let n=0;n<3;n++){const context=f.context();G.CustomGamePresencePlugin.start(context);await flush();const start=f.store.getVisibleGame().start;assert.equal(Date.now()-start,1000000);const publications=f.events.length;t.mock.timers.tick(10000);await flush();assert.equal(Date.now()-start,1010000);assert.equal(f.events.length,publications);context.stop();assert.equal(f.hooks.size,0);assert.deepEqual(f.store.getRunningGames(),[]);assert.equal(accounts.size,0);}
});
test('native lookups have a bounded wait, abort immediately, and never cache a cancelled response',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const id='200000000000000004';let finish,calls=0;
 const api={get:()=>{calls++;return new Promise(r=>finish=r);},post(){},put(){},patch(){},del(){}};globalThis.window={Syncord:{webpack:{find:fn=>fn(api)?api:undefined}}};
 const abort=new AbortController(),first=G.resolveGame(id,abort.signal);abort.abort();await assert.rejects(first,/game.cancelled/);assert.equal(calls,1);
 finish({body:[{id,name:'Fourth'}]});await flush();const timeout=G.resolveGame(id,new AbortController().signal);assert.equal(calls,2,'cancelled response was not cached');const rejected=assert.rejects(timeout,/game.lookup_failed/);t.mock.timers.tick(15000);await rejected;finish({body:[{id,name:'Fourth'}]});await flush();
});
test('registration is unique, default-off and explicit; Auto Quests uses the common coordinator without stale snapshots',()=>{
 const index=readFileSync('src/renderer/plugins/index.ts','utf8'),quest=readFileSync('src/renderer/plugins/autoQuests/index.ts','utf8');assert.equal(index.split('import "./customGamePresence"').length-1,1);assert.equal(G.CustomGamePresencePlugin.enabledByDefault,false);assert.equal(G.CustomGamePresencePlugin.permissions.webpackPatch,true);assert.equal(G.CustomGamePresencePlugin.permissions.network,undefined);assert.ok(quest.includes('release=simulateGame'));assert.ok(!quest.includes('games: originalGames'));
});

test('real plugin manager stops Custom Game Presence on Safe Mode/Lockdown and refuses restart while restricted',async()=>{
 await build({stdin:{resolveDir:process.cwd(),contents:"export * from './src/renderer/api/plugin/manager';import './src/renderer/plugins/customGamePresence';export * from './src/renderer/plugins/customGamePresence/settings';"},bundle:true,platform:'node',format:'esm',outfile:dir+'/manager.mjs',loader:{'.png':'dataurl'},logLevel:'silent',plugins:[{name:'settings-only',setup(b){b.onResolve({filter:/api\/settings$|^\.\.\/settings$/},()=>({path:'settings',namespace:'fixture'}));b.onResolve({filter:/multiChatCanvas\/discord$/},()=>({path:'user',namespace:'fixture'}));b.onResolve({filter:/globalMessageSearch\/discord$/},()=>({path:'account',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:({settings:'export const settings={get:(k,f)=>globalThis.saved[k]??f,set:(k,v)=>globalThis.saved[k]=v,flush:async()=>{}};',user:'export const currentUserId=()=>globalThis.account;',account:'export const watchAccount=fn=>{globalThis.accounts.add(fn);return()=>globalThis.accounts.delete(fn);};'}[a.path])}));}}]});
 globalThis.saved={};globalThis.account=A;globalThis.accounts=new Set();const target=new EventTarget(),f=fixture();globalThis.window=target;target.Syncord={common:{stores:{RunningGameStore:f.store}},webpack:{findByProps:()=>f.dispatcher,find:fn=>{const api={get:async()=>({body:[game]}),post(){},put(){},patch(){},del(){}};return fn(api)?api:undefined;}}};
 const M=await import(dir+'/manager.mjs');M.saveConfig(A,{selected:game,realPriority:false});await M.enable('custom-game-presence');await flush();assert.equal(f.store.getRunningGames().length,1);
 M.setSafeMode(true);await M.stopNonCore();assert.deepEqual(f.store.getRunningGames(),[]);assert.equal(accounts.size,0);await M.enable('custom-game-presence');assert.deepEqual(f.store.getRunningGames(),[]);
 M.setSafeMode(false);await M.enable('custom-game-presence');await flush();assert.equal(f.store.getRunningGames().length,1);M.armLockdown();await M.stopNonCore();assert.deepEqual(f.store.getRunningGames(),[]);await M.enable('custom-game-presence');assert.deepEqual(f.store.getRunningGames(),[]);assert.equal(f.hooks.size,0);assert.equal(accounts.size,0);
});

test('game search ranks exact, prefixes, abbreviations and typo matches; folding, stable limits and deduplication stay bounded',()=>{
 const names=['Minecraft Dungeons','Cyberpunk 2077','Minecraft','Grand Theft Auto V','Red Dead Redemption 2','Café Racer','İSTANBUL Driver','Unrelated'];const games=names.map((name,i)=>({id:String(400000000000000000n+BigInt(i)),name}));
 const results=q=>G.searchGames(games,q).map(g=>g.name);
 assert.equal(results('minecraft')[0],'Minecraft');assert.deepEqual(results('mINE'),['Minecraft','Minecraft Dungeons']);assert.ok(results('minecrfat').includes('Minecraft'));assert.equal(results('cyberpnuk')[0],'Cyberpunk 2077');assert.equal(results('gta v')[0],'Grand Theft Auto V');assert.equal(results('gta')[0],'Grand Theft Auto V');assert.equal(results('cafe')[0],'Café Racer');assert.equal(results('istanbul')[0],'İSTANBUL Driver');assert.equal(results('red dead redemtion')[0],'Red Dead Redemption 2');
 assert.deepEqual(results('zz'),[]);assert.deepEqual(results('nonexistent qzx game'),[]);assert.equal(G.searchGames(games,games[4].id)[0].id,games[4].id);assert.equal(G.searchGames([...games,...games],'').length,games.length);assert.equal(G.searchGames(games,'',2).length,2);assert.equal(G.searchGames(games,'',0).length,0);assert.deepEqual(G.searchGames(games,'x'.repeat(500)),[]);
 const many=Array.from({length:15000},(_,i)=>({id:String(500000000000000000n+BigInt(i)),name:'Example game '+i}));assert.equal(G.searchGames(many,'example').length,30);
});

test('native game catalog: empty stores, late Cyberpunk entry, single flight, abort isolation, cache, bounded failure and retry',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1800000000000});
 let finish,calls=0;const rest={get:args=>{assert.equal(args.url,'/applications/detectable');calls++;return new Promise(resolve=>finish=resolve);},post(){},put(){},patch(){},del(){}};
 globalThis.window={Syncord:{webpack:{find:fn=>fn(rest)?rest:undefined,findByStoreName:()=>undefined}}};
 assert.deepEqual(G.cachedGames(),[]);
 const cancelled=new AbortController(),other=new AbortController();
 const first=G.loadGames(cancelled.signal),second=G.loadGames(other.signal);const rejected=assert.rejects(first,/game.cancelled/);cancelled.abort();await rejected;await flush();assert.equal(calls,1);
 const data=Array.from({length:16000},(_,i)=>({id:String(600000000000000000n+BigInt(i)),name:'Other game '+i}));data.push({id:'787443973538971748',name:'Cyberpunk 2077'},null,{id:'invalid',name:'Bad'});
 finish({status:200,body:data});const catalog=await second;assert.equal(catalog.length,16001);assert.equal(G.searchGames(catalog,'cyber')[0].name,'Cyberpunk 2077');assert.ok(Object.isFrozen(catalog));await G.loadGames(other.signal);assert.equal(calls,1);
 t.mock.timers.tick(30*60*1000+1);const failure=G.loadGames(other.signal);await flush();finish({status:429,body:{retry_after:1}});await assert.rejects(failure,/game.catalog_failed/);await assert.rejects(G.loadGames(other.signal),/game.catalog_failed/);assert.equal(calls,2,'failure cooldown prevents request bursts');
 t.mock.timers.tick(30001);const retry=G.loadGames(other.signal);await flush();finish({status:200,body:[{id:'787443973538971748',name:'Cyberpunk 2077'}]});assert.equal((await retry).length,1);assert.equal(calls,3);
 t.mock.timers.tick(30*60*1000+1);const waiting=G.loadGames(other.signal),timeout=assert.rejects(waiting,/game.catalog_failed/);await flush();t.mock.timers.tick(15000);await timeout;const detached=G.loadGames(new AbortController().signal);await flush();assert.equal(calls,4,'local timeout never duplicates the native in-flight request');finish({status:200,body:[{id:'787443973538971748',name:'Cyberpunk 2077'}]});await detached;
});
