import {getFiber,type Fiber} from '../../ui/userNames';
import {expressionDraft} from '../../chat/expressionDraft';
import {mediaAlternative,native,type Alternative,type Media} from './model';
export type Bag=Record<string,unknown>;
export const object=(v:unknown):v is Bag=>v!==null&&typeof v==='object';
type Channel={id:string;type:number;guild_id?:string};
function store<T>(name:string):T|undefined{return (window.Syncord?.common?.stores as unknown as Bag|undefined)?.[name] as T|undefined??window.Syncord?.webpack?.findByStoreName(name) as T|undefined;}
export function account():string|undefined {return store<{getCurrentUser?:()=>{id?:string}}>('UserStore')?.getCurrentUser?.()?.id;}
export type Selection={kind:'emoji'|'sticker';id:string;props:Bag;channelId:string};
/** Resolve the actual React owner, including portal/thread/pane owners. Never use the selected route. */
export function selectionFrom(node:Element):Selection|undefined {
  let kind:'emoji'|'sticker'|undefined,id:string|undefined,props:Bag|undefined;
  const cell=node.closest('[data-type="emoji"],[data-type="sticker"],[role="gridcell"]');
  if(!cell){
    const active=node.getAttribute('aria-activedescendant');
    const target=active?node.ownerDocument.getElementById(active):null;
    return target&&target!==node&&node.contains(target)?selectionFrom(target):undefined;
  }
  if(cell){
    const button=node.closest('button');
    if(button&&button!==cell&&!button.hasAttribute('data-id'))return;
    kind=cell.getAttribute('data-type') as typeof kind;id=cell.getAttribute('data-id')??undefined;
  }
  let fiber: Fiber|null=getFiber(node);
  // Icons/images can be plain DOM below the React-owned clickable node.
  for(let parent:Element|null=node;!fiber&&parent&&parent!==cell?.parentElement;parent=parent.parentElement)fiber=getFiber(parent);
  for(let depth=0;fiber&&depth<64;depth++,fiber=fiber.return??null){
    const p=fiber.memoizedProps??fiber.pendingProps;if(!p)continue;
    for(const key of ['emoji','sticker'] as const){const value=p[key];if(!id&&object(value)&&typeof value.id==='string'){kind=key;id=value.id;}}
    if(typeof p.onSelectEmoji==='function'&&typeof p.onSelectSticker==='function'&&typeof p.onSelectGIF==='function'&&object(p.channel)&&typeof p.channel.id==='string') {props=p;break;}
  }
  if(!props||(kind!=='emoji'&&kind!=='sticker')||!id||!/^\d{17,20}$/.test(id))return;
  const intention=window.Syncord?.webpack.findByProps('EmojiIntention') as {EmojiIntention?:{CHAT?:unknown}}|undefined;
  const type=props.type,chat=intention?.EmojiIntention?.CHAT;
  if(!object(type)||chat==null)return;
  // Discord's full ExpressionPicker defaults an omitted intention to CHAT.
  // Normal/sidebar composers omit expressionPicker entirely; do not reject them.
  const config=type.expressionPicker;
  if(config!=null&&!object(config))return;
  if((object(config)?config.emojiIntention??chat:chat)!==chat)return;
  if(object(type.permissions)&&type.permissions.requireSendMessages===false)return;
  return {kind,id,props,channelId:(props.channel as Channel).id};
}
type StickerSendability={check:(media:Media,user:Bag,channel:Channel)=>unknown;premium:unknown};
/** Discover the loaded native module by its enum and semantic calls, never export hashes. */
function stickerSendability():StickerSendability|undefined {
  let result:StickerSendability|undefined;
  window.Syncord?.webpack.find(value=>{
    if(!object(value))return false;
    const exports=Object.values(value);
    const reasons=exports.find(item=>object(item)&&['SENDABLE','SENDABLE_WITH_PREMIUM','NONSENDABLE','SENDABLE_WITH_BOOSTED_GUILD'].every(key=>typeof item[key]==='number'));
    if(!object(reasons))return false;
    const check=exports.find(item=>{
      if(typeof item!=='function')return false;
      const source=Function.prototype.toString.call(item);
      return ['canUseCustomStickersEverywhere','getSelfMember','getStickerPack'].every(signal=>source.includes(signal));
    });
    if(typeof check!=='function')return false;
    result={check:check as StickerSendability['check'],premium:reasons.SENDABLE_WITH_PREMIUM};
    return true;
  });
  return result;
}
export function alternative(selection:Selection):Alternative {
  const {kind,id,channelId}=selection;
  const channel=store<{getChannel?:(id:string)=>Channel}>('ChannelStore')?.getChannel?.(channelId);
  const user=store<{getCurrentUser?:()=>{id?:string;premiumType?:number|null;premium_type?:number|null}}>('UserStore')?.getCurrentUser?.();
  if(!user?.id||!channel||![0,1,3,5,10,11,12].includes(channel.type))return native;
  const media=kind==='emoji'
    ?store<{getCustomEmojiById?:(id:string)=>Media}>('EmojiStore')?.getCustomEmojiById?.(id)
    :store<{getStickerById?:(id:string)=>Media}>('StickersStore')?.getStickerById?.(id);
  if(!media||media.id!==id||media.available===false)return native;
  const guild=media.guildId??media.guild_id;
  // Cached assets from departed/inaccessible guilds are never eligible.
  if(guild&&!store<{getGuild?:(id:string)=>unknown}>('GuildStore')?.getGuild?.(guild))return native;
  let blocked=false;
  if(kind==='emoji'){
    if(!guild)return native;
    const availability=window.Syncord?.webpack.findByProps('getEmojiUnavailableReason') as {getEmojiUnavailableReason?:(options:Bag)=>unknown}|undefined;
    const enums=window.Syncord?.webpack.findByProps('PREMIUM_LOCKED','DISALLOW_EXTERNAL') as Bag|undefined;
    const constants=window.Syncord?.webpack.findByProps('EmojiIntention') as {EmojiIntention?:{CHAT?:unknown}}|undefined;
    if(!availability?.getEmojiUnavailableReason||!enums||constants?.EmojiIntention?.CHAT==null)return native;
    const reason=availability.getEmojiUnavailableReason({emoji:media,channel,intention:constants.EmojiIntention.CHAT});
    blocked=reason!=null&&(reason===enums.PREMIUM_LOCKED||reason===enums.DISALLOW_EXTERNAL);
  } else {
    const sendability=stickerSendability();
    if(!sendability)return native;
    // Let Discord evaluate membership, channel permissions, availability and
    // real entitlements. Non-Nitro User models normalize premiumType to null.
    blocked=sendability.check(media,user,channel)===sendability.premium;
  }
  return mediaAlternative(kind,media,blocked);
}
type Editor={selection:unknown;children:unknown[];insertText:(text:string)=>void};
/** Bind insertion to the picker's native anchor and an explicit channel owner. */
export function draftInsertion(selection:Selection):((text:string,close:boolean)=>boolean)|undefined {
  const registered=expressionDraft(selection.props.type);
  if(registered){if(registered.channelId!==selection.channelId||!registered.valid())return;return(text,close)=>{if(!registered.valid())return false;registered.insertText(text,close);return true;};}
  const ref=selection.props.positionTargetRef;
  const anchor=object(ref)?ref.current:undefined;
  if(!anchor||typeof (anchor as Element).closest!=='function')return;
  const root=(anchor as Element).closest('[class*="channelTextArea_"],[class*="channelTextArea__"]');
  const editable=root?.querySelector('[data-slate-editor="true"]');
  if(!editable)return;
  let editor:Editor|undefined,channelId:string|undefined;
  for(let fiber=getFiber(editable),n=0;fiber&&n<48;n++,fiber=fiber.return??null){
    const p=fiber.memoizedProps??fiber.pendingProps;if(!p)continue;
    const candidate=p.editor;
    if(!editor&&object(candidate)&&typeof candidate.insertText==='function'&&Array.isArray(candidate.children)&&candidate.selection)editor=candidate as Editor;
    const explicit=object(p.channel)?p.channel.id:p.channelId;
    if(!channelId&&typeof explicit==='string')channelId=explicit;
    if(editor&&channelId)break;
  }
  if(!editor||channelId!==selection.channelId)return;
  const target=editor,owner=account();
  return (text,close)=>{
    if(!editable.isConnected||!owner||account()!==owner||!target.selection)return false;
    // Re-resolve ownership before touching Slate; React can recycle the same DOM.
    let current:string|undefined,liveEditor:unknown;
    for(let f=getFiber(editable),n=0;f&&n<48;n++,f=f.return??null){const p=f.memoizedProps??f.pendingProps;if(p){if(!liveEditor&&object(p.editor)&&typeof p.editor.insertText==='function')liveEditor=p.editor;const id=object(p.channel)?p.channel.id:p.channelId;if(!current&&typeof id==='string')current=id;if(current&&liveEditor)break;}}
    if(current!==selection.channelId||liveEditor!==target)return false;
    target.insertText(text);
    if(close&&typeof selection.props.onClose==='function'){
      try{selection.props.onClose();}catch{/* Keep the inserted draft even if Discord cannot dismiss the picker. */}
    }
    return true;
  };
}
