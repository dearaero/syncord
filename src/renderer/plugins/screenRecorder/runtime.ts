import { canonicalMessage, localizeError, localizeMessage, t as i18nText } from "../../i18n";
import { discordRecordingOptions } from "./discordAudio";
import type { RecordingStatus } from "../../../shared/recording";
import type { PluginContext } from "../../api/plugin/types";
import { showToast, ToastType } from "../../ui/toast";
import { recorderOptions, RECORDER_EVENT } from "./settings";
let context:PluginContext|undefined;
let status:RecordingStatus={phase:"idle",startedAt:null,bytes:0,detail:canonicalMessage("ui.ready_to_record"),id:null,systemAudio:false,directory:""};
let busy=false;let timer=0;let refreshing=false;let generation=0;
export function recorderState():RecordingStatus{return {...status};}
export function recorderEnabled():boolean{return !!context;}
export function recorderBridge(){if(!context)throw new Error("Enable Screen Recorder first.");return context.recording;}
function emit():void{window.dispatchEvent(new Event(RECORDER_EVENT));}
export function recorderBusy():boolean{return busy;}
export async function refreshRecorder():Promise<void>{
  if(!context||refreshing)return;refreshing=true;const current=generation;
  try{const next=await context.recording.status();if(current!==generation)return;
    const previous=status;status=next;
    if(previous.phase!==next.phase){
      if(next.phase==="recording")showToast(i18nText("ui.screen_recording_started"),{type:ToastType.SUCCESS});
      else if((previous.phase==="recording"||previous.phase==="stopping")&&next.phase==="idle")showToast(localizeMessage(next.detail),{type:ToastType.SUCCESS});
      else if(next.phase==="error")showToast(localizeMessage(next.detail),{type:ToastType.FAILURE,duration:7000});
    }emit();
  }catch{if(current===generation){status={...status,phase:"error",detail:canonicalMessage("ui.recorder_status_is_unavailable_restart_discord_after_updating")};emit();}}
  finally{refreshing=false;if(current===generation)schedule();}
}
function schedule():void{clearTimeout(timer);timer=0;if(context&&["choosing","starting","recording","stopping"].includes(status.phase))timer=window.setTimeout(()=>{void refreshRecorder();},1000);}
export async function toggleRecorder():Promise<void>{
  if(!context||busy)return;busy=true;emit();const ctx=context;const current=generation;
  try{
    let next:RecordingStatus;
    if(["choosing","starting","recording","stopping"].includes(status.phase))next=await ctx.recording.stop();
    else {
      // Query main at start as well: the first status refresh can still be in flight.
      const capability=await ctx.recording.status();
      if(current!==generation)return;
      status=capability;
      const options=discordRecordingOptions(recorderOptions());
      next=await ctx.recording.start(options);
    }
    if(current===generation){status=next;emit();schedule();}
    else await ctx.recording.stop();
  }catch(error){if(current===generation){status={...status,phase:"error",detail:error instanceof Error?error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""):i18nText("ui.recording_failed")};showToast(localizeError(status.detail),{type:ToastType.FAILURE,duration:7000});emit();}}
  finally{if(current===generation){busy=false;emit();}}
}
export function attachRecorder(ctx:PluginContext):()=>void{
  context=ctx;generation++;refreshing=false;void refreshRecorder();
  return()=>{generation++;clearTimeout(timer);timer=0;context=undefined;busy=false;void ctx.recording.stop(true).catch(()=>undefined);status={...status,phase:"idle",startedAt:null};emit();};
}
