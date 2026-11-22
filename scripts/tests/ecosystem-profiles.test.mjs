import test from 'node:test';
import {PNG} from 'pngjs';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.cwd(),dir=mkdtempSync(path.join(tmpdir(),'syncord-eco-profiles-'));
const exports=`export * from './src/renderer/core/profileBadges';export * from './src/renderer/api/ecosystem/art';export * from './src/renderer/api/ecosystem/badges';export {badgesForUser,clearBadgeCache} from './src/renderer/plugins/showBadges/badges';export {ECOSYSTEM_CHANGED} from './src/shared/ecosystem';export {kit,resolveTooltip} from './src/renderer/discordKit';export {mountNativeTooltip} from './src/renderer/ui/nativeTooltip';`;
await build({stdin:{resolveDir:root,contents:exports},bundle:true,platform:'neutral',format:'esm',outfile:path.join(dir,'unit.mjs'),logLevel:'silent'});
const E=await import(pathToFileURL(path.join(dir,'unit.mjs')).href);
const A='1554184140704841939',B='1554184140704841940',badge={id:'first-light',name:'First <Light>',description:'Official',art:'spark',price:25};
const drain=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};
function fixture(){globalThis.window=new EventTarget();window.Syncord={common:{stores:{UserProfileStore:{emitChange(){}}}},webpack:{getRequire:()=>undefined}};}
test.after(()=>{rmSync(dir,{recursive:true,force:true});delete globalThis.window;});

test('native profile badges preserve native arrays/receivers, isolated identities, empty profiles and local-only art',async()=>{
 fixture();let repaint=0;window.Syncord.common.stores.UserProfileStore.emitChange=()=>repaint++;
 const calls=[],stop=E.startProfileBadges(async ids=>{calls.push(ids);return Object.fromEntries(ids.map(id=>[id,[badge]]));});
 class DisplayProfile{constructor(userId,native=[]){this.userId=userId;this.native=Object.freeze(native);}getLegacyUsername(){return 'native';}getBadges(marker){assert.equal(marker,'retained');return this.native;}}
 const original=DisplayProfile.prototype.getBadges;
 try{
  E.patchProfileExports({minified:DisplayProfile});E.patchProfileExports({minified:DisplayProfile});
  const native={id:'nitro',description:'Nitro',iconSrc:'https://cdn.discordapp.com/badge-icons/native.png'},profile=new DisplayProfile(A,[native]);
  assert.equal(profile.getBadges('retained'),profile.native);await drain();
  const result=profile.getBadges('retained');assert.equal(result[0],native);assert.deepEqual(profile.native,[native]);assert.equal(result.length,2);assert.equal(result[1].description,'Syncord · First <Light>');
  assert.ok(result[1].iconSrc.startsWith('data:image/svg+xml;'));const svg=decodeURIComponent(result[1].iconSrc.split(',')[1]);assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'));assert.ok(!svg.includes('<Light>'));assert.ok(!svg.includes('http://')||svg.includes('http://www.w3.org/2000/svg'));
  assert.equal(new DisplayProfile(A).getBadges('retained').length,1);assert.equal(calls.length,1);assert.equal(repaint,1);
  new DisplayProfile('not-an-id').getBadges('retained');new DisplayProfile('18446744073709551616').getBadges('retained');assert.equal(calls.length,1);
  assert.equal(new DisplayProfile(B).getBadges('retained').length,0);await drain();assert.equal(calls.length,2);
  assert.equal(E.appendProfileBadges(result,[badge]).length,2);assert.equal(E.appendProfileBadges(null,[badge]),null);
 }finally{stop();}assert.equal(DisplayProfile.prototype.getBadges,original);assert.deepEqual(E.officialBadges(A),[]);
});

test('chat native-badge resolution does not fetch profiles for offscreen message authors',async()=>{
 fixture();let calls=0;
 class Model{constructor(profile){this.userId=profile.userId;}getBadges(){return [];}getBannerURL(){return '';}getLegacyUsername(){return '';}}
 const req=Object.assign(()=>assert.fail('No forced modules'),{c:{model:{loaded:true,exports:{Z:Model}}},m:{}});
 window.Syncord.webpack.getRequire=()=>req;window.Syncord.webpack.find=predicate=>predicate(Model)?Model:undefined;window.Syncord.common.stores.UserProfileStore.getUserProfile=()=>({userId:A,badges:[]});
 const stop=E.startProfileBadges(async()=>{calls++;return{[A]:[badge]};});
 try{E.clearBadgeCache();E.badgesForUser({id:A},null);await drain();assert.equal(calls,0);const actualProfile=new Model({userId:A});actualProfile.getBadges();await drain();assert.equal(calls,1);const badges=E.badgesForUser({id:A},null).badges;assert.equal(badges.filter(b=>b.id==='syncord:first-light').length,1);}finally{stop();E.clearBadgeCache();}
});
test('native profile records select uploaded SVGs by hash and fall back safely for invalid image identities',async()=>{
 const image='2'.repeat(64),result=E.appendProfileBadges([],[{...badge,image}]);assert.ok(result[0].iconSrc.startsWith('data:image/svg+xml;'));const data='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');await E.loadBadgeImage(image,async()=>data);assert.equal(E.appendProfileBadges([],[{...badge,image}])[0].iconSrc,data);assert.ok(E.appendProfileBadges([],[{...badge,image:'https://evil.test/x.svg'}])[0].iconSrc.startsWith('data:image/svg+xml;'));
});

test('chat and profile share one request lane/cache; stopping chat cannot clear a mounted profile',async()=>{
 fixture();const calls=[],changes=[];let releaseProfile;
 const lookup=ids=>new Promise(resolve=>calls.push({ids,resolve}));
 const chat=E.watchOfficialBadges(lookup,ids=>changes.push(['chat',ids]));
 const profile=E.watchOfficialBadges(lookup,ids=>changes.push(['profile',ids]));releaseProfile=profile.release;
 try{
  chat.update([A]);profile.update([A,B]);assert.equal(calls.length,1);
  calls[0].resolve({[A]:[badge]});await drain();assert.equal(calls.length,2);assert.deepEqual(calls[1].ids,[B]);
  chat.release();assert.equal(E.officialBadges(A).length,1);calls[1].resolve({[B]:[badge]});await drain();assert.equal(E.officialBadges(B).length,1);
  window.dispatchEvent(new CustomEvent(E.ECOSYSTEM_CHANGED,{detail:{id:A}}));assert.equal(calls.length,3);calls[2].resolve({[A]:[]});await drain();assert.deepEqual(E.officialBadges(A),[]);assert.equal(changes.filter(([surface])=>surface==='profile').length,3);
 }finally{chat.release();releaseProfile();}
});

