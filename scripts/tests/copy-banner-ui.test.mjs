import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
const root=process.cwd(),electron=['Electron.app/Contents/MacOS/Electron','electron.exe','electron'].map(name=>path.join(root,'node_modules/electron/dist',name)).find(existsSync);
function setup(){
 const USER='1425993161108357191',OTHER='1425993161108357192',GUILD='1425993161108357201',CHANNEL='1425993161108357301';
 window.guildRecords=new Map([[GUILD,{icon:'server-icon',banner:null}]]);window.guildReads=[];window.throwGuildRead=false;
 window.ids={USER,OTHER,GUILD,CHANNEL};window.profiles=new Map();window.guildProfiles=new Map();window.userBanners=new Map();window.writes=[];window.notices=[];window.logs=[];window.closeCount=0;window.keepMenu=false;window.failClipboard=false;
 Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{if(failClipboard)throw new Error('clipboard denied');writes.push(text);}}});
 window.Syncord={common:{stores:{
   UserStore:{getUser:id=>({id,banner:userBanners.get(id),getAvatarURL:()=>`https://cdn.discordapp.com/avatars/${id}/avatar.png?size=4096`})},
   UserProfileStore:{getUserProfile:id=>profiles.get(id),getGuildMemberProfile:(id,guild)=>guildProfiles.get(id+':'+guild)},
   GuildMemberStore:{getMember:()=>({avatar:'guild-avatar'})},GuildStore:{getGuild(id){if(this!==Syncord.common.stores.GuildStore)throw new Error('Lost guild store receiver');if(throwGuildRead)throw new Error('Guild store unavailable');guildReads.push(id);return guildRecords.get(id);}},ChannelStore:{getChannel:()=>({icon:'group-icon'})},
 },flux:{FluxDispatcher:{dispatch(action){if(action.type==='CONTEXT_MENU_CLOSE'){closeCount++;if(!keepMenu)document.querySelector('[role=menu]')?.parentElement.remove();}}}}},webpack:{findByStoreName:()=>undefined}};
 window.disposers=[];window.ctx={log:{info(){},warn:(...args)=>logs.push(args),error:(...args)=>logs.push(args)},disposable:fn=>disposers.push(fn)};
}
async function checks(){
 const {USER,OTHER,GUILD,CHANNEL}=ids;
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const until=async fn=>{const end=Date.now()+2000;while(!fn()){if(Date.now()>end)throw new Error('Copy Banner menu did not update');await wait(10);}};
 const open=async(props,nav='user-context')=>{
   document.querySelector('[role=menu]')?.parentElement.remove();
   const portal=document.createElement('div');portal.innerHTML='<div role="menu" id="'+nav+'"><div role="group"><div id="'+nav+'-user-profile" role="menuitem" class="item_fixture danger_fixture focused_fixture" tabindex="-1"><div class="label_fixture"><span data-marquee-overflow><span>View Profile</span></span></div><svg class="icon_fixture"></svg></div></div></div>';
   const menu=portal.querySelector('[role=menu]');menu.__reactFiber$fixture={memoizedProps:props};document.body.append(portal);
   if(nav==='user-context'||nav==='guild-context'||nav==='gdm-context')await until(()=>menu.querySelector('[data-dion-copy-avatar]'));else await wait(50);
   return menu;
 };
 const banner=()=>document.getElementById('dion-copy-banner');
 const serverBanner=()=>document.getElementById('dion-copy-server-banner');
 profiles.set(USER,{banner:'a'.repeat(32)});
 let menu=await open({user:{id:USER}});
 const out={labels:[...menu.querySelectorAll('[data-dion-copy-avatar]')].map(row=>row.textContent),nativeStructure:!!banner().querySelector('.label_fixture [data-marquee-overflow] span')&&!!banner().querySelector('svg.icon_fixture'),clonesClean:[...menu.querySelectorAll('[data-dion-copy-avatar]')].every(row=>!row.classList.contains('danger_fixture')&&!row.classList.contains('focused_fixture'))};
 const avatar=document.getElementById('dion-copy-avatar');avatar.dispatchEvent(new Event('pointerenter'));out.avatarFocused=avatar.classList.contains('focused_fixture');banner().dispatchEvent(new Event('pointerenter'));out.bannerFocusOnly=banner().classList.contains('focused_fixture')&&!avatar.classList.contains('focused_fixture');
 const first=banner(),before=writes.length,closes=closeCount;first.dispatchEvent(new Event('pointerdown',{bubbles:true}));first.click();await until(()=>writes.length===before+1);
 out.staticURL=writes.at(-1);out.once=closeCount===closes+1&&writes.length===before+1;out.success=notices.at(-1).text;
 guildProfiles.set(USER+':'+GUILD,{banner:'a_'+'b'.repeat(32)});menu=await open({user:{id:USER},guildId:GUILD});banner().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await until(()=>writes.length===before+2);out.guildAnimatedURL=writes.at(-1);
 guildProfiles.set(USER+':'+GUILD,{banner:null});menu=await open({user:{id:USER},guildId:GUILD});banner().click();await until(()=>writes.length===before+3);out.guildFallbackURL=writes.at(-1);
 userBanners.set(USER,'old-stale-banner');profiles.set(USER,{banner:null});menu=await open({user:{id:USER}});const noBannerWrites=writes.length;banner().click();await wait(20);out.noBanner=notices.at(-1).text;out.noBannerNoCopy=writes.length===noBannerWrites;
 profiles.delete(USER);userBanners.delete(USER);menu=await open({user:{id:USER}});banner().click();await wait(20);out.notReady=notices.at(-1).text;
 userBanners.set(USER,'c'.repeat(32));menu=await open({user:{id:USER}});banner().click();await until(()=>writes.length===noBannerWrites+1);out.userStoreURL=writes.at(-1);
 profiles.set(USER,{banner:'d'.repeat(32)});menu=await open({user:{id:USER}});profiles.set(USER,{banner:'e'.repeat(32)});banner().click();await until(()=>writes.length===noBannerWrites+2);out.lateURL=writes.at(-1);
 // React can drop only our new row; the observer must restore it without duplicating Avatar.
 menu=await open({user:{id:USER}});banner().remove();const native=document.createElement('div');native.setAttribute('role','menuitem');native.textContent='Native item';menu.querySelector('[role=group]').append(native);await until(()=>banner());
 out.repaired=menu.querySelectorAll('[data-dion-copy-avatar="avatar"]').length===1&&menu.querySelectorAll('[data-dion-copy-avatar="banner"]').length===1;
 // The same menu element is reused for another user and for repeated copy actions.
 profiles.set(OTHER,{banner:'f'.repeat(32)});keepMenu=true;menu.__reactFiber$fixture.memoizedProps={user:{id:OTHER}};document.dispatchEvent(new Event('contextmenu',{bubbles:true}));await until(()=>banner()?.dataset.copyTarget.includes(OTHER));
 const count=writes.length;banner().click();await until(()=>writes.length===count+1);out.reusedURL=writes.at(-1);
 document.dispatchEvent(new Event('contextmenu',{bubbles:true}));await until(()=>banner());banner().click();await until(()=>writes.length===count+2);out.reopenedCopiesAgain=true;keepMenu=false;
 menu=await open({user:{id:USER},channel:{id:CHANNEL,type:3}});out.groupUserBanner=!!banner()&&document.getElementById('dion-copy-avatar').textContent==='Copy Avatar';
 menu=await open({guild:{id:GUILD}},'guild-context');out.serverNoBanner=!banner();document.getElementById('dion-copy-avatar').click();await wait(20);out.serverURL=writes.at(-1);
 // Server banners are a separate guild-menu action, never a user banner or invite splash.
 guildRecords.set(GUILD,{icon:'server-icon',banner:'1'.repeat(32)});
 menu=await open({guild:{id:GUILD}},'guild-context');
 out.serverLabels=[...menu.querySelectorAll('[data-dion-copy-avatar]')].map(row=>row.textContent);
 out.serverNativeStructure=!!serverBanner().querySelector('.label_fixture [data-marquee-overflow] span')&&!!serverBanner().querySelector('svg.icon_fixture');
 const serverWrites=writes.length,serverCloses=closeCount,firstServer=serverBanner();firstServer.dispatchEvent(new Event('pointerdown',{bubbles:true}));firstServer.click();await until(()=>writes.length===serverWrites+1);
 out.serverBannerURL=writes.at(-1);out.serverBannerSuccess=notices.at(-1).text;out.serverBannerOnce=closeCount===serverCloses+1&&writes.length===serverWrites+1;
 guildRecords.set(GUILD,{banner:'a_'+'2'.repeat(32)});menu=await open({guildId:GUILD},'guild-context');serverBanner().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await until(()=>writes.length===serverWrites+2);out.serverAnimatedURL=writes.at(-1);
 out.serverAbsentNoCopy=true;
 for(const value of [null,undefined]){
  guildRecords.set(GUILD,{banner:value,splash:'invite-splash'});menu=await open({guild:{id:GUILD}},'guild-context');const priorWrites=writes.length;serverBanner().click();await wait(20);
  out.serverMissingBanner=notices.at(-1).text;out.serverAbsentNoCopy&&=writes.length===priorWrites&&notices.at(-1).type==='failure';
 }
 guildRecords.delete(GUILD);menu=await open({guild:{id:GUILD}},'guild-context');const unloadedWrites=writes.length;serverBanner().click();await wait(20);out.serverNotReady=notices.at(-1).text;out.serverUnloadedNoCopy=writes.length===unloadedWrites;
 guildRecords.set(GUILD,{banner:'3'.repeat(32)});const readsBeforeMenu=guildReads.length;menu=await open({guild:{id:GUILD}},'guild-context');out.serverLazyLookup=guildReads.length===readsBeforeMenu;
 guildRecords.set(GUILD,{banner:'4'.repeat(32)});serverBanner().click();await until(()=>writes.length===unloadedWrites+1);out.serverLateURL=writes.at(-1);
 menu=await open({guild:{id:GUILD}},'guild-context');serverBanner().remove();const nativeGuildRow=document.createElement('div');nativeGuildRow.setAttribute('role','menuitem');menu.querySelector('[role=group]').append(nativeGuildRow);await until(()=>serverBanner());
 out.serverRepaired=menu.querySelectorAll('[data-dion-copy-avatar="avatar"]').length===1&&menu.querySelectorAll('[data-dion-copy-avatar="guild-banner"]').length===1;
 const secondGuild='1425993161108357202';guildRecords.set(secondGuild,{banner:'5'.repeat(32)});keepMenu=true;menu.__reactFiber$fixture.memoizedProps={guildId:secondGuild};document.dispatchEvent(new Event('contextmenu',{bubbles:true}));await until(()=>serverBanner()?.dataset.copyTarget.includes(secondGuild));
 serverBanner().click();await until(()=>writes.length===unloadedWrites+2);out.serverReusedURL=writes.at(-1);keepMenu=false;
 menu=await open({guild:{id:GUILD}},'guild-context');failClipboard=true;serverBanner().dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}));await until(()=>notices.at(-1)?.text==="Couldn't copy server banner URL");out.serverClipboardError=notices.at(-1).type==='failure';failClipboard=false;
 menu=await open({guild:{id:GUILD}},'guild-context');throwGuildRead=true;const beforeLookupFailure=writes.length;serverBanner().click();await wait(20);out.serverLookupError=notices.at(-1).text;out.serverLookupNoCopy=writes.length===beforeLookupFailure;throwGuildRead=false;
 menu=await open({channel:{id:CHANNEL,type:3}},'gdm-context');out.groupNoBanner=!banner()&&!serverBanner();document.getElementById('dion-copy-avatar').click();await wait(20);out.groupURL=writes.at(-1);
 menu=await open({message:{id:'message',author:{id:USER}}},'message');out.messageUntouched=!menu.querySelector('[data-dion-copy-avatar]');
 menu=await open({user:{id:USER}});const n=writes.length;document.getElementById('dion-copy-avatar').click();await until(()=>writes.length===n+1);out.avatarURL=writes.at(-1);
 menu=await open({user:{id:USER}});failClipboard=true;banner().dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}));await until(()=>notices.at(-1)?.text==="Couldn't copy banner URL");out.clipboardError=true;failClipboard=false;
 menu=await open({guild:{id:GUILD}},'guild-context');disposers.reverse().forEach(fn=>fn());out.cleaned=!menu.querySelector('[data-dion-copy-avatar]');document.dispatchEvent(new Event('contextmenu',{bubbles:true}));await wait(50);out.staysStopped=!menu.querySelector('[data-dion-copy-avatar]');
 return out;
}
function driver(dir,checkSource){
 const {app,BrowserWindow}=require('electron'),path=require('node:path');app.setPath('userData',path.join(dir,'profile'));app.disableHardwareAcceleration();
 app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:500,height:500,webPreferences:{backgroundThrottling:false}});
 try{await win.loadFile(path.join(dir,'index.html'));const result=await win.webContents.executeJavaScript('('+checkSource+')()');console.log('COPY_BANNER_RESULT:'+JSON.stringify(result));win.destroy();app.exit(0);}catch(error){console.error(error.stack);win.destroy();app.exit(1);}});
}
test('copy banner UI: native user/server-menu rows, animated URLs, absent/unloaded data, click-time lookup, copy failures, reused menus and cleanup',{
 skip:!electron&&'Electron is not installed',timeout:20_000,
},async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'syncord-copy-banner-'));
 try{
   await build({stdin:{resolveDir:root,loader:'ts',contents:`import {CopyAvatarPlugin} from './src/renderer/plugins/copyAvatar';CopyAvatarPlugin.start(window.ctx);`},bundle:true,platform:'browser',format:'iife',outfile:path.join(dir,'fixture.js'),logLevel:'warning',plugins:[{name:'fixture',setup(b){
     b.onResolve({filter:/api\/plugin$/},()=>({path:'plugin',namespace:'fixture'}));b.onResolve({filter:/\/toast$/},()=>({path:'toast',namespace:'fixture'}));
     b.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',contents:args.path==='plugin'?'export const definePlugin=p=>p;':'export const ToastType={SUCCESS:"success",FAILURE:"failure"};export const toast={show:(text,options)=>window.notices.push({text,...options})};'}));
   }}]});
   writeFileSync(path.join(dir,'index.html'),`<!doctype html><html><head><style>.item_fixture{color:white;background:#222}.focused_fixture{background:#5865f2}</style></head><body><script>(${setup.toString()})();</script><script src="fixture.js"></script></body></html>`);
   writeFileSync(path.join(dir,'main.cjs'),`(${driver.toString()})(${JSON.stringify(dir)},${JSON.stringify(checks.toString())});`);
   const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const run=spawnSync(electron,[path.join(dir,'main.cjs')],{env,encoding:'utf8',timeout:15_000});assert.equal(run.status,0,`${run.error??''}\n${run.stdout}\n${run.stderr}`);
   const line=run.stdout.split('\n').find(line=>line.startsWith('COPY_BANNER_RESULT:'));assert.ok(line,run.stdout);const r=JSON.parse(line.slice('COPY_BANNER_RESULT:'.length));
   const USER='1425993161108357191',OTHER='1425993161108357192',GUILD='1425993161108357201',CHANNEL='1425993161108357301';
   assert.deepEqual(r.labels,['Copy Avatar','Copy Banner']);assert.equal(r.nativeStructure,true);assert.equal(r.clonesClean,true);assert.equal(r.avatarFocused,true);assert.equal(r.bannerFocusOnly,true);
   assert.equal(r.staticURL,`https://cdn.discordapp.com/banners/${USER}/${'a'.repeat(32)}.png?size=4096`);assert.equal(r.once,true);assert.equal(r.success,'Banner URL copied');
   assert.equal(r.guildAnimatedURL,`https://cdn.discordapp.com/guilds/${GUILD}/users/${USER}/banners/a_${'b'.repeat(32)}.webp?size=4096&animated=true`);assert.equal(r.guildFallbackURL,r.staticURL);
   assert.equal(r.noBanner,'This user has no banner.');assert.equal(r.noBannerNoCopy,true);assert.match(r.notReady,/not available yet/);
   assert.equal(r.userStoreURL,`https://cdn.discordapp.com/banners/${USER}/${'c'.repeat(32)}.png?size=4096`);assert.equal(r.lateURL,`https://cdn.discordapp.com/banners/${USER}/${'e'.repeat(32)}.png?size=4096`);
   assert.equal(r.repaired,true);assert.equal(r.reusedURL,`https://cdn.discordapp.com/banners/${OTHER}/${'f'.repeat(32)}.png?size=4096`);assert.equal(r.reopenedCopiesAgain,true);
   assert.equal(r.groupUserBanner,true);assert.equal(r.serverNoBanner,true);assert.equal(r.groupNoBanner,true);assert.equal(r.messageUntouched,true);
   assert.equal(r.serverURL,`https://cdn.discordapp.com/icons/${GUILD}/server-icon.png?size=4096`);assert.equal(r.groupURL,`https://cdn.discordapp.com/channel-icons/${CHANNEL}/group-icon.png?size=4096`);
   assert.deepEqual(r.serverLabels,['Copy Server Icon','Copy Server Banner']);assert.equal(r.serverNativeStructure,true);assert.equal(r.serverBannerOnce,true);
   assert.equal(r.serverBannerURL,`https://cdn.discordapp.com/banners/${GUILD}/${'1'.repeat(32)}.png?size=4096`);assert.equal(r.serverBannerSuccess,'Server banner URL copied');
   assert.equal(r.serverAnimatedURL,`https://cdn.discordapp.com/banners/${GUILD}/a_${'2'.repeat(32)}.webp?size=4096&animated=true`);
   assert.equal(r.serverMissingBanner,'This server has no banner.');assert.equal(r.serverAbsentNoCopy,true);assert.match(r.serverNotReady,/Server banner data is not available yet/);assert.equal(r.serverUnloadedNoCopy,true);
   assert.equal(r.serverLazyLookup,true);assert.equal(r.serverLateURL,`https://cdn.discordapp.com/banners/${GUILD}/${'4'.repeat(32)}.png?size=4096`);assert.equal(r.serverRepaired,true);
   assert.equal(r.serverReusedURL,`https://cdn.discordapp.com/banners/1425993161108357202/${'5'.repeat(32)}.png?size=4096`);assert.equal(r.serverClipboardError,true);
   assert.equal(r.serverLookupError,"Couldn't read this server's banner");assert.equal(r.serverLookupNoCopy,true);
   assert.equal(r.avatarURL,`https://cdn.discordapp.com/avatars/${USER}/avatar.png?size=4096`);assert.equal(r.clipboardError,true);assert.equal(r.cleaned,true);assert.equal(r.staysStopped,true);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
