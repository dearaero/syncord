import type {BadgeImageResolver} from '../../api/ecosystem/art';
import {hydrateBadgeImages} from '../../ui/ecosystem/images';
import type {ProfileTarget} from "../../api/discordEvents/profiles";
import type { ChatUser } from "./badges";
import {
  badgeImgHtml,
  badgesForUser,
} from "./badges";

import {getFiber,messageFromUsernameNode,messageRoot,isPopoutContext,usernameCandidates,canonicalUsername} from "../../ui/userNames";

const ATTR = "data-dion-badges";
const MSG_ATTR = "data-dion-badge-msg";
const WRAP_CLASS = "dion-badges";

function asUser(value: unknown): ChatUser | null {
  if (value == null || typeof value !== "object") return null;
  const u = value as Record<string, unknown>;
  if (typeof u.id !== "string") return null;
  return u as ChatUser;
}

export function authorFromUsernameNode(el:Element):ChatUser|null {return asUser(messageFromUsernameNode(el)?.author);}

function enrichUser(user: ChatUser): ChatUser {
  const store = window.Syncord?.common?.stores.UserStore as
    | { getUser?: (id: string) => ChatUser | undefined }
    | undefined;
  const profileStore = window.Syncord?.common?.stores.UserProfileStore as
    | {
        getUserProfile?: (id: string) =>
          | {
              premiumSince?: ChatUser["premiumSince"];
              premiumGuildSince?: ChatUser["premiumGuildSince"];
            }
          | undefined;
      }
    | undefined;
  const full = store?.getUser?.(user.id);
  const profile = profileStore?.getUserProfile?.(user.id);
  return {
    id: user.id,
    flags: full?.flags ?? user.flags,
    publicFlags: full?.publicFlags ?? full?.public_flags ?? user.publicFlags ?? user.public_flags,
    premiumType: full?.premiumType ?? full?.premium_type ?? user.premiumType ?? user.premium_type,
    premiumSince:
      full?.premiumSince ?? full?.premium_since ?? profile?.premiumSince ?? user.premiumSince ?? user.premium_since,
    premiumGuildSince:
      full?.premiumGuildSince ?? full?.premium_guild_since ??
      profile?.premiumGuildSince ??
      user.premiumGuildSince ?? user.premium_guild_since,
  };
}

function renderBadgeHtml(
  badges: ReturnType<typeof badgesForUser>["badges"],
  size: number,
): string {
  let html = "";
  for (let i = 0; i < badges.length; i++) {
    html += badgeImgHtml(badges[i]!, size);
  }
  return html;
}

function findWrap(msg: Element): HTMLElement | null {
  return msg.querySelector(`.${WRAP_CLASS}`);
}

function applyWrap(
  username: Element,
  msg: Element,
  badges: ReturnType<typeof badgesForUser>["badges"],
  size: number,
  userId: string,
): void {
  const ids = badges.map((b) => b.id).join(",");
  let wrap = findWrap(msg);
  if (!wrap) {
    wrap = document.createElement("span");
    wrap.className = WRAP_CLASS;
    wrap.setAttribute("aria-hidden", "true");
    username.insertAdjacentElement("afterend", wrap);
  } else if (wrap.previousElementSibling !== username) {
    // Keep wrap immediately after the canonical username (before guild tag).
    username.insertAdjacentElement("afterend", wrap);
  }

  const signature=JSON.stringify([size,...badges.map(b=>[b.id,b.icon,b.label,b.ecosystemArt,b.ecosystemImage])]);
  if (wrap.dataset.signature !== signature) {
    wrap.dataset.signature=signature;
    wrap.dataset.ids = ids;
    wrap.innerHTML = renderBadgeHtml(badges, size);
  }
  wrap.dataset.userId = userId;
}

