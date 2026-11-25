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

export const HOME_ITEM='[data-list-item-id="guildsnav___home"]';
const square=(el:Element):number=>{const r=el.getBoundingClientRect();return Math.abs(r.width-r.height)<1&&r.width>=24&&r.width<=80?r.width:0;};
const visible=(value:string):boolean=>!!value&&value!=='transparent'&&!/rgba\([^)]*,\s*0\)$/.test(value);

/** Measure the native "Direct Messages" item so the entry matches it exactly:
 * icon size, corner radius, resting background and horizontal position.
 * Read every pass rather than hard-coding Discord's current design tokens. */
export function nativeEntryVars(rail:Element,host:Element):Record<string,string> {
 const vars:Record<string,string>={};
 const home=rail.querySelector(HOME_ITEM);
 const icon=home&&[home,...home.querySelectorAll('*')].find(square);
 if(icon){
  const size=square(icon),box=icon.getBoundingClientRect(),hostBox=host.getBoundingClientRect(),homeBox=home.getBoundingClientRect();
  vars['--syncord-virtual-size']=`${size}px`;
  if(hostBox.width>0){
   // Scroller gutters differ from the pinned home row's; align by geometry.
   vars['--syncord-virtual-offset']=`${Math.max(0,Math.round(box.left-hostBox.left))}px`;
   vars['--syncord-virtual-justify']='flex-start';
   vars['--syncord-virtual-pill']=`${Math.min(0,Math.round(Math.min(homeBox.left,rail.getBoundingClientRect().left)-hostBox.left))}px`;
  }
  for(const el of [icon,...icon.querySelectorAll('*')].filter(e=>square(e)===size)){
   const style=getComputedStyle(el);
   if(!vars['--syncord-virtual-radius']&&parseFloat(style.borderTopLeftRadius)>0)vars['--syncord-virtual-radius']=style.borderTopLeftRadius;
   // A selected or hovered home is brand-coloured; only its resting colour is useful.
   if(!vars['--syncord-virtual-bg']&&visible(style.backgroundColor)&&!home.matches(':hover')&&home.getAttribute('aria-selected')!=='true'&&!home.closest('[aria-selected="true"]'))vars['--syncord-virtual-bg']=style.backgroundColor;
  }
 }
 // A native guild without an icon renders its acronym; copy that typography.
 for(const row of rail.querySelectorAll(GUILD_ITEM)){
  if(row.matches(HOME_ITEM)||row.querySelector('img,svg'))continue;
  // Only the visible acronym inside the icon; screen-reader labels carry the
  // same text with a different weight.
  const text=[row,...row.querySelectorAll('*')].find(el=>{
   if(el.childElementCount!==0||!/^\S{1,4}$/.test(el.textContent?.trim()??''))return false;
   const box=el.getBoundingClientRect();if(box.width<4||box.height<4)return false;
   for(let parent=el.parentElement;parent&&row.contains(parent);parent=parent.parentElement)if(square(parent))return true;
   return square(row)>0;
  });
  if(!text)continue;
  const style=getComputedStyle(text);
  vars['--syncord-virtual-font']=`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  break;
 }
 return vars;
}