test('late results from a released generation cannot populate a new profile session or start overlapping requests',async()=>{
 fixture();const calls=[],lookup=ids=>new Promise(resolve=>calls.push({ids,resolve}));
 const old=E.watchOfficialBadges(lookup,()=>assert.fail('Released consumer notified'));old.update([A]);old.release();
 let changed=0;const current=E.watchOfficialBadges(lookup,()=>changed++);
 try{current.update([B]);assert.equal(calls.length,1);calls[0].resolve({[A]:[badge]});await drain();assert.deepEqual(E.officialBadges(A),[]);assert.equal(calls.length,2);calls[1].resolve({[B]:[badge]});await drain();assert.equal(changed,1);}finally{current.release();}
});

test('profile factory integration is lazy, semantic, idempotent and restored on teardown',async()=>{
 fixture();let executed=0;let Model;
 function factory(module,_exports,req){assert.equal(this.marker,'receiver');assert.equal(typeof req,'function');executed++;Model=class{constructor(){this.userId=A;}getBadges(){return [];}getLegacyUsername(){return undefined;}};module.exports=Object.defineProperty({unrelated:'kept'},'minified',{enumerable:true,get:()=>Model});}
 const unrelated=()=>assert.fail('Unrelated factory loaded');const req=Object.assign(()=>assert.fail('Module forced'),{m:{model:factory,other:unrelated},c:{}});
 const stop=E.startProfileBadges(async()=>({[A]:[badge]}));
 try{E.installProfileBadgeFactories(req);const wrapped=req.m.model;assert.notEqual(wrapped,factory);E.installProfileBadgeFactories(req);assert.equal(req.m.model,wrapped);assert.equal(req.m.other,unrelated);assert.equal(executed,0);
  const module={exports:{}};req.m.model.call({marker:'receiver'},module,module.exports,req);assert.equal(executed,1);assert.equal(module.exports.unrelated,'kept');const profile=new Model();assert.deepEqual(profile.getBadges(),[]);await drain();assert.equal(profile.getBadges()[0].id,'syncord:first-light');
 }finally{stop();}assert.equal(req.m.model,factory);assert.deepEqual(new Model().getBadges(),[]);
});

test('profile models loaded after boot are discovered from the native store signal without factory execution or polling',async()=>{
 fixture();const listeners=new Set(),cache={};const req=Object.assign(()=>assert.fail('Must not force modules'),{c:cache,m:{}});
 window.Syncord.webpack.getRequire=()=>req;
 const store=window.Syncord.common.stores.UserProfileStore;store.addChangeListener=fn=>listeners.add(fn);store.removeChangeListener=fn=>listeners.delete(fn);
 const stop=E.startProfileBadges(async()=>({[A]:[badge]}));
 class LazyProfile{constructor(){this.userId=A;}getBadges(){return [];}getLegacyUsername(){return '';}}
 try{assert.equal(listeners.size,1);cache.lazy={loaded:true,exports:{renamed:LazyProfile}};for(const fn of listeners)fn();assert.equal(listeners.size,0);const profile=new LazyProfile();profile.getBadges();await drain();assert.equal(profile.getBadges()[0].id,'syncord:first-light');}finally{stop();}assert.equal(listeners.size,0);
});

test('restricted modes suppress native additions and profile requests without touching original badges',async()=>{
 fixture();let enabled=false,calls=0;const stop=E.startProfileBadges(async()=>{calls++;return{[A]:[badge]};},()=>enabled);
 class Model{constructor(){this.userId=A;}getBadges(){return [{id:'native'}];}getLegacyUsername(){return '';}}
 try{E.patchProfileExports(Model);const profile=new Model();assert.deepEqual(profile.getBadges(),[{id:'native'}]);assert.equal(calls,0);enabled=true;profile.getBadges();await drain();assert.equal(profile.getBadges().length,2);enabled=false;assert.deepEqual(profile.getBadges(),[{id:'native'}]);assert.equal(calls,1);}finally{stop();}
});

