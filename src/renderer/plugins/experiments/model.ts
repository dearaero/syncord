import {find,findByProps,findByStoreName} from '../../webpack';
import {prepareNativeAccess,nativeAccessInstalled} from './nativeAccess';

type ExperimentStore={
 getRegisteredExperiments():unknown;
 getAllExperimentAssignments():unknown;
 addChangeListener?:(listener:()=>void)=>void;
 removeChangeListener?:(listener:()=>void)=>void;
};
export type Experiment={name:string;title:string;buckets:number[];descriptions:string[];assignment:number|null};
export type Snapshot={available:boolean;experiments:Experiment[]};
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value:unknown):string=>typeof value==='string'?value.slice(0,1000):'';

/** Read only: assignment getters avoid exposure tracking and server evaluation. */
export function snapshot(store:unknown):Snapshot {
 try{
  if(!record(store)||typeof store.getRegisteredExperiments!=='function'||typeof store.getAllExperimentAssignments!=='function')return{available:false,experiments:[]};
  const definitions:unknown=store.getRegisteredExperiments(),assignments:unknown=store.getAllExperimentAssignments();
  if(!record(definitions)||!record(assignments))return{available:false,experiments:[]};
  const overrides:unknown=typeof store.getAllExperimentOverrideDescriptors==='function'?store.getAllExperimentOverrideDescriptors():{};
  if(!record(overrides))return{available:false,experiments:[]};
  const experiments:Experiment[]=[];
  for(const [name,value] of Object.entries(definitions)){
   // Guild and unknown experiment kinds are deliberately excluded.
   if(!record(value)||value.type!=='user'||!name||name.length>200||!Array.isArray(value.buckets))continue;
   const buckets=value.buckets.filter((bucket):bucket is number=>typeof bucket==='number'&&Number.isSafeInteger(bucket));
   const override=Object.hasOwn(overrides,name)?overrides[name]:undefined;
   const assigned=record(override)&&override.type==='user'&&override.override===true?override.bucket:Object.hasOwn(assignments,name)?assignments[name]:undefined;
   experiments.push({name,title:text(value.title)||name,buckets,
    descriptions:Array.isArray(value.description)?value.description.map(text).filter(Boolean):text(value.description)?[text(value.description)]:[],
    assignment:typeof assigned==='number'&&Number.isSafeInteger(assigned)?assigned:null});
  }
  experiments.sort((a,b)=>a.name.localeCompare(b.name));return{available:true,experiments};
 }catch{return{available:false,experiments:[]};}
}
export function discover():unknown {
 try{return window.Syncord?.common?.stores?.ExperimentStore??findByStoreName('ExperimentStore');}catch{return undefined;}
}
export function watch(store:unknown,listener:()=>void):()=>void {
 try{
  if(!record(store))return()=>{};
  const target=store as Partial<ExperimentStore>,add=target.addChangeListener,remove=target.removeChangeListener;
  if(typeof add!=='function'||typeof remove!=='function')return()=>{};
  try{add.call(target,listener);}catch{try{remove.call(target,listener);}catch{/* Partial subscription. */}return()=>{};}
  return()=>{try{remove.call(target,listener);}catch{/* Discord shutdown. */}};
 }catch{return()=>{};}
}
const NATIVE_TARGET='experiments_panel';
type NavigationState={getState():{currentPanelKey?:unknown}};
function navigationState():NavigationState|undefined {
 return find(value=>{
  if(!record(value)||typeof value.getState!=='function')return false;
  const state:unknown=value.getState();
  return record(state)&&Object.hasOwn(state,'currentPanelKey')&&Object.hasOwn(state,'currentCategoryKey')&&Object.hasOwn(state,'scrollPositionSnapshots');
 }) as NavigationState|undefined;
}
function delay(signal?:AbortSignal):Promise<void> {
 return new Promise(resolve=>{
  if(signal?.aborted){resolve();return;}
  const finish=():void=>{clearTimeout(timer);signal?.removeEventListener('abort',finish);resolve();};
  const timer=setTimeout(finish,50);signal?.addEventListener('abort',finish,{once:true});
 });
}
/** An already-mounted native settings tree memoizes its original layout.
 * Reopen only through Discord's unsaved-change validation, never closeModal. */
async function refreshMountedSettings(signal?:AbortSignal):Promise<boolean> {
 if(!nativeAccessInstalled())return true;
 const navigation=findByProps('navigate','maybeWaitForAccordionExpansion','reset');
 if(!record(navigation)||typeof navigation.closeWithValidation!=='function')return true;
 const directory=navigation.accessibleDirectory;
 if(!record(directory)||typeof directory.entry!=='function'||directory.entry(NATIVE_TARGET)!=null)return true;
 const modals=findByProps('hasModalOpen','openModalLazy','closeModal');
 if(!record(modals)||typeof modals.hasModalOpen!=='function'||!modals.hasModalOpen('USER_SETTINGS_MODAL_MODAL_KEY'))return true;
 if(signal?.aborted)return false;
 navigation.closeWithValidation();
 for(let attempt=0;attempt<20;attempt++){
  if(signal?.aborted)return false;
  if(!modals.hasModalOpen('USER_SETTINGS_MODAL_MODAL_KEY')&&navigation.accessibleDirectory==null)return true;
  await delay(signal);
 }
 return false;
}
/** Routing is a UI action, not developer identity. Confirm the native selection
 * because modern Discord silently ignores targets outside its settings tree. */
export async function openNative(signal?:AbortSignal):Promise<boolean> {
 try{
  if(signal?.aborted)return false;
  const candidate=window.Syncord?.common?.utils?.SettingsRouter??findByProps('openUserSettings');
  if(!record(candidate)||typeof candidate.openUserSettings!=='function')return false;
  prepareNativeAccess();
  if(!await refreshMountedSettings(signal)||signal?.aborted)return false;
  await candidate.openUserSettings(NATIVE_TARGET);
  if(signal?.aborted)return false;
  // Lazy settings exports become available through Discord's own open action.
  // Install before the modal's scheduled React render; never require factories.
  if(prepareNativeAccess()){
   if(!await refreshMountedSettings(signal)||signal?.aborted)return false;
   await candidate.openUserSettings(NATIVE_TARGET);
   if(signal?.aborted)return false;
  }
  const state=navigationState();
  if(!state)return false;
  for(let attempt=0;attempt<20;attempt++){
   if(signal?.aborted)return false;
   const selected=state?.getState().currentPanelKey===NATIVE_TARGET;
   const anchor=document.querySelector('[data-nav-anchor-key="experiments_panel"], [data-settings-sidebar-item="experiments_panel"] [aria-current="page"]');
   if(selected&&anchor)return true;
   await delay(signal);
  }
  return false;
 }catch{return false;}
}
