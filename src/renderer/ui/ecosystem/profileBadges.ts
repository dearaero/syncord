import {BodyMutationObserver} from "../bodyObserver";
import {getFiber,type Fiber} from '../userNames';
import {mountNativeTooltip} from '../nativeTooltip';
import {ecosystemArt,ecosystemArtUrl} from './art';
import {ecoAccount,type EcoBadge} from '../../../shared/ecosystem';

const PROFILE='.user-profile-popout,.user-profile-modal,.user-profile-sidebar,[class*="userPopoutOuter_"],[class*="userProfileOuter_"],[class*="userProfileModalOuter_"],[class*="profilePanel_"]';
const BADGES='[class*="profileBadges_"],[class*="badgeList_"],[class*="badgesContainer_"]';
const ROW=BADGES+',[role="group"][aria-label]';
const ICON='img[src*="/badge-icons/"]';
const OWN='[data-syncord-profile-badges]';
const EXCLUDE='#Syncord-settings-root,.dion-badges,[data-syncord-platforms],[id^="chat-messages-"],[class*="messageListItem_"],[data-list-id^="members"],[data-list-id^="private-channels"]';
type Entry={anchor:HTMLElement;profile:Element|null;after:boolean;host?:HTMLElement;signature?:string;tooltips:(()=>void)[]};
function record(value:unknown):Record<string,unknown>|undefined{return value!==null&&typeof value==='object'?value as Record<string,unknown>:undefined;}
function id(value:unknown):string|undefined{try{return ecoAccount(value);}catch{return undefined;}}
function currentFiber(node:Element):Fiber|null{
 const attached=getFiber(node);if(!attached)return null;
 let root=attached;for(let depth=0;root.return&&depth<80;depth++)root=root.return;
 const current=(root as Fiber&{stateNode?:{current?:unknown}}).stateNode?.current;
 return current&&current!==root?(attached as Fiber&{alternate?:Fiber}).alternate??attached:attached;
}

/** Resolve the viewed profile, including current function-component userId props.
 * Never fall back to currentUser, a selected chat, or the logged-in account. */
export function profileBadgeUser(anchor:Element,profile:Element|null):string|undefined{
 const boundary=profile?.parentElement?currentFiber(profile.parentElement):null;
 for(let node:Element|null=anchor,level=0;node&&node!==document.body&&level<8;node=node.parentElement,level++){
  let fiber:Fiber|null=currentFiber(node);
  for(let depth=0;fiber&&fiber!==boundary&&depth<32;depth++,fiber=fiber.return??null){
   const host=(fiber as Fiber&{stateNode?:unknown}).stateNode;
   if(profile&&host instanceof Element&&!profile.contains(host))break;
   const props=fiber.memoizedProps??fiber.pendingProps;if(!props)continue;
   const found=id(record(props.displayProfile)?.userId)??id(record(props.userProfile)?.userId)??id(record(props.user)?.id)??id(props.userId);
   if(found)return found;
  }
  if(node===profile)break;
 }
 return undefined;
}
/** Profile cards also contain activity badge/group containers. Their user props
 * identify the profile owner, not a user-badge placement target. Check the local
 * activity context before walking upward for that owner. Never inspect a global
 * profile.activities array: that would also exclude the real profile header. */
