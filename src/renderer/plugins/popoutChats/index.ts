import {readChatHistory,retainChatAccounts,type SavedChat} from "./history";
import {definePlugin} from '../../api/plugin';
import type {PluginContext} from '../../api/plugin';
import {t,getLocale,onLocaleChange,localizeError,setLocalizedText,setLocalizedAttribute} from '../../i18n';
import {appendNativeMenuAction,inspectMenuContext,watchNativeMenus} from '../../ui/nativeMenus';
import {channelAvatarUrl,channelTitle,currentUserId,getMessages,getMessage,getChannel,fetchInitialMessages,fetchOlderMessages,subscribeMessageStore,sendCanvasMessage,listChannelChoices,userDisplayName,channelViewable,channelSendError,hasMoreBefore,getCurrentChannelId} from '../multiChatCanvas/discord';
import {copyNativePickerStyles} from '../../chat/nativePickerWindow';
import {messageHtml,dateSeparatorHtml,sameCalendarDay} from '../../chat/messageView';
import {createMediaPicker} from '../multiChatCanvas/mediaPicker';
import {createUploads,validateCustomEmojis,mediaError,type NativeUpload} from '../multiChatCanvas/mediaDiscord';
import {addFiles,releaseFiles} from '../multiChatCanvas/mediaDraft';
import type {PaneRuntime} from '../multiChatCanvas/types';
import {isExpiredPopoutSession,POPOUT_MEDIA_HOSTS,type ChatBounds,type ChatEvent,type ChatState} from '../../../shared/popoutChats';
import {registerPopoutOpener} from './service';

