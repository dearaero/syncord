import {h,t,messageHtml as html,onLocaleChange} from '../../i18n';
import {platformIcon} from '../../api/discordEvents/platformIcons';
import {hideTooltip} from '../../ui/tooltip';
import {PLATFORMS,rowState,type Platform} from './model';
import {spooferState,onSpooferState,saveSelection,refreshObservation} from './state';
let expanded=false;
export const isSpooferExpanded=():boolean=>expanded;
/** Surface the limitation/risk notice immediately when enabled from Settings. */
export function revealSpooferPanel(root:Element):void{
 expanded=true;const button=root.querySelector('[data-ps-expand]');button?.setAttribute('aria-expanded','true');button?.closest('.dion-plugin')?.classList.add('is-open');
}
export function platformName(platform:Platform):string{return platform==='vr'?'VR':t('ui.'+(platform==='web'?'browser':platform));}
export function spooferExpandHtml():string{return `<button type="button" class="dion-icon-btn dion-expand-btn" data-ps-expand aria-expanded="${expanded}" aria-label="${h('ps.name')}" data-si18n-aria-label="ps.name"><svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m7 9 5 5 5-5"/></svg></button>`;}
export function spooferSectionHtml():string{return `<section class="dion-plugin-details dion-spoofer" data-ps-panel>
 <div class="dion-details-head"><div><span class="dion-eyebrow">${html('ps.name')}</span><h4>${html('ps.platforms')}</h4></div></div><p class="dion-setting-desc ps-risk">${html('ps.risk')}</p><p class="dion-setting-desc ps-limitation">${html('ps.limitation')}</p>
 <fieldset class="dion-settings-group"><legend>${html('ps.platforms')}</legend>${PLATFORMS.map(p=>`<label class="dion-setting-row"><span class="ps-icon" data-ps-icon="${p}" aria-hidden="true">${p==='console'?'':platformIcon(p)}</span><span class="dion-setting-copy ps-copy"><span class="dion-setting-title" data-ps-name="${p}"></span><span class="dion-setting-desc" data-ps-state="${p}"></span></span><span class="dion-switch"><input type="checkbox" data-ps-platform="${p}"><span class="dion-track" aria-hidden="true"></span></span></label>`).join('')}</fieldset>
 <div class="ps-actions"><button type="button" class="dion-primary-btn" data-ps-apply>${html('ps.apply')}</button><button type="button" class="dion-primary-btn ps-secondary" data-ps-restore>${html('ps.restore')}</button><button type="button" class="dion-primary-btn ps-secondary" data-ps-refresh>${html('ui.refresh')}</button></div>
 <p class="dion-setting-desc ps-identity" data-ps-identity role="status" aria-live="polite"></p>
 <p class="dion-setting-desc" data-ps-result role="status" aria-live="polite"></p>
 <h4>${html('ps.presence')}</h4><div class="dion-settings-group ps-presence" data-ps-observed></div><p class="dion-setting-desc">${html('ps.verification')}</p>
 </section>`;}
