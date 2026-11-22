import { settings } from "../../api/settings";
import { DEFAULT_RECORDING_OPTIONS, parseRecordingOptions, type RecordingOptions } from "../../../shared/recording";
export const RECORDER_ID = "screen-recorder";
export const RECORDER_EVENT = "Syncord-screen-recorder-change";
export function recorderOptions(): RecordingOptions {
  const raw={...DEFAULT_RECORDING_OPTIONS};
  for(const key of Object.keys(raw) as (keyof RecordingOptions)[])Object.assign(raw,{[key]:settings.get(`plugins.${RECORDER_ID}.data.${key}`,raw[key])});
  try{return parseRecordingOptions(raw);}catch{return {...DEFAULT_RECORDING_OPTIONS};}
}
export function setRecorderOption(key:keyof RecordingOptions,value:string|number|boolean):void{
  const valid=parseRecordingOptions({...recorderOptions(),[key]:value});
  settings.set(`plugins.${RECORDER_ID}.data.${key}`,valid[key]);
  window.dispatchEvent(new Event(RECORDER_EVENT));
}
