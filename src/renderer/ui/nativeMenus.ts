import type {Logger} from '../api/logger';
export const NATIVE_MENU_ROW='data-syncord-native-menu-row';
type Bag=Record<string,unknown>;
const bag=(value:unknown):value is Bag=>value!==null&&typeof value==='object';
function snowflake(value:unknown):string|undefined {return typeof value==='string'?value:bag(value)&&typeof value.id==='string'?value.id:undefined;}
type FiberLike = { return?: FiberLike; memoizedProps?: unknown };

/** How far up the tree to walk; the context sits a handful of frames above. */
const WALK_LIMIT = 30;

function fiberOf(element: Element): FiberLike | undefined {
  const key = Object.keys(element).find(
    (name) => name.startsWith("__reactFiber$") || name.startsWith("__reactInternalInstance$"),
  );
  if (!key) return undefined;
  return (element as unknown as Bag)[key] as FiberLike | undefined;
}

export type MenuContext = {
  userId?: string;
  guildId?: string;
  channelId?: string;
  channelType?: number;
};

const DM_CHANNEL_TYPE = 1;
const GROUP_DM_CHANNEL_TYPE = 3;

/**
 * Ids only, never Discord objects.
 *
 * The walk does not look for a user, it reads an id and then asks `UserStore`
 * for the object — cheaper, and there is no way to settle on the wrong user.
 */
function readContext(props: unknown): MenuContext | undefined {
  if (!bag(props)) return undefined;

  const channel = bag(props.channel) ? props.channel : undefined;
  const channelId = snowflake(props.channel) ?? snowflake(props.channelId);
  const channelType = channel && typeof channel.type === "number" ? channel.type : undefined;
  const userId = snowflake(props.user) ?? snowflake(props.userId);
  const rawGuildId = snowflake(props.guildId) ?? snowflake(props.guild) ?? snowflake(channel?.guild_id);

  // A DM carries no server, and a per-guild avatar is meaningless in one.
  const guildId =
    rawGuildId !== undefined &&
    channelType !== DM_CHANNEL_TYPE &&
    channelType !== GROUP_DM_CHANNEL_TYPE
      ? rawGuildId
      : undefined;

  if (!userId && !channelId && !guildId) return undefined;
  return { userId, guildId, channelId, channelType };
}

/** A props bag carrying a message record is a message menu. Stop the walk. */
function isMessageProps(props: unknown): boolean {
  return bag(props) && bag(props.message) && typeof props.message.id === "string";
}

/** What the menu is about, and the ids needed to answer it. */
export function inspectMenuContext(menu: Element): MenuContext | undefined {
  let fiber = fiberOf(menu);
  for (let step = 0; fiber && step < WALK_LIMIT; step += 1) {
    const props = fiber.memoizedProps;
    if (isMessageProps(props)) return undefined;
    const context = readContext(props);
    if (context) return context;
    fiber = fiber.return;
  }
  return undefined;
}


