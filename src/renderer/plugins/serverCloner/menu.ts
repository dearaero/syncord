import {inspectMenuContext} from '../../ui/nativeMenus';
import {validId} from './model';
export const MENU_ID='Syncord-clone-server';
export function menuGuild(menu:Element,target:Element|null):string|undefined {
 if(menu.id!=='guild-context')return;
 const context=inspectMenuContext(menu);
 if(context?.channelId||context?.userId)return;
 const rail=target?.closest('[data-list-item-id]')?.getAttribute('data-list-item-id')?.match(/^guildsnav___([1-9]\d*)$/)?.[1];
 if(context?.guildId&&rail&&context.guildId!==rail)return;
 const id=context?.guildId??rail;return validId(id)?id:undefined;
}
