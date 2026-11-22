import { t as i18nText } from "../../i18n";
import {definePlugin} from '../../api/plugin';
import {registerDmView} from '../../ui/privateChannelView';
import type {ElementLike,NativeReact} from '../dmFilters/native';
import {inspectMenuContext,watchNativeMenus,appendNativeMenuAction} from '../../ui/nativeMenus';
import {getFiber} from '../../ui/userNames';
import {accountId,hiddenSet,HIDDEN_ID,HIDDEN_EVENT,nativeStore,notify,quickAccessEnabled} from './settings';
import {projectGuildTree,validId,type HiddenKind} from './model';
import {CSS,openManager,closeRestoreUi} from './ui';
import {hideItem} from './actions';
const MENU_ROW='Syncord-hide-navigation-item';
type Target={kind:HiddenKind;id:string};
function gestureChannel(target:Element|null):string|undefined {
  const link=target?.closest('a[href^="/channels/@me/"]');const id=link?.getAttribute('href')?.match(/^\/channels\/@me\/([1-9]\d*)\/?$/)?.[1];if(validId(id))return id;
  if(!target?.closest('[class*="privateChannels_"],[class*="privateChannels__"],[data-syncord-private-channels]'))return;
  let fiber=getFiber(target);for(let i=0;fiber&&i<24;i++,fiber=fiber.return??null){const props=fiber.memoizedProps,channel=props?.channel as {id?:unknown;type?:unknown}|undefined;if(validId(channel?.id)&&[1,3].includes(Number(channel?.type)))return channel.id;}
  return;
}
export function menuTarget(menu:Element,gesture:Element|null):Target|undefined {
  const context=inspectMenuContext(menu),nav=menu.id;
  if(nav==='guild-context'){
    const fromRail=gesture?.closest('[data-list-item-id]')?.getAttribute('data-list-item-id')?.match(/^guildsnav___([1-9]\d*)$/)?.[1];
    const id=context?.guildId??fromRail;return validId(id)?{kind:'guild',id}:undefined;
  }
  if(!['user-context','gdm-context','group-dm-context','dm-context','private-channel-context'].includes(nav))return;
  const id=context?.channelId??gestureChannel(gesture);if(!validId(id))return;
  const channel=nativeStore<{getChannel?:(id:string)=>{type?:unknown}|undefined}>('ChannelStore')?.getChannel?.(id);
  if(channel?.type===1)return{kind:'dm',id};
  if(channel?.type===3&&nav!=='user-context')return{kind:'group',id};
  return;
}
function withEye(node:unknown,react:NativeReact):unknown {
  if(!quickAccessEnabled()||!react.isValidElement(node))return node;const header=node as ElementLike;
  // Discord's native heading forwards className but drops arbitrary data props.
  const headingClass=`${typeof header.props.className==='string'?header.props.className:''} Syncord-hidden-heading`;
  const eye=react.createElement('button',{key:'Syncord-hidden-eye',type:'button','data-syncord-hidden-eye':'','aria-label':`${i18nText('ui.quick_access')}: ${i18nText('ui.hidden_items')}`,title:i18nText('ui.quick_access'),'aria-haspopup':'dialog',onClick:(event:{preventDefault:()=>void;stopPropagation:()=>void})=>{event.preventDefault();event.stopPropagation();openManager(hideItem);}},react.createElement('svg',{width:20,height:20,viewBox:'0 0 24 24','aria-hidden':true},react.createElement('path',{fill:'currentColor',d:'M12 5c-5 0-9 4.5-10 7 1 2.5 5 7 10 7s9-4.5 10-7c-1-2.5-5-7-10-7Zm0 12c-4 0-7.3-3.5-8-5 .7-1.5 4-5 8-5s7.3 3.5 8 5c-.7 1.5-4 5-8 5Zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z'})));
  const children=Array.isArray(header.props.children)?header.props.children:[header.props.children];
  // Current Discord keeps the ellipsis and plus inside one action container.
  const action=children[children.length-1];
  if(react.isValidElement(action)&&(action as ElementLike).type==='div'){
    const el=action as ElementLike,inner=Array.isArray(el.props.children)?el.props.children:[el.props.children];const next=[...inner];next.splice(Math.max(0,next.length-1),0,eye);
    return react.cloneElement(header,{className:headingClass,children:[...children.slice(0,-1),react.cloneElement(el,{children:next})]});
  }
  const next=[...children];next.splice(Math.max(0,next.length-1),0,eye);return react.cloneElement(header,{className:headingClass,children:next});
}
type TreeStore={getGuildsTree:()=>unknown;emitChange?:()=>void};
export const HiddenItemsPlugin=definePlugin({
  id:HIDDEN_ID,name:i18nText("ui.hidden_items"),author:i18nText("ui.syncord"),enabledByDefault:true,
  get description() { return i18nText("ui.hide_servers_dms_and_groups_locally_and_restore_them_from_the_dm_heade"); },
  permissions:{media:true,userData:true,webpackPatch:true,discordStores:['user','guild','channel','UserStore','GuildStore','ChannelStore','SortedGuildStore','GuildsTreeStore']},
  start(ctx){
    ctx.css.inject(CSS);let warnedTree=false,stopped=false,frame=0,retry=0,retryEnd=0,treeStore:TreeStore|undefined,undoTree:(()=>void)|undefined,account=accountId();
    const cache=new WeakMap<object,{version:unknown;hidden:ReadonlySet<string>;result:unknown}>();
    const view=registerDmView(ctx,{visible:id=>!hiddenSet('dm').has(id)&&!hiddenSet('group').has(id),header:withEye});
    const patchTree=():void=>{
      if(treeStore||stopped)return;const value=nativeStore<Partial<TreeStore>>('SortedGuildStore')??nativeStore<Partial<TreeStore>>('GuildsTreeStore');
      if(typeof value?.getGuildsTree!=='function')return;
      try {treeStore=value as TreeStore;
      undoTree=ctx.patch.after(treeStore,'getGuildsTree',(_args,result)=>{
        if(stopped||!result||typeof result!=='object')return result;const hidden=hiddenSet('guild'),version=(result as {version?:unknown}).version,old=cache.get(result);
        if(old&&old.version===version&&old.hidden===hidden)return old.result;
        const projected=projectGuildTree(result,hidden);cache.set(result,{version,hidden,result:projected});return projected;
      });
      window.clearInterval(retry);window.clearTimeout(retryEnd);retry=retryEnd=0;treeStore.emitChange?.();
      }catch(error){undoTree?.();undoTree=undefined;treeStore=undefined;if(!warnedTree){warnedTree=true;ctx.log.warn('Native server tree cannot be patched; DM hiding remains available.',error);}}
    };
    const refresh=():void=>{if(stopped||frame)return;frame=requestAnimationFrame(()=>{frame=0;patchTree();view.refresh();try{treeStore?.emitChange?.();}catch(error){ctx.log.warn('Hidden server view refresh failed',error);}});};
    const userStore=nativeStore<{addChangeListener?:(fn:()=>void)=>void;removeChangeListener?:(fn:()=>void)=>void}>('UserStore');
    const accountChanged=():void=>{const next=accountId();if(next===account)return;account=next;closeRestoreUi();notify();};
    userStore?.addChangeListener?.(accountChanged);window.addEventListener(HIDDEN_EVENT,refresh);
    const reset=():void=>{for(const row of document.querySelectorAll('[id="'+MENU_ROW+'"]'))row.remove();};
    const unwatch=watchNativeMenus({log:ctx.log,reset,menu:(menu,target)=>{
      const item=menuTarget(menu,target),old=menu.querySelector<HTMLElement>('[id="'+MENU_ROW+'"]');
      if(!item||hiddenSet(item.kind).has(item.id)){old?.remove();return;}
      const expected=accountId(),identity=JSON.stringify([expected,item.kind,item.id]);
      if(old&&old.dataset.hiddenTarget!==identity)old.remove();
      appendNativeMenuAction(menu,MENU_ROW,item.kind==='guild'?i18nText("ui.hide_server"):item.kind==='dm'?i18nText("ui.hide_dm"):i18nText("ui.hide_group"),()=>hideItem(item.kind,item.id,expected),'eye');
      const row=menu.querySelector<HTMLElement>('[id="'+MENU_ROW+'"]');if(row)row.dataset.hiddenTarget=identity;
    }});
    patchTree();if(!treeStore){retry=window.setInterval(patchTree,500);retryEnd=window.setTimeout(()=>{window.clearInterval(retry);retry=retryEnd=0;if(!treeStore)ctx.log.warn('Discord server tree is not available; hidden server entries remain manageable in settings.');},30000);}
    ctx.disposable(()=>{
      stopped=true;if(frame)cancelAnimationFrame(frame);window.clearInterval(retry);window.clearTimeout(retryEnd);window.removeEventListener(HIDDEN_EVENT,refresh);userStore?.removeChangeListener?.(accountChanged);unwatch();closeRestoreUi();undoTree?.();try{treeStore?.emitChange?.();}catch{/* Client is shutting down. */}
    });
  },
});
