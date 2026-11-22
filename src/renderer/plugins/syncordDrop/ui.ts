import type {PluginContext} from '../../api/plugin';
import {h,t,messageHtml,setLocalizedHtml,setLocalizedText,onLocaleChange,getLocale} from '../../i18n';
import {currentUserId} from '../multiChatCanvas/discord';
import {abortableSleep} from '../messageCleaner/engine';
import {openSettings} from '../../ui/settingsPanel';
import {type DropInvite,type DropFile} from '../../../shared/drop';
import {transfer,type DropProgress} from './peer';
import {dm} from './discord';
export const DROP_CSS=`
.Syncord-drop{position:fixed;inset:64px 12px auto auto;margin:0;z-index:99999;box-sizing:border-box;width:min(480px,calc(100vw - 24px));max-height:calc(100dvh - 80px);overflow:auto;border:1px solid var(--border-subtle,#ffffff18);border-radius:16px;background:var(--background-base-low,var(--background-primary,#202127));color:var(--text-normal,#eee);padding:22px;font:14px/1.5 var(--font-primary,system-ui);box-shadow:0 20px 70px #0007}
.Syncord-drop header{display:flex;align-items:center;justify-content:space-between;gap:12px}.Syncord-drop h2{font-size:20px;margin:0}.Syncord-drop p{overflow-wrap:anywhere}.Syncord-drop small{display:block}.Syncord-drop [data-drop-speed]{margin:8px 0 12px;font-variant-numeric:tabular-nums}.Syncord-drop-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.Syncord-drop-incoming footer button{flex:1}.Syncord-drop button{font-weight:600}.Syncord-drop-incoming{border-color:var(--brand-500,#5865f2)}.Syncord-drop-incoming header small{font-size:11px;letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px}.Syncord-drop small,.Syncord-drop dt{color:var(--text-muted,#aaa)}.Syncord-drop dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 14px}.Syncord-drop dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}.Syncord-drop footer{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}.Syncord-drop button{font:inherit;border:0;border-radius:8px;padding:8px 12px;color:inherit;background:var(--background-secondary,#303238);cursor:pointer}.Syncord-drop [data-drop-send],.Syncord-drop [data-drop-accept]{background:var(--brand-500,#5865f2);color:white}.Syncord-drop button:disabled{opacity:.45;cursor:default}.Syncord-drop [hidden]{display:none!important}.Syncord-drop :focus-visible{outline:2px solid var(--focus-primary,#949aff);outline-offset:3px}.Syncord-drop progress{width:100%;height:6px;accent-color:var(--brand-500,#5865f2)}.Syncord-drop label{display:flex;align-items:flex-start;gap:8px;margin:14px 0}.Syncord-drop [role=alert]{color:var(--text-danger,#fa777c)}.Syncord-drop input[type=checkbox]{accent-color:var(--brand-500,#5865f2);margin-top:5px;flex-shrink:0}
`;
export function bytes(n:number):string{const i=Math.max(0,Math.min(4,Math.floor(Math.log2(Math.max(n,1))/10)));return new Intl.NumberFormat(getLocale(),{maximumFractionDigits:1}).format(n/1024**i)+' '+['B','KiB','MiB','GiB','TiB'][i];}
function errorKey(error:unknown):string{const raw=error instanceof Error?error.message:'';const key=/drop\.[a-z_]+/.exec(raw)?.[0];return key&&t(key)!==key?key:'drop.error';}
export function openDrop(ctx:PluginContext,account:string,closed:()=>void,channelId?:string,inviteId?:string,automatic=false):{close:()=>void}{
 const previousFocus=document.activeElement;
 const dialog=document.createElement('dialog');dialog.className='Syncord-drop';if(inviteId)dialog.classList.add('Syncord-drop-incoming');const controller=new AbortController();
 let offNative:(()=>void)|undefined;
 let session='',alive=true,busy=false,started=false,completed=false,file:DropFile|undefined,invite:DropInvite|undefined,recipient='',peerName='',phase='drop.choose',failure='',progress:DropProgress|undefined;
 const stopLocale=onLocaleChange(()=>paint());
 setLocalizedHtml(dialog,`<header><div><small>Syncord Drop</small><h2>${messageHtml(inviteId?'drop.incoming':'drop.send')}</h2></div><button type="button" data-drop-close aria-label="${h('ui.close')}" data-si18n-aria-label="ui.close">×</button></header>
 <dl><dt>${messageHtml('drop.file')}</dt><dd data-drop-file>—</dd><dt>${messageHtml('drop.peer')}</dt><dd data-drop-peer>—</dd><dt>${messageHtml('drop.size')}</dt><dd data-drop-size>—</dd></dl>
 <p role="status" aria-live="polite" data-drop-status></p><progress max="1" value="0" data-drop-progress aria-label="${h('drop.progress')}" data-si18n-aria-label="drop.progress"></progress><small data-drop-speed></small>
 <p role="alert" data-drop-error hidden></p><small>${messageHtml('drop.limits')}</small>
 <label data-drop-consent-row><input type="checkbox" data-drop-consent><span>${messageHtml('drop.privacy')}</span></label>
 <footer><button type="button" data-drop-choose>${messageHtml('drop.choose')}</button><button type="button" data-drop-send>${messageHtml('drop.send_invite')}</button><button type="button" data-drop-accept>${messageHtml('drop.yes')}</button><button type="button" data-drop-decline>${messageHtml('drop.no')}</button><button type="button" data-drop-cancel>${messageHtml('ui.cancel')}</button><button type="button" data-drop-reveal>${messageHtml('drop.reveal')}</button><button type="button" data-drop-settings>${messageHtml('ui.open_settings')}</button></footer>`);
 const q=<T extends HTMLElement=HTMLElement>(selector:string):T=>dialog.querySelector<T>(selector)!;
 const check=():void=>{if(!alive||controller.signal.aborted||currentUserId()!==account)throw Error('drop.cancelled');};
 const active=():boolean=>started&&!completed;
 function paint():void{
  if(!alive)return;q('[data-drop-file]').textContent=file?.name??'—';q('[data-drop-size]').textContent=file?bytes(file.size):'—';q('[data-drop-peer]').textContent=peerName?peerName+' · '+recipient:'—';
  setLocalizedText(q('[data-drop-status]'),phase);q('[data-drop-error]').hidden=!failure;q('[data-drop-error]').textContent=failure?t(failure):'';
  q('[data-drop-status]').classList.toggle('Syncord-drop-sr',phase==='drop.incoming');
  q('[data-drop-cancel]').hidden=!!inviteId&&!started&&!completed;
  q('[data-drop-speed]').hidden=!progress;
  const p=q<HTMLProgressElement>('[data-drop-progress]');p.hidden=!started;p.max=Math.max(1,file?.size??1);p.value=progress?.bytes??0;
  q('[data-drop-speed]').textContent=progress?`${bytes(progress.bytes)} / ${bytes(file?.size??0)} · ${bytes(progress.speed)}/s · ${progress.speed>0?new Intl.NumberFormat(getLocale(),{style:'unit',unit:'second',maximumFractionDigits:0}).format(progress.eta):'—'}`:'';
  q('[data-drop-consent-row]').hidden=started||completed;
  setLocalizedText(q('[data-drop-cancel]'),completed?'ui.close':'ui.cancel');
  for(const key of ['choose','send','accept','decline','reveal','settings']){
   const button=q<HTMLButtonElement>('[data-drop-'+key+']');button.disabled=busy;
   button.hidden=key==='choose'?!!inviteId||!!invite||started:key==='send'?!!inviteId||started:key==='accept'||key==='decline'?!inviteId||started:key==='reveal'?!completed||!inviteId:!failure;
  }
  q<HTMLButtonElement>('[data-drop-send]').disabled=busy||!file||!session||!q<HTMLInputElement>('[data-drop-consent]').checked;
  q<HTMLButtonElement>('[data-drop-accept]').disabled=busy||!invite||!session||!q<HTMLInputElement>('[data-drop-consent]').checked;
  q<HTMLInputElement>('[data-drop-consent]').disabled=busy;
 }
 const attempt=async(fn:()=>Promise<void>):Promise<void>=>{
  if(busy||!alive)return;busy=true;failure='';paint();try{check();await fn();}catch(e){if(alive&&!controller.signal.aborted){failure=errorKey(e);if(!completed)phase='drop.failed';if(started&&!completed){controller.abort();void ctx.drop.stop(session).catch(()=>{});}}}finally{busy=false;paint();}
 };
 function close():void{if(!alive)return;alive=false;controller.abort();stopLocale();offNative?.();if(session)void ctx.drop.stop(session).catch(()=>{});dialog.close();dialog.remove();closed();}
 const launch=async():Promise<void>=>{
  check();if(!invite)throw Error('drop.state');started=true;busy=false;phase='drop.connecting';paint();
  await transfer({bridge:ctx.drop,session,invite,sender:!inviteId,signal:controller.signal,progress:state=>{if(!alive)return;progress=state;phase='drop.'+state.phase;if(state.phase==='complete'){completed=true;failure='';}paint();}});
  check();completed=true;phase='drop.complete';paint();
 };
 const choose=():Promise<void>=>attempt(async()=>{if(active())throw Error('drop.state');const selected=await ctx.drop.pick(session);check();if(selected)file=selected;phase='drop.choose';});
 q('[data-drop-choose]').addEventListener('click',()=>{void choose();});
 q('[data-drop-send]').addEventListener('click',()=>{void attempt(async()=>{
  if(!channelId||!file||!q<HTMLInputElement>('[data-drop-consent]').checked)throw Error('drop.state');
  if(dm(channelId,account).id!==recipient)throw Error('drop.dm_only');
  invite??=await ctx.drop.invite(session,recipient);check();
  // The explicit click sends only an authenticated Drop invitation. No Discord message.
  started=true;phase='drop.waiting';paint();
  while(invite.state==='pending'){await abortableSleep(2000,controller.signal);check();invite=await ctx.drop.view(session,invite.id);check();}
  if(invite.state!=='accepted')throw Error('drop.cancelled');await launch();
 });});
 q('[data-drop-accept]').addEventListener('click',()=>{void attempt(async()=>{
  if(!invite||!q<HTMLInputElement>('[data-drop-consent]').checked)throw Error('drop.state');
  if(!await ctx.drop.save(session,invite.id))return;check();invite=await ctx.drop.action(session,invite.id,'accept');check();await launch();
 });});
 q('[data-drop-decline]').addEventListener('click',()=>{void attempt(async()=>{if(invite)await ctx.drop.action(session,invite.id,'decline');close();});});
 q('[data-drop-reveal]').addEventListener('click',()=>{void attempt(async()=>{await ctx.drop.reveal(session);});});
 q('[data-drop-settings]').addEventListener('click',()=>{close();openSettings('ecosystem');});
 q('[data-drop-consent]').addEventListener('change',paint);
 for(const key of ['close','cancel'])q('[data-drop-'+key+']').addEventListener('click',close);
 dialog.setAttribute('aria-label','Syncord Drop');
 dialog.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}});
 document.body.append(dialog);paint();
 // Transfers must not make the rest of Discord inert while streaming.
 dialog.show();
 if(automatic&&previousFocus instanceof HTMLElement&&previousFocus.isConnected)previousFocus.focus({preventScroll:true});
 void attempt(async()=>{
  if(!inviteId){if(!channelId)throw Error('drop.dm_only');const peer=dm(channelId,account);recipient=peer.id;peerName=peer.name;}
  session=await ctx.drop.connect(account);
  if(alive)offNative=ctx.drop.subscribe(token=>{if(token!==session||!alive||completed)return;controller.abort();if(!failure)failure='drop.disabled';phase='drop.failed';paint();});if(!alive||currentUserId()!==account){await ctx.drop.stop(session);return;}
  if(inviteId){invite=await ctx.drop.view(session,inviteId);check();if(invite.receiver!==account||invite.state!=='pending')throw Error('drop.expired');file=invite;recipient=invite.sender;peerName=invite.senderName;phase='drop.incoming';}
 });
 return{close};
}
