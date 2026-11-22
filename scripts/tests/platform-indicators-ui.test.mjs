import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';
import {mkdtempSync,writeFileSync,existsSync,rmSync} from 'node:fs';import {spawnSync} from 'node:child_process';import {tmpdir} from 'node:os';import path from 'node:path';
const root=process.cwd(),electron=['Electron.app/Contents/MacOS/Electron','electron.exe','electron'].map(p=>path.join(root,'node_modules/electron/dist',p)).find(existsSync);
function setup(){
 window.A='1425993161108357191';window.B='1425993161108357192';window.C='1425993161108357193';window.D='1425993161108357194';window.E='1425993161108357195';
 window.CA='1425993161108357301';window.CB='1425993161108357302';window.nativeCalls=0;window.frames=0;window.reads=new Map();window.disposers=[];window.errors=[];window.network=0;window.settingsData=new Map();
 window.presences=new Map([[A,{status:'online',clientStatus:{desktop:'online',mobile:'idle'},activities:[]}],[B,{status:'online',clientStatus:{embedded:'online'},activities:[]}],[C,{status:'online',clientStatus:{web:'online',vr:'online'},activities:[]}],[D,{status:'offline',clientStatus:{mobile:'online'},activities:[]}],[E,{status:'online',clientStatus:{mobile:'online'},activities:[]}]]);
 const raf=requestAnimationFrame;window.requestAnimationFrame=fn=>{frames++;return raf(fn);};window.fetch=()=>{network++;throw Error('No extra network');};
 const flux={dispatch(action){nativeCalls++;const apply=row=>{const id=row.user?.id??row.userId??row.user_id;if(id)presences.set(id,{...presences.get(id),...row});};if(action.type==='PRESENCE_UPDATE')apply(action);if(action.type==='PRESENCE_UPDATES')action.updates.forEach(apply);},subscribe(){throw Error('Separate native subscription');},unsubscribe(){throw Error('Separate native subscription');}};
 window.original=flux.dispatch;
 window.Syncord={common:{flux:{FluxDispatcher:flux},stores:{PresenceStore:{getStatus(id){reads.set(id,(reads.get(id)??0)+1);return presences.get(id)?.status;},getClientStatus:id=>presences.get(id)?.clientStatus,getActivities:id=>presences.get(id)?.activities},ChannelStore:{getChannel:id=>({type:id===CA?1:3,recipients:id===CA?[C]:[A,B]})}}},webpack:{findByStoreName(){return undefined;}}};
 window.ctx={plugin:{id:'platform-indicators'},css:{inject(css){const style=document.createElement('style');style.textContent=css;document.head.append(style);disposers.push(()=>style.remove());}},log:{warn(...args){errors.push(args.map(String).join(' '));}},disposable:fn=>disposers.push(fn)};
 window.makeMessage=(number,id,where='messages')=>{
  const row=document.createElement('li');row.id='chat-messages-'+CA+'-'+number;row.innerHTML='<h3><span id="message-username-'+number+'">Name</span><span class="owner-tag">Owner</span></h3><p>Text</p>';
  const name=row.querySelector('span');name.__reactFiber$fixture={memoizedProps:{user:{id:B},message:{author:{id},channel_id:CA}}};document.getElementById(where).append(row);return name;
 };
 makeMessage('1',A);makeMessage('2',A);makeMessage('3',B);makeMessage('4',D);makeMessage('5',E).closest('li').style.cssText='position:absolute;top:5000px';
 const parentFiber={memoizedProps:{user:{id:E}}};document.getElementById('members').__reactFiber$fixture=parentFiber;
 for(const id of [A,B]){const row=document.createElement('div');row.className='member_fixture';row.dataset.listItemId='members-'+id;row.innerHTML='<div class="nameAndDecorators_fixture"><span class="username_fixture">A very long member name</span><span class="owner-tag">♛</span></div>';row.querySelector('span').__reactFiber$fixture={memoizedProps:{user:{id}},return:parentFiber};document.getElementById('members').append(row);}
 const friends=document.getElementById('friends'),row=document.createElement('div');friends.__reactFiber$fixture=parentFiber;row.className='peopleListItem_fixture';row.innerHTML='<span class="username_fixture">Friend</span>';row.querySelector('span').__reactFiber$fixture={memoizedProps:{user:{id:C}},return:parentFiber};friends.append(row);
 const profile=document.getElementById('profile');profile.querySelector('span').__reactFiber$fixture={memoizedProps:{user:{id:B}}};
 document.getElementById('dms').innerHTML='<a href="/channels/@me/'+CA+'"><span class="name_fixture">One-to-one DM</span></a><a href="/channels/@me/'+CB+'"><span class="name_fixture">Group DM</span></a>';
}
async function checks(){
 const {PlatformIndicatorsPlugin:P,sharedDispatcher,discordEventStats,platformSettings,PLATFORM_SETTINGS_EVENT,panel}=api;
 const wait=ms=>new Promise(r=>setTimeout(r,ms));const until=async fn=>{for(let i=0;i<200;i++){if(fn())return;await wait(10);}throw Error('Platform UI timeout');};
 const result={},hub=sharedDispatcher(),other=()=>{};hub.subscribe('PRESENCE_UPDATE',other);const hook=Syncord.common.flux.FluxDispatcher.dispatch;
 P.start(ctx);await until(()=>document.querySelectorAll('[data-syncord-platforms]').length===8);await wait(70);
 result.sharedHook=Syncord.common.flux.FluxDispatcher.dispatch===hook;result.initial=Object.fromEntries(['message','member','friend','dm','profile'].map(surface=>[surface,document.querySelectorAll('[data-syncord-platforms][data-surface='+surface+']').length]));
 result.multiple=document.querySelector('#message-username-1 + [data-syncord-platforms]').children.length===2;
 result.offlineHidden=!document.querySelector('#message-username-4 + [data-syncord-platforms]');result.offscreenHidden=!document.querySelector('#message-username-5 + [data-syncord-platforms]');
 result.groupExcluded=!document.querySelector('a[href$="'+CB+'"] [data-syncord-platforms]');
 window.platformPreviewReady=true;
 while(window.platformCapture&&!window.platformPreviewCaptured)await wait(10);
 const node=document.querySelector('[data-platform=mobile]');node.dispatchEvent(new Event('mouseenter'));await wait(20);result.tooltip=document.getElementById('Syncord-tooltip').textContent.includes('Mobile · Idle');node.dispatchEvent(new Event('mouseleave'));
 await wait(60);let before=frames,readCount=[...reads.values()].reduce((a,b)=>a+b,0),calls=nativeCalls;
 for(let i=0;i<100000;i++)Syncord.common.flux.FluxDispatcher.dispatch({type:'PRESENCE_UPDATE',userId:'1425993161108357999',status:'online',clientStatus:{web:'online'}});
 await wait(40);result.unrelatedNoWork=frames===before&&readCount===[...reads.values()].reduce((a,b)=>a+b,0);result.nativeOnce=nativeCalls-calls===100000;
 reads.clear();before=frames;
 for(let i=0;i<100;i++)Syncord.common.flux.FluxDispatcher.dispatch({type:'PRESENCE_UPDATE',userId:A,status:'dnd',clientStatus:{desktop:'dnd',mobile:'offline'}});
 await until(()=>document.querySelector('#message-username-1 + [data-syncord-platforms] [data-status=dnd]'));await wait(50);
 result.coalesced=frames-before===1;result.oncePerVisibleUser=reads.get(A)===1&&!reads.has(B)&&!reads.has(C);
 result.allAuthorRows=[...document.querySelectorAll('[data-syncord-platforms][data-user-id="'+A+'"]')].every(w=>w.children.length===1&&w.firstChild.dataset.status==='dnd');
 Syncord.common.flux.FluxDispatcher.dispatch({type:'PRESENCE_UPDATE',user:{id:A},status:'offline'});await until(()=>!document.querySelector('[data-syncord-platforms][data-user-id="'+A+'"]'));
 result.offlineRemovesAll=true;
 Syncord.common.flux.FluxDispatcher.dispatch({type:'PRESENCE_UPDATES',updates:[{userId:A,status:'online',clientStatus:{mobile:'online'}},{userId:B,status:'online',clientStatus:{},activities:[{type:0,platform:'ps5'}]}]});
 await until(()=>document.querySelector('[data-platform=activity-ps5]'));result.activityHonest=document.querySelector('[data-platform=activity-ps5]').getAttribute('aria-label').includes('not a confirmed Discord login');
 const name=document.getElementById('message-username-2');name.__reactFiber$fixture.memoizedProps.message.author.id=C;name.id='message-username-recycled';await until(()=>name.nextElementSibling?.dataset.userId===C);result.recycled=true;
 const badge=document.createElement('span');badge.className='dion-badges';badge.textContent='Existing badge';name.insertAdjacentElement('afterend',badge);await wait(30);before=frames;await wait(70);result.noMutationLoop=frames===before&&badge.isConnected;
 const panelRoot=document.createElement('section');panelRoot.id='Syncord-settings-root';panelRoot.innerHTML='<div class="dion-plugin">'+panel.platformsExpandButtonHtml()+panel.platformsSectionHtml()+'</div>';document.body.append(panelRoot);const disposePanel=panel.bindPlatformsPanel(panelRoot);
 panelRoot.querySelector('[data-dion-platforms-expand]').click();result.expandable=panelRoot.firstElementChild.classList.contains('is-open');
 const option=panelRoot.querySelector('[data-dion-platform-option=memberList]');option.checked=false;option.dispatchEvent(new Event('change',{bubbles:true}));await until(()=>!document.querySelector('[data-syncord-platforms][data-surface=member]'));
 result.settingImmediate=!!document.querySelector('[data-syncord-platforms][data-surface=message]')&&platformSettings.bind('platform-indicators').get('memberList')===false;
 const audio=panelRoot.querySelector('[data-dion-platform-option=activityPlatforms]');audio.checked=false;audio.dispatchEvent(new Event('change',{bubbles:true}));await until(()=>!document.querySelector('[data-platform=activity-ps5]'));result.activitySetting=true;
 disposePanel();panelRoot.remove();
 // A reconnected account must never inherit visible icons from the previous session.
 Syncord.common.flux.FluxDispatcher.dispatch({type:'LOGOUT'});result.logoutClean=!document.querySelector('[data-syncord-platforms]');
 document.body.append(document.createElement('aside'));await wait(40);result.logoutStaysClean=!document.querySelector('[data-syncord-platforms]');
 Syncord.common.flux.FluxDispatcher.dispatch({type:'CONNECTION_OPEN_SUPPLEMENTAL'});await until(()=>document.querySelector('[data-syncord-platforms]'));
 result.reconnect=true;
 const row5=document.getElementById('message-username-5').closest('li');row5.style.cssText='';document.dispatchEvent(new Event('scroll'));await until(()=>document.querySelector('#message-username-5 + [data-syncord-platforms]'));result.scrollVisible=true;
 result.compact=[...document.querySelectorAll('.syncord-platform-icon')].every(icon=>icon.getBoundingClientRect().width===14);
 platformSettings.bind('platform-indicators').set('memberList',true);window.dispatchEvent(new Event(PLATFORM_SETTINGS_EVENT));await until(()=>document.querySelector('[data-surface=member]'));
 document.getElementById('members').style.width='110px';await wait(30);
 result.narrow=[...document.querySelectorAll('#members .syncord-platform-icon')].every(icon=>{const a=icon.getBoundingClientRect(),b=icon.closest('.member_fixture').getBoundingClientRect();return a.width===14&&a.left>=b.left&&a.right<=b.right+1;});
 result.network=network;result.errors=errors;
 disposers.reverse().forEach(fn=>fn());result.cleanDOM=!document.querySelector('[data-syncord-platforms]');result.otherConsumerSurvives=discordEventStats().attached&&Syncord.common.flux.FluxDispatcher.dispatch===hook;
 before=frames;Syncord.common.flux.FluxDispatcher.dispatch({type:'PRESENCE_UPDATE',userId:C,status:'offline'});document.body.append(document.createElement('div'));window.dispatchEvent(new Event(PLATFORM_SETTINGS_EVENT));await wait(60);result.noPostStopWork=frames===before;
 hub.unsubscribe('PRESENCE_UPDATE',other);result.finalStats=discordEventStats();result.originalRestored=Syncord.common.flux.FluxDispatcher.dispatch===original;
 return result;
}
function driver(dir){const {app,BrowserWindow}=require('electron'),path=require('node:path');app.disableHardwareAcceleration();app.setPath('userData',path.join(dir,'profile'));app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:900,height:920,webPreferences:{backgroundThrottling:false}});try{await w.loadFile(path.join(dir,'index.html'));await w.webContents.executeJavaScript('window.platformCapture='+Boolean(process.env.PLATFORM_SCREENSHOT_PATH));const pending=w.webContents.executeJavaScript('('+checks.toString()+')()');if(process.env.PLATFORM_SCREENSHOT_PATH){for(let i=0;i<200;i++){if(await w.webContents.executeJavaScript('Boolean(window.platformPreviewReady)'))break;await new Promise(r=>setTimeout(r,10));}require('node:fs').writeFileSync(process.env.PLATFORM_SCREENSHOT_PATH,(await w.webContents.capturePage()).toPNG());await w.webContents.executeJavaScript('window.platformPreviewCaptured=true');}const result=await pending;console.log('PLATFORM_UI:'+JSON.stringify(result));w.destroy();app.exit(0);}catch(e){console.error(e.stack);app.exit(1);}});}
test('Platform Indicators UI: real layout, shared hub, event coalescing, recycled rows, settings, offline safety and complete cleanup',{skip:!electron&&'Electron missing',timeout:25000},async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'syncord-platform-ui-'));
 try{
 await build({stdin:{resolveDir:root,loader:'ts',contents:`import {PlatformIndicatorsPlugin} from './src/renderer/plugins/platformIndicators';import {sharedDispatcher,discordEventStats} from './src/renderer/api/discordEvents';import {platformSettings,PLATFORM_SETTINGS_EVENT} from './src/renderer/plugins/platformIndicators/settings';import * as panel from './src/renderer/plugins/platformIndicators/panel';window.api={PlatformIndicatorsPlugin,sharedDispatcher,discordEventStats,platformSettings,PLATFORM_SETTINGS_EVENT,panel};`},bundle:true,platform:'browser',format:'iife',outfile:path.join(dir,'fixture.js'),logLevel:'warning',plugins:[{name:'fixture',setup(b){b.onResolve({filter:/api\/plugin$/},()=>({path:'plugin',namespace:'fixture'}));b.onResolve({filter:/api\/settings$|^\.\.\/settings$/},()=>({path:'settings',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},a=>({loader:'js',contents:a.path==='plugin'?'export const definePlugin=p=>p;':'export const settings={get:(key,fallback)=>window.settingsData.get(key)??fallback,set:(key,value)=>window.settingsData.set(key,value)};'}));}}]});
 writeFileSync(path.join(dir,'index.html'),`<!doctype html><html><head><style>body{background:#1e1f22;color:#eee;font:14px system-ui;margin:12px}h3{display:flex;align-items:center;margin:5px 0}p{margin:2px}li{list-style:none}.member_fixture{width:100%}.nameAndDecorators_fixture{display:flex;min-width:0;align-items:center}.username_fixture{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;min-width:0}.owner-tag{flex:none}#messages{max-width:calc(100% - 250px)}#members{position:absolute;right:12px;top:12px;width:205px}#dms a{display:flex;width:240px}#profile{width:230px;margin-top:8px}.dion-plugin-details{display:none}.is-open .dion-plugin-details{display:block}</style></head><body><ul id="messages"></ul><aside id="members" data-list-id="members-test"></aside><div id="dms" class="privateChannels_fixture"></div><section id="friends"></section><div id="profile" class="userPopoutOuter_fixture"><span class="username_fixture">Profile</span></div><script>(${setup.toString()})()</script><script src="fixture.js"></script></body></html>`);
 writeFileSync(path.join(dir,'main.cjs'),`const checks=${checks.toString()};(${driver.toString()})(${JSON.stringify(dir)});`);
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const run=spawnSync(electron,[path.join(dir,'main.cjs')],{env,encoding:'utf8',timeout:22000});assert.equal(run.status,0,`${run.error??''}\n${run.stdout}\n${run.stderr}`);
 const line=run.stdout.split('\n').find(l=>l.startsWith('PLATFORM_UI:'));assert.ok(line,run.stdout);const r=JSON.parse(line.slice('PLATFORM_UI:'.length));
 assert.deepEqual(r.initial,{message:3,member:2,friend:1,dm:1,profile:1});assert.equal(r.network,0);assert.deepEqual(r.errors,[]);assert.deepEqual(r.finalStats,{listeners:0,interceptors:0,attached:false});
 for(const key of ['sharedHook','multiple','offlineHidden','offscreenHidden','groupExcluded','tooltip','unrelatedNoWork','nativeOnce','coalesced','oncePerVisibleUser','allAuthorRows','offlineRemovesAll','activityHonest','recycled','noMutationLoop','expandable','settingImmediate','activitySetting','logoutClean','logoutStaysClean','reconnect','scrollVisible','compact','narrow','cleanDOM','otherConsumerSurvives','noPostStopWork','originalRestored'])assert.equal(r[key],true,key);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
