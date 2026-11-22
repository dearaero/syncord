import {isSupportedLocale, type Locale} from "../shared/i18nLocale";
import {nativeMessage,nativeError} from "../shared/nativeI18n";
/** Runs only in a main-owned local capture/device window, never in Discord's page. */
import { ipcRenderer } from "electron";
import { RECORDING_IPC, type RecordingWorkerInit } from "../shared/recording";

const CSS = `:root{color-scheme:dark;font:15px system-ui;background:#1e1f22;color:#f2f3f5}*{box-sizing:border-box}body{margin:0;padding:20px}h1{font-size:20px;margin:0 0 8px}p{color:#b5bac1}button{font:inherit;border:0;border-radius:8px;padding:10px 14px;background:#5865f2;color:white;cursor:pointer}button:focus-visible{outline:2px solid #fff;outline-offset:3px}button:disabled{opacity:.5;cursor:default}#sources{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin:18px 0}#sources button{display:flex;flex-direction:column;gap:8px;text-align:left;background:#2b2d31;min-width:0}#sources img{width:100%;aspect-ratio:16/9;object-fit:contain;background:#111;border-radius:5px}#sources span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%}video{width:100%;max-height:calc(100vh - 160px);background:#111;border-radius:8px}header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}header h1{margin:0}#status{white-space:pre-wrap}#recording-begin{display:none}`;
const MAX_PENDING = 16 * 1024 * 1024;
const CHUNK_SIZE = 2 * 1024 * 1024;

