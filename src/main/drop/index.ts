import {dialog,shell,BrowserWindow,type WebContents,type IpcMainInvokeEvent} from 'electron';
import {randomUUID} from 'node:crypto';
import {DROP_IPC,dropId,dropInvite,dropInbox,dropSdp,type DropAction,type DropInvite} from '../../shared/drop';
import {ecoAccount} from '../../shared/ecosystem';
import {ecosystemProfile,ecosystemDrop} from '../ecosystem';
import {isSafeMode,isLockdown,onModeRestricted} from '../security/modes';
import {isNetworkLockedDown,isPluginRegistered,onNetworkLockdown} from '../security/networkBroker';
import {readSettings} from '../security/settings';
import {DropSource,DropSink,saveName} from './files';
type Owner={wc:WebContents;session:string;account:string;source?:DropSource;sink?:DropSink;invite?:DropInvite;busy:boolean;timer:ReturnType<typeof setTimeout>;dispose:()=>void};
const owners=new Map<number,Owner>();
type Presence={wc:WebContents;account:string;lease:string;tail:Promise<void>;dispose:()=>void};
const presences=new Map<number,Presence>();
function withdraw(p:Presence):Promise<void>{
 if(presences.get(p.wc.id)!==p)return p.tail;
 presences.delete(p.wc.id);p.dispose();
 // Serialize revocation after any in-flight renewal so it cannot resurrect a lease.
 p.tail=p.tail.then(async()=>{await ecosystemDrop(p.account,undefined,'inbox',{lease:p.lease,available:false});}).catch(()=>{});
 return p.tail;
}
function enabled(data:Record<string,unknown>):boolean{
 const plugins=data.plugins as Record<string,{enabled?:boolean}>|undefined;
 return (data['plugins.syncord-drop.enabled']??plugins?.['syncord-drop']?.enabled)===true;
}
/** The only settings-write path calls this after an atomic successful write.
 * Missing/removed enablement also revokes leases; no per-block disk settings IO. */