function activityAnchor(anchor:Element,profile:Element|null):boolean{
 if(anchor.closest('[data-activity-id],[class*="activityCard_"],[class*="activitySection_"],[class*="richPresence_"]'))return true;
 const boundary=profile?currentFiber(profile):null,seen=new Set<Fiber>();
 for(let node:Element|null=anchor,level=0;node&&node!==document.body&&level<8;node=node.parentElement,level++){
  for(let fiber=currentFiber(node),depth=0;fiber&&depth<32;depth++,fiber=fiber.return??null){
   if(seen.has(fiber))break;seen.add(fiber);
   const host=(fiber as Fiber&{stateNode?:unknown}).stateNode;
   if(profile&&host instanceof Element&&!profile.contains(host))break;
   const props=fiber.memoizedProps??fiber.pendingProps,activity=record(props?.activity);
   if(activity&&typeof activity.type==='number'&&(typeof activity.name==='string'||typeof activity.application_id==='string'))return true;
   if(fiber===boundary)break;
  }
  if(node===profile)break;
 }
 return false;
}
function nativeRow(img:Element):HTMLElement|undefined{
 const explicit=img.closest(ROW);if(explicit instanceof HTMLElement)return explicit;
 // Current Discord also uses a generic container class. Match the actual badge
 // image and its flex row rather than a hash or a translated aria-label.
 let fallback:HTMLElement|undefined;
 for(let node=img.parentElement,depth=0;node&&depth<6;node=node.parentElement,depth++){
  if(node.matches('a,button,[class*="badge_"],[class*="badgeIcon_"]')||node.getAttribute('role')==='button')continue;
  const display=getComputedStyle(node).display;
  if(display==='flex'||display==='inline-flex'){if(node.querySelectorAll(ICON).length>1)return node;fallback??=node;}
  if(node.matches(PROFILE))break;
 }
 return fallback;
}

/** Compatibility rendering island inside the native badge row. Native children
 * remain untouched; only our own host is replaced/removed. No idle polling. */
