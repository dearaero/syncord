import type {ElementLike,NativeReact} from '../dmFilters/native';
export type NativeSidebar={props:{guild?:{id?:unknown};guildId?:unknown};render:()=>unknown;renderChannelList:()=>unknown;renderGuildHeader:unknown;getGuildBannerHash:unknown;forceUpdate:()=>void};
export function isSidebar(value:unknown):value is NativeSidebar {
 if(!value||typeof value!=='object')return false;const v=value as Record<string,unknown>,p=v.props as NativeSidebar['props']|undefined;
 return typeof p?.guild?.id==='string'&&['render','renderChannelList','renderGuildHeader','getGuildBannerHash','forceUpdate'].every(key=>typeof v[key]==='function');
}
/** Keep the actual native nav boundary; its real guild prop is never modified. */
export function projectSidebar(tree:unknown,react:NativeReact,contents:unknown,name:string):unknown {
 if(!react.isValidElement(tree)||(tree as ElementLike).type!=='nav')return tree;
 return react.cloneElement(tree as ElementLike,{'aria-label':name,onContextMenu:undefined,children:contents,'data-syncord-virtual-sidebar':''});
}