const electron=['Electron.app/Contents/MacOS/Electron','electron.exe','electron'].map(p=>path.join(root,'node_modules/electron/dist',p)).find(existsSync);
async function uiChecks(){
 const {A,B,badge}=window.fi,E=window.api,calls=[],pending=[];let current=A,active=true,refreshes=0;
 // Advance only the real refresh timers; keep browser paints/image loads real.
 const realNow=Date.now,realSet=setTimeout,realClear=clearTimeout,timers=new Map();let offset=0;
 Date.now=()=>realNow()+offset;
 window.setTimeout=(fn,delay,...args)=>{let token;const run=()=>{timers.delete(token);fn(...args);};token=realSet(run,delay);if(delay>=29000&&delay<=30000)timers.set(token,run);return token;};
 window.clearTimeout=token=>{timers.delete(token);realClear(token);};
 const expire=()=>{offset+=30001;const due=[...timers];for(const [token,run]of due){realClear(token);run();}};

 class DisplayProfile{constructor(userId){this.userId=userId;}getLegacyUsername(){return 'native';}getBadges(){return this.userId===A?[{id:'nitro',description:'Native Nitro',iconSrc:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="blue"/></svg>')}]:[];}}
 const render=()=>{refreshes++;for(const container of document.querySelectorAll('[data-profile]')){const list=new DisplayProfile(current).getBadges();container.replaceChildren(...list.map(b=>{const img=document.createElement('img');img.src=b.iconSrc;img.title=b.description;img.dataset.badge=b.id;return img;}));}};
 window.Syncord={common:{stores:{UserProfileStore:{emitChange:render}}},webpack:{getRequire:()=>undefined}};
 let blocked=false;const stop=E.startProfileBadges(ids=>new Promise(resolve=>{calls.push(ids);pending.push(resolve);}),()=>!blocked);E.patchProfileExports({Z:DisplayProfile});
 const wait=ms=>new Promise(r=>setTimeout(r,ms)),until=async(fn,label)=>{const end=Date.now()+6000;while(!fn()){if(Date.now()>end)throw Error('Timeout '+label);await wait(10);}};
 try{
  render();if(calls.length!==1)throw Error('Profiles created duplicate lookups');pending.shift()({[A]:[badge]});
  await until(()=>document.querySelectorAll('[data-badge="syncord:first-light"]').length===3,'all native profile surfaces');
  await until(()=>[...document.querySelectorAll('[data-badge="syncord:first-light"]')].every(img=>img.naturalWidth===32),'local SVG loads');
  if(document.querySelectorAll('[data-badge="nitro"]').length!==3)throw Error('Native badges missing');
  let chatNotifies=0;const chat=E.watchOfficialBadges(async()=>{throw Error('Chat repeated a cached profile lookup');},()=>chatNotifies++);chat.update([A]);await wait(25);if(calls.length!==1)throw Error('Separate chat cache');chat.release();render();if(document.querySelectorAll('[data-badge="syncord:first-light"]').length!==3)throw Error('Chat stop removed profile badges');
  expire();if(!pending.length)throw Error('No automatic refresh timer');pending.shift()({[A]:[]});await until(()=>!document.querySelector('[data-badge="syncord:first-light"]'),'remote removal without local event');
  expire();pending.shift()({[A]:[{...badge,name:'New remote badge'}]});await until(()=>document.querySelectorAll('[data-badge="syncord:first-light"][title="Syncord · New remote badge"]').length===3,'remote badge appears without local event');
  current=B;render();if(document.querySelector('[data-badge="syncord:first-light"]'))throw Error('Previous user badge leaked');pending.shift()({[B]:[badge]});await until(()=>document.querySelectorAll('[data-badge="syncord:first-light"]').length===3,'badge on otherwise empty profile');
  active=false;window.dispatchEvent(new CustomEvent(E.ECOSYSTEM_CHANGED,{detail:{id:B}}));pending.shift()({[B]:[]});await until(()=>!document.querySelector('[data-badge="syncord:first-light"]'),'deactivation while profile stays open');
  blocked=true;current=A;render();if(document.querySelector('[data-badge="syncord:first-light"]'))throw Error('Restricted badge retained');
  const out={surfaces:3,lookups:calls.length,localImages:true,nativePreserved:true,chatCacheShared:true,switched:true,deactivated:!active,cleanup:false};
  stop();render();out.cleanup=document.querySelectorAll('[data-badge="nitro"]').length===3&&!document.querySelector('[data-badge="syncord:first-light"]');return out;
 }finally{stop();Date.now=realNow;window.setTimeout=realSet;window.clearTimeout=realClear;}
}
function driver(dir){const {app,BrowserWindow}=require('electron'),path=require('node:path');app.setPath('userData',path.join(dir,'profile'));app.disableHardwareAcceleration();app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:900,height:500,webPreferences:{backgroundThrottling:false}});try{await win.loadFile(path.join(dir,'index.html'));const result=await win.webContents.executeJavaScript('('+uiChecks.toString()+')()');console.log('PROFILE_RESULT:'+JSON.stringify(result));win.destroy();app.exit(0);}catch(error){console.error(error.stack);win.destroy();app.exit(1);}});}
test('native profile UI fixture: popout/modal/sidebar display local art, update in place, preserve native badges and share chat cache', {skip:!electron&&'Electron not installed',timeout:20000},async()=>{
 const uiDir=mkdtempSync(path.join(tmpdir(),'syncord-eco-profiles-ui-'));
 try{await build({stdin:{resolveDir:root,contents:`import * as api from './src/renderer/core/profileBadges';import {watchOfficialBadges} from './src/renderer/api/ecosystem/badges';import {ECOSYSTEM_CHANGED} from './src/shared/ecosystem';window.api={...api,watchOfficialBadges,ECOSYSTEM_CHANGED};`},bundle:true,platform:'browser',format:'iife',outfile:path.join(uiDir,'fixture.js'),logLevel:'silent'});
  writeFileSync(path.join(uiDir,'index.html'),`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="img-src data: https://cdn.discordapp.com"></head><body><aside data-profile="popout"></aside><section data-profile="modal"></section><aside data-profile="sidebar"></aside><script>window.fi=${JSON.stringify({A,B,badge})};</script><script src="fixture.js"></script></body></html>`);
  writeFileSync(path.join(uiDir,'main.cjs'),`const uiChecks=${uiChecks.toString()};(${driver.toString()})(${JSON.stringify(uiDir)});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const run=spawnSync(electron,[path.join(uiDir,'main.cjs')],{env,encoding:'utf8',timeout:15000});assert.equal(run.status,0,`${run.error??''}\n${run.stdout}\n${run.stderr}`);
  const line=run.stdout.split('\n').find(l=>l.startsWith('PROFILE_RESULT:'));assert.ok(line,run.stdout);assert.deepEqual(JSON.parse(line.slice(15)),{surfaces:3,lookups:5,localImages:true,nativePreserved:true,chatCacheShared:true,switched:true,deactivated:true,cleanup:true});
 }finally{rmSync(uiDir,{recursive:true,force:true});}
});


async function rowFallbackChecks(){
 const {A,B,badge}=window.fi,E=window.api,calls=[],pending=[];
 // This is the regression: no DisplayProfile export/method and emitChange is a
 // no-op. The old model-only integration leaves all of these cards undecorated.
 let roots=0,unmounts=0,cleanup=[];
 function NativeTooltip({text,children,color,position}){
  let popup;const hide=()=>{popup?.remove();popup=undefined;};
  const show=()=>{hide();popup=document.createElement('div');popup.setAttribute('role','tooltip');popup.dataset.nativeTooltip='';popup.dataset.color=color;popup.dataset.position=position;popup.textContent=text;document.body.append(popup);};
  cleanup.push(hide);return children({onMouseEnter:show,onMouseLeave:hide,onFocus:show,onBlur:hide,'aria-label':text});
 }
 function tooltipFactory(){return{tooltipPointer:'native-pointer',tooltipContent:'native-content'};}
 const react={createElement:(type,props,...children)=>({type,props:{...props,children:children.length===1?children[0]:children}}),useState(){throw Error('Fixture hook not used');}};
 const reactDOM={createRoot(host){roots++;let disposers=[];return{render(tree){
  const draw=node=>{if(typeof node==='string')return document.createTextNode(node);if(typeof node.type==='function')return draw(node.type(node.props));const el=document.createElement(node.type);
   for(const [key,value]of Object.entries(node.props)){if(key==='children')continue;if(key==='style'){Object.assign(el.style,value);continue;}const event={onMouseEnter:'mouseenter',onMouseLeave:'mouseleave',onFocus:'focus',onBlur:'blur'}[key];if(event)el.addEventListener(event,value);else if(key==='tabIndex')el.tabIndex=value;else el.setAttribute(key,String(value));}
   for(const child of [node.props.children].flat().filter(Boolean))el.append(draw(child));return el;};
  cleanup=[];host.replaceChildren(draw(tree));disposers=cleanup;cleanup=[];
 },unmount(){unmounts++;for(const dispose of disposers)dispose();host.replaceChildren();}};}};
 const req=Object.assign(()=>{throw Error('Unexecuted factory required');},{c:{tooltip:{loaded:true,exports:{T:NativeTooltip}}},m:{tooltip:tooltipFactory}});
 window.Syncord={common:{react:{React:react,ReactDOM:reactDOM},stores:{UserProfileStore:{emitChange(){}}}},webpack:{getRequire:()=>req}};
 let enabled=true;const stop=E.startProfileBadges(ids=>new Promise(resolve=>{calls.push(ids);pending.push(resolve);}),()=>enabled,async()=> 'data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="12"/></svg>'));
 const wait=ms=>new Promise(r=>setTimeout(r,ms)),until=async(fn,label)=>{const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw Error('Fallback timeout '+label);await wait(10);}};
 const make=(user,kind='generic')=>{
  const profile=document.createElement('article');profile.className=kind==='empty'?'user-profile-modal':'outer_fixture';
  const name=document.createElement('h2');name.textContent='Viewed user';profile.append(name);
  if(kind==='empty'){name.__reactFiber$fixture={memoizedProps:{user:{id:user},currentUser:{id:A}}};}
  else{
   const row=document.createElement('div');row.className='container_fixture';row.style.cssText='display:flex;align-items:center;gap:4px';row.innerHTML='<span style="display:inline-flex"><a><img width="22" height="22" src="https://cdn.discordapp.com/badge-icons/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png"></a></span><a><img width="22" height="22" src="https://cdn.discordapp.com/badge-icons/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png"></a>';
   row.__reactFiber$fixture={memoizedProps:{},return:{memoizedProps:{userId:user,badges:[{id:'native'}],currentUser:{id:B}}}};profile.append(row);
  }
  document.body.append(profile);return profile;
 };
 try{
  const card=make(A);await until(()=>calls.length===1,'late-mounted generic native row');pending.shift()({[A]:[badge]});
  await until(()=>card.querySelector('[data-syncord-profile-badges] img'),'badge after async lookup without store rerender');
  if([...card.querySelectorAll('img')].filter(img=>!img.closest('[data-syncord-profile-badges]')).length!==2)throw Error('Native badge changed');if(card.querySelector('[data-syncord-profile-badges]').parentElement!==card.querySelector('.container_fixture'))throw Error('Mounted inside a single badge wrapper');
  const first=card.querySelector('[data-syncord-profile-badges]');if(first.dataset.syncordProfileBadges!==A)throw Error('Wrong profile identity');
  first.querySelector('[role=img]').dispatchEvent(new MouseEvent('mouseenter'));await until(()=>document.querySelector('[data-native-tooltip]')?.textContent.includes('First <Light>'),'safe native tooltip');first.querySelector('[role=img]').dispatchEvent(new MouseEvent('mouseleave'));
  // Activity cards reuse badge containers and inherit the viewed user's props.
  // They must not become a second Syncord profile-badge row.
  const activity=document.createElement('section');activity.className='unknown_game_card';
  activity.innerHTML='<div class="badgesContainer_activity" role="group" aria-label="Playing"><span>3100:01:46</span><img width="22" height="22" src="https://cdn.discordapp.com/badge-icons/cccccccccccccccccccccccccccccccc.png"></div>';
  const activityRow=activity.firstElementChild;activityRow.__reactFiber$fixture={memoizedProps:{},return:{memoizedProps:{activity:{type:0,name:'Grand Theft Auto VI',application_id:'200000000000000001'},user:{id:A}}}};
  card.append(activity);await wait(60);if(activity.querySelector('[data-syncord-profile-badges]'))throw Error('Game activity inherited the profile owner badges');
  if(!activity.querySelector('img')||!activity.textContent.includes('3100:01:46'))throw Error('Native game activity was changed');
  const listening=activity.cloneNode(true);listening.className='activityCard_fixture';card.append(listening);await wait(50);if(listening.querySelector('[data-syncord-profile-badges]'))throw Error('DOM activity card received profile badges without a fiber');
  // Native rows inside a real profile must be chosen over activity rows. A
  // profile-wide activities array must not hide the genuine user badge row.
  const mixed=make(A,'empty');mixed.__reactFiber$fixture={memoizedProps:{userId:A,activities:[{type:0,name:'Playing'}]}};
  const nested=activity.cloneNode(true);nested.firstElementChild.__reactFiber$fixture=activityRow.__reactFiber$fixture;mixed.prepend(nested);
  await until(()=>mixed.querySelector('[data-syncord-profile-badges]'),'profile header beside game activity');
  if(nested.querySelector('[data-syncord-profile-badges]')||mixed.querySelectorAll('[data-syncord-profile-badges]').length!==1)throw Error('Activity row displaced the real profile header');
  // A recycled row can become an activity anchor after we decorated it.
  const recycled=make(A);await until(()=>recycled.querySelector('[data-syncord-profile-badges]'),'recycled native badge row');
  recycled.querySelector('.container_fixture').__reactFiber$fixture.return.memoizedProps.activity={type:0,name:'A game'};recycled.querySelector('h2').textContent='Now an activity';
  await until(()=>!recycled.querySelector('[data-syncord-profile-badges]'),'recycled activity row clears its own badge host');
  const nativeRow=card.querySelector('.container_fixture');nativeRow.replaceChildren(nativeRow.querySelector('a'));await until(()=>nativeRow.querySelector('[data-syncord-profile-badges]'),'React native child replacement repairs island');
  nativeRow.__reactFiber$fixture.return.memoizedProps.userId=B;card.querySelector('h2').textContent='Different viewed user';await until(()=>calls.length===2,'same DOM new identity');
  if(card.querySelector('[data-syncord-profile-badges]'))throw Error('Previous badge remained during account lookup');pending.shift()({[B]:[]});await wait(30);
  if(card.querySelector('[data-syncord-profile-badges]'))throw Error('Previous badge leaked to unowned profile');
  const empty=make(A,'empty');await until(()=>empty.querySelector('[data-syncord-profile-badges] img'),'profile without native badges');
  const lateRow=document.createElement('div');lateRow.className='profileBadges_fixture';lateRow.style.display='flex';lateRow.__reactFiber$fixture={memoizedProps:{user:{id:A}}};empty.append(lateRow);
  await until(()=>lateRow.querySelector('[data-syncord-profile-badges]'),'empty profile native row arrives later');if(empty.querySelectorAll('[data-syncord-profile-badges]').length!==1)throw Error('Duplicate after native row mount');
  const alternate=make(B),alternateRow=alternate.querySelector('.container_fixture'),oldRoot={stateNode:{}},currentRoot={};oldRoot.stateNode.current=currentRoot;
  alternateRow.__reactFiber$fixture={memoizedProps:{userId:B},return:oldRoot,alternate:{memoizedProps:{userId:A},return:currentRoot}};alternate.querySelector('h2').textContent='Current React branch';
  await until(()=>alternate.querySelector('[data-syncord-profile-badges]')?.dataset.syncordProfileBadges===A,'current React alternate identity');
  const untrusted=make(A);untrusted.querySelector('.container_fixture').__reactFiber$fixture={memoizedProps:{currentUser:{id:A}}};untrusted.querySelector('h2').textContent='No viewed identity';await wait(50);if(untrusted.querySelector('[data-syncord-profile-badges]'))throw Error('currentUser used as viewed identity');
  const messageBadge=make(A);messageBadge.id='chat-messages-1554184140704900001-1';await wait(30);if(messageBadge.querySelector('[data-syncord-profile-badges]'))throw Error('Message image mistaken for a profile');
  window.dispatchEvent(new CustomEvent(E.ECOSYSTEM_CHANGED,{detail:{id:A}}));await until(()=>calls.length===3,'custom SVG invalidation');pending.shift()({[A]:[{...badge,image:'2'.repeat(64)}]});
  await until(()=>[...document.querySelectorAll('[data-syncord-profile-badges] img')].some(img=>img.naturalWidth===32&&img.src.startsWith('data:image/svg+xml;base64,')),'uploaded SVG in actual native row');
  const nativeIcon=empty.querySelector('[data-syncord-profile-badges] [role=img]');if(!nativeIcon)throw Error('Native tooltip child missing');
  nativeIcon.dispatchEvent(new MouseEvent('mouseenter'));await until(()=>document.querySelector('[data-native-tooltip]'),'native hover tooltip');
  const tip=document.querySelector('[data-native-tooltip]');if(tip.textContent!==badge.name||tip.dataset.color!=='primary'||tip.dataset.position!=='top'||document.querySelector('#Syncord-tooltip'))throw Error('Custom tooltip used instead of native primary Tooltip');
  nativeIcon.dispatchEvent(new MouseEvent('mouseleave'));if(document.querySelector('[data-native-tooltip]'))throw Error('Native tooltip did not dismiss');
  const focused=empty.querySelector('[data-syncord-profile-badges] [role=img]');if(focused.tabIndex!==0)throw Error('Native badge is not keyboard focusable');focused.dispatchEvent(new FocusEvent('focus'));await until(()=>document.querySelector('[data-native-tooltip]'),'native keyboard focus');focused.dispatchEvent(new FocusEvent('blur'));if(document.querySelector('[data-native-tooltip]'))throw Error('Native tooltip did not dismiss on blur');
  const allRequests=calls.length;for(let i=0;i<20;i++){const message=document.createElement('p');message.textContent='Unrelated chat';document.body.append(message);}await wait(50);if(calls.length!==allRequests)throw Error('Chat mutations create requests');
  enabled=false;window.dispatchEvent(new CustomEvent(E.ECOSYSTEM_CHANGED,{detail:{id:A}}));await until(()=>calls.length===4,'invalidation');pending.shift()({[A]:[badge]});await wait(30);
  await until(()=>!document.querySelector('[data-syncord-profile-badges]'),'restricted mode clears profile islands');
  // Stop also clears profile hosts/tooltips and handles detached native cards.
  card.remove();empty.remove();stop();if(document.querySelector('[data-syncord-profile-badges]'))throw Error('Host leaked on teardown');if(roots!==unmounts||document.querySelector('[data-native-tooltip]'))throw Error('Native React root/tooltip leaked');
  return{modelMissing:true,asyncWithoutStoreRerender:true,genericNativeRow:true,emptyProfile:true,recycledIdentity:true,reactReplacement:true,nativePreserved:true,noCurrentUserFallback:true,cleanup:true};
 }finally{stop();}
}
function fallbackDriver(dir){const {app,BrowserWindow,session}=require('electron'),path=require('node:path');app.setPath('userData',path.join(dir,'profile'));app.disableHardwareAcceleration();app.whenReady().then(async()=>{
 session.defaultSession.webRequest.onBeforeRequest({urls:['https://cdn.discordapp.com/badge-icons/*']},(_details,callback)=>callback({cancel:true}));
 const win=new BrowserWindow({show:false,width:900,height:600,webPreferences:{backgroundThrottling:false}});try{await win.loadFile(path.join(dir,'index.html'));const result=await win.webContents.executeJavaScript('('+rowFallbackChecks.toString()+')()');console.log('FALLBACK_RESULT:'+JSON.stringify(result));win.destroy();app.exit(0);}catch(error){console.error(error.stack);win.destroy();app.exit(1);}});}
test('real-row fallback regression: missing model, async unchanged store, current generic row, React replacement and recycled profile identity', {skip:!electron&&'Electron not installed',timeout:20000},async()=>{
 const uiDir=mkdtempSync(path.join(tmpdir(),'syncord-eco-profile-row-'));
 try{
  await build({stdin:{resolveDir:root,contents:`import * as api from './src/renderer/core/profileBadges';import {ECOSYSTEM_CHANGED} from './src/shared/ecosystem';window.api={...api,ECOSYSTEM_CHANGED};`},bundle:true,platform:'browser',format:'iife',outfile:path.join(uiDir,'fixture.js'),logLevel:'silent'});
  writeFileSync(path.join(uiDir,'index.html'),`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="img-src data: https://cdn.discordapp.com"></head><body><script>window.fi=${JSON.stringify({A,B,badge})};</script><script src="fixture.js"></script></body></html>`);
  writeFileSync(path.join(uiDir,'main.cjs'),`const rowFallbackChecks=${rowFallbackChecks.toString()};(${fallbackDriver.toString()})(${JSON.stringify(uiDir)});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const run=spawnSync(electron,[path.join(uiDir,'main.cjs')],{env,encoding:'utf8',timeout:15000});assert.equal(run.status,0,`${run.error??''}\n${run.stdout}\n${run.stderr}`);
  const line=run.stdout.split('\n').find(l=>l.startsWith('FALLBACK_RESULT:'));assert.ok(line,run.stdout);for(const [name,value]of Object.entries(JSON.parse(line.slice(16))))assert.equal(value,true,name);
 }finally{rmSync(uiDir,{recursive:true,force:true});}
});

test('open native profiles refresh changed badges automatically and closed profiles retire',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});fixture();let calls=0,open=true,active=[];
 const stop=E.startProfileBadges(async()=>{calls++;return{[A]:active};});
 class Model{constructor(){this.userId=A;}getLegacyUsername(){return '';}getBadges(){return [];}}
 E.patchProfileExports({Model});const model=new Model();let rendered=[];
 window.Syncord.common.stores.UserProfileStore.emitChange=()=>{if(open)rendered=model.getBadges();};
 try{
  rendered=model.getBadges();await drain();assert.deepEqual(rendered,[]);assert.equal(calls,1);
  active=[badge];t.mock.timers.tick(30000);await drain();assert.equal(rendered[0]?.id,'syncord:first-light');assert.equal(calls,2);
  active=[{...badge,name:'Changed name'}];t.mock.timers.tick(30000);await drain();assert.equal(rendered[0]?.description,'Syncord · Changed name');
  active=[];t.mock.timers.tick(30000);await drain();assert.deepEqual(rendered,[]);
  open=false;t.mock.timers.tick(30000);await drain();t.mock.timers.tick(30000);await drain();const retired=calls;
  t.mock.timers.tick(120000);await drain();assert.equal(calls,retired,'closed profiles no longer keep a poll alive');
 }finally{stop();}
});

