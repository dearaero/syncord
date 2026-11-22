import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
const root=process.cwd(),dir=mkdtempSync(path.join(tmpdir(),'syncord-popout-tests-'));
await build({stdin:{resolveDir:root,contents:'export * from "./src/shared/popoutChats";export * from "./src/renderer/plugins/popoutChats/history";export * from "./src/main/security/localPopups";'},bundle:true,platform:'node',format:'esm',outfile:dir+'/contracts.mjs',logLevel:'silent'});
const api=await import(dir+'/contracts.mjs');test.after(()=>rmSync(dir,{recursive:true,force:true}));
test('popout contracts reject forged routing, dangerous links, invalid files and unbounded snapshots',()=>{
 assert.equal(api.isExpiredPopoutSession(new Error('Expired chat session')),true);assert.equal(api.isExpiredPopoutSession(new Error("Error invoking remote method 'Syncord_POPOUT_OPEN': Error: Expired chat session")),true);
 for(const error of [new Error('Window permission denied'),new Error('Too many chat windows'),null,{},new Error("Error invoking remote method 'Syncord_POPOUT_PUBLISH': Error: Expired chat session")])assert.equal(api.isExpiredPopoutSession(error),false);
 assert.equal(api.chatId('1234567890'),'1234567890');for(const value of ['../12345',null,12345,'1'.repeat(23)])assert.throws(()=>api.chatId(value));
 for(const value of [{kind:'emoji-search',query:'x',request:-1},{kind:'emoji-search',query:'x'.repeat(101),request:1},{kind:'close'},{kind:'minimize'},{kind:'maximize'},{kind:'invoke',channel:'SECRET'},{kind:'reply',messageId:'../x'},{kind:'draft',text:'x'.repeat(4001)},{kind:'file',file:{name:'x',type:'x',bytes:new ArrayBuffer(25*1024*1024+1)}},{kind:'file',file:{name:'x',type:'x',bytes:new Uint8Array(2)}},{kind:'link',url:'file:///tmp/private'},{kind:'link',url:'javascript:alert(1)'},{kind:'link',url:'https://user:pass@example.com'}])assert.throws(()=>api.parseChatAction(value));
 assert.deepEqual(api.parseChatAction({kind:'send',text:'hello',channelId:'99999'}),{kind:'send',text:'hello'});
 assert.deepEqual(api.parseChatAction({kind:'picker',picker:'GIF'}),{kind:'picker',picker:'GIF'});assert.deepEqual(api.parseChatAction({kind:'picker',picker:'Emoji'}),{kind:'picker',picker:'Emoji'});
 const state={title:'a',avatar:'',html:'',draft:'',draftVersion:0,reply:'',attachments:'',busy:false,older:true,error:'',locale:'tr',light:false,labels:{send:'Gönder'}};
 assert.equal(api.parseChatState(state).labels.send,'Gönder');for(const patch of [{html:'x'.repeat(2*1024*1024+1)},{draftVersion:-1},{busy:'false'},{historyLoading:'false'},{pickerSize:{width:400,height:500}},{pickerReady:'x',pickerSize:{width:159,height:500}},{pickerReady:'x',pickerSize:{width:400,height:1001}},{labels:{send:'x'.repeat(501)}},{title:'x'.repeat(201)}]){assert.throws(()=>api.parseChatState({...state,...patch}));}
 const sticker={id:'1234567890',name:'Wave',format:1};assert.deepEqual(api.parseChatState({...state,stickers:[sticker]}).stickers,[sticker]);
 for(const stickers of [null,{},[null],[{...sticker,id:'../private'}],[{...sticker,format:5}],[{...sticker,format:'1'}],[{...sticker,name:'x'.repeat(201)}],Array(4).fill(sticker)])assert.throws(()=>api.parseChatState({...state,stickers}));
 assert.equal(api.chatStickerUrl(sticker),'https://media.discordapp.net/stickers/1234567890.png?size=160');assert.equal(api.chatStickerUrl({...sticker,format:4}),'https://media.discordapp.net/stickers/1234567890.gif?size=160');assert.equal(api.chatStickerUrl({...sticker,format:3}),undefined);assert.equal(api.chatStickerUrl({...sticker,id:'../x'}),undefined);
});
test('native popup leases are owner-bound, exact-document, one-use, revocable and short lived',()=>{
 const owner={},other={},name='syncord-native-picker-test';let calls=0;
 const create=()=>{calls++;return {};};let revoke=api.leaseLocalPopup(owner,name,create);
 for(const [sender,url,frameName]of [[other,'about:blank',name],[owner,'https://discord.com',name],[owner,'about:blank','other'],[owner,'about:blank#x',name]])assert.equal(api.consumeLocalPopup(sender,{url,frameName}),undefined);
 const response=api.consumeLocalPopup(owner,{url:'about:blank',frameName:name});assert.equal(response.action,'allow');response.createWindow({});assert.equal(calls,1);assert.equal(api.consumeLocalPopup(owner,{url:'about:blank',frameName:name}),undefined);revoke();
 revoke=api.leaseLocalPopup(owner,name,create);revoke();assert.equal(api.consumeLocalPopup(owner,{url:'about:blank',frameName:name}),undefined);
 revoke=api.leaseLocalPopup(owner,name,create);const now=Date.now;try{Date.now=()=>now()+4000;assert.equal(api.consumeLocalPopup(owner,{url:'about:blank',frameName:name}).action,'deny');}finally{Date.now=now;revoke();}
});
test('native popup dispatcher survives later Discord handlers without admitting ordinary blank windows',()=>{
 let handler,ordinary=0,destroy;const owner={setWindowOpenHandler:fn=>{handler=fn;},once:(_name,fn)=>{destroy=fn;}};
 const setter=owner.setWindowOpenHandler;api.installLocalPopupDispatcher(owner);api.installLocalPopupDispatcher(owner);
 owner.setWindowOpenHandler(()=>{ordinary++;return {action:'deny'};});
 assert.equal(handler({url:'about:blank',frameName:'random'}).action,'deny');
 const revoke=api.leaseLocalPopup(owner,'one-use',()=>({}));
 // Discord installs a replacement after Syncord's initial navigation guard.
 owner.setWindowOpenHandler(()=>{ordinary++;return {action:'deny'};});
 assert.equal(handler({url:'about:blank',frameName:'one-use'}).action,'allow');assert.equal(ordinary,1);
 assert.equal(handler({url:'about:blank',frameName:'one-use'}).action,'deny');assert.equal(ordinary,2);revoke();destroy();assert.equal(owner.setWindowOpenHandler,setter);
});
test('saved histories stay account-bound, reject malformed values and remain within the settings budget',()=>{
 const saved=Object.fromEntries(Array.from({length:40},(_,i)=>[String(1000000000+i),{draft:'x'.repeat(6000),reopen:true,updated:i,bounds:{x:0,y:0,width:480,height:640}}]));
 saved.bad={draft:'bad'};saved['9999999999']=null;
 const history=api.readChatHistory(saved);assert.equal(Object.keys(history).length,16);assert(Object.values(history).every(x=>x.draft.length===4000));assert.equal(Math.max(...Object.values(history).map(x=>x.updated)),39);assert.equal(Math.min(...Object.values(history).map(x=>x.updated)),24);assert.deepEqual(api.readChatHistory(null),{});
 const accounts=api.retainChatAccounts({'1111111111':saved,'2222222222':saved,'3333333333':null,'4444444444':[]},'5555555555',history);assert.equal(Object.keys(accounts).length,3);assert.deepEqual(accounts['5555555555'],history);assert(JSON.stringify(accounts).length<210000);
 for(const url of ['https://cdn.discordapp.com/attachments/1/2/a.png?ex=1&hm=2','https://media.tenor.com/example.gif','https://images-ext-1.discordapp.net/external/fixture/https/static.klipy.com/category.gif?format=webp&animated=true','https://images-ext-2.discordapp.net/external/fixture/https/static.klipy.com/category.gif','https://static.klipy.com/fixture.gif','https://media.giphy.com/fixture.gif'])assert.equal(api.isPopoutAsset(url),true);
 for(const url of ['http://cdn.discordapp.com/a','https://cdn.discordapp.com.evil.invalid/a','https://user:secret@cdn.discordapp.com/a','https://media.tenor.com:8080/a','https://static.klipy.com.evil.invalid/a','https://api.klipy.com/a','https://images-ext-1.discordapp.net.evil.invalid/a','https://images-ext-3.discordapp.net/a','https://user:secret@images-ext-1.discordapp.net/a','https://images-ext-1.discordapp.net:8080/a','file:///tmp/x'])assert.equal(api.isPopoutAsset(url),false);
});
const electron=['Electron.app/Contents/MacOS/Electron','electron.exe','electron'].map(n=>path.join(root,'node_modules/electron/dist',n)).find(existsSync);
test('real Electron popouts isolate IPC, deduplicate, clamp bounds, protect navigation and release windows',{skip:!electron,timeout:45000},async()=>{
 await build({stdin:{resolveDir:root,contents:'export * from "./src/main/popoutChats";export * from "./src/shared/popoutChats";export {consumeLocalPopup,installLocalPopupDispatcher} from "./src/main/security/localPopups";'},bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:dir+'/manager.cjs',logLevel:'silent'});
 await build({stdin:{resolveDir:root,contents:'import {bootstrapPopoutChats} from "./src/preload/popoutChats";bootstrapPopoutChats();'},bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:dir+'/preload.js',logLevel:'silent'});
 writeFileSync(dir+'/app.cjs',String.raw`
 const {app,BrowserWindow,ipcMain}=require('electron'),assert=require('node:assert/strict'),fs=require('node:fs');
 app.on('window-all-closed',()=>{});app.setPath('userData',__dirname+'/profile');app.commandLine.appendSwitch('no-sandbox');
 const manager=require('./manager.cjs'),handlers=new Map();manager.registerPopoutChats((name,fn)=>handlers.set(name,fn));
 const wait=ms=>new Promise(r=>setTimeout(r,ms));const until=async fn=>{for(let i=0;i<150;i++){if(await fn())return;await wait(20);}throw Error('Timed out');};
 app.whenReady().then(async()=>{try{
  const owner=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});await owner.loadURL('about:blank');
  const event={sender:owner.webContents,senderFrame:owner.webContents.mainFrame};const call=(name,...args)=>handlers.get(manager.POPOUT_IPC[name])(event,...args);
  const token=await call('CONNECT','1234567890'),actions=[];const original=owner.webContents.send.bind(owner.webContents);owner.webContents.send=(name,payload)=>{if(name===manager.POPOUT_IPC.EVENT)actions.push(payload);original(name,payload);};
  await call('OPEN',token,'1111111111',{x:-90000,y:-90000,width:1,height:99999});let chat=BrowserWindow.getAllWindows().find(w=>w!==owner);assert(chat);const firstSession=chat.webContents.session;await wait(100);
  assert.equal(chat.webContents.getURL(),manager.POPOUT_BASE_URL+'/chat');assert.equal(await chat.webContents.executeJavaScript('location.origin'),'null');assert.equal(chat.isAlwaysOnTop(),false);if(['darwin','win32'].includes(process.platform))assert(chat.getBounds().height>chat.getContentBounds().height,'OS frame must provide native window chrome');assert.equal(await chat.webContents.executeJavaScript('!!document.querySelector("#older,#close,#minimize,#maximize")'),false);assert(chat.getBounds().width>=340);assert(chat.getBounds().x>=0);
  await call('OPEN',token,'1111111111');assert.equal(BrowserWindow.getAllWindows().length,2);
  await owner.webContents.executeJavaScript('history.pushState({},"","#another-channel")');await wait(25);assert.equal(chat.isDestroyed(),false,'Real same-document routing preserves the chat lease');
  for(const args of [[{isMainFrame:true,isSameDocument:true},'about:blank#route',false,true],[{},'about:blank#legacy',true,true],[{isMainFrame:false,isSameDocument:false},'about:blank',false,true]]){
    owner.webContents.emit('did-start-navigation',...args);await call('OPEN',token,'1111111111');assert.equal(chat.isDestroyed(),false);
  }

  const state={title:'Test DM',avatar:'',html:'<li data-mc-message-id="99999999"><article>Hello <a href="https://example.com">link</a><img src="https://evil.invalid/x" onerror="alert(1)"><button data-mc-reply-message="99999999">Reply</button></article></li>',draft:'kept draft',draftVersion:0,reply:'',attachments:'',busy:false,older:true,error:'',locale:'tr',light:false,labels:{send:'Gönder',close:'Kapat',older:'Eski mesajlar',message:'Mesaj',failed:'Hata'}};
  await call('PUBLISH',token,'1111111111',state);
  await until(()=>chat.webContents.executeJavaScript('document.querySelector("#draft")?.value === "kept draft"'));
  assert.equal(await chat.webContents.executeJavaScript('typeof window.SyncordNative+":"+typeof require'),'undefined:undefined');
  assert.equal(await chat.webContents.executeJavaScript('document.querySelector("#messages-list img").hasAttribute("src")'),false);
  await chat.webContents.executeJavaScript('document.querySelector("#draft").value="my draft";document.querySelector("#draft").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("[data-mc-reply-message]").click();document.querySelector("#pin").click();');
  await until(()=>actions.some(a=>a.action?.kind==='draft'));assert(actions.some(a=>a.action?.text==='my draft'&&a.channelId==='1111111111'));await until(()=>chat.isAlwaysOnTop());
  state.html='<li>Live edit</li>';state.light=true;state.locale='fa';await call('PUBLISH',token,'1111111111',state);await wait(60);
  assert.equal(await chat.webContents.executeJavaScript('document.querySelector("#draft").value'),'my draft');assert.equal(await chat.webContents.executeJavaScript('document.documentElement.dir'),'rtl');
  await call('OPEN',token,'2222222222');assert.equal(BrowserWindow.getAllWindows().length,3);
  assert.throws(()=>handlers.get(manager.POPOUT_IPC.PUBLISH)({sender:chat.webContents,senderFrame:chat.webContents.mainFrame},token,'1111111111',state),/Expired/);
  chat.close();await until(()=>chat.isDestroyed());assert(actions.some(a=>a.type==='closed'&&a.channelId==='1111111111'));
  const token2=await call('CONNECT','3333333333');assert.notEqual(token,token2);assert.equal(BrowserWindow.getAllWindows().length,1);assert.throws(()=>call('OPEN',token,'1111111111'),/Expired/);
  await call('OPEN',token2,'1111111111');assert.equal(BrowserWindow.getAllWindows().find(w=>w!==owner).webContents.session,firstSession);
  owner.webContents.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false},'about:blank?reload',true,true);assert.equal(BrowserWindow.getAllWindows().length,1);assert.throws(()=>call('OPEN',token2,'1111111111'),/Expired/);
  const token3=await call('CONNECT','3333333333');await call('OPEN',token3,'1111111111');owner.webContents.emit('did-start-navigation',{},'about:blank?legacy-reload',false,true);assert.equal(BrowserWindow.getAllWindows().length,1);assert.throws(()=>call('OPEN',token3,'1111111111'),/Expired/);
  owner.destroy();await until(()=>BrowserWindow.getAllWindows().length===0);
  fs.writeFileSync(__dirname+'/result.txt','POPOUT_OK');app.exit(0);
 }catch(error){console.error(error.stack);app.exit(1);}});
 `);
 const run=spawnSync(electron,[dir+'/app.cjs'],{encoding:'utf8',timeout:40000,env:{...process.env,ELECTRON_RUN_AS_NODE:''}});assert.equal(run.status,0,run.stdout+'\n'+run.stderr);assert.equal(readFileSync(dir+'/result.txt','utf8'),'POPOUT_OK');
});

