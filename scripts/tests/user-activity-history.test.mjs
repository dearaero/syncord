import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {tmpdir} from 'node:os';

const root=process.cwd();
const electron=['Electron.app/Contents/MacOS/Electron','electron.exe','electron'].map(name=>path.join(root,'node_modules/electron/dist',name)).find(existsSync);
function setup(){
  const USER='1425993161108357191',OTHER='1425993161108357192',ACCOUNT='1425993161108357999';
  window.historyIds={USER,OTHER,ACCOUNT};window.saved={userIds:[USER,OTHER],paused:true,presence:false,messages:false,typing:false,avatar:false,profile:false,activities:false,voice:false};
  window.toasts=[];window.saveErrors=[];window.nativeMessages=new Map();
  window.Syncord={common:{flux:{FluxDispatcher:{dispatch(action){
      const incoming=action.message,channel=action.channelId??action.channel_id??incoming?.channel_id;
      if(action.type==='MESSAGE_CREATE')nativeMessages.set(channel+':'+incoming.id,structuredClone(incoming));
      if(action.type==='MESSAGE_UPDATE'){const key=channel+':'+incoming.id;if(nativeMessages.has(key))nativeMessages.set(key,{...nativeMessages.get(key),...incoming});}
      if(action.type==='MESSAGE_DELETE')nativeMessages.delete(channel+':'+(action.id??action.messageId??action.message_id??incoming?.id));
      if(action.type==='MESSAGE_DELETE_BULK')for(const id of action.ids??action.messageIds??[])nativeMessages.delete(channel+':'+id);
    }}},stores:{
    UserStore:{getCurrentUser:()=>({id:ACCOUNT}),getUser:id=>({id,username:id===USER?'Alice <img onerror="bad">':'Bob',avatar:'a'})},
    ChannelStore:{getChannel:id=>({id,guild_id:'g',type:0,name:'general'})},PermissionStore:{computePermissions:channel=>channel.id==='hidden'?0n:1024n},
    GuildStore:{getGuildIds:()=>[],getGuild:()=>({name:'Guild'})},PresenceStore:{getStatus:()=> 'offline',getActivities:()=>[]},
    VoiceStateStore:{getVoiceStateForUser:id=>({userId:id,channelId:null})},
    MessageStore:{getMessage:(channel,id)=>nativeMessages.get(channel+':'+id)},
  }}};
  window.disposers=[];window.ctx={settings:{get:(key,fallback)=>window.saved[key]??fallback},log:{warn:(...args)=>window.saveErrors.push(args[0])},disposable:fn=>window.disposers.push(fn)};
}
async function checks(){
  const {USER,OTHER,ACCOUNT}=window.historyIds,foreign='1425993161108357888';
  const {activityHistory,ActivityHistory,openActivityLog}=window.api;
  // Existing version-1 history must survive the schema upgrade and gain correct counters.
  await new Promise((resolve,reject)=>{
    const req=indexedDB.open('Syncord.plugins.user-activity.history',1);
    req.onupgradeneeded=()=>{const store=req.result.createObjectStore('events',{keyPath:'id',autoIncrement:true});store.createIndex('account-user-id',['accountId','userId','id'],{unique:true});};
    req.onerror=()=>reject(req.error);
    req.onsuccess=()=>{const db=req.result,tx=db.transaction('events','readwrite');
      tx.objectStore('events').add({accountId:foreign,userId:OTHER,userName:'Legacy',kind:'typing',timestamp:1700000000000,text:'legacy event'});
      tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);
    };
  });
  const base={accountId:ACCOUNT,userId:USER,userName:'Alice <img onerror="bad">',kind:'presence',timestamp:1700000000000};
  await activityHistory.appendMany(Array.from({length:6001},(_,i)=>({...base,text:'event '+i})));
  await activityHistory.appendMany([{...base,userId:OTHER,text:'Bob event'},{...base,accountId:foreign,text:'Different account'}]);
  const first=await activityHistory.page(ACCOUNT,USER);
  const old=await activityHistory.page(ACCOUNT,USER,'older',first.entries.at(-1).id);
  const back=await activityHistory.page(ACCOUNT,USER,'newer',old.entries[0].id);
  const legacy=await activityHistory.page(foreign,OTHER);
  const out={legacyCount:legacy.total,legacyText:legacy.entries[0].text,total:first.total,firstLength:first.entries.length,first:first.entries[0].text,last:first.entries.at(-1).text,
    hasOlder:first.hasOlder,hasNewer:first.hasNewer,olderFirst:old.entries[0].text,newerMatches:JSON.stringify(back.entries)===JSON.stringify(first.entries),
    other:(await activityHistory.page(ACCOUNT,OTHER)).total,foreign:(await activityHistory.page(foreign,USER)).total};
  let anchor=first.entries.at(-1).id,page=first,read=first.entries.length,maxLoaded=first.entries.length;
  while(page.hasOlder){page=await activityHistory.page(ACCOUNT,USER,'older',anchor);read+=page.entries.length;maxLoaded=Math.max(maxLoaded,page.entries.length);anchor=page.entries.at(-1).id;}
  out.readAll=read;out.maxLoaded=maxLoaded;out.oldest=page.entries.at(-1).text;
  await activityHistory.close();const reopened=new ActivityHistory();out.reopened=(await reopened.page(ACCOUNT,USER)).total;await reopened.close();
  try{await activityHistory.appendMany([{...base,userId:'invalid',text:'bad'}]);out.invalidRejected=false;}catch{out.invalidRejected=true;}
  const emit=(type,value)=>Syncord.common.flux.FluxDispatcher.dispatch({...value,type});
  const message=(id,user=USER,channel='channel')=>({message:{id,channel_id:channel,author:{id:user},content:'Observed message body'}});
  for(let i=0;i<5;i++)emit('TYPING_START',{userId:USER,channelId:'channel'});
  for(let i=0;i<600;i++){emit('MESSAGE_CREATE',message('m'+i));if(i===0)emit('MESSAGE_CREATE',message('m'+i));}
  emit('MESSAGE_CREATE',message('hidden',USER,'hidden'));emit('MESSAGE_CREATE',message('other-account',foreign));
  emit('PRESENCE_UPDATE',{user:{id:USER},status:'online',activities:[{name:'Game',type:0}]});
  emit('USER_UPDATE',{user:{id:USER,avatar:'b',username:'New name'}});
  emit('VOICE_STATE_UPDATE',{userId:USER,channelId:'channel'});
  emit('TYPING_START',{userId:OTHER,channelId:'channel'});
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async fn=>{const end=Date.now()+5000;while(!await fn()){if(Date.now()>end)throw new Error('History did not update');await wait(10);}};
  await until(async()=> (await activityHistory.page(ACCOUNT,USER)).total===6611);
  const captured=await activityHistory.page(ACCOUNT,USER);
  const kinds=new Set();let typing=0,current=captured;
  for(;;){
    for(const row of current.entries)if(row.id>first.entries[0].id){kinds.add(row.kind);if(row.kind==='typing')typing++;}
    if(!current.hasOlder||current.entries.at(-1).id<=first.entries[0].id)break;
    current=await activityHistory.page(ACCOUNT,USER,'older',current.entries.at(-1).id);
  }
  out.capturedKinds=[...kinds];out.capturedTotal=captured.total;out.typingCount=typing;
  out.messageBodySaved=JSON.stringify(captured).includes('Observed message body');out.silent=window.toasts.length===0;
  out.otherAfter=(await activityHistory.page(ACCOUNT,OTHER)).total;
  // Enable notifications; repeated typing is still logged five times but shown once.
  for(const kind of ['presence','messages','typing','avatar','profile','activities','voice'])saved[kind]=true;
  saved.paused=false;window.dispatchEvent(new Event('Syncord-user-activity-settings'));
  for(let i=0;i<5;i++)emit('TYPING_START',{userId:USER,channelId:'channel'});
  await until(async()=> (await activityHistory.page(ACCOUNT,USER)).total===6616);await wait(300);
  out.toastCount=window.toasts.length;out.toast=window.toasts[0];
  saved.userIds=[OTHER];window.dispatchEvent(new Event('Syncord-user-activity-settings'));
  emit('MESSAGE_CREATE',message('after-removal'));await wait(30);
  out.removalRetainsHistory=(await activityHistory.page(ACCOUNT,USER)).total===6616;
  saved.userIds=[USER,OTHER];window.dispatchEvent(new Event('Syncord-user-activity-settings'));
  const opener=document.getElementById('opener');opener.focus();
  openActivityLog(USER);await until(()=>document.querySelector('#Syncord-user-activity-history article'));
  const dialog=document.getElementById('Syncord-user-activity-history');
  out.modal=dialog.matches(':modal');out.title=dialog.querySelector('h2').textContent;
  out.domRows=dialog.querySelectorAll('article').length;out.escaped=!dialog.querySelector('img[onerror]');
  const closeButton=dialog.querySelector('[data-ua-log-close]'),r=closeButton.getBoundingClientRect();
  out.aboveOverlay=dialog.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));
  dialog.querySelector('[data-ua-log-older]').click();await until(()=>!dialog.querySelector('[data-ua-log-refresh]').disabled);
  out.olderEnabled=!dialog.querySelector('[data-ua-log-newer]').disabled;out.domRowsOlder=dialog.querySelectorAll('article').length;
  dialog.querySelector('[data-ua-log-newer]').click();await until(()=>!dialog.querySelector('[data-ua-log-refresh]').disabled);
  out.backAtNewest=dialog.querySelector('[data-ua-log-newer]').disabled;
  const before=(await activityHistory.page(ACCOUNT,USER)).total;
  emit('MESSAGE_CREATE',message('fresh'));
  await until(()=>dialog.querySelector('[data-ua-log-status]').textContent.includes('New events saved'));
  dialog.querySelector('[data-ua-log-refresh]').click();await until(()=>!dialog.querySelector('[data-ua-log-refresh]').disabled);
  out.refreshed=dialog.querySelector('[data-ua-log-count]').textContent;
  // Failed writes are reported once, not silently treated as saved history.
  const append=activityHistory.appendMany;activityHistory.appendMany=async()=>{throw new Error('simulated disk full');};
  emit('TYPING_START',{userId:OTHER,channelId:'channel'});await wait(30);
  emit('TYPING_START',{userId:OTHER,channelId:'channel'});await wait(30);
  out.failureVisible=dialog.querySelector('[data-ua-log-status]').textContent.includes('could not be saved');
  out.failureToasts=window.toasts.filter(text=>text.includes('could not be saved')).length;
  out.failedNotSaved=(await activityHistory.page(ACCOUNT,OTHER)).total===2;
  activityHistory.appendMany=append;
  dialog.dispatchEvent(new Event('cancel',{cancelable:true}));out.closed=!document.getElementById('Syncord-user-activity-history');
  out.focusRestored=document.activeElement===opener;
  openActivityLog(OTHER);await until(()=>document.querySelector('#Syncord-user-activity-history article'));
  out.otherTitle=document.querySelector('#Syncord-user-activity-history h2').textContent;
  out.otherRows=document.querySelectorAll('#Syncord-user-activity-history article').length;
  emit('MESSAGE_CREATE',message('on-stop'));
  window.disposers.reverse().forEach(fn=>fn());out.stopCloses=!document.getElementById('Syncord-user-activity-history');
  await until(async()=> (await activityHistory.page(ACCOUNT,USER)).total===before+2);
  out.finalTotal=(await activityHistory.page(ACCOUNT,USER)).total;
  out.expectedFinal=before+2;
  return out;
}
function driver(dir,checksSource){
  const {app,BrowserWindow}=require('electron'),path=require('node:path');
  app.setPath('userData',path.join(dir,'profile'));app.disableHardwareAcceleration();
  app.whenReady().then(async()=>{
    const win=new BrowserWindow({width:600,height:500,show:false,webPreferences:{backgroundThrottling:false}});
    try{
      const file=path.join(dir,'index.html');await win.loadFile(file);
      const result=await win.webContents.executeJavaScript('('+checksSource+')()');
      await win.loadFile(file);
      result.afterReload=await win.webContents.executeJavaScript(`window.api.activityHistory.page(historyIds.ACCOUNT,historyIds.USER).then(page=>page.total)`);
      win.setContentSize(340,300);
      result.small=await win.webContents.executeJavaScript(`(async()=>{
        window.api.openActivityLog(historyIds.USER);await new Promise(resolve=>setTimeout(resolve,100));
        const d=document.getElementById('Syncord-user-activity-history'),r=d.getBoundingClientRect();
        return {overflow:d.scrollWidth>d.clientWidth,width:r.width,within:r.bottom<=innerHeight,modal:d.matches(':modal')};
      })()`);
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'ESCAPE'});
      await new Promise(resolve=>setTimeout(resolve,50));
      result.escape=await win.webContents.executeJavaScript(`!document.getElementById('Syncord-user-activity-history')`);
      console.log('ACTIVITY_HISTORY_RESULT:'+JSON.stringify(result));win.destroy();app.exit(0);
    }catch(error){console.error(error.stack);win.destroy();app.exit(1);}
  });
}

