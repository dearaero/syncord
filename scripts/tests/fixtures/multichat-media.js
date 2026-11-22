import {setLocale,t,SUPPORTED_LOCALES} from "../../../src/renderer/i18n";
window.canvasI18n={setLocale,t,SUPPORTED_LOCALES};
import { installNativePickerFixture } from "./native-expression-picker";
import { openMultiChatCanvas, closeMultiChatCanvas, disposeMultiChatCanvas } from '../../../src/renderer/plugins/multiChatCanvas/canvas';
import { MULTICHAT_CSS } from '../../../src/renderer/plugins/multiChatCanvas/styles';

document.head.appendChild(Object.assign(document.createElement('style'), {textContent:MULTICHAT_CSS}));
const messages = Array.from({length:window.workspaceMessageCount??1},(_,i)=>({id:`m${i+1}`,content:window.workspaceMessageCount?`Message ${i+1}: this conversation stays in place while switching layouts.`:'hello',author:{id:'user',username:'User'},timestamp:new Date().toISOString()}));
const channels = Object.fromEntries(['a','b'].map(id => [id,{id,name:id.toUpperCase(),recipients:[`recipient-${id}`],type:1,getGuildId:()=>undefined}]));
const emoji = {id:'123456',name:'party',animated:true};
const staticEmoji = {id:'1425993161108357191',name:'R53KPTN',animated:false};
const emojiStore = {
  searchWithoutFetchingLatest: options => {
    window.emojiQueries.push(options.channel.id);
    const all = [{name:'smile',surrogates:'😄'}, emoji, staticEmoji];
    return {unlocked:all.filter(e=>e.name.includes(options.query)), locked:[{id:'999',name:'locked'}]};
  },
  getCustomEmojiById:id=>[emoji,staticEmoji].find(item=>item.id===id),
};
class Upload {
  constructor(item,channelId){this.item=item;this.channelId=channelId;this.listeners={};}
  on(event,listener){this.listeners[event]=listener;}
  trackUploadFinished(){}
  upload(){}
  cancel(){window.cancelledUploads++;}
}
window.saved = {version:1,paneCount:2,panes:[{id:'pane-1',channelId:'a'},{id:'pane-2',channelId:'b'}]};
window.sent=[]; window.routes=[]; window.emojiQueries=[]; window.mode='success'; window.cancelledUploads=0;
window.gifRequests=[]; window.failGifs=false; window.blockEmoji=false;
window.blobsCreated=[]; window.blobsRevoked=[];
const create=URL.createObjectURL.bind(URL), revoke=URL.revokeObjectURL.bind(URL);
URL.createObjectURL=blob=>{const url=create(blob);window.blobsCreated.push(url);return url;};
URL.revokeObjectURL=url=>{window.blobsRevoked.push(url);revoke(url);};
const actions = {
  fetchMessages:async()=>{},
  async sendMessage(channelId,message,wait,options){
    window.sent.push({channelId,content:message.content,stickers:options.stickerIds??[],files:(options.attachmentsToUpload??[]).map(u=>({name:u.item.file.name,channelId:u.channelId,platform:u.item.platform})),reply:options.messageReference,emojis:message.validNonShortcutEmojis});
    for(const upload of options.attachmentsToUpload??[]) upload.listeners.progress?.(50,100);
    if(window.mode==='delay') return new Promise(resolve=>window.finishSend=()=>resolve({ok:true,body:{id:'sent'}}));
    if(window.mode==='throw') throw new Error('Network unavailable');
    if(window.mode==='resolved-error') return {ok:false,status:403,body:{message:'Missing permissions'}};
    if(window.mode==='upload-error'){options.onAttachmentUploadError({},40005,{msg:'File too large'});return;}
    if(window.mode==='unconfirmed') return;
    return {ok:true,body:{id:'sent'}};
  },
};
const nativePicker=installNativePickerFixture(emojiStore);
window.Syncord={
  common:{flux:{},react:{React:nativePicker.React,ReactDOM:nativePicker.ReactDOM},
    stores:{UserStore:{getUser:id=>({id,username:id,getAvatarURL:()=>`https://example.com/avatar-${id}.png`})},ChannelStore:{getChannel:id=>channels[id],getChannelIds:()=>Object.keys(channels)},SelectedChannelStore:{getChannelId:()=> 'a'},MessageStore:{getMessages:()=>({_array:messages,ready:true,hasMoreBefore:false}),getMessage:()=>messages[0]},EmojiStore:emojiStore,
      StickersStore:{getAllGuildStickers:()=>new Map([['guild',[{id:'222',name:'Wave',format_type:1},{id:'333',name:'Removed',format_type:1,available:false}]]]),getAllPackStickers:()=>new Map()},LocaleStore:{locale:'tr'}},
    actions:{MessageActions:actions},
    utils:{RestAPI:{async get({url,query}){
      if(url==='/sticker-packs') return {ok:true,body:{sticker_packs:[{stickers:[{id:'444',name:'Dance',format_type:3}]}]}};
      window.gifRequests.push({url,query});
      await new Promise(resolve=>setTimeout(resolve,query.q==='slow'?500:10));
      if(window.failGifs) throw {body:{message:'GIF service unavailable'}};
      return {ok:true,body:[{id:query.q??'trending',title:query.q??'Trending GIF',url:'https://example.com/'+(query.q??'trending'),gif_src:'https://example.com/preview.gif'}]};
    }}},
  },
  webpack:{find:filter=>[Upload,...(window.noNativePicker?[]:[nativePicker.component]),...(window.noNativeLayers?[]:[nativePicker.layers]),nativePicker.store].find(filter),findByProps:(...props)=>{
    if(props.includes('EmojiIntention')) return {EmojiIntention:{CHAT:3}};
    if(props.includes('getEmojiUnavailableReason')) return {getEmojiUnavailableReason:()=>window.blockEmoji?2:null};
    if(props.includes('transitionTo')) return {transitionTo:route=>window.routes.push(route)};
  }},toast:{show:message=>{window.lastToast=message}},
};
const ctx={settings:{get:()=>window.saved,set:(_,value)=>window.saved=value},log:console};
window.openCanvas=()=>openMultiChatCanvas(ctx);
window.closeCanvas=closeMultiChatCanvas;
window.disposeCanvas=disposeMultiChatCanvas;
window.openCanvas();

// Exercise the integration without creating a second Discord runtime in the browser fixture.
import {registerPopoutOpener} from '../../../src/renderer/plugins/popoutChats/service';
let disposePopoutFixture;
window.fixturePopoutCalls=[];
window.fixtureTogglePopouts=enabled=>{if(enabled)disposePopoutFixture=registerPopoutOpener(id=>window.fixturePopoutCalls.push(id));else disposePopoutFixture?.();};
