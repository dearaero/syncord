import {definePlugin} from '../../api/plugin';
import {t} from '../../i18n';
import {currentUserId} from '../multiChatCanvas/discord';
import {watchAccount} from '../globalMessageSearch/discord';
import {watchNativeMenus,inspectMenuContext,appendNativeMenuAction} from '../../ui/nativeMenus';
import {parseDropLink} from '../../../shared/drop';
import {openDrop,DROP_CSS} from './ui';
import {dm} from './discord';
import {watchDropInbox} from './inbox';
export const SyncordDropPlugin=definePlugin({
 id:'syncord-drop',name:'Syncord Drop',get description(){return t('drop.description');},enabledByDefault:false,
 permissions:{native:['syncord-drop'],media:true,userData:true,discordStores:['UserStore','ChannelStore','user','channel'],discordActions:[]},
 start(ctx){
  ctx.css.inject(DROP_CSS);let view:ReturnType<typeof openDrop>|undefined,owner='',stopped=false;const rows=new Set<Element>();
  let inbox:ReturnType<typeof watchDropInbox>|undefined;
  const open=(channel?:string,invite?:string,automatic=false):void=>{if(stopped||view)return;const account=currentUserId();if(!account)return;owner=account;view=openDrop(ctx,account,()=>{view=undefined;owner='';inbox?.wake();},channel,invite,automatic);};
  const reset=():void=>{for(const row of rows)row.remove();rows.clear();};
  const offMenu=watchNativeMenus({log:ctx.log,reset,menu(menu){
   if(stopped||ctx.settings.get<boolean>('menu',true)===false)return;
   const context=inspectMenuContext(menu),id=context?.channelId,account=currentUserId();if(!id||!account)return;
   try{dm(id,account);}catch{return;}
   appendNativeMenuAction(menu,'Syncord-drop-menu',t('drop.send'),()=>{try{dm(id,account);open(id);}catch{/* The DM/account changed after this menu was rendered. */}},'popout');
   const row=menu.querySelector('#Syncord-drop-menu');if(row)rows.add(row);
  }});
  const click=(event:MouseEvent):void=>{
   if(stopped||ctx.settings.get<boolean>('links',true)===false||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
   const anchor=event.target instanceof Element?event.target.closest<HTMLAnchorElement>('a[href]'):null;if(!anchor)return;const id=parseDropLink(anchor.href);if(!id)return;
   event.preventDefault();event.stopImmediatePropagation();open(undefined,id);
  };
  document.addEventListener('click',click,true);
  inbox=watchDropInbox({account:currentUserId,enabled:()=>ctx.settings.get<boolean>('incoming',true)!==false,busy:()=>!!view,hidden:()=>document.hidden,read:(id,available)=>ctx.drop.inbox(id,available),show:invite=>open(undefined,invite.id,true)});
  const visibility=():void=>inbox?.wake();document.addEventListener('visibilitychange',visibility);
  const incomingChanged=(e:Event):void=>{if(e.target instanceof HTMLInputElement&&e.target.dataset.dropSetting==='incoming')queueMicrotask(()=>inbox?.wake());};document.addEventListener('change',incomingChanged);
  const offAccount=watchAccount(()=>{if(owner&&owner!==currentUserId())view?.close();inbox?.wake();});
  ctx.disposable(()=>{stopped=true;inbox?.stop();view?.close();document.removeEventListener('change',incomingChanged);document.removeEventListener('visibilitychange',visibility);offAccount();offMenu();reset();document.removeEventListener('click',click,true);});
 },
});