async function runHistory(checks){
  const dir=mkdtempSync(path.join(tmpdir(),'syncord-activity-history-'));
  try{
    await build({stdin:{resolveDir:root,loader:'ts',contents:`
      import {activityHistory,ActivityHistory} from './src/renderer/plugins/userActivity/history';
      import {openActivityLog,closeActivityLog} from './src/renderer/plugins/userActivity/logView';
      import {startActivity} from './src/renderer/plugins/userActivity/runtime';
      window.api={activityHistory,ActivityHistory,openActivityLog,closeActivityLog,startActivity};startActivity(window.ctx);
    `},bundle:true,platform:'browser',format:'iife',outfile:path.join(dir,'fixture.js'),logLevel:'warning',plugins:[{name:'history-fixture',setup(b){
      b.onResolve({filter:/\/toast$/},args=>({path:args.path,namespace:'toast-fixture'}));
      b.onLoad({filter:/.*/,namespace:'toast-fixture'},()=>({loader:'js',contents:'export const showToast=text=>window.toasts.push(text);'}));
      b.onResolve({filter:/\/logger$/},args=>({path:args.path,namespace:'logger-fixture'}));
      b.onLoad({filter:/.*/,namespace:'logger-fixture'},()=>({loader:'js',contents:'export const createLogger=()=>({info(){},warn(){},error(){}});'}));
    }}]});
    writeFileSync(path.join(dir,'index.html'),`<!doctype html><html><head><style>
      body{margin:0;background:#222;color:#eee;font:14px sans-serif;}#background{position:fixed;inset:0;z-index:2147483646;background:#333;}#opener{position:relative;z-index:2147483647;}
    </style></head><body><div id="background"></div><button id="opener">Log</button><script>(${setup.toString()})();</script><script src="fixture.js"></script></body></html>`);
    writeFileSync(path.join(dir,'main.cjs'),`(${driver.toString()})(${JSON.stringify(dir)},${JSON.stringify(checks.toString())});`);
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    const run=spawnSync(electron,[path.join(dir,'main.cjs')],{env,encoding:'utf8',timeout:25_000});
    assert.equal(run.status,0,`${run.error??''}\n${run.stdout}\n${run.stderr}`);
    const line=run.stdout.split('\n').find(line=>line.startsWith('ACTIVITY_HISTORY_RESULT:'));assert.ok(line,run.stdout);
    const r=JSON.parse(line.slice('ACTIVITY_HISTORY_RESULT:'.length));
    return r;
  }finally{rmSync(dir,{recursive:true,force:true});}
}
test('activity history: unlimited durable records, account/user isolation, indexed pagination and accessible log UI',{
  skip:!electron&&'Electron is not installed',timeout:30_000,
},async()=>{
  const r=await runHistory(checks);
    assert.equal(r.legacyCount,1);assert.equal(r.legacyText,'legacy event');
    assert.equal(r.total,6001);assert.equal(r.firstLength,50);assert.equal(r.first,'event 6000');assert.equal(r.last,'event 5951');
    assert.equal(r.hasOlder,true);assert.equal(r.hasNewer,false);assert.equal(r.olderFirst,'event 5950');assert.equal(r.newerMatches,true);
    assert.equal(r.other,1);assert.equal(r.foreign,1);assert.equal(r.readAll,6001);assert.equal(r.maxLoaded,50);assert.equal(r.oldest,'event 0');
    assert.equal(r.reopened,6001);assert.equal(r.invalidRejected,true);assert.equal(r.capturedTotal,6611);
    assert.deepEqual(new Set(r.capturedKinds),new Set(['presence','messages','typing','avatar','profile','activities','voice']));
    assert.equal(r.typingCount,5);assert.equal(r.messageBodySaved,true);assert.equal(r.silent,true);assert.equal(r.otherAfter,2);
    assert.equal(r.removalRetainsHistory,true);assert.equal(r.toastCount,1);assert.match(r.toast,/Started typing/);
    assert.equal(r.modal,true);assert.match(r.title,/Alice <img/);assert.equal(r.escaped,true);assert.equal(r.domRows,50);assert.equal(r.aboveOverlay,true);
    assert.equal(r.olderEnabled,true);assert.equal(r.domRowsOlder,50);assert.equal(r.backAtNewest,true);assert.match(r.refreshed,/6[,. ]617/);
    assert.equal(r.failureToasts,1);assert.equal(r.failureVisible,true);assert.equal(r.failedNotSaved,true);assert.equal(r.closed,true);assert.equal(r.focusRestored,true);
    assert.match(r.otherTitle,/Bob/);assert.equal(r.otherRows,2);assert.equal(r.stopCloses,true);assert.equal(r.finalTotal,r.expectedFinal);
    assert.equal(r.afterReload,r.finalTotal);assert.equal(r.small.overflow,false);assert.ok(r.small.width<=340);assert.equal(r.small.within,true);assert.equal(r.small.modal,true);assert.equal(r.escape,true);
});

