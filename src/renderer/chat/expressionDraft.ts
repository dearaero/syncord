/** Trusted Syncord composers expose insertion, never sending, to picker integrations. */
export type ExpressionDraft = {channelId:string; valid:()=>boolean; insertText:(text:string,close:boolean)=>void};
const drafts = new WeakMap<object, ExpressionDraft>();
const listeners = new Set<(event:Event)=>void>();
export function registerExpressionDraft(type:object,draft:ExpressionDraft):()=>void {
  drafts.set(type,draft);return()=>{if(drafts.get(type)===draft)drafts.delete(type);};
}
export function expressionDraft(type:unknown):ExpressionDraft|undefined {
  return type!==null&&typeof type==='object'?drafts.get(type):undefined;
}
export function onExpressionSelection(listener:(event:Event)=>void):()=>void {
  listeners.add(listener);return()=>{listeners.delete(listener);};
}
/** Also covers native pickers hosted in a different popout document. */
export function bindExpressionSurface(host:HTMLElement):()=>void {
  if(host.ownerDocument?.defaultView===window)return()=>{};
  const capture=(event:Event)=>{for(const listener of listeners)listener(event);};
  for(const type of ['click','keydown'])host.addEventListener(type,capture,true);
  return()=>{for(const type of ['click','keydown'])host.removeEventListener(type,capture,true);};
}
