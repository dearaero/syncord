import {h,t,messageHtml,onLocaleChange} from '../../i18n';
import {closeSettings} from '../../ui/settingsPanel';
import {discover,snapshot,watch,openNative,type Snapshot} from './model';
import {running,subscribe} from './state';

let expanded=false;
export const isExperimentsExpanded=():boolean=>expanded;
export function experimentsExpandHtml():string {return `<button type="button" class="dion-icon-btn dion-expand" data-exp-expand aria-expanded="${expanded}" aria-label="${h('exp.name')}">⌄</button>`;}
export function experimentsSectionHtml():string {return `<section class="dion-plugin-details" data-exp-panel>
 <p class="dion-setting-desc">${messageHtml('exp.notice')}</p><p class="dion-setting-desc">${messageHtml('exp.readonly')}</p>
 <div class="dion-setting-row"><button type="button" class="dion-primary-btn" data-exp-native>${messageHtml('exp.open')}</button><button type="button" class="dion-icon-btn" data-exp-refresh aria-label="${h('exp.refresh')}">↻</button></div>
 <div class="dion-search"><input type="search" data-exp-search placeholder="${h('exp.search')}" aria-label="${h('exp.search')}" data-si18n-placeholder="exp.search" data-si18n-aria-label="exp.search"></div>
 <p class="dion-setting-desc" data-exp-status role="status"></p><div data-exp-results></div>
 <div class="dion-setting-row"><button type="button" class="dion-icon-btn" data-exp-page="-1" aria-label="${h('ui.previous_results_page')}">←</button><span data-exp-count></span><button type="button" class="dion-icon-btn" data-exp-page="1" aria-label="${h('ui.next_results_page')}">→</button></div>
 </section>`;}
export function bindExperimentsPanel(root:HTMLElement):()=>void {
 const host=root.querySelector<HTMLElement>('[data-exp-panel]');if(!host)return()=>{};
 const input=host.querySelector<HTMLInputElement>('[data-exp-search]')!;
 const status=host.querySelector<HTMLElement>('[data-exp-status]')!,results=host.querySelector<HTMLElement>('[data-exp-results]')!;
 let closed=false,queued=false,page=0,error='',busy=false,epoch=0,store:unknown,operation:AbortController|undefined,offStore=()=>{},data:Snapshot={available:false,experiments:[]};
 const active=():boolean=>!closed&&expanded&&running();
 const render=():void=>{
  if(closed)return;const on=active();
  input.placeholder=t('exp.search');input.setAttribute('aria-label',t('exp.search'));
  root.querySelector('[data-exp-expand]')?.setAttribute('aria-label',t('exp.name'));
  host.querySelector('[data-exp-refresh]')?.setAttribute('aria-label',t('exp.refresh'));
  host.querySelector('[data-exp-page="-1"]')?.setAttribute('aria-label',t('ui.previous_results_page'));
  host.querySelector('[data-exp-page="1"]')?.setAttribute('aria-label',t('ui.next_results_page'));
  for(const button of host.querySelectorAll<HTMLButtonElement>('button'))button.disabled=!on||busy;
  input.disabled=!on;
  if(!on){results.replaceChildren();status.textContent='';return;}
  const query=input.value.trim().toLowerCase();
  const filtered=data.experiments.filter(row=>(row.name+' '+row.title+' '+row.descriptions.join(' ')).toLowerCase().includes(query));
  const pages=Math.max(1,Math.ceil(filtered.length/40));page=Math.max(0,Math.min(page,pages-1));
  const fragment=document.createDocumentFragment();
  for(const row of filtered.slice(page*40,(page+1)*40)){
   const item=document.createElement('article');item.className='dion-setting-row';item.style.cssText='display:block;overflow-wrap:anywhere;padding:12px 0';
   const title=document.createElement('strong');title.textContent=row.title;
   const id=document.createElement('div');id.className='dion-setting-desc';id.textContent=row.name;
   const details=document.createElement('p');details.className='dion-setting-desc';details.textContent=row.descriptions.join(' · ');
   const assignment=document.createElement('div');assignment.className='dion-setting-desc';assignment.textContent=t('exp.treatment')+': '+(row.assignment??'—')+' / ['+row.buckets.join(', ')+']';
   item.append(title,id,details,assignment);fragment.append(item);
  }
  results.replaceChildren(fragment);
  status.textContent=error?t(error):!data.available?t('exp.unavailable'):filtered.length?'':t('exp.empty');
  host.querySelector<HTMLElement>('[data-exp-count]')!.textContent=`${page+1} / ${pages} · ${filtered.length}`;
  host.querySelector<HTMLButtonElement>('[data-exp-page="-1"]')!.disabled=busy||page===0;
  host.querySelector<HTMLButtonElement>('[data-exp-page="1"]')!.disabled=busy||page+1>=pages;
 };
 const changed=():void=>{if(!active()||queued)return;queued=true;queueMicrotask(()=>{queued=false;if(active()){data=snapshot(store);render();}});};
 const refresh=():void=>{epoch++;operation?.abort();offStore();offStore=()=>{};store=undefined;data={available:false,experiments:[]};if(active()){store=discover();data=snapshot(store);offStore=watch(store,changed);}render();};
 const click=async(event:Event):Promise<void>=>{
  const button=event.target instanceof Element?event.target.closest<HTMLButtonElement>('button'):null;
  if(!button||button.disabled)return;
  if(button.hasAttribute('data-exp-expand')){event.preventDefault();event.stopPropagation();expanded=!expanded;button.setAttribute('aria-expanded',String(expanded));button.closest('.dion-plugin')?.classList.toggle('is-open',expanded);error='';refresh();return;}
  if(!host.contains(button)||!active())return;error='';
  if(button.hasAttribute('data-exp-refresh'))refresh();
  else if(button.dataset.expPage){page+=Number(button.dataset.expPage);render();}
  else if(button.hasAttribute('data-exp-native')){busy=true;const request=epoch;operation=new AbortController();render();const opened=await openNative(operation.signal);if(closed)return;operation=undefined;busy=false;if(request!==epoch){render();return;}if(active()&&opened)closeSettings();else{error='exp.native_unavailable';render();}}
 };
 const handler=(event:Event):void=>{void click(event);},search=():void=>{page=0;render();};
 root.addEventListener('click',handler);input.addEventListener('input',search);
 const off=subscribe(refresh),localeOff=onLocaleChange(()=>{error='';render();});refresh();
 return()=>{closed=true;operation?.abort();offStore();off();localeOff();root.removeEventListener('click',handler);input.removeEventListener('input',search);results.replaceChildren();};
}
