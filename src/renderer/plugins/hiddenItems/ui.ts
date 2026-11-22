import { h, messageHtml as i18nHtml, setLocalizedAttribute, setLocalizedHtml, t as i18nText } from "../../i18n";
import {showToast,ToastType} from '../../ui/toast';
import {accountId,hiddenEntries,setHidden,restoreAll,HIDDEN_EVENT,nativeStore,type HiddenEntry} from './settings';
import {validId,type HiddenKind} from './model';
export const category=(kind:HiddenKind):string=>kind==='guild'?i18nText("ui.server"):kind==='dm'?'DM':i18nText("ui.group");
let closeDialog:(()=>void)|undefined;
export const CSS=`
[data-syncord-hidden-eye]{display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;color:var(--interactive-normal,#949ba4);width:24px;height:24px;padding:2px;margin-left:4px;flex-shrink:0;cursor:pointer;border-radius:4px}
[data-syncord-hidden-eye]{opacity:0;pointer-events:none}
.Syncord-hidden-heading:hover [data-syncord-hidden-eye],.Syncord-hidden-heading:focus-within [data-syncord-hidden-eye]{opacity:1;pointer-events:auto}
[data-syncord-hidden-eye]:hover{color:var(--interactive-hover,#fff);background:var(--background-modifier-hover,#35373c)}
[data-syncord-hidden-eye]:focus-visible{outline:2px solid var(--focus-primary,#00a8fc)}
.Syncord-hidden-dialog{box-sizing:border-box;width:min(620px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto;padding:20px;border:1px solid var(--border-subtle,#404249);border-radius:12px;background:var(--background-primary,#1e1f22);color:var(--text-normal,#f2f3f5);font:14px/1.5 var(--font-primary,system-ui)}
.Syncord-hidden-dialog::backdrop{background:#0009}.Syncord-hidden-dialog header{display:flex;align-items:center;justify-content:space-between;gap:12px}.Syncord-hidden-dialog h2{margin:0;font-size:20px}
.Syncord-hidden-dialog button,.Syncord-hidden-manager button{font:inherit;background:var(--background-secondary,#2b2d31);color:inherit;border:1px solid var(--border-subtle,#404249);border-radius:6px;padding:6px 10px;cursor:pointer}
.Syncord-hidden-manager{min-width:0;color:var(--text-normal,#f2f3f5);font:14px/1.5 var(--font-primary,system-ui)}
.Syncord-hidden-manager input,.Syncord-hidden-manager select{box-sizing:border-box;min-width:0;max-width:100%;font:inherit;background:var(--background-secondary,#2b2d31);color:inherit;border:1px solid var(--border-subtle,#404249);border-radius:6px;padding:7px 9px}
.Syncord-hidden-tools,.Syncord-hidden-add{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.Syncord-hidden-tools input,.Syncord-hidden-add input{flex:1 1 140px;width:0}.Syncord-hidden-tools button{margin-left:auto}
.Syncord-hidden-list{max-height:340px;overflow:auto;margin:0;padding:0;list-style:none}.Syncord-hidden-list li{display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--border-subtle,#35373c);padding:9px 0;min-width:0}.Syncord-hidden-list .copy{flex:1;min-width:0;overflow-wrap:anywhere}.Syncord-hidden-list small,.Syncord-hidden-manager p{color:var(--text-muted,#949ba4)}.Syncord-hidden-list small{display:block}.Syncord-hidden-list button{flex-shrink:0}
`;
export function changedAccount():void{showToast(i18nText("ui.your_discord_account_changed_reopen_the_menu_and_try_again"),{type:ToastType.FAILURE});}
export function restore(entry:HiddenEntry,account:string|undefined):void{if(!setHidden(entry.kind,entry.id,false,account))changedAccount();}
export function mountManager(host:HTMLElement,add?:(kind:HiddenKind,id:string,account:string|undefined)=>void):()=>void {
  host.classList.add('Syncord-hidden-manager');
  setLocalizedHtml(host, `<p>${i18nHtml("ui.hidden_items_are_saved_locally_for_this_account_hiding_changes_navigat")}</p><div class="Syncord-hidden-tools"><input type="search" aria-label="${h("ui.search_hidden_items")}" placeholder="${h("ui.search_hidden_items")}" data-si18n-aria-label="ui.search_hidden_items" data-si18n-placeholder="ui.search_hidden_items"><select aria-label="${h("ui.hidden_item_type")}" data-si18n-aria-label="ui.hidden_item_type"><option value="all">${i18nHtml("ui.all")}</option><option value="guild">${i18nHtml("ui.servers")}</option><option value="dm">${i18nHtml("ui.dms")}</option><option value="group">${i18nHtml("ui.groups")}</option></select><button type="button" data-restore-all>${i18nHtml("ui.show_all")}</button></div><p role="status" data-hidden-count></p><ul class="Syncord-hidden-list"></ul><button type="button" data-hidden-more hidden>${i18nHtml("ui.show_more")}</button>`);
  const search=host.querySelector<HTMLInputElement>('input')!,filter=host.querySelector<HTMLSelectElement>('select')!,all=host.querySelector<HTMLButtonElement>('[data-restore-all]')!,list=host.querySelector<HTMLUListElement>('ul')!,more=host.querySelector<HTMLButtonElement>('[data-hidden-more]')!;
  let limit=50,renderedAccount=accountId();const render=():void=>{
    const entries=hiddenEntries(),account=accountId(),query=search.value.toLocaleLowerCase();
    if(account!==renderedAccount){const draft=host.querySelector<HTMLInputElement>('.Syncord-hidden-add input');if(draft)draft.value="";}renderedAccount=account;
    const visible=entries.filter(e=>(filter.value==='all'||e.kind===filter.value)&&`${e.name} ${e.id}`.toLocaleLowerCase().includes(query));
    const oldScroll=list.scrollTop;list.replaceChildren();
    host.querySelector('[data-hidden-count]')!.textContent=account?i18nText("ui.value_hidden_value_matching", {v0: entries.length, v1: visible.length}):i18nText("ui.sign_in_to_manage_hidden_items");all.disabled=!account||!entries.length;
    for(const entry of visible.slice(0,limit)){
      const li=document.createElement('li'),copy=document.createElement('span'),name=document.createElement('span'),meta=document.createElement('small'),button=document.createElement('button');
      copy.className='copy';name.textContent=entry.name;meta.textContent=`${category(entry.kind)} · ${entry.id}`;copy.append(name,meta);
      button.type='button';button.textContent=i18nText("ui.show");setLocalizedAttribute(button, 'aria-label', "ui.show_value_value", {v0: category(entry.kind), v1: entry.name});button.dataset.hiddenId=entry.id;button.addEventListener('click',()=>restore(entry,account));li.append(copy,button);list.append(li);
    }
    if(!visible.length){const empty=document.createElement('li');empty.textContent=entries.length?i18nText("ui.no_matching_hidden_items"):i18nText("ui.nothing_is_hidden");list.append(empty);}
    more.hidden=visible.length<=limit;list.scrollTop=oldScroll;
  };
  const reset=():void=>{limit=50;render();};search.addEventListener('input',reset);filter.addEventListener('change',reset);more.addEventListener('click',()=>{limit+=50;render();});
  all.addEventListener('click',()=>{if(!restoreAll(renderedAccount))changedAccount();});
  if(add){
    const form=document.createElement('form');form.className='Syncord-hidden-add';setLocalizedHtml(form, `<select aria-label="${h("ui.item_to_hide")}" data-si18n-aria-label="ui.item_to_hide"><option value="guild">${i18nHtml("ui.server")}</option><option value="dm">${i18nHtml("ui.dm")}</option><option value="group">${i18nHtml("ui.group")}</option></select><input aria-label="${h("ui.server_or_channel_id")}" placeholder="${h("ui.server_or_channel_id")}" inputmode="numeric" required data-si18n-aria-label="ui.server_or_channel_id" data-si18n-placeholder="ui.server_or_channel_id"><button type="submit">${i18nHtml("ui.hide")}</button>`);
    form.addEventListener('submit',event=>{event.preventDefault();const input=form.querySelector('input')!;if(!validId(input.value.trim())){showToast(i18nText("ui.enter_a_valid_server_or_channel_id"),{type:ToastType.FAILURE});return;}add(form.querySelector('select')!.value as HiddenKind,input.value.trim(),renderedAccount);});host.append(form);
  }
  const onChange=():void=>render();
  const users=nativeStore<{addChangeListener?:(fn:()=>void)=>void;removeChangeListener?:(fn:()=>void)=>void}>('UserStore');
  const accountChange=():void=>{if(accountId()!==renderedAccount)render();};users?.addChangeListener?.(accountChange);
  window.addEventListener(HIDDEN_EVENT,onChange);render();
  return()=>{window.removeEventListener(HIDDEN_EVENT,onChange);users?.removeChangeListener?.(accountChange);host.replaceChildren();};
}
export function closeRestoreUi():void {
  closeDialog?.();
}
export function openManager(add?:(kind:HiddenKind,id:string,account:string|undefined)=>void):void {
  closeDialog?.();const previous=document.activeElement,dialog=document.createElement('dialog');dialog.className='Syncord-hidden-dialog';setLocalizedAttribute(dialog, 'aria-label', "ui.hidden_items");
  setLocalizedHtml(dialog, `<header><h2>${i18nHtml("ui.hidden_items")}</h2><button type="button" aria-label="${h("ui.close_hidden_items")}" data-si18n-aria-label="ui.close_hidden_items">×</button></header><div data-manager></div>`);
  document.body.append(dialog);const dispose=mountManager(dialog.querySelector<HTMLElement>('[data-manager]')!,add);
  const close=():void=>{dispose();dialog.close();dialog.remove();closeDialog=undefined;if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};closeDialog=close;
  dialog.querySelector('header button')!.addEventListener('click',close);dialog.addEventListener('cancel',event=>{event.preventDefault();close();});dialog.showModal();
}
