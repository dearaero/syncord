import { t as i18nText } from "../../i18n";
import {showToast,ToastType} from '../../ui/toast';
import {accountId,nativeStore,setHidden} from './settings';
import {validId,type HiddenKind} from './model';
export function hideItem(kind:HiddenKind,id:string,account:string|undefined):void {
  if(!account||account!==accountId()){showToast(i18nText("ui.your_discord_account_changed_reopen_the_menu_and_try_again"),{type:ToastType.FAILURE});return;}
  let available=false;
  try{
    if(kind==='guild')available=!!nativeStore<{getGuild?:(id:string)=>unknown}>('GuildStore')?.getGuild?.(id);
    else {const channel=nativeStore<{getChannel?:(id:string)=>{type?:unknown}|undefined}>('ChannelStore')?.getChannel?.(id);available=channel?.type===(kind==='dm'?1:3);}
  }catch{/* Cached records can disappear while a menu is open. */}
  if(!validId(id)||!available){showToast(i18nText("ui.this_item_is_not_available_in_discord_open_it_and_try_again"),{type:ToastType.FAILURE});return;}
  if(setHidden(kind,id,true,account))showToast(i18nText("ui.value_hidden", {v0: kind==='guild'?i18nText("ui.server"):kind==='dm'?'DM':i18nText("ui.group")}),{type:ToastType.SUCCESS});
}
