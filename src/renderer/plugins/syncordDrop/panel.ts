import {h,messageHtml as html,t} from '../../i18n';
import {settings} from '../../api/settings';
let expanded=false;
export const isDropExpanded=():boolean=>expanded;
export const dropExpandHtml=():string=>`<button type="button" class="dion-icon-btn dion-expand" data-drop-expand aria-expanded="${expanded}" aria-label="${h('drop.description')}" data-si18n-aria-label="drop.description">⌄</button>`;
export const dropSectionHtml=():string=>`<div class="dion-plugin-details"><p class="dion-setting-desc">${html('drop.limits')}</p>${(['menu','incoming'] as const).map(key=>`<label class="dion-setting-row"><span class="dion-setting-copy"><span class="dion-setting-title">${html('drop.setting_'+key)}</span></span><span class="dion-switch"><input type="checkbox" role="switch" data-drop-setting="${key}" aria-label="${h('drop.setting_'+key)}" data-si18n-aria-label="drop.setting_${key}" ${settings.get<boolean>('plugins.syncord-drop.data.'+key,true)!==false?'checked':''}><span class="dion-track" aria-hidden="true"></span></span></label>`).join('')}<p class="dion-setting-desc">${html('drop.privacy')}</p></div>`;
export function bindDropPanel(root:HTMLElement):()=>void{
 const click=(e:Event):void=>{const target=e.target instanceof Element?e.target.closest<HTMLButtonElement>('[data-drop-expand]'):null;if(!target)return;e.preventDefault();expanded=!expanded;target.setAttribute('aria-expanded',String(expanded));target.closest('.dion-plugin')?.classList.toggle('is-open',expanded);};
 const change=(e:Event):void=>{const target=e.target;if(!(target instanceof HTMLInputElement)||!['menu','incoming'].includes(target.dataset.dropSetting??''))return;settings.set('plugins.syncord-drop.data.'+target.dataset.dropSetting,target.checked);};
 root.addEventListener('click',click);root.addEventListener('change',change);return()=>{root.removeEventListener('click',click);root.removeEventListener('change',change);};
}
