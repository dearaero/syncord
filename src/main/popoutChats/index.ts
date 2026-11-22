import {BrowserWindow,session,screen,ipcMain,type WebContents,type IpcMainInvokeEvent} from "electron";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {POPOUT_BASE_URL,POPOUT_ARGUMENT,POPOUT_IPC,POPOUT_MEDIA_HOSTS,isPopoutAsset,chatId,parseChatAction,parseChatState,type ChatState,type ChatBounds,type ChatEvent} from "../../shared/popoutChats";
import {leaseLocalPopup} from "../security/localPopups";
import {bootLog} from "../../shared/bootLog";
import {isLockdown,isSafeMode} from "../security/modes";
import {readSettings} from "../security/settings";
import {consumeLimit} from "../security/rateLimit";
import {openExternal} from "../security/navigation";
const ChatWindow=BrowserWindow;
type Picker={channelId:string;name:string;window?:Electron.BrowserWindow;revoke:()=>void};
type Owner={picker?:Picker;wc:WebContents;session:string;account:string;windows:Map<string,Entry>;dispose:()=>void};
type Entry={slot:number;owner:Owner;channelId:string;window:Electron.BrowserWindow;state?:ChatState};
const owners=new Map<number,Owner>();
const children=new Map<number,Entry>();
let installed=false;
function pickerZoom(wc:WebContents):number {
  // Discord's Electron wrapper can omit the legacy getZoomFactor method.
  // A missing/invalid zoom must never prevent an otherwise ready panel opening.
  try {const zoom=wc.zoomFactor;if(Number.isFinite(zoom)&&zoom>0)return zoom;}catch{}
  try {const zoom=typeof wc.getZoomFactor==='function'?wc.getZoomFactor():1;if(Number.isFinite(zoom)&&zoom>0)return zoom;}catch{}
  return 1;
}
function permitted():void {
  const s=readSettings();const plugins=s.ok?s.data.plugins as Record<string,{enabled?:boolean}>|undefined:undefined;
  if(isLockdown()||isSafeMode()||plugins?.['popout-chats']?.enabled===false)throw Error('Popout Chats is disabled');
}
function ownerFor(wc:WebContents,token:unknown):Owner {
  permitted();const owner=owners.get(wc.id);if(!owner||owner.wc!==wc||owner.session!==token)throw Error('Expired chat session');return owner;
}
function emit(owner:Owner,event:ChatEvent):void {if(!owner.wc.isDestroyed())owner.wc.send(POPOUT_IPC.EVENT,event);}
function closeOwner(owner:Owner):void {
  if(owners.get(owner.wc.id)!==owner)return;
  owners.delete(owner.wc.id);closePicker(owner);owner.dispose();for(const e of [...owner.windows.values()]){emit(owner,{type:'closed',session:owner.session,channelId:e.channelId,bounds:e.window.getNormalBounds()});e.window.destroy();}
}
export function closePopoutChats():void {for(const owner of [...owners.values()])closeOwner(owner);}
function bounds(raw:unknown):Partial<ChatBounds> {
  if(!raw||typeof raw!=='object')return {};const b=raw as ChatBounds;
  if(![b.x,b.y,b.width,b.height].every(Number.isFinite)||Math.abs(b.x)>1000000||Math.abs(b.y)>1000000||b.width>100000||b.height>100000)return {};
  const area=screen.getDisplayMatching({x:Math.round(b.x),y:Math.round(b.y),width:Math.max(1,Math.round(b.width)),height:Math.max(1,Math.round(b.height))}).workArea;
  const width=Math.min(area.width,Math.max(340,Math.round(b.width))),height=Math.min(area.height,Math.max(360,Math.round(b.height)));
  return {width,height,x:Math.round(Math.max(area.x,Math.min(b.x,area.x+area.width-width))),y:Math.round(Math.max(area.y,Math.min(b.y,area.y+area.height-height)))};
}
function closePicker(owner:Owner):void{
  const picker=owner.picker;if(!picker)return;owner.picker=undefined;picker.revoke();if(picker.window&&!picker.window.isDestroyed())picker.window.destroy();
}
function preparePicker(entry:Entry,kind:'Emoji'|'GIF'|'Stickers'):void{
  const owner=entry.owner;closePicker(owner);
  const name='syncord-native-picker-'+randomUUID();
  const picker:Picker={channelId:entry.channelId,name,revoke:()=>{}};owner.picker=picker;
  picker.revoke=leaseLocalPopup(owner.wc,name,options=>{
    permitted();if(owner.picker!==picker||owners.get(owner.wc.id)!==owner||entry.window.isDestroyed())throw Error('Expired picker');
    const chat=entry.window.getContentBounds(),area=screen.getDisplayMatching(chat).workArea;
    const width=Math.min(440,area.width),height=Math.min(500,area.height);
    const win=new ChatWindow({...options,parent:entry.window,show:false,frame:false,resizable:false,skipTaskbar:true,minimizable:false,maximizable:false,width,height,
      x:Math.round(Math.max(area.x,Math.min(chat.x+12,area.x+area.width-width))),y:Math.round(Math.max(area.y,Math.min(chat.y+chat.height-height-64,area.y+area.height-height))),
      alwaysOnTop:entry.window.isAlwaysOnTop(),webPreferences:{...options.webPreferences,preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:false,webSecurity:true,additionalArguments:[],backgroundThrottling:false}});
    picker.window=win;picker.revoke();
    let startupFailed=false;
    const readyTimeout=setTimeout(()=>{if(!win.isDestroyed()&&!win.isVisible()){startupFailed=true;bootLog('native picker startup timeout: content did not become ready');win.destroy();}},4000);readyTimeout.unref();
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.on('will-navigate',event=>event.preventDefault());win.webContents.on('will-redirect',event=>event.preventDefault());win.webContents.on('will-attach-webview',event=>event.preventDefault());
    win.webContents.once('render-process-gone',()=>{if(!win.isDestroyed())win.destroy();});
    let interactive=false;
    win.on('focus',()=>{if(win.isVisible())interactive=true;});
    // window.open can blur the hidden child while styles/layout are loading.
    // Only dismiss a panel that has actually been presented and received focus.
    win.on('blur',()=>{if(interactive&&!win.isDestroyed()&&win.isVisible())win.close();});
    win.once('closed',()=>{clearTimeout(readyTimeout);if(owner.picker===picker){owner.picker=undefined;emit(owner,{type:'picker-closed',reason:startupFailed?'startup-timeout':undefined,session:owner.session,channelId:entry.channelId});}});
    return win.webContents;
  });
  emit(owner,{type:'picker',picker:kind,frameName:name,session:owner.session,channelId:entry.channelId});
}
async function open(owner:Owner,channelId:string,position:unknown):Promise<void> {
  const existing=owner.windows.get(channelId);if(existing){if(existing.window.isMinimized())existing.window.restore();existing.window.show();existing.window.focus();return;}
  if(children.size>=12||owner.windows.size>=8)throw Error('Too many chat windows');
  const occupied=new Set([...children.values()].map(entry=>entry.slot));
  const slot=Array.from({length:12},(_,index)=>index).find(index=>!occupied.has(index));if(slot===undefined)throw Error('Too many chat windows');
  // Electron retains sessions by partition name for the process lifetime. Reuse a bounded pool.
  const target=session.fromPartition('syncord-chat-slot-'+slot);
  target.setPermissionCheckHandler(()=>false);target.setPermissionRequestHandler((_wc,_p,cb)=>cb(false));
  target.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!(d.url===POPOUT_BASE_URL+'/chat'&&d.resourceType==='mainFrame')&&!(d.method==='GET'&&['image','media'].includes(d.resourceType)&&isPopoutAsset(d.url))}));
  // Public media only. This partition never inherits Discord cookies or headers.
  target.webRequest.onBeforeSendHeaders((d,cb)=>{const headers={...d.requestHeaders};for(const k of Object.keys(headers))if(/^(cookie|authorization|referer)$/i.test(k))delete headers[k];cb({requestHeaders:headers});});
  target.protocol.handle('syncord-chat',()=>new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'none';style-src 'unsafe-inline';img-src ${POPOUT_MEDIA_HOSTS.map(host=>'https://'+host).join(' ')};media-src ${POPOUT_MEDIA_HOSTS.map(host=>'https://'+host).join(' ')};connect-src 'none';frame-src 'none';object-src 'none';base-uri 'none';form-action 'none'"></head><body><main id="Syncord-popout-root"></main></body></html>`,{headers:{'Content-Type':'text/html'}}));
  const win=new ChatWindow({width:480,height:640,minWidth:340,minHeight:360,...bounds(position),title:'Popout Chats',show:false,frame:true,autoHideMenuBar:true,backgroundColor:'#1e1f22',
    webPreferences:{session:target,preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:false,webSecurity:true,additionalArguments:[POPOUT_ARGUMENT]}});
  const wcId=win.webContents.id;
  const e:Entry={slot,owner,channelId,window:win};owner.windows.set(channelId,e);children.set(win.webContents.id,e);
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',event=>event.preventDefault());win.webContents.on('will-redirect',event=>event.preventDefault());
  win.webContents.on('will-attach-webview',event=>event.preventDefault());
  win.webContents.once('render-process-gone',()=>{if(!win.isDestroyed())win.destroy();});
  let geometryTimer:ReturnType<typeof setTimeout>|undefined;
  const geometry=():void=>{clearTimeout(geometryTimer);geometryTimer=setTimeout(()=>{if(!win.isDestroyed())emit(owner,{type:'bounds',session:owner.session,channelId,bounds:win.getNormalBounds()});},150);geometryTimer.unref();};
  win.on('move',geometry);win.on('resize',geometry);
  win.on('close',()=>emit(owner,{type:'closed',session:owner.session,channelId,bounds:win.getNormalBounds()}));
  win.once('closed',()=>{if(owner.picker?.channelId===channelId)closePicker(owner);clearTimeout(geometryTimer);children.delete(wcId);if(owner.windows.get(channelId)===e)owner.windows.delete(channelId);target.protocol.unhandle('syncord-chat');void target.clearStorageData();});
  try{await win.loadURL(POPOUT_BASE_URL+'/chat');if(!win.isDestroyed()){win.show();win.focus();}}catch(error){if(!win.isDestroyed())win.destroy();throw error;}
}
function child(event:IpcMainInvokeEvent):Entry {
  const e=children.get(event.sender.id);
  if(!e||e.window.webContents!==event.sender||event.senderFrame!==event.sender.mainFrame||event.senderFrame.url!==POPOUT_BASE_URL+'/chat'||owners.get(e.owner.wc.id)!==e.owner)throw Error('Untrusted chat window');
  permitted();
  if(!consumeLimit('chat:'+event.sender.id,'ipc').allowed)throw Error('Too many chat requests');return e;
}
type Handle=(name:string,fn:(event:IpcMainInvokeEvent,...args:unknown[])=>unknown)=>void;
export function registerPopoutChats(handle:Handle):void {
  if(installed)return;installed=true;
  handle(POPOUT_IPC.CONNECT,(event,account)=>{
    permitted();const id=chatId(account);const old=owners.get(event.sender.id);if(old)closeOwner(old);
    const wc=event.sender;const close=()=>closeOwner(owner);
    const nav=(details:Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,_url:string,isInPlace:boolean,isMainFrame:boolean):void=>{
      // Discord changes channels via history in the existing document. Those
      // routes keep the same owner/bridge; only a document replacement revokes it.
      const mainFrame=details.isMainFrame??isMainFrame;
      const sameDocument=details.isSameDocument??isInPlace;
      if(mainFrame&&!sameDocument)close();
    };
    const timer=setInterval(()=>{try{permitted();}catch{close();}},1000);timer.unref();
    const owner:Owner={wc,session:randomUUID(),account:id,windows:new Map(),dispose:()=>{clearInterval(timer);wc.removeListener('destroyed',close);wc.removeListener('render-process-gone',close);wc.removeListener('did-start-navigation',nav);}};
    owners.set(wc.id,owner);wc.once('destroyed',close);wc.once('render-process-gone',close);wc.on('did-start-navigation',nav);return owner.session;
  });
  handle(POPOUT_IPC.OPEN,(event,token,channelId,position)=>open(ownerFor(event.sender,token),chatId(channelId),position));
  handle(POPOUT_IPC.STOP,(event,token)=>{const owner=owners.get(event.sender.id);if(owner&&owner.session===token)closeOwner(owner);});
  handle(POPOUT_IPC.PUBLISH,(event,token,channelId,raw)=>{
    const owner=ownerFor(event.sender,token),e=owner.windows.get(chatId(channelId));if(!e)return;
    const state=parseChatState(raw);const picker=owner.picker;
    if(state.pickerReady&&picker?.name===state.pickerReady&&picker.channelId===e.channelId&&picker.window&&!picker.window.isDestroyed()){
      const win=picker.window;
      if(state.pickerSize){const old=win.getContentBounds(),area=screen.getDisplayMatching(old).workArea,zoom=pickerZoom(win.webContents);const width=Math.min(area.width,Math.round(state.pickerSize.width*zoom)),height=Math.min(area.height,Math.round(state.pickerSize.height*zoom));if(old.width!==width||old.height!==height)win.setContentBounds({x:Math.max(area.x,Math.min(old.x,area.x+area.width-width)),y:Math.max(area.y,Math.min(old.y,area.y+area.height-height)),width,height});}
      if(!win.isVisible()){win.show();win.focus();}
    }
    e.state=state;e.window.setTitle(state.title);e.window.webContents.send(POPOUT_IPC.STATE,state);
  });
  ipcMain.handle(POPOUT_IPC.INIT,event=>{const e=child(event);emit(e.owner,{type:'action',session:e.owner.session,channelId:e.channelId,action:{kind:'ready'}});return e.state;});
  ipcMain.handle(POPOUT_IPC.ACTION,async(event,raw)=>{
    const e=child(event),a=parseChatAction(raw),win=e.window;
    switch(a.kind){
      case 'pin':win.setAlwaysOnTop(!win.isAlwaysOnTop());return win.isAlwaysOnTop();
      case 'link':return openExternal(a.url);
      case 'picker':preparePicker(e,a.picker);return;
    }
    emit(e.owner,{type:'action',session:e.owner.session,channelId:e.channelId,action:a});
  });
}
