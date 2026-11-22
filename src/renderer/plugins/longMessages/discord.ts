import {replaceLongDraft} from './draft';
import {accountLimit} from '../../chat/messageLimit';
export {accountLimit} from '../../chat/messageLimit';
import {validateCustomEmojis} from '../multiChatCanvas/mediaDiscord';
import {getFiber,type Fiber} from '../../ui/userNames';
import {currentUserId,channelSendError} from '../multiChatCanvas/discord';
import type {LongRequest} from '../../chat/longMessage';
type Bag=Record<string,unknown>;
const object=(v:unknown):v is Bag=>!!v&&typeof v==='object';
const common=()=>window.Syncord?.common;
export function store<T>(name:string):T|undefined{return (common()?.stores as unknown as Bag)?.[name] as T|undefined??window.Syncord?.webpack.findByStoreName(name) as T|undefined;}
type Actions={sendMessage:(...args:unknown[])=>unknown;getSendMessageOptionsForReply?:(reply:unknown)=>Bag};
const revisions=new WeakMap<Element,number>();
export function noteComposerInput(node:Element):void{const root=node.closest('[class*="channelTextArea_"],[class*="channelTextArea__"]');if(root)revisions.set(root,(revisions.get(root)??0)+1);}
export type Composer={channelId:string;text:()=>string|undefined;replace:(expected:string,text:string)=>boolean;valid:()=>boolean;root:HTMLElement;props:Bag};
/** Native serialized text + explicit owner; no selected-channel or DOM text fallback. */
export function composerFrom(node:Element):Composer|undefined {
  const root=node.closest<HTMLElement>('[class*="channelTextArea_"],[class*="channelTextArea__"]');
  if(!root||root.closest('[data-mc-pane],#Syncord-settings-root'))return;
  const editable=root.querySelector<HTMLElement>('[data-slate-editor="true"]');if(!editable)return;
  const resolve=():Bag|undefined=>{
    for(let f=getFiber(editable),n=0;f&&n<64;n++,f=f.return??null){const p=f.memoizedProps??f.pendingProps;
      if(p&&object(p.channel)&&typeof p.channel.id==='string'&&typeof p.textValue==='string'&&object(p.type)&&['normal','sidebar','overlay'].includes(String(p.type.analyticsName))&&object(p.type.drafts)&&p.type.drafts.type===0&&typeof p.onSubmit==='function')return p;
    }
  };
  const props=resolve();if(!props||props.disabled===true)return;
  const channelId=(props.channel as Bag).id as string,owner=currentUserId(),revision=revisions.get(root)??0;
  const drafts=store<{getDraft?:(id:string,type:number)=>string}>('DraftStore');
  const draftActions=window.Syncord?.webpack.findByProps('saveDraft','clearDraft') as {saveDraft?:(id:string,text:string,type:number)=>void}|undefined;
  if(!draftActions?.saveDraft||!drafts?.getDraft)return;
  const valid=()=>editable.isConnected&&!!owner&&currentUserId()===owner&&(resolve()?.channel as Bag|undefined)?.id===channelId;
  return {root,props,channelId,valid,text:()=>valid()?resolve()?.textValue as string|undefined:undefined,replace:(expected,text)=>{
    if(!valid()||(revisions.get(root)??0)!==revision||resolve()?.textValue!==expected||!draftActions?.saveDraft)return false;
    if(text.length>2000){
      for(let f=getFiber(editable),n=0;f&&n<48;n++,f=f.return??null){
        const p=f.memoizedProps??f.pendingProps;if(object(p?.editor)&&Array.isArray(p.editor.children))return replaceLongDraft(p.editor,text);
      }
      return false;
    }
    draftActions.saveDraft(channelId,text,0);return drafts.getDraft?.(channelId,0)===text;
  }};
}
/** A native send button calls the buttons component's handleSubmit. No translated labels/classes. */
export function isSendClick(node:Element):boolean{
  let clicked:unknown;
  for(let f=getFiber(node),n=0;f&&n<32;n++,f=f.return??null){const p=f.memoizedProps??f.pendingProps;if(!p)continue;
    if(!clicked&&typeof p.onClick==='function')clicked=p.onClick;
    if(clicked&&p.handleSubmit===clicked)return true;
  }
  return false;
}
export function enterSends(event:KeyboardEvent,composer:Composer):boolean {
  if(event.key!=='Enter'||event.shiftKey||event.altKey||event.isComposing||event.repeat||event.keyCode===229)return false;
  // Honor an explicitly disabled Enter-to-submit native input.
  const submit=object(composer.props.type)&&object(composer.props.type.submit)?composer.props.type.submit:undefined;
  if(submit?.disableEnterToSubmit===true&&!event.ctrlKey&&!event.metaKey)return false;
  return true;
}
/** Snapshot native attachment/reply objects once, then use the existing action for every part. */
export function nativeRequest(composer:Composer):LongRequest|undefined {
  const owner=currentUserId(),text=composer.text();if(!owner||text==null)return;
  const actions=common()?.actions.MessageActions as unknown as Actions|undefined;
  const pending=store<{getPendingReply?:(id:string)=>unknown}>('PendingReplyStore');
  const uploads=store<{getUploads?:(id:string,type:number)=>unknown[]}>('UploadAttachmentStore');
  const stickers=window.Syncord?.webpack.findByProps('getStickerPreview') as {getStickerPreview?:(id:string,type:number)=>{id:string}[]}|undefined;
  if(!actions?.sendMessage||!actions.getSendMessageOptionsForReply||!pending?.getPendingReply||!uploads?.getUploads||!stickers?.getStickerPreview)return;
  const reply=pending.getPendingReply(composer.channelId),files=[...uploads.getUploads(composer.channelId,0)],stickerIds=(stickers.getStickerPreview(composer.channelId,0)??[]).map(s=>s.id);
  const uploadActions=window.Syncord?.webpack.findByProps('removeFiles','clearAll') as {removeFiles?:(channel:string,ids:string[],type:number)=>void}|undefined;
  if(files.length&&!uploadActions?.removeFiles)return;
  const replyOptions=actions.getSendMessageOptionsForReply(reply);
  const expected=text;let first=false;
  const valid=()=>composer.valid()&&currentUserId()===owner;
  const request:LongRequest={accountId:owner,channelId:composer.channelId,text,limit:accountLimit(),valid,
    send:async(content,index,nonce)=>{
      if(!valid()||channelSendError(composer.channelId))throw Error('long.unavailable');
      const emojis=validateCustomEmojis(composer.channelId,content);
      let uploadFailed=false;
      const options:Bag={nonce,...(index===0?replyOptions:{allowedMentions:{parse:[],users:[],roles:[],replied_user:false}}),
        ...(index===0&&files.length?{attachmentsToUpload:files,onAttachmentUploadError:()=>{uploadFailed=true;}}:{}),
        ...(index===0&&stickerIds.length?{stickerIds}:{}),};
      const result=await actions.sendMessage(composer.channelId,{content,invalidEmojis:[],validNonShortcutEmojis:emojis,tts:false},true,options);
      if(uploadFailed)throw Error('long.uncertain');return result;
    },
    delivered:(remaining)=>{
      if(!valid())return;
      // Keep the immutable original in the live composer while sending. Native
      // DraftStore caps long drafts (current client: increased limit + 500).
      // Rewriting each suffix both truncates it and races React's props update.
      if(remaining==='')composer.replace(expected,'');
      if(!first){first=true;
        const ids=files.filter(object).map(f=>f.id).filter((id):id is string=>typeof id==='string');
        if(ids.length)uploadActions?.removeFiles?.(composer.channelId,ids,0);
        const dispatcher=common()?.flux.FluxDispatcher as {dispatch?:(event:unknown)=>void}|undefined;
        const dispatch=(event:unknown)=>dispatcher?.dispatch?.(event);
        if(reply&&pending.getPendingReply?.(composer.channelId)===reply)dispatch?.({type:'DELETE_PENDING_REPLY',channelId:composer.channelId});
        if(stickerIds.length&&JSON.stringify((stickers.getStickerPreview?.(composer.channelId,0)??[]).map(s=>s.id))===JSON.stringify(stickerIds))dispatch?.({type:'CLEAR_STICKER_PREVIEW',channelId:composer.channelId,draftType:0});
      }
    },
    settled:(remaining,sent)=>{if(sent>0&&remaining&&valid())composer.replace(expected,remaining);},
    restore:remaining=>{if(!valid())return false;const current=composer.text();if(current===remaining)return true;if(current!==expected&&current!=='')return false;return composerFrom(composer.root)?.replace(current,remaining)??false;},
  };
  return request;
}
export function insertPaste(composer:Composer,text:string):boolean {
  const editable=composer.root.querySelector<HTMLElement>('[data-slate-editor="true"]');if(!editable||!composer.valid())return false;
  for(let f: Fiber|null=getFiber(editable),n=0;f&&n<48;n++,f=f.return??null){const p=f.memoizedProps??f.pendingProps,e=p?.editor;
    if(object(e)&&typeof e.insertText==='function'&&e.selection){e.insertText(text);return true;}
  }
  return false;
}
