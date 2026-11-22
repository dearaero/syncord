import {ipcRenderer} from 'electron';
import {DROP_IPC,type DropBridge} from '../shared/drop';
/** Installed only by the existing trusted main-frame preload origin gate. */
export function createDropBridge():DropBridge{return {
 availability:1,
 inbox:(account,available=true)=>ipcRenderer.invoke(DROP_IPC.INBOX,account,available),
 connect:account=>ipcRenderer.invoke(DROP_IPC.CONNECT,account),pick:session=>ipcRenderer.invoke(DROP_IPC.PICK,session),
 invite:(session,receiver)=>ipcRenderer.invoke(DROP_IPC.INVITE,session,receiver),view:(session,id)=>ipcRenderer.invoke(DROP_IPC.VIEW,session,id),
 action:(session,id,action,sdp)=>ipcRenderer.invoke(DROP_IPC.ACTION,session,id,action,sdp),save:(session,id)=>ipcRenderer.invoke(DROP_IPC.SAVE,session,id),
 read:session=>ipcRenderer.invoke(DROP_IPC.READ,session),write:(session,bytes)=>ipcRenderer.invoke(DROP_IPC.WRITE,session,bytes),
 hash:session=>ipcRenderer.invoke(DROP_IPC.HASH,session),finish:(session,digest)=>ipcRenderer.invoke(DROP_IPC.FINISH,session,digest),
 reveal:session=>ipcRenderer.invoke(DROP_IPC.REVEAL,session),stop:session=>ipcRenderer.invoke(DROP_IPC.STOP,session),
 subscribe:listener=>{const receive=(_e:Electron.IpcRendererEvent,token:unknown):void=>{if(typeof token==='string'&&token.length===36)listener(token);};ipcRenderer.on(DROP_IPC.EVENT,receive);return()=>ipcRenderer.removeListener(DROP_IPC.EVENT,receive);},
};}
