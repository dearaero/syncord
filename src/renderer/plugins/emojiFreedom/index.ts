import {definePlugin} from '../../api/plugin';
import {t} from '../../i18n';
import {onExpressionSelection} from '../../chat/expressionDraft';
import {showToast,ToastType} from '../../ui/toast';
import {selectionFrom,alternative,draftInsertion,account} from './discord';

export const EmojiFreedomPlugin=definePlugin({
  id:'emoji-freedom',name:'Emoji Freedom',enabledByDefault:false,
  get description(){return t('emojiFreedom.description');},
  permissions:{discordStores:['UserStore','ChannelStore','GuildStore','EmojiStore','StickersStore'],discordActions:['ExpressionPicker','SlateEditor']},
  start(ctx){
    let stopped=false;
    const capture=(event:Event):void=>{
      if(stopped||event.defaultPrevented)return;
      const keyboard=event as KeyboardEvent,mouse=event as MouseEvent;
      if(event.type==='keydown'&&(!['Enter',' '].includes(keyboard.key)||keyboard.repeat||keyboard.isComposing))return;
      if(mouse.ctrlKey||mouse.altKey||mouse.metaKey||event.type==='click'&&mouse.button!==0)return;
      const target=event.target as Element|null;
      if(!target||typeof target.closest!=='function')return;
      try{
        const owner=account(),selection=selectionFrom(target);if(!owner||!selection)return;
        const choice=alternative(selection);if(choice.kind==='native')return;
        const insert=choice.kind==='link'?draftInsertion(selection):undefined;
        // This is an explicit fallback selection, never a send action.
        event.preventDefault();event.stopImmediatePropagation();
        if(choice.kind==='unsupported'){showToast(t('emojiFreedom.lottie'),{type:ToastType.FAILURE});return;}
        if(account()!==owner||!insert||!insert(` ${choice.url} `,!mouse.shiftKey))showToast(t('emojiFreedom.unavailable'),{type:ToastType.FAILURE});
      }catch{ctx.log.warn('Native expression selection unavailable');showToast(t('emojiFreedom.unavailable'),{type:ToastType.FAILURE});}
    };
    for(const type of ['click','keydown'])window.addEventListener(type,capture,true);
    const off=onExpressionSelection(capture);
    ctx.disposable(()=>{stopped=true;off();for(const type of ['click','keydown'])window.removeEventListener(type,capture,true);});
  },
});
