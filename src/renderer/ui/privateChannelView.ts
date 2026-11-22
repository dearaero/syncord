import {BodyMutationObserver} from "./bodyObserver";
import {onLocaleChange} from "../i18n";
import type {DmFilter} from '../plugins/dmFilters/model';
import type {PluginContext} from '../api/plugin';
import {getFiber} from './userNames';
import {isNativeDmList,isNativeReact,decorateListTree,scrollFiltered,type NativeDmList,type NativeReact,type ViewOptions} from '../plugins/dmFilters/native';
const PRIVATE='[class*="privateChannels_"],[class*="privateChannels__"],[data-syncord-private-channels]';
type Entry={anchor:Element};
function listInstances():Map<NativeDmList,Element> {
  const found=new Map<NativeDmList,Element>();
  for(const sidebar of document.querySelectorAll(PRIVATE)){
    const candidates=[sidebar,...sidebar.querySelectorAll('h2,h3,[data-list-id^="private-channels"],a[href^="/channels/@me/"]')];
    for(const node of candidates){
      let fiber=getFiber(node) as {stateNode?:unknown;return?:unknown}|null;
      for(let depth=0;fiber&&depth<48;depth++,fiber=fiber.return as typeof fiber){
        const instance=fiber.stateNode;if(!isNativeDmList(instance))continue;
        let anchor:unknown;try{anchor=instance._list?.getScrollerNode?.();}catch{/* Native list is mounting. */}
        found.set(instance,anchor instanceof Element&&anchor.isConnected?anchor:sidebar);break;
      }
    }
  }
  return found;
}

