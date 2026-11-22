import {usernameCandidates,messageFromUsernameNode,messageRoot,rowUserId} from '../../ui/userNames';
import type {PlatformOptions} from './settings';
export type PlatformAnchor={name:HTMLElement;row:Element;userId:string;surface:string};
const valid=(id:unknown):id is string=>typeof id==='string'&&/^\d{17,20}$/.test(id);
const MEMBER_ROOT='[data-list-id^="members"],[class*="membersWrap_"],[class*="members_"]';
const PROFILE='[class*="userPopoutOuter_"],[class*="userProfileOuter_"],[class*="userProfileModalOuter_"],[class*="profilePanel_"]';
export function platformAnchors(root:ParentNode,options:PlatformOptions):PlatformAnchor[] {
  const found=new Map<HTMLElement,PlatformAnchor>();
  const add=(name:Element|null,row:Element|null,id:unknown,surface:string):void=>{
    if(!(name instanceof HTMLElement)||!row||!valid(id)||found.has(name)||name.closest('#Syncord-settings-root,[data-syncord-platforms]'))return;
    const rect=row.getBoundingClientRect();
    if(rect.width<=0||rect.height<=0||rect.bottom<=0||rect.top>=innerHeight||rect.right<=0||rect.left>=innerWidth||name.getClientRects().length===0)return;
    found.set(name,{name,row,userId:id,surface});
  };
  if(options.messages===true)for(const name of usernameCandidates(root))add(name,messageRoot(name),(messageFromUsernameNode(name)?.author as {id?:unknown}|undefined)?.id,'message');
  if(options.memberList===true)for(const row of root.querySelectorAll('[data-list-item-id^="members-"],[class*="member_"]')){
    if(!row.closest(MEMBER_ROOT))continue;
    const name=row.querySelector('[class*="username_"],[class*="name_"]');if(name)add(name,row,rowUserId(name,row),'member');
  }
  if(options.friends===true)for(const row of root.querySelectorAll('[class*="peopleListItem_"]')){
    const name=row.querySelector('[class*="username_"],[class*="globalName_"]');if(name)add(name,row,rowUserId(name,row),'friend');
  }
  if(options.dms===true)for(const row of root.querySelectorAll('a[href^="/channels/@me/"]')){
    if(!row.closest('[class*="privateChannels_"],[data-list-id^="private-channels"]'))continue;
    const id=row.getAttribute('href')?.match(/^\/channels\/@me\/(\d{17,20})$/)?.[1];if(!id)continue;
    const store=window.Syncord?.common?.stores.ChannelStore as {getChannel?:(id:string)=>{type?:unknown;recipients?:unknown}}|undefined;
    let channel;try{channel=store?.getChannel?.(id);}catch{continue;}
    if(channel?.type!==1||!Array.isArray(channel.recipients)||channel.recipients.length!==1)continue;
    add(row.querySelector('[class*="name_"],[class*="username_"]'),row,channel.recipients[0],'dm');
  }
  if(options.profiles===true)for(const row of root.querySelectorAll(PROFILE)){
    const name=row.querySelector('[class*="nickname_"],[class*="globalName_"],[class*="displayName_"],[class*="username_"]');
    if(!name)continue;
    // Profile components may put user only on the outer card fiber.
    const id=rowUserId(name,row)??rowUserId(row,row);
    add(name,row,id,'profile');
  }
  return [...found.values()];
}
