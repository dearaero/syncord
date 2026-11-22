import {nativeUiMutationRelevant} from "./mutations";
import { t as i18nText } from "../i18n";
type PresentationAuthor={author:Record<string,unknown>;channel_id:string};
const presentationAuthors=new WeakMap<Element,PresentationAuthor>();
/** Only explicit presentation rows can supply identity context to decorators.
 * This registry is not a message store and contains no message ID/content. */
export function bindPresentationAuthor(node:Element,context:PresentationAuthor):()=>void{
  presentationAuthors.set(node,context);return()=>{presentationAuthors.delete(node);};
}
/** Read-only anchors shared by username decorations; never infer authors from session props. */
export type Fiber = {memoizedProps?:Record<string,unknown>;pendingProps?:Record<string,unknown>;return?:Fiber|null};
export function getFiber(node:Element):Fiber|null {
  const key=Object.keys(node).find(k=>k.startsWith('__reactFiber$')||k.startsWith('__reactInternalInstance$'));
  return key?(node as unknown as Record<string,Fiber>)[key]??null:null;
}
function user(value:unknown):{id:string}|null {
  return value!==null&&typeof value==='object'&&typeof (value as {id?:unknown}).id==='string'?value as {id:string}:null;
}
export function messageFromUsernameNode(node:Element):Record<string,unknown>|null {
  const row=node.closest('[data-syncord-local-record]'),context=row?presentationAuthors.get(row):undefined;
  if(context)return context;
  let fiber=getFiber(node);
  for(let i=0;i<40&&fiber;i++,fiber=fiber.return??null){
    const props=fiber.memoizedProps??fiber.pendingProps,message=props?.message;
    if(message!==null&&typeof message==='object'&&user((message as {author?:unknown}).author))return message as Record<string,unknown>;
  }
  return null;
}
const MESSAGE_SEL="li[id^=\"chat-messages-\"], [id^=\"chat-messages-\"], [class*=\"messageListItem_\"], [data-syncord-local-record]";
const POPOUT_SEL='[class*="userPopout"], [class*="UserPopout"], [class*="profileCard"], [class*="focusLock"], [role="dialog"]';
export function messageRoot(node:Element):Element|null {return node.closest(MESSAGE_SEL);}
export function isPopoutContext(node:Element):boolean {
  return !!node.closest(POPOUT_SEL);
}
export function canonicalUsername(root:Element):Element|null {
  return root.querySelector('[data-syncord-message-author]')??root.querySelector('[id^="message-username-"]')??root.querySelector('h3 [class*="username"]')
    ??root.querySelector('[class*="headerText"] [class*="username"]')??root.querySelector('[class*="username_"]');
}
export function usernameCandidates(root:ParentNode):Element[] {
  const messages=root instanceof Element&&root.matches(MESSAGE_SEL)?[root]:[...root.querySelectorAll(MESSAGE_SEL)];
  // Native list wrappers and their message children can both match MESSAGE_SEL.
  // Resolve each actual name once without caching recycled virtual-list nodes.
  const result=new Set<Element>();
  for(const message of messages){if(isPopoutContext(message))continue;const name=canonicalUsername(message);if(name)result.add(name);}
  return [...result];
}
/** Stop at the surface's own row, before global/current-user contexts. */
export function rowUserId(node:Element,row:Element):string|undefined {
  const parent=row.parentElement,boundary=parent?getFiber(parent):null;
  let fiber=getFiber(node)??getFiber(row);
  for(let i=0;i<24&&fiber&&fiber!==boundary;i++,fiber=fiber.return??null){
    const props=fiber.memoizedProps??fiber.pendingProps;
    const member=props?.member;
    const found=user(props?.user)??user(member!==null&&typeof member==='object'?(member as {user?:unknown}).user:undefined);
    if(found&&/^\d{17,20}$/.test(found.id))return found.id;
  }
  return undefined;
}

/** Settings text and our decorations cannot change a native username anchor.
 * Ignore them before scheduling a document-wide scan/layout read. */
export function usernameMutationRelevant(records:MutationRecord[],excludePopouts=false):boolean {
  // Chat-only consumers have no anchors in profiles/dialogs. Platform Indicators
  // also decorates profiles, so its default must keep those mutations relevant.
  return nativeUiMutationRelevant(records,'.dion-badges,[data-syncord-platforms],[data-syncord-profile-badges]'+(excludePopouts?','+POPOUT_SEL:''));
}