type Contribution=ViewOptions&{availabilityChanged?:(available:boolean)=>void;content?:(react:NativeReact)=>unknown;mode?:()=>DmFilter;select?:(next:DmFilter)=>void};
const leases=new Map<symbol,{ctx:PluginContext;options:Contribution}>();
let host:{refresh:(reset?:boolean)=>void;stop:()=>void;available:()=>boolean}|undefined,owner:PluginContext|undefined;
const combined:Contribution={
  availabilityChanged:available=>{for(const v of leases.values())try{v.options.availabilityChanged?.(available);}catch{/* Isolate consumers. */}},
  content:react=>{for(const v of leases.values()){const node=v.options.content?.(react);if(node!==undefined)return node;}return undefined;},
  showFilters:()=>{for(const v of leases.values())if(v.options.mode)return true;return false;},
  visible:id=>{for(const v of leases.values())if(v.options.visible?.(id)===false)return false;return true;},
  header:(node,react)=>{for(const v of leases.values())node=v.options.header?.(node,react)??node;return node;},
  mode:()=>{for(const v of leases.values())if(v.options.mode)return v.options.mode();return 'all';},
  select:next=>{for(const v of leases.values())if(v.options.select){v.options.select(next);return;}},
};
export function registerDmView(ctx:PluginContext,options:Contribution):{refresh:(reset?:boolean)=>void;available:()=>boolean} {
  const token=Symbol();leases.set(token,{ctx,options});
  const start=():void=>{const first=leases.values().next().value;if(!first)return;owner=first.ctx;host=createHost(owner,combined);};
  if(!host)start();else host.refresh();
  ctx.disposable(()=>{
    leases.delete(token);
    if(owner===ctx){host?.stop();host=undefined;owner=undefined;if(leases.size)start();}
    else host?.refresh();
  });
  return{refresh:reset=>host?.refresh(reset),available:()=>host?.available()??false};
}
function createHost(ctx:PluginContext,options:Contribution):{refresh:(reset?:boolean)=>void;stop:()=>void;available:()=>boolean} {
    let stopped=false,frame=0,retry=0,retryEnd=0,lastAvailable=false;
    const entries=new Map<NativeDmList,Entry>(),prototypes=new Map<object,()=>void>();
    const available=():boolean=>!stopped&&[...entries.values()].some(entry=>entry.anchor.isConnected);
    const notifyAvailability=():void=>{const next=available();if(next===lastAvailable)return;lastAvailable=next;options.availabilityChanged?.(next);};
    const lookup=(id:string):unknown=>{const s=window.Syncord?.common?.stores.ChannelStore as {getChannel?:(id:string)=>unknown}|undefined;return s?.getChannel?.(id);};
    const update=(instance:NativeDmList,reset=false):void=>{try{instance.forceUpdate(reset?()=>instance._list?.scrollTo?.({to:0}):undefined);}catch(error){ctx.log.warn('Private channel view refresh unavailable',error);}};
    const react=():NativeReact|undefined=>{const r=window.Syncord?.common?.react.React;return isNativeReact(r)?r:undefined;};
    const scan=():void=>{
      frame=0;if(stopped)return;
      for(const [instance,entry] of entries)if(!entry.anchor.isConnected)entries.delete(instance);
      const nativeReact=react();if(!nativeReact)return;
      for(const [instance,anchor] of listInstances()){
        if(entries.has(instance))continue;
        const prototype=Object.getPrototypeOf(instance) as {render?:unknown;scrollToChannel?:unknown}|null;
        if(!prototype||typeof prototype.render!=='function')continue;
        if(!prototypes.has(prototype)){
          let undoRender:(()=>void)|undefined,undoScroll:(()=>void)|undefined;
          try{
            // Patch the native class once. Per-row/instance patch disposers would
            // retain every unmounted sidebar until this plugin is disabled.
            undoRender=ctx.patch.after(prototype,'render',function(this:NativeDmList,_args,result){
              if(stopped||!entries.has(this))return result;
              const replacement=options.content?.(nativeReact);if(replacement!==undefined)return replacement;
              return decorateListTree(result,this,nativeReact,()=>options.mode?.()??'all',next=>options.select?.(next),()=>!stopped,lookup,options);
            });
            if(typeof prototype.scrollToChannel==='function')undoScroll=ctx.patch.instead(prototype,'scrollToChannel',function(this:NativeDmList,args,original){
              if(stopped||!entries.has(this))return original(...args);
              if(options.content?.(nativeReact)!==undefined)return;
              try{if(scrollFiltered(this,options.mode?.()??'all',args[0],lookup,options))return;}catch(error){ctx.log.warn('DM filter scroll unavailable',error);}return original(...args);
            });
            prototypes.set(prototype,()=>{undoRender?.();undoScroll?.();});
          }catch(error){undoRender?.();undoScroll?.();ctx.log.warn('Native DM filter view unavailable',error);continue;}
        }
        entries.set(instance,{anchor});update(instance);
      }
      notifyAvailability();
      if(entries.size){window.clearInterval(retry);window.clearTimeout(retryEnd);retry=retryEnd=0;}
    };
    const schedule=():void=>{if(!stopped&&!frame)frame=requestAnimationFrame(scan);};
    const observer=new BodyMutationObserver(mutations=>{
      if([...entries.values()].some(entry=>!entry.anchor.isConnected)){schedule();return;}
      for(const m of mutations){
        if(m.target instanceof Element&&m.target.closest('[data-syncord-dm-filter-section]'))continue;
        if(!entries.size&&m.target instanceof Element&&m.target.closest(PRIVATE)){schedule();return;}
        if([...m.addedNodes].some(node=>node instanceof Element&&(node.matches(PRIVATE)||!!node.querySelector(PRIVATE)))){schedule();return;}
      }
    });
    const stopLocale=onLocaleChange(()=>{for(const [instance,entry]of entries)if(entry.anchor.isConnected)update(instance);});
    const stop=():void=>{
      stopLocale();stopped=true;notifyAvailability();observer.disconnect();if(frame)cancelAnimationFrame(frame);window.clearInterval(retry);window.clearTimeout(retryEnd);
      for(const undo of prototypes.values())undo();prototypes.clear();
      for(const [instance,entry] of entries)if(entry.anchor.isConnected)update(instance);entries.clear();
    };
    observer.observe(document.body,{childList:true,subtree:true});
    scan();
    if(!entries.size){retry=window.setInterval(scan,500);retryEnd=window.setTimeout(()=>{window.clearInterval(retry);retry=retryEnd=0;},30_000);}
    return{stop,available,refresh:(reset=false)=>{for(const [instance,entry] of entries)if(entry.anchor.isConnected)update(instance,reset);schedule();}};
}
