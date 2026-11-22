import {kit,scanKit,openNativeMenu} from '../../discordKit';
import {showToast,ToastType} from '../../ui/toast';
import {t} from '../../i18n';
export type LocalMenuItem={id:string;label:string;action:()=>void;disabled?:boolean;danger?:boolean};
/** Real Discord menus; no CSS imitation or native guild-editing actions. */
export function createVirtualMenu(alive:()=>boolean):{open:(event:unknown,label:string,items:LocalMenuItem[])=>void;dispose:()=>void} {
 let owned=false;
 const close=():void=>{if(owned){owned=false;kit.closeContextMenu?.();}};
 return {
  open(event,label,items){
   if(!alive())return;scanKit();
   if(!kit.react||!kit.menu||!kit.menuItem){showToast(t('ui.the_menu_failed_to_open'),{type:ToastType.FAILURE});return;}
   owned=true;
   const opened=openNativeMenu(event,({navId,label:menuLabel,onClose})=>{
    const react=kit.react;if(!react||!alive())return null;
    return react.createElement(kit.menu,{navId,'aria-label':menuLabel,onClose:()=>{owned=false;onClose();}},
     ...items.map(item=>react.createElement(kit.menuItem,{id:'Syncord-virtual-'+item.id,key:item.id,label:item.label,disabled:item.disabled,color:item.danger?'danger':undefined,
      action:()=>{close();if(alive()&&!item.disabled)item.action();}})));
   },'Syncord-virtual-actions',label);
   if(!opened) {owned=false;showToast(t('ui.the_menu_failed_to_open'),{type:ToastType.FAILURE});}
  },dispose:close,
 };
}
