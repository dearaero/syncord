import {bindTooltip,hideTooltip} from './tooltip';
import {t,messageKeyForLabel} from '../i18n';

const TOGGLE='button.dion-expand,button.dion-expand-btn';
const CHEVRON='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const detailState=new Map<string,boolean>();
export type SettingsControls={refresh:()=>void;dispose:()=>void;captureFocus:()=>()=>void};

/** Shared Settings presentation. New plugin sections opt in with a button using
 * .dion-expand / .dion-expand-btn, aria-expanded, and a .dion-plugin-details body.
 * Existing plugin handlers own state and side effects. No observer or polling. */
export function bindSettingsControls(root:HTMLElement):SettingsControls {
 let closed=false,serial=0;
 let frame:number|undefined;
 let opening:string|undefined;
 const tips=new Map<HTMLElement,()=>void>();
 const detailsKeys=new WeakMap<HTMLDetailsElement,string>();
 const scope=(element:Element):string=>element.closest('.dion-plugin')?.querySelector<HTMLInputElement>('[data-dion-plugin]')?.dataset.dionPlugin
  ??element.closest('[data-dion-statistics],[data-dion-ecosystem]')?.getAttributeNames().find(name=>name.startsWith('data-dion-'))??'settings';
 const tip=(element:HTMLElement):void=>{
  if(tips.has(element))return;
  tips.set(element,bindTooltip(element,()=>{
   if(element.matches(TOGGLE))return t(element.getAttribute('aria-expanded')==='true'?'ui.hide_options':'ui.show_options')+' · '+(element.getAttribute('aria-label')??'');
   if(element.tagName==='SUMMARY')return t((element.parentElement as HTMLDetailsElement).open?'ui.hide_options':'ui.show_options')+' · '+(element.textContent?.trim()??'');
   const select=element as HTMLSelectElement;
   return select.getAttribute('aria-label')??select.labels?.[0]?.querySelector('.dion-setting-title')?.textContent?.trim()??select.labels?.[0]?.textContent?.trim()??select.selectedOptions[0]?.textContent??'';
  },{position:'top',delay:250}));
 };
 const summary=(details:HTMLDetailsElement):void=>{
  const button=details.querySelector<HTMLElement>(':scope > summary');if(!button)return;
  let content=details.querySelector<HTMLElement>(':scope > .dion-summary-content');
  if(!content){
   content=document.createElement('div');content.className='dion-summary-content';
   content.id=`Syncord-settings-detail-${++serial}`;
   for(const child of Array.from(details.childNodes))if(child!==button)content.append(child);
   details.append(content);
  }
  // Preserve native details keyboard and disclosure semantics.
  button.setAttribute('aria-expanded',String(details.open));
  button.setAttribute('aria-controls',content.id);tip(button);
 };
 const plugin=(button:HTMLButtonElement):void=>{
  const row=button.closest<HTMLElement>('.dion-plugin'),body=row?.querySelector<HTMLElement>('.dion-plugin-details');if(!row||!body)return;
  button.classList.add('dion-disclosure-toggle');
  if(!button.hasAttribute('data-si18n-aria-label')){
   const key=messageKeyForLabel(button.getAttribute('aria-label')??'');
   if(key)button.setAttribute('data-si18n-aria-label',key);
  }
  if(!button.dataset.dionStandardChevron){button.innerHTML=CHEVRON;button.dataset.dionStandardChevron='true';}
  let viewport=body.closest<HTMLElement>('.dion-disclosure');
  if(!viewport){
   viewport=document.createElement('div');viewport.className='dion-disclosure';
   const inner=document.createElement('div');inner.className='dion-disclosure-inner';
   body.before(viewport);viewport.append(inner);inner.append(body);
   const id=scope(row);viewport.id=`Syncord-settings-options-${id}`;
   // Some sections refresh their contents on open. Starting styles animate the
   // replacement surface without forced layout or replaying unrelated sections.
   if(opening===id){viewport.classList.add('dion-disclosure-enter');button.classList.add('dion-disclosure-enter');}
  }
  button.setAttribute('aria-controls',viewport.id);
  const expanded=button.getAttribute('aria-expanded')==='true';
  row.classList.toggle('is-open',expanded);
  if(!expanded&&viewport.contains(document.activeElement))button.focus({preventScroll:true});
  viewport.inert=!expanded;viewport.setAttribute('aria-hidden',String(!expanded));tip(button);
 };
 const refresh=():void=>{
  if(closed)return;
  for(const [element,off]of tips)if(!root.contains(element)){off();tips.delete(element);}
  for(const button of root.querySelectorAll<HTMLButtonElement>(TOGGLE))plugin(button);
  for(const select of root.querySelectorAll<HTMLSelectElement>('select'))tip(select);
  const counts=new Map<string,number>();
  for(const details of root.querySelectorAll<HTMLDetailsElement>('details')){
   const group=scope(details),index=counts.get(group)??0;counts.set(group,index+1);
   const key=group+':'+index;
   if(!detailsKeys.has(details)){
    detailsKeys.set(details,key);const open=detailState.get(key);if(open!==undefined)details.open=open;
   }
   summary(details);
  }
 };
 const schedule=():void=>{
  if(frame!==undefined||closed)return;
  // A microtask from a capture listener can precede native default actions or
  // later plugin listeners. Reconcile once before the next paint instead.
  frame=requestAnimationFrame(()=>{frame=undefined;if(!closed)refresh();opening=undefined;});
 };
 const hover=(event:Event):void=>{
  const element=event.target instanceof Element?event.target.closest<HTMLElement>(`${TOGGLE},summary,select`):null;
  if(!element||!root.contains(element)||tips.has(element))return;
  for(const [old,off]of tips)if(!root.contains(old)){off();tips.delete(old);}
  tip(element);
 };
 const click=(event:Event):void=>{
  const target=event.target instanceof Element?event.target:null;
  const button=target?.closest<HTMLButtonElement>(TOGGLE);
  if(button)opening=button.getAttribute('aria-expanded')!=='true'?scope(button):undefined;
  if(button||target?.closest('summary')){hideTooltip();schedule();}
  else if(target?.closest('select'))hideTooltip();
 };
 const toggle=(event:Event):void=>{
  if(!(event.target instanceof HTMLDetailsElement))return;
  const details=event.target,key=detailsKeys.get(details);
  if(key)detailState.set(key,details.open);summary(details);
 };
 const keydown=(event:KeyboardEvent):void=>{
  if(event.key!=='Escape'||event.defaultPrevented||!(event.target instanceof Element))return;
  const target=event.target;
  if(target instanceof HTMLSelectElement){
   try{if(target.matches(':open')){event.stopPropagation();return;}}catch{event.stopPropagation();return;}
  }
  // Let existing autocomplete handlers close their own results first.
  if(target.matches('[role="combobox"],[aria-expanded="true"]:not(button):not(summary)'))return;
  const details=target.closest<HTMLDetailsElement>('details[open]');
  if(details){
   event.preventDefault();event.stopImmediatePropagation();details.open=false;
   summary(details);const key=detailsKeys.get(details);if(key)detailState.set(key,false);
   details.querySelector<HTMLElement>(':scope > summary')?.focus({preventScroll:true});hideTooltip();return;
  }
  const button=target.closest('.dion-plugin.is-open')?.querySelector<HTMLButtonElement>(TOGGLE);
  if(button){event.preventDefault();event.stopImmediatePropagation();button.click();button.focus({preventScroll:true});}
 };
 root.addEventListener('pointerover',hover,true);root.addEventListener('focusin',hover,true);
 root.addEventListener('click',click,true);root.addEventListener('toggle',toggle,true);root.addEventListener('keydown',keydown,true);
 refresh();
 return {refresh,captureFocus:()=>{
  for(const details of root.querySelectorAll<HTMLDetailsElement>('details')){const key=detailsKeys.get(details);if(key)detailState.set(key,details.open);}
  const active=document.activeElement;if(!(active instanceof HTMLElement)||!root.contains(active))return()=>{};
  const controls=active.getAttribute('aria-controls');
  const key=active.tagName==='SUMMARY'?detailsKeys.get(active.parentElement as HTMLDetailsElement):undefined;
  const attributes=active.getAttributeNames().filter(name=>name.startsWith('data-')&&!name.startsWith('data-si18n-')).map(name=>[name,active.getAttribute(name)] as const);
  const group=scope(active),selection=active instanceof HTMLInputElement||active instanceof HTMLTextAreaElement?[active.selectionStart,active.selectionEnd] as const:undefined;
  return()=>{
   if(closed||active.isConnected)return;
   const candidates=root.querySelectorAll<HTMLElement>(active.tagName.toLowerCase());
   for(const candidate of candidates){
    const match=key?detailsKeys.get(candidate.parentElement as HTMLDetailsElement)===key:controls?candidate.getAttribute('aria-controls')===controls:attributes.length>0&&scope(candidate)===group&&attributes.every(([name,value])=>candidate.getAttribute(name)===value);
    if(!match)continue;candidate.focus({preventScroll:true});
    if(selection&&selection[0]!==null&&(candidate instanceof HTMLInputElement||candidate instanceof HTMLTextAreaElement))try{candidate.setSelectionRange(selection[0],selection[1]);}catch{/* Number/select controls have no text range. */}
    break;
   }
  };
 },dispose:()=>{
  closed=true;if(frame!==undefined)cancelAnimationFrame(frame);for(const off of tips.values())off();tips.clear();
  root.removeEventListener('pointerover',hover,true);root.removeEventListener('focusin',hover,true);
  root.removeEventListener('click',click,true);root.removeEventListener('toggle',toggle,true);root.removeEventListener('keydown',keydown,true);
 }};
}

