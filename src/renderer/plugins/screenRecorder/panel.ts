import { h, onLocaleChange, localizeMessage, messageHtml as i18nHtml, setLocalizedText, t as i18nText } from "../../i18n";
import { recorderOptions, RECORDER_EVENT, setRecorderOption } from "./settings";
import { recorderState, recorderEnabled, recorderBusy, refreshRecorder, toggleRecorder } from "./runtime";
import { openRecordingLibrary } from "./library";
import { showToast, ToastType } from "../../ui/toast";
import type { RecordingOptions } from "../../../shared/recording";
let expanded=false;
export const isRecorderExpanded=():boolean=>expanded;
export function recorderExpandButtonHtml():string{return `<button type="button" class="dion-icon-btn dion-expand-btn" data-recorder-expand aria-label="${h("ui.screen_recorder_options")}" aria-expanded="${expanded}" data-si18n-aria-label="ui.screen_recorder_options"><svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m7 9 5 5 5-5 1.4 1.4L12 16.8l-6.4-6.4Z"/></svg></button>`;}
const option=(v:number,current:number,label:string):string=>`<option value="${v}" ${v===current?'selected':''}>${label}</option>`;
const toggle=(key:string,title:string,desc:string,checked:boolean):string=>`<label class="dion-setting-row"><span class="dion-setting-copy"><span class="dion-setting-title">${title}</span><span class="dion-setting-desc">${desc}</span></span><span class="dion-switch"><input type="checkbox" role="switch" data-recorder-option="${key}" ${checked?'checked':''}><span class="dion-track" aria-hidden="true"></span></span></label>`;
export function recorderSectionHtml():string{
  const v=recorderOptions();
  return `<div class="dion-plugin-details dion-recorder-panel"><div class="dion-details-head"><div><span class="dion-eyebrow">${i18nHtml("ui.screen_recorder")}</span><h4>${i18nHtml("ui.local_screen_recording")}</h4></div><button type="button" class="dion-primary-btn dion-recorder-secondary" data-recorder-library>${i18nHtml("ui.recordings")}</button></div>
    <label class="dion-setting-row"><span class="dion-setting-copy"><span class="dion-setting-title">${i18nHtml("ui.resolution")}</span><span class="dion-setting-desc">${i18nHtml("ui.maximum_size_preserves_aspect_ratio_without_stretching")}</span></span><select class="dion-select" data-recorder-option="resolution">${[720,1080,1440,2160].map(n=>option(n,v.resolution,`${n}p`)).join('')}</select></label>
    <label class="dion-setting-row"><span class="dion-setting-copy"><span class="dion-setting-title">${i18nHtml("ui.frame_rate")}</span><span class="dion-setting-desc">${i18nHtml("ui.15_fps_uses_less_processing_power")}</span></span><select class="dion-select" data-recorder-option="fps">${[15,24,30].map(n=>option(n,v.fps,`${n} FPS`)).join('')}</select></label>
    ${toggle('microphone',i18nText("ui.record_microphone"),i18nText("ui.automatically_use_the_microphone_selected_in_discord_voice_video_recor"),v.microphone)}
    ${toggle('output',i18nText("ui.record_output_audio"),i18nText("ui.record_system_playback_including_discord_through_native_audio_capture"),v.output)}
    <div class="dion-recorder-actions"><button type="button" class="dion-primary-btn" data-recorder-toggle>${i18nHtml("ui.start_recording")}</button></div>
    <p class="dion-setting-desc" data-recorder-audio-help></p><p class="dion-setting-desc" data-recorder-status role="status">${i18nHtml("ui.ready_to_record")}</p>
    <p class="dion-setting-desc">${i18nHtml("ui.settings_apply_to_the_next_recording_saved_as_webm_in_your_videos_sync")}</p></div>`;
}
export function bindRecorderPanel(root:HTMLElement):()=>void{
  const paint=():void=>{const state=recorderState();
    root.querySelectorAll<HTMLElement>('[data-recorder-status]').forEach(el=>el.textContent=localizeMessage(state.detail));
    const active=['choosing','starting','recording','stopping'].includes(state.phase);
    root.querySelectorAll<HTMLButtonElement>('[data-recorder-toggle]').forEach(el=>{el.textContent=active?i18nText("ui.stop_recording"):i18nText("ui.start_recording");el.disabled=!recorderEnabled()||recorderBusy()||state.phase==='stopping';el.classList.toggle('is-recording',state.phase==='recording');});
    root.querySelectorAll<HTMLButtonElement>('[data-recorder-library]').forEach(el=>el.disabled=!recorderEnabled());
    root.querySelectorAll<HTMLElement>('[data-recorder-audio-help]').forEach(el=>setLocalizedText(el, "ui.microphone_follows_the_input_selected_in_discord_output_captures_syste"));
  };
  const click=(event:Event):void=>{const button=(event.target as Element|null)?.closest<HTMLButtonElement>('button');if(!button)return;
    if(button.matches('[data-recorder-expand]')){event.preventDefault();event.stopPropagation();expanded=!expanded;button.setAttribute('aria-expanded',String(expanded));button.closest('.dion-plugin')?.classList.toggle('is-open',expanded);if(expanded){void refreshRecorder();}}
    if(button.matches('[data-recorder-toggle]'))void toggleRecorder();
    if(button.matches('[data-recorder-library]')){try{openRecordingLibrary();}catch{showToast(i18nText("ui.enable_screen_recorder_first"),{type:ToastType.FAILURE});}}
  };
  const change=(event:Event):void=>{const el=event.target;if(!(el instanceof HTMLInputElement||el instanceof HTMLSelectElement))return;
    const key=el.dataset.recorderOption;if(!key)return;
    const value=el instanceof HTMLInputElement?el.checked:(key==='resolution'||key==='fps'?Number(el.value):el.value);
    try{setRecorderOption(key as keyof RecordingOptions,value);}catch{showToast(i18nText("ui.invalid_recording_setting"),{type:ToastType.FAILURE});}
  };
  root.addEventListener('click',click);root.addEventListener('change',change);window.addEventListener(RECORDER_EVENT,paint);const stopLocale=onLocaleChange(paint);paint();if(expanded){void refreshRecorder();}
  return()=>{stopLocale();root.removeEventListener('click',click);root.removeEventListener('change',change);window.removeEventListener(RECORDER_EVENT,paint);};
}