test('owner renderer uses live stores/actions, isolates drafts and replies, revokes access, restores and cleans up',{skip:!electron,timeout:45000},async()=>{
 const work=dir+'/integration';writeFileSync(dir+'/integration-marker','');
 const {mkdirSync}=await import('node:fs');mkdirSync(work);
 await build({stdin:{resolveDir:root,contents:'export * from "./src/main/popoutChats";export * from "./src/shared/popoutChats";export {consumeLocalPopup,installLocalPopupDispatcher} from "./src/main/security/localPopups";'},bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:work+'/manager.cjs',logLevel:'silent'});
 await build({stdin:{resolveDir:root,contents:'import {bootstrapPopoutChats} from "./src/preload/popoutChats";bootstrapPopoutChats();'},bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:work+'/preload.js',logLevel:'silent'});
 await build({stdin:{resolveDir:root,contents:`import {contextBridge,ipcRenderer} from 'electron';import {POPOUT_IPC as I} from './src/shared/popoutChats';contextBridge.exposeInMainWorld('fixtureBridge',{connect:a=>ipcRenderer.invoke(I.CONNECT,a),open:(s,c,b)=>ipcRenderer.invoke(I.OPEN,s,c,b),stop:s=>ipcRenderer.invoke(I.STOP,s),publish:(s,c,v)=>ipcRenderer.invoke(I.PUBLISH,s,c,v),subscribe:f=>{const cb=(_e,v)=>f(v);ipcRenderer.on(I.EVENT,cb);return()=>ipcRenderer.removeListener(I.EVENT,cb);}});`},bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:work+'/owner-preload.js',logLevel:'silent'});
 await build({stdin:{resolveDir:root,contents:`
 import {installNativePickerFixture} from './scripts/tests/fixtures/native-expression-picker.js';import {startPopoutChats} from './src/renderer/plugins/popoutChats';import {openChatPopout} from './src/renderer/plugins/popoutChats/service';import {setLocale,t,SUPPORTED_LOCALES} from './src/renderer/i18n';import {get} from './src/renderer/api/plugin/manager';
 let fixtureId=0;if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{value:()=>String(++fixtureId)});
 const a='1111111111',b='2222222222';const rows={ [a]:[{id:'1000000001',channel_id:a,content:'Initial DM',timestamp:new Date(),author:{id:'4444444444',username:'Ada'}}], [b]:[{id:'1000000002',channel_id:b,content:'Initial Group',timestamp:new Date(),author:{id:'4444444444',username:'Ada'}}]};
 let account='1234567890',allowed=true,more=true;const emojiQueries=[];const emojiStore={searchWithoutFetchingLatest:options=>{emojiQueries.push({channel:options.channel.id,query:options.query});return {unlocked:[{name:'smile',surrogates:'😄'},{id:'1234567899',name:'party',animated:true},{id:'9999999999',name:'blocked'}].filter(e=>e.name.includes(options.query)),locked:[{id:'8888888888',name:'locked'}]};},getCustomEmojiById:id=>id==='1234567899'?{id,name:'party',animated:true}:undefined};const listeners=new Set();const saved=new Map(),sent=[],disposers=[],historyRequests=[];
 class Upload {constructor(item,channelId){this.file=item.file;this.channelId=channelId;}trackUploadFinished(){}upload(){}on(){}cancel(){}}
 const messageActions={fetchMessages:async options=>{if(options.before){historyRequests.push(options);await new Promise(resolve=>setTimeout(resolve,100));rows[options.channelId].unshift({id:'1000000000',channel_id:options.channelId,content:'Older history',timestamp:new Date(Date.now()-86400000),author:{id:'4444444444',username:'Ada'}});}},sendMessage:async(id,body,_ready,options)=>{sent.push({id,body,options:{stickerIds:options.stickerIds,messageReference:options.messageReference,attachmentsToUpload:options.attachmentsToUpload?.map(x=>({name:x.file.name,size:x.file.size,channelId:x.channelId}))}});return {ok:true,body:{id:'5555555555'}};}};
 window.nativeMediaAssets=true;window.nativeStickerIds=['2222222222','4444444444'];window.nativePanelWidth=400;window.nativeSplitHeader=true;window.nativeDialogOffset=true;window.nativeNestedOffset=true;const nativePicker=installNativePickerFixture(emojiStore);window.Syncord={common:{react:{React:nativePicker.React,ReactDOM:nativePicker.ReactDOM},stores:{EmojiStore:emojiStore,ChannelStore:{getChannel:id=>allowed?{id,type:id===a?1:3}:undefined},UserStore:{getCurrentUser:()=>({id:account}),getUser:id=>({id,username:'Ada'})},MessageStore:{getMessages:id=>({_array:rows[id]??[],ready:true,hasMoreBefore:more}),getMessage:(id,msg)=>rows[id]?.find(m=>m.id===msg),addChangeListener:f=>listeners.add(f),removeChangeListener:f=>listeners.delete(f)},SelectedChannelStore:{getChannelId:()=>a}},actions:{MessageActions:messageActions},flux:{}},webpack:{findByProps:(...names)=>names.includes('EmojiIntention')?{EmojiIntention:{CHAT:3}}:names.includes('getEmojiUnavailableReason')?{getEmojiUnavailableReason:()=>null}:names.includes('fetchMessages')?messageActions:undefined,find:predicate=>[Upload,nativePicker.component,nativePicker.layers,nativePicker.store].find(predicate)},toast:{show:()=>{}}};
 let fault='',holdPickerReady=false,connectCount=0,openCount=0;const bridge={...window.fixtureBridge,publish:(s,c,value)=>window.fixtureBridge.publish(s,c,holdPickerReady?{...value,pickerReady:undefined,pickerSize:undefined}:value),connect:id=>{connectCount++;return window.fixtureBridge.connect(id);},open:(s,c,b)=>{openCount++;if(fault)throw Error(fault==='expired'?'Expired chat session':'Window permission denied');return window.fixtureBridge.open(s,c,b);}};
 const ctx={log:{warn:()=>{},info:()=>{}},popoutChats:bridge,settings:{get:(k,f)=>k.split('.').reduce((v,p)=>v?.[p],Object.fromEntries(saved))??f,set:(k,v)=>saved.set(k,structuredClone(v))},disposable:f=>disposers.push(f)};
 startPopoutChats(ctx);window.testFixture={holdReady:value=>{holdPickerReady=value;},open:openChatPopout,setLocale,names:()=>{const result=SUPPORTED_LOCALES.map(locale=>{setLocale(locale);return {locale,name:get('popout-chats')?.name,expected:t('popout.name')};});setLocale('en-US');return result;},liveSticker:()=>{rows[a].push({id:'1000009000',channel_id:a,content:'',timestamp:new Date(),sticker_items:[{id:'2222222222',name:'Wave',format_type:1}],author:{id:account,username:'Me'}});for(const f of listeners)f();},live:()=>{rows[a].push({id:'1000000003',channel_id:a,content:'Realtime arrival',timestamp:new Date(),author:{id:'4444444444',username:'Ada'}});for(const f of listeners)f();},revoke:()=>{allowed=false;for(const f of listeners)f();},account:()=>{account='9999999999';},stop:()=>{for(const f of disposers.reverse())f();},seedHistory:()=>{rows[a]=Array.from({length:400},(_,i)=>({id:String(1000001000+i),channel_id:a,content:'History row '+i,timestamp:new Date(Date.now()-400000+i*1000),author:{id:'4444444444',username:'Ada'}}));for(const f of listeners)f();},endHistory:()=>{more=false;for(const f of listeners)f();},fault:value=>{fault=value;},snapshot:()=>({sent,saved:Object.fromEntries(saved),listeners:listeners.size,connectCount,openCount,historyRequests,emojiQueries})};
 `},bundle:true,platform:'browser',format:'iife',outfile:work+'/owner.js',logLevel:'silent'});
 writeFileSync(work+'/app.cjs',String.raw`
 const {app,BrowserWindow,ipcMain}=require('electron'),assert=require('node:assert/strict'),fs=require('node:fs');app.on('window-all-closed',()=>{});app.setPath('userData',__dirname+'/profile');app.commandLine.appendSwitch('no-sandbox');
 const manager=require('./manager.cjs');let zoomChecks=0;manager.registerPopoutChats((name,fn)=>ipcMain.handle(name,(...args)=>{
 if(name!==manager.POPOUT_IPC.PUBLISH||!args[3]?.pickerReady)return fn(...args);
 const popup=BrowserWindow.getAllWindows().find(w=>w.getParentWindow());if(!popup)return fn(...args);
 const wc=popup.webContents,method=Object.getOwnPropertyDescriptor(wc,'getZoomFactor');
 // Simulate Discord's API surface only at the main handler boundary, preserving
 // Electron's own window initialization and cleanup implementation.
 Object.defineProperty(wc,'getZoomFactor',{value:undefined,configurable:true});
 zoomChecks++;
 try{return fn(...args);}finally{if(method)Object.defineProperty(wc,'getZoomFactor',method);else delete wc.getZoomFactor;}
 }));const wait=ms=>new Promise(r=>setTimeout(r,ms));const until=async fn=>{for(let i=0;i<300;i++){if(await fn())return;await wait(20);}throw Error('Timed out');};
 app.whenReady().then(async()=>{try{
 const owner=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,preload:__dirname+'/owner-preload.js'}});
 const mediaRequests=[];const imageBytes=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
 await owner.webContents.session.protocol.handle('https',request=>{mediaRequests.push(request.url);return new Response(new URL(request.url).hostname==='discord.com'?'<html><body></body></html>':imageBytes,{headers:{'Content-Type':new URL(request.url).hostname==='discord.com'?'text/html':'image/gif'}});});
 await owner.loadURL('https://discord.com/channels/@me');manager.installLocalPopupDispatcher(owner.webContents);owner.webContents.setWindowOpenHandler(()=>({action:'deny'}));await owner.webContents.executeJavaScript(fs.readFileSync(__dirname+'/owner.js','utf8'));
 const run=code=>owner.webContents.executeJavaScript(code),chats=()=>BrowserWindow.getAllWindows().filter(w=>w!==owner&&w.webContents.getURL()===manager.POPOUT_BASE_URL+'/chat');
 await run('testFixture.open("1111111111")');await until(()=>chats().length===1);const first=chats()[0];await until(()=>first.webContents.executeJavaScript('document.body.textContent.includes("Initial DM")'));
 await first.webContents.executeJavaScript('document.querySelector("#draft").value="independent A";document.querySelector("#draft").dispatchEvent(new Event("input"))');
 await run('testFixture.open("2222222222")');await until(()=>chats().length===2);const second=chats().find(w=>w!==first);await until(()=>second.webContents.executeJavaScript('document.body.textContent.includes("Initial Group")'));assert.equal(await second.webContents.executeJavaScript('document.querySelector("#draft").value'),'');
 app.on('browser-window-created',(_event,win)=>{if(win.getParentWindow()===first)setTimeout(()=>{if(!win.isDestroyed()&&!win.isVisible())win.emit('blur');},0);});
 const chatDemotions=[];for(const method of ['hide','minimize','moveBottom']){if(typeof first[method]!=='function')continue;const original=first[method].bind(first);first[method]=(...args)=>{chatDemotions.push(method);return original(...args);};}
 // The real native adapter mounts in a child document; Discord's main window stays hidden.
 const parentCalls=[];for(const method of ['show','focus']){const original=owner[method].bind(owner);owner[method]=(...args)=>{parentCalls.push(method);return original(...args);};}
 assert.equal(await run('window.open("about:blank","unleased")==null'),true);
 await first.webContents.executeJavaScript('document.querySelector("#emoji").click()');
 const native=()=>BrowserWindow.getAllWindows().find(w=>w.getParentWindow()===first);
 await until(()=>native()?.isVisible());let pickerWindow=native();
 await until(()=>pickerWindow.getContentBounds().width===400);
 await until(()=>pickerWindow.webContents.executeJavaScript('(()=>{const panel=document.querySelector("[data-native-drawer]").getBoundingClientRect(),header=document.querySelector("[data-native-header]").getBoundingClientRect();return Math.abs(panel.left)<1&&Math.abs(header.top)<1&&Math.abs(panel.right-innerWidth)<1&&Math.abs(panel.bottom-innerHeight)<1;})()'));
 // A narrow display and subsequent expansion must retain both edges and hit targets.
 for(const width of [320,400]){
   pickerWindow.setContentSize(width,420);
   await until(()=>pickerWindow.webContents.executeJavaScript('(()=>{const panel=document.querySelector("[data-native-drawer]").getBoundingClientRect(),header=document.querySelector("[data-native-header]").getBoundingClientRect();return Math.abs(panel.left)<1&&Math.abs(panel.right-innerWidth)<1&&Math.abs(panel.bottom-innerHeight)<1&&Math.abs(header.top)<1;})()'));
   assert.equal(await pickerWindow.webContents.executeJavaScript('(()=>{const panel=document.querySelector("[data-native-drawer]"),r=panel.getBoundingClientRect();return panel.contains(document.elementFromPoint(r.left+2,r.top+30))&&panel.contains(document.elementFromPoint(r.right-2,r.top+30));})()'),true,'Both native edges must remain clickable without a clipped rail or empty gutter');
 }
 assert.equal(owner.isVisible(),false);assert.deepEqual(parentCalls,[]);assert.equal(pickerWindow.getParentWindow(),first);
 assert(zoomChecks>0);assert.equal(first.isVisible(),true);assert.equal(first.isMinimized(),false);assert.deepEqual(chatDemotions,[]);
 assert.equal(await pickerWindow.webContents.executeJavaScript('typeof SyncordNative+":"+typeof require'),'undefined:undefined');
 assert.equal(await pickerWindow.webContents.executeJavaScript('!!document.querySelector("[data-native-expression-picker]")'),true);
 assert.equal(await run('!!document.querySelector("[data-native-expression-picker]")'),false);
 assert.equal(await run('nativePickerProps.channel.id'),'1111111111');assert.equal(await run('nativePickerStore.getState().activeView'),'emoji');
 let beforePick=await run('testFixture.snapshot().openCount');await pickerWindow.webContents.executeJavaScript('document.querySelector("[data-native-expression-picker] button[aria-label=smile]").click()');
 await until(()=>first.webContents.executeJavaScript('document.querySelector("#draft").value==="independent A😄"'));await until(async()=>(await run('testFixture.snapshot().openCount'))===beforePick+1);await until(()=>!native());
 assert.equal(await second.webContents.executeJavaScript('document.querySelector("#draft").value'),'');assert.deepEqual(parentCalls,[]);
 await first.webContents.executeJavaScript('document.querySelector("#draft").value="independent A";document.querySelector("#draft").dispatchEvent(new Event("input"));document.querySelector("#emoji").click()');
 await until(()=>native()?.isVisible());assert(zoomChecks>1);pickerWindow=native();beforePick=await run('testFixture.snapshot().openCount');
 pickerWindow.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
 await until(async()=>(await run('testFixture.snapshot().openCount'))===beforePick+1);await until(()=>!native());assert.equal(await run('nativePickerListeners()'),0);assert.deepEqual(parentCalls,[]);
 // Native GIF stores use protocol-relative image/video sources in a blank child.
 await first.webContents.executeJavaScript('document.querySelector("#gif").click()');await until(()=>native()?.isVisible());pickerWindow=native();
 assert.equal(await pickerWindow.webContents.executeJavaScript('document.baseURI'),'https://discord.com/');
 await until(()=>pickerWindow.webContents.executeJavaScript('document.querySelector("[data-native-gif]")?.naturalWidth===1'));
 await until(()=>pickerWindow.webContents.executeJavaScript('(()=>{const categories=[...document.querySelectorAll("[data-native-gif-category]")];return categories.length===2&&categories.every(image=>image.complete&&image.naturalWidth===1);})()'));
 for(const index of [1,2])assert(mediaRequests.includes('https://images-ext-'+index+'.discordapp.net/external/fixture/https/static.klipy.com/category.gif?format=webp&animated=true'),'Proxied category images must resolve via HTTPS and load under native CSP');
 await until(()=>mediaRequests.includes('https://c.tenor.com/fixture.webm'));assert(mediaRequests.includes('https://static.klipy.com/fixture.gif'));
 await pickerWindow.webContents.executeJavaScript('document.querySelector("button[aria-label="+JSON.stringify("Trending GIF")+"]").click()');await until(()=>!native());
 await until(()=>first.webContents.executeJavaScript('document.querySelector("#draft").value.includes("https://example.com/fast")'));
 await first.webContents.executeJavaScript('document.querySelector("#draft").value="independent A";document.querySelector("#draft").dispatchEvent(new Event("input"))');
 // A genuinely unready child reports a localized error instead of silently vanishing.
 console.log('TIMEOUT_CHECK_START');await run('testFixture.holdReady(true)');await first.webContents.executeJavaScript('document.querySelector("#emoji").click()');await until(()=>!!native());await until(()=>!native());
 await until(()=>first.webContents.executeJavaScript('document.querySelector("#error").textContent.length>0'));
 console.log('TIMEOUT_RECOVERY_START');await run('testFixture.holdReady(false)');await first.webContents.executeJavaScript('document.querySelector("#emoji").click()');await until(()=>native()?.isVisible());assert.equal(await first.webContents.executeJavaScript('document.querySelector("#error").textContent'),'');
 native().webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});await until(()=>!native());
 await run('testFixture.live()');await until(()=>first.webContents.executeJavaScript('document.body.textContent.includes("Realtime arrival")'));
 assert.equal(await run('testFixture.snapshot().historyRequests.length'),0,'Initial render must not drain old history');
 await first.webContents.executeJavaScript('for(let i=0;i<8;i++)document.querySelector("#chat-messages").dispatchEvent(new WheelEvent("wheel",{deltaY:-100,bubbles:true}))');
 await until(()=>first.webContents.executeJavaScript('document.querySelector("#chat-messages").getAttribute("aria-busy")==="true"'));assert.equal(await first.webContents.executeJavaScript('document.querySelector("#draft").disabled'),false,'History loading must not disable the composer');
 await until(()=>first.webContents.executeJavaScript('document.body.textContent.includes("Older history")'));assert.equal(await run('testFixture.snapshot().historyRequests.length'),1,'One request despite a wheel burst');await wait(100);assert.equal(await run('testFixture.snapshot().historyRequests.length'),1,'No automatic follow-up after restoring scroll');
 await run('testFixture.seedHistory()');await until(()=>first.webContents.executeJavaScript('document.querySelector("#messages-list > [data-mc-message-id]")?.dataset.mcMessageId==="1000001150"'));
 const anchor=await first.webContents.executeJavaScript('(()=>{const s=document.querySelector("#chat-messages");s.scrollTop=80;const row=[...document.querySelectorAll("#messages-list > [data-mc-message-id]")].find(el=>el.getBoundingClientRect().bottom>s.getBoundingClientRect().top);const value={id:row.dataset.mcMessageId,top:row.getBoundingClientRect().top};s.dispatchEvent(new Event("scroll"));return value;})()');
 await until(()=>first.webContents.executeJavaScript('document.querySelector("#messages-list > [data-mc-message-id]")?.dataset.mcMessageId==="1000001100"'));
 const preserved=await first.webContents.executeJavaScript('document.querySelector('+JSON.stringify('[data-mc-message-id="'+anchor.id+'"]')+').getBoundingClientRect().top');assert(Math.abs(preserved-anchor.top)<2,'Prepending history must preserve the visible message anchor');assert.equal(await run('testFixture.snapshot().historyRequests.length'),1,'Cached history must not fetch from Discord again');
 await run('testFixture.endHistory()');for(const expected of ['1000001050','1000001000']){await first.webContents.executeJavaScript('(()=>{const s=document.querySelector("#chat-messages");s.scrollTop=0;s.dispatchEvent(new Event("scroll"));s.dispatchEvent(new WheelEvent("wheel",{deltaY:-100,bubbles:true}));})()');await until(()=>first.webContents.executeJavaScript('document.querySelector("#messages-list > [data-mc-message-id]")?.dataset.mcMessageId==="'+expected+'"'));}
 await first.webContents.executeJavaScript('for(let i=0;i<8;i++)document.querySelector("#chat-messages").dispatchEvent(new WheelEvent("wheel",{deltaY:-100,bubbles:true}))');await wait(80);assert.equal(await run('testFixture.snapshot().historyRequests.length'),1);assert.equal(await first.webContents.executeJavaScript('document.querySelector("#latest").disabled'),false,'The true beginning must not leave paging stuck');
 await first.webContents.executeJavaScript('document.querySelector("#latest").click()');await until(()=>first.webContents.executeJavaScript('(()=>{const s=document.querySelector("#chat-messages");return s.scrollHeight-s.clientHeight-s.scrollTop<5;})()'));

 await first.webContents.session.protocol.handle('https',request=>new Response(imageBytes,{headers:{'Content-Type':'image/gif'}}));
 await first.webContents.executeJavaScript('document.querySelector("#sticker").click()');await until(()=>native()?.isVisible());
 await native().webContents.executeJavaScript('document.querySelector("button[aria-label=Wave]").click()');await until(()=>!native());
 await until(()=>first.webContents.executeJavaScript('document.querySelector("#sticker-previews img")?.naturalWidth===1'));
 assert.equal(await first.webContents.executeJavaScript('document.querySelector("#sticker-previews img").src'),'https://media.discordapp.net/stickers/2222222222.png?size=160');
 assert.equal(await second.webContents.executeJavaScript('document.querySelector("#sticker-previews").childElementCount'),0);
 await first.webContents.executeJavaScript('document.querySelector("[data-mc-reply-message]").click()');await until(()=>first.webContents.executeJavaScript('!document.querySelector("#reply-strip").hidden'));
 await first.webContents.executeJavaScript('document.querySelector("#send").click()');await until(async()=>(await run('testFixture.snapshot().sent.length'))===1);await until(()=>first.webContents.executeJavaScript('document.querySelector("#draft").value===""'));
 const sent=await run('testFixture.snapshot().sent');assert.equal(sent[0].id,'1111111111');assert.deepEqual(sent[0].options.stickerIds,['2222222222']);assert.equal(await first.webContents.executeJavaScript('document.querySelector("#sticker-previews").childElementCount'),0);assert.equal(sent[0].body.content,'independent A');assert.equal(sent[0].options.messageReference.channel_id,'1111111111');await run('testFixture.liveSticker()');await until(()=>first.webContents.executeJavaScript('document.querySelector("[data-mc-sticker-preview] img")?.naturalWidth===1'));
 await second.webContents.executeJavaScript('const transfer=new DataTransfer();transfer.items.add(new File(["payload"],"proof.txt",{type:"text/plain"}));const file=document.querySelector("#file");file.files=transfer.files;file.dispatchEvent(new Event("change"))');await until(()=>second.webContents.executeJavaScript('document.querySelector("#attachment-text").textContent.includes("proof.txt")')).catch(async error=>{throw Error(error.message+': '+await second.webContents.executeJavaScript('document.querySelector("#error").textContent'));});await second.webContents.executeJavaScript('document.querySelector("#send").click()');await until(async()=>(await run('testFixture.snapshot().sent.length'))===2);await until(()=>second.webContents.executeJavaScript('document.querySelector("#attachment-strip").hidden'));const upload=(await run('testFixture.snapshot().sent'))[1];assert.equal(upload.id,'2222222222');assert.deepEqual(upload.options.attachmentsToUpload,[{name:'proof.txt',size:7,channelId:'2222222222'}]);
 await second.webContents.executeJavaScript('document.querySelector("#draft").value="saved B";document.querySelector("#draft").dispatchEvent(new Event("input"))');await wait(80);second.close();await until(async()=>Boolean((await run('testFixture.snapshot().saved'))['accounts']?.['1234567890']?.['2222222222']?.bounds));
 await run('testFixture.open("2222222222")');await until(()=>chats().length===2);let reopened=chats().find(w=>w!==first);await until(()=>reopened.webContents.executeJavaScript('document.querySelector("#draft").value==="saved B"'));
 const names=await run('testFixture.names()');assert.equal(names.length,18);for(const item of names){assert.equal(item.name,item.expected);assert(item.name.length>0);if(item.locale!=='en-US')assert.notEqual(item.name,'Popout Chats');}
 await run('testFixture.setLocale("tr")');await until(()=>reopened.webContents.executeJavaScript('document.documentElement.lang==="tr"'));assert.equal(await reopened.webContents.executeJavaScript('document.querySelector("#draft").value'),'saved B');
 console.log('MAIN_REVOCATION_CHECK');
 // Main revocation must recover only OPEN, keep the same-account text draft, and never replay a send.
 manager.closePopoutChats();await until(()=>chats().length===0);await wait(40);const beforeRecovery=await run('testFixture.snapshot()');await run('testFixture.open("2222222222")');await until(()=>chats().length===1);reopened=chats()[0];await until(()=>reopened.webContents.executeJavaScript('document.querySelector("#draft").value==="saved B"'));assert.equal((await run('testFixture.snapshot()')).connectCount,beforeRecovery.connectCount+1);assert.equal(await run('testFixture.snapshot().sent.length'),2);
 manager.closePopoutChats();await until(()=>chats().length===0);await wait(40);await run('testFixture.fault("expired")');const attempts=await run('testFixture.snapshot()');await run('testFixture.open("2222222222")');await until(async()=>(await run('testFixture.snapshot().openCount'))>=attempts.openCount+2);await wait(40);const stopped=await run('testFixture.snapshot()');assert.equal(stopped.openCount,attempts.openCount+2);assert.equal(stopped.connectCount,attempts.connectCount+1);assert.equal(chats().length,0);
 await run('testFixture.fault("denied")');const denied=await run('testFixture.snapshot()');await run('testFixture.open("2222222222")');await until(async()=>(await run('testFixture.snapshot().openCount'))>denied.openCount);await wait(40);assert.equal((await run('testFixture.snapshot()')).connectCount,denied.connectCount);assert.equal((await run('testFixture.snapshot()')).openCount,denied.openCount+1);
 await run('testFixture.fault("");testFixture.open("2222222222")');await until(()=>chats().length===1);reopened=chats()[0];await until(()=>reopened.webContents.executeJavaScript('document.querySelector("#draft").value==="saved B"'));
 await reopened.webContents.executeJavaScript('document.querySelector("#emoji").click()');await until(()=>BrowserWindow.getAllWindows().some(w=>w.getParentWindow()===reopened&&w.isVisible()));
 await run('testFixture.revoke()');await until(()=>!BrowserWindow.getAllWindows().some(w=>w.getParentWindow()===reopened));await until(()=>reopened.webContents.executeJavaScript('document.querySelector("#messages-list").textContent===""'));await reopened.webContents.executeJavaScript('document.querySelector("#send").click()');await wait(100);assert.equal(await run('testFixture.snapshot().sent.length'),2);
 await run('testFixture.account()');await until(()=>chats().length===0);await run('testFixture.stop()');assert.equal(await run('testFixture.snapshot().listeners'),0);assert.equal(await run('!!document.getElementById("syncord-popout-launcher")'),false);
 fs.writeFileSync(__dirname+'/result.txt','HOST_OK');owner.destroy();app.exit(0);
 }catch(error){console.error(error.stack);app.exit(1);}});
 `);
 const run=spawnSync(electron,[work+'/app.cjs'],{encoding:'utf8',timeout:40000,env:{...process.env,ELECTRON_RUN_AS_NODE:''}});assert.equal(run.error,undefined,run.stdout+'\n'+run.stderr+String(run.error));assert.equal(run.status,0,run.stdout+'\n'+run.stderr);assert.equal(readFileSync(work+'/result.txt','utf8'),'HOST_OK');
});
