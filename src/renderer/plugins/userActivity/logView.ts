import { dateFormatter, onLocaleChange, h, localizeError, messageHtml as i18nHtml, setLocalizedHtml, setLocalizedText, t as i18nText } from "../../i18n";
import {formatActivityText} from './text';
import {css} from '../../api/css';
import {activityAccount,userName} from './discord';
import {activityHistory,ACTIVITY_LOG_CHANGED,ACTIVITY_LOG_FAILED,type ActivityLogPage} from './history';

const ROOT='Syncord-user-activity-history';
const labels={presence:"ui.presence",messages:"ui.message",typing:"ui.typing",avatar:"ui.avatar",profile:"ui.profile",activities:"ui.activity",voice:"ui.voice"};
let active:{close:()=>void}|undefined;
export function closeActivityLog():void {active?.close();}

export function openActivityLog(userId:string):void {
  closeActivityLog();
  const account=activityAccount(),previous=document.activeElement;
  const dialog=document.createElement('dialog');dialog.id=ROOT;
  dialog.setAttribute('aria-labelledby','dion-ua-log-title');
  setLocalizedHtml(dialog, `<header><div class="ua-log-heading"><span>${i18nHtml("ui.user_activity_local_history")}</span><h2 id="dion-ua-log-title"></h2><small data-ua-log-id></small></div>
    <button type="button" data-ua-log-close aria-label="${h("ui.close_activity_log")}" data-si18n-aria-label="ui.close_activity_log">×</button></header>
    <div class="ua-log-toolbar"><span data-ua-log-count></span><button type="button" data-ua-log-refresh>${i18nHtml("ui.refresh")}</button></div>
    <p class="ua-log-status" data-ua-log-status role="status" aria-live="polite"></p>
    <div class="ua-log-list" data-ua-log-list aria-label="${h("ui.activity_events")}" data-si18n-aria-label="ui.activity_events"></div>
    <footer><button type="button" data-ua-log-newer>${i18nHtml("ui.newer")}</button><span>${i18nHtml("ui.newest_first")}</span><button type="button" data-ua-log-older>${i18nHtml("ui.older")}</button></footer>`);
  const title=dialog.querySelector<HTMLElement>('h2')!,id=dialog.querySelector<HTMLElement>('[data-ua-log-id]')!;
  const list=dialog.querySelector<HTMLElement>('[data-ua-log-list]')!,status=dialog.querySelector<HTMLElement>('[data-ua-log-status]')!;
  const count=dialog.querySelector<HTMLElement>('[data-ua-log-count]')!;
  const older=dialog.querySelector<HTMLButtonElement>('[data-ua-log-older]')!,newer=dialog.querySelector<HTMLButtonElement>('[data-ua-log-newer]')!;
  const refresh=dialog.querySelector<HTMLButtonElement>('[data-ua-log-refresh]')!;
  setLocalizedText(title, "ui.value_activity_log", {v0: userName(userId)});id.textContent=userId;
  let page:ActivityLogPage|undefined,closed=false,request=0;
  let rowPainters:Array<()=>void>=[];
  const stopLocale=onLocaleChange(()=>{for(const paint of rowPainters)paint();});
  const close=():void=>{
    if(closed)return;closed=true;request++;stopLocale();rowPainters=[];
    window.removeEventListener(ACTIVITY_LOG_CHANGED,changed);window.removeEventListener(ACTIVITY_LOG_FAILED,failed);
    dialog.close();dialog.remove();css.remove('user-activity-history-style');active=undefined;
    if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();
  };
  const formatter=dateFormatter({dateStyle:'medium',timeStyle:'medium'});
  const load=async(direction:'older'|'newer'='older',anchor?:number):Promise<void>=>{
    const token=++request;older.disabled=newer.disabled=refresh.disabled=true;list.setAttribute('aria-busy','true');
    setLocalizedText(status, "ui.loading_activity_history");
    try {
      if(!account)throw new Error('Your Discord account is not ready yet. Sign in and try again.');
      const result=await activityHistory.page(account,userId,direction,anchor);
      if(closed||token!==request)return;
      if(activityAccount()!==account){close();return;}
      page=result;setLocalizedText(count, "count.events", {count: result.total});
      list.replaceChildren();rowPainters=[];const fragment=document.createDocumentFragment();
      for(const row of result.entries){
        const article=document.createElement('article');article.dataset.eventId=String(row.id);
        const meta=document.createElement('div');meta.className='ua-log-meta';
        const kind=document.createElement('strong');setLocalizedText(kind,labels[row.kind]);
        const time=document.createElement('time');time.dateTime=new Date(row.timestamp).toISOString();
        meta.append(kind,time);
        const text=document.createElement('p');
        const paint=():void=>{text.textContent=formatActivityText(row);time.textContent=formatter.format(row.timestamp);};paint();rowPainters.push(paint);
        const context=document.createElement('small');context.textContent=[row.userName,row.channelName??row.channelId].filter(Boolean).join(' · ');
        article.append(meta,text);
        if(row.kind==='messages'){
          const body=document.createElement('p');body.className='ua-log-message';body.dataset.uaMessageContent='';
          if(row.content)body.textContent=row.content;
          else setLocalizedText(body,row.content===undefined?"ui.message_content_unavailable_not_recorded":"ui.no_text_content_attachment_sticker_or_embed_only");
          article.append(body);
        }
        article.append(context);fragment.append(article);
      }
      list.append(fragment);list.scrollTop=0;
      if(result.entries.length)status.textContent='';else setLocalizedText(status,"ui.no_events_saved_for_this_user_yet");
      older.disabled=!result.hasOlder;newer.disabled=!result.hasNewer;
    }catch(error){if(!closed&&token===request)status.textContent=error instanceof Error?localizeError(error):i18nText("ui.could_not_load_local_activity_history_try_again");}
    finally{if(!closed&&token===request){refresh.disabled=false;list.removeAttribute('aria-busy');}}
  };
  const failed=():void=>{setLocalizedText(status, "ui.activity_history_could_not_be_saved_check_available_disk_space_and_try");};
  const changed=(event:Event):void=>{
    if(activityAccount()!==account){close();return;}
    const detail=event instanceof CustomEvent?event.detail as {accountId?:string;userIds?:string[]}|undefined:undefined;
    if(detail?.accountId===account&&detail.userIds?.includes(userId))setLocalizedText(status, "ui.new_events_saved_refresh_to_see_the_latest");
  };
  dialog.querySelector<HTMLButtonElement>('[data-ua-log-close]')!.addEventListener('click',close);
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  dialog.addEventListener('click',event=>{
    if(event.target!==dialog)return;const r=dialog.getBoundingClientRect();
    if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)close();
  });
  older.addEventListener('click',()=>{const rows=page?.entries;if(rows?.length)void load('older',rows[rows.length-1]!.id);});
  newer.addEventListener('click',()=>{const first=page?.entries[0];if(first)void load('newer',first.id);});
  refresh.addEventListener('click',()=>{void load();});
  css.inject('user-activity-history-style',`
    #${ROOT}{box-sizing:border-box;width:min(760px,calc(100vw - 24px));height:min(680px,calc(100dvh - 24px));max-width:none;max-height:none;margin:auto;padding:0;border:1px solid var(--border-subtle,#393a40);border-radius:16px;background:var(--background-base-low,#1e1f22);color:var(--text-default,#eee);font:14px var(--font-primary,sans-serif);box-shadow:0 20px 80px #0008;}
    #${ROOT}[open]{display:flex;flex-direction:column;}#${ROOT}::backdrop{background:#000a;}
    #${ROOT} header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px;flex-shrink:0;}
    #${ROOT} .ua-log-heading{min-width:0;}#${ROOT} h2{font-size:18px;margin:5px 0;overflow-wrap:anywhere;}
    #${ROOT} small,#${ROOT} .ua-log-heading>span{color:var(--text-muted,#aaa);font-size:12px;overflow-wrap:anywhere;}
    #${ROOT} button{font:inherit;cursor:pointer;flex-shrink:0;border:1px solid var(--border-subtle,#393a40);border-radius:8px;background:var(--background-modifier-accent,#303138);color:inherit;padding:6px 12px;}
    #${ROOT} button:hover:not(:disabled){background:var(--background-modifier-hover,#40414a);}#${ROOT} button:disabled{opacity:.4;cursor:default;}
    #${ROOT} button:focus-visible{outline:2px solid var(--text-link,#00a8fc);outline-offset:2px;}
    #${ROOT} [data-ua-log-close]{font-size:22px;padding:2px 10px;}
    #${ROOT} .ua-log-toolbar,#${ROOT} footer{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 18px;border-block:1px solid var(--border-subtle,#393a40);flex-shrink:0;}
    #${ROOT} footer{border-bottom:0;}#${ROOT} footer span{font-size:12px;color:var(--text-muted,#aaa);}
    #${ROOT} .ua-log-status{padding:8px 18px;margin:0;flex-shrink:0;font-size:12px;overflow-wrap:anywhere;}#${ROOT} .ua-log-status:empty{display:none;}
    #${ROOT} .ua-log-list{flex:1;min-height:0;overflow:auto;padding:0 18px;overscroll-behavior:contain;}
    #${ROOT} article{padding:14px 0;border-bottom:1px solid var(--border-subtle,#393a40);overflow-wrap:anywhere;}
    #${ROOT} .ua-log-meta{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px;}
    #${ROOT} time{font-size:11px;color:var(--text-muted,#aaa);font-variant-numeric:tabular-nums;}#${ROOT} article p{margin:6px 0;white-space:pre-wrap;line-height:1.45;}
    #${ROOT} .ua-log-message{padding:10px 12px;border-radius:8px;background:var(--background-modifier-accent,#303138);user-select:text;}
    @media(max-width:400px){#${ROOT} header{padding:12px;}#${ROOT} .ua-log-list{padding:0 12px;}#${ROOT} footer,#${ROOT} .ua-log-toolbar{padding:10px 12px;}#${ROOT} h2{font-size:16px;}}
    @media(max-height:400px){#${ROOT} header{padding:8px 12px;}#${ROOT} .ua-log-heading>span,#${ROOT} [data-ua-log-id]{display:none;}#${ROOT} footer,#${ROOT} .ua-log-toolbar{padding:6px 12px;}}
  `);
  document.body.append(dialog);active={close};window.addEventListener(ACTIVITY_LOG_CHANGED,changed);window.addEventListener(ACTIVITY_LOG_FAILED,failed);
  dialog.showModal();void load();
}
