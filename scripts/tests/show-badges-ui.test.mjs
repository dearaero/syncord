import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
const root=process.cwd(),electron=['Electron.app/Contents/MacOS/Electron','electron.exe','electron'].map(name=>path.join(root,'node_modules/electron/dist',name)).find(existsSync);
function setup(mode){
 const A='1425993161108357191',B='1425993161108357192',C='1425993161108357193',D='1425993161108357196';
 const GA='1425993161108357201',GB='1425993161108357202',CA='1425993161108357301',CB='1425993161108357302',HIDDEN='1425993161108357303';
 window.ids={A,B,C,D,GA,GB,CA,CB,HIDDEN};window.requests=[];window.profileCache=new Map([[C,{badges:[{id:'cached',icon:'c'.repeat(32)}]}]]);
 window.guildCache=new Map([[C+':'+GA,{badges:[]}]]);window.fetching=new Set();window.modelFlags=new Map();window.frames=0;window.nativeCalls=0;
 const raf=window.requestAnimationFrame.bind(window);window.requestAnimationFrame=fn=>{window.frames++;return raf(fn);};
 const flux={dispatch(action){
   window.nativeCalls++;
   if(action.type==='USER_PROFILE_FETCH_START')fetching.add(action.userId+':'+(action.guildId??''));
   if(action.type==='USER_PROFILE_FETCH_SUCCESS'){
     const id=action.userProfile.user.id;profileCache.set(id,{badges:action.userProfile.badges});guildCache.set(id+':'+action.guildId,{badges:action.userProfile.guild_badges??[]});fetching.delete(id+':'+action.guildId);
   }
   if(action.type==='USER_UPDATE'&&action.user?.id===A&&typeof action.user.public_flags==='number')modelFlags.set(A,action.user.public_flags);
 },subscribe(){throw new Error('Separate native subscription');},unsubscribe(){throw new Error('Separate native subscription');}};
 async function nativeProfileLoader(userId,options){
   const {guildId,withMutualGuilds}=options;
   flux.dispatch({type:'USER_PROFILE_FETCH_START',userId,guildId});
   try{
     const body=await new Promise((resolve,reject)=>{
       const row={userId,guildId,withMutualGuilds,withMutualFriends:options.withMutualFriends,aborted:false,finish:resolve};requests.push(row);
       options.abortSignal.addEventListener('abort',()=>{row.aborted=true;reject(new Error('cancelled'));},{once:true});
     });
     flux.dispatch({type:'USER_PROFILE_FETCH_SUCCESS',userProfile:{user:{id:userId},...body},guildId});
   }catch(error){flux.dispatch({type:'USER_PROFILE_FETCH_FAILURE',userId,guildId});throw error;}
 }
 window.Syncord={common:{flux:{FluxDispatcher:flux},actions:mode==='common'?{UserProfileActions:{fetchProfile:nativeProfileLoader}}:{},stores:{
   UserStore:{getCurrentUser:()=>({id:'1425993161108357999'}),getUser:id=>({id,username:id,publicFlags:modelFlags.get(id)})},
   UserProfileStore:{getUserProfile:id=>profileCache.get(id),getGuildMemberProfile:(id,guild)=>guildCache.get(id+':'+guild),isFetchingProfile:(id,guild)=>fetching.has(id+':'+(guild??''))},
   ChannelStore:{getChannel:id=>({id,type:0,guild_id:id===CB?GB:GA})},SelectedGuildStore:{getGuildId:()=>GA},SelectedChannelStore:{getChannelId:()=>CA},
   PermissionStore:{computePermissions:channel=>channel.id===HIDDEN?0n:1024n},GuildStore:{getGuildIds:()=>[]},PresenceStore:{getStatus:()=> 'offline',getActivities:()=>[]},
 }},webpack:{find:predicate=>predicate(nativeProfileLoader)?nativeProfileLoader:undefined,findByStoreName:()=>undefined,getRequire:()=>({c:{}})}};
 window.originalDispatch=flux.dispatch;
 const make=(id,user,channel,extra={})=>{
   const li=document.createElement('li');li.id='chat-messages-'+channel+'-'+id;li.innerHTML='<h3><span id="message-username-'+id+'">User</span></h3><p>Message</p>';
   const name=li.querySelector('span');name.__reactFiber$fixture={memoizedProps:{user:{id:'1425993161108357999'},message:{id,channel_id:channel,author:{id:user,...extra}}}};
   document.getElementById('messages').append(li);return li;
 };
 make('1',A,CA,{public_flags:128});make('2',A,CA,{public_flags:128});make('3',B,CB);make('4',C,CA);
 make('5',D,CA).style.cssText='position:absolute;top:5000px';make('6',B,HIDDEN);
 window.badgeCtx={plugin:{id:'show-badges'},log:{info(){},warn(){},error(err){throw err;}},disposable:fn=>window.badgeDisposers.push(fn),
   css:{inject:source=>{const style=document.createElement('style');style.textContent=source;document.head.append(style);badgeDisposers.push(()=>style.remove());}}};
 window.badgeDisposers=[];window.activityDisposers=[];
 window.activityCtx={settings:{get:(key,fallback)=>key==='userIds'?[A]:key==='paused'?true:fallback},log:{warn(){}},disposable:fn=>activityDisposers.push(fn)};
}
async function checks(){
 const {A,B,C,D,GA,GB,CA}=ids,{ShowBadgesPlugin,acquireUserProfiles,profileRequestStats,discordEventStats,startActivity}=api;
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const until=async fn=>{const end=Date.now()+7000;while(!fn()){if(Date.now()>end)throw new Error('Badge UI did not update');await wait(10);}};
 startActivity(activityCtx);const shared=Syncord.common.flux.FluxDispatcher.dispatch;ShowBadgesPlugin.start(badgeCtx);
 await until(()=>requests.length===1);
 const out={sameHook:shared===Syncord.common.flux.FluxDispatcher.dispatch,initialRequests:requests.length,
   flagsBeforeProfile:document.querySelector('#message-username-1').nextElementSibling?.dataset.ids,firstUser:requests[0].userId,
   pendingWithoutWrap:document.querySelector('#message-username-3').dataset.dionBadges==='pending',cached:!!document.querySelector('#message-username-4 + .dion-badges')};
 const extra=acquireUserProfiles();extra.update([{userId:A,guildId:GA,channelId:CA}]);await wait(30);out.dedup=requests.length===1;
 requests[0].finish({badges:[{id:'premium',icon:'a'.repeat(32),description:'Nitro'}],guild_badges:[{id:'guild-a',icon:'b'.repeat(32)}]});
 await until(()=>document.querySelector('#message-username-1 + .dion-badges')?.dataset.ids.includes('premium'));
 out.sameAuthorRows=document.querySelectorAll('.dion-badges[data-user-id="'+A+'"]').length;
 await until(()=>requests.length===2);out.secondUser=requests[1].userId;out.secondGuild=requests[1].guildId;
 requests[1].finish({badges:[],guild_badges:[]});await until(()=>document.querySelector('#message-username-3').dataset.dionBadges==='1');
 out.emptyComplete=!document.querySelector('#message-username-3 + .dion-badges');
 Syncord.common.flux.FluxDispatcher.dispatch({type:'USER_PROFILE_FETCH_SUCCESS',guildId:GB,userProfile:{user:{id:B},badges:[{id:'new-nitro',icon:'d'.repeat(32),description:'New badge'}],guild_badges:[]}});
 await until(()=>document.querySelector('#message-username-3 + .dion-badges')?.dataset.ids.includes('new-nitro'));
 out.emptyUpdates=true;out.guildSeparation=!document.querySelector('#message-username-3 + .dion-badges').dataset.ids.includes('guild-a');
 Syncord.common.flux.FluxDispatcher.dispatch({type:'USER_UPDATE',user:{id:A,public_flags:0}});
 await until(()=>!document.querySelector('#message-username-1 + .dion-badges').dataset.ids.includes('brilliance'));
 out.flagsUpdate=true;out.onlyVisible=requests.length===2;out.noFriends=requests.every(row=>row.withMutualGuilds===false&&row.withMutualFriends===false);
 await wait(100);const beforeFrames=frames,beforeNative=nativeCalls;
 for(let i=0;i<100000;i++)Syncord.common.flux.FluxDispatcher.dispatch({type:'USER_UPDATE',user:{id:'1425993161108357888',public_flags:0}});
 await wait(50);out.unrelatedNoPaint=frames===beforeFrames;out.nativeExactlyOnce=nativeCalls-beforeNative===100000;
 out.stats=discordEventStats();out.idleTimers=profileRequestStats().timers;out.idlePending=profileRequestStats().pending;
 // Profiles are not chat/member badge targets. Opening or expanding a native
 // profile must not schedule a document-wide chat scan for each subtree update.
 const profile=document.createElement('section');profile.className='userPopout_fixture';profile.setAttribute('role','dialog');
 const beforeProfile=frames;document.body.append(profile);await wait(50);
 for(let i=0;i<5;i++){profile.textContent='Profile section '+i;await wait(50);}
 const beforeProfileScroll=frames;profile.dispatchEvent(new Event('scroll'));await wait(50);out.profileScrollFrames=frames-beforeProfileScroll;
 profile.remove();await wait(50);out.profileOnlyFrames=frames-beforeProfile;
 const beforeMixed=frames;document.body.append(profile);document.getElementById('messages').append(document.createElement('p'));await wait(50);
 out.mixedProfileAndChatScan=frames>beforeMixed;profile.remove();await wait(50);
 // Navigation must release obsolete targets now, but not mutate the old chat
 // inside native dispatch. A burst should only rebuild decorations once.
 const chat=document.getElementById('messages'),beforeReset=chat.querySelectorAll('.dion-badges').length,mutations=[];
 const observer=new MutationObserver(records=>mutations.push(...records));observer.observe(chat,{subtree:true,childList:true,attributes:true});
 for(let i=0;i<20;i++)Syncord.common.flux.FluxDispatcher.dispatch({type:'CHANNEL_SELECT',channelId:CA});
 out.navigationSyncMutations=observer.takeRecords().length;
 await wait(80);mutations.push(...observer.takeRecords());observer.disconnect();
 out.navigationRemoved=mutations.flatMap(r=>[...r.removedNodes]).filter(n=>n instanceof Element&&n.matches('.dion-badges')).length;
 out.navigationExpectedRemoved=beforeReset;out.navigationRestored=chat.querySelectorAll('.dion-badges').length===beforeReset;
  // The Settings Panel option is opt-in and updates member badges immediately.
 const E='1425993161108357188';
 const memberRoot=document.createElement('aside');memberRoot.dataset.listId='members-'+GA;memberRoot.style.cssText='position:fixed;right:0;top:0;width:210px';
 const listFiber={memoizedProps:{user:{id:A}}};memberRoot.__reactFiber$fixture=listFiber;
 const makeMember=(label,user)=>{
   const row=document.createElement('div');row.dataset.listItemId='members-'+user.id;row.className='member_fixture';
   row.innerHTML='<div class="nameAndDecorators_fixture"><span class="username_fixture">'+label+'</span><span class="owner-icon">♛</span></div>';
   const name=row.querySelector('.username_fixture');name.__reactFiber$fixture={memoizedProps:{},return:{memoizedProps:{member:{user},guildId:GA,currentUser:{id:A}},return:listFiber}};
   memberRoot.append(row);return row;
 };
 const firstMember=makeMember('Same author', {id:A}),cachedMember=makeMember('Very long member name that must stay compact',{id:C}),unknownMember=makeMember('New member',{id:E,public_flags:128});
 document.body.append(memberRoot);await wait(50);out.membersDefaultOff=!memberRoot.querySelector('.dion-member-badges');
 const panelRoot=document.createElement('section');panelRoot.id='Syncord-settings-root';document.body.append(panelRoot);
 const redraw=()=>{panelRoot.innerHTML='<div class="dion-plugin '+(api.panel.isBadgesExpanded()?'is-open':'')+'">'+api.panel.badgesExpandButtonHtml()+api.panel.badgesSectionHtml()+'</div>';};
 redraw();const disposePanel=api.panel.bindBadgesPanel(panelRoot);
 const option=()=>panelRoot.querySelector('[data-dion-badges-members]');out.defaultSetting=option().checked;
 panelRoot.querySelector('[data-dion-badges-expand]').click();out.expands=panelRoot.querySelector('.dion-plugin').classList.contains('is-open');
 option().checked=true;option().dispatchEvent(new Event('change',{bubbles:true}));
 await until(()=>!!firstMember.querySelector('.dion-member-badges')&&!!unknownMember.querySelector('.dion-member-badges'));
 out.memberIcons=memberRoot.querySelectorAll('.dion-member-badges').length;out.memberSharedUser=firstMember.querySelector('.dion-member-badges').dataset.userId;
 out.memberNoSelfLeak=cachedMember.querySelector('.dion-member-badges').dataset.ids==='cached';
 out.memberQueued=profileRequestStats().pending===1;out.memberNoDuplicate=requests.length===2;
 const chatCount=document.querySelectorAll('#messages .dion-badges').length;
 option().checked=false;option().dispatchEvent(new Event('change',{bubbles:true}));
 await until(()=>!memberRoot.querySelector('.dion-member-badges'));
 out.offPreservesChat=document.querySelectorAll('#messages .dion-badges').length===chatCount;
 out.offDropsPending=profileRequestStats().pending===0;out.offCleansMembers=!memberRoot.querySelector('[data-dion-badge-user],[data-dion-badge-member]');
 redraw();out.persistedOff=option().checked===false;
 option().checked=true;option().dispatchEvent(new Event('change',{bubbles:true}));await until(()=>requests.length===3);
 out.memberOnlyUser=requests[2].userId;
 option().checked=false;option().dispatchEvent(new Event('change',{bubbles:true}));await until(()=>requests[2].aborted);
 out.memberAbortOnOff=true;out.memberNoBackground=profileRequestStats().active===0&&profileRequestStats().pending===0;
 // A virtualized member row reuses DOM with a different user; no previous badges can remain.
 unknownMember.remove();option().checked=true;option().dispatchEvent(new Event('change',{bubbles:true}));await until(()=>cachedMember.querySelector('.dion-member-badges'));
 cachedMember.querySelector('.username_fixture').__reactFiber$fixture.return.memoizedProps.member.user={id:A};document.dispatchEvent(new Event('scroll'));
 await until(()=>cachedMember.querySelector('.dion-member-badges')?.dataset.userId===A);
 out.recycledMember=!cachedMember.querySelector('.dion-member-badges').dataset.ids.includes('cached');
 out.memberFits=[...memberRoot.querySelectorAll('.nameAndDecorators_fixture')].every(row=>row.scrollWidth<=row.clientWidth);
 option().checked=false;option().dispatchEvent(new Event('change',{bubbles:true}));await until(()=>!memberRoot.querySelector('.dion-member-badges'));
 disposePanel();const beforeSetting=api.showBadgesSettings.bind('show-badges').get('memberList');
 option().checked=true;option().dispatchEvent(new Event('change',{bubbles:true}));out.panelCleanup=api.showBadgesSettings.bind('show-badges').get('memberList')===beforeSetting;
 panelRoot.remove();memberRoot.remove();
  // Scrolling a previously offscreen author into view must use the same queue.
 const offscreen=document.querySelector('[id$="-5"]');offscreen.style.cssText='';document.dispatchEvent(new Event('scroll'));
 await until(()=>requests.length===4);out.scrollUser=requests[3].userId;
 extra.release();badgeDisposers.reverse().forEach(fn=>fn());
 out.abortOnStop=requests[3].aborted;out.cleanDOM=!document.querySelector('.dion-badges,[data-dion-badges],[data-dion-badge-user],[data-dion-badge-msg],[data-dion-badge-size],[data-dion-badge-member],[data-dion-badge-guild]');
 out.cleanProfiles=profileRequestStats();out.activityStillAttached=discordEventStats().attached;out.remainingListeners=discordEventStats().listeners;
 activityDisposers.reverse().forEach(fn=>fn());await wait(50);out.finalStats=discordEventStats();out.originalRestored=Syncord.common.flux.FluxDispatcher.dispatch===originalDispatch;
 return out;
}
function driver(dir){
 const {app,BrowserWindow}=require('electron'),path=require('node:path');app.setPath('userData',path.join(dir,'profile'));app.disableHardwareAcceleration();
 app.whenReady().then(async()=>{
   const win=new BrowserWindow({width:700,height:600,show:false,webPreferences:{backgroundThrottling:false}});
   try{
     const results=[];
     for(const mode of ['common','loaded']){
       await win.loadFile(path.join(dir,'index.html'),{query:{mode}});results.push(await win.webContents.executeJavaScript('('+checks.toString()+')()'));
     }
     console.log('SHOW_BADGES_RESULT:'+JSON.stringify(results));win.destroy();app.exit(0);
   }catch(error){console.error(error.stack);win.destroy();app.exit(1);}
 });
}
test('show badges UI: unopened profiles, empty row refresh, shared hub, native lazy loading, visibility and complete cleanup',{
 skip:!electron&&'Electron is not installed',timeout:40_000,
},async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'syncord-show-badges-ui-'));
 try{
   await build({stdin:{resolveDir:root,loader:'ts',contents:`
     import {ShowBadgesPlugin} from './src/renderer/plugins/showBadges';
     import {acquireUserProfiles,profileRequestStats} from './src/renderer/api/discordEvents/profiles';
     import {discordEventStats} from './src/renderer/api/discordEvents';
     import {startActivity} from './src/renderer/plugins/userActivity/runtime';
     import * as panel from './src/renderer/plugins/showBadges/panel';
     import {showBadgesSettings} from './src/renderer/plugins/showBadges/settings';
     window.api={ShowBadgesPlugin,acquireUserProfiles,profileRequestStats,discordEventStats,startActivity,panel,showBadgesSettings};
   `},bundle:true,platform:'browser',format:'iife',outfile:path.join(dir,'fixture.js'),logLevel:'warning',plugins:[{name:'fixture',setup(b){
     b.onResolve({filter:/api\/plugin$/},()=>({path:'plugin',namespace:'fixture'}));
     b.onResolve({filter:/\/settings$/},args=>args.resolveDir.endsWith('/api/plugin')||args.path.includes('api/settings')?{path:'settings',namespace:'fixture'}:undefined);
     b.onResolve({filter:/\/(recorder|toast|logger)$/},args=>({path:args.path.split('/').pop(),namespace:'fixture'}));
     b.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',contents:args.path==='plugin'?'export const definePlugin=p=>p;':args.path==='settings'?'export const settings={get:(key,fallback)=>localStorage.getItem(key)===null?fallback:JSON.parse(localStorage.getItem(key)),set:(key,value)=>localStorage.setItem(key,JSON.stringify(value))};':args.path==='recorder'?'export class ActivityRecorder {record(){}async message(){}async settle(){}failure(){}stop(){}}':args.path==='toast'?'export const showToast=()=>{};':'export const createLogger=()=>({info(){},warn(){},error(){}});'}));
   }}]});
   writeFileSync(path.join(dir,'index.html'),`<!doctype html><html><head><style>body{background:#222;color:#eee;font:14px sans-serif}ul{padding:0}li{list-style:none;height:80px}h3{margin:0}.nameAndDecorators_fixture{display:flex;align-items:center;min-width:0;width:100%;gap:2px}.username_fixture{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.owner-icon{flex-shrink:0}.dion-plugin-details{display:none}.is-open .dion-plugin-details{display:block}</style></head><body><ul id="messages"></ul><script>(${setup.toString()})(new URLSearchParams(location.search).get('mode'));</script><script src="fixture.js"></script></body></html>`);
   writeFileSync(path.join(dir,'main.cjs'),`const checks=${checks.toString()};(${driver.toString()})(${JSON.stringify(dir)});`);
   const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
   const run=spawnSync(electron,[path.join(dir,'main.cjs')],{env,encoding:'utf8',timeout:35_000});assert.equal(run.status,0,`${run.error??''}\n${run.stdout}\n${run.stderr}`);
   const line=run.stdout.split('\n').find(line=>line.startsWith('SHOW_BADGES_RESULT:'));assert.ok(line,run.stdout);
   const results=JSON.parse(line.slice('SHOW_BADGES_RESULT:'.length));
   console.log('PROFILE_CHAT_SCAN:'+JSON.stringify(results.map(r=>({profileOnlyFrames:r.profileOnlyFrames,profileScrollFrames:r.profileScrollFrames,mixedProfileAndChatScan:r.mixedProfileAndChatScan}))));
   for(const r of results){
     assert.equal(r.sameHook,true);assert.equal(r.initialRequests,1);assert.equal(r.flagsBeforeProfile,'brilliance');assert.equal(r.firstUser,'1425993161108357191');
     assert.equal(r.pendingWithoutWrap,true);assert.equal(r.cached,true);assert.equal(r.dedup,true);assert.equal(r.sameAuthorRows,2);
     assert.equal(r.secondUser,'1425993161108357192');assert.equal(r.secondGuild,'1425993161108357202');
     assert.equal(r.emptyComplete,true);assert.equal(r.emptyUpdates,true);assert.equal(r.guildSeparation,true);assert.equal(r.flagsUpdate,true);
     assert.equal(r.onlyVisible,true);assert.equal(r.noFriends,true);assert.equal(r.unrelatedNoPaint,true);assert.equal(r.nativeExactlyOnce,true);
     assert.equal(r.stats.listeners,31);assert.equal(r.stats.interceptors,1);assert.equal(r.idleTimers,0);assert.equal(r.idlePending,0);
     assert.equal(r.profileOnlyFrames,0);assert.equal(r.mixedProfileAndChatScan,true);
     assert.equal(r.profileScrollFrames,0);
     assert.equal(r.navigationSyncMutations,0);assert.ok(r.navigationExpectedRemoved>0);assert.equal(r.navigationRemoved,r.navigationExpectedRemoved);assert.equal(r.navigationRestored,true);
     assert.equal(r.membersDefaultOff,true);assert.equal(r.defaultSetting,false);assert.equal(r.expands,true);
     assert.equal(r.memberIcons,3);assert.equal(r.memberSharedUser,'1425993161108357191');assert.equal(r.memberNoSelfLeak,true);assert.equal(r.memberQueued,true);assert.equal(r.memberNoDuplicate,true);
     assert.equal(r.offPreservesChat,true);assert.equal(r.offDropsPending,true);assert.equal(r.offCleansMembers,true);assert.equal(r.persistedOff,true);
     assert.equal(r.memberOnlyUser,'1425993161108357188');assert.equal(r.memberAbortOnOff,true);assert.equal(r.memberNoBackground,true);
     assert.equal(r.recycledMember,true);assert.equal(r.memberFits,true);assert.equal(r.panelCleanup,true);
     assert.equal(r.scrollUser,'1425993161108357196');assert.equal(r.abortOnStop,true);assert.equal(r.cleanDOM,true);
     assert.deepEqual(r.cleanProfiles,{consumers:0,pending:0,recent:0,active:0,timers:0});assert.equal(r.activityStillAttached,true);assert.equal(r.remainingListeners,15);
     assert.deepEqual(r.finalStats,{listeners:0,interceptors:0,attached:false});assert.equal(r.originalRestored,true);
   }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
