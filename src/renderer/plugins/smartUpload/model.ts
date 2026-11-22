import {number as i18nNumber} from "../../i18n";
import { t as i18nText } from "../../i18n";
export const MIB=1024*1024;
export type MediaKind='image'|'video'|'audio';
export type Options={images:boolean;videos:boolean;audio:boolean;maxHeight:number};
export const DEFAULTS:Options={images:true,videos:true,audio:true,maxHeight:720};
export function options(raw:Partial<Options>):Options{return{images:raw.images!==false,videos:raw.videos!==false,audio:raw.audio!==false,maxHeight:[480,720,1080].includes(Number(raw.maxHeight))?Number(raw.maxHeight):720};}
export function kind(file:Pick<File,'type'|'name'>):MediaKind|undefined {
  const mime=file.type.toLowerCase().split(';')[0],ext=file.name.split('.').pop()?.toLowerCase();
  if(['image/jpeg','image/png','image/webp'].includes(mime)||(!mime&&['jpg','jpeg','png','webp'].includes(ext??'')))return'image';
  if(mime.startsWith('video/')||(!mime&&['mp4','mov','webm','mkv','m4v'].includes(ext??'')))return'video';
  if(mime.startsWith('audio/')||(!mime&&['mp3','wav','flac','ogg','opus','m4a','aac'].includes(ext??'')))return'audio';
  return;
}
export function eligible(file:File,config:Options,limit:number):boolean {const k=kind(file);return file.size>limit&&!!k&&(k==='image'?config.images:k==='video'?config.videos:config.audio);}
export function outputBudget(limit:number,count=1):number {if(!Number.isSafeInteger(limit)||limit<4096||!Number.isInteger(count)||count<1||count>25)throw Error("The upload limit could not be read safely.");return Math.floor(Math.min(limit*.94,64*MIB,128*MIB/count));}
export function fit(width:number,height:number,maxEdge:number):{width:number;height:number}{
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>33_554_432)throw Error("This image/video is too large to decode safely (maximum 32 megapixels).");
  const scale=Math.min(1,maxEdge/Math.max(width,height));return{width:Math.min(width,Math.max(2,Math.floor(width*scale/2)*2)),height:Math.min(height,Math.max(2,Math.floor(height*scale/2)*2))};
}
export function budget(duration:number,target:number,video:boolean,factor=1):{audio:number;video:number}{
  if(!Number.isFinite(duration)||duration<=0||duration>1800)throw Error("Choose a playable file with a duration of up to 30 minutes.");
  const total=Math.floor(target*8/duration*.82*factor);const audio=Math.min(96000,Math.floor(total*(video?.17:1)));
  if(audio<16000||(video&&total-audio<80000))throw Error("This duration cannot fit the limit at a usable quality. Trim the file and try again.");
  return{audio,video:video?Math.min(6_000_000,total-audio):0};
}
export function filename(name:string,extension:string):string {const base=name.replace(/\.[^.]*$/,'').replace(/[\x00-\x1f/\\]/g,'_').slice(0,160)||'media';return `${base}-optimized.${extension}`;}
export function size(bytes:number):string{return bytes>=MIB?i18nText("ui.value_mib", {v0: i18nNumber((bytes/MIB),{useGrouping:false,minimumFractionDigits:2,maximumFractionDigits:2})}):i18nText("ui.value_kib", {v0: Math.ceil(bytes/1024)});}
