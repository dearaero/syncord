import { h, localizeError, messageHtml as i18nHtml, setLocalizedAttribute, setLocalizedHtml, setLocalizedText, t as i18nText } from "../../i18n";
import { closeRecordingPlayer, openRecordingPlayer } from "./player";
import { recorderBridge } from "./runtime";
import { showToast, ToastType } from "../../ui/toast";
let closeLibrary:(()=>void)|undefined;
export function disposeRecordingLibrary():void{closeRecordingPlayer();closeLibrary?.();}
export function openRecordingLibrary():void{
  closeLibrary?.();const bridge=recorderBridge();const previous=document.activeElement;
  const dialog=document.createElement("dialog");dialog.className="Syncord-recording-library";
  setLocalizedAttribute(dialog, "aria-label", "ui.local_recordings");
  setLocalizedHtml(dialog, `<header><h2>${i18nHtml("ui.recordings")}</h2><div><button type="button" data-folder>${i18nHtml("ui.open_folder")}</button><button type="button" data-close aria-label="${h("ui.close_recordings")}" data-si18n-aria-label="ui.close_recordings">×</button></div></header><p data-directory></p><div data-videos></div><footer><span role="status"></span><button type="button" data-more hidden>${i18nHtml("ui.load_more")}</button></footer>`);
  const list=dialog.querySelector<HTMLElement>('[data-videos]')!;const text=dialog.querySelector<HTMLElement>('[role=status]')!;
  const more=dialog.querySelector<HTMLButtonElement>('[data-more]')!;
  let before:string|undefined;let closed=false;let loading=false;
  const close=():void=>{if(closed)return;closed=true;closeRecordingPlayer();dialog.close();dialog.remove();closeLibrary=undefined;if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};
  closeLibrary=close;dialog.querySelector('[data-close]')!.addEventListener('click',close);
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  const report=(error:unknown):void=>showToast(error instanceof Error?localizeError(error):i18nText("ui.could_not_open_this_recording"),{type:ToastType.FAILURE});
  dialog.querySelector('[data-folder]')!.addEventListener('click',()=>{void bridge.reveal().catch(report);});
  const load=async():Promise<void>=>{if(loading||closed)return;loading=true;more.disabled=true;setLocalizedText(text, "ui.loading_recordings");
    try{const page=await bridge.list(before);if(closed)return;dialog.querySelector('[data-directory]')!.textContent=page.directory;
      for(const item of page.items){const row=document.createElement('article');setLocalizedHtml(row, `<div><h3></h3><p></p></div><div><button type="button" data-play>${i18nHtml("ui.play")}</button><button type="button" data-reveal>${i18nHtml("ui.show_in_folder")}</button></div>`);
        row.querySelector('h3')!.textContent=item.name;
        setLocalizedText(row.querySelector('p')!, "ui.value_mb_value_value_value_valuevalue", {v0: Math.round(item.bytes/1024/1024*10)/10, v1: Math.floor(item.durationMs/60000), v2: String(Math.floor(item.durationMs/1000)%60).padStart(2,'0'), v3: item.width, v4: item.height, v5: item.recovered?i18nText("ui.interrupted_recording"):''});
        row.querySelector('[data-play]')!.addEventListener('click',()=>{openRecordingPlayer(item,bridge);});row.querySelector('[data-reveal]')!.addEventListener('click',()=>{void bridge.reveal(item.id).catch(report);});list.append(row);}
      before=page.next??undefined;more.hidden=!page.next;text.textContent=list.children.length?i18nText("ui.stored_on_this_computer_only"):i18nText("ui.no_recordings_yet_use_start_recording_to_create_one");
    }catch(error){if(!closed)text.textContent=error instanceof Error?localizeError(error):i18nText("ui.could_not_load_recordings");}
    finally{loading=false;more.disabled=false;}};
  more.addEventListener('click',()=>{void load();});document.body.append(dialog);dialog.showModal();void load();
}