export function decorateUsername(el: Element, size: number): void {
  if (isPopoutContext(el)) return;

  const msg = messageRoot(el);
  if (!msg) return;

  const canonical = canonicalUsername(msg);
  if (!canonical || canonical !== el) return;

  const raw = authorFromUsernameNode(el);
  if (!raw) return;
  if(el.getAttribute('data-dion-badge-user')!==raw.id){
    el.removeAttribute(ATTR);msg.removeAttribute(MSG_ATTR);findWrap(msg)?.remove();
    el.setAttribute('data-dion-badge-user',raw.id);
  }
  if(el.getAttribute(ATTR)==='1'&&msg.getAttribute('data-dion-badge-size')===String(size))return;

  const author = enrichUser(raw);
  const { badges, complete } = badgesForUser(author, profileTarget(el)?.guildId ?? null);

  if (badges.length === 0) {
    findWrap(msg)?.remove();
  } else {
    applyWrap(el, msg, badges, size, author.id);
  }

  msg.setAttribute("data-dion-badge-size",String(size));
  if (complete) {
    el.setAttribute(ATTR, "1");
    msg.setAttribute(MSG_ATTR, "1");
    return;
  }

  // Public flags render now; shared profile completion redraws this pending row.
  el.setAttribute(ATTR, "pending");
  msg.setAttribute(MSG_ATTR, "pending");
}

function profileTarget(el:Element):ProfileTarget|undefined {
  const message=messageFromUsernameNode(el),user=asUser(message?.author);
  const raw=message?.channel_id??message?.channelId??messageRoot(el)?.id.match(/^chat-messages-(\d{17,20})-/)?.[1];
  if(!user||typeof raw!=="string"||!/^\d{17,20}$/.test(raw))return undefined;
  const channels=window.Syncord?.common?.stores.ChannelStore as {getChannel?:(id:string)=>{guild_id?:string;guildId?:string}}|undefined;
  const channel=channels?.getChannel?.(raw),guildId=channel?.guild_id??channel?.guildId;
  return {userId:user.id,channelId:raw,...(guildId?{guildId}:{})};
}
export function scan(root: ParentNode, size: number, members=false,resolve?:BadgeImageResolver):ProfileTarget[] {
  const targets=new Map<string,ProfileTarget>();
  const names=usernameCandidates(root);
  const memberEntries=members?memberRows(root).flatMap(row=>{
    const node=row.querySelector('[class*="username_"],[class*="name_"]');
    if(!node||isPopoutContext(node))return [];
    const context=memberContext(node,row);
    return context?[{row,node,context}]:[];
  }):[];
  // Read geometry for the entire batch before inserting/removing decorations.
  // Interleaved badge writes and rect reads can force layout per message.
  for(const node of names){
    const rect=messageRoot(node)?.getBoundingClientRect();
    if(!rect||rect.bottom<=0||rect.top>=innerHeight||rect.width<=0)continue;
    const target=profileTarget(node);
    if(target&&targets.size<100)targets.set(`${target.userId}:${target.guildId??''}`,target);
  }
  if(members){
    for(const {row,context} of memberEntries){
      const rect=row.getBoundingClientRect();
      if(context.target&&targets.size<100&&rect.width>0&&rect.bottom>0&&rect.top<innerHeight)targets.set(`${context.user.id}:${context.guildId??''}`,context.target);
    }
  }
  for(const node of names)decorateUsername(node,size);
  if(members){
    for(const {node,row,context} of memberEntries)decorateMember(node,row,context.user,context.guildId,size);
  }else uninstallMemberDecorations();
  hydrateBadgeImages(root,resolve);
  return [...targets.values()];
}

