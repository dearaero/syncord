import {css} from '../api/css';
import {performanceModeEnabled,setPerformanceMode,onPerformanceModeChange,nativeMotionAvailable} from '../core/performance';
import {messageHtml as html,h,onLocaleChange,setLocalizedHtml,setLocalizedText,number,t} from '../i18n';
import {frameReport,frameReportText,resetFrameDiagnostics} from '../core/performance/diagnostics';

export function mountPerformancePanel(host: HTMLElement, openStatistics: () => void): () => void {
 const removeStyle=css.inject('performance-panel',`
 #Syncord-settings-root .pm-card{padding:20px;border:1px solid var(--background-modifier-accent,rgba(128,128,128,.2));border-radius:14px;background:var(--background-secondary,rgba(128,128,128,.04));display:grid;gap:18px;max-width:850px}
 #Syncord-settings-root .pm-card .dion-setting-row{margin:0;gap:20px;padding:0}
 #Syncord-settings-root .pm-card p{margin:0;color:var(--text-muted,#999);font-size:13px;line-height:1.6;overflow-wrap:anywhere}
 #Syncord-settings-root .pm-card button{justify-self:start;border:1px solid var(--background-modifier-accent,rgba(128,128,128,.2));border-radius:9px;padding:9px 14px;color:var(--text-normal,#ddd);background:var(--background-tertiary,rgba(128,128,128,.1));font:inherit;cursor:pointer}
 #Syncord-settings-root .pm-card button:focus-visible{outline:2px solid var(--brand-500,#5865f2);outline-offset:3px}
 #Syncord-settings-root .pm-frames table{width:100%;border-collapse:collapse;font-size:13px}
 #Syncord-settings-root .pm-frames th,#Syncord-settings-root .pm-frames td{padding:6px 8px;text-align:start;border-bottom:1px solid var(--background-modifier-accent,rgba(128,128,128,.2));overflow-wrap:anywhere}
 #Syncord-settings-root .pm-frames td:not(:first-child),#Syncord-settings-root .pm-frames th:not(:first-child){text-align:end;white-space:nowrap}
 #Syncord-settings-root .pm-actions{display:flex;gap:10px;flex-wrap:wrap}
 @media(max-width:650px){#Syncord-settings-root .pm-card{padding:14px}}
 `);
 setLocalizedHtml(host,`<section class="pm-card"><label class="dion-setting-row"><span class="dion-setting-copy"><strong class="dion-setting-title">${html('pm.mode')}</strong><span class="dion-setting-desc">${html('pm.description')}</span></span><span class="dion-switch"><input type="checkbox" role="switch" data-performance-mode aria-label="${h('pm.mode')}" data-si18n-aria-label="pm.mode"><span class="dion-track" aria-hidden="true"></span></span></label><p>${html('pm.details')}</p><p data-performance-native role="status"></p><p>${html('pm.limit')}</p><button type="button" data-performance-statistics>${html('ui.statistics')}</button></section><section class="pm-card pm-frames" aria-labelledby="pm-frames-title"><strong class="dion-setting-title" id="pm-frames-title">${html('pd.title')}</strong><p>${html('pd.description')}</p><p data-pd-summary role="status"></p><table><thead><tr><th scope="col">${html('pd.source')}</th><th scope="col">${html('pd.script')}</th><th scope="col">${html('pd.layout')}</th><th scope="col">${html('pd.frames')}</th></tr></thead><tbody data-pd-rows></tbody></table><div class="pm-actions"><button type="button" data-pd-copy>${html('pd.copy')}</button><button type="button" data-pd-reset>${html('pd.reset')}</button></div></section>`);
 const input=host.querySelector<HTMLInputElement>('[data-performance-mode]')!;
 const status=host.querySelector<HTMLElement>('[data-performance-native]')!;
 const button=host.querySelector<HTMLButtonElement>('[data-performance-statistics]')!;
 const summary=host.querySelector<HTMLElement>('[data-pd-summary]')!,rows=host.querySelector<HTMLElement>('[data-pd-rows]')!;
 const copyButton=host.querySelector<HTMLButtonElement>('[data-pd-copy]')!,resetButton=host.querySelector<HTMLButtonElement>('[data-pd-reset]')!;
 const ms=(n:number):string=>number(Math.round(n),{style:'unit',unit:'millisecond',unitDisplay:'narrow'});
 const paintFrames=():void=>{
  const r=frameReport();
  summary.textContent=!r.supported?t('pd.unsupported'):!r.frames?t('pd.empty'):t('pd.summary',{v0:number(r.frames),v1:ms(r.blockingMs),v2:ms(r.worstMs)});
  rows.replaceChildren(...r.sources.slice(0,12).map(s=>{const tr=document.createElement('tr');for(const v of [s.source,ms(s.scriptMs),ms(s.layoutMs),number(s.frames)]){const td=document.createElement('td');td.textContent=v;tr.append(td);}return tr;}));
 };
 const copyReport=():void=>{void navigator.clipboard.writeText(frameReportText()).then(()=>{summary.textContent=t('pd.copied');},()=>{});};
 const resetFrames=():void=>{resetFrameDiagnostics();paintFrames();};
 copyButton.addEventListener('click',copyReport);resetButton.addEventListener('click',resetFrames);
 // Only while Settings shows the panel; the observer itself never touches the DOM.
 const frameTimer=window.setInterval(()=>{if(!document.hidden)paintFrames();},2000);paintFrames();
 const paint=():void=>{input.checked=performanceModeEnabled();status.hidden=!input.checked;setLocalizedText(status,nativeMotionAvailable()?'pm.native':'pm.fallback');};
 const change=():void=>setPerformanceMode(input.checked);
 input.addEventListener('change',change);button.addEventListener('click',openStatistics);
 const off=onPerformanceModeChange(paint),locale=onLocaleChange(()=>{paint();paintFrames();});paint();
 return()=>{off();locale();window.clearInterval(frameTimer);copyButton.removeEventListener('click',copyReport);resetButton.removeEventListener('click',resetFrames);input.removeEventListener('change',change);button.removeEventListener('click',openStatistics);removeStyle();host.replaceChildren();};
}