type Saved=SavedChat;
type Model={pickerSize?:{width:number;height:number};pickerReady?:string;pane:PaneRuntime;endId?:string;html:string;draftVersion:number;error:string;loading:boolean;uploads:NativeUpload[];closed:boolean;lastState:string;renderFingerprint:string};
function pane(id:string,draft:string):PaneRuntime{return {id,channelId:id,draft,files:[],stickers:[],sending:false,loading:false,loadingOlder:false,atBottom:true,newMessages:0,fingerprint:'',initialScrollDone:false};}
export const PopoutChatsPlugin=definePlugin({
  id:'popout-chats',name:'Popout Chats',get description(){return t('popout.description');},enabledByDefault:true,
  permissions:{native:['popout-chats'],media:true,userData:true,discordStores:['message','channel','guild','user'],discordActions:['message-send']},
  start(ctx){startPopoutChats(ctx);},
});
export function startPopoutChats(ctx:PluginContext):void {
  let active=true,account='',session='',connecting:Promise<void>|undefined,saveTimer:number|undefined,refreshTimer:number|undefined;
  let pendingPickerStyles:AbortController|undefined;let pickerPopup:Window|null=null;let saved:Record<string,Saved>={},pickerChannel:string|undefined;const models=new Map<string,Model>(),picker=createMediaPicker(()=>()=>{});
  ctx.disposable(()=>pendingPickerStyles?.abort());
  const labelKeys:Record<string,string>={'pin':'popout.pin','loading':'ui.loading_messages','latest':'popout.latest','attach':'ui.attach_files','emoji':'ui.emoji','gif':'ui.gif','sticker':'ui.stickers','send':'ui.send_message','cancel-reply':'ui.cancel_reply','clear-files':'ui.clear','message':'ui.message_text','failed':'ui.could_not_complete_the_request_please_try_again','file-limit':'popout.file_limit'};
  const persist=():void=>{
    if(!account)return;
    ctx.settings.set('accounts',retainChatAccounts(ctx.settings.get('accounts'),account,saved));
  };
  const save=():void=>{window.clearTimeout(saveTimer);saveTimer=window.setTimeout(persist,200);};
  const valid=(m:Model):boolean=>active&&!m.closed&&currentUserId()===account&&models.get(m.pane.id)===m;
  const cancel=(m:Model):void=>{m.closed=true;for(const upload of m.uploads)try{upload.cancel();}catch{/* already finished */}releaseFiles(m.pane);};
  const access=(id:string):boolean=>channelViewable(id);
  const paint=(m:Model):void=>{
    if(!valid(m)||!session)return;const id=m.pane.id,allowed=access(id);
    if(!allowed&&pickerChannel===id){pickerChannel=undefined;pendingPickerStyles?.abort();picker.close();if(pickerPopup&&!pickerPopup.closed)pickerPopup.close();pickerPopup=null;}
    const all=allowed?getMessages(id):[];const end=m.endId?all.findIndex(x=>x.id===m.endId)+1:all.length;
    const start=Math.max(0,(end||all.length)-250);
    const messages=all.slice(start,end||all.length);
    const signature=JSON.stringify([getLocale(),allowed,m.endId,messages.map(msg=>[msg.id,msg.content,msg.editedTimestamp,msg.edited_timestamp,msg.attachments,msg.embeds,msg.stickerItems??msg.sticker_items??msg.stickers,msg.author?.id,msg.author?.avatar,userDisplayName(msg.author)])]);
    let html=m.html;if(signature!==m.renderFingerprint){html='';const chunks:string[]=[];let bytes=0;for(let i=0;i<messages.length;i++){
      const msg=messages[i],previous=messages[i-1];const chunk=(!sameCalendarDay(previous?.timestamp,msg.timestamp)?dateSeparatorHtml(msg.timestamp):'')+messageHtml(msg,previous,id);
      chunks.push(chunk);bytes+=chunk.length;while(bytes>1500000&&chunks.length>1)bytes-=chunks.shift()?.length??0;
    }html=chunks.join('');
    }m.html=html;m.renderFingerprint=signature;
    const title=channelTitle(id).title;
    const state:ChatState={pickerSize:m.pickerSize,pickerReady:m.pickerReady,title:title.slice(0,200),avatar:channelAvatarUrl(id)??'',html,draft:m.pane.draft,draftVersion:m.draftVersion,reply:m.pane.reply?`${m.pane.reply.authorName}: ${m.pane.reply.preview}`.slice(0,300):'',
      stickers:m.pane.stickers.map(x=>({id:x.id,name:x.name.slice(0,200),format:x.format_type??1})),attachments:[...m.pane.files.map(x=>x.file.name),...m.pane.stickers.map(x=>x.name)].join(' · ').slice(0,3000),busy:m.pane.sending,historyLoading:m.loading,older:allowed&&messages.length>0&&(start>0||hasMoreBefore(id)),error:!allowed?t('ui.this_chat_is_unavailable_or_you_do_not_have_permission_to_view_it_your'):m.error,
      locale:getLocale(),light:document.documentElement.classList.contains('theme-light')||Boolean(document.querySelector('body.theme-light')),labels:Object.fromEntries(Object.entries(labelKeys).map(([name,key])=>[name,t(key)]))};
    const fingerprint=JSON.stringify(state);if(fingerprint===m.lastState)return;m.lastState=fingerprint;
    void ctx.popoutChats.publish(session,id,state).catch(error=>{m.lastState='';if(state.pickerReady)ctx.log.warn('Native media picker readiness rejected',error);});
  };
  const refresh=():void=>{refreshTimer=undefined;for(const m of models.values())paint(m);};
  const schedule=():void=>{if(refreshTimer!==undefined)return;refreshTimer=window.setTimeout(refresh,80);};
  const connect=async():Promise<void>=>{
    const next=currentUserId()??'';if(next===account&&session)return;
    if(connecting){await connecting;if(next===account&&session)return;}
    const run=async():Promise<void>=>{
      pendingPickerStyles?.abort();persist();for(const m of models.values())cancel(m);models.clear();pickerChannel=undefined;picker.close();const old=session;session='';account='';if(old)await ctx.popoutChats.stop(old);
      if(!active||!next)return;
      account=next;saved=readChatHistory(ctx.settings.get('accounts.'+account));
      const token=await ctx.popoutChats.connect(next);if(!active||currentUserId()!==next){await ctx.popoutChats.stop(token);account='';return;}session=token;
    };
    connecting=run();try{await connecting;}finally{connecting=undefined;}
  };
  const open=async(id:string,recover=true):Promise<void>=>{
    let created:Model|undefined;
    try{
      await connect();if(!active||!session||!access(id))return;
      if(!models.has(id)&&models.size>=8){window.Syncord?.toast?.show(t('ui.could_not_complete_the_request_please_try_again'));return;}
      let m=models.get(id);if(!m){m={pane:pane(id,saved[id]?.draft??''),html:'',draftVersion:0,error:'',loading:false,uploads:[],closed:false,lastState:'',renderFingerprint:''};models.set(id,m);created=m;}
      saved[id]={...saved[id],draft:m.pane.draft,reopen:true,updated:Date.now()};
      // Cap retained histories without ever evicting an open window's draft.
      for(const old of Object.keys(saved).sort((a,b)=>saved[a].updated-saved[b].updated))if(Object.keys(saved).length>16&&!models.has(old))delete saved[old];
      save();const openingSession=session,openingAccount=account;
      try{await ctx.popoutChats.open(openingSession,id,saved[id]?.bounds);}
      catch(error){
        if(!recover||!isExpiredPopoutSession(error))throw error;
        if(!active||currentUserId()!==openingAccount)return;
        // A revoked lease has no valid windows. Reconnect through the normal
        // account-bound handshake, retaining text drafts, and retry only OPEN.
        if(session===openingSession)session='';
        await connect();
        if(!active||account!==openingAccount||currentUserId()!==openingAccount)return;
        return open(id,false);
      }
      paint(m);
      if(!getMessages(id).length&&!m.loading){m.loading=true;paint(m);try{await fetchInitialMessages(id);}catch(error){m.error=localizeError(mediaError(error));}finally{m.loading=false;paint(m);}}
    }catch(error){if(created&&models.get(id)===created){cancel(created);models.delete(id);}ctx.log.warn('Could not open chat popout',error);window.Syncord?.toast?.show(t('ui.could_not_complete_the_request_please_try_again'));}
  };
  const handle=async(event:ChatEvent):Promise<void>=>{
    if(event.session!==session||currentUserId()!==account)return;
    const m=models.get(event.channelId);if(!m||!valid(m))return;const p=m.pane;
    if(event.type==='bounds'){saved[p.id]={...saved[p.id],draft:p.draft,bounds:event.bounds,reopen:true,updated:Date.now()};save();return;}
    if(event.type==='closed'){
      if(pickerChannel===p.id){pickerChannel=undefined;pendingPickerStyles?.abort();picker.close();}
      saved[p.id]={...saved[p.id],draft:p.draft,bounds:event.bounds,reopen:false,updated:Date.now()};cancel(m);models.delete(p.id);persist();return;
    }
    if(event.type==='picker-closed'){if(pickerChannel===p.id){pickerChannel=undefined;pendingPickerStyles?.abort();picker.close();}if(event.reason==='startup-timeout'){m.pickerReady=undefined;m.pickerSize=undefined;m.error=t('ui.discord_s_media_menu_could_not_be_displayed_your_draft_is_kept');paint(m);}return;}
    if(event.type==='picker'){
      if(p.sending)return;m.error='';paint(m);
      pickerChannel=undefined;pendingPickerStyles?.abort();picker.close();pickerPopup?.close();pickerPopup=null;
      const styles=new AbortController();pendingPickerStyles=styles;
      let popup:Window|null=null,themeObserver:MutationObserver|undefined;
      try{
        popup=window.open('about:blank',event.frameName);if(!popup)throw Error('Native picker window was blocked');pickerPopup=popup;pickerChannel=p.id;
        const doc=popup.document;doc.head.replaceChildren();doc.body.replaceChildren();
        const mediaSources=POPOUT_MEDIA_HOSTS.map(host=>'https://'+host).join(' ');
        const policy=doc.createElement('meta');policy.httpEquiv='Content-Security-Policy';policy.content=`default-src 'none';script-src 'none';style-src 'unsafe-inline' ${location.origin};font-src ${location.origin} https://cdn.discordapp.com data:;img-src ${location.origin} ${mediaSources} data:;media-src ${mediaSources};connect-src 'none';frame-src 'none';object-src 'none';base-uri ${location.origin};form-action 'none'`;doc.head.append(policy);
        // Native GIF stores deliberately strip https: from thumbnail/video URLs.
        // A main-created blank document needs an explicit trusted HTTPS base.
        const base=doc.createElement('base');base.href=location.origin+'/';doc.head.append(base);
        doc.documentElement.className=document.documentElement.className;doc.documentElement.lang=document.documentElement.lang;doc.documentElement.dir=document.documentElement.dir;doc.body.className=document.body.className;
        await copyNativePickerStyles(document,doc,styles.signal);
        if(styles.signal.aborted||!valid(m)||!access(p.id)||popup.closed||pickerPopup!==popup){if(!popup.closed)popup.close();return;}
        const workspace=doc.createElement('div');workspace.dataset.nativePickerWindow='true';workspace.style.cssText='position:fixed;inset:0';doc.body.style.cssText='margin:0;overflow:hidden';doc.body.append(workspace);
        const source=getComputedStyle(document.querySelector('#app-mount')??document.body);workspace.style.fontFamily=source.fontFamily;workspace.style.color=source.color;
        for(let index=0;index<source.length;index++){const key=source[index];if(key.startsWith('--'))workspace.style.setProperty(key,source.getPropertyValue(key));}
        const syncTheme=()=>{if(!popup||popup.closed)return;doc.documentElement.className=document.documentElement.className;doc.body.className=document.body.className;for(let index=0;index<source.length;index++){const key=source[index];if(key.startsWith('--'))workspace.style.setProperty(key,source.getPropertyValue(key));}};
        themeObserver=new MutationObserver(syncTheme);for(const element of [document.documentElement,document.body])themeObserver.observe(element,{attributes:true,attributeFilter:['class','style']});
        const anchor=doc.createElement('span');anchor.setAttribute('aria-hidden','true');Object.assign(anchor.style,{position:'fixed',right:'0',bottom:'0',width:'1px',height:'1px',pointerEvents:'none'});workspace.append(anchor);
        pickerChannel=p.id;
        const closed=()=>{themeObserver?.disconnect();anchor.remove();m.pickerReady=undefined;m.pickerSize=undefined;if(pickerPopup===popup)pickerPopup=null;if(popup&&!popup.closed)popup.close();if(pickerChannel!==p.id)return;pickerChannel=undefined;if(valid(m))void ctx.popoutChats.open(session,p.id).catch(()=>undefined);};
        picker.open(workspace,p.id,event.picker,item=>{
          if(!valid(m)||p.sending)return;
          if(typeof item==='string'){p.draft=(p.draft+item).slice(0,4000);m.draftVersion++;saved[p.id]={...saved[p.id],draft:p.draft,reopen:true,updated:Date.now()};save();}else p.stickers=[item];paint(m);
        },anchor,reason=>{m.error=reason;paint(m);},closed,size=>{if(popup&&!popup.closed&&pickerChannel===p.id){m.pickerReady=event.frameName;m.pickerSize=size;paint(m);}});
      }catch(error){themeObserver?.disconnect();if(popup&&!popup.closed)popup.close();if(styles.signal.aborted||pickerPopup!==popup)return;ctx.log.warn('Native media picker could not open',error);pickerChannel=undefined;m.error=localizeError(mediaError(error));paint(m);}
      return;
    }
    const a=event.action;
    if(a.kind==='ready'){m.lastState='';paint(m);return;}
    if(a.kind==='draft'){if(!p.sending){p.draft=a.text;saved[p.id]={...saved[p.id],draft:p.draft,reopen:true,updated:Date.now()};save();}return;}
    if(a.kind==='cancel-reply'){p.reply=undefined;paint(m);return;}
    if(a.kind==='clear-files'){if(!p.sending){releaseFiles(p);p.stickers=[];m.error='';paint(m);}return;}
    if(!access(p.id)){paint(m);return;}
    if(a.kind==='reply'){const msg=getMessage(p.id,a.messageId);if(msg)p.reply={messageId:msg.id,authorName:userDisplayName(msg.author),preview:(msg.content??'').slice(0,96)};paint(m);return;}
    if(a.kind==='latest'){m.endId=undefined;paint(m);return;}
    if(a.kind==='older'){
      if(m.loading)return;
      const list=getMessages(p.id),end=m.endId?list.findIndex(x=>x.id===m.endId)+1:list.length;
      const start=Math.max(0,(end||list.length)-250),oldest=list[start];if(!oldest)return;
      // Cached pages need no network request. At the true beginning stop paging.
      if(start===0&&!hasMoreBefore(p.id)){paint(m);return;}
      m.loading=true;m.error='';paint(m);
      try{
        if(start===0)await fetchOlderMessages(p.id,oldest.id);
        if(!valid(m))return;
        const all=getMessages(p.id),index=all.findIndex(x=>x.id===oldest.id);
        if(index>=0){const nextStart=Math.max(0,index-50);m.endId=all[Math.min(all.length-1,nextStart+249)]?.id;}
      }catch(error){m.error=localizeError(mediaError(error));}finally{m.loading=false;paint(m);}return;
    }
    if(a.kind==='file'){
      if(p.sending)return;
      if(p.files.reduce((n,x)=>n+x.file.size,0)+a.file.bytes.byteLength>50*1024*1024){m.error=t('popout.file_limit');paint(m);return;}
      try{addFiles(p,[new File([a.file.bytes],a.file.name,{type:a.file.type})]);m.error='';}catch{m.error=t('popout.file_limit');}paint(m);return;
    }
    if(a.kind==='send'){
      if(p.sending)return;m.lastState='';p.draft=a.text;if(!p.draft.trim()&&!p.files.length&&!p.stickers.length){paint(m);return;}
      p.sending=true;m.error='';paint(m);
      try{
        const denied=channelSendError(p.id);if(denied)throw Error(denied);
        const emojis=validateCustomEmojis(p.id,p.draft);m.uploads=createUploads(p.files.map(x=>x.file),p.id,()=>{});
        if(!valid(m))return;
        await sendCanvasMessage(p.id,p.draft,p.reply,{uploads:m.uploads,stickerIds:p.stickers.map(x=>x.id),emojis,
          valid:()=>valid(m),onRemaining:(remaining,sent)=>{
            if(!valid(m))return;p.draft=remaining;m.draftVersion++;
            if(sent===1){p.reply=undefined;p.stickers=[];releaseFiles(p);}
            saved[p.id]={...saved[p.id],draft:remaining,reopen:true,updated:Date.now()};save();paint(m);
          }});
        if(!valid(m))return;p.draft='';p.reply=undefined;p.stickers=[];releaseFiles(p);m.endId=undefined;m.draftVersion++;
      }catch(error){if(valid(m))m.error=localizeError(mediaError(error));}
      finally{m.uploads=[];p.sending=false;if(valid(m)){saved[p.id]={...saved[p.id],draft:p.draft,reopen:true,updated:Date.now()};persist();paint(m);}}
    }
  };
  ctx.disposable(ctx.popoutChats.subscribe(event=>{void handle(event).catch(error=>ctx.log.warn('Chat action failed',error));}));
  ctx.disposable(registerPopoutOpener(id=>{void open(id);}));
  const users=window.Syncord?.common?.stores.UserStore as {addChangeListener?:(listener:()=>void)=>void;removeChangeListener?:(listener:()=>void)=>void}|undefined;
  const accountChanged=():void=>{if(currentUserId()!==account)void connect().catch(error=>ctx.log.warn('Chat session unavailable',error));};
  if(users?.addChangeListener&&users.removeChangeListener){users.addChangeListener(accountChanged);ctx.disposable(()=>users.removeChangeListener?.(accountChanged));}
  ctx.disposable(subscribeMessageStore(schedule));ctx.disposable(onLocaleChange(schedule));
  const theme=new MutationObserver(schedule);theme.observe(document.documentElement,{attributes:true,attributeFilter:['class']});theme.observe(document.body,{attributes:true,attributeFilter:['class']});ctx.disposable(()=>theme.disconnect());
  const timer=window.setInterval(()=>{if(currentUserId()!==account)void connect().catch(error=>ctx.log.warn('Chat session unavailable',error));else schedule();},1500);ctx.disposable(()=>window.clearInterval(timer));
  const rowId='syncord-popout-menu',restoreId='syncord-popout-restore';
  const restore=async():Promise<void>=>{await connect();for(const [id] of Object.entries(saved).filter(([id])=>!models.has(id)).sort(([,a],[,b])=>b.updated-a.updated).slice(0,Math.max(0,8-models.size)))await open(id);};
  const menuAction=(menu:Element,id:string,key:string,action:()=>void):void=>{
    appendNativeMenuAction(menu,id,t(key),action,id===rowId?'popout':undefined);const row=menu.querySelector('[id="'+id+'"]');if(!row)return;
    setLocalizedAttribute(row,'aria-label',key);
    const label=[...row.querySelectorAll('*')].find(el=>!el.children.length&&el.textContent?.trim()===t(key));if(label)setLocalizedText(label,key);
  };
  ctx.disposable(watchNativeMenus({log:ctx.log,reset:()=>{document.getElementById(rowId)?.remove();document.getElementById(restoreId)?.remove();},menu:(menu,target)=>{
    const context=inspectMenuContext(menu);
    if(context?.userId&&context.userId===currentUserId()){menu.querySelector('[id="'+rowId+'"]')?.remove();menu.querySelector('[id="'+restoreId+'"]')?.remove();return;}
    let id=context?.channelId;
    if(!id&&target instanceof Element){const link=target.closest('a[href*="/channels/"]');id=link?.getAttribute('href')?.match(/\/channels\/(?:@me|\d+)\/(\d+)/)?.[1];}
    if(id&&access(id)){menuAction(menu,rowId,'popout.open',()=>{void open(id);});if(Object.keys(saved).length)menuAction(menu,restoreId,'popout.restore',()=>{void restore();});}
  }}));
  void connect().catch(error=>ctx.log.warn('Chat session unavailable',error));
  ctx.disposable(()=>{active=false;window.clearTimeout(saveTimer);window.clearTimeout(refreshTimer);persist();picker.close();for(const m of models.values())cancel(m);models.clear();if(session)void ctx.popoutChats.stop(session).catch(()=>undefined);});
}
