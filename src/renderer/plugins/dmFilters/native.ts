import {t as i18nText} from "../../i18n";
import {DM_FILTERS,type DmFilter,filterPrivateIds} from './model';
export type ElementLike={type:unknown;props:Record<string,unknown>;key?:unknown};
export type NativeReact={createElement:(type:unknown,props:Record<string,unknown>|null,...children:unknown[])=>ElementLike;
  cloneElement:(element:ElementLike,props:Record<string,unknown>)=>ElementLike;isValidElement:(value:unknown)=>boolean};
type Callback=(...args:unknown[])=>unknown;
export type NativeDmList={props:{privateChannelIds:readonly string[];channels:Record<string,unknown>;padding?:number};state?:{preRenderedChildren?:number};
  render:()=>unknown;renderRow:Callback;renderSection:Callback;getRowHeight:Callback;getSectionHeight:Callback;
  forceUpdate:(callback?:()=>void)=>void;scrollToChannel?:(id:unknown)=>void;
  _list?:{scrollTo?:(options:{to:number})=>void;scrollIntoViewRect?:(options:{start:number;end:number})=>void;getScrollerNode?:()=>unknown}};
const object=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
export function isNativeDmList(value:unknown):value is NativeDmList {
  const instance=object(value),props=object(instance?.props);
  return Array.isArray(props?.privateChannelIds)&&props.privateChannelIds.every(id=>typeof id==='string')&&!!object(props.channels)
    &&['render','renderRow','renderSection','getRowHeight','getSectionHeight','forceUpdate'].every(key=>typeof instance?.[key]==='function');
}
export function isNativeReact(value:unknown):value is NativeReact {
  const react=object(value);return ['createElement','cloneElement','isValidElement'].every(key=>typeof react?.[key]==='function');
}
function isVirtualList(props:Record<string,unknown>):boolean {
  return Array.isArray(props.sections)&&props.sections.length===2&&['renderRow','renderSection','rowHeight','sectionHeight'].every(key=>typeof props[key]==='function');
}
/** Follow only native element children/render props. Never invoke components or force-load a factory. */
export function mapListTree(node:unknown,react:NativeReact,decorate:(props:Record<string,unknown>)=>Record<string,unknown>,depth=0):unknown {
  if(depth>12)return node;
  if(Array.isArray(node))return node.map(child=>mapListTree(child,react,decorate,depth+1));
  if(!react.isValidElement(node))return node;
  const element=node as ElementLike,props=element.props;
  if(isVirtualList(props))return react.cloneElement(element,decorate(props));
  const child=props.children;
  if(typeof child==='function')return react.cloneElement(element,{children:function(this:unknown,...args:unknown[]){return mapListTree((child as Callback).apply(this,args),react,decorate,depth+1);}});
  if(child===undefined)return node;
  const next=mapListTree(child,react,decorate,depth+1);
  return next===child?node:react.cloneElement(element,{children:next});
}
export type ViewOptions={visible?:(id:string)=>boolean;header?:(node:unknown,react:NativeReact)=>unknown;showFilters?:()=>boolean};
export const FILTER_HEIGHT=36;
export function filterBar(react:NativeReact,mode:DmFilter,select:(next:DmFilter)=>void):ElementLike {
  return react.createElement('div',{'data-syncord-dm-filters':'',role:'group','aria-label':i18nText('ui.dm_filters')},...DM_FILTERS.map(({id,label})=>react.createElement('button',{
    type:'button',key:id,'data-dm-filter':id,'aria-pressed':mode===id,
    onClick:(event:{preventDefault:()=>void;stopPropagation:()=>void})=>{event.preventDefault();event.stopPropagation();select(id);},
  },label)));
}
/** Change only the mounted sidebar's virtual-list view, preserving native row components and all data stores. */
export function decorateListTree(result:unknown,instance:NativeDmList,react:NativeReact,current:()=>DmFilter,select:(next:DmFilter)=>void,enabled:()=>boolean,lookup?:(id:string)=>unknown,options:ViewOptions={}):unknown {
  return mapListTree(result,react,props=>{
    if(!enabled())return props;
    const mode=current(),ids=instance.props.privateChannelIds,selected=filterPrivateIds(ids,instance.props.channels,mode,lookup);
    const filtered=options.visible?selected.filter(options.visible):selected;
    const filters=options.showFilters?.()??true,empty=filtered.length===0&&(mode!=='all'||ids.length>0);
    const originalRows=filtered===ids?undefined:new Map(ids.map((id,i)=>[id,i]));
    const sections=props.sections as number[],before=sections[0],total=before+filtered.length;
    const nativeRow=props.renderRow as Callback,nativeHeader=props.renderSection as Callback;
    const nativeHeight=props.rowHeight as Callback,nativeSection=props.sectionHeight as Callback;
    return {...props,sections:[before,Math.max(filtered.length,1)],
      renderRow:function(this:unknown,...args:unknown[]){
        const row=object(args[0]);if(!row||row.section!==1){
          const child=nativeRow.apply(this,args);
          return react.isValidElement(child)?react.cloneElement(child as ElementLike,{'aria-setsize':total}):child;
        }
        if(empty)return react.createElement('div',{'data-syncord-dm-filter-empty':'',role:'status'},i18nText(filters?'ui.no_conversations_in_this_filter':'ui.no_visible_conversations'));
        const index=typeof row.row==='number'?row.row:0,original=originalRows?.get(filtered[index])??index;
        const child=nativeRow.call(this,{...row,row:original},...args.slice(1));
        return react.isValidElement(child)?react.cloneElement(child as ElementLike,{'aria-setsize':total,'aria-posinset':before+index+1}):child;
      },
      renderSection:function(this:unknown,...args:unknown[]){
        const child=nativeHeader.apply(this,args);if(object(args[0])?.section!==1)return child;
        const header=options.header?.(child,react)??child;
        return filters?react.createElement('div',{'data-syncord-dm-filter-section':''},header,filterBar(react,mode,select)):header;
      },
      rowHeight:function(this:unknown,...args:unknown[]){
        if(args[0]===1&&empty)return 64;
        return nativeHeight.apply(this,args);
      },
      sectionHeight:function(this:unknown,...args:unknown[]){
        const height=nativeSection.apply(this,args);return typeof height==='number'&&args[0]===1?height+(filters?FILTER_HEIGHT:0):height;
      },
    };
  });
}
/** Native selected-channel scrolling must use the filtered position, not an unfiltered index. */
export function scrollFiltered(instance:NativeDmList,mode:DmFilter,id:unknown,lookup?:(id:string)=>unknown,options:ViewOptions={}):boolean {
  const list=instance._list;if(!list?.scrollTo)return false;
  const selected=filterPrivateIds(instance.props.privateChannelIds,instance.props.channels,mode,lookup),ids=options.visible?selected.filter(options.visible):selected,index=typeof id==='string'?ids.indexOf(id):-1;
  if(index<0){list.scrollTo({to:0});return true;}
  if(!list.scrollIntoViewRect)return false;
  const before=instance.state?.preRenderedChildren??0;
  let top=instance.props.padding??8;
  for(let i=0;i<before;i++){const value=instance.getRowHeight(0,i);if(typeof value!=='number'||!Number.isFinite(value)||value<0)return false;top+=value;}
  const header=instance.getSectionHeight(1),height=instance.getRowHeight(1,0);
  if(typeof header!=='number'||typeof height!=='number'||!Number.isFinite(header)||!Number.isFinite(height)||height<=0)return false;
  top+=header+((options.showFilters?.()??true)?FILTER_HEIGHT:0)+index*height;
  list.scrollIntoViewRect({start:Math.max(0,top-8),end:top+height+8});return true;
}
