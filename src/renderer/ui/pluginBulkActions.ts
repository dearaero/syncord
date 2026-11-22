import {css} from '../api/css';
import {applyBulkPlugins,hasPreviousPluginState,onPluginOperationChange,pluginOperationBusy,pluginsNeedRestart} from '../api/plugin/bulk';
import {messageHtml,onLocaleChange,setLocalizedHtml,setLocalizedText,t} from '../i18n';
import {bindTooltip,hideTooltip} from './tooltip';

export function mountPluginBulkActions(host:HTMLElement,root:HTMLElement,onApplied:()=>void):{refresh:()=>void;dispose:()=>void}{
 const offStyle=css.inject('plugin-bulk-actions',`
 #Syncord-settings-root .dion-plugin-bulk{margin-bottom:18px;display:grid;gap:9px}
 #Syncord-settings-root .dion-plugin-bulk[hidden]{display:none!important}
 #Syncord-settings-root .dion-plugin-bulk-actions{display:flex;flex-wrap:wrap;gap:8px}
 #Syncord-settings-root .dion-plugin-bulk button{min-height:36px;padding:8px 12px;border:1px solid var(--background-modifier-accent,rgba(128,128,128,.2));border-radius:9px;background:var(--background-secondary,#25262d);color:var(--text-normal,#eee);font:600 12px var(--font-primary,system-ui);cursor:pointer;transition:background-color 160ms ease,border-color 160ms ease}
 #Syncord-settings-root .dion-plugin-bulk button:hover:not(:disabled){background:var(--background-modifier-hover,rgba(128,128,128,.16))}
 #Syncord-settings-root .dion-plugin-bulk button:active:not(:disabled){background:var(--background-modifier-active,rgba(128,128,128,.22))}
 #Syncord-settings-root .dion-plugin-bulk button:focus-visible{outline:2px solid var(--brand-500,#5865f2);outline-offset:3px}
 #Syncord-settings-root .dion-plugin-bulk button:disabled{opacity:.45;cursor:default}
 #Syncord-settings-root .dion-plugin-bulk p{margin:0;color:var(--text-muted,#999);font-size:12px;line-height:1.5;overflow-wrap:anywhere}
 #Syncord-settings-root .dion-plugin-bulk [data-bulk-status]:empty{display:none}
 @media(prefers-reduced-motion:reduce){#Syncord-settings-root .dion-plugin-bulk button{transition:none}}
 `);
 host.classList.add('dion-plugin-bulk');
 setLocalizedHtml(host,`<div class="dion-plugin-bulk-actions" role="group" aria-describedby="dion-plugin-bulk-hint"><button type="button" data-plugin-bulk="disable">${messageHtml('pluginsBulk.off')}</button><button type="button" data-plugin-bulk="enable">${messageHtml('pluginsBulk.on')}</button><button type="button" data-plugin-bulk="restore">${messageHtml('pluginsBulk.restore')}</button></div><p id="dion-plugin-bulk-hint">${messageHtml('pluginsBulk.hint')}</p><p data-bulk-status role="status" aria-live="polite"></p>`);
 let closed=false,wasBusy=pluginOperationBusy(),message='';
 const status=host.querySelector<HTMLElement>('[data-bulk-status]');
 const paint=():void=>{
  if(closed)return;
  const busy=pluginOperationBusy(),finished=wasBusy&&!busy;wasBusy=busy;
  host.setAttribute('aria-busy',String(busy));
  for(const button of host.querySelectorAll<HTMLButtonElement>('button'))button.disabled=busy||(button.dataset.pluginBulk==='restore'&&!hasPreviousPluginState());
  for(const input of root.querySelectorAll<HTMLInputElement>('input[data-dion-plugin]'))input.disabled=busy;
  const key=busy?'pluginsBulk.busy':message==='pluginsBulk.failed'||message==='pluginsBulk.partial'?message:pluginsNeedRestart()?'pluginsBulk.restart':message;
  if(status){if(key)setLocalizedText(status,key);else status.textContent='';}
  if(finished)onApplied();
 };
 const click=(event:Event):void=>{
  const button=event.target instanceof Element?event.target.closest<HTMLButtonElement>('button[data-plugin-bulk]'):null;
  const action=button?.dataset.pluginBulk;if(!button||button.disabled||!['enable','disable','restore'].includes(action??''))return;
  hideTooltip();message='';
  void applyBulkPlugins(action as 'enable'|'disable'|'restore').then(result=>{message=result.incomplete.length?'pluginsBulk.partial':'pluginsBulk.done';}).catch(()=>{message='pluginsBulk.failed';}).finally(paint);
 };
 host.addEventListener('click',click);
 const tooltips=[...host.querySelectorAll<HTMLButtonElement>('button')].map(button=>bindTooltip(button,()=>t(button.dataset.pluginBulk==='restore'?'pluginsBulk.hint':button.dataset.pluginBulk==='enable'?'pluginsBulk.on':'pluginsBulk.off'),{position:'bottom'}));
 const off=onPluginOperationChange(paint),locale=onLocaleChange(paint);paint();
 return {refresh:paint,dispose(){closed=true;off();locale();host.removeEventListener('click',click);for(const undo of tooltips)undo();offStyle();host.replaceChildren();}};
}
