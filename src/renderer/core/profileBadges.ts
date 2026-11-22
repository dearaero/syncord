import {badgeImageData,loadBadgeImage,type BadgeImageResolver} from '../api/ecosystem/art';
import {beforeWebpackReady,type WebpackRequire} from '../webpack';
import {after} from '../api/patcher';
import {officialBadges,watchOfficialBadges} from '../api/ecosystem/badges';
import {ecosystemArtUrl} from '../ui/ecosystem/art';
import {watchProfileBadgeRows} from '../ui/ecosystem/profileBadges';
import {ecoAccount,OFFICIAL_BADGE_REFRESH_MS,type EcoBadge,type EcoLookup} from '../../shared/ecosystem';
import {createLogger} from '../api/logger';

const log=createLogger('profile-badges');
type Profile={userId:unknown;getBadges:()=>unknown;getLegacyUsername:()=>unknown};
type Runtime={read:(id:string)=>EcoBadge[]};
let runtime:Runtime|undefined;
let nativeOnly=0;
/** Chat's native-badge resolver constructs DisplayProfile too; it must not count
 * those temporary models as newly opened profiles or fetch offscreen authors. */
export function withoutOfficialProfileBadges<T>(read:()=>T):T{
 nativeOnly++;try{return read();}finally{nativeOnly--;}
}
const prototypes=new Map<object,()=>void>();
const factories=new Map<string,{req:WebpackRequire;original:NonNullable<WebpackRequire['m']>[string];wrapper:NonNullable<WebpackRequire['m']>[string]}>();
function record(value:unknown):value is Record<string,unknown>{return value!==null&&(typeof value==='object'||typeof value==='function');}
function account(value:unknown):string|undefined{try{return ecoAccount(value);}catch{return undefined;}}