/** Scoped to Syncord Settings: native Discord menus are unaffected. */
export const SETTINGS_CONTROLS_CSS=`
#Syncord-settings-root{--dion-control-size:32px;--dion-control-radius:9px;--dion-disclosure-duration:200ms;--dion-disclosure-ease:cubic-bezier(.2,.8,.2,1)}
#Syncord-settings-root .dion-disclosure-toggle{width:var(--dion-control-size);height:var(--dion-control-size);padding:0;border:1px solid var(--dion-border);border-radius:var(--dion-control-radius);display:inline-flex;align-items:center;justify-content:center;color:var(--dion-muted);background:var(--dion-bg-high);transition:background-color 140ms ease,border-color 140ms ease,color 140ms ease,transform 140ms ease}
#Syncord-settings-root .dion-disclosure-toggle:hover{background:var(--dion-bg-hover,var(--background-modifier-hover));border-color:var(--dion-border-strong);color:var(--dion-text)}
#Syncord-settings-root .dion-disclosure-toggle:active{background:var(--background-modifier-active)}
#Syncord-settings-root .dion-disclosure-toggle:focus-visible,#Syncord-settings-root summary:focus-visible{outline:2px solid var(--dion-brand);outline-offset:3px}
#Syncord-settings-root .dion-disclosure-toggle>svg{width:16px;height:16px;transition:transform var(--dion-disclosure-duration) var(--dion-disclosure-ease);transform:rotate(0)}
#Syncord-settings-root .dion-disclosure-toggle[aria-expanded=true]>svg{transform:rotate(180deg)}
#Syncord-settings-root .dion-disclosure{display:grid;grid-template-rows:0fr;opacity:0;visibility:hidden;transition:grid-template-rows var(--dion-disclosure-duration) var(--dion-disclosure-ease),opacity var(--dion-disclosure-duration) var(--dion-disclosure-ease),visibility 0s linear var(--dion-disclosure-duration)}
#Syncord-settings-root .dion-plugin.is-open>.dion-disclosure{grid-template-rows:1fr;opacity:1;visibility:visible;transition-delay:0s}
@starting-style{#Syncord-settings-root .dion-plugin.is-open>.dion-disclosure-enter{grid-template-rows:0fr;opacity:0}#Syncord-settings-root .dion-disclosure-toggle.dion-disclosure-enter>svg{transform:rotate(0)}}
#Syncord-settings-root .dion-disclosure-inner{min-height:0;overflow:hidden}
#Syncord-settings-root .dion-disclosure .dion-plugin-details{display:block;animation:none}
#Syncord-settings-root details>summary{display:flex;align-items:center;gap:8px;min-height:34px;padding:8px 0;box-sizing:border-box;cursor:pointer;list-style:none;font-size:12px;font-weight:600;letter-spacing:normal;text-transform:none;color:var(--dion-text)}
#Syncord-settings-root details>summary::-webkit-details-marker{display:none}
#Syncord-settings-root details>summary::after{display:none}
#Syncord-settings-root details>summary::before{content:'';width:16px;height:16px;flex:0 0 16px;background:currentColor;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='m6 9 6 6 6-6' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center/contain no-repeat;transform:rotate(-90deg);transition:transform var(--dion-disclosure-duration) var(--dion-disclosure-ease)}
#Syncord-settings-root details[open]>summary::before{transform:rotate(0)}
#Syncord-settings-root details>summary:hover{color:var(--dion-brand)}
@supports(interpolate-size:allow-keywords){
 #Syncord-settings-root details{interpolate-size:allow-keywords}
 #Syncord-settings-root details::details-content{block-size:0;opacity:0;overflow:clip;transition:block-size var(--dion-disclosure-duration) var(--dion-disclosure-ease),opacity var(--dion-disclosure-duration) var(--dion-disclosure-ease),content-visibility var(--dion-disclosure-duration) allow-discrete}
 #Syncord-settings-root details[open]::details-content{block-size:auto;opacity:1}
}
#Syncord-settings-root select,#Syncord-settings-root select.dion-select{height:var(--dion-control-size);border:1px solid var(--dion-border);border-radius:var(--dion-control-radius);padding:0 32px 0 10px;font:inherit;font-size:12px;font-weight:500;color:var(--dion-text);background-color:color-mix(in srgb,var(--dion-bg) 80%,black 5%);background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='m6 9 6 6 6-6' fill='none' stroke='%23949ba4' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-position:right 9px center;background-size:16px;background-repeat:no-repeat;appearance:none;cursor:pointer;transition:border-color 140ms ease,background-color 140ms ease,box-shadow 140ms ease;max-width:100%}
#Syncord-settings-root .dion-select-wrap>.dion-select-chevron{display:none}
#Syncord-settings-root select:open{border-color:var(--dion-brand);background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='m6 15 6-6 6 6' fill='none' stroke='%23949ba4' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")}
#Syncord-settings-root select:hover{border-color:var(--dion-border-strong)}
#Syncord-settings-root select:focus{border-color:var(--dion-brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--dion-brand) 12%,transparent)}
#Syncord-settings-root select:focus-visible{outline:2px solid var(--dion-brand);outline-offset:2px}
#Syncord-settings-root select:disabled{opacity:.5;cursor:not-allowed}
#Syncord-settings-root select option{background:var(--dion-bg);color:var(--dion-text)}
#Syncord-settings-root[dir=rtl] details:not([open])>summary::before{transform:rotate(90deg)}
#Syncord-settings-root[dir=rtl] select{background-position:left 9px center;padding:0 10px 0 32px}
@media(prefers-reduced-motion:reduce){#Syncord-settings-root .dion-disclosure,#Syncord-settings-root .dion-disclosure-toggle,#Syncord-settings-root .dion-disclosure-toggle>svg,#Syncord-settings-root details::details-content,#Syncord-settings-root details>summary::before,#Syncord-settings-root select{transition:none;animation:none}}
`;
