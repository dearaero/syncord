import {definePlugin} from '../../api/plugin';
import {t} from '../../i18n';
import {showToast} from '../../ui/toast';
import {channelIdFromRow,shouldBlock} from './decide';

type Channel={type?:number;isVocal?:()=>boolean};
const stores=()=>window.Syncord?.common?.stores;
const safe=<T>(fn:()=>T,fallback:T):T=>{try{return fn();}catch{return fallback;}};
const channel=(id:string):Channel|undefined=>safe(()=>(stores()?.ChannelStore as {getChannel?:(id:string)=>Channel|undefined}|undefined)?.getChannel?.(id),undefined);
const isVoice=(c:Channel|undefined):boolean=>!!c&&(safe(()=>c.isVocal?.()===true,false)||c.type===2||c.type===13);
const connectedTo=(id:string):boolean=>safe(()=>(stores()?.SelectedChannelStore as {getVoiceChannelId?:()=>string|null|undefined}|undefined)?.getVoiceChannelId?.()===id,false);

export const SafeVoiceJoinPlugin=definePlugin({
  id:'safe-voice-join',get name(){return t('safeVoice.name');},get description(){return t('safeVoice.description');},enabledByDefault:false,
  permissions:{discordStores:['ChannelStore','SelectedChannelStore']},
  start(ctx){
    let hint=0,lastHint=0;
    // Capture on document runs before React's root listener, so a swallowed first click never reaches Discord's join handler.
    const onClick=(event:MouseEvent):void=>{
      const target=event.target instanceof Element?event.target:null;if(!target||event.button!==0)return;
      const row=target.closest('[data-list-item-id]'),id=channelIdFromRow(row?.getAttribute('data-list-item-id')??null);if(!row||!id)return;
      const control=target.closest('button,[role=button]');
      if(event.detail>=2){clearTimeout(hint);return;}
      if(!shouldBlock({detail:event.detail,voice:isVoice(channel(id)),connected:connectedTo(id),onControl:!!control&&control!==row&&row.contains(control)}))return;
      event.preventDefault();event.stopImmediatePropagation();
      // Hint only when no second click follows, and at most every few seconds.
      clearTimeout(hint);hint=window.setTimeout(()=>{if(Date.now()-lastHint<4000)return;lastHint=Date.now();showToast(t('safeVoice.hint'));},400);
    };
    document.addEventListener('click',onClick,true);
    ctx.disposable(()=>{document.removeEventListener('click',onClick,true);clearTimeout(hint);});
  },
});