export function dropSettingsChanged(data:Record<string,unknown>):void{
 if(!enabled(data))closeDrops();
 else if(data['plugins.syncord-drop.data.incoming']===false)for(const p of [...presences.values()])void withdraw(p);
}
function permitted(checkSettings=false,receiving=false):void{
 if(isSafeMode()||isLockdown()||isNetworkLockedDown()||!isPluginRegistered('syncord-drop'))throw Error('drop.disabled');
 if(checkSettings){const data=readSettings();if(!data.ok||!enabled(data.data)||receiving&&data.data['plugins.syncord-drop.data.incoming']===false)throw Error('drop.disabled');}
}
function own(wc:WebContents,token:unknown):Owner {permitted();const o=owners.get(wc.id);if(!o||o.wc!==wc||o.session!==token)throw Error('drop.expired');return o;}
async function close(o:Owner):Promise<void>{
 if(owners.get(o.wc.id)!==o)return;owners.delete(o.wc.id);o.dispose();clearTimeout(o.timer);
 // A crashed/disposed frame must not prevent file-handle and partial cleanup.
 try{if(!o.wc.isDestroyed())o.wc.send(DROP_IPC.EVENT,o.session);}catch{}
 if(o.invite)void ecosystemDrop(o.account,o.invite.id,'cancel',{}).catch(()=>{});
 await Promise.all([o.source?.close(),o.sink?.close()]);
}
export function closeDrops():void{for(const p of [...presences.values()])void withdraw(p);for(const o of [...owners.values()])void close(o);}
const error=(e:unknown):Error=>new Error(e instanceof Error&&/^drop\.[a-z_]+$/.test(e.message)?e.message:'drop.error');
async function operation<T>(o:Owner,fn:()=>Promise<T>):Promise<T>{if(o.busy)throw Error('drop.state');o.busy=true;try{const result=await fn();own(o.wc,o.session);return result;}catch(e){throw error(e);}finally{o.busy=false;}}
async function signal(o:Owner,id:string|undefined,action:'invite'|'view'|DropAction,body?:unknown):Promise<DropInvite>{
 const result=dropInvite(await ecosystemDrop(o.account,id,action,body));
 try{own(o.wc,o.session);}catch(e){if(action==='invite')void ecosystemDrop(o.account,result.id,'cancel',{}).catch(()=>{});throw e;}
 if(result.sender!==o.account&&result.receiver!==o.account)throw Error('drop.denied');
 if(id&&result.id!==id)throw Error('drop.invalid');return result;
}
let subscribed=false;
export function registerDrop(handle:(channel:string,fn:(e:IpcMainInvokeEvent,...args:unknown[])=>unknown)=>void):void{
 if(!subscribed){subscribed=true;onModeRestricted(closeDrops);onNetworkLockdown(closeDrops);}
 handle(DROP_IPC.INBOX,async(e,account,available=true)=>{
  const id=ecoAccount(account);if(typeof available!=='boolean')throw Error('drop.invalid');
  const previous=presences.get(e.sender.id);
  // Revocation can only affect this document's own existing lease. It remains
  // allowed after plugin disable; Safe Mode/Lockdown still deny actual egress.
  if(!available){if(previous?.account===id)await withdraw(previous);return [];}
  permitted(true,true);
  if(previous&&previous.account!==id)void withdraw(previous);
  let p=presences.get(e.sender.id);
  if(!p){
   if(presences.size>=8)throw Error('drop.state');
   const wc=e.sender,stop=():void=>{void withdraw(entry);};
   const entry:Presence={wc,account:id,lease:randomUUID(),tail:Promise.resolve(),dispose:()=>{wc.removeListener('destroyed',stop);wc.removeListener('did-navigate',stop);wc.removeListener('render-process-gone',stop);}};
   wc.once('destroyed',stop);wc.once('did-navigate',stop);wc.once('render-process-gone',stop);presences.set(wc.id,entry);p=entry;
  }
  const entry=p;
  const task=entry.tail.then(async()=>{
   if(presences.get(e.sender.id)!==entry)throw Error('drop.disabled');
   permitted(true,true);
   const invites=dropInbox(await ecosystemDrop(id,undefined,'inbox',{lease:entry.lease,available:true}),id);
   permitted(true,true);if(presences.get(e.sender.id)!==entry)throw Error('drop.disabled');return invites;
  });
  entry.tail=task.then(()=>{},()=>{});
  try{return await task;}catch(e){throw error(e);}
 });
 handle(DROP_IPC.CONNECT,async(e,account)=>{
  permitted(true);const id=ecoAccount(account),previous=owners.get(e.sender.id);if(previous)await close(previous);
  if(owners.size>=8)throw Error('drop.state');
  const session=randomUUID(),wc=e.sender;
  const stop=():void=>{void close(o);};
  const o:Owner={wc,session,account:id,busy:true,timer:setTimeout(stop,4*3600000),dispose:()=>{wc.removeListener('destroyed',stop);wc.removeListener('did-navigate',stop);wc.removeListener('render-process-gone',stop);}};
  o.timer.unref();owners.set(wc.id,o);wc.once('destroyed',stop);wc.once('did-navigate',stop);wc.once('render-process-gone',stop);
  try{const profile=await ecosystemProfile(id);own(wc,session);if(profile.id!==id)throw Error('drop.denied');o.busy=false;return session;}catch{await close(o);throw Error('drop.link_required');}
 });
 handle(DROP_IPC.PICK,async(e,token)=>{
  const o=own(e.sender,token);return operation(o,async()=>{
   if(o.invite||o.sink)throw Error('drop.state');
   const parent=BrowserWindow.fromWebContents(e.sender),options={properties:['openFile'] as Array<'openFile'>};
   const chosen=parent?await dialog.showOpenDialog(parent,options):await dialog.showOpenDialog(options);own(e.sender,token);
   if(chosen.canceled||chosen.filePaths.length!==1)return null;
   await o.source?.close();const source=await DropSource.open(chosen.filePaths[0]);
   try{own(e.sender,token);o.source=source;return source.file;}catch(e){await source.close();throw e;}
  });
 });
 handle(DROP_IPC.INVITE,async(e,token,receiver)=>{
  const o=own(e.sender,token);return operation(o,async()=>{
   if(!o.source||o.invite)throw Error('drop.state');const result=await signal(o,undefined,'invite',{receiver:ecoAccount(receiver),...o.source.file});
   if(result.sender!==o.account||result.receiver!==receiver||result.name!==o.source.file.name||result.size!==o.source.file.size)throw Error('drop.invalid');o.invite=result;return result;
  });
 });
 handle(DROP_IPC.VIEW,async(e,token,id)=>{
  const o=own(e.sender,token);return operation(o,async()=>{
   const key=dropId(id);if(o.invite&&o.invite.id!==key||o.source&&!o.invite)throw Error('drop.state');const result=await signal(o,key,'view');o.invite=result;return result;
  });
 });
 handle(DROP_IPC.ACTION,async(e,token,id,action,sdp)=>{
  const o=own(e.sender,token);return operation(o,async()=>{
   const key=dropId(id);if(o.invite?.id!==key||!['accept','decline','cancel','offer','answer','connected'].includes(String(action)))throw Error('drop.state');
   // Only a receiver who chose a destination can authorize peer setup.
   if(action==='accept'&&!o.sink)throw Error('drop.state');
   const result=await signal(o,key,action as DropAction,action==='offer'||action==='answer'?{sdp:dropSdp(sdp)}:{});o.invite=result;return result;
  });
 });
 handle(DROP_IPC.SAVE,async(e,token,id)=>{
  const o=own(e.sender,token);return operation(o,async()=>{
   const key=dropId(id),invite=await signal(o,key,'view');
   if(o.source||o.invite?.id!==key||invite.receiver!==o.account||!['pending','accepted'].includes(invite.state))throw Error('drop.state');
   if(o.sink)return true;if(invite.state!=='pending')throw Error('drop.state');
   const parent=BrowserWindow.fromWebContents(e.sender),options={defaultPath:saveName(invite.name)};
   const chosen=parent?await dialog.showSaveDialog(parent,options):await dialog.showSaveDialog(options);own(e.sender,token);if(chosen.canceled||!chosen.filePath)return false;
   const sink=await DropSink.open(chosen.filePath,invite);try{own(e.sender,token);o.sink=sink;return true;}catch(e){await sink.close();throw e;}
  });
 });
 handle(DROP_IPC.READ,async(e,token)=>{
  const o=own(e.sender,token);if(!o.source||o.invite?.sender!==o.account||!['accepted','connected'].includes(o.invite.state))throw Error('drop.state');
  try{const bytes=await o.source.read();own(e.sender,token);return bytes;}catch(e){throw error(e);}
 });
 handle(DROP_IPC.WRITE,async(e,token,bytes)=>{
  const o=own(e.sender,token);if(!o.sink||o.invite?.receiver!==o.account||!['accepted','connected'].includes(o.invite.state))throw Error('drop.state');
  try{const n=await o.sink.write(bytes);own(e.sender,token);return n;}catch(e){throw error(e);}
 });
 handle(DROP_IPC.HASH,async(e,token)=>{const o=own(e.sender,token);if(!o.source||o.invite?.sender!==o.account||!['accepted','connected'].includes(o.invite.state))throw Error('drop.state');try{const digest=await o.source.digest();await o.source.close();return digest;}catch(e){throw error(e);}});
 handle(DROP_IPC.FINISH,async(e,token,digest)=>{const o=own(e.sender,token);if(!o.sink||o.invite?.receiver!==o.account||!['accepted','connected'].includes(o.invite.state))throw Error('drop.state');try{await o.sink.finish(digest);own(e.sender,token);}catch(e){throw error(e);}});
 handle(DROP_IPC.REVEAL,async(e,token)=>{const o=own(e.sender,token);if(!o.sink)throw Error('drop.state');shell.showItemInFolder(o.sink.savedPath());});
 handle(DROP_IPC.STOP,async(e,token)=>{const o=owners.get(e.sender.id);if(o?.wc===e.sender&&o.session===token)await close(o);});
}
