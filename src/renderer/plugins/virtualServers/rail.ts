const GUILD_ITEM='[data-list-item-id^="guildsnav___"]';
/** guildsnav can own both pinned controls and an inner scrolling guild list.
 * Use a real guild row's scroll ancestor; overflow geometry must not depend on
 * whether the list currently overflows or on Discord's hashed CSS names. */
export function railMountPoint(rail:Element):Element {
 for(const row of rail.querySelectorAll(GUILD_ITEM)){
  if(!/^guildsnav___[1-9]\d*$/.test(row.getAttribute('data-list-item-id')??''))continue;
  let mount:Element|undefined;
  for(let parent=row.parentElement;parent&&rail.contains(parent);parent=parent.parentElement){
   // Prefer the rail's outer scroll surface over an expanded folder's inner one.
   if(/^(auto|scroll|overlay)$/.test(getComputedStyle(parent).overflowY)&&(parent!==rail||!mount))mount=parent;
   if(parent===rail)break;
  }
  if(mount)return mount;
 }
 return rail;
}
/** Only native guild-list structural changes need to retry the mount point. */
export function railStructureChanged(rail:Element|undefined,record:MutationRecord):boolean {
 if(!rail?.contains(record.target))return false;
 return [...record.addedNodes,...record.removedNodes].some(node=>node instanceof Element&&!node.matches('[data-syncord-virtual-entry]')&&(node.matches(GUILD_ITEM)||!!node.querySelector(GUILD_ITEM)));
}
