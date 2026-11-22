import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import path from 'node:path';import {tmpdir} from 'node:os';
const dir=mkdtempSync(path.join(tmpdir(),'syncord-spotify-'));
const stub={name:'native-webpack-fixture',setup(b){b.onResolve({filter:/webpack$/},a=>a.importer.includes('/api/spotify/')?{path:'webpack-fixture',namespace:'fixture'}:undefined);b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const beforeWebpackReady=fn=>globalThis.spotifyHooks.push(fn);export const findByStoreName=()=>globalThis.nativeStore;export const waitFor=()=>()=>{};',loader:'js'}));}};
globalThis.spotifyHooks=[];
await build({stdin:{resolveDir:process.cwd(),contents:'export * from "./src/renderer/api/spotify";export * from "./src/renderer/api/spotify/transport";export * from "./src/renderer/plugins/spotifyControls/spring";'},bundle:true,platform:'node',format:'esm',outfile:dir+'/api.mjs',plugins:[stub],logLevel:'silent'});
const api=await import(dir+'/api.mjs');test.after(()=>{rmSync(dir,{recursive:true,force:true});delete globalThis.window;delete globalThis.nativeStore;delete globalThis.spotifyHooks;});
const item={id:'1234567890123456789012',type:'track',name:'Track <img onerror=bad()>',duration_ms:200000,artists:[{name:'Artist'}],album:{images:[{url:'https://i.scdn.co/image/cover'}]}};
const raw=()=>({item,progress_ms:30000,is_playing:true,repeat_state:'context',shuffle_state:false,device:{id:'device-a',is_active:true,is_restricted:false,supports_volume:true,volume_percent:45},actions:{disallows:{}}});
test('Spotify projection retains only bounded public playback fields and measures paused/playing progress',()=>{
 const s=api.applyPlayer({...api.emptyPlayback(),connected:true,premium:true},raw(),1000);assert.equal(s.track.name,item.name);assert.equal(s.track.cover,'https://i.scdn.co/image/cover');assert.equal(s.repeat,'context');assert.equal(s.shuffle,false);assert.equal(api.positionAt(s,6000),35000);assert.equal(api.positionAt({...s,playing:false},6000),30000);assert.equal(api.positionAt(s,999999),200000);
 assert.equal(api.spotifyLink(s.track),'https://open.spotify.com/track/1234567890123456789012');assert.equal(api.spotifyLink({...s.track,id:'../../x'}),null);
 for(const u of ['javascript:bad()','http://i.scdn.co/x','https://i.scdn.co.evil.invalid/x','https://user:secret@i.scdn.co/x'])assert.equal(api.coverUrl(u),'');
 const project=api.applyPlayer(s,{...raw(),account:{accessToken:'private'},accessToken:'private',headers:{authorization:'private'}});assert(!JSON.stringify(project).includes('private'));
 assert.equal(api.applyPlayer(s,{...raw(),is_playing:false}).track.id,item.id);
 assert.equal(api.applyPlayer(s,{...raw(),item:null}).track,null);
});
test('fixed Spotify command descriptors validate scalars, capabilities, device restrictions and precise repeat',()=>{
 assert.deepEqual(api.commandRequest({kind:'seek',value:4500},200000),{method:'put',route:'seek',query:{position_ms:4500}});
 assert.deepEqual(api.commandRequest({kind:'next'},200000),{method:'post',route:'next'});
 for(const c of [{kind:'seek',value:NaN},{kind:'seek',value:-1},{kind:'seek',value:300000},{kind:'volume',value:101},{kind:'volume',value:Infinity},{kind:'repeat',value:'evil'},{kind:'shuffle',value:'true'},{kind:'arbitrary',url:'https://evil.invalid'}])assert.throws(()=>api.commandRequest(c,200000));
 const s=api.applyPlayer({...api.emptyPlayback(),connected:true,premium:true},raw());assert(api.canControl(s,'next',true));assert(!api.canControl(s,'next',false));
 for(const patch of [{connected:false},{premium:false},{restricted:true},{busy:true},{deviceId:''},{track:null}])assert(!api.canControl({...s,...patch},'play',true));
 assert(!api.canControl({...s,disallows:{seeking:true}},'seek',true));assert(!api.canControl({...s,shuffle:null},'shuffle',true));assert(!api.canControl({...s,volumeSupported:false},'volume',true));
});
function nativeFactory(module,exports,require){
 const signals=['PLAYER_DEVICES','SPOTIFY_SET_ACTIVE_DEVICE','onlyRetryOnAuthorizationErrors'];void signals;
 const http=require('native-http').Bo;
 const wrap=method=>async(account,credential,options)=>{const response=await method({...options,headers:{authorization:'Bearer '+credential}});if(response.status===202)throw Error('native retry would duplicate command');return response;};
 module.exports={opaque:{get:wrap(http.get),put:wrap(http.put)}};
}
test('native Spotify factory adapter is scoped, one-shot, strips POST marker, normalizes accepted skip and never loads factories early',async()=>{
 const calls=[],http={get:async o=>({status:200,body:raw()}),put:async o=>{calls.push(['put',o]);return {status:204};},post:async o=>{calls.push(['post',o]);return {status:202};}};
 const req=id=>({Bo:http});req.m={native:nativeFactory};req.c={};spotifyHooks[0](req);assert.notEqual(req.m.native,nativeFactory);assert.equal(calls.length,0);
 const module={exports:{}};req.m.native(module,module.exports,req);assert.equal(req.m.native,nativeFactory);assert.equal(api.nativeSpotifyTransport().post,true);
 const dispose=api.useSpotifyTransport();
 await api.nativeSpotifyTransport().put('account','fake-secret',api.postOptions({url:'https://api.spotify.com/v1/me/player/next'}));
 assert.equal(calls[0][0],'post');assert.equal(Object.getOwnPropertySymbols(calls[0][1]).length,0);assert.equal(calls[0][1].headers.authorization,'Bearer fake-secret');
 await api.nativeSpotifyTransport().put('account','fake-secret',{url:'https://api.spotify.com/v1/me/player/pause'});assert.equal(calls[1][0],'put');
 await assert.rejects(()=>api.nativeSpotifyTransport().put('account','fake-secret',api.postOptions({url:'https://evil.invalid'})));dispose();
 await assert.rejects(()=>api.nativeSpotifyTransport().put('account','fake-secret',api.postOptions({url:'https://api.spotify.com/v1/me/player/next'})));assert.equal(calls.length,2);
 assert.equal(http.put.name,'put','Global native HTTP object is unchanged');
});
test('Spotify session uses existing native auth transiently, follows flux/socket state, rejects stale results and fully unsubscribes',async()=>{
 let body=raw(),failure=0,notify=0,secretReads=0,storeListener,active=true,deferred;const eventHandlers=new Map(),socket=new EventTarget(),calls=[];
 const native={accountId:'spotify-account',isPremium:true,socket};Object.defineProperty(native,'accessToken',{get(){secretReads++;return 'fixture-spotify-secret';}});
 globalThis.nativeStore={hasConnectedAccount:()=>active,getActiveSocketAndDevice:()=>active?{socket:native,device:body.device}:undefined,getPlayerState:()=>null,addChangeListener:fn=>storeListener=fn,removeChangeListener:fn=>{assert.equal(fn,storeListener);storeListener=undefined;}};
 globalThis.window={Syncord:{common:{flux:{FluxDispatcher:{subscribe:(key,fn)=>eventHandlers.set(key,fn),unsubscribe:(key,fn)=>{assert.equal(eventHandlers.get(key),fn);eventHandlers.delete(key);}}}}}};
 const http={get:async()=>({status:200,body}),put:async o=>{calls.push(o);if(deferred)return deferred;if(failure)throw {status:failure,request:{headers:{authorization:'private'}}};if(o.url.endsWith('/pause'))body={...body,is_playing:false};return {status:204};},post:async()=>({status:202})};
 const req=()=>({Bo:http});req.m={native:nativeFactory};req.c={};spotifyHooks[0](req);const module={exports:{}};req.m.native(module,module.exports,req);
 const session=api.createSpotifySession(()=>notify++);await new Promise(r=>setTimeout(r,0));assert.equal(session.snapshot().track.name,item.name);assert(session.can('pause'));const unchanged=notify;storeListener();storeListener();assert.equal(notify,unchanged,'unchanged store notifications are coalesced');assert(secretReads>0);assert(!JSON.stringify(session.snapshot()).includes('secret'));
 await session.command({kind:'pause'});assert.equal(session.snapshot().playing,false);assert(calls.at(-1).url.endsWith('/pause'));
 failure=403;await session.command({kind:'play'});assert.equal(session.snapshot().error,'denied');assert.equal(session.snapshot().playing,false);assert.equal(session.snapshot().busy,false);
 failure=429;await session.command({kind:'play'});assert.equal(session.snapshot().error,'rate-limit');
 socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({payloads:[{events:[{type:'PLAYER_STATE_CHANGED',event:{state:{...raw(),repeat_state:'track',shuffle_state:true}}}]}]})}));assert.equal(session.snapshot().repeat,'track');assert.equal(session.snapshot().shuffle,true);
 failure=0;let finish;deferred=new Promise(resolve=>finish=resolve);const pending=session.command({kind:'play'});active=false;eventHandlers.get('LOGOUT')();finish({status:204});await pending;assert.equal(session.snapshot().connected,false);assert.equal(session.snapshot().track,null);assert.equal(session.snapshot().busy,false);
 const n=notify;session.dispose();assert.equal(eventHandlers.size,0);assert.equal(storeListener,undefined);socket.dispatchEvent(new MessageEvent('message',{data:'{}'}));assert.equal(notify,n);
});
test('Dynamic Island spring settles, reverses without jumps, and caps long frame steps',()=>{
 let x=0,v=0;for(let i=0;i<180;i++){const r=api.springStep(x,v,1,1/60);x=r.position;v=r.velocity;}assert(Math.abs(x-1)<.001);
 const next=api.springStep(x,v,0,1/60);assert(next.position<1&&next.position>.8);assert.deepEqual(api.springStep(0,0,1,10),api.springStep(0,0,1,.064));
});
test('Dynamic Island spring preserves elapsed-time motion at 30/60/120Hz and velocity through a reversal',()=>{
 const sample=hz=>{let position=0,velocity=0;for(let i=0;i<hz/2;i++)({position,velocity}=api.springStep(position,velocity,1,1/hz));return {position,velocity};};
 const reference=sample(60);for(const hz of [30,120]){const result=sample(hz);assert(Math.abs(result.position-reference.position)<1e-10);assert(Math.abs(result.velocity-reference.velocity)<1e-10);}
 const moving=api.springStep(.55,2,0,.001);assert(moving.position>.55,'closing retains outward momentum instead of snapping');
 let position=0,velocity=0,peak=0;for(let i=0;i<120;i++){({position,velocity}=api.springStep(position,velocity,1,1/120));peak=Math.max(peak,position);}assert(peak>1&&peak<1.04,'small bounded elastic overshoot');
});
test('Spotify plugin never handles credentials or creates a separate HTTP client; Vencord source is not shipped',()=>{
 const plugin=readFileSync('src/renderer/plugins/spotifyControls/index.ts','utf8'),view=readFileSync('src/renderer/plugins/spotifyControls/view.ts','utf8');
 assert(!/accessToken|authorization|fetch\(|XMLHttpRequest|api\.spotify\.com/.test(plugin+view));assert.match(plugin,/discordActions:\s*\[\s*['"]spotify-playback['"]\s*\]/);assert(!plugin.includes('network:'));
});