export const SPOOFER_CSS=`
.dion-spoofer{min-width:0}
.dion-spoofer .ps-risk{margin:0 0 10px;line-height:1.6}
.dion-spoofer .ps-limitation{margin:0 0 16px;padding:10px 12px;border:1px solid var(--dion-border,var(--border-subtle,#ffffff14));border-radius:10px;background:var(--dion-bg-low,var(--background-secondary,#202127));line-height:1.6}
.dion-spoofer fieldset{position:relative;border:0;padding:0;margin:0;min-width:0}
.dion-spoofer legend{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.dion-spoofer .ps-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;overflow-wrap:anywhere}
.dion-spoofer .ps-icon{display:inline-flex;align-items:center;justify-content:center;width:20px;flex:0 0 20px;color:var(--dion-muted,var(--text-muted,#949ba4))}
.dion-spoofer .dion-switch{margin-inline-start:auto;flex-shrink:0}
.dion-spoofer .ps-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:14px 0 10px}
.dion-spoofer .ps-secondary,#Syncord-settings-root .dion-spoofer .ps-secondary{background:rgba(255,255,255,.025);color:var(--dion-text,var(--text-normal,#eee));border:1px solid var(--dion-border,var(--border-subtle,#ffffff14));box-shadow:none}
.dion-spoofer .ps-actions button{white-space:normal;max-width:100%;min-height:32px}
.dion-spoofer [data-ps-result]:empty{display:none}
.dion-spoofer [data-error=true]{color:var(--text-danger,#fa777c)}
.dion-spoofer .ps-presence{padding:2px 12px;margin-bottom:10px}
.dion-spoofer .ps-observation{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;padding:9px 0;font-size:12px;line-height:1.5}
.dion-spoofer .ps-observation strong{font-weight:590}
.dion-spoofer .ps-observation small{color:var(--dion-muted,var(--text-muted,#949ba4));font-size:11px}
.dion-spoofer h4{margin:14px 0 8px;font-size:12px;font-weight:600}
.dion-spoofer input:focus-visible{outline:2px solid var(--focus-primary,#00a8fc);outline-offset:3px}
.dion-spoofer [hidden]{display:none!important}
@media(max-width:550px){.dion-spoofer .ps-actions>button{flex:1 1 140px}}
`;
const statusLabel=(status:string):string=>t('ui.'+(status==='dnd'?'do_not_disturb':status));
export function bindSpooferPanel(root:HTMLElement):()=>void{
 const host=root.querySelector<HTMLElement>('[data-ps-panel]');if(!host)return()=>{};
 let closed=false,account:string|undefined,signature='',wasSaving=false,draft:Platform[]=[],localError='';
 function render():void{
  if(closed)return;const state=spooferState(),next=JSON.stringify(state.selected);
  if(account!==state.account||signature!==next||(wasSaving&&!state.saving&&['saved','restored'].includes(state.result))){account=state.account;signature=next;draft=[...state.selected];localError='';}
  wasSaving=state.saving;
  const enabled=state.running&&!!state.account&&!state.saving&&!state.identity?.busy;
  for(const platform of PLATFORMS){
   const input=host!.querySelector<HTMLInputElement>(`[data-ps-platform="${platform}"]`)!;
   input.checked=draft.includes(platform);input.disabled=!enabled;input.setAttribute('aria-label',platformName(platform));
   host!.querySelector<HTMLElement>(`[data-ps-name="${platform}"]`)!.textContent=platformName(platform);
   const row=rowState(state,platform),evidence=state.evidence[platform];
   host!.querySelector<HTMLElement>(`[data-ps-state="${platform}"]`)!.textContent=!state.running?'':!state.available?t('ps.unavailable'):(row==='verification'?t('ui.unverified'):!evidence&&state.identity?.available&&platform!=='console'?t('ps.identityReady'):t('ps.'+row))+(evidence?' · '+statusLabel(evidence.status):'');
   const icon=host!.querySelector<HTMLElement>(`[data-ps-icon="${platform}"]`)!;
   if(platform==='console')icon.innerHTML=evidence?platformIcon('console'):'';
  }
  for(const button of host!.querySelectorAll<HTMLButtonElement>('button'))button.disabled=!enabled;
  const identity=host!.querySelector<HTMLElement>('[data-ps-identity]')!,capability=state.identity;
  const phase=capability?.phase,identityKey=!capability?.available?'identityUnavailable':phase==='armed'?'identityArmed':phase==='prepared'?'identityPrepared':phase==='connected'?'identityConnected':phase==='failed'?'identityFailed':phase==='multiple'?'identityMultiple':phase==='console'?'identityConsole':'identityReady';
  identity.textContent=state.running&&state.account?(phase==='armed'&&!capability?.platform?t('ui.waiting_for_discord_to_reconnect'):t('ps.'+identityKey,{platform:capability?.platform?platformName(capability.platform):''})):'';
  const result=host!.querySelector<HTMLElement>('[data-ps-result]')!;
  const message=localError||(!state.running?'ps.enable':!state.account?'ps.noAccount':state.saving?'ui.loading':state.result?'ps.'+state.result:'');
  result.textContent=message?t(message==='ps.failed'&&state.identity?'ps.identityFailed':message):'';result.dataset.error=String(!!localError||state.result==='failed');
  const observed=host!.querySelector<HTMLElement>('[data-ps-observed]')!;observed.replaceChildren();
  if(!state.running||!state.account||!state.available){const p=document.createElement('p');p.className='dion-setting-desc';p.textContent=t(!state.running?'ps.enable':!state.account?'ps.noAccount':'ps.unavailable');observed.append(p);return;}
  if(state.visibility==='offline'||state.visibility==='invisible'){const p=document.createElement('p');p.className='dion-setting-desc';p.textContent=t('ui.offline');observed.append(p);return;}
  for(const platform of PLATFORMS){
   const evidence=state.evidence[platform];if(!evidence)continue;
   const row=document.createElement('div');row.className='ps-observation';row.dataset.psReported=platform;
   const name=document.createElement('strong');name.textContent=platformName(platform)+' · '+statusLabel(evidence.status);
   const source=document.createElement('small');source.textContent=t('ps.'+(evidence.source==='presence'?'reported':'session'));row.append(name,source);observed.append(row);
  }
  if(!observed.children.length){const p=document.createElement('p');p.className='dion-setting-desc';p.textContent=t('ps.unavailable');observed.append(p);}
 }
 function click(event:Event):void{
  const button=event.target instanceof Element?event.target.closest<HTMLButtonElement>('button'):null;if(!button||button.disabled)return;
  if(button.hasAttribute('data-ps-expand')){event.preventDefault();event.stopPropagation();hideTooltip();expanded=!expanded;button.setAttribute('aria-expanded',String(expanded));button.closest('.dion-plugin')?.classList.toggle('is-open',expanded);if(expanded)refreshObservation();return;}
  if(!host!.contains(button))return;
  localError='';
  if(button.hasAttribute('data-ps-refresh'))refreshObservation();
  else if(button.hasAttribute('data-ps-apply')||button.hasAttribute('data-ps-restore')){
   const restore=button.hasAttribute('data-ps-restore');if(!account||!saveSelection(draft,account,restore))localError='ps.failed';
  }
  render();
 }
 const change=(event:Event):void=>{
  const input=event.target;if(!(input instanceof HTMLInputElement)||input.disabled||!input.hasAttribute('data-ps-platform'))return;
  const platform=input.dataset.psPlatform as Platform;if(!PLATFORMS.includes(platform))return;
  draft=PLATFORMS.filter(p=>p===platform?input.checked:draft.includes(p));localError='';
 };
 root.addEventListener('click',click);host.addEventListener('change',change);
 const off=onSpooferState(render),localeOff=onLocaleChange(render);render();
 return()=>{closed=true;draft=[];off();localeOff();root.removeEventListener('click',click);host.removeEventListener('change',change);};
}