test('native tooltip resolves only executed modules and delegates the real component/anchor props/cleanup',()=>{
 fixture();let loaded=0,rendered,unmounted=0;
 function NativeTooltip(props){return{onMouseEnter(){},children:props.children};}
 function factory(){return{tooltipPointer:'pointer',tooltipContent:'content'};}
 const req=Object.assign(()=>{loaded++;throw Error('Must not load factories');},{m:{tooltip:factory},c:{}});
 window.Syncord.webpack.getRequire=()=>req;
 assert.equal(E.resolveTooltip(),undefined);assert.equal(loaded,0);
 req.c.tooltip={loaded:true,exports:{obfuscated:NativeTooltip}};
 const react={createElement:(type,props,...children)=>({type,props:{...props,children:children.length===1?children[0]:children}}),useState(){throw Error('Unused hook');}};
 window.Syncord.common.react={React:react,ReactDOM:{createRoot:()=>({render:node=>rendered=node,unmount:()=>unmounted++})}};
 try{
  const dispose=E.mountNativeTooltip({},'Badge <script>',(r,props)=>r.createElement('span',props));
  assert.equal(typeof dispose,'function');assert.equal(rendered.type,NativeTooltip);assert.equal(rendered.props.text,'Badge <script>');assert.equal(rendered.props.position,'top');assert.equal(rendered.props.color,'primary');
  const native={onMouseEnter(){},onMouseLeave(){},onFocus(){},onBlur(){},ref(){},'aria-describedby':'native-tooltip'};
  const anchor=rendered.props.children(native);for(const key of Object.keys(native))assert.equal(anchor.props[key],native[key]);
  assert.equal(loaded,0);dispose();assert.equal(unmounted,1);
 }finally{delete E.kit.tooltip;delete E.kit.react;delete E.kit.createRoot;}
});
test('missing or incompatible native tooltip runtime fails locally without custom tooltip styling',()=>{
 fixture();let calls=0;
 assert.equal(E.mountNativeTooltip({},'Badge',()=>{calls++;}),undefined);assert.equal(calls,0);
 E.kit.tooltip=function Tooltip(){};E.kit.react={createElement:()=>({}),useState:()=>[0,()=>{}]};E.kit.createRoot=()=>({render(){throw Error('Incompatible client');},unmount(){calls++;}});
 try{assert.equal(E.mountNativeTooltip({},'Badge',()=>{}),undefined);assert.equal(calls,1);}finally{delete E.kit.tooltip;delete E.kit.react;delete E.kit.createRoot;}
});

