import { h, localizeError, messageHtml as i18nHtml, setLocalizedAttribute, setLocalizedHtml, setLocalizedText, t as i18nText } from "../../i18n";
import type { RecordingBridge, RecordingItem, RecordingPlayback } from "../../../shared/recording";
let activeClose: (() => void) | undefined;
export function closeRecordingPlayer(): void { activeClose?.(); }

type Session = { source: MediaSource; buffer?: SourceBuffer; controller: AbortController;
  url: string; position: number; goal: number; resume: boolean; internalSeek: boolean; busy: boolean; ready: boolean };
function bufferOperation(session: Session, action: () => void): Promise<void> {
  return new Promise((resolve,reject)=>{
    const buffer=session.buffer;const signal=session.controller.signal;
    if(!buffer||signal.aborted){reject(new DOMException("Preview closed","AbortError"));return;}
    const cleanup=():void=>{buffer.removeEventListener("updateend",done);buffer.removeEventListener("error",error);signal.removeEventListener("abort",abort);};
    const done=():void=>{cleanup();resolve();};
    const error=():void=>{cleanup();reject(new Error("This video could not be decoded."));};
    const abort=():void=>{cleanup();reject(new DOMException("Preview closed","AbortError"));};
    buffer.addEventListener("updateend",done,{once:true});buffer.addEventListener("error",error,{once:true});signal.addEventListener("abort",abort,{once:true});
    try{action();}catch(reason){cleanup();reject(reason);}
  });
}
export function openRecordingPlayer(item: RecordingItem, bridge: RecordingBridge): void {
  closeRecordingPlayer();const previous=document.activeElement;
  const dialog=document.createElement("dialog");dialog.className="Syncord-recording-player";setLocalizedAttribute(dialog, "aria-label", "ui.recording_preview");
  setLocalizedHtml(dialog, `<header><h2></h2><div><button type="button" data-player-folder>${i18nHtml("ui.show_in_folder")}</button><button type="button" data-player-close aria-label="${h("ui.close_recording_preview")}" data-si18n-aria-label="ui.close_recording_preview">×</button></div></header><video controls playsinline preload="metadata" disablepictureinpicture controlslist="nodownload noremoteplayback"></video><p role="status">${i18nHtml("ui.loading_recording")}</p>`);
  dialog.querySelector("h2")!.textContent=item.name;
  const video=dialog.querySelector("video")!;video.disableRemotePlayback=true;
  const status=dialog.querySelector<HTMLElement>('[role="status"]')!;
  let closed=false,failed=false;let descriptor:RecordingPlayback|undefined;let session:Session|undefined;
  let reads=Promise.resolve();
  const cancelSession=():void=>{if(!session)return;session.controller.abort();try{if(session.buffer?.updating)session.buffer.abort();}catch{/* detached */}
    video.pause();video.removeAttribute("src");video.load();URL.revokeObjectURL(session.url);session=undefined;};
  const close=():void=>{if(closed)return;closed=true;cancelSession();if(descriptor)void bridge.closePlayback(descriptor.token).catch(()=>undefined);
    dialog.close();dialog.remove();activeClose=undefined;if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};
  activeClose=close;
  const fail=(error:unknown):void=>{if(closed||failed)return;failed=true;cancelSession();if(descriptor)void bridge.closePlayback(descriptor.token).catch(()=>undefined);
    status.textContent=error instanceof Error?localizeError(error):i18nText("ui.this_recording_could_not_be_played_try_opening_it_from_its_folder");};
  const read=async(position:number):Promise<ArrayBuffer>=>{
    let result:ArrayBuffer|undefined;const next=reads.then(async()=>{if(closed||!descriptor)throw new Error("Preview closed.");result=await bridge.readPlayback(descriptor.token,position);});
    reads=next.catch(()=>undefined);await next;if(!result?.byteLength)throw new Error("The recording changed or ended unexpectedly.");return result;
  };
  const pump=async(current:Session):Promise<void>=>{
    if(closed||failed||session!==current||!current.ready||current.busy||!descriptor)return;current.busy=true;
    try{while(!closed&&!failed&&session===current&&current.position<descriptor.size){
      const buffer=current.buffer!;
      const end=buffer.buffered.length?buffer.buffered.end(buffer.buffered.length-1):0;
      if(end-Math.max(video.currentTime,current.goal)>20)break;
      if(video.currentTime>12&&buffer.buffered.length&&buffer.buffered.start(0)<video.currentTime-10){await bufferOperation(current,()=>buffer.remove(0,video.currentTime-10));}
      const bytes=await read(current.position);if(session!==current||current.controller.signal.aborted)return;
      await bufferOperation(current,()=>buffer.appendBuffer(bytes));current.position+=bytes.byteLength;
      if(current.internalSeek&&video.readyState>=1){video.currentTime=current.goal;if(current.resume)void video.play().catch(()=>undefined);}
      status.textContent="";
    }
    if(session===current&&current.position>=descriptor.size&&current.source.readyState==="open"&&!current.buffer?.updating)current.source.endOfStream();
    }catch(error){if(session===current&&!current.controller.signal.aborted)fail(error);}
    finally{current.busy=false;}
  };
  const startAt=(goal:number,resume:boolean):void=>{
    if(!descriptor||closed||failed)return;cancelSession();
    let point=descriptor.points[0];for(const candidate of descriptor.points){if(candidate.time>goal)break;point=candidate;}
    const source=new MediaSource();const url=URL.createObjectURL(source);
    const current:Session={source,controller:new AbortController(),url,position:point.offset,goal,resume,internalSeek:true,busy:false,ready:false};session=current;
    source.addEventListener("sourceopen",()=>{void(async()=>{
      try{if(session!==current||closed)return;current.buffer=source.addSourceBuffer(descriptor!.mimeType);
        await bufferOperation(current,()=>current.buffer!.appendBuffer(descriptor!.header));
        if(session!==current)return;source.duration=descriptor!.duration;current.ready=true;await pump(current);
      }catch(error){if(session===current&&!current.controller.signal.aborted)fail(error);}
    })();},{once:true,signal:current.controller.signal});video.src=url;
  };
  const buffered=(time:number):boolean=>{for(let i=0;i<video.buffered.length;i++)if(video.buffered.start(i)<=time+.1&&video.buffered.end(i)>=time)return true;return false;};
  video.addEventListener("seeking",()=>{const current=session;if(!current||!descriptor||!current.ready)return;
    if(current.internalSeek&&Math.abs(video.currentTime-current.goal)<.25)return;
    if(!buffered(video.currentTime))startAt(Math.min(video.currentTime,descriptor.duration-.01),!video.paused);
  });
  video.addEventListener("seeked",()=>{if(session)session.internalSeek=false;});
  for(const event of ["timeupdate","waiting","play"])video.addEventListener(event,()=>{if(session)void pump(session);});
  video.addEventListener("error",()=>{if(video.getAttribute("src"))fail(new Error("This recording could not be decoded. Open its folder to try another player."));});
  dialog.querySelector('[data-player-close]')!.addEventListener("click",close);
  dialog.addEventListener("cancel",event=>{event.preventDefault();close();});
  dialog.querySelector('[data-player-folder]')!.addEventListener("click",()=>{void bridge.reveal(item.id).catch(()=>{setLocalizedText(status, "ui.could_not_open_the_file_location");});});
  document.body.append(dialog);dialog.showModal();
  void bridge.play(item.id).then(opened=>{if(closed){void bridge.closePlayback(opened.token).catch(()=>undefined);return;}
    descriptor=opened;if(typeof MediaSource==="undefined"||!MediaSource.isTypeSupported(opened.mimeType)){fail(new Error("This Discord build cannot play this recording inside the client. You can still open its folder."));return;}startAt(0,false);
  }).catch(error=>{if(!closed)fail(error);});
}
