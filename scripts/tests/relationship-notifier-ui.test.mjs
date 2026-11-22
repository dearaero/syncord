import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {tmpdir} from 'node:os';
const root=process.cwd(),electron=['Electron.app/Contents/MacOS/Electron','electron.exe','electron'].map(p=>path.join(root,'node_modules/electron/dist',p)).find(existsSync);
function setup(){
 const A='1425993161108357000',B='1425993161108357001',U='1425993161108357002',V='1425993161108357003',G='1425993161108357004',S='1425993161108357005',W='1425993161108357006';
 window.ids={A,B,U,V,G,S,W};window.preferences=new Map([['plugins.relationship-notifier.data.members',true],['plugins.relationship-notifier.data.notifyMemberAdded',true],['plugins.relationship-notifier.data.notifyMemberRemoved',true]]);
 const people={[U]:{id:U,username:'alice',globalName:'Alice'},[V]:{id:V,username:'bob',globalName:'Bob'},[W]:{id:W,username:'eve',globalName:'Eve <img src=x onerror="bad()">'}};
 window.state={account:A,online:false,relationships:new Map(),groups:{},guilds:{},unavailable:new Set(),geoRestricted:[]};window.calls=[];window.warnings=[];window.profileCalls=[];window.dmCalls=[];window.deferred=[];window.delayRest=false;window.failRest=false;window.disposers=[];window.createdBlobs=[];window.revoked=[];window.downloads=[];
 const createURL=URL.createObjectURL.bind(URL),revokeURL=URL.revokeObjectURL.bind(URL);URL.createObjectURL=blob=>{createdBlobs.push(blob);return createURL(blob);};URL.revokeObjectURL=url=>{revoked.push(url);revokeURL(url);};
 document.addEventListener('click',event=>{if(event.target instanceof HTMLAnchorElement&&event.target.download){downloads.push(event.target.download);event.preventDefault();}},true);
 window.nativeDispatch=action=>{
  const e=action,channel=e.channel,rel=e.relationship;
  if(e.type==='CONNECTION_OPEN'){
   state.account=e.user.id;state.online=true;state.relationships=new Map(e.relationships.map(r=>[r.id,r.type]));state.groups=Object.fromEntries(e.initialPrivateChannels.map(c=>[c.id,c]));state.guilds=Object.fromEntries(e.guilds.map(g=>[g.id,g]));state.unavailable=new Set(e.unavailableGuilds);state.geoRestricted=e.geoRestrictedGuilds??[];
  }
  if(e.type==='CONNECTION_OPEN_SUPPLEMENTAL')for(const g of e.lazyPrivateChannels)state.groups[g.id]=g;
  if(e.type==='CONNECTION_CLOSED')state.online=false;
  if(e.type==='CONNECTION_RESUMED')state.online=true;
  if(e.type==='LOGOUT'){state.account='';state.online=false;}
  if(e.type==='CURRENT_USER_UPDATE')state.account=e.user.id;
  if(e.type==='RELATIONSHIP_ADD'||e.type==='RELATIONSHIP_UPDATE')state.relationships.set(rel.id,rel.type);
  if(e.type==='RELATIONSHIP_REMOVE')state.relationships.delete(rel.id);
  if(e.type==='CHANNEL_CREATE')state.groups[channel.id]=channel;
  if(e.type==='CHANNEL_DELETE')delete state.groups[channel.id];
  if(e.type==='CHANNEL_RECIPIENT_ADD'&&state.groups[e.channelId])state.groups[e.channelId].recipients=[...new Set([...state.groups[e.channelId].recipients,e.user.id])];
  if(e.type==='CHANNEL_RECIPIENT_REMOVE'&&state.groups[e.channelId])state.groups[e.channelId].recipients=state.groups[e.channelId].recipients.filter(id=>id!==e.user.id);
  if(e.type==='GUILD_CREATE'){state.guilds[e.guild.id]=e.guild;state.unavailable.delete(e.guild.id);}
  if(e.type==='GUILD_DELETE'){delete state.guilds[e.guild.id];if(e.guild.unavailable)state.unavailable.add(e.guild.id);else state.unavailable.delete(e.guild.id);}
  if(e.type==='GUILD_UNAVAILABLE')state.unavailable.add(e.guildId);
 };
 window.rest={};for(const method of ['get','put','post','patch','del'])rest[method]=options=>{
  calls.push({method,url:options.url});if(failRest){failRest=false;return Promise.reject(Error('HTTP failure'));}
  if(delayRest){delayRest=false;return new Promise((resolve,reject)=>deferred.push({resolve,reject}));}return Promise.resolve({status:204});
 };
 window.originalRest={...rest};window.dmChannels={};window.dmRoutes=[];window.dmRecipients=[];window.emptyGroups=0;window.actionToasts=[];window.settingsClosed=0;
 window.nativeProfiles={openUserProfileModal({userId}){profileCalls.push(userId);return Promise.resolve();}};
 window.nativeSelections=[];window.nativeNavigation={selectPrivateChannel(channelId){if(this!==nativeNavigation)throw Error('Native selector receiver lost');nativeSelections.push(channelId);dmRoutes.push('/channels/@me/'+channelId);const channel=dmChannels[channelId];if(channel?.type===1)dmCalls.push(channel.recipients[0]);}};
 window.nativeChannels={
  // Match current Discord: passing a string to this method would create an empty group.
  openPrivateChannel({recipientIds}){if(!recipientIds?.length){emptyGroups++;return Promise.resolve();}return this.ensurePrivateChannel(recipientIds);},
  getOrEnsurePrivateChannel(id){const channel=Object.values(dmChannels).find(c=>c.type===1&&c.recipients[0]===id);return channel?.id??this.ensurePrivateChannel([id]);},
  ensurePrivateChannel(recipients){dmRecipients.push(recipients);if(!Array.isArray(recipients)||recipients.length!==1)throw Error('Expected exactly one recipient');const id=String(BigInt(recipients[0])+100n);dmChannels[id]={id,type:1,recipients};return Promise.resolve(id);},
  closePrivateChannel(id){Syncord.common.flux.FluxDispatcher.dispatch({type:'CHANNEL_DELETE',channel:{id},silent:false});return rest.del({url:'/channels/'+id});}
 };
 window.nativeRelationships={
  addRelationship(options){const promise=rest.put({url:'/users/@me/relationships/'+options.userId,body:{}});Syncord.common.flux.FluxDispatcher.dispatch({type:'RELATIONSHIP_ADD',relationship:{id:options.userId,type:4,user:people[options.userId]}});return promise;},
  removeRelationship(id){return rest.del({url:'/users/@me/relationships/'+id});}
 };
 const stores={UserStore:{getCurrentUser:()=>state.account?{id:state.account}:undefined,getUser:id=>people[id]},
  RelationshipStore:{getMutableRelationships:()=>state.relationships,getRelationshipType:id=>state.relationships.get(id)??0},ChannelStore:{getMutablePrivateChannels:()=>state.groups,getChannel:id=>state.groups[id]??dmChannels[id],getDMFromUserId:id=>Object.values(dmChannels).find(c=>c.type===1&&c.recipients[0]===id)?.id},GuildStore:{getGuilds:()=>state.guilds,getGuild:id=>state.guilds[id]},GeoRestrictedGuildStore:{getGeoRestrictedGuilds:()=>state.geoRestricted},
  GuildAvailabilityStore:{get unavailableGuilds(){return [...state.unavailable];},isUnavailable:id=>state.unavailable.has(id)},GatewayConnectionStore:{isConnected:()=>state.online}};
 window.Syncord={common:{stores,flux:{FluxDispatcher:{dispatch:nativeDispatch}},utils:{RestAPI:rest},actions:{ChannelActionCreators:nativeChannels}},webpack:{findByStoreName:name=>stores[name],findByProps:(...keys)=>[nativeChannels,nativeRelationships,nativeProfiles,nativeNavigation].find(m=>keys.every(k=>typeof m[k]==='function'))},closeSettings(){settingsClosed++;},toast:{show(message){actionToasts.push(message);}}};
 window.newContext=()=>({css:{inject(css){const style=document.createElement('style');style.textContent=css;document.head.append(style);disposers.push(()=>style.remove());}},patch:{before:(...args)=>{const undo=api.patcher.before(...args);disposers.push(undo);return undo;},after:(...args)=>{const undo=api.patcher.after(...args);disposers.push(undo);return undo;}},log:{warn:(...args)=>warnings.push(args.map(String))},disposable:fn=>disposers.push(fn)});
}
async function checks(){
 const {A,B,U,V,G,S,W}=ids,results={},db=api.relationshipStorage;
 const wait=ms=>new Promise(r=>setTimeout(r,ms)),until=async(fn,label)=>{const start=Date.now();while(!await fn()){if(Date.now()-start>6000)throw Error('Timeout: '+label);await wait(10);}};
 const emit=(type,value={})=>Syncord.common.flux.FluxDispatcher.dispatch({type,...value}),count=async(account=A)=>(await db.page(account)).total;
 const history=()=>document.getElementById('Syncord-relationship-history'),notice=()=>document.getElementById('Syncord-relationship-notices');
 const person=id=>({id,username:id===U?'alice':'bob',name:id===U?'Alice':'Bob'}),group=()=>({id:G,type:3,name:'Study group',recipients:[U,V]});
 const connect=(account=A,relations=[{id:U,type:1},{id:V,type:3}],initial=[group()],lazy=[],guilds=[{id:S,name:'Server'}],unavailable=[])=>{
  emit('CONNECTION_OPEN',{user:{id:account},relationships:relations,initialPrivateChannels:initial,guilds,unavailableGuilds:unavailable});
  emit('CONNECTION_OPEN_SUPPLEMENTAL',{lazyPrivateChannels:lazy});emit('POST_CONNECTION_OPEN');
 };
 const stop=async()=>{disposers.splice(0).reverse().forEach(fn=>fn());await wait(100);};
 const start=()=>api.RelationshipNotifier.start(newContext());
 start();connect();await until(async()=>(await db.backup(A)).friends.length===1,'baseline backup');await wait(100);
 results.baseline=await count()===0&&!notice();results.noBackgroundRequests=calls.length===0;
 emit('GUILD_MEMBER_REMOVE',{guildId:S,user:{id:U}});emit('GUILD_DELETE',{guild:{id:S,unavailable:true}});emit('GUILD_UNAVAILABLE',{guildId:S});await wait(100);results.outage=await count()===0;
 emit('GUILD_CREATE',{guild:{id:S,name:'Server'}});
 emit('RELATIONSHIP_REMOVE',{relationship:{id:U}});emit('RELATIONSHIP_REMOVE',{relationship:{id:U}});await until(async()=>await count()===1,'external unfriend');await until(()=>notice(),'interactive notice');
 results.externalNotice=notice().textContent.includes('Alice')&&notice().querySelectorAll('article').length===1&&!notice().textContent.includes('blocked');
 const notices=notice();notices.querySelector('[data-rn-action=profile]').click();await wait(20);results.noticeNavigation=!notice()&&profileCalls.at(-1)===U;
 api.openRelationshipHistory();await until(()=>history()?.querySelector('[data-rn-action=dm]'),'DM action');history().querySelector('[data-rn-action=dm]').click();await until(()=>!history(),'native DM navigation');
 results.noNamedRouter=Syncord.webpack.findByProps('transitionTo')===undefined&&Syncord.common.utils.NavigationRouter===undefined&&nativeSelections.at(-1)===String(BigInt(U)+100n);
 results.quickActions=dmCalls.at(-1)===U&&dmRecipients.length===1&&dmRecipients[0].length===1&&dmRecipients[0][0]===U&&emptyGroups===0&&dmRoutes.at(-1)==='/channels/@me/'+String(BigInt(U)+100n)&&settingsClosed===2;
 // A failed asynchronous native action remains visible after the dialog was closed.
 const originalProfile=nativeProfiles.openUserProfileModal;nativeProfiles.openUserProfileModal=()=>Promise.reject(Error('Profile temporarily unavailable'));
 api.openRelationshipHistory();await until(()=>history()?.querySelector('[data-rn-action=profile]'),'failing profile');history().querySelector('[data-rn-action=profile]').click();await until(()=>actionToasts.length===1,'visible action error');results.actionError=actionToasts[0]==='Profile temporarily unavailable'&&!history();nativeProfiles.openUserProfileModal=originalProfile;
 api.openRelationshipHistory();await until(()=>history()?.querySelector('[data-rn-action=request]'),'friend request action');history().querySelector('[data-rn-action=request]').click();await until(()=>state.relationships.get(U)===4,'send friend request');await wait(100);results.explicitRequest=calls.filter(c=>c.method==='put').length===1&&await count()===1;results.requestDisabled=history().querySelector('[data-rn-action=request]').disabled;
 emit('RELATIONSHIP_REMOVE',{relationship:{id:U}});emit('RELATIONSHIP_REMOVE',{relationship:{id:V}});await until(async()=>await count()===3,'cancelled requests');
 results.requestReenabled=!history().querySelector('[data-rn-action=request]').disabled;
 const requests=(await db.page(A)).entries;results.requestKinds=requests.some(r=>r.kind==='incoming-request-ended')&&requests.some(r=>r.kind==='outgoing-request-ended');
 emit('RELATIONSHIP_ADD',{relationship:{id:U,type:1}});await until(async()=>await count()===4,'friend restored');
 delayRest=true;const local=rest.del({url:'/users/@me/relationships/'+U});emit('RELATIONSHIP_REMOVE',{relationship:{id:U}});await wait(100);results.pendingNotCommitted=await count()===4;
 deferred.shift().resolve({status:204});await local;await until(async()=>await count()===5,'local confirmed');emit('RELATIONSHIP_REMOVE',{relationship:{id:U}});await wait(50);results.localConfirmed=(await db.page(A)).entries[0].cause==='local'&&await count()===5;
 emit('RELATIONSHIP_ADD',{relationship:{id:U,type:1}});await until(async()=>await count()===6,'friend restored twice');failRest=true;await rest.del({url:'/users/@me/relationships/'+U}).catch(()=>{});await wait(20);
 emit('RELATIONSHIP_REMOVE',{relationship:{id:U}});await until(async()=>await count()===7,'failed intent released');results.failedIntent=(await db.page(A)).entries[0].cause==='unknown';
 failRest=true;await nativeChannels.closePrivateChannel(G).catch(()=>{});await wait(100);results.failedOptimisticClose=await count()===7;
 emit('CHANNEL_CREATE',{channel:group()});emit('CHANNEL_DELETE',{channel:{id:G,type:3}});await until(async()=>await count()===8,'external group removal');
 emit('CHANNEL_CREATE',{channel:group()});await nativeChannels.closePrivateChannel(G);await until(async()=>await count()===9,'confirmed native leave');results.localGroup=(await db.page(A)).entries[0].cause==='local';
 emit('CHANNEL_CREATE',{channel:group()});emit('CHANNEL_RECIPIENT_ADD',{channelId:G,user:{id:W}});emit('CHANNEL_RECIPIENT_REMOVE',{channelId:G,user:{id:W}});emit('CHANNEL_RECIPIENT_REMOVE',{channelId:G,user:{id:W}});await until(async()=>await count()===11,'group member changes');results.members=(await db.page(A)).entries.slice(0,2).every(r=>r.kind.startsWith('group-member-'));
 emit('GUILD_DELETE',{guild:{id:S}});await until(async()=>await count()===12,'server removed');
 emit('GUILD_CREATE',{guild:{id:S,name:'Server'}});await rest.del({url:'/users/@me/guilds/'+S});await until(async()=>await count()===13,'local server leave');emit('GUILD_DELETE',{guild:{id:S}});await wait(40);results.localServer=(await db.page(A)).entries[0].cause==='local'&&await count()===13;
 emit('RELATIONSHIP_ADD',{relationship:{id:U,type:1}});await until(async()=>await count()===14,'pre-offline baseline');emit('GUILD_CREATE',{guild:{id:S,name:'Server'}});await wait(80);
 await stop();results.unpatched=Object.keys(originalRest).every(k=>rest[k]===originalRest[k])&&Syncord.common.flux.FluxDispatcher.dispatch===nativeDispatch;
 // A lazy group arrives after READY. Its temporary absence cannot be a removal.
 state.online=false;start();connect(A,[],[],[group()],[],[S]);await until(async()=>await count()===15,'offline friend removal');await until(()=>notice()?.textContent.includes('previous session'),'offline summary');await wait(100);
 results.offline=(await db.page(A)).entries[0].offline===true&&notice().textContent.includes('Alice')&&await count()===15;
 emit('POST_CONNECTION_OPEN');await wait(100);results.reconnectDedup=await count()===15;
 // A resumed connection replays changes while disconnected, then reconciles.
 emit('CONNECTION_CLOSED');emit('RELATIONSHIP_ADD',{relationship:{id:U,type:1}});emit('CONNECTION_RESUMED');await until(async()=>await count()===16,'replayed friend add');results.resume=(await db.page(A)).entries[0].offline===true;
 await stop();state.online=false;start();connect(A,[],[],[],[],[S]);await until(async()=>await count()===18,'offline group removal');results.offlineGroup=(await db.page(A)).entries.some(r=>r.kind==='group-removed'&&r.offline);
 emit('RELATIONSHIP_ADD',{relationship:{id:U,type:1}});emit('CHANNEL_CREATE',{channel:group()});await until(async()=>await count()===19,'pre-partial baseline');
 emit('CONNECTION_OPEN',{user:{id:A},relationships:[],initialPrivateChannels:[],guilds:[],unavailableGuilds:[],failedStates:['relationships']});emit('POST_CONNECTION_OPEN');await wait(120);
 results.failedStartupData=await count()===19;
 emit('CONNECTION_OPEN',{user:{id:A},relationships:[{id:U,type:1}],initialPrivateChannels:[group()],guilds:[],unavailableGuilds:[],geoRestrictedGuilds:[{id:S,name:'Server',geo_restricted:true}]});emit('POST_CONNECTION_OPEN');await wait(120);
 results.geoRestricted=await count()===19;
 api.openRelationshipHistory();await until(()=>history()?.querySelector('article'),'history page');results.historyNativeDialog=history().open&&history().querySelector('[data-rn-action=profile]')!==null;history().querySelector('[data-rn-action=profile]').click();results.historyNavigation=!history();await wait(10);
 emit('LOGOUT');results.logoutClears=!history()&&!notice();
 // UserStore can switch before the rest of Discord's caches. Do not copy A's
 // cached relationships/groups into B before B's new connection snapshot.
 emit('CURRENT_USER_UPDATE',{user:{id:B}});await wait(100);results.noCrossAccountCache=await count(B)===0&&(await db.backup(B)).friends.length===0;
 connect(B,[{id:W,type:1}],[],[],[]);await until(async()=>(await db.backup(B)).friends.length===1,'account B baseline');results.accountIsolation=await count(B)===0&&(await db.backup(B)).friends.every(r=>r.id===W)&&(await db.backup(A)).friends.some(r=>r.id===U);
 const cfg=api.config();await Promise.all([1,2].map(()=>db.update(B,old=>api.transition(old,B,{scope:'relationship',id:W},cfg,Date.now(),'unknown'),true,()=>true)));
 results.atomicDedup=await count(B)===1;
 // Indexed reads remain paged even with many events. User text is never HTML.
 await db.update(B,old=>({snapshot:{...old,revision:old.revision+1},backup:[],entries:Array.from({length:120},(_,i)=>({accountId:B,kind:'friend-added',subjectId:W,user:{id:W,username:'eve',name:'Eve <img src=x onerror="bad()">'},name:'Eve',detectedAt:1700000000000+i,offline:false,cause:'unknown'}))}),true,()=>true);
 api.openRelationshipHistory();await until(()=>history()?.querySelectorAll('article').length===50,'bounded history');results.historyPaged=history().querySelector('[data-count]').textContent.includes('121')&&history().querySelectorAll('img').length===0;
 history().querySelector('[data-older]').click();await until(()=>history()?.querySelector('[data-count]').textContent.includes('50 on this page')&&!history().querySelector('.rn-list').hasAttribute('aria-busy'),'older page');
 history().querySelector('[data-older]').click();await until(()=>history()?.querySelectorAll('article').length===21,'last history page');results.pagination=history().querySelector('[data-older]').disabled;
 history().querySelector('[data-mode]').value='backup';history().querySelector('[data-mode]').dispatchEvent(new Event('change'));await until(()=>history()?.querySelector('[data-count]').textContent.includes('backed-up'),'backup view');results.backupView=history().querySelector('.rn-list').textContent.includes(W)&&!history().querySelector('.rn-list').textContent.includes(U);
 history().querySelector('[data-export]').click();await until(()=>createdBlobs.length===1,'JSON export');const exported=JSON.parse(await createdBlobs[0].text());results.export=exported.accountId===B&&exported.friends.length===1&&exported.friends[0].id===W&&downloads[0].includes(B);
 api.closeRelationshipHistory();results.exportReleased=revoked.length===1;
 const panel=document.createElement('section');panel.innerHTML='<div class="dion-plugin">'+api.relationshipExpandButtonHtml()+api.relationshipSectionHtml()+'</div>';document.body.append(panel);const disposePanel=api.bindRelationshipPanel(panel);
 panel.querySelector('[data-rn-expand]').click();results.settingsExpand=panel.firstElementChild.classList.contains('is-open');
 const duration=panel.querySelector('[data-rn-option=duration]');duration.value='999';duration.dispatchEvent(new Event('change',{bubbles:true}));results.settingClamp=api.config().duration===60;
 const members=panel.querySelector('[data-rn-option=members]');members.click();results.settingToggle=api.config().members===false;
 results.allPreferences=true;
 for(const key of api.relationshipSettings.keys){if(key==='duration')continue;const input=panel.querySelector('[data-rn-option='+key+']'),before=api.config()[key];input.click();results.allPreferences&&=api.config()[key]===!before;input.click();results.allPreferences&&=api.config()[key]===before;}
 const invalidDuration=api.config().duration;duration.value='';duration.dispatchEvent(new Event('change',{bubbles:true}));results.durationEmptyPreserved=api.config().duration===invalidDuration;
 disposePanel();panel.remove();api.openRelationshipHistory();await wait(50);
 await stop();results.cleanup=!notice()&&!history()&&api.discordEventStats().listeners===0&&!api.discordEventStats().attached&&Object.keys(originalRest).every(k=>rest[k]===originalRest[k]);
 const before=await count(B);emit('RELATIONSHIP_REMOVE',{relationship:{id:W}});await wait(100);results.disabledInactive=await count(B)===before&&!notice();
 results.warnings=warnings;await db.close();return results;
}
function driver(dir){
 const {app,BrowserWindow,session}=require('electron'),fs=require('node:fs'),path=require('node:path');app.disableHardwareAcceleration();app.setPath('userData',path.join(dir,'profile'));
 app.whenReady().then(async()=>{
  session.defaultSession.protocol.handle('https',request=>{const url=new URL(request.url),name=url.pathname.endsWith('.js')?'fixture.js':'fixture.html';return new Response(fs.readFileSync(path.join(dir,name)),{headers:{'content-type':name.endsWith('.js')?'application/javascript':'text/html'}});});
  const window=new BrowserWindow({show:false,width:900,height:800,webPreferences:{backgroundThrottling:false}});
  try{await window.loadURL('https://discord.com/fixture.html');const result=await window.webContents.executeJavaScript('('+checks.toString()+')()');
   if(process.env.SYNCORD_RELATIONSHIP_SCREENSHOTS){await window.webContents.executeJavaScript('api.openRelationshipHistory()');await new Promise(r=>setTimeout(r,100));fs.writeFileSync('/tmp/syncord-relationship-history-desktop.png',(await window.webContents.capturePage()).toPNG());window.setContentSize(380,600);await new Promise(r=>setTimeout(r,100));fs.writeFileSync('/tmp/syncord-relationship-history-narrow.png',(await window.webContents.capturePage()).toPNG());await window.webContents.executeJavaScript('api.closeRelationshipHistory()');}
   console.log('RELATIONSHIP_UI '+JSON.stringify(result));window.destroy();app.exit(0);}catch(error){console.error(error.stack);app.exit(1);}
 });
}
test('RelationshipNotifier real Electron: shared events, atomic history, offline/lazy/outage safeguards, local confirmations, account isolation, quick actions, JSON and UI cleanup',{skip:!electron&&'Electron missing',timeout:60000},async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'syncord-relationship-ui-'));
 try{
  await build({stdin:{resolveDir:root,contents:`import {RelationshipNotifier} from './src/renderer/plugins/relationshipNotifier';import * as storage from './src/renderer/plugins/relationshipNotifier/storage';import * as engine from './src/renderer/plugins/relationshipNotifier/engine';import * as settings from './src/renderer/plugins/relationshipNotifier/settings';import * as panel from './src/renderer/plugins/relationshipNotifier/panel';import * as view from './src/renderer/plugins/relationshipNotifier/view';import * as patcher from './src/renderer/api/patcher';import {discordEventStats} from './src/renderer/api/discordEvents';window.api={RelationshipNotifier,...storage,...engine,...settings,...panel,...view,patcher,discordEventStats};`},outfile:path.join(dir,'fixture.js'),bundle:true,platform:'browser',format:'iife',logLevel:'silent',plugins:[{name:'fixture',setup(b){
   b.onResolve({filter:/api\/plugin$/},()=>({path:'plugin',namespace:'fixture'}));
   b.onResolve({filter:/^\.\.\/settings$/},a=>a.importer.includes('/api/plugin/')?{path:'settings',namespace:'fixture'}:undefined);
   b.onResolve({filter:/ui\/tooltip$/},()=>({path:'tooltip',namespace:'fixture'}));
   b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path==='plugin'?'export const definePlugin=p=>p;':a.path==='settings'?'export const settings={get:(k,f)=>window.preferences.get(k)??f,set:(k,v)=>window.preferences.set(k,v)};':'export function hideTooltip(){}'}));
  }}]});
  writeFileSync(path.join(dir,'fixture.html'),`<!doctype html><html><body style="background:#17181c;color:white"><input aria-label="Message"><script>(${setup.toString()})();</script><script src="/fixture.js"></script></body></html>`);
  writeFileSync(path.join(dir,'main.cjs'),`const checks=${checks.toString()};(${driver.toString()})(${JSON.stringify(dir)});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const run=spawnSync(electron,[path.join(dir,'main.cjs')],{env,encoding:'utf8',timeout:55000,maxBuffer:2*1024*1024});
  assert.equal(run.status,0,`${run.error??''}\n${run.stdout}\n${run.stderr}`);const line=run.stdout.split('\n').find(line=>line.startsWith('RELATIONSHIP_UI '));assert.ok(line,run.stdout);const results=JSON.parse(line.slice('RELATIONSHIP_UI '.length));assert.deepEqual(results.warnings,[]);for(const [name,value]of Object.entries(results))if(name!=='warnings')assert.equal(value,true,name+' '+JSON.stringify(results));
 }finally{if(process.env.SYNCORD_KEEP_RELATIONSHIP_FIXTURE)console.log('RELATIONSHIP_FIXTURE '+dir);else rmSync(dir,{recursive:true,force:true});}
});
