import { messageKeyForLabel, onLocaleChange, setLocalizedAttribute, setLocalizedText, t as i18nText } from "../../i18n";
import {accountId} from './discord';
import {describe,kindLabel,notificationEnabled,type Entry,type Config} from './types';
import {actionButtons,refreshActionButtons} from './uiActions';
import {openRelationshipHistory} from './view';
/** Bounded interactive cards, since the shared native text toast has no actions. */
export class RelationshipNotices {
 private stopLocale:(()=>void)|undefined;
 private rows:Entry[]=[];private offlineCount=0;private liveCount=0;private timer:number|undefined;private expiry:number|undefined;private root:HTMLDivElement|undefined;
 add(entries:Entry[],cfg:Config):void {
  if(this.root)refreshActionButtons(this.root,accountId());
  for(const row of entries)if(notificationEnabled(row,cfg)){if(row.offline)this.offlineCount++;else this.liveCount++;this.rows.push(row);if(this.rows.length>20)this.rows.shift();}
  if(!this.rows.length||this.timer!==undefined)return;
  this.timer=window.setTimeout(()=>{this.timer=undefined;this.flush(cfg.duration,cfg.history);},600);
 }
 private flush(duration:number,history:boolean):void {
  this.remove();const rows=this.rows.splice(0),offline=this.offlineCount,live=this.liveCount;this.offlineCount=this.liveCount=0;if(!rows.length)return;
  const account=rows[0]!.accountId;if(accountId()!==account)return;
  const root=this.root=document.createElement('div');root.id='Syncord-relationship-notices';root.className='Syncord-rn';root.setAttribute('popover','manual');root.setAttribute('role','region');setLocalizedAttribute(root, 'aria-label', "ui.relationship_notifications");
  const refreshers:(()=>void)[]=[];
  const add=(title:()=>string,body:()=>string,row?:Entry):void=>{
   const article=document.createElement('article'),heading=document.createElement('strong'),message=document.createElement('p'),feedback=document.createElement('p');
   const paint=():void=>{heading.textContent=title();message.textContent=body();};paint();refreshers.push(paint);message.setAttribute('role','status');feedback.setAttribute('role','status');
   const dismiss=document.createElement('button');dismiss.type='button';dismiss.className='rn-dismiss';dismiss.textContent='×';setLocalizedAttribute(dismiss, 'aria-label', "ui.dismiss_relationship_notification");dismiss.onclick=()=>{article.remove();if(!root.childElementCount)this.remove();};
   article.append(heading,dismiss,message);if(row)article.append(actionButtons(row,account,text=>{if(accountId()===account) {const key=messageKeyForLabel(text);if(key)setLocalizedText(feedback,key);else feedback.textContent=text;}},()=>this.clear()));
   const history=document.createElement('button');history.type='button';setLocalizedText(history, "ui.view_history");history.onclick=()=>{if(accountId()===account){this.remove();openRelationshipHistory();}};
   const actions=article.querySelector('.rn-actions')??document.createElement('div');actions.classList.add('rn-actions');actions.append(history);if(!actions.parentElement)article.append(actions);
   article.append(feedback);root.append(article);
  };
  if(offline)add(()=>i18nText('ui.changes_since_your_previous_session'),()=>i18nText('relationship.offline_changes',{count:offline})+' '+i18nText(history?'ui.open_history_for_all_names_and_detection_times':'ui.local_history_saving_is_off'));
  for(const row of rows.slice(-3))add(()=>`${row.offline?i18nText('ui.since_last_sync'):''}${kindLabel[row.kind]}`,()=>describe(row),row);
  if(!offline&&live>3)add(()=>i18nText('ui.more_relationship_changes'),()=>i18nText('relationship.additional_changes',{count:live-3})+' '+i18nText(history?'ui.open_history_to_review_them':'ui.local_history_saving_is_off'));
  this.stopLocale=onLocaleChange(()=>{if(this.root===root&&root.isConnected&&accountId()===account)for(const paint of refreshers)paint();});
  document.body.append(root);try{root.showPopover();}catch{/* Fixed positioning on older hosts. */}
  this.expiry=window.setTimeout(()=>this.remove(),duration*1000);
 }
 private remove():void {this.stopLocale?.();this.stopLocale=undefined;if(this.expiry!==undefined)clearTimeout(this.expiry);this.expiry=undefined;this.root?.remove();this.root=undefined;}
 clear():void {if(this.timer!==undefined)clearTimeout(this.timer);this.timer=undefined;this.rows=[];this.offlineCount=this.liveCount=0;this.remove();}
 dispose():void {this.clear();}
}