export function watchProfileBadgeRows(read:(id:string)=>EcoBadge[],enabled:()=>boolean,onMounted:()=>void=()=>{}):{refresh:()=>void;stop:()=>void}{
 const entries=new Map<HTMLElement,Entry>(),pending=new Set<Document|Element>();
 let stopped=false,frame=0,reported=false;
 // A single native commit can insert a profile, its row and every badge image.
 // Keep only outermost roots so discover() never walks those subtrees again.
 const queueRoot=(root:Document|Element):void=>{
  for(const existing of pending){
   if(existing.contains(root))return;
   if(root.contains(existing))pending.delete(existing);
  }
  pending.add(root);
 };
 const clear=(entry:Entry):void=>{for(const undo of entry.tooltips)undo();entry.tooltips=[];entry.host?.remove();entry.host=undefined;entry.signature=undefined;};
 const add=(anchor:HTMLElement,profile:Element|null,after=false):void=>{
  if(entries.has(anchor)||anchor.closest(EXCLUDE)||activityAnchor(anchor,profile)||entries.size>=16)return;
  if(!after&&profile)for(const [key,entry]of entries)if(entry.after&&entry.profile===profile){clear(entry);entries.delete(key);}
  entries.set(anchor,{anchor,profile,after,tooltips:[]});
 };
 const discover=(root:ParentNode):void=>{
  const query=(selector:string):Element[]=>[...(root instanceof Element&&root.matches(selector)?[root]:[]),...root.querySelectorAll(selector)];
  for(const img of query(ICON)){
   if(img.closest(OWN+','+EXCLUDE))continue;
   const row=nativeRow(img);if(row)add(row,img.closest(PROFILE)??row.parentElement);
  }
  for(const profile of query(PROFILE)){
   if(profile.closest(EXCLUDE))continue;
   const row=[...profile.querySelectorAll(BADGES)].find(node=>!activityAnchor(node,profile));
   if(row instanceof HTMLElement){add(row,profile);continue;}
   if([...profile.querySelectorAll(ICON)].some(node=>!activityAnchor(node,profile)))continue;
   // A user with no Discord badges may have no badge container at all.
   const name=[...profile.querySelectorAll('[class*="userTag_"],[class*="nameTag_"],[class*="username_"],[class*="globalName_"],[class*="displayName_"],h1,h2')].find(node=>!activityAnchor(node,profile));
   if(name instanceof HTMLElement)add(name,profile,true);
  }
 };
 const draw=(entry:Entry):void=>{
  if(activityAnchor(entry.anchor,entry.profile)){clear(entry);entries.delete(entry.anchor);return;}
  if(!enabled()||!entry.anchor.getClientRects().length){clear(entry);return;}
  const user=profileBadgeUser(entry.anchor,entry.profile);
  if(!user){clear(entry);return;}
  const badges=read(user),nativeImages=[...entry.anchor.querySelectorAll<HTMLImageElement>('img')].filter(img=>!img.closest(OWN));
  const additions=badges.filter(b=>!nativeImages.some(img=>img.src===ecosystemArtUrl(b.art,b.image)));
  if(!additions.length){clear(entry);return;}
  const size=Math.max(16,Math.min(24,nativeImages[0]?.getBoundingClientRect().height||22));
  const signature=JSON.stringify([user,size,additions,additions.map(b=>ecosystemArtUrl(b.art,b.image))]);
  if(entry.host?.isConnected&&entry.signature===signature)return;
  clear(entry);const host=document.createElement('span');host.setAttribute('data-syncord-profile-badges',user);
  host.style.cssText='display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;vertical-align:middle;max-width:100%;';
  for(const badge of additions){
   const icon=document.createElement('span');icon.setAttribute('role','img');icon.setAttribute('aria-label',badge.name);icon.tabIndex=0;
   icon.style.cssText=`display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;cursor:pointer;width:${size}px;height:${size}px;`;
   const unmount=mountNativeTooltip(icon,badge.name,(react,props)=>react.createElement('span',{
    ...props,role:'img','aria-label':badge.name,tabIndex:0,
    style:{...(props.style!==null&&typeof props.style==='object'?props.style:{}),display:'inline-flex',cursor:'pointer',width:size,height:size},
   },react.createElement('img',{src:ecosystemArtUrl(badge.art,badge.image),width:size,height:size,alt:'',draggable:false,referrerPolicy:'no-referrer',style:{objectFit:'contain'}})),entry.anchor);
   if(unmount){entry.tooltips.push(unmount);icon.removeAttribute('role');icon.removeAttribute('aria-label');icon.removeAttribute('tabindex');}
   else{icon.innerHTML=ecosystemArt(badge.art,size,badge.image);icon.title=badge.name;}
   host.append(icon);
  }
  if(entry.after)entry.anchor.insertAdjacentElement('afterend',host);else entry.anchor.append(host);
  entry.host=host;entry.signature=signature;if(!reported){reported=true;onMounted();}
 };
 const run=():void=>{
  frame=0;if(stopped)return;
  for(const [anchor,entry]of entries)if(!anchor.isConnected){clear(entry);entries.delete(anchor);}
  for(const root of pending)if(!(root instanceof Element)||root.isConnected)discover(root);pending.clear();
  for(const entry of entries.values())draw(entry);
 };
 const schedule=():void=>{if(!stopped&&!frame)frame=requestAnimationFrame(run);};
 const owned=(node:Node):boolean=>!!(node instanceof Element?node:node.parentElement)?.closest(OWN+',#Syncord-tooltip');
 const observer=new BodyMutationObserver(records=>{
  let changed=false;
  for(const m of records){
   if(owned(m.target))continue;
   const nodes=[...m.addedNodes,...m.removedNodes];if(nodes.length&&nodes.every(owned))continue;
   const target=m.target instanceof Element?m.target:m.target.parentElement;
   const profile=target?.closest(PROFILE);if(profile){queueRoot(profile);changed=true;continue;}
   else if(target&&[...entries.values()].some(e=>e.anchor.contains(target)||!!e.profile?.contains(target))){changed=true;}
   for(const node of m.addedNodes){
    if(!(node instanceof Element)||node.closest(EXCLUDE)||owned(node))continue;
    if(node.matches(PROFILE+','+ICON+','+ROW)||node.querySelector(PROFILE+','+ICON)){queueRoot(node);changed=true;}
   }
   if(!changed&&[...entries.keys()].some(anchor=>!anchor.isConnected))changed=true;
  }
  if(changed)schedule();
 });
 observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['src'],characterData:true});
 queueRoot(document);schedule();
 return{refresh:schedule,stop:()=>{if(stopped)return;stopped=true;observer.disconnect();if(frame)cancelAnimationFrame(frame);frame=0;pending.clear();for(const entry of entries.values())clear(entry);entries.clear();}};
}
