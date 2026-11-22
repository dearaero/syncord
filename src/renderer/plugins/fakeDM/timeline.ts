import {BodyMutationObserver} from "../../ui/bodyObserver";
import {isSafeModeActive,isLockdownActive} from '../../api/plugin';
import {getFiber} from '../../ui/userNames';
import {accountId,target} from './discord';
import {object,type LocalRecord} from './model';
import {projectTree,type ElementNode,type ReactAdapter} from './projection';
import type {LocalStore} from './storage';
import {nativeHeaders,type NativeHeader} from './headers';
type NativeFunction=(props:Record<string,unknown>)=>unknown;
type React=ReactAdapter&{useSyncExternalStore:(subscribe:(fn:()=>void)=>()=>void,snapshot:()=>number)=>number;useRef:<T>(value:T)=>{current:T};useLayoutEffect:(effect:()=>void|(()=>void),deps:unknown[])=>void};
export type Owner={props:{channel?:unknown};render:()=>unknown;renderMessageBanner:()=>unknown;forceUpdate:()=>void};
const text=(fn:unknown)=>typeof fn==='function'?Function.prototype.toString.call(fn):'';
export const nativeStream=(fn:unknown):fn is NativeFunction=>['channelStream','messageGroupSpacing','messagesNavigationDescription','showNewMessagesBar'].every(s=>text(fn).includes(s));
export function mountTimeline(store:LocalStore,render:(r:ReactAdapter,row:LocalRecord,previous?:LocalRecord,compact?:boolean,showDate?:boolean,header?:NativeHeader)=>unknown,install:(prototype:object,hook:(owner:Owner,result:unknown)=>unknown)=>()=>void){
 let stopped=false,revision=0,frame=0;const rendered=new Set<string>();const listeners=new Set<()=>void>(),owners=new Map<Owner,{anchor:Element}>(),prototypes=new Map<object,()=>void>();
 let headerAccount:string|undefined,headerChannel:string|undefined;const headers=new Map<string,NativeHeader>();
 const wrappers=new WeakMap<NativeFunction,NativeFunction>(),outerWrappers=new WeakMap<NativeFunction,NativeFunction>();
 const react=window.Syncord?.common?.react.React as React|undefined;
 if(!react?.useSyncExternalStore||!react.cloneElement||!react.isValidElement)return {refresh(){},available:(_channelId?:string)=>false,dispose(){}};
 const r=react,allowed=()=>!stopped&&!isSafeModeActive()&&!isLockdownActive();
 const subscribe=(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};};
 const notify=()=>{revision++;for(const fn of [...listeners])fn();};
 function stream(original:NativeFunction):NativeFunction{
  const old=wrappers.get(original);if(old)return old;
  const Wrapped:NativeFunction=props=>{
   r.useSyncExternalStore(subscribe,()=>revision);

   // These are the original native component's hooks, called in the same order
   // on every render of this stable wrapper. No native props/records are altered.
   const tree=original(props);try{const channel=object(props.channel)?target(props.channel.id):undefined;
   if(!allowed()||!channel||!Array.isArray(props.channelStream)||!object(props.messages))return tree;
   const account=accountId();if(account!==headerAccount||channel.id!==headerChannel){headers.clear();headerAccount=account;headerChannel=channel.id;}
   const rows=store.rows(channel.id);if(rows.length)for(const [id,header]of nativeHeaders(channel.id))if(channel.participants.includes(id))headers.set(id,header);
   const result=projectTree(tree,rows,r,(row,previous,showDate)=>render(r,row,previous,props.messageDisplayCompact===true,showDate,headers.get(row.authorId)),{before:props.messages.hasMoreBefore===true,after:props.messages.hasMoreAfter===true,empty:props.messages.length===0});
   if(result.found)rendered.add(channel.id);else rendered.delete(channel.id);return result.tree;}catch{return tree;}
  };wrappers.set(original,Wrapped);return Wrapped;
 }
 function outer(original:NativeFunction):NativeFunction{
  const old=outerWrappers.get(original);if(old)return old;
  const Wrapped:NativeFunction=props=>{
   const tree=original(props);try{return project(tree);}catch{return tree;}
  };outerWrappers.set(original,Wrapped);return Wrapped;
 }
 // Providers and native render-prop boundaries can sit between the outer
 // message-list component and its stream. Inspect elements, never invoke an
 // unknown component or alter the native message/store data to cross them.
 function project(root:unknown):unknown{
  let visited=0;
  const walk=(node:unknown,depth:number):unknown=>{
   if(++visited>800||depth>40)return node;if(Array.isArray(node))return node.map(v=>walk(v,depth+1));if(!r.isValidElement(node))return node;
   const element=node as ElementNode,type=element.type,fn=object(type)?type.type:undefined;
   if(nativeStream(type))return r.createElement(stream(type),{...element.props,key:element.key});
   if(typeof fn==='function'&&['channelStream','messageGroupSpacing','getMessages'].every(s=>text(fn).includes(s)))return r.createElement(outer(fn as NativeFunction),{...element.props,key:element.key});
   const children=element.props.children;if(typeof children==='function')return r.cloneElement(element,{children:function(this:unknown,...args:unknown[]){const result=children.apply(this,args);try{return project(result);}catch{return result;}}});
   return children===undefined?node:r.cloneElement(element,{children:walk(children,depth+1)});
  };
  return walk(root,0);
 }
 function scan():void{
  frame=0;if(!allowed())return;const mounted=new Set<Owner>();
  for(const [owner,entry]of owners)if(!entry.anchor.isConnected){owners.delete(owner);}
  for(const list of document.querySelectorAll('main ol')){
   if(list.closest('[data-mc-pane],[data-syncord-popout]'))continue;
   let fiber=getFiber(list) as {return?:unknown;stateNode?:unknown}|null;
   for(let i=0;fiber&&i<80;i++,fiber=fiber.return as typeof fiber){
    const owner=fiber.stateNode as Owner|undefined;
    if(!owner||typeof owner.render!=='function'||typeof owner.renderMessageBanner!=='function'||typeof owner.forceUpdate!=='function'||!object(owner.props?.channel)||!target(owner.props.channel.id))continue;
    mounted.add(owner);if(!owners.has(owner)){
     const prototype=Object.getPrototypeOf(owner) as {render?:unknown}|null;if(!prototype||typeof prototype.render!=='function')continue;
     if(!prototypes.has(prototype)){const undo=install(prototype,(owner,result)=>{
      if(!owners.has(owner))return result;
      if(object(owner.props.channel)&&typeof owner.props.channel.id==='string')rendered.delete(owner.props.channel.id);
      if(!allowed()||!object(owner.props.channel)||!target(owner.props.channel.id))return result;
      return project(result);
     });prototypes.set(prototype,undo);}
     owners.set(owner,{anchor:list.closest('main')??list});owner.forceUpdate();
    }break;
   }
  }
  for(const owner of owners.keys())if(!mounted.has(owner))owners.delete(owner);
  for(const id of rendered)if(![...owners.keys()].some(owner=>object(owner.props.channel)&&owner.props.channel.id===id))rendered.delete(id);
 }
 const schedule=()=>{if(!stopped&&!frame)frame=requestAnimationFrame(scan);};
 // Observe mount/removal only; ignore message churn inside an existing list.
 const observer=new BodyMutationObserver(records=>{if([...owners.values()].some(v=>!v.anchor.isConnected)){schedule();return;}for(const record of records)for(const node of record.addedNodes)if(node instanceof Element&&(node.matches('main')||node.querySelector('main ol')||(!owners.size&&(node.matches('ol')||node.querySelector('ol'))))){schedule();return;}});
 observer.observe(document.body,{childList:true,subtree:true});const off=store.subscribe(notify);scan();
 return {refresh(){notify();schedule();},available:(channelId?:string)=>allowed()&&[...owners].some(([owner,v])=>v.anchor.isConnected&&object(owner.props.channel)&&typeof owner.props.channel.id==='string'&&(!channelId||owner.props.channel.id===channelId)&&rendered.has(owner.props.channel.id)),dispose(){stopped=true;off();observer.disconnect();if(frame)cancelAnimationFrame(frame);for(const undo of prototypes.values())undo();prototypes.clear();for(const owner of owners.keys()){try{owner.forceUpdate();}catch{}}owners.clear();rendered.clear();headers.clear();notify();listeners.clear();}};
}
