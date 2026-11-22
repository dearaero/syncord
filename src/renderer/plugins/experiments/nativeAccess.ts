import type {PluginContext} from '../../api/plugin';
import {find,findByStoreName} from '../../webpack';
import {onNativeSettingsLoaded} from './nativeLoader';
import {running,subscribe,setRunning} from './state';

const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object';
type UseExternalStore=(subscribe:(fn:()=>void)=>(()=>void),snapshot:()=>boolean,serverSnapshot:()=>boolean)=>boolean;

/** Only the native Experiments sidebar branch is exposed. Never reveal the
 * sibling Developer Options branch or modify the account/developer stores. */
export function experimentsSections(value:unknown,useExternalStore:UseExternalStore,subscribeNative:typeof subscribe=subscribe):unknown {
 if(!Array.isArray(value))return value;
 const developer=findByStoreName('DeveloperExperimentStore');
 if(record(developer)&&developer.isDeveloper===true)return value;
 return value.map(section=>{
  if(!record(section)||section.key!=='developer_section'||section.type!==1||typeof section.buildLayout!=='function'||typeof section.usePredicate!=='function')return section;
  const children:unknown=section.buildLayout();if(!Array.isArray(children))return section;
  const experiments=children.find(child=>record(child)&&child.key==='experiments_sidebar_item'&&child.type===2&&typeof child.buildLayout==='function');
  if(!record(experiments)||typeof experiments.buildLayout!=='function')return section;
  const panels:unknown=experiments.buildLayout();
  if(!Array.isArray(panels)||panels.length!==1||!record(panels[0])||panels[0].key!=='experiments_panel'||panels[0].type!==3)return section;
  const predicate=section.usePredicate;
  return {...section,buildLayout:()=>[experiments],usePredicate:()=>{
   const original=predicate.call(section);
   return useExternalStore(subscribeNative,running,running)||original;
  }};
 });
}

let prepare=():boolean=>false;
let installedAccess=false;
export const prepareNativeAccess=():boolean=>prepare();
export const nativeAccessInstalled=():boolean=>installedAccess;
export function installNativeAccess(ctx:PluginContext,patchRoot:(root:object,transform:(result:unknown)=>unknown)=>void):void {
 const installed=new WeakSet<object>();
 const subscriptions=new Set<()=>void>();let stopped=false;
 const subscribeNative:typeof subscribe=listener=>{
  if(stopped)return()=>{};
  const off=subscribe(listener),dispose=():void=>{off();subscriptions.delete(dispose);};
  subscriptions.add(dispose);return dispose;
 };
 const install=():boolean=>{
  if(stopped)return false;
  const react=window.Syncord?.common?.react?.React as {useSyncExternalStore?:UseExternalStore}|undefined;
  if(typeof react?.useSyncExternalStore!=='function')return false;
  const root=find(value=>record(value)&&value.key==='$Root'&&value.type===0&&value.analyticsKey==='user_settings'&&typeof value.buildLayout==='function');
  if(!record(root)||installed.has(root))return false;
  try{
   const hook=react.useSyncExternalStore;
   patchRoot(root,result=>experimentsSections(result,hook,subscribeNative));
   installed.add(root);
   installedAccess=true;
   return true;
  }catch{ctx.log.warn('Native Experiments settings integration is unavailable for this Discord build.');return false;}
 };
 prepare=install;ctx.disposable(()=>{
  stopped=true;prepare=()=>false;installedAccess=false;setRunning(false);
  for(const off of [...subscriptions])off();
 });install();
 ctx.disposable(onNativeSettingsLoaded(()=>{
  try{install();}catch{ctx.log.warn('Native Experiments settings integration is unavailable for this Discord build.');}
 }));
}