async function tooltipContextChecks(){
 const {React,createRoot,createPortal,flushSync,mountNativeTooltip}=window.api;
 const AppLayer=React.createContext([null,()=>{}]),Theme=React.createContext('missing');
 function Tooltip({children,text}){
  const [open,setOpen]=React.useState(false),[container]=React.useContext(AppLayer),theme=React.useContext(Theme);
  return React.createElement(React.Fragment,null,children({onMouseEnter:()=>setOpen(true),onMouseLeave:()=>setOpen(false),onFocus:()=>setOpen(true),onBlur:()=>setOpen(false)}),open&&container?createPortal(React.createElement('div',{role:'tooltip','data-native-theme':theme},text),container):null);
 }
 function factory(){return{tooltipPointer:'pointer',tooltipContent:'content'};}
 const req=Object.assign(()=>{throw Error('Unexecuted factory required');},{c:{tooltip:{loaded:true,exports:{T:Tooltip}}},m:{tooltip:factory}});
 window.Syncord={common:{react:{React,ReactDOM:{createRoot}}},webpack:{getRequire:()=>req}};
 const wait=ms=>new Promise(r=>setTimeout(r,ms)),until=async(fn,label)=>{const end=Date.now()+4000;while(!fn()){if(Date.now()>end)throw Error(label);await wait(10);}};
 const first=document.createElement('div'),second=document.createElement('div'),app=document.createElement('div');document.body.append(app,first,second);
 const appRoot=createRoot(app);let dispose,orphanDispose;
 const render=container=>{let content=React.createElement('div',{id:'profile-native-anchor'},'Native badge row');for(let i=0;i<150;i++)content=React.createElement('section',{style:{display:'contents'}},content);flushSync(()=>appRoot.render(React.createElement(Theme.Provider,{value:'outer'},React.createElement(AppLayer.Provider,{value:[container,()=>{}]},React.createElement(Theme.Provider,{value:'native-profile'},content)))));};
 const mount=(host,anchor)=>{let stop;flushSync(()=>{stop=mountNativeTooltip(host,'Syncorder <literal>',(r,props)=>r.createElement('span',{...props,tabIndex:0,'data-syncord-icon':''},'Badge'),anchor);});if(!stop)throw Error('Native tooltip did not mount');return stop;};
 const enter=host=>host.querySelector('[data-syncord-icon]').dispatchEvent(new MouseEvent('mouseover',{bubbles:true,relatedTarget:document.body}));
 const leave=host=>host.querySelector('[data-syncord-icon]').dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:document.body}));
 try{
  render(first);const orphan=document.createElement('span');document.body.append(orphan);orphanDispose=mount(orphan);enter(orphan);await wait(30);
  if(document.querySelector('[role=tooltip]'))throw Error('Control unexpectedly inherited App Layer; missing-context regression not reproduced');orphanDispose();orphanDispose=undefined;orphan.remove();
  const anchor=document.getElementById('profile-native-anchor'),host=document.createElement('span');anchor.append(host);dispose=mount(host,anchor);enter(host);
  await until(()=>first.querySelector('[role=tooltip]'),'Native tooltip remains invisible without App Layer context');
  const tip=first.querySelector('[role=tooltip]');if(tip.textContent!=='Syncorder <literal>'||tip.dataset.nativeTheme!=='native-profile')throw Error('Tooltip lost native theme/provider precedence or literal text');
  leave(host);await until(()=>!first.querySelector('[role=tooltip]'),'Native hover tooltip did not hide');
  host.querySelector('[data-syncord-icon]').dispatchEvent(new FocusEvent('focusin',{bubbles:true}));await until(()=>first.querySelector('[role=tooltip]'),'Native focus tooltip did not show');
  flushSync(()=>dispose());dispose=undefined;if(document.querySelector('[role=tooltip]'))throw Error('Portal survived root cleanup');host.remove();
  render(second);const current=document.getElementById('profile-native-anchor'),replacement=document.createElement('span');current.append(replacement);dispose=mount(replacement,current);enter(replacement);
  await until(()=>second.querySelector('[role=tooltip]'),'Updated native provider value was not read from the current React branch');if(first.querySelector('[role=tooltip]'))throw Error('Stale native layer retained');
  flushSync(()=>dispose());dispose=undefined;if(document.querySelector('[role=tooltip]'))throw Error('Replacement portal survived cleanup');
  return{missingContextReproduced:true,realReactHover:true,nativeLayer:true,nestedTheme:true,keyboardFocus:true,currentBranch:true,cleanup:true};
 }finally{if(dispose)flushSync(()=>dispose());if(orphanDispose)flushSync(()=>orphanDispose());flushSync(()=>appRoot.unmount());app.remove();first.remove();second.remove();}
}
test('real React native tooltip: missing App Layer reproduces invisible hover; inherited provider enables portals',{skip:!electron&&'Electron not installed',timeout:20000},async()=>{
 const uiDir=mkdtempSync(path.join(tmpdir(),'syncord-tooltip-context-'));
 try{
  await build({stdin:{resolveDir:root,contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {createPortal,flushSync} from 'react-dom';import {mountNativeTooltip} from './src/renderer/ui/nativeTooltip';window.api={React,createRoot,createPortal,flushSync,mountNativeTooltip};`},bundle:true,platform:'browser',format:'iife',outfile:path.join(uiDir,'fixture.js'),logLevel:'silent'});
  writeFileSync(path.join(uiDir,'index.html'),'<!doctype html><html><body><script src="fixture.js"></script></body></html>');
  writeFileSync(path.join(uiDir,'main.cjs'),`const uiChecks=${tooltipContextChecks.toString()};(${driver.toString()})(${JSON.stringify(uiDir)});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const run=spawnSync(electron,[path.join(uiDir,'main.cjs')],{env,encoding:'utf8',timeout:15000});assert.equal(run.status,0,`${run.error??''}\n${run.stdout}\n${run.stderr}`);
  const line=run.stdout.split('\n').find(l=>l.startsWith('PROFILE_RESULT:'));assert.ok(line,run.stdout);for(const [key,value]of Object.entries(JSON.parse(line.slice(15))))assert.equal(value,true,key);
 }finally{rmSync(uiDir,{recursive:true,force:true});}
});

test('profile tooltip prefers the current element-child component and copies only native badge timing/placement',()=>{
 fixture();let rendered,loads=0,unmounted=0;
 function Modern(props){return{__unsupportedReactNodeAsText:props.text,keyboardShortcut:props.keyboardShortcut,anchorRef:props.anchorRef,caretConfig:props.caretConfig,isValidElement:props.children};}
 const req=Object.assign(()=>{loads++;throw Error('No forced factories');},{c:{modern:{loaded:true,exports:{m:Modern}}},m:{}});window.Syncord.webpack.getRequire=()=>req;
 const react={createElement:(type,props,...children)=>({type,props:{...props,children:children.length===1?children[0]:children}}),useState(){throw Error('Unused');}};
 window.Syncord.common.react={React:react,ReactDOM:{createRoot:()=>({render:node=>rendered=node,unmount:()=>unmounted++})}};
 E.kit.tooltip=function Legacy(){};
 const image={__reactFiber$fixture:{type:Modern,memoizedProps:{delay:425,position:'bottom',align:'left',spacing:13,ariaHidden:false,onTooltipShow(){throw Error('Do not inherit analytics');},forceOpen:true,text:'Native badge'}}},anchor={querySelectorAll:()=>[image]};
 try{
  const dispose=E.mountNativeTooltip({},'Syncorder',(r,props)=>r.createElement('span',{...props,'aria-label':'Syncorder'}),anchor);
  assert.equal(rendered.type,Modern);assert.equal(rendered.props.delay,425);assert.equal(rendered.props.position,'bottom');assert.equal(rendered.props.align,'left');assert.equal(rendered.props.spacing,13);assert.equal(rendered.props.ariaHidden,false);
  assert.equal(typeof rendered.props.children,'object');assert.equal(rendered.props.children.type,'span');assert.equal(rendered.props.text,'Syncorder');assert.equal(rendered.props.onTooltipShow,undefined);assert.equal(rendered.props.forceOpen,undefined);assert.equal(rendered.props.color,undefined);assert.equal(loads,0);dispose();assert.equal(unmounted,1);
  image.__reactFiber$fixture.memoizedProps={delay:Infinity,spacing:-1};const stop=E.mountNativeTooltip({},'Badge',(r,props)=>r.createElement('span',props),anchor);assert.equal(rendered.props.delay,300);assert.equal(rendered.props.spacing,undefined);assert.equal(rendered.props.position,'top');stop();
 }finally{delete E.kit.profileTooltip;delete E.kit.tooltip;delete E.kit.react;delete E.kit.createRoot;}
});

async function modernTooltipTimingChecks(){
 const {React,createRoot,createPortal,flushSync,mountNativeTooltip}=window.api;
 const Layer=React.createContext(null),Motion=React.createContext(false),tasks=new Map();let now=0,serial=0;
 const clock={set(fn,delay){const id=++serial;tasks.set(id,{fn,at:now+delay});return id;},clear(id){tasks.delete(id);},tick(ms){now+=ms;for(const [id,task]of [...tasks])if(task.at<=now){tasks.delete(id);task.fn();}}};
 function ModernTooltip({children,text,delay=0,__unsupportedReactNodeAsText,keyboardShortcut,anchorRef,caretConfig}){
  const container=React.useContext(Layer),reduced=React.useContext(Motion),[phase,setPhase]=React.useState('hidden'),timers=React.useRef([]);
  const cancel=()=>{timers.current.forEach(clock.clear);timers.current=[];};
  React.useEffect(()=>cancel,[]);
  const show=()=>{cancel();timers.current.push(clock.set(()=>setPhase('visible'),delay));};
  const hide=()=>{cancel();setPhase(current=>current==='hidden'?'hidden':'leaving');timers.current.push(clock.set(()=>setPhase('hidden'),90));};
  if(!React.isValidElement(children))throw Error('Modern Tooltip requires an element, not render props');
  return React.createElement(React.Fragment,null,React.cloneElement(children,{onMouseEnter:show,onMouseLeave:hide,onFocus:show,onBlur:hide}),phase!=='hidden'&&container?createPortal(React.createElement('div',{role:'tooltip','data-phase':phase,'data-exit-scale':reduced?'1':'0.95'},text),container):null);
 }
 const req=Object.assign(()=>{throw Error('Forced factory');},{c:{modern:{loaded:true,exports:{m:ModernTooltip}}},m:{}});
 window.Syncord={common:{react:{React,ReactDOM:{createRoot}}},webpack:{getRequire:()=>req}};
 const app=document.createElement('div'),layer=document.createElement('div');document.body.append(app,layer);const appRoot=createRoot(app);let dispose;
 const render=reduced=>{
  const image=React.createElement('img',{src:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"/>')+'#/badge-icons/'});
  const badge=React.createElement(ModernTooltip,{text:'Native',delay:375},React.createElement('span',{'data-native-trigger':''},image));
  const row=React.createElement('div',{id:'native-badge-row'},badge);
  flushSync(()=>appRoot.render(React.createElement(Layer.Provider,{value:layer},React.createElement(Motion.Provider,{value:reduced},row))));
 };
 const mount=()=>{const anchor=document.getElementById('native-badge-row'),host=document.createElement('span');anchor.append(host);flushSync(()=>{dispose=mountNativeTooltip(host,'Syncorder',(r,props)=>r.createElement('span',{...props,'data-syncord-trigger':'',tabIndex:0},'S'),anchor);});if(!dispose)throw Error('Modern tooltip did not mount');};
 const event=(selector,type)=>flushSync(()=>document.querySelector(selector).dispatchEvent(new MouseEvent(type,{bubbles:true,relatedTarget:document.body})));
 const tick=ms=>flushSync(()=>clock.tick(ms));
 const settle=async()=>{for(let i=0;i<100;i++){if([...layer.children].every(t=>t.dataset.phase!=='visible'))return;await new Promise(resolve=>setTimeout(resolve,10));}};
 const both=type=>{event('[data-native-trigger]',type);event('[data-syncord-trigger]',type);};
 try{
  render(false);mount();both('mouseover');tick(374);if(layer.children.length)throw Error('Tooltip opened before native badge delay');tick(1);if(layer.querySelectorAll('[role=tooltip]').length!==2)throw Error('Native and Syncord opening delays differ');
  both('mouseout');await settle();if([...layer.children].some(t=>t.dataset.phase!=='leaving'||t.dataset.exitScale!=='0.95'))throw Error('Exit behavior was overridden: '+layer.innerHTML);tick(89);if(layer.children.length!==2)throw Error('Tooltip root removed before native exit completed');tick(1);if(layer.children.length)throw Error('Native exit did not complete');
  both('mouseover');tick(150);both('mouseout');await settle();tick(400);if(layer.children.length)throw Error('Short hover did not cancel delayed opening');
  both('mouseover');tick(375);flushSync(()=>dispose());dispose=undefined;if(layer.children.length!==1||layer.firstChild.textContent!=='Native')throw Error('Cleanup affected native tooltip or leaked Syncord portal');
  event('[data-native-trigger]','mouseout');await settle();tick(90);render(true);mount();both('mouseover');tick(375);both('mouseout');await settle();if([...layer.children].some(t=>t.dataset.exitScale!=='1'))throw Error('Reduced-motion context was not inherited');tick(90);
  return{nativeDelay:true,exitLifecycle:true,shortHoverCancellation:true,reducedMotion:true,cleanup:true};
 }finally{if(dispose)flushSync(()=>dispose());flushSync(()=>appRoot.unmount());app.remove();layer.remove();}
}
test('real React current tooltip matches native badge delay, exit lifecycle and reduced-motion settings',{skip:!electron&&'Electron not installed',timeout:20000},async()=>{
 const uiDir=mkdtempSync(path.join(tmpdir(),'syncord-tooltip-timing-'));
 try{
  await build({stdin:{resolveDir:root,contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {createPortal,flushSync} from 'react-dom';import {mountNativeTooltip} from './src/renderer/ui/nativeTooltip';window.api={React,createRoot,createPortal,flushSync,mountNativeTooltip};`},bundle:true,platform:'browser',format:'iife',outfile:path.join(uiDir,'fixture.js'),logLevel:'silent'});
  writeFileSync(path.join(uiDir,'index.html'),'<!doctype html><html><body><script src="fixture.js"></script></body></html>');writeFileSync(path.join(uiDir,'main.cjs'),`const uiChecks=${modernTooltipTimingChecks.toString()};(${driver.toString()})(${JSON.stringify(uiDir)});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const run=spawnSync(electron,[path.join(uiDir,'main.cjs')],{env,encoding:'utf8',timeout:15000});assert.equal(run.status,0,`${run.error??''}\n${run.stdout}\n${run.stderr}`);
  const line=run.stdout.split('\n').find(l=>l.startsWith('PROFILE_RESULT:'));assert.ok(line,run.stdout);for(const [key,value]of Object.entries(JSON.parse(line.slice(15))))assert.equal(value,true,key);
 }finally{rmSync(uiDir,{recursive:true,force:true});}
});

test('existing native badge renderer accepts three shop, one tier and three approved personal PNG records without touching Discord badges',async()=>{
 fixture();const p=new PNG({width:128,height:128});p.data[0]=240;p.data[3]=90;const data='data:image/png;base64,'+PNG.sync.write(p).toString('base64'),image='png:'+'e'.repeat(64);await E.loadBadgeImage(image,async()=>data);
 const native=Object.freeze([{id:'nitro',description:'Nitro',iconSrc:'https://cdn.discordapp.com/badge-icons/native.png'}]);const records=[...Array.from({length:3},(_,i)=>({...badge,id:'shop-'+i})),{...badge,id:'supporter-tier-3'},...Array.from({length:3},(_,i)=>({...badge,id:'custom-'+String(i).padStart(32,'0'),image,price:0}))];
 const result=E.appendProfileBadges(native,records);assert.equal(result.length,8);assert.strictEqual(result[0],native[0]);assert.equal(native.length,1);assert.equal(result.filter(b=>b.iconSrc===data).length,3);assert.equal(E.appendProfileBadges(result,records).length,8);
});
