import {h,messageHtml,t,onLocaleChange} from '../../i18n';
import {hideTooltip} from '../../ui/tooltip';
import {options,setOption,type Options} from './settings';
import {onSpotifyStatus,showSpotifyPlayer,spotifyStatus} from './state';
let expanded=false;
export const isSpotifyExpanded=():boolean=>expanded;
export function spotifyExpandHtml():string{return `<button type="button" class="dion-icon-btn dion-expand" data-spotify-expand aria-expanded="${expanded}" aria-label="${h('spotify.options')}" data-si18n-aria-label="spotify.options">⌄</button>`;}
export function spotifySectionHtml():string {
  const cfg=options();
  const fields=(Object.keys(cfg) as Array<keyof Options>).map(key=>`<label class="dion-setting-row"><span class="dion-setting-copy"><span class="dion-setting-title">${messageHtml('spotify.'+key)}</span></span>${key==='speed'?`<input type="range" data-spotify-option="speed" min="0.5" max="2" step="0.1" value="${cfg.speed}" aria-label="${h('spotify.speed')}" data-si18n-aria-label="spotify.speed">`:`<span class="dion-switch"><input type="checkbox" role="switch" data-spotify-option="${key}" ${cfg[key]?'checked':''} aria-label="${h('spotify.'+key)}" data-si18n-aria-label="spotify.${key}"><span class="dion-track" aria-hidden="true"></span></span>`}</label>`).join('');
  return `<div class="dion-plugin-details" data-spotify-options><div class="dion-details-head"><h4>${messageHtml('spotify.name')}</h4></div>${fields}<p class="dion-setting-desc" data-spotify-status role="status"></p><button type="button" class="dion-primary-btn" data-spotify-player>${messageHtml('spotify.player')}</button></div>`;
}
export function bindSpotifyPanel(root:HTMLElement):()=>void {
  const host=root.querySelector<HTMLElement>('[data-spotify-options]');if(!host)return()=>{};
  const status=host.querySelector<HTMLElement>('[data-spotify-status]'),open=host.querySelector<HTMLButtonElement>('[data-spotify-player]');
  const paint=():void=>{const {running,playback:s}=spotifyStatus();if(status)status.textContent=t('spotify.status')+': '+(!running?t('spotify.off'):!s.connected?t('spotify.disconnected'):t('spotify.connected')+' · '+t('spotify.'+(s.playing?'playing':'paused')));if(open)open.disabled=!running||!s.track;};
  const click=(e:Event):void=>{const el=e.target instanceof Element?e.target.closest('[data-spotify-expand],[data-spotify-player]'):null;if(!el)return;e.preventDefault();e.stopPropagation();hideTooltip();if(el.hasAttribute('data-spotify-player')){showSpotifyPlayer();return;}expanded=!expanded;el.closest('.dion-plugin')?.classList.toggle('is-open',expanded);el.setAttribute('aria-expanded',String(expanded));};
  const change=(e:Event):void=>{const el=e.target;if(!(el instanceof HTMLInputElement)||!el.hasAttribute('data-spotify-option'))return;const key=el.dataset.spotifyOption;if(!key||!Object.hasOwn(options(),key))return;setOption(key as keyof Options,el.type==='checkbox'?el.checked:Number(el.value));};
  root.addEventListener('click',click);host.addEventListener('change',change);const statusOff=onSpotifyStatus(paint),localeOff=onLocaleChange(paint);paint();
  return()=>{root.removeEventListener('click',click);host.removeEventListener('change',change);statusOff();localeOff();};
}
