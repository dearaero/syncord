import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
const root=process.cwd(),electron=['Electron.app/Contents/MacOS/Electron','electron.exe','electron'].map(n=>path.join(root,'node_modules/electron/dist',n)).find(existsSync);
function setup(){
 window.calls=[];window.events=[];window.notices=[];window.disposers=[];window.hold=false;
 window.own='100000000000000001';window.other='100000000000000002';
 window.channels={a:{id:'200000000000000001',type:1,recipients:[other]},b:{id:'200000000000000002',type:1,recipients:[other]},c:{id:'200000000000000003',type:3,name:'Test group'},d:{id:'200000000000000004',type:0,guild_id:'300000000000000001',name:'Server text channel'}};
 window.guilds={a:{id:'300000000000000001',name:'Test server',ownerId:other},b:{id:'300000000000000002',name:'Owned server',ownerId:own},c:{id:'300000000000000003',name:'Unknown owner'}};
 const rest={get(){},post(){},put(){},patch(){},async del(options){calls.push(options);if(hold)await new Promise(resolve=>window.release=resolve);return{status:204};}};
 window.Syncord={common:{utils:{RestAPI:rest},stores:{UserStore:{getCurrentUser:()=>({id:own}),getUser:()=>({username:'<img src=x onerror=alert(1)>'})},ChannelStore:{getMutablePrivateChannels:()=>channels,getChannel:id=>Object.values(channels).find(c=>c.id===id)},GuildStore:{getGuilds:()=>guilds,getGuild:id=>Object.values(guilds).find(g=>g.id===id)}},flux:{FluxDispatcher:{dispatch(e){events.push(e);if(e.type==='GUILD_DELETE'){for(const key of Object.keys(guilds))if(guilds[key].id===e.guild.id)delete guilds[key];}else if(e.type==='CHANNEL_DELETE'){for(const key of Object.keys(channels))if(channels[key].id===e.channel.id)delete channels[key];}}}}}};
 window.ctx={css:{inject(css){const s=document.createElement('style');s.textContent=css;document.head.append(s);disposers.push(()=>s.remove());}},log:{warn(){}},disposable:fn=>disposers.push(fn)};
}
async function checks(){
 const wait=ms=>new Promise(r=>setTimeout(r,ms)),until=async fn=>{for(let i=0;i<150;i++){if(fn())return;await wait(10);}throw new Error('DM Closer UI timed out');};const r={};
 const button=()=>document.getElementById('Syncord-dm-closer-toolbar-btn'),dialog=()=>document.querySelector('.Syncord-dm-closer'),q=selector=>dialog().querySelector(selector);
 r.adjacent=button().parentElement.previousElementSibling.querySelector('#Syncord-message-cleaner-toolbar-btn')!==null;
 button().click();r.noAutoRequests=calls.length===0;r.serversDefaultOff=!q('[data-servers]').checked;r.modal=dialog().open;
 r.review=q('[data-scope]').textContent.includes('2 DMs to close · 1 groups to leave')&&q('[data-scope]').textContent.includes('Servers will be kept.');
 r.warning=dialog().textContent.includes('new invite')&&dialog().textContent.includes('keeps its message history');
 r.safeNames=q('[data-targets]').textContent.includes('<img')&&!dialog().querySelector('img');
 r.styled=getComputedStyle(q('[data-start]')).backgroundColor==='rgb(218, 55, 60)';r.responsive=dialog().getBoundingClientRect().width<=innerWidth&&dialog().getBoundingClientRect().height<=innerHeight;
 q('[data-servers]').click();r.guildPreview=q('[data-scope]').textContent.includes('1 servers to leave · 1 owned servers kept · 1 with unknown ownership kept');q('[data-servers]').click();
 q('[data-start]').click();await until(()=>q('[role=status]').textContent.includes('Closing complete.'));
 r.onlyPrivate=calls.length===3&&calls.every(o=>o.url.startsWith('/channels/'))&&Object.keys(channels).length===1&&!!channels.d;
 r.counters=q('[role=status]').textContent.includes('2 DMs closed · 1 groups left · 0 servers left');r.ownedStillThere=!!guilds.b;
 q('[data-close]').click();button().click();r.offOnReopen=!q('[data-servers]').checked&&q('[data-start]').disabled;
 q('[data-servers]').click();q('[data-start]').click();await until(()=>q('[role=status]').textContent.includes('Closing complete.'));
 r.guildOptIn=calls.length===4&&calls[3].url==='/users/@me/guilds/300000000000000001'&&!guilds.a&&!!guilds.b&&!!guilds.c;
 r.guildCount=q('[role=status]').textContent.includes('1 servers left');q('[data-close]').click();
 // Freeze the reviewed plan, then add a new conversation. It must wait for Refresh.
 channels.e={id:'200000000000000005',type:1,name:'Reviewed DM'};button().click();channels.f={id:'200000000000000006',type:3,name:'New group'};window.hold=true;
 q('[data-start]').click();await until(()=>window.release);r.runningRed=button().dataset.active==='true';r.controlsLocked=q('[data-servers]').disabled&&q('[data-refresh]').disabled;
 q('[data-close]').click();document.getElementById('chat').textContent='Another chat';
 document.getElementById('toolbar').innerHTML='<div><button id="Syncord-message-cleaner-toolbar-btn">Cleaner</button></div>';
 await until(()=>button());r.remount=document.querySelectorAll('#Syncord-dm-closer-toolbar-btn').length===1&&button().dataset.active==='true';
 button().click();r.progressOnReopen=q('[data-scope]').textContent.includes('1 DMs to close · 0 groups to leave');q('[data-stop]').click();window.release();
 await until(()=>q('[role=status]').textContent.includes('Closing stopped.'));r.stopped=calls.length===5&&!!channels.f&&q('[role=status]').textContent.includes('1 DMs closed');
 q('[data-refresh]').click();r.refreshed=q('[data-scope]').textContent.includes('0 DMs to close · 1 groups to leave');
 q('[data-start]').click();await until(()=>calls.length===6);disposers.reverse().forEach(fn=>fn());window.release();await wait(40);
 r.cleaned=!button()&&!dialog()&&!document.querySelector('style[data-plugin]');r.noContinue=calls.length===6;
 document.getElementById('toolbar').append(document.createElement('span'));await wait(30);r.staysClean=!button();return r;
}
function driver(dir,checks){const {app,BrowserWindow}=require('electron');app.disableHardwareAcceleration();app.setPath('userData',require('node:path').join(dir,'profile'));app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:390,height:740,webPreferences:{backgroundThrottling:false}});try{await w.loadFile(require('node:path').join(dir,'index.html'));if(process.env.DM_CLOSER_SCREENSHOT_PATH){await w.webContents.executeJavaScript("document.getElementById('Syncord-dm-closer-toolbar-btn').click()");await new Promise(r=>setTimeout(r,100));require('node:fs').writeFileSync(process.env.DM_CLOSER_SCREENSHOT_PATH,(await w.webContents.capturePage()).toPNG());await w.webContents.executeJavaScript("document.querySelector('[data-close]').click()");}const result=await w.webContents.executeJavaScript('('+checks+')()');console.log('DM_CLOSER_UI:'+JSON.stringify(result));w.destroy();app.exit(0);}catch(e){console.error(e.stack);app.exit(1);}});}
test('DM Closer UI: reviewed scope, default-off server opt-in, styled responsive modal, exact requests, Stop, remount and disposal',{skip:!electron&&'Electron missing',timeout:20000},async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'syncord-dm-closer-ui-'));
 try{
  await build({stdin:{resolveDir:root,loader:'ts',contents:"import {DmCloserPlugin} from './src/renderer/plugins/dmCloser'; DmCloserPlugin.start(window.ctx);"},bundle:true,platform:'browser',format:'iife',outfile:path.join(dir,'fixture.js'),logLevel:'warning',plugins:[{name:'fixture',setup(b){
   b.onResolve({filter:/api\/plugin$/},()=>({path:'plugin',namespace:'fixture'}));b.onResolve({filter:/ui\/toast$/},()=>({path:'toast',namespace:'fixture'}));b.onResolve({filter:/ui\/tooltip$/},()=>({path:'tooltip',namespace:'fixture'}));
   b.onLoad({filter:/.*/,namespace:'fixture'},a=>({loader:'js',contents:a.path==='plugin'?'export const definePlugin=p=>p;':a.path==='tooltip'?'export const bindTooltip=()=>()=>{};':'export const ToastType={SUCCESS:"success",FAILURE:"failure"};export const showToast=(text,options)=>window.notices.push({text,...options});'}));
  }}]});
  writeFileSync(path.join(dir,'index.html'),`<!doctype html><html><head><style>body{background:#1e1f22;color:white;font:14px system-ui}#toolbar{display:flex}</style></head><body><div id="toolbar"><div><button id="Syncord-message-cleaner-toolbar-btn">Cleaner</button></div></div><main id="chat">Test chat</main><script>(${setup.toString()})();</script><script src="fixture.js"></script></body></html>`);
  writeFileSync(path.join(dir,'main.cjs'),`(${driver.toString()})(${JSON.stringify(dir)},${JSON.stringify(checks.toString())});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const run=spawnSync(electron,[path.join(dir,'main.cjs')],{env,encoding:'utf8',timeout:15000});assert.equal(run.status,0,`${run.error??''}\n${run.stdout}\n${run.stderr}`);
  const line=run.stdout.split('\n').find(l=>l.startsWith('DM_CLOSER_UI:'));assert.ok(line,run.stdout);const result=JSON.parse(line.slice('DM_CLOSER_UI:'.length));
  for(const [key,value] of Object.entries(result))assert.equal(value,true,key);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
