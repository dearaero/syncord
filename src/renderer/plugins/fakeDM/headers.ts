import {getFiber,type Fiber} from '../../ui/userNames';
import {object} from './model';
import type {ReactAdapter} from './projection';
type BoundaryProps={children?:unknown;fallback?:unknown};
type Component=new(props:BoundaryProps)=>{props:BoundaryProps};
const boundaries=new WeakMap<object,unknown>();
/** A changed native dependency must fail only this presentation, never the chat. */
export function nativePresentation(r:ReactAdapter,child:unknown,fallback:unknown):unknown{
 const Base=(r as ReactAdapter&{Component?:Component}).Component;if(!Base)return fallback;
 let Boundary=boundaries.get(r);if(!Boundary){class Guard extends Base{
  state={failed:false};static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?this.props.fallback:this.props.children;}
 }Boundary=Guard;boundaries.set(r,Boundary);}
 return r.createElement(Boundary,{fallback},child);
}
export type NativeHeader={type:unknown;message:Record<string,unknown>;author:Record<string,unknown>;channel:Record<string,unknown>;timestamp?:unknown};
export function isNativeHeader(type:unknown):boolean{
 const fn=object(type)?type.type:type;
 return typeof fn==='function'&&['hideGuildTag','showTimestampOnHover','subscribeToGroupId','enableScheduledBadge'].every(key=>Function.prototype.toString.call(fn).includes(key));
}
export function isNativeTimestamp(type:unknown):boolean{
 const fn=object(type)?type.type:type;
 return typeof fn==='function'&&['timestampFormat','isVisibleOnlyOnHover','cozyAlt','isEdited','tooltipPosition'].every(key=>Function.prototype.toString.call(fn).includes(key));
}
function timestampType(name:Element):unknown{
 const time=name.closest('h3')?.querySelector('time');if(!time)return;
 let fiber=getFiber(time) as (Fiber&{type?:unknown})|null;
 for(let i=0;fiber&&i<12;i++,fiber=fiber.return??null)if(isNativeTimestamp(fiber.type))return fiber.type;
}
/** Reuse only an already-mounted header for this DM's actual author. Its real
 * message is read-only identity context, never changed or inserted in a store.
 * Only the presentation props are retained; native action closures are excluded. */
export function nativeHeaders(channelId:string):ReadonlyMap<string,NativeHeader>{
 const found=new Map<string,NativeHeader>();
 for(const name of document.querySelectorAll('main ol [id^="message-username-"]')){
  if(name.closest('[data-syncord-local-record],[data-mc-pane],[data-syncord-popout]'))continue;
  let fiber=getFiber(name) as (Fiber&{type?:unknown;return?:unknown})|null;
  for(let depth=0;fiber&&depth<32;depth++,fiber=fiber.return as typeof fiber){
   const props=fiber.memoizedProps??fiber.pendingProps;
   if(!props||!isNativeHeader(fiber.type)||!object(props.message)||!object(props.author)||!object(props.channel)||props.channel.id!==channelId||!object(props.message.author))continue;
   const id=props.message.author.id;
   if(typeof id==='string'&&!found.has(id))found.set(id,{type:fiber.type,message:props.message,author:props.author,channel:props.channel,timestamp:timestampType(name)});
   break;
  }
 }
 return found;
}
