import { setLocalizedAttribute } from "../../i18n";
import {readPlatforms,platformLabel,type PlatformPresenceStore,type PlatformIndicator} from '../../api/discordEvents/presence';
import {bindTooltip} from '../../ui/tooltip';
import {platformIcon} from './icons';
import type {PlatformAnchor} from './anchors';
type Entry={anchor:PlatformAnchor;key:string;wrap?:HTMLElement;dispose:(()=>void)[]};
/** Only mounted, visible username anchors are retained. Native presence remains the only data cache. */
export class PlatformRenderer {
  private entries=new Map<HTMLElement,Entry>();
  private users=new Set<string>();
  visible(id:string):boolean{return this.users.has(id);}
  targets(anchors:PlatformAnchor[]):void {
    const names=new Set(anchors.map(a=>a.name));
    for(const [node,entry] of this.entries)if(!names.has(node)){this.remove(entry);this.entries.delete(node);}
    this.users.clear();
    for(const anchor of anchors){
      let entry=this.entries.get(anchor.name);
      if(entry&&(entry.anchor.userId!==anchor.userId||entry.anchor.surface!==anchor.surface)){this.remove(entry);entry=undefined;}
      if(!entry){entry={anchor,key:'',dispose:[]};this.entries.set(anchor.name,entry);}else entry.anchor=anchor;
      this.users.add(anchor.userId);
    }
  }
  refresh(store:PlatformPresenceStore|undefined,showActivities:boolean,changed?:ReadonlySet<string>):void {
    const snapshot=new Map<string,PlatformIndicator[]>();
    for(const entry of this.entries.values()){
      if(changed&&!changed.has(entry.anchor.userId))continue;
      if(!entry.anchor.name.isConnected){this.remove(entry);continue;}
      const id=entry.anchor.userId;
      if(!snapshot.has(id))snapshot.set(id,readPlatforms(store,id,showActivities));
      const rows=snapshot.get(id)!;
      const key=id+':'+rows.map(row=>`${row.id}/${row.status}/${row.source}`).join(',');
      if(entry.key===key&&(!rows.length||entry.wrap?.parentElement===entry.anchor.name.parentElement))continue;
      this.remove(entry);entry.key=key;if(!rows.length)continue;
      const wrap=document.createElement('span');wrap.dataset.syncordPlatforms='';wrap.dataset.userId=id;wrap.dataset.surface=entry.anchor.surface;
      wrap.setAttribute('role','group');setLocalizedAttribute(wrap, 'aria-label', "ui.reported_platforms");
      for(const row of rows){
        const icon=document.createElement('span');icon.className='syncord-platform-icon';icon.dataset.platform=row.id;icon.dataset.status=row.status;icon.dataset.source=row.source;
        icon.setAttribute('role','img');icon.setAttribute('aria-label',platformLabel(row));icon.innerHTML=platformIcon(row.icon);
        entry.dispose.push(bindTooltip(icon,platformLabel(row)));wrap.append(icon);
      }
      entry.wrap=wrap;entry.anchor.name.insertAdjacentElement('afterend',wrap);
    }
  }
  private remove(entry:Entry):void {for(const dispose of entry.dispose)dispose();entry.dispose=[];entry.wrap?.remove();entry.wrap=undefined;entry.key='';}
  clear():void {for(const entry of this.entries.values())this.remove(entry);this.entries.clear();this.users.clear();}
}
