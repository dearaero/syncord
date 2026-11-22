import {ensureReact,kit,resolveTooltip,resolveProfileTooltip,type ReactNs} from '../discordKit';
import {getFiber,type Fiber} from './userNames';

const MAX_CONTEXT_DEPTH=512;
type Provider={type:unknown;value:unknown};
type ProviderFiber=Fiber&{type?:unknown;elementType?:unknown;alternate?:ProviderFiber|null;stateNode?:{current?:unknown}};
function currentFiberFor(anchor:Element|undefined):ProviderFiber|null{
 if(!anchor)return null;
 let fiber:ProviderFiber|null=null;
 for(let element:Element|null=anchor;element&&!fiber;element=element.parentElement)fiber=getFiber(element);
 // DOM attachments can refer to the previous React branch after an update.
 let root=fiber;for(let i=0;root?.return&&i<MAX_CONTEXT_DEPTH;i++)root=root.return;
 if(root?.stateNode?.current&&root.stateNode.current!==root)fiber=fiber?.alternate??fiber;
 return fiber;
}
function providersFor(anchor:Element|undefined):Provider[]{
 let fiber=currentFiberFor(anchor);
 const providers:Provider[]=[],seen=new Set<ProviderFiber>();
 for(let i=0;fiber&&!seen.has(fiber)&&i<MAX_CONTEXT_DEPTH;fiber=fiber.return??null,i++){
  seen.add(fiber);const type=fiber.type,props=fiber.memoizedProps??fiber.pendingProps;
  if(!type||typeof type!=='object'||!props||!Object.hasOwn(props,'value'))continue;
  const context=type as {$$typeof?:unknown;Provider?:unknown};
  if(context.$$typeof===Symbol.for('react.provider')||(context.$$typeof===Symbol.for('react.context')&&context.Provider===type))providers.push({type,value:props.value});
 }
 return providers;
}

function badgeTooltipProps(anchor:Element|undefined,component:unknown):Record<string,unknown>{
 // Discord's profile badge delay is 300 ms; prefer the live sibling's values
 // so placement/timing follows the current client rather than a copied spring.
 const result:Record<string,unknown>={delay:300,position:'top',ariaHidden:true};
 for(const image of anchor?.querySelectorAll('img[src*="/badge-icons/"]')??[]){
  let fiber=currentFiberFor(image);
  for(let depth=0;fiber&&depth<MAX_CONTEXT_DEPTH;depth++,fiber=fiber.return??null){
   if(fiber.type!==component&&fiber.elementType!==component)continue;
   const props=fiber.memoizedProps??fiber.pendingProps;if(!props)break;
   for(const key of ['delay','spacing']){const value=props[key];if(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=(key==='delay'?5000:64))result[key]=value;}
   if(['top','bottom','left','right'].includes(String(props.position)))result.position=props.position;
   if(['center','left','right','top','bottom'].includes(String(props.align)))result.align=props.align;
   for(const key of ['ariaHidden','hideOnClick','overflowOnly'])if(typeof props[key]==='boolean')result[key]=props[key];
   return result;
  }
 }
 return result;
}

/** A React island inside our own DOM host; Discord owns tooltip visuals,
 * positioning, hover/focus handlers, accessibility and portal cleanup. */
export function mountNativeTooltip(
 host:HTMLElement,
 text:string,
 child:(react:ReactNs,props:Record<string,unknown>)=>unknown,
 contextAnchor?:Element,
):(()=>void)|undefined{
 try{
  const profileTooltip=resolveProfileTooltip(),Tooltip=profileTooltip??resolveTooltip();if(!Tooltip||!ensureReact())return undefined;
  const react=kit.react,createRoot=kit.createRoot;if(!react||!createRoot)return undefined;
  const root=createRoot(host);
  try{
   const options=badgeTooltipProps(contextAnchor,Tooltip);
   let tree=profileTooltip
    ?react.createElement(Tooltip,{...options,text},child(react,{}))
    :react.createElement(Tooltip,{...options,text,color:'primary'},(props:Record<string,unknown>)=>child(react,props??{}));
   // A new root does not inherit Discord's App Layer context. Its native Layer
   // deliberately renders null without a container, even when hover succeeds.
   // Reprovide the actual ancestor values (also theme/accessibility), nearest
   // first so nested providers retain their original precedence.
   for(const provider of providersFor(contextAnchor))tree=react.createElement(provider.type,{value:provider.value},tree);
   root.render(tree);
  }
  catch{root.unmount();return undefined;}
  let disposed=false;return()=>{if(!disposed){disposed=true;root.unmount();}};
 }catch{return undefined;}
}
