import {SUPPORTER_CSS} from './supporterStyle';
import {t,h,number,localizeError,getLocale} from '../../i18n';
import {hydrateBadgeImages} from './images';
import {ECOSYSTEM_CHANGED} from '../../../shared/ecosystem';
import {MAX_CUSTOM_BADGE_INPUT,badgeInput,type SupporterBridge,type SupporterStatus,type CustomBadge,type BadgeMutation} from '../../../shared/supporter';
const escape=(value:string):string=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const label=(key:string):string=>escape(t('supporter.'+key));
/** One owned section inside My Badges; no website, global observer or idle polling. */
export function createSupporterView(account:string,bridge:SupporterBridge,accountValid:()=>boolean,art?:((image:string)=>Promise<string>)):{attach:(host:Element)=>void;detach:()=>void;dispose:()=>void} {
 const root=document.createElement('section');root.className='eco-supporter';
 let disposed=false,busy=false,loaded=false,lastRefresh=0,epoch=0,locale=getLocale(),status:SupporterStatus|undefined,selected:string|undefined,editing=false;
 let name='',description='',bytes:Uint8Array|undefined,blob='',fileName='',notice='',error=false,deleteConfirm=false;
 const previews=new Map<string,string>(),keys=new Map<string,string>();
 const alive=():boolean=>!disposed&&accountValid();
 const current=():CustomBadge|undefined=>status?.badges.find(b=>b.id===selected);
 const key=(value:unknown):string=>{const signature=JSON.stringify(value);if(!keys.has(signature))keys.set(signature,crypto.randomUUID());while(keys.size>128)keys.delete(keys.keys().next().value!);return keys.get(signature)!;};
 const mutation=(b:CustomBadge,action:string):BadgeMutation=>({id:b.id,revision:b.revision,key:key([action,b.id,b.revision,name,description])});
 const resetFile=():void=>{bytes=undefined;fileName='';if(blob)URL.revokeObjectURL(blob);blob='';};
 const setStatus=(value:SupporterStatus):void=>{status=value;loaded=true;if(selected){const b=current();if(b){name=b.name;description=b.description;}else{selected=undefined;editing=false;}}};
 const changed=(id=account):void=>{if(alive())window.dispatchEvent(new CustomEvent(ECOSYSTEM_CHANGED,{detail:{id}}));};
 async function run(work:()=>Promise<void>):Promise<void>{if(busy||!alive()||!root.isConnected)return;busy=true;notice='';error=false;const token=++epoch;paint();try{await work();if(alive()&&token===epoch)keys.clear();}catch(e){if(alive()&&token===epoch){const message=e instanceof Error?e.message:'';notice=/^supporter\.[A-Za-z]+$/.test(message)?t(message):e instanceof Error?localizeError(e):t('supporter.invalid');error=true;}}finally{if(alive()&&token===epoch){busy=false;paint();}}}
 async function refresh():Promise<void>{lastRefresh=Date.now();const value=await bridge.status(account);if(!alive())return;setStatus(value);}

 async function preview(b:CustomBadge):Promise<void>{const cacheKey=b.image;if(!cacheKey||previews.has(cacheKey))return;try{const data=await bridge.preview(account,b.id);if(!alive()||typeof data!=='string'||!data.startsWith('data:image/png;base64,')||data.length>90000)return;previews.set(cacheKey,data);while(previews.size>12)previews.delete(previews.keys().next().value!);if(current()?.id===b.id&&current()?.image===b.image&&!blob){const target=root.querySelector('[data-sup-preview="user"]');if(target){const template=document.createElement('template');template.innerHTML=previewHtml(data);target.replaceWith(template.content);const sizes=root.querySelector('[data-sup-sizes]');if(sizes){const sizeTemplate=document.createElement('template');sizeTemplate.innerHTML=sizesHtml(data);sizes.replaceWith(sizeTemplate.content);}}}}catch{/* A preview grants no authority. */}}
 const previewHtml=(data:string):string=>`<div data-sup-preview="user" class="sup-preview" aria-label="${h('supporter.preview')}">${data?`<img src="${escape(data)}" width="40" height="40" alt="">`:'◇'}</div>`;
 const sizesHtml=(data:string):string=>`<div data-sup-sizes class="sup-size-preview">${[16,20,24,32].map(size=>`<span>${data?`<img src="${escape(data)}" width="${size}" height="${size}" alt="">`:'—'}<small>${number(size)} px</small></span>`).join('')}</div>`;
 function paint():void{
  if(!alive())return;
  root.setAttribute('aria-busy',String(busy));
  const b=current(),can=!!status&&status.tier>0&&!status.suspended;
  const editable=can&&(!b||!['PROCESSING','PENDING_REVIEW','REVOKED'].includes(b.status));
  const data=blob||previews.get(b?.image??'')||'';
  const editor=editing?`<div class="sup-editor">
   <div class="sup-editor-heading"><strong>${b?escape(b.name):label('create')}</strong>${b?`<span class="eco-chip">${label(b.status)}</span>`:''}</div>
   <div class="sup-body">
    ${b?`<div class="sup-image">${previewHtml(data)}<div class="sup-image-controls">
     <input class="eco-visually-hidden" type="file" tabindex="-1" aria-label="${h('supporter.image')}" accept="image/png,image/webp,image/jpeg" data-sup-file ${busy||!editable||!status?.uploadConfigured?'disabled':''}>
     <div class="sup-actions" ${!editable?'hidden':''}><button type="button" data-sup-pick ${busy||!status?.uploadConfigured?'disabled':''}>${label('image')}</button><button type="button" class="primary" data-sup-upload>${label('upload')}</button></div>
     ${fileName?`<span class="sup-filename">${escape(fileName)}</span>`:''}
     <span class="sup-help">PNG · WebP · JPEG · ≤ ${number(MAX_CUSTOM_BADGE_INPUT/1024/1024)} MiB · ${number(2048)} × ${number(2048)}</span>
    </div></div><details><summary>${label('preview')}</summary>${sizesHtml(data)}</details>`:''}
    ${b&&!editable?`<p class="sup-help">${label('locked')}</p>`:''}
    ${b&&!b.image?`<p class="sup-help" data-sup-image-help>${label('imageRequired')}</p>`:''}
    <form data-sup-form>
     <label>${label('name')}<input data-sup-name maxlength="32" value="${escape(name)}" required ${busy||!editable?'disabled':''}></label>
     <label>${label('description')}<textarea data-sup-description maxlength="160" ${busy||!editable?'disabled':''}>${escape(description)}</textarea></label>
     <div class="sup-actions" ${!editable?'hidden':''}><button type="submit" class="primary" data-sup-save>${escape(t('ui.save'))}</button></div>
    </form>
    ${b?.reason?`<p class="sup-reason">${label('reason')}: ${escape(b.reason)}</p>`:''}
    <div class="sup-actions sup-footer">
     ${b?`<button type="button" class="primary" data-sup-submit>${label('submit')}</button>${b.status==='APPROVED'?`<button type="button" data-sup-active ${busy||!can||(!b.active&&status!.badges.filter(v=>v.active).length>=status!.tier)?'disabled':''}>${escape(t(b.active?'ui.active_deactivate':'ui.activate_badge'))}</button>`:''}`:''}
     <button type="button" data-sup-cancel>${escape(t('ui.close'))}</button>
     ${b?`<button type="button" class="eco-danger" data-sup-delete ${busy?'disabled':''}>${escape(t(deleteConfirm?'ui.click_again_to_confirm':'ui.delete'))}</button>`:''}
    </div>
   </div></div>`:`<div class="eco-empty"><strong>${label('title')}</strong><p>${label('help')}</p></div>`;
  root.innerHTML=`<style>${SUPPORTER_CSS}</style><header><h3>${label('title')}</h3><button type="button" class="eco-quiet" data-sup-refresh ${busy?'disabled':''}>${escape(t('ui.refresh'))}</button></header>
   <p class="sup-help">${label('help')}</p><p role="status" aria-live="polite" data-error="${error}">${escape(notice||(busy?t('ui.loading'):''))}</p>
   ${!status?`<p>${escape(busy||!notice?t('ui.loading'):'')}</p>`:`<div class="sup-metrics"><span class="eco-chip">${status.tier?label('tier')+' '+number(status.tier):label('none')}</span><span>${label('slots')}: ${number(status.slotsUsed)} / ${number(status.tier)}</span></div>
    ${!status.uploadConfigured?`<p class="eco-notice">${label('unconfigured')}</p>`:''}
    ${status.tier>0&&status.slotsUsed>=status.tier?`<p class="sup-help">${label('quota')}</p>`:''}
    <div class="sup-layout"><div class="sup-list">${status.badges.map(item=>`<button type="button" data-sup-select="${item.id}" aria-pressed="${item.id===selected}"><strong>${escape(item.name)}</strong><small>${label(item.status)}${item.active?' · '+escape(t('ui.active')):''}</small></button>`).join('')}<button type="button" class="eco-quiet" data-sup-new ${busy||!can||status.slotsUsed>=status.tier?'disabled':''}>${label('create')}</button></div>${editor}</div>`}`;
  syncActions();hydrateBadgeImages(root,art);
 }
 /** Update action availability without replacing the input being edited. */
 function syncActions():void{
  const b=current(),dirty=!!b&&(name!==b.name||description!==b.description);
  const editable=!!status&&status.tier>0&&!status.suspended&&(!b||!['PROCESSING','PENDING_REVIEW','REVOKED'].includes(b.status));
  const imageHelp=root.querySelector<HTMLElement>('[data-sup-image-help]');if(imageHelp)imageHelp.hidden=!!bytes;
  const save=root.querySelector<HTMLButtonElement>('[data-sup-save]');
  if(save){save.disabled=busy||!editable||(!dirty&&!!b);save.hidden=!!b&&!dirty;}
  const upload=root.querySelector<HTMLButtonElement>('[data-sup-upload]');
  if(upload){upload.hidden=!bytes;upload.disabled=busy||!editable||!status?.uploadConfigured||!bytes||dirty;}
  const submit=root.querySelector<HTMLButtonElement>('[data-sup-submit]');
  if(submit){submit.hidden=!editable||dirty||!!bytes;submit.disabled=busy||!editable||!b?.image||dirty||!!bytes;}
 }
 const onInput=(event:Event):void=>{
  const targetEl=event.target;if(!(targetEl instanceof HTMLInputElement||targetEl instanceof HTMLTextAreaElement))return;
  if(targetEl.hasAttribute('data-sup-name'))name=targetEl.value;
  if(targetEl.hasAttribute('data-sup-description'))description=targetEl.value;
  syncActions();
 };
 const onChange=(event:Event):void=>{const input=event.target;
  if(!(input instanceof HTMLInputElement)||!input.hasAttribute('data-sup-file'))return;const file=input.files?.[0];if(!file)return;
  void run(async()=>{if(file.size>MAX_CUSTOM_BADGE_INPUT||file.size<12)throw Error('supporter.invalidImage');const data=new Uint8Array(await file.arrayBuffer());if(!alive())return;let mime='';if(data[0]===137&&data[1]===80&&data[2]===78&&data[3]===71)mime='image/png';else if(data[0]===255&&data[1]===216)mime='image/jpeg';else if(String.fromCharCode(...data.slice(0,4))==='RIFF'&&String.fromCharCode(...data.slice(8,12))==='WEBP')mime='image/webp';else throw Error('supporter.invalidImage');resetFile();bytes=data;fileName=file.name;blob=URL.createObjectURL(new Blob([data.buffer],{type:mime}));});
 };
 const onSubmit=(event:Event):void=>{if(!(event.target instanceof HTMLFormElement)||!event.target.hasAttribute('data-sup-form'))return;event.preventDefault();void run(async()=>{const input=badgeInput({name,description}),b=current(),previous=new Set(status?.badges.map(v=>v.id));const value=b?await bridge.edit(account,mutation(b,'edit'),input):await bridge.create(account,input,key(['create',input]));if(!alive())return;setStatus(value);if(!b)selected=value.badges.find(v=>!previous.has(v.id))?.id??value.badges.at(-1)?.id;editing=true;notice=t('ui.saved');changed();});};
 const onClick=(event:Event):void=>{const button=event.target instanceof Element?event.target.closest<HTMLButtonElement>('button'):null;if(!button||button.disabled||busy||!alive())return;
  if(button.hasAttribute('data-sup-pick')){root.querySelector<HTMLInputElement>('[data-sup-file]')?.click();return;}
  if(button.hasAttribute('data-sup-refresh')){void run(refresh);return;}
  if(button.dataset.supSelect){selected=button.dataset.supSelect;const b=current();if(b){name=b.name;description=b.description;editing=true;deleteConfirm=false;resetFile();void preview(b);}paint();return;}
  if(button.hasAttribute('data-sup-new')){selected=undefined;editing=true;name=description='';deleteConfirm=false;resetFile();paint();root.querySelector<HTMLInputElement>('[data-sup-name]')?.focus();return;}
  if(button.hasAttribute('data-sup-cancel')){editing=false;resetFile();paint();return;}
  const b=current();
  if(button.hasAttribute('data-sup-upload')&&b&&bytes){const data=bytes;void run(async()=>{const value=await bridge.upload(account,mutation(b,'upload'),data);if(alive()){resetFile();setStatus(value);const fresh=current();if(fresh)void preview(fresh);changed();}});return;}
  if(button.hasAttribute('data-sup-submit')&&b){void run(async()=>{const value=await bridge.submit(account,mutation(b,'submit'));if(alive()){setStatus(value);changed();}});return;}
  if(button.hasAttribute('data-sup-active')&&b){void run(async()=>{const ids=status!.badges.filter(v=>v.active&&v.id!==b.id).map(v=>v.id);if(!b.active)ids.push(b.id);const value=await bridge.activate(account,ids,key(['active',ids]));if(alive()){setStatus(value);changed();}});return;}
  if(button.hasAttribute('data-sup-delete')&&b){if(!deleteConfirm){deleteConfirm=true;paint();return;}void run(async()=>{const value=await bridge.remove(account,mutation(b,'delete'));if(alive()){selected=undefined;editing=false;deleteConfirm=false;resetFile();setStatus(value);changed();}});return;}
 };
 const onWake=():void=>{if(root.isConnected&&!document.hidden&&Date.now()-lastRefresh>10000&&status?.badges.some(b=>b.status==='PENDING_REVIEW'||b.status==='PROCESSING'))void run(refresh);};
 window.addEventListener('focus',onWake);document.addEventListener('visibilitychange',onWake);
 root.addEventListener('click',onClick);root.addEventListener('input',onInput);root.addEventListener('change',onChange);root.addEventListener('submit',onSubmit);
 return {
  attach(host){if(!alive())return;const entering=!root.isConnected;host.append(root);if(locale!==getLocale()){locale=getLocale();paint();}if(!loaded||entering){loaded=true;paint();void run(refresh);}else paint();},
  detach(){root.remove();},
  dispose(){if(disposed)return;disposed=true;epoch++;window.removeEventListener('focus',onWake);document.removeEventListener('visibilitychange',onWake);resetFile();previews.clear();keys.clear();root.removeEventListener('click',onClick);root.removeEventListener('input',onInput);root.removeEventListener('change',onChange);root.removeEventListener('submit',onSubmit);root.remove();},
 };
}
