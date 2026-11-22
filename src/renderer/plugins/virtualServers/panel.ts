import {h,messageHtml as html,t} from '../../i18n';
import {trialService} from './service';
import {accountId,store,type FluxStore} from './discord';
export const VIRTUAL_PANEL_CSS=`
#Syncord-settings-root [data-virtual-editor] button[hidden]{display:none}
#Syncord-settings-root [data-virtual-editor]{display:flex;flex-direction:column;gap:14px}
#Syncord-settings-root [data-virtual-editor] label{display:flex;flex-direction:column;gap:8px;max-width:420px;font-weight:600}
#Syncord-settings-root [data-virtual-editor] input{box-sizing:border-box;width:100%;min-width:0;background:var(--background-base-lowest,#17181c);color:var(--text-default,#f2f3f5);border:1px solid var(--border-subtle,#41434a);border-radius:9px;padding:10px 12px;font:inherit;outline:none}
#Syncord-settings-root [data-virtual-editor] input:focus-visible{border-color:var(--brand-500,#5865f2);box-shadow:0 0 0 2px color-mix(in srgb,var(--brand-500,#5865f2) 25%,transparent)}
#Syncord-settings-root [data-virtual-editor] [data-virtual-actions]{display:flex;flex-wrap:wrap;gap:8px}
#Syncord-settings-root [data-virtual-editor] button:not(.dion-expand){border:0;border-radius:8px;padding:9px 14px;background:var(--background-modifier-selected,#383a42);color:var(--text-default,#f2f3f5);font:inherit;font-size:14px;font-weight:600;cursor:pointer}
#Syncord-settings-root [data-virtual-editor] [data-virtual-save]{background:var(--brand-500,#5865f2);color:white}
#Syncord-settings-root [data-virtual-editor] button:hover{filter:brightness(1.1)}
#Syncord-settings-root [data-virtual-editor] button:focus-visible{outline:2px solid var(--focus-primary,#00a8fc);outline-offset:2px}
`;
let expanded=false;
export const isVirtualExpanded=():boolean=>expanded;
export function virtualExpandHtml():string {return `<button type="button" class="dion-icon-btn dion-expand" data-virtual-expand aria-expanded="${expanded}" aria-label="${h('virtual.trial')}"><svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m7.41 8.59 4.59 4.58 4.59-4.58L18 10l-6 6-6-6 1.41-1.41Z"/></svg></button>`;}
const escape=(text:string):string=>text.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
export function virtualSectionHtml():string {
 const value=trialService()?.read();
 return `<div class="dion-plugin-details" data-virtual-editor><p class="dion-setting-desc">${html('virtual.hint')}</p><label>${html('virtual.name')}<input data-virtual-field="name" type="text" maxlength="48" aria-label="${h('virtual.name')}" value="${escape(value?.name??'')}"></label><div data-virtual-actions><button type="button" data-virtual-save>${value?html('ui.save'):html('virtual.create')}</button><button type="button" data-virtual-open ${value?'':'hidden'}>${html('virtual.open')}</button><button type="button" data-virtual-delete ${value?'':'hidden'}>${html('ui.delete')}</button></div><p class="dion-setting-desc" data-virtual-status role="status"></p></div>`;
}
export function bindVirtualPanel(root:HTMLElement,onOpen:()=>void=()=>{}):()=>void {
 if(!root.querySelector('[data-virtual-editor]'))return()=>{};
 const controller=new AbortController();let account=accountId();
 const clearAccount=():void=>{const next=accountId();if(next===account)return;account=next;for(const field of root.querySelectorAll<HTMLInputElement>('[data-virtual-field]'))field.value='';for(const status of root.querySelectorAll<HTMLElement>('[data-virtual-status]'))status.textContent=t('virtual.notReady');for(const button of root.querySelectorAll<HTMLButtonElement>('[data-virtual-open],[data-virtual-delete]'))button.hidden=true;};
 const users=store<FluxStore>('UserStore');users?.addChangeListener?.(clearAccount);
 root.addEventListener('click',event=>{
  if(account!==accountId()){clearAccount();return;}
  const target=event.target;if(!(target instanceof Element))return;
  const expand=target.closest('[data-virtual-expand]');if(expand){expanded=!expanded;expand.setAttribute('aria-expanded',String(expanded));expand.closest('.dion-plugin')?.classList.toggle('is-open',expanded);return;}
  const editor=target.closest<HTMLElement>('[data-virtual-editor]');if(!editor)return;
  const status=editor.querySelector<HTMLElement>('[data-virtual-status]'),service=trialService();
  const report=(key:string):void=>{if(status)status.textContent=t(key);};
  if(!service){report('virtual.notReady');return;}
  if(target.closest('[data-virtual-save]')){
   const value=editor.querySelector<HTMLInputElement>('input')?.value.trim()??'';
   if(!service.save(value)){report('virtual.invalid');return;}
   for(const button of editor.querySelectorAll<HTMLButtonElement>('[data-virtual-open],[data-virtual-delete]'))button.hidden=false;
   const button=editor.querySelector('[data-virtual-save]');if(button)button.textContent=t('ui.save');
   if(service.open()){onOpen();return;}report('virtual.savedOpen');
  }else if(target.closest('[data-virtual-open]')){if(service.open())onOpen();else report('virtual.notReady');}
  else if(target.closest('[data-virtual-delete]')){service.clear();for(const field of editor.querySelectorAll<HTMLInputElement>('input'))field.value='';for(const button of editor.querySelectorAll<HTMLButtonElement>('[data-virtual-open],[data-virtual-delete]'))button.hidden=true;const button=editor.querySelector('[data-virtual-save]');if(button)button.textContent=t('virtual.create');report('ui.saved');}
 },{signal:controller.signal});
 return()=>{controller.abort();users?.removeChangeListener?.(clearAccount);};
}