const MEMBER_ROOT='[data-list-id^="members"],[class*="membersWrap_"],[class*="members_"]';
function memberRows(root:ParentNode):Element[]{
  return [...root.querySelectorAll('[data-list-item-id^="members-"],[class*="member_"]')]
    .filter(row=>!!row.closest(MEMBER_ROOT)&&!isPopoutContext(row));
}
function memberContext(node:Element,row:Element):{user:ChatUser;guildId:string|null;target?:ProfileTarget}|undefined {
  const list=row.closest(MEMBER_ROOT),boundary=list?getFiber(list):null;
  let fiber=getFiber(node),user:ChatUser|null=null,guild:unknown,channelId:unknown;
  for(let i=0;i<24&&fiber&&fiber!==boundary;i++,fiber=fiber.return??null){
    const props=fiber.memoizedProps??fiber.pendingProps;
    if(!props)continue;
    // Only the member's user prop, never currentUser or a parent session context.
    user??=asUser(props.user)??asUser((props.member as {user?:unknown}|undefined)?.user);
    if(guild===undefined)guild=props.guildId??props.guild_id;
    if(channelId===undefined)channelId=props.channelId??(props.channel as {id?:unknown}|undefined)?.id;
  }
  if(!user||!/^\d{17,20}$/.test(user.id))return undefined;
  const stores=window.Syncord?.common?.stores;
  const selected=stores?.SelectedChannelStore as {getChannelId?:()=>string}|undefined;
  const channels=stores?.ChannelStore as {getChannel?:(id:string)=>{guild_id?:string;guildId?:string}}|undefined;
  const id=typeof channelId==='string'?channelId:selected?.getChannelId?.();
  const channel=id?channels?.getChannel?.(id):undefined,nativeGuild=channel?.guild_id??channel?.guildId;
  const guildId=typeof guild==='string'?guild:nativeGuild??null;
  const target=id&&channel&&(guildId===null?!nativeGuild:nativeGuild===guildId)?{userId:user.id,channelId:id,...(guildId?{guildId}:{})}:undefined;
  return {user,guildId,target};
}
function decorateMember(node:Element,row:Element,user:ChatUser,guildId:string|null,size:number):void {
  if(node.getAttribute('data-dion-badge-user')!==user.id){node.removeAttribute(ATTR);findWrap(row)?.remove();node.setAttribute('data-dion-badge-user',user.id);}
  if(!row.hasAttribute('data-dion-badge-member'))row.setAttribute('data-dion-badge-member','');
  if(node.getAttribute(ATTR)==='1'&&row.getAttribute('data-dion-badge-size')===String(size)&&row.getAttribute('data-dion-badge-guild')===(guildId??''))return;
  const {badges,complete}=badgesForUser(enrichUser(user),guildId);
  if(badges.length){applyWrap(node,row,badges,size,user.id);findWrap(row)?.classList.add('dion-member-badges');}else findWrap(row)?.remove();
  node.setAttribute(ATTR,complete?'1':'pending');row.setAttribute('data-dion-badge-size',String(size));row.setAttribute('data-dion-badge-guild',guildId??'');
}
function uninstallMemberDecorations():void {
  for(const row of document.querySelectorAll('[data-dion-badge-member]')){
    row.querySelector('.dion-member-badges')?.remove();
    for(const node of row.querySelectorAll(`[${ATTR}],[data-dion-badge-user]`)){node.removeAttribute(ATTR);node.removeAttribute('data-dion-badge-user');}
    row.removeAttribute('data-dion-badge-member');row.removeAttribute('data-dion-badge-size');row.removeAttribute('data-dion-badge-guild');
  }
}

export function uninstallDecorations(): void {
  uninstallMemberDecorations();
  document.querySelectorAll(`.${WRAP_CLASS}`).forEach((n) => n.remove());
  document
    .querySelectorAll(`[${ATTR}],[data-dion-badge-user]`)
    .forEach((n) => {n.removeAttribute(ATTR);n.removeAttribute("data-dion-badge-user");});
  document
    .querySelectorAll(`[${MSG_ATTR}]`)
    .forEach((n) => {n.removeAttribute(MSG_ATTR);n.removeAttribute("data-dion-badge-size");});
}
