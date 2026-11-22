import {definePlugin} from '../../api/plugin';
import {canonicalMessage,t} from '../../i18n';
import {showToast,ToastType} from '../../ui/toast';
import {registerLongMessages} from '../../chat/longMessage';
import {watchAccount} from '../globalMessageSearch/discord';
import {currentUserId} from '../multiChatCanvas/discord';
import {LongQueue} from './queue';
import {LONG_ID,options} from './settings';
import {composerFrom,nativeRequest,accountLimit,isSendClick,enterSends,insertPaste,noteComposerInput} from './discord';
import {CSS,transferUi} from './ui';
export const LongMessagesPlugin=definePlugin({
 id:LONG_ID,name:canonicalMessage('long.name'),get description(){return t('long.description');},enabledByDefault:false,
 permissions:{media:true,userData:true,clipboard:true,discordStores:['UserStore','ChannelStore','PermissionStore','DraftStore','PendingReplyStore','UploadAttachmentStore','StickersStore','EmojiStore'],discordActions:['message-send','saveDraft','removeFiles','DELETE_PENDING_REPLY','CLEAR_STICKER_PREVIEW']},
 start(ctx){
  ctx.css.inject(CSS);let stopped=false;const ui=transferUi(),queue=new LongQueue(options,job=>ui.update(job));ui.onDismiss(job=>queue.dismiss(job));
  const errorKey=(error:unknown)=>error instanceof Error&&/^long\.[a-zA-Z]+$/.test(error.message)?error.message:'long.unavailable';
  const unregister=registerLongMessages(request=>queue.offer(request)?.catch(error=>{throw Error(t(errorKey(error)));}));
  const failure=(error:unknown):void=>{if(!stopped)showToast(t(errorKey(error)),{type:ToastType.FAILURE});};
  const capture=(event:Event):void=>{
    if(stopped||event.defaultPrevented)return;
    if(event.type==='keydown'&&((event as KeyboardEvent).key!=='Enter'||(event as KeyboardEvent).shiftKey||(event as KeyboardEvent).isComposing||(event as KeyboardEvent).repeat))return;
    const node=event.target as Element|null;if(!node||typeof node.closest!=='function'||node.closest('[data-mc-pane],#Syncord-long-messages'))return;
    if(event.type==='input'){noteComposerInput(node);return;}
    const composer=composerFrom(node);if(!composer)return;
    const text=composer.text();if(text==null||text.startsWith('/'))return;
    if(event.type==='paste'){
      const clipboard=(event as ClipboardEvent).clipboardData;if(!clipboard||clipboard.files.length)return;
      const pasted=clipboard.getData('text/plain');if(pasted.length<=accountLimit())return;
      // Prevent Discord's automatic message.txt conversion, not ordinary/file paste.
      if(insertPaste(composer,pasted)){event.preventDefault();event.stopImmediatePropagation();}return;
    }
    if(text.length<=2000||text.length<=accountLimit())return;
    if(event.type==='keydown'){
      const key=event as KeyboardEvent;if(!enterSends(key,composer))return;
      const editable=node.closest('[data-slate-editor="true"]');if(!editable||editable.getAttribute('aria-expanded')==='true'||editable.getAttribute('aria-activedescendant'))return;
    }else if(event.type==='click'&&((event as MouseEvent).button!==0||!isSendClick(node)))return;
    event.preventDefault();event.stopImmediatePropagation();
    try{const request=nativeRequest(composer);if(!request){failure(Error('long.unavailable'));return;}
      void queue.offer(request)?.catch(failure);
    }catch{failure(Error('long.unavailable'));}
  };
  for(const type of ['keydown','click','paste','submit','input'])window.addEventListener(type,capture,true);
  const offAccount=watchAccount(()=>{ui.accountChanged();queue.cancelOtherAccounts(currentUserId());});
  ctx.disposable(()=>{stopped=true;unregister();offAccount();for(const type of ['keydown','click','paste','submit','input'])window.removeEventListener(type,capture,true);queue.stop();ui.dispose();});
 },
});