async function messageChecks(){
  const {USER,OTHER,ACCOUNT}=window.historyIds,{activityHistory,openActivityLog}=window.api;
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async fn=>{const end=Date.now()+5000;while(!await fn()){if(Date.now()>end)throw new Error('Message history did not update');await wait(10);}};
  // Upgrade an existing v2 database, including old rows with no recorded message content.
  await new Promise((resolve,reject)=>{
    const req=indexedDB.open('Syncord.plugins.user-activity.history',2);
    req.onupgradeneeded=()=>{
      const events=req.result.createObjectStore('events',{keyPath:'id',autoIncrement:true});events.createIndex('account-user-id',['accountId','userId','id'],{unique:true});
      req.result.createObjectStore('counts',{keyPath:['accountId','userId']});
    };
    req.onerror=()=>reject(req.error);req.onsuccess=()=>{
      const db=req.result,tx=db.transaction(['events','counts'],'readwrite'),events=tx.objectStore('events');
      const base={accountId:ACCOUNT,userId:USER,userName:'Alice',kind:'messages',timestamp:1700000000000,channelId:'channel',text:'Sent a message'};
      events.add({...base});events.add({...base,messageId:'legacy',messageEvent:'sent',content:'Saved before restart'});
      tx.objectStore('counts').put({accountId:ACCOUNT,userId:USER,count:2});
      tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);
    };
  });
  const emit=(type,value)=>Syncord.common.flux.FluxDispatcher.dispatch({...value,type});
  const send=(id,content,user=USER,channel='channel')=>emit('MESSAGE_CREATE',{message:{id,channel_id:channel,author:{id:user},content}});
  const latest=id=>activityHistory.message(ACCOUNT,'channel',id);
  const body='First line\n**bold**\n<img src=x onerror="window.bad=true"> 😀';
  send('m1',body);send('m1',body);
  emit('MESSAGE_UPDATE',{message:{id:'m1',channel_id:'channel',content:body+'\nEdited'}});
  emit('MESSAGE_DELETE',{id:'m1',channelId:'channel'});emit('MESSAGE_DELETE',{id:'m1',channelId:'channel'});
  await until(async()=> (await latest('m1'))?.messageEvent==='deleted');
  const first=await activityHistory.page(ACCOUNT,USER);
  const m1=first.entries.filter(row=>row.messageId==='m1');
  const out={migrationTotal:first.total,m1Events:m1.map(row=>row.messageEvent),sentContent:m1.at(-1).content,deletedContent:m1[0].content};
  send('m2','Bob text',OTHER);send('m3','Hidden content',USER,'hidden');send('m4','Unselected content','1425993161108357888');send('m5','');
  emit('MESSAGE_DELETE_BULK',{messageIds:['m2','m5','never-observed'],channel_id:'channel'});
  emit('MESSAGE_DELETE',{message_id:'m5',channel_id:'channel'});
  await until(async()=> (await latest('m5'))?.messageEvent==='deleted');
  out.emptyContent=(await latest('m5')).content;
  out.bob=(await activityHistory.page(ACCOUNT,OTHER)).entries.map(row=>[row.messageEvent,row.content]);
  nativeMessages.set('channel:m6',{id:'m6',channel_id:'channel',author:{id:USER},content:'Already in Discord store'});
  emit('MESSAGE_DELETE',{id:'m6',channelId:'channel'});
  emit('MESSAGE_DELETE',{id:'legacy',channelId:'channel'});
  emit('MESSAGE_DELETE',{message:{id:'unknown-body',channel_id:'channel',author:{id:USER}}});
  await until(async()=> (await latest('unknown-body'))?.messageEvent==='deleted');
  out.nativeContent=(await latest('m6')).content;out.restartContent=(await latest('legacy')).content;
  out.unavailable=(await latest('unknown-body')).content===undefined;
  send('m8','Before');
  emit('MESSAGE_UPDATE',{message:{id:'m8',channel_id:'channel',content:'After\nEdit'}});
  emit('MESSAGE_UPDATE',{message:{id:'m8',channel_id:'channel',content:'After\nEdit'}});
  emit('MESSAGE_UPDATE',{message:{id:'m8',channel_id:'channel',embeds:[]}});
  await until(async()=> (await latest('m8'))?.messageEvent==='edited');
  await activityHistory.close();nativeMessages.clear();
  emit('MESSAGE_DELETE',{id:'m8',channelId:'channel'});
  await until(async()=> (await latest('m8'))?.messageEvent==='deleted');
  out.editAfterReopen=(await latest('m8')).content;
  const permissions=Syncord.common.stores.PermissionStore.computePermissions;
  nativeMessages.set('channel:revoked',{id:'revoked',channel_id:'channel',author:{id:USER},content:'Do not log'});
  emit('MESSAGE_DELETE',{id:'revoked',channelId:'channel'});Syncord.common.stores.PermissionStore.computePermissions=()=>0n;
  await wait(30);Syncord.common.stores.PermissionStore.computePermissions=permissions;
  out.revokedNotSaved=!await latest('revoked');
  const current=Syncord.common.stores.UserStore.getCurrentUser;
  nativeMessages.set('channel:switched',{id:'switched',channel_id:'channel',author:{id:USER},content:'Account changed'});
  emit('MESSAGE_DELETE',{id:'switched',channelId:'channel'});Syncord.common.stores.UserStore.getCurrentUser=()=>({id:'1425993161108357888'});
  await wait(30);Syncord.common.stores.UserStore.getCurrentUser=current;out.switchedNotSaved=!await latest('switched');
  const rows=(await activityHistory.page(ACCOUNT,USER)).entries;
  out.hiddenNotSaved=!rows.some(row=>row.messageId==='m3'||row.messageId==='m4'||row.messageId==='never-observed');
  out.edits=rows.filter(row=>row.messageId==='m8').map(row=>row.messageEvent);
  openActivityLog(USER);await until(()=>document.querySelector('[data-ua-message-content]'));
  const dialog=document.getElementById('Syncord-user-activity-history');
  const bodies=[...dialog.querySelectorAll('[data-ua-message-content]')].map(node=>node.textContent);
  out.uiContent=bodies.includes(body)&&bodies.includes(body+'\nEdited');
  out.uiSafe=!dialog.querySelector('img,script')&&!window.bad;
  out.uiMissing=bodies.some(text=>text.includes('Message content unavailable'));
  out.uiEmpty=bodies.some(text=>text.includes('No text content'));
  send('stop-pending','Saved before stop');emit('MESSAGE_DELETE',{id:'stop-pending',channelId:'channel'});
  window.disposers.reverse().forEach(fn=>fn());
  await until(async()=> (await latest('stop-pending'))?.messageEvent==='deleted');
  out.stoppedContent=(await latest('stop-pending')).content;
  out.finalTotal=(await activityHistory.page(ACCOUNT,USER)).total;out.toasts=window.toasts.length;
  return out;
}
test('activity message history: sent/edited/deleted content, pre-store and persisted fallback, bulk/dedup, v2 migration and safe UI',{
  skip:!electron&&'Electron is not installed',timeout:30_000,
},async()=>{
  const r=await runHistory(messageChecks);
  assert.equal(r.migrationTotal,5);assert.deepEqual(r.m1Events,['deleted','edited','sent']);
  assert.equal(r.deletedContent,r.sentContent+'\nEdited');assert.match(r.sentContent,/First line\n\*\*bold\*\*/);
  assert.equal(r.emptyContent,'');assert.deepEqual(r.bob,[['deleted','Bob text'],['sent','Bob text']]);
  assert.equal(r.nativeContent,'Already in Discord store');assert.equal(r.restartContent,'Saved before restart');assert.equal(r.unavailable,true);
  assert.equal(r.editAfterReopen,'After\nEdit');assert.deepEqual(r.edits,['deleted','edited','sent']);
  assert.equal(r.revokedNotSaved,true);assert.equal(r.switchedNotSaved,true);assert.equal(r.hiddenNotSaved,true);
  assert.equal(r.uiContent,true);assert.equal(r.uiSafe,true);assert.equal(r.uiMissing,true);assert.equal(r.uiEmpty,true);
  assert.equal(r.stoppedContent,'Saved before stop');assert.equal(r.toasts,0);assert.equal(r.afterReload,r.finalTotal);
  assert.equal(r.small.overflow,false);assert.equal(r.small.modal,true);assert.equal(r.escape,true);
});
