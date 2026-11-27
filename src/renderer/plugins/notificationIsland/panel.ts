import {h,messageHtml} from '../../i18n';
import {hideTooltip} from '../../ui/tooltip';
import {choice,searchUsers} from '../userActivity/discord';
import {KINDS,options,setOption,type Kind} from './settings';
let expanded=false;
export const isIslandExpanded=():boolean=>expanded;
const escape=(value:string):string=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]??c));
export const islandExpandHtml=():string=>`<button type="button" class="dion-icon-btn dion-expand-btn" data-ni-expand aria-expanded="${expanded}" aria-label="${h('island.menu')}" data-si18n-aria-label="island.menu"><svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m7.41 8.59 4.59 4.58 4.59-4.58L18 10l-6 6-6-6 1.41-1.41Z"/></svg></button>`;
const GROUPS:Array<[string,readonly Kind[]]>=[['island.messages',['mention','dm','reply','keyword']],['island.voice',['voiceJoin','voiceLeave','stream','call']],['island.syncord',['update','sp','badge','pluginError','friendSyncord']]];
const toggle=(key:string,checked:boolean,label:string):string=>`<label class="dion-setting-row"><span class="dion-setting-title">${messageHtml(label)}</span><span class="dion-switch"><input type="checkbox" role="switch" data-ni-option="${key}" ${checked?'checked':''} aria-label="${h(label)}" data-si18n-aria-label="${label}"><span class="dion-track" aria-hidden="true"></span></span></label>`;
const radio=(name:string,value:string,current:string,label:string):string=>`<label class="dion-setting-row"><span class="dion-setting-title">${messageHtml(label)}</span><input type="radio" name="ni-${name}" data-ni-option="${name}" value="${value}" ${current===value?'checked':''}></label>`;
function peopleHtml():string{
  const ids=options().voiceUsers;
  const rows=ids.map(id=>{const user=choice(id);return `<div class="dion-setting-row" data-ni-person="${escape(id)}"><span class="dion-setting-title">${escape(user?.name??id)}</span><button type="button" class="dion-icon-btn" data-ni-remove="${escape(id)}" aria-label="${h('island.remove')}">×</button></div>`;}).join('');
  return `<div data-ni-people>${rows}<input type="search" data-ni-search placeholder="${h('island.search')}" aria-label="${h('island.search')}"><div data-ni-results></div></div>`;
}
export function islandSectionHtml():string{
  const cfg=options();
  const groups=GROUPS.map(([title,kinds])=>`<details${title==='island.messages'?' open':''}><summary class="dion-setting-title">${messageHtml(title)}</summary>${kinds.map(kind=>toggle(kind,cfg.enabled[kind],'island.'+kind)).join('')}${title==='island.messages'?`<label class="dion-field-row"><span class="dion-setting-title">${messageHtml('island.keywords')}</span><input type="text" data-ni-option="keywords" value="${escape(cfg.keywords.join(', '))}" aria-label="${h('island.keywords')}"></label><p class="dion-setting-desc">${messageHtml('island.keywordsHint')}</p>`:''}${title==='island.voice'?`<p class="dion-setting-desc">${messageHtml('island.voiceMode')}</p>${radio('voiceMode','friends',cfg.voiceMode,'island.voiceFriends')}${radio('voiceMode','selected',cfg.voiceMode,'island.voiceSelected')}<div data-ni-people-wrap ${cfg.voiceMode==='selected'?'':'hidden'}>${peopleHtml()}</div>`:''}</details>`).join('');
  return `<div class="dion-plugin-details" data-ni-options><div class="dion-details-head"><h4>${messageHtml('island.name')}</h4></div>${toggle('silent',cfg.silent,'island.silent')}<label class="dion-field-row"><span class="dion-setting-title">${messageHtml('island.duration')}</span><input type="number" min="3" max="30" data-ni-option="duration" value="${cfg.duration}" aria-label="${h('island.duration')}"></label><p class="dion-setting-desc">${messageHtml('island.historyMode')}</p>${radio('historyMode','session',cfg.historyMode,'island.historySession')}${radio('historyMode','persistent',cfg.historyMode,'island.historyPersistent')}${groups}</div>`;
}
export function bindIslandPanel(root:HTMLElement):()=>void{
  // The plugin list is re-rendered (search, toggles), so the options block is looked up per event, never cached.
  const host=():HTMLElement|null=>root.querySelector<HTMLElement>('[data-ni-options]');
  const repaintPeople=():void=>{const wrap=host()?.querySelector('[data-ni-people-wrap]');if(wrap)wrap.innerHTML=peopleHtml();};
  const saveUsers=(list:string[]):void=>{setOption('voiceUsers',JSON.stringify([...new Set(list)].slice(0,50)));repaintPeople();};
  const click=(event:Event):void=>{
    const target=event.target instanceof Element?event.target:null;if(!target)return;
    const expand=target.closest('[data-ni-expand]');
    if(expand){event.preventDefault();event.stopPropagation();hideTooltip();expanded=!expanded;expand.setAttribute('aria-expanded',String(expanded));expand.closest('.dion-plugin')?.classList.toggle('is-open',expanded);return;}
    const pick=target.closest<HTMLElement>('[data-ni-pick]');if(pick){saveUsers([...options().voiceUsers,pick.dataset.niPick??'']);return;}
    const remove=target.closest<HTMLElement>('[data-ni-remove]');if(remove)saveUsers(options().voiceUsers.filter(id=>id!==remove.dataset.niRemove));
  };
  const input=(event:Event):void=>{
    const field=event.target;if(!(field instanceof HTMLInputElement)||!field.closest('[data-ni-options]'))return;
    if(field.dataset.niOption==='keywords'){setOption('keywords',field.value.slice(0,500));return;}
    if(!field.hasAttribute('data-ni-search'))return;
    const results=field.parentElement?.querySelector('[data-ni-results]');if(!results)return;
    const users=field.value.trim()?searchUsers(field.value,new Set(options().voiceUsers)).slice(0,8):[];
    results.innerHTML=users.length?users.map(user=>`<button type="button" class="dion-setting-row" data-ni-pick="${escape(user.id)}">${escape(user.name)} · ${escape(user.username)}</button>`).join(''):field.value.trim()?`<p class="dion-setting-desc">${messageHtml('island.noUsers')}</p>`:'';
  };
  const change=(event:Event):void=>{
    const field=event.target;if(!(field instanceof HTMLInputElement)||!field.closest('[data-ni-options]'))return;const key=field.dataset.niOption;if(!key)return;
    if((KINDS as readonly string[]).includes(key)||key==='silent')setOption(key as Kind,field.checked);
    else if(key==='duration'){if(Number.isFinite(Number(field.value)))setOption('duration',Number(field.value));field.value=String(options().duration);}
    else if(key==='keywords')setOption('keywords',field.value.slice(0,500));
    else if((key==='voiceMode'||key==='historyMode')&&field.checked){setOption(key,field.value);if(key==='voiceMode'){const wrap=host()?.querySelector<HTMLElement>('[data-ni-people-wrap]');if(wrap)wrap.hidden=field.value!=='selected';}}
  };
  root.addEventListener('click',click);root.addEventListener('input',input);root.addEventListener('change',change);
  return()=>{root.removeEventListener('click',click);root.removeEventListener('input',input);root.removeEventListener('change',change);};
}
