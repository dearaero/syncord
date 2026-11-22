import {definePlugin,isSafeModeActive,isLockdownActive} from '../../api/plugin';
import {watchAccount} from '../globalMessageSearch/discord';
import {getFiber} from '../../ui/userNames';
import {sharedDispatcher} from '../../api/discordEvents';
import {canonicalMessage,t,onLocaleChange} from '../../i18n';
import {watchNativeMenus,inspectMenuContext,appendNativeMenuAction} from '../../ui/nativeMenus';
import {ID} from './model';
import {accountId,target,current} from './discord';
import {LocalStore} from './storage';
import {mountTimeline,type Owner} from './timeline';
import {CSS,createUi,localRow} from './ui';
export const FakeDmPlugin=definePlugin({
 id:ID,name:canonicalMessage('fd.name'),get description(){return t('fd.description');},enabledByDefault:false,
 permissions:{media:true,userData:true,webpackPatch:true,discordStores:['UserStore','ChannelStore','SelectedChannelStore','MessageStore']},
 start(ctx){
  ctx.css.inject(CSS);let stopped=false,loggedOut=false,account=accountId();const allowed=()=>!stopped&&!loggedOut&&!isSafeModeActive()&&!isLockdownActive();
  const store=new LocalStore(ctx,()=>allowed()?accountId():undefined);
  const ui=createUi(store,id=>view.available(id),allowed);
  const view=mountTimeline(store,(r,row,previous,compact,showDate,header)=>localRow(r,row,previous,ui.edit,ui.remove,compact,showDate,header),(prototype,hook)=>ctx.patch.after(prototype,'render',function(this:Owner,_args,result){return hook(this,result);}));
  const reset=()=>{for(const node of document.querySelectorAll('[id="Syncord-fake-dm-menu"]'))node.remove();};
  const offMenu=watchNativeMenus({log:ctx.log,reset,menu:(menu,gesture)=>{
   if(!allowed()||!['user-context','dm-context','private-channel-context','gdm-context','group-dm-context'].includes(menu.id))return;
   const context=inspectMenuContext(menu);let channel=target(context?.channelId);
   if(!channel&&gesture){const id=gesture.closest('a[href^="/channels/@me/"]')?.getAttribute('href')?.match(/^\/channels\/@me\/(\d+)\/?$/)?.[1];channel=target(id);
    if(!channel){let fiber=getFiber(gesture);for(let n=0;fiber&&n<32;n++,fiber=fiber.return??null){const c=fiber.memoizedProps?.channel;if(c&&typeof c==='object'){channel=target((c as {id?:unknown}).id);if(channel)break;}}}
   }
   const expected=accountId();if(!channel||!expected)return;
   const selected=channel,identity=expected+':'+selected.id,existing=menu.querySelector<HTMLElement>('[id="Syncord-fake-dm-menu"]');if(existing&&existing.dataset.fakeDmTarget!==identity)existing.remove();appendNativeMenuAction(menu,'Syncord-fake-dm-menu',t('fd.name'),()=>{if(allowed()&&accountId()===expected&&target(selected.id))ui.manage(selected);});const added=menu.querySelector<HTMLElement>('[id="Syncord-fake-dm-menu"]');if(added)added.dataset.fakeDmTarget=identity;
  }});
  const flux=sharedDispatcher(),events=['CHANNEL_SELECT','CURRENT_USER_UPDATE','USER_UPDATE','LOGOUT','CONNECTION_OPEN','LOAD_MESSAGES_SUCCESS'];
  const changed=(action:{type?:string;user?:{id?:string};channelId?:string;channel_id?:string})=>{
   if(action.type==='CHANNEL_SELECT')ui.dispose();
   if(action.type==='LOGOUT'){loggedOut=true;ui.dispose();reset();}else if(action.type==='CONNECTION_OPEN'||action.type==='CURRENT_USER_UPDATE')loggedOut=false;
   if(action.type==='USER_UPDATE'&&!current()?.participants.includes(action.user?.id??''))return;
   if(action.type==='LOAD_MESSAGES_SUCCESS'&&(action.channelId??action.channel_id)!==current()?.id)return;
   const next=accountId();if(next!==account){account=next;ui.dispose();reset();}view.refresh();
  };
  for(const event of events)flux?.subscribe(event,changed);const offAccount=watchAccount(()=>{if(accountId()!==account)changed({type:'CURRENT_USER_UPDATE'});});const offLocale=onLocaleChange(()=>{ui.dispose();view.refresh();reset();});
  ctx.disposable(()=>{stopped=true;offMenu();offLocale();offAccount();for(const event of events)flux?.unsubscribe(event,changed);ui.dispose();view.dispose();store.dispose();});
 },
});
