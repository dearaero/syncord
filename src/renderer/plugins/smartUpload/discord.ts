import { canonicalMessage as i18nText } from "../../i18n";
import {MIB} from './model';
type Bag=Record<string,unknown>;
const object=(v:unknown):v is Bag=>v!==null&&typeof v==='object';
function store<T>(name:string):T|undefined{return (window.Syncord?.common?.stores as unknown as Bag|undefined)?.[name] as T|undefined??window.Syncord?.webpack?.findByStoreName?.(name) as T|undefined;}
export function currentAccount():string|undefined {try{return store<{getCurrentUser?:()=>{id?:string}}> ('UserStore')?.getCurrentUser?.()?.id;}catch{return;}}
export function selectedChannel():string|undefined{try{return store<{getChannelId?:()=>string}>('SelectedChannelStore')?.getChannelId?.();}catch{return;}}
export function validChannel(id:string):boolean {try{const channel=store<{getChannel?:(id:string)=>{type?:number}}> ('ChannelStore')?.getChannel?.(id);return !!channel&&[0,1,3,5,10,11,12].includes(channel.type??-1);}catch{return false;}}
type UploadTarget={getMaxFileSize:(id:string)=>unknown};
export function channelLabel(id:string):string{
 try{const channel=store<{getChannel?:(id:string)=>{name?:string;type?:number;recipients?:string[]}}>('ChannelStore')?.getChannel?.(id);if(channel?.type===1&&channel.recipients?.[0]){const user=store<{getUser?:(id:string)=>{globalName?:string;username?:string}}>('UserStore')?.getUser?.(channel.recipients[0]);return user?.globalName||user?.username||channel.name||i18nText("ui.direct_message_cd3e160");}if(channel?.name)return channel.type===3?channel.name:'#'+channel.name;}catch{/* Missing native labels never affect the captured destination. */}return 'Channel '+id;
}
let target:UploadTarget|undefined;
/** Resolve the native MESSAGE_ATTACHMENT target through its semantic enum, never a minified export name or factory require. */
export function uploadLimit(channelId:string):{bytes:number;native:boolean}{
  try{
    if(!target){const module=window.Syncord?.webpack?.find(value=>object(value)&&Object.values(value).some(v=>object(v)&&v.MESSAGE_ATTACHMENT===0&&v.GUILD_PRODUCT_ATTACHMENT===1&&v.GRAVITY_ATTACHMENT===2));
      if(object(module))for(const candidate of Object.values(module)){if(typeof candidate!=='function')continue;const result=candidate(0) as unknown;
        if(object(result)&&typeof result.getMaxFileSize==='function'&&typeof result.getCreateAttachmentURL==='function'&&typeof result.getMaxAttachmentsCount==='function'){target=result as UploadTarget;break;}}
    }
    const value=target?.getMaxFileSize(channelId);if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=4096&&value<=4*1024*MIB)return{bytes:value,native:true};
  }catch{/* A lazy/changed native target cannot decide our fallback size. */}
  return{bytes:8*MIB,native:false};
}
