import { dateFormatter, getLocale, onLocaleChange, h, localizeError, messageHtml as i18nHtml, setLocalizedHtml, setLocalizedText, t as i18nText } from "../../i18n";
import {css} from '../../api/css';
import {sharedDispatcher} from '../../api/discordEvents';
import {accountId,assertAccount} from './discord';
import {relationshipStorage} from './storage';
import {RN_DATA,describe,kindLabel,type Entry} from './types';
import {RELATIONSHIP_CSS} from './styles';
import {actionButtons,refreshActionButtons} from './uiActions';
let active:(()=>void)|undefined;
export const closeRelationshipHistory=():void=>active?.();
export function openRelationshipHistory():void {
 closeRelationshipHistory();const account=accountId(),previous=document.activeElement;if(!account)return;
 const root=document.createElement('dialog');root.id='Syncord-relationship-history';root.className='Syncord-rn';root.setAttribute('aria-labelledby','rn-history-title');
 setLocalizedHtml(root, `<header><div><h2 id="rn-history-title">${i18nHtml("ui.relationship_history")}</h2><small data-account></small></div><button type="button" data-close aria-label="${h("ui.close_relationship_history")}" data-si18n-aria-label="ui.close_relationship_history">×</button></header><div class="rn-toolbar"><select data-mode aria-label="${h("ui.view")}" data-si18n-aria-label="ui.view"><option value="history">${i18nHtml("ui.history")}</option><option value="backup">${i18nHtml("ui.friend_backup")}</option></select><input data-search type="search" aria-label="${h("ui.filter_loaded_entries")}" placeholder="${h("ui.filter_this_page_by_name_or_id")}" data-si18n-aria-label="ui.filter_loaded_entries" data-si18n-placeholder="ui.filter_this_page_by_name_or_id"><button type="button" data-export>${i18nHtml("ui.export_friend_backup")}</button><button type="button" data-refresh>${i18nHtml("ui.refresh")}</button></div><p class="rn-note">${i18nHtml("ui.times_show_when_syncord_detected_each_change_offline_changes_may_have_")}</p><p data-status role="status" aria-live="polite"></p><div class="rn-list" aria-label="${h("ui.saved_relationship_data")}" data-si18n-aria-label="ui.saved_relationship_data"></div><footer><span data-count></span><button type="button" data-newest>${i18nHtml("ui.newest")}</button><button type="button" data-older>${i18nHtml("ui.older")}</button></footer>`);
 const get=<T extends Element>(q:string):T=>{const el=root.querySelector<T>(q);if(!el)throw Error("Incomplete relationship view.");return el;};
 const mode=get<HTMLSelectElement>('[data-mode]'),search=get<HTMLInputElement>('[data-search]'),list=get<HTMLDivElement>('.rn-list'),status=get<HTMLParagraphElement>('[data-status]'),older=get<HTMLButtonElement>('[data-older]'),refresh=get<HTMLButtonElement>('[data-refresh]'),count=get<HTMLSpanElement>('[data-count]');
 setLocalizedText(get('[data-account]'), "ui.discord_account_value_stored_on_this_device", {v0: account});
 let closed=false,request=0,before:number|undefined,rows:Entry[]=[],more=false,backupPage=0;const urls=new Map<string,ReturnType<typeof setTimeout>>(),controller=new AbortController();
 let rowPainters:Array<()=>void>=[];
 const stopLocale=onLocaleChange(()=>{for(const paint of rowPainters)paint();});
 const clock=dateFormatter({dateStyle:'medium',timeStyle:'medium'}),dispatcher=sharedDispatcher();
 const close=():void=>{if(closed)return;closed=true;request++;stopLocale();rowPainters=[];controller.abort();window.removeEventListener(RN_DATA,changed);dispatcher?.unsubscribe('LOGOUT',close);dispatcher?.unsubscribe('CONNECTION_OPEN',identity);dispatcher?.unsubscribe('CURRENT_USER_UPDATE',identity);root.close();root.remove();css.remove('relationship-history');for(const [url,timer]of urls){clearTimeout(timer);URL.revokeObjectURL(url);}active=undefined;if(previous instanceof HTMLElement&&previous.isConnected)previous.focus({preventScroll:true});};
 const identity=():void=>{if(accountId()!==account)close();};
 const paint=():void=>{
  const query=search.value.trim().toLocaleLowerCase(getLocale());list.replaceChildren();rowPainters=[];
  for(const row of rows){
   if(query&&!`${row.name} ${row.user?.username??''} ${row.user?.id??''} ${row.subjectId} ${row.context??''}`.toLocaleLowerCase(getLocale()).includes(query))continue;
   const article=document.createElement('article'),meta=document.createElement('div'),kind=document.createElement('strong'),time=document.createElement('time'),body=document.createElement('p'),detail=document.createElement('small');
   meta.className='rn-meta';time.dateTime=new Date(row.detectedAt).toISOString();meta.append(kind,time);
   const paintRow=():void=>{kind.textContent=kindLabel[row.kind];time.textContent=clock.format(row.detectedAt);body.textContent=describe(row);
   detail.textContent=[row.user?.username,row.user?.id??row.subjectId,i18nText(row.offline?"ui.detected_after_reconnecting":"ui.live_event"),i18nText(row.cause==='local'?"ui.your_accounts_action":"ui.cause_not_attributed")].filter(Boolean).join(' · ');};paintRow();rowPainters.push(paintRow);
   article.append(meta,body,detail,actionButtons(row,account,text=>{if(!closed&&accountId()===account)status.textContent=text;},close));list.append(article);
  }
  if(!list.childElementCount){const p=document.createElement('p');setLocalizedText(p,query?"ui.no_matching_entries_on_this_page":"ui.no_saved_events_for_this_account_yet");list.append(p);}
 };
 const load=async(anchor?:number):Promise<void>=>{
  const token=++request;refresh.disabled=older.disabled=true;setLocalizedText(status, "ui.loading_local_data");list.setAttribute('aria-busy','true');
  try{
   assertAccount(account);
   if(mode.value==='backup'){
    const result=await relationshipStorage.backup(account);if(closed||token!==request)return;assertAccount(account);
    const all=result.friends.sort((a,b)=>Number(b.isFriend)-Number(a.isFriend)||a.username.localeCompare(b.username)),page=all.slice(backupPage*50,(backupPage+1)*50);rows=[];list.replaceChildren();rowPainters=[];
    for(const row of page){const article=document.createElement('article'),heading=document.createElement('strong'),body=document.createElement('p');heading.textContent=row.name;const paintRow=():void=>{body.textContent=`${row.username} · ${row.id} · ${row.isFriend?i18nText("ui.friend_at_last_backup"):i18nText("ui.former_friend_at_last_backup")}`;};paintRow();rowPainters.push(paintRow);
     article.append(heading,body,actionButtons({accountId:account,kind:'friend-added',subjectId:row.id,name:row.name,user:row,detectedAt:row.lastSeenAt,offline:false,cause:'unknown'},account,text=>{if(!closed&&accountId()===account)status.textContent=text;},close));list.append(article);}
    setLocalizedText(count, "ui.value_backed_up_users_page_value", {v0: all.length, v1: backupPage+1});more=(backupPage+1)*50<all.length;setLocalizedText(older, "ui.next_page");
    if(result.updatedAt){
     const backupAt=result.updatedAt,formatBackup=():string=>i18nText("ui.last_backup_value_export_includes_all_saved_friends_and_former_friends",{v0:clock.format(backupAt)});
     let lastBackupText=formatBackup();status.textContent=lastBackupText;
     rowPainters.push(()=>{if(status.textContent===lastBackupText){lastBackupText=formatBackup();status.textContent=lastBackupText;}});
    }else setLocalizedText(status,"ui.no_friend_backup_has_been_saved_for_this_account_yet");search.disabled=true;
   }else{
    const result=await relationshipStorage.page(account,anchor);if(closed||token!==request)return;assertAccount(account);
    rows=result.entries;before=rows[rows.length-1]?.id;more=result.more;setLocalizedText(count, "ui.value_saved_events_value_on_this_page", {v0: result.total, v1: rows.length});setLocalizedText(older,"ui.older");search.disabled=false;paint();status.textContent='';
   }
   list.scrollTop=0;older.disabled=!more;
  }catch(error){if(!closed&&token===request){if(accountId()!==account){close();return;}status.textContent=error instanceof Error?localizeError(error):i18nText("ui.could_not_read_local_relationship_data");}}
  finally{if(!closed&&token===request){refresh.disabled=false;list.removeAttribute('aria-busy');}}
 };
 const changed=(event:Event):void=>{identity();if(!closed&&event instanceof CustomEvent&&event.detail?.accountId===account){refreshActionButtons(root,account);setLocalizedText(status, "ui.new_changes_saved_refresh_to_see_the_latest");}};
 get<HTMLButtonElement>('[data-close]').onclick=close;
 root.addEventListener('cancel',event=>{event.preventDefault();close();},{signal:controller.signal});
 root.addEventListener('click',event=>{if(event.target===root){const r=root.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)close();}},{signal:controller.signal});
 refresh.onclick=()=>{void load();};older.onclick=()=>{if(mode.value==='backup'){backupPage++;void load();}else void load(before);};get<HTMLButtonElement>('[data-newest]').onclick=()=>{backupPage=0;void load();};
 mode.onchange=()=>{backupPage=0;search.value='';void load();};search.oninput=paint;
 get<HTMLButtonElement>('[data-export]').onclick=()=>{
  const token=request;setLocalizedText(status, "ui.preparing_your_local_friend_backup");
  void relationshipStorage.backup(account).then(result=>{
   if(closed||token!==request)return;assertAccount(account);
   const data={schemaVersion:1,accountId:account,exportedAt:new Date().toISOString(),backupDetectedAt:result.updatedAt?new Date(result.updatedAt).toISOString():null,friends:result.friends};
   const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));urls.set(url,setTimeout(()=>{URL.revokeObjectURL(url);urls.delete(url);},3000));
   const link=document.createElement('a');link.href=url;link.download=`Syncord-friends-${account}-${new Date().toISOString().slice(0,10)}.json`;link.hidden=true;document.body.append(link);link.click();link.remove();setLocalizedText(status, "ui.exported_value_saved_users_as_json", {v0: result.friends.length});
  }).catch(error=>{if(!closed&&accountId()===account)status.textContent=error instanceof Error?localizeError(error):i18nText("ui.could_not_export_friend_backup");});
 };
 css.inject('relationship-history',RELATIONSHIP_CSS);document.body.append(root);active=close;window.addEventListener(RN_DATA,changed);
 dispatcher?.subscribe('LOGOUT',close);dispatcher?.subscribe('CONNECTION_OPEN',identity);dispatcher?.subscribe('CURRENT_USER_UPDATE',identity);
 root.showModal();void load();
}
