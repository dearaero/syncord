import {BodyMutationObserver} from "../../ui/bodyObserver";
import {getLocale, onLocaleChange} from "../../i18n";
import { t as i18nText } from "../../i18n";
import { definePlugin } from "../../api/plugin";
import { bindTooltip } from "../../ui/tooltip";
import { attachRecorder, recorderState, recorderBusy, toggleRecorder } from "./runtime";
import { RECORDER_EVENT, RECORDER_ID } from "./settings";
import { disposeRecordingLibrary } from "./library";
const ID="Syncord-recording-toolbar-btn";
const PLAYER_CSS = `
.Syncord-recording-player{box-sizing:border-box;width:min(1040px,calc(100vw - 32px));max-height:calc(100dvh - 32px);padding:18px;border:1px solid var(--border-subtle,#404249);border-radius:12px;background:var(--background-primary,#1e1f22);color:var(--text-normal,#f2f3f5);box-shadow:0 16px 64px #0009;overflow:auto}
.Syncord-recording-player::backdrop{background:#000b}
.Syncord-recording-player header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap}
.Syncord-recording-player h2{font:600 17px/1.4 var(--font-primary,system-ui);margin:0;min-width:0;flex:1;overflow-wrap:anywhere}
.Syncord-recording-player header>div{display:flex;gap:8px;flex-shrink:0}
.Syncord-recording-player button{font:inherit;border:0;border-radius:7px;background:var(--background-secondary,#2b2d31);color:inherit;cursor:pointer;padding:8px 12px}
.Syncord-recording-player button:hover{background:var(--background-modifier-hover,#35373c)}
.Syncord-recording-player button:focus-visible{outline:2px solid var(--focus-primary,#00a8fc);outline-offset:2px}
.Syncord-recording-player video{display:block;width:100%;max-height:calc(100dvh - 160px);min-height:140px;aspect-ratio:16/9;object-fit:contain;background:#000;border-radius:8px}
.Syncord-recording-player video:fullscreen{max-height:none;height:100%;aspect-ratio:auto}
.Syncord-recording-player [role=status]{color:var(--text-muted,#949ba4);font-size:13px;line-height:1.5;margin:12px 0 0}
.Syncord-recording-player [role=status]:empty{display:none}
@media(max-width:550px){.Syncord-recording-player{padding:12px}.Syncord-recording-player header>div{flex-wrap:wrap}}
`;
const CSS=`#${ID}{display:flex;align-items:center;justify-content:center;width:32px;height:32px;cursor:pointer;color:var(--interactive-normal,#b5bac1);border-radius:6px;background:transparent;border:0;padding:4px;position:relative}#${ID}:hover{color:var(--interactive-hover,#fff);background:var(--background-modifier-hover,#35363c)}#${ID}[data-recording=true]{color:#f23f42!important;background:#f23f421a}#${ID}:focus-visible{outline:2px solid var(--focus-primary,#00a8fc);outline-offset:2px}#${ID}:disabled{opacity:.6;cursor:wait}.Syncord-recording-library{box-sizing:border-box;color:var(--text-normal,#f2f3f5);background:var(--background-primary,#1e1f22);border:1px solid var(--border-subtle,#404249);border-radius:12px;padding:20px;width:min(800px,calc(100vw - 32px));max-height:85vh;overflow:auto;box-shadow:0 16px 64px #0008}.Syncord-recording-library::backdrop{background:#0009}.Syncord-recording-library header,.Syncord-recording-library footer,.Syncord-recording-library article{display:flex;align-items:center;justify-content:space-between;gap:14px}.Syncord-recording-library h2{margin:0;font-size:22px}.Syncord-recording-library h3{font-size:15px;margin:0}.Syncord-recording-library p{font-size:13px;color:var(--text-muted,#949ba4);overflow-wrap:anywhere}.Syncord-recording-library article{padding:14px 0;border-bottom:1px solid var(--border-subtle,#404249)}.Syncord-recording-library button{border:0;background:var(--background-secondary,#2b2d31);border-radius:6px;color:inherit;padding:8px 12px;font:inherit;cursor:pointer}.Syncord-recording-library [data-play]{background:#5865f2;color:#fff}.Syncord-recording-library button:focus-visible{outline:2px solid #00a8fc}.Syncord-recording-library header>div,.Syncord-recording-library article>div:last-child{display:flex;gap:8px;flex-shrink:0}.Syncord-recording-library footer{margin-top:14px}@media(max-width:550px){.Syncord-recording-library article{align-items:flex-start;flex-direction:column}.Syncord-recording-library header{flex-wrap:wrap}}`;
export const ScreenRecorderPlugin=definePlugin({id:RECORDER_ID,name:i18nText("ui.screen_recorder"),get description() { return i18nText("ui.record_a_screen_or_window_with_optional_microphone_and_output_audio_wa"); },author:i18nText("ui.syncord"),enabledByDefault:true,
  permissions:{media:true,userData:true,discordStores:["MediaEngineStore"],native:["screen-recording","show-in-folder"]},
  start(ctx){ctx.css.inject(CSS+PLAYER_CSS);ctx.disposable(attachRecorder(ctx));
    let wrapper:HTMLElement|undefined;let tooltipDispose:(()=>void)|undefined;let raf=0;
    const paint=():void=>{const button=document.getElementById(ID) as HTMLButtonElement|null;if(!button)return;const state=recorderState();
      const recording=state.phase==='recording';const active=['choosing','starting','recording','stopping'].includes(state.phase);
      button.dataset.recording=String(recording);button.disabled=recorderBusy()||state.phase==='stopping';button.setAttribute('aria-pressed',String(recording));
      button.setAttribute('aria-label',active?i18nText("ui.stop_screen_recording"):i18nText("ui.start_screen_recording"));
      button.innerHTML=`<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">${active?'<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>':'<circle cx="12" cy="12" r="8" fill="currentColor"/>'}</svg>`;
    };
    ctx.disposable(onLocaleChange(()=>{paint();void ctx.recording.setLocale?.(getLocale()).catch(error=>ctx.log.warn("Recorder locale update failed",error));}));
    const mount=():void=>{if(document.getElementById(ID))return;
      const canvas=document.getElementById('Syncord-multichat-toolbar-btn');const inbox=document.querySelector<HTMLElement>('[aria-label="Inbox"],[aria-label="Gelen Kutusu"]');
      const slot=canvas?.parentElement??inbox?.closest<HTMLElement>('[class*="iconWrapper"]')??inbox?.parentElement;if(!slot?.parentElement)return;
      tooltipDispose?.();wrapper?.remove();wrapper=document.createElement('div');wrapper.className=slot.className;
      const button=document.createElement('button');button.id=ID;button.type='button';button.addEventListener('click',()=>{void toggleRecorder();});wrapper.append(button);
      if(canvas)slot.after(wrapper);else slot.before(wrapper);
      tooltipDispose=bindTooltip(button,()=>button.getAttribute('aria-label')??i18nText("ui.screen_recorder"),{position:'bottom'});paint();
    };
    const observer=new BodyMutationObserver(()=>{if(document.getElementById(ID)||raf)return;raf=requestAnimationFrame(()=>{raf=0;mount();});});observer.observe(document.body,{childList:true,subtree:true});mount();window.addEventListener(RECORDER_EVENT,paint);
    ctx.disposable(()=>{observer.disconnect();if(raf)cancelAnimationFrame(raf);tooltipDispose?.();wrapper?.remove();window.removeEventListener(RECORDER_EVENT,paint);disposeRecordingLibrary();});
  },
});
