import { localizeError, t as i18nText } from "../../i18n";
import {definePlugin} from '../../api/plugin';
import {registerUploadPreparer,prepareUploadFiles} from '../../ui/uploadPreparation';
import {reviewFiles,cancelSmartUpload,CSS} from './ui';
import {currentAccount,selectedChannel,validChannel,uploadLimit} from './discord';
import {smartOptions,SMART_ID} from './settings';
import {eligible} from './model';
import {getFiber} from '../../ui/userNames';
import {showToast,ToastType} from '../../ui/toast';
const COMPOSER='[class*="channelTextArea_"],[class*="channelTextArea__"],[class*="chatContent_"],[class*="chatContent__"],[data-smart-upload-composer]';
const EXCLUDE='#Syncord-settings-root,[data-mc-pane],.Syncord-smart-upload,[role="dialog"]';
/** A portal's DOM parent is not its React owner. Read the nearest explicit channel before considering the selected chat. */
function fiberChannel(element:HTMLElement):string|undefined{
 let fiber=getFiber(element);for(let depth=0;fiber&&depth<48;depth++,fiber=fiber.return??null){const props=fiber.memoizedProps??fiber.pendingProps,channel=props?.channel as {id?:unknown}|undefined;const id=channel?.id??props?.channelId;if(typeof id==='string'&&validChannel(id))return id;}
}
/** A sidebar thread/popout can differ from the globally selected channel. */
export function composerChannel(element:HTMLElement):string|undefined{
 const id=fiberChannel(element);if(id)return id;
 if(element.closest('[class*="threadSidebar"],[data-thread-id]'))return;
 return selectedChannel();
}
function uploadChannel(element:HTMLElement,input:HTMLInputElement|undefined,eventType:string):string|undefined{
 if(element.closest(EXCLUDE))return;
 if(element.closest(COMPOSER))return composerChannel(element);
 // Discord's attachment-menu FileInput is rendered in a portal, not below
 // channelTextArea/chatContent. Never guess its destination from the current
 // route: the native owner's channel also covers sidebar threads correctly.
 if(input)return fiberChannel(element);
 // Discord also accepts drops on the conversation's outer upload surface.
 if(eventType==='drop'&&element.closest('[class*="chat_"],[class*="chat__"],[class*="uploadArea_"],[class*="uploadArea__"]'))return fiberChannel(element);
}
export const SmartUploadPlugin=definePlugin({
 id:SMART_ID,name:i18nText("ui.smart_upload"),author:i18nText("ui.syncord"),enabledByDefault:true,
 get description() { return i18nText("ui.optimize_oversized_images_videos_and_audio_on_this_device_and_compare_"); },
 permissions:{media:true,userData:true,discordStores:['user','channel','UserStore','ChannelStore','SelectedChannelStore']},
 start(ctx){
  ctx.css.inject(CSS);const unregister=registerUploadPreparer(reviewFiles),replays=new WeakSet<Event>();let stopped=false;
  const capture=(event:Event):void=>{
   if(stopped||replays.has(event)||event.defaultPrevented)return;const element=event.target;if(!(element instanceof HTMLElement))return;
   const input=event.type==='change'&&element instanceof HTMLInputElement&&element.type==='file'?element:undefined;
   const transfer=event instanceof DragEvent?event.dataTransfer:event instanceof ClipboardEvent?event.clipboardData:undefined;
   const files=Array.from(input?.files??transfer?.files??[]);if(!files.length)return;
   const channelId=uploadChannel(element,input,event.type),account=currentAccount();if(!channelId||!account||!validChannel(channelId))return;const selectedAtStart=selectedChannel(),limit=uploadLimit(channelId),config=smartOptions();if(!files.some(file=>eligible(file,config,limit.bytes)))return;
   // Snapshot textual clipboard/drop data now: the browser protects it after dispatch ends.
   const text=transfer?transfer.types.filter(type=>type!=='Files').map(type=>[type,transfer.getData(type)] as const):[];
   event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();
   const valid=():boolean=>!stopped&&element.isConnected&&currentAccount()===account&&uploadChannel(element,input,event.type)===channelId&&selectedChannel()===selectedAtStart;
   void prepareUploadFiles(files,{channelId,valid}).then(result=>{
    if(!result||!valid()){if(input&&input.isConnected)input.value='';return;}
    const data=new DataTransfer();for(const [type,value]of text)data.setData(type,value);for(const file of result)data.items.add(file);
    const replay=input?new Event('change',{bubbles:true,cancelable:true}):event.type==='paste'?new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}):new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data});
    if(input)input.files=data.files;replays.add(replay);element.dispatchEvent(replay);
   }).catch(error=>{if(input&&input.isConnected)input.value='';ctx.log.warn('Smart Upload could not prepare this selection',error);showToast(error instanceof Error?localizeError(error):i18nText("ui.smart_upload_failed_select_the_original_files_again"),{type:ToastType.FAILURE});});
  };
  // Run before React's delegated root/document handlers perform Nitro checks.
  for(const type of ['change','drop','paste'])window.addEventListener(type,capture,true);
  ctx.disposable(()=>{stopped=true;for(const type of ['change','drop','paste'])window.removeEventListener(type,capture,true);unregister();cancelSmartUpload();});
 },
});