/** Append new records, never mutate Discord's cached native badge array/profile. */
export function appendProfileBadges(result:unknown,badges:EcoBadge[]):unknown{
 if(!Array.isArray(result)||!badges.length)return result;
 const ids=new Set(result.map(b=>record(b)?b.id:undefined));
 const additions=badges.filter(b=>!ids.has('syncord:'+b.id)).map(b=>({id:'syncord:'+b.id,description:'Syncord · '+b.name,iconSrc:ecosystemArtUrl(b.art,b.image)})).filter(b=>b.iconSrc);
 return additions.length?[...result,...additions]:result;
}
/** Inspect already-executed exports only. Match model methods, not minified names. */
export function patchProfileExports(exports:unknown):void{
 const seen=new Set<unknown>();
 const visit=(value:unknown,depth:number):void=>{
  if(!record(value)||seen.has(value))return;seen.add(value);
  let prototype:unknown;try{prototype=value.prototype;}catch{return;}
  if(record(prototype)&&typeof prototype.getBadges==='function'&&typeof prototype.getLegacyUsername==='function'&&!prototypes.has(prototype)){
   try{
    const undo=after(prototype,'getBadges',function(this:Profile,_args,result){
     const id=account(this.userId);return runtime&&!nativeOnly&&id&&Array.isArray(result)?appendProfileBadges(result,runtime.read(id)):result;
    });
    prototypes.set(prototype,undo);
   }catch(error){log.warn('Native profile badge model is not patchable',error);}
  }
  if(depth===0||typeof value==='function')return;
  let keys:string[];try{keys=Object.keys(value).slice(0,64);}catch{return;}
  for(const key of keys){try{const nested=value[key];if(typeof nested==='function'||key==='default')visit(nested,depth-1);}catch{/* Unrelated lazy exports may throw. */}}
 };
 visit(exports,2);
}
/** Observe only the native profile model factory; never force-load Discord code. */
export function installProfileBadgeFactories(req:WebpackRequire):void{
 for(const [id,factory]of Object.entries(req.m??{})){
  if(typeof factory!=='function'||factories.get(id)?.wrapper===factory)continue;
  const source=Function.prototype.toString.call(factory);
  if(!/getLegacyUsername\s*\(/.test(source)||!/getBadges\s*\(/.test(source))continue;
  const apply=(module:unknown):void=>{try{if(record(module))patchProfileExports(module.exports);}catch(error){log.warn('Native profile badges unavailable',error);}};
  const cached=req.c?.[id];if(cached?.loaded)apply(cached);
  const wrapper=function(this:unknown,module:unknown,exports:unknown,localRequire:WebpackRequire):void{factory.call(this,module,exports,localRequire);apply(module);};
  req.m![id]=wrapper;factories.set(id,{req,original:factory,wrapper});
 }
}

/** Built-in Ecosystem integration, independent of the optional Show Badges plugin. */
export function startProfileBadges(lookup:(ids:string[])=>Promise<EcoLookup>,enabled:()=>boolean=()=>true,resolveArt?:BadgeImageResolver):()=>void{
 let stopped=false,refreshQueued=false;const imageRequests=new Set<string>();const recent=new Map<string,number>();
 let rows:ReturnType<typeof watchProfileBadgeRows>|undefined;
 const inspected=new WeakSet<object>();
 const store=window.Syncord?.common?.stores.UserProfileStore as {emitChange?:()=>void;addChangeListener?:(fn:()=>void)=>void;removeChangeListener?:(fn:()=>void)=>void}|undefined;
 let detachModelDiscovery:(()=>void)|undefined;
 const discover=():void=>{
  const cache=window.Syncord?.webpack?.getRequire()?.c;
  for(const module of Object.values(cache??{})){
   if(module?.loaded===false||!record(module?.exports)||inspected.has(module.exports))continue;
   inspected.add(module.exports);try{patchProfileExports(module.exports);}catch{/* Foreign export shapes must not interrupt Discord startup. */}
  }
  if(prototypes.size){detachModelDiscovery?.();detachModelDiscovery=undefined;}
 };
 const refresh=():void=>{
  if(stopped||refreshQueued)return;refreshQueued=true;
  queueMicrotask(()=>{
   refreshQueued=false;if(stopped)return;
   rows?.refresh();if(!enabled())return;
   try{store?.emitChange?.();}catch(error){log.warn('Profile badge refresh unavailable',error);}
  });
 };
 const watch=watchOfficialBadges(lookup,refresh,()=>{
  // Only mounted profiles reread their model/row on this store refresh. Retire
  // closed profiles so their last 100 viewed accounts are not polled forever.
  for(const [id,readAt]of recent)if(Date.now()-readAt>=OFFICIAL_BADGE_REFRESH_MS*2)recent.delete(id);
  refresh();return [...recent.keys()];
 });
 runtime={read:id=>{
  if(stopped||!enabled())return [];
  recent.delete(id);recent.set(id,Date.now());if(recent.size>100){const oldest=recent.keys().next();if(!oldest.done)recent.delete(oldest.value);}
  watch.update([...recent.keys()]);const badges=officialBadges(id);
  if(resolveArt)for(const badge of badges){const image=badge.image;if(!image||badgeImageData(image)||imageRequests.has(image)||imageRequests.size>=128)continue;
   imageRequests.add(image);void loadBadgeImage(image,resolveArt).then(()=>{if(!stopped&&enabled())refresh();},()=>{}).finally(()=>imageRequests.delete(image));
  }
  return badges;
 }};
 // Covers a model already in the module cache when Syncord starts late.
 const req=window.Syncord?.webpack?.getRequire();
 if(typeof document!=='undefined'&&document.body)rows=watchProfileBadgeRows(id=>runtime?.read(id)??[],enabled,()=>log.info('Native profile badge row connected'));
 if(req)installProfileBadgeFactories(req);
 discover();
 // A profile UI chunk can arrive long after boot. Inspect newly cached exports
 // on the existing native profile-store signal, and detach once the model is found.
 if(!prototypes.size&&store?.addChangeListener&&store.removeChangeListener){
  store.addChangeListener(discover);detachModelDiscovery=()=>store.removeChangeListener?.(discover);
 }
 return()=>{
  if(stopped)return;stopped=true;runtime=undefined;rows?.stop();rows=undefined;detachModelDiscovery?.();detachModelDiscovery=undefined;watch.release();recent.clear();
  for(const undo of prototypes.values())undo();prototypes.clear();
  for(const [id,entry]of factories){const map=entry.req.m;if(map&&map[id]===entry.wrapper)map[id]=entry.original;}factories.clear();
  const store=window.Syncord?.common?.stores.UserProfileStore as {emitChange?:()=>void}|undefined;
  try{store?.emitChange?.();}catch{/* Discord may already be shutting down. */}
 };
}
beforeWebpackReady(installProfileBadgeFactories);