type Client={menu:(menu:Element,target:Element|null)=>void;reset:()=>void;log:Logger};
const clients=new Set<Client>();let observer:MutationObserver|undefined,frame=0,target:Element|null=null;
const scan=():void=>{frame=0;for(const menu of document.querySelectorAll('[role="menu"]'))for(const client of clients){try{client.menu(menu,target);}catch(error){client.log.warn('Native context menu extension failed',error);}}};
const schedule=():void=>{if(!frame)frame=requestAnimationFrame(scan);};
const gesture=(event:Event):void=>{target=event.target instanceof Element?event.target:null;for(const client of clients)client.reset();schedule();};
/** One observer/gesture listener shared by image actions and navigation hiding. */
export function watchNativeMenus(client:Client):()=>void {
  clients.add(client);
  if(!observer){
    observer=new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes){
      if(!(node instanceof Element)||node.hasAttribute(NATIVE_MENU_ROW))continue;
      if(node.matches('[role="menu"]')||node.closest('[role="menu"]')||node.querySelector('[role="menu"]')){schedule();return;}
    }});
    observer.observe(document.documentElement,{childList:true,subtree:true});document.addEventListener('contextmenu',gesture,true);
  }
  schedule();let active=true;
  return()=>{if(!active)return;active=false;client.reset();clients.delete(client);if(!clients.size){observer?.disconnect();observer=undefined;if(frame)cancelAnimationFrame(frame);frame=0;target=null;document.removeEventListener('contextmenu',gesture,true);}};
}
export function closeNativeContextMenu():void {
  const flux=window.Syncord?.common?.flux.FluxDispatcher as {dispatch?:(action:unknown)=>unknown}|undefined;
  flux?.dispatch?.({type:'CONTEXT_MENU_CLOSE'});
}
/** Reuse a real action's structure/classes when its React export cannot be patched. */
export function appendNativeMenuAction(menu:Element,id:string,label:string,action:()=>void,icon?:'eye'|'popout'|'clone'):void {
  if(menu.querySelector('[id="'+id+'"]'))return;
  const sample=[...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(row=>!row.hasAttribute(NATIVE_MENU_ROW)&&!row.hasAttribute('aria-haspopup')&&row.getAttribute('aria-disabled')!=='true');
  if(!sample?.parentElement)return;
  const row=sample.cloneNode(true) as HTMLElement;row.id=id;row.setAttribute(NATIVE_MENU_ROW,'');row.setAttribute('aria-label',label);row.removeAttribute('aria-labelledby');row.removeAttribute('aria-describedby');
  for(const name of [...row.classList])if(/danger|focus/i.test(name))row.classList.remove(name);
  const text=row.querySelector('[data-marquee-overflow] span')??[...row.querySelectorAll('*')].find(el=>!el.children.length&&el.textContent?.trim());
  if(text)text.textContent=label;else row.textContent=label;
  if(icon){
    // Keep the native icon slot and hover colors, replacing the cloned glyph.
    const existing=row.querySelector('svg'),svg=existing??menu.ownerDocument.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.removeAttribute('aria-label');svg.removeAttribute('id');
    const path=menu.ownerDocument.createElementNS('http://www.w3.org/2000/svg','path');
    if(icon==='eye'){
      path.setAttribute('fill','currentColor');path.setAttribute('d','M12 5c-5 0-9 4.5-10 7 1 2.5 5 7 10 7s9-4.5 10-7c-1-2.5-5-7-10-7Zm0 12c-4 0-7.3-3.5-8-5 .7-1.5 4-5 8-5s7.3 3.5 8 5c-.7 1.5-4 5-8 5Zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z');
    }else if(icon==='clone'){
      path.setAttribute('fill','currentColor');path.setAttribute('d','M8 2H4a2 2 0 0 0-2 2v12h2V4h4V2Zm0 4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2H8Zm0 2h12v12H8V8Z');
    }else{
      path.setAttribute('fill','none');path.setAttribute('stroke','currentColor');path.setAttribute('stroke-width','2');path.setAttribute('stroke-linecap','round');path.setAttribute('stroke-linejoin','round');path.setAttribute('d','M14 3h7v7m0-7L11 13M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5');
    }
    svg.replaceChildren(path);
    if(!existing){svg.setAttribute('width','18');svg.setAttribute('height','18');svg.style.cssText='flex-shrink:0;vertical-align:middle;margin-inline-end:8px';row.prepend(svg);}
  }
  let done=false;const run=(event:Event):void=>{event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();if(done)return;done=true;closeNativeContextMenu();action();};
  row.addEventListener('pointerdown',run,true);row.addEventListener('click',run,true);row.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' ')run(event);},true);
  const focus=(on:boolean):void=>{const cls=[...menu.querySelectorAll('[role="menuitem"]')].flatMap(el=>[...el.classList]).find(name=>/focus/i.test(name));for(const other of menu.querySelectorAll<HTMLElement>('[role="menuitem"]')){if(cls)other.classList.toggle(cls,on&&other===row);other.setAttribute('data-marquee-active',String(on&&other===row));}};
  row.addEventListener('pointerenter',()=>focus(true));row.addEventListener('pointerleave',()=>focus(false));row.setAttribute('data-marquee-active','false');sample.parentElement.append(row);
}
