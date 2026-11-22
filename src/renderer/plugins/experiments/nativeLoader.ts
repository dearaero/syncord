import {beforeWebpackReady,type WebpackRequire} from '../../webpack';

const listeners=new Set<()=>void>();
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object';
export function onNativeSettingsLoaded(listener:()=>void):()=>void {
 listeners.add(listener);return()=>{listeners.delete(listener);};
}

/** Native modal exports are read-only webpack getters. Adapt only the settings
 * router's dependency, before that router initializes, instead of monkeypatching
 * the global modal service or forcing any lazy factories to execute. */
export function captureSettingsLoader(req:WebpackRequire):void {
 const modules=req.m;if(!modules)return;
 const matches=Object.entries(modules).filter(([,factory])=>{
  if(typeof factory!=='function')return false;
  const source=Function.prototype.toString.call(factory);
  return ['openUserSettings','USER_SETTINGS_MODAL_OPEN','openModalLazy','closeWithValidation'].every(key=>source.includes(key));
 });
 if(matches.length!==1)return;
 const [id,original]=matches[0];if(!original||req.c?.[id])return;
 const wrapped:NonNullable<NonNullable<WebpackRequire['m']>[string]>=function(module,exports,nativeReq){
  if(modules[id]===wrapped)modules[id]=original;
  const dependencyReq=new Proxy(nativeReq,{apply(target,thisArg,args){
   const dependency:unknown=Reflect.apply(target,thisArg,args);
   if(!record(dependency)||typeof dependency.openModalLazy!=='function'||typeof dependency.hasModalOpen!=='function'||typeof dependency.closeModal!=='function')return dependency;
   return new Proxy(dependency,{get(object,key,receiver){
    const value:unknown=Reflect.get(object,key,receiver);
    if(key!=='openModalLazy'||typeof value!=='function')return value;
    return function(this:unknown,...values:unknown[]):unknown{
     const [loader,options]=values;
     if(listeners.size&&typeof loader==='function'&&record(options)&&options.modalKey==='USER_SETTINGS_MODAL_MODAL_KEY'){
      values[0]=async function(this:unknown,...args:unknown[]):Promise<unknown>{
       const render:unknown=await Reflect.apply(loader,this,args);
       for(const listener of [...listeners])if(listeners.has(listener)){try{listener();}catch{/* Preserve native modal loading. */}}
       return render;
      };
     }
     return Reflect.apply(value,this,values);
    };
   }});
  }}) as WebpackRequire;
  original(module,exports,dependencyReq);
 };
 modules[id]=wrapped;
}

// One-shot factory adapter, using the same early capture as native Spotify.
// With the plugin disabled there are no listeners, timers or changed modal args.
beforeWebpackReady(captureSettingsLoader);