export function bootstrapRecordingWindow(): void {
  window.addEventListener("DOMContentLoaded",()=>{void boot();},{once:true});
}
async function boot(): Promise<void> {
  const root=document.getElementById("recording-app");if(!root)return;
  const style=document.createElement("style");style.textContent=CSS;document.head.append(style);
  let locale: Locale='en-US';let revision=-1;
  const bindings = new Map<Element,()=>void>();
  const text=(element:Element|null,key:string,params:()=>Readonly<Record<string,string|number>>=()=>({})):void=>{
    if(!element)return;const update=():void=>{element.textContent=nativeMessage(locale,key,params());};bindings.set(element,update);update();
  };
  const refresh=():void=>{document.documentElement.lang=locale;document.documentElement.dir=locale==='fa'?'rtl':'ltr';for(const update of bindings.values())update();};
  const acceptLocale=(raw:unknown):void=>{if(!raw||typeof raw!=='object')return;const state=raw as {locale?:unknown;revision?:unknown};
    if(!isSupportedLocale(state.locale)||typeof state.revision!=='number'||!Number.isSafeInteger(state.revision)||state.revision<0||state.revision<revision||(state.revision===revision&&state.locale!==locale))return;
    locale=state.locale;revision=state.revision;refresh();
  };
  const changed=(_event:unknown,state:unknown):void=>acceptLocale(state);
  ipcRenderer.on(RECORDING_IPC.LOCALE,changed);
  window.addEventListener('beforeunload',()=>ipcRenderer.removeListener(RECORDING_IPC.LOCALE,changed),{once:true});
  try {
    const init=await ipcRenderer.invoke(RECORDING_IPC.INIT) as RecordingWorkerInit;
    acceptLocale(init);
    if(init.role==="devices"){
      root.innerHTML='<h1></h1><p></p><button type="button"></button><p role="status"></p>';
      text(root.querySelector('h1'),'native.recorder_audio_devices');text(root.querySelector('p'),'native.recorder_devices_help');text(root.querySelector('button'),'native.recorder_list_inputs');
      root.querySelector("button")!.addEventListener("click",()=>{void(async()=>{let probe:MediaStream|undefined;
        try{probe=await navigator.mediaDevices.getUserMedia({audio:true,video:false});const devices=await navigator.mediaDevices.enumerateDevices();
          const inputs=devices.filter(d=>d.kind==="audioinput"&&d.deviceId!=="default"&&d.deviceId!=="communications"&&d.label).slice(0,128).map(d=>({label:d.label}));
          probe.getTracks().forEach(t=>t.stop());probe=undefined;await ipcRenderer.invoke(RECORDING_IPC.DEVICES_RESULT,inputs);
        }catch{text(root.querySelector('[role=status]'),'native.recorder_inputs_unavailable');}
        finally{probe?.getTracks().forEach(t=>t.stop());}
      })();});return;
    }
    root.innerHTML='<h1></h1><p id="summary"></p><div id="sources"></div><p id="status" role="status"></p><button id="recording-begin" type="button"></button>';
    text(root.querySelector('h1'),'native.recorder_choose_source');text(root.querySelector('#recording-begin'),'native.recorder_record');
    text(root.querySelector('#summary'),'native.recorder_summary',()=>({resolution:init.options.resolution,fps:init.options.fps,
      microphone:nativeMessage(locale,init.options.microphone?'native.recorder_on':'native.recorder_off'),output:nativeMessage(locale,init.options.output?'native.recorder_on':'native.recorder_off')}));
    const status=root.querySelector("#status")!;
    const sources=root.querySelector("#sources")!;
    let statusKey="";bindings.set(status,()=>{status.textContent=failureReason?nativeError(locale,failureReason):statusKey?nativeMessage(locale,statusKey):"";});
    const streams:MediaStream[]=[];
    let recorder:MediaRecorder|undefined;
    let audio:AudioContext|undefined;
    let queue=Promise.resolve();let pending=0;let sequence=0;let failed=false;let failureReason="";let started=0;let ended=false;let starting=false;let stopRequested=false;
    const release=():void=>{for(const stream of streams)for(const track of stream.getTracks())track.stop();void audio?.close().catch(()=>undefined);};
    const failure=(message:string):void=>{if(failed)return;failed=true;failureReason=message;status.textContent=nativeError(locale,message);release();
      if(recorder && recorder.state!=="inactive")recorder.stop();else void ipcRenderer.invoke(RECORDING_IPC.ERROR,message).catch(()=>undefined);};
    const stop=():void=>{stopRequested=true;if(recorder && recorder.state!=="inactive")recorder.stop();else if(!starting){release();void ipcRenderer.invoke(RECORDING_IPC.FINISH,failed).catch(()=>undefined);}};
    ipcRenderer.on(RECORDING_IPC.WORKER_STOP,stop);
    window.addEventListener("beforeunload",()=>{release();ipcRenderer.removeListener(RECORDING_IPC.WORKER_STOP,stop);},{once:true});
    const acquire=async (promise:Promise<MediaStream>):Promise<MediaStream>=>{const stream=await promise;streams.push(stream);
      if(stopRequested||failed){release();throw new Error("Recording cancelled.");}return stream;};
    for(const source of init.sources){
      const button=document.createElement("button");button.type="button";
      const image=document.createElement("img");image.src=source.thumbnail;image.alt="";
      const name=document.createElement("span");name.textContent=source.name;button.append(image,name);sources.append(button);
      button.addEventListener("click",()=>{sources.querySelectorAll("button").forEach(b=>b.disabled=true);statusKey="native.recorder_starting";status.textContent=nativeMessage(locale,statusKey);
        const sourceId=source.id;init.sources.length=0;sources.replaceChildren();
        void ipcRenderer.invoke(RECORDING_IPC.SELECT,sourceId).catch((error:unknown)=>failure(error instanceof Error?error.message:"Could not select this screen."));});
    }
    document.getElementById("recording-begin")!.addEventListener("click",()=>{if(starting||recorder)return;starting=true;
      void (async()=>{
        try{
          const options=init.options;
          // Create/resume from this gesture before asynchronous device prompts.
          if(options.microphone||options.output){audio=new AudioContext();await audio.resume();}
          // Include Discord playback and keep speakers audible while recording.
          const display=await acquire(navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:options.fps,max:options.fps}},audio:options.output&&!options.outputDevice?({restrictOwnAudio:false,suppressLocalAudioPlayback:false} as MediaTrackConstraints):false}));
          const video=display.getVideoTracks()[0];if(!video)throw new Error("No video track was granted.");
          const original=video.getSettings();const maxWidth=Math.round(options.resolution*16/9);
          const factor=original.width&&original.height?Math.min(1,maxWidth/original.width,options.resolution/original.height):1;
          await video.applyConstraints({width:{...(original.width?{ideal:Math.max(1,Math.round(original.width*factor))}:{}),max:maxWidth},
            height:{...(original.height?{ideal:Math.max(1,Math.round(original.height*factor))}:{}),max:options.resolution},
            ...(original.width&&original.height?{aspectRatio:{ideal:original.width/original.height}}:{}),frameRate:{ideal:options.fps,max:options.fps}});
          video.addEventListener("ended",stop,{once:true});
          const audioStreams:MediaStream[]=[];
          let inputs:MediaDeviceInfo[]=[];
          if((options.microphone&&options.microphoneDevice.startsWith("label:"))||(options.output&&options.outputDevice.startsWith("label:"))){
            const probe=await acquire(navigator.mediaDevices.getUserMedia({audio:true,video:false}));
            inputs=await navigator.mediaDevices.enumerateDevices();probe.getTracks().forEach(t=>t.stop());
          }
          const currentDevice=(key:string):string=>{if(!key.startsWith("label:"))return key;
            const matches=inputs.filter(d=>d.kind==="audioinput"&&d.label===key.slice(6)&&d.deviceId!=="default"&&d.deviceId!=="communications");
            if(matches.length!==1)throw new Error("Discord's selected microphone is unavailable or ambiguous. Check Discord Voice & Video settings.");return matches[0].deviceId;};
          if(options.output&&!options.outputDevice){if(!display.getAudioTracks().length)throw new Error("Output audio was not granted. Check operating system recording permissions for Discord, or turn Record output audio off.");audioStreams.push(display);}
          if(options.output&&options.outputDevice){audioStreams.push(await acquire(navigator.mediaDevices.getUserMedia({audio:{deviceId:{exact:currentDevice(options.outputDevice)},echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false})));}
          if(options.microphone){audioStreams.push(await acquire(navigator.mediaDevices.getUserMedia({audio:{...(options.microphoneDevice?{deviceId:{exact:currentDevice(options.microphoneDevice)}}:{}),echoCancellation:true,noiseSuppression:true},video:false})));}
          const tracks:MediaStreamTrack[]=[video];
          if(audio&&audioStreams.length){const destination=audio.createMediaStreamDestination();
            for(const stream of audioStreams){if(!stream.getAudioTracks().length||stream.getAudioTracks().some(track=>track.readyState!=="live"))throw new Error("Requested audio capture is unavailable. Check operating system recording permissions for Discord.");
              const source=audio.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));const gain=audio.createGain();gain.gain.value=audioStreams.length>1?.7:1;source.connect(gain).connect(destination);
              for(const track of stream.getAudioTracks())track.addEventListener("ended",()=>failure("An audio input disconnected; recording stopped."),{once:true});}
            streams.push(destination.stream);tracks.push(...destination.stream.getAudioTracks());
          }
          const mime=["video/webm;codecs=vp8,opus","video/webm;codecs=vp8","video/webm"].find(type=>MediaRecorder.isTypeSupported(type));
          if(!mime)throw new Error("This Discord build has no WebM recorder support.");
          const bitrate=options.resolution<=720?2_500_000:options.resolution<=1080?5_000_000:options.resolution<=1440?8_000_000:12_000_000;
          recorder=new MediaRecorder(new MediaStream(tracks),{mimeType:mime,videoBitsPerSecond:bitrate,audioBitsPerSecond:128_000});
          recorder.addEventListener("dataavailable",event=>{if(!event.data.size||failed)return;
            pending+=event.data.size;
            if(pending>MAX_PENDING){failure("Disk writing is too slow; recording stopped to protect memory.");return;}
            const blob=event.data;
            queue=queue.then(async()=>{for(let offset=0;offset<blob.size;offset+=CHUNK_SIZE){const bytes=new Uint8Array(await blob.slice(offset,offset+CHUNK_SIZE).arrayBuffer());await ipcRenderer.invoke(RECORDING_IPC.CHUNK,sequence++,bytes);}})
              .catch(()=>failure("Could not save the recording. Check free disk space."))
              .finally(()=>{pending-=blob.size;});
          });
          recorder.addEventListener("error",()=>failure("Video encoding failed; recording stopped."));
          recorder.addEventListener("stop",()=>{if(ended)return;ended=true;const durationMs=started?performance.now()-started:0;release();void queue.then(()=>ipcRenderer.invoke(RECORDING_IPC.FINISH,failed,durationMs,failureReason)).catch(()=>undefined);},{once:true});
          if(stopRequested){release();await ipcRenderer.invoke(RECORDING_IPC.FINISH,false);return;}
          const actual=video.getSettings();
          await ipcRenderer.invoke(RECORDING_IPC.READY,{width:actual.width??0,height:actual.height??0,fps:actual.frameRate??options.fps,microphone:options.microphone,output:options.output});
          started=performance.now();recorder.start(1000);
        }catch(error){failure(error instanceof Error?error.message:"Capture failed. Check operating system screen and microphone permissions.");}
        finally{starting=false;if(stopRequested&&!recorder)stop();}
      })();
    });
  }catch(error){const message=error instanceof Error?error.message:"Recorder could not initialize.";bindings.set(root,()=>{root.textContent=nativeError(locale,message);});refresh();}
}
