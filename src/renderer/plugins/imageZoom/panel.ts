import { productAttribute, productHtml, h, messageHtml as i18nHtml, t as i18nText } from "../../i18n";
import { imageZoomSettings, imageZoomOptions, IMAGE_ZOOM_ID, IMAGE_ZOOM_CHANGED, numericRange, normalizeOptions, type ImageZoomOptions } from './settings';
import { hideTooltip } from '../../ui/tooltip';
let expanded=false;
const esc=(value:unknown):string=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]??c));
export const isImageZoomExpanded=():boolean=>expanded;
export function imageZoomExpandButtonHtml():string {
  return `<button type="button" class="dion-icon-btn dion-expand-btn" data-iz-expand aria-expanded="${expanded}" aria-label="${h("ui.imagezoom_options")}" data-si18n-aria-label="ui.imagezoom_options"><svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m7.41 8.59 4.59 4.58 4.59-4.58L18 10l-6 6-6-6 1.41-1.41Z"/></svg></button>`;
}
const groups:readonly [string,readonly (keyof ImageZoomOptions)[]][]=[
  ["ui.inline_inspection",['hover','avatars','highResolution','hoverDelay','closeDelay']],
  ["ui.zoom_and_rendering",['smooth','pan','zoomEnabled','zoomModifier','zoomStep','maxZoom','resizeEnabled','resizeModifier','resizeStep','pixelPerfect']],
  ["ui.gif_playback_and_memory",['gifControls','gifAutoplay','gifLoop','gifSpeed','gifMaxMB','gifMaxMP']],
  ["ui.keyboard_shortcuts",['protectTyping','pauseKey','previousKey','nextKey','pixelKey','resetKey','closeKey']],
];
export function imageZoomSectionHtml():string {
  const cfg=imageZoomOptions();
  const field=(key:keyof ImageZoomOptions):string=>{
    const def=imageZoomSettings.schema[key],title=productHtml(def.title),value=cfg[key];let input:string;
    if(def.type==='boolean')input=`<span class="dion-switch"><input type="checkbox" role="switch" data-iz-option="${key}" ${productAttribute("aria-label",def.title)} ${value?'checked':''}><span class="dion-track" aria-hidden="true"></span></span>`;
    else if(key==='zoomModifier'||key==='resizeModifier')input=`<select class="dion-select" data-iz-option="${key}" ${productAttribute("aria-label",def.title)}>${['alt','shift','ctrl','meta','none'].map(modifier=>`<option value="${modifier}" ${value===modifier?'selected':''}>${modifier==='none'?i18nHtml('ui.no_modifier'):modifier==='meta'?'Command / Windows':esc(modifier[0].toUpperCase()+modifier.slice(1))}</option>`).join('')}</select>`;
    else {const range=numericRange(key);input=`<input type="${def.type==='number'?'number':'text'}" data-iz-option="${key}" ${productAttribute("aria-label",def.title)} value="${esc(value)}" ${range?`min="${range[0]}" max="${range[1]}" step="${['zoomStep','gifSpeed'].includes(key)?'.05':'1'}"`:'maxlength="80"'}>`;}
    return `<label class="${def.type==='boolean'?'dion-setting-row':'dion-field-row'}"><span class="dion-setting-copy"><span class="dion-setting-title">${title}</span><span class="dion-setting-desc">${productHtml(def.description)}</span></span>${input}</label>`;
  };
  return `<div class="dion-plugin-details"><div class="dion-details-head"><div><span class="dion-eyebrow">${i18nHtml("ui.imagezoom")}</span><h4>${i18nHtml("ui.inspect_images_without_leaving_the_conversation")}</h4></div></div>${groups.map(([title,keys],i)=>`<details ${i===0?'open':''}><summary class="dion-setting-title">${i18nHtml(title)}</summary>${keys.map(field).join('')}</details>`).join('')}<p class="dion-setting-desc">${i18nHtml("ui.defaults_alt_scroll_to_zoom_shift_scroll_to_resize_move_the_pointer_to")}</p></div>`;
}
export function bindImageZoomPanel(root:HTMLElement):()=>void {
  const click=(event:Event):void=>{const button=event.target instanceof Element?event.target.closest<HTMLButtonElement>('[data-iz-expand]'):null;if(!button)return;event.preventDefault();event.stopPropagation();hideTooltip();expanded=!expanded;button.setAttribute('aria-expanded',String(expanded));button.closest('.dion-plugin')?.classList.toggle('is-open',expanded);};
  const change=(event:Event):void=>{
    const input=event.target;if(!(input instanceof HTMLInputElement||input instanceof HTMLSelectElement))return;
    const key=input.dataset.izOption;if(!imageZoomSettings.keys.some(k=>k===key))return;
    const name=key as keyof ImageZoomOptions,def=imageZoomSettings.schema[name],cfg=imageZoomSettings.bind(IMAGE_ZOOM_ID);
    let value:unknown=input.value;
    if(def.type==='boolean'&&input instanceof HTMLInputElement)value=input.checked;
    if(def.type==='number'){if(input.value.trim()===''||!Number.isFinite(Number(input.value)))return;value=Number(input.value);}
    const normalized=normalizeOptions({...cfg.snapshot(),[name]:value});cfg.set(name,normalized[name]);
    if(def.type!=='boolean')input.value=String(normalized[name]);window.dispatchEvent(new Event(IMAGE_ZOOM_CHANGED));
  };
  root.addEventListener('click',click);root.addEventListener('change',change);return()=>{root.removeEventListener('click',click);root.removeEventListener('change',change);};
}
