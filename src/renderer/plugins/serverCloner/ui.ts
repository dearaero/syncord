import {t,onLocaleChange,getDirection} from '../../i18n';
import {CloneError,plan,type Issue} from './model';
import {openSettings,targetSupports} from './discord';
import type {CloneSession} from './state';
const message=(error:unknown):string=>t('clone.'+(error instanceof CloneError?error.code:'failed'));
function node<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string):HTMLElementTagNameMap[K]{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;}
export function openStudio(session:CloneSession,cancel:()=>void):()=>void {
 const dialog=node('dialog');dialog.className='Syncord-server-cloner';dialog.id='Syncord-server-cloner';
 const events=new AbortController();let viewEvents=new AbortController(),closed=false,error='',target=session.targetId??'',confirmed=false,renderedActive=false,renderedResult=false;
 let localeOff=():void=>{},stateOff=():void=>{};
 const hide=():void=>{if(closed)return;closed=true;events.abort();viewEvents.abort();localeOff();stateOff();dialog.close();dialog.remove();};
 const failure=(errorValue:unknown):void=>{if(!closed){error=message(errorValue);render();}};
 const action=(label:string,run:()=>unknown,primary=false):HTMLButtonElement=>{
  const button=node('button',label);button.type='button';if(primary)button.dataset.primary='';
  button.addEventListener('click',()=>{if(closed)return;try{session.guard();void Promise.resolve(run()).catch(failure);}catch(errorValue){failure(errorValue);}},{signal:viewEvents.signal});return button;
 };
 const stats=(roles:string,categories:string,channels:string):HTMLElement=>{const list=node('dl');for(const [key,value]of [['roles',roles],['categories',categories],['channels',channels]])list.append(node('dt',t('clone.'+key)),node('dd',value));return list;};
 const issues=(rows:readonly Issue[]):HTMLElement=>{
  const detail=node('details');detail.append(node('summary',t('clone.remaining')));
  detail.addEventListener('toggle',()=>{if(!detail.open||detail.childElementCount>1)return;const list=node('ul');for(const row of rows)list.append(node('li',row.item+' — '+t('clone.'+row.code)));detail.append(list);},{signal:viewEvents.signal});return detail;
 };
 const paint=():void=>{
  if(closed)return;const progress=session.progress(),status=dialog.querySelector('[data-clone-status]'),counts=dialog.querySelector('[data-clone-counts]');
  if(status)status.textContent=(progress.phase==='stopping'?t('ui.stopping_after_the_current_request'):t('clone.'+progress.phase))+(progress.item?' · '+progress.item:'');
  if(counts)counts.textContent=[t('clone.roles')+': '+progress.roles,t('clone.categories')+': '+progress.categories,t('clone.channels')+': '+progress.channels].join(' · ');
  const stop=dialog.querySelector<HTMLButtonElement>('[data-clone-stop]');if(stop)stop.disabled=progress.phase==='stopping';
 };
 const render=():void=>{
  if(closed)return;session.guard();viewEvents.abort();viewEvents=new AbortController();dialog.dir=getDirection();dialog.replaceChildren();
  const source=session.source,progress=session.progress(),active=session.active();renderedActive=active;renderedResult=!!progress.result;
  const header=node('header');header.append(node('h2',t('clone.name')),action(t('ui.close'),hide));dialog.append(header);
  dialog.append(node('small',t('clone.source')),node('p',source.name),stats(String(source.roles.filter(r=>r.id!==source.id&&!r.managed).length),String(source.channels.filter(c=>c.type===4).length),String(source.channels.filter(c=>c.type!==4).length)));
  dialog.append(node('p',t('clone.guide')),node('small',t('clone.cache')));
  const label=node('label',t('clone.target')),select=node('select');select.id='Syncord-clone-target';label.htmlFor=select.id;select.disabled=session.started();select.append(node('option',t('clone.target')));select.options[0]!.value='';
  const targets=session.targets();for(const guild of targets){const option=node('option',guild.name);option.value=guild.id;select.append(option);}select.value=target;
  select.addEventListener('change',()=>{target=select.value;confirmed=false;render();dialog.querySelector<HTMLSelectElement>('select')?.focus();},{signal:viewEvents.signal});
  dialog.append(label,select,node('small',t('clone.targetHint')),node('p',t('clone.appendNotice')));
  const chosen=targets.find(g=>g.id===target),confirmation=node('label'),checkbox=node('input');checkbox.type='checkbox';checkbox.checked=confirmed;checkbox.disabled=!chosen||session.started();
  confirmation.append(checkbox,node('span',t('clone.confirm',{target:chosen?.name??''})));dialog.append(confirmation);
  const start=action(t('clone.run'),()=>{if(!confirmed||!chosen||chosen.id!==target)throw new CloneError('invalid');error='';return session.run(target);},true);start.disabled=!confirmed||!chosen||session.started();
  checkbox.addEventListener('change',()=>{confirmed=checkbox.checked;start.disabled=!confirmed||!chosen||session.started();},{signal:viewEvents.signal});
  const nav=node('nav'),refresh=action(t('ui.refresh'),()=>{confirmed=false;render();});refresh.disabled=active;nav.append(start,refresh);
  if(chosen){for(const section of ['ROLES','CHANNELS'] as const){const button=action(t(section==='ROLES'?'clone.roles':'clone.channels'),async()=>{await openSettings(target,section);hide();});button.disabled=active;nav.append(button);}}
  dialog.append(nav);
  const status=node('p');status.dataset.cloneStatus='';status.setAttribute('role','status');const counts=node('small');counts.dataset.cloneCounts='';dialog.append(status,counts);
  if(error){const alert=node('p',error);alert.setAttribute('role','alert');dialog.append(alert);}
  if(progress.result){const result=progress.result;dialog.append(node('h3',t('clone.report')),stats(result.roles+'/'+source.roles.filter(r=>!r.managed).length,result.categories+'/'+source.channels.filter(c=>c.type===4).length,result.channels+'/'+source.channels.filter(c=>c.type!==4).length),issues(result.issues));}
  else{const pending=[...plan(source),...progress.issues];if(chosen)for(const c of source.channels)if(!targetSupports(chosen.id,c.type))pending.push({code:'unsupported',item:c.name});dialog.append(issues(pending));}
  const structure=node('details');structure.append(node('summary',t('clone.report')));
  structure.addEventListener('toggle',()=>{
   if(!structure.open||structure.childElementCount>1)return;
   // Render the detailed read-only plan only on demand, not on each store event.
   const roleNames=new Map(source.roles.map(r=>[r.id,r.name]));
   const channelNames=new Map(source.channels.map(c=>[c.id,c.name]));
   const types:Record<number,string>={0:'text',2:'voice',4:'category',5:'announcement',13:'stage',15:'forum',16:'media'};
   for(const channel of source.channels){
    const item=node('details');item.append(node('summary',channel.name+' · '+t('clone.'+(types[channel.type]??'other'))+(channel.parent?' · '+(channelNames.get(channel.parent)??channel.parent):'')));
    item.append(node('small',t('clone.position')+': '+channel.position));
    if(typeof channel.settings.topic==='string')item.append(node('small',t('clone.topic')),node('p',channel.settings.topic));
    const permissions=node('dl');permissions.setAttribute('aria-label',t('clone.permissionLabel'));
    for(const row of channel.overwrites)permissions.append(node('dt',row.type===0?roleNames.get(row.id)??row.id:row.id),node('dd','+ '+row.allow+' / − '+row.deny));
    item.append(permissions);structure.append(item);
   }
   const data={roles:source.roles,channels:source.channels.map(c=>({...c,overwrites:c.overwrites.map(row=>({...row,role:row.type===0?roleNames.get(row.id)??null:null})),targetId:progress.result?.channelIds.get(c.id)??null}))};
   structure.append(node('pre',JSON.stringify(data,null,2)));
  },{signal:viewEvents.signal});dialog.append(structure);  const footer=node('footer');if(active){const stop=action(t('ui.stop'),()=>session.stop());stop.dataset.cloneStop='';footer.append(stop);}else footer.append(action(t('ui.cancel'),()=>{hide();cancel();}));dialog.append(footer);paint();
 };
 dialog.addEventListener('cancel',event=>{event.preventDefault();hide();},{signal:events.signal});
 localeOff=onLocaleChange(()=>{try{render();}catch{hide();}});
 stateOff=session.subscribe(()=>{if(closed)return;if(renderedActive!==session.active()||renderedResult!==!!session.progress().result)render();else paint();});
 try{render();document.body.append(dialog);dialog.showModal();}catch(error){hide();throw error;}return hide;
}
export const cloneErrorMessage=message;
