import {definePlugin} from '../../api/plugin';
import {t} from '../../i18n';
import {watchNativeMenus,appendNativeMenuAction} from '../../ui/nativeMenus';
import {showToast,ToastType} from '../../ui/toast';
import {accountId,watchStore} from './discord';
import {CloneSession} from './state';
import {menuGuild,MENU_ID} from './menu';
import {openStudio,cloneErrorMessage} from './ui';
import {CSS} from './styles';
export const ServerCloner=definePlugin({
 id:'server-cloner',name:'Server Cloner',description:'Clone server roles, channels, categories, permissions and structure.',enabledByDefault:false,
 permissions:{media:true,discordStores:['UserStore','GuildStore','GuildRoleStore','ChannelStore','PermissionStore'],discordActions:['guild-settings','guild-role-create','guild-role-update','guild-channel-create','guild-channel-update','guild-structure-order']},
 start(ctx){
  ctx.css.inject(CSS);let session:CloneSession|undefined,close:(()=>void)|undefined,stopped=false;
  const reset=():void=>{for(const row of document.querySelectorAll('[id="'+MENU_ID+'"]'))row.remove();};
  const clear=():void=>{close?.();close=undefined;session?.dispose();session=undefined;reset();};
  const unwatch=watchNativeMenus({log:ctx.log,reset,menu:(menu,target)=>{
   const id=menuGuild(menu,target),old=menu.querySelector<HTMLElement>('[id="'+MENU_ID+'"]');
   if(!id){old?.remove();return;}const expected=accountId();if(!expected){old?.remove();return;}
   if(old?.dataset.cloneIdentity!==expected+':'+id)old?.remove();
   appendNativeMenuAction(menu,MENU_ID,t(session?.active()||session?.source.id===id?'clone.resume':'clone.action'),()=>{
    if(stopped||accountId()!==expected)return;
    try{close?.();if(!session?.active()&&session?.source.id!==id){session?.dispose();session=new CloneSession(id);}session.guard();close=openStudio(session,clear);}
    catch(error){if(!session?.active())clear();showToast(cloneErrorMessage(error),{type:ToastType.FAILURE});}
   },'clone');
   const row=menu.querySelector<HTMLElement>('[id="'+MENU_ID+'"]');if(row)row.dataset.cloneIdentity=expected+':'+id;
  }});
  const offAccount=watchStore('UserStore',()=>{if(session&&accountId()!==session.account)clear();});
  ctx.disposable(()=>{stopped=true;offAccount();unwatch();clear();});
 },
});
