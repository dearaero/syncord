import {settings} from '../settings';
import {disable,enable,list} from './manager';

const PREVIOUS='ui.plugins.previousState';
type Snapshot={version:1;states:Record<string,boolean>};
export type BulkResult={incomplete:string[]};
const listeners=new Set<()=>void>();
let busy=false;
const restartRequired=new Set<string>();
export const pluginsNeedRestart=():boolean=>list().some(p=>!p.enabled&&restartRequired.has(p.id));
export const pluginOperationBusy=():boolean=>busy;
export function onPluginOperationChange(listener:()=>void):()=>void {
 listeners.add(listener);return()=>{listeners.delete(listener);};
}
function notify():void {for(const listener of [...listeners]){try{listener();}catch{/* A closed UI must not strand the operation lock. */}}}
function previous():Snapshot|undefined {
 const raw=settings.get<unknown>(PREVIOUS);
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return;
 const value=raw as Partial<Snapshot>;
 if(value.version!==1||!value.states||typeof value.states!=='object'||Array.isArray(value.states))return;
 const entries=Object.entries(value.states);
 if(entries.length>256||entries.some(([id,on])=>!/^[a-z][a-z0-9-]*$/.test(id)||typeof on!=='boolean'))return;
 return {version:1,states:Object.fromEntries(entries)};
}
export const hasPreviousPluginState=():boolean=>previous()!==undefined;
async function exclusive<T>(work:()=>Promise<T>):Promise<T> {
 if(busy)throw Error('Plugin operation already running');
 busy=true;notify();
 try{return await work();}finally{busy=false;notify();}
}
/** UI toggles share the bulk lock, so a click cannot race a snapshot/restore. */
export function setPluginEnabled(id:string,on:boolean):Promise<void> {
 return exclusive(async()=>{
  if(on)await enable(id);
  else{const p=list().find(p=>p.id===id);if(p?.restartOnDisable&&(p.enabled||p.started))restartRequired.add(id);await disable(id);}
 });
}
/** Snapshots contain preferences, never plugin data, permissions or credentials. */
export function applyBulkPlugins(action:'enable'|'disable'|'restore'):Promise<BulkResult> {
 return exclusive(async()=>{
  const all=list(),saved=action==='restore'?previous():undefined;
  if(action==='restore'&&!saved)throw Error('No previous plugin state');
  const states=saved?.states??{};
  const target=new Map(all.map(p=>[p.id,action==='restore'?states[p.id]===true:action==='enable']));
  // A redundant click must not overwrite the useful pre-bulk snapshot.
  if(action!=='restore'&&all.some(p=>p.enabled!==target.get(p.id))){
   settings.set(PREVIOUS,{version:1,states:Object.fromEntries(all.map(p=>[p.id,p.enabled]))} satisfies Snapshot);
   await settings.flush();
  }
  // Tear down in reverse registration order before starting anything. IDs added
  // after a saved snapshot default to off when restoring that snapshot.
  for(const p of [...all].reverse())if(!target.get(p.id)){
   if(p.restartOnDisable&&(p.enabled||p.started))restartRequired.add(p.id);
   await disable(p.id);
  }
  for(const p of all)if(target.get(p.id))await enable(p.id);
  await settings.flush();
  return {incomplete:list().filter(p=>target.get(p.id)?!p.enabled||!p.started:p.enabled||p.started).map(p=>p.id)};
 });
}
