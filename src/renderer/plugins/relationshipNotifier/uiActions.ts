import { t as i18nText } from "../../i18n";
import {quickAction,assertAccount,relationshipType,accountId} from './discord';
import {validId,type Entry} from './types';
export function actionButtons(row:Entry,account:string,status:(text:string)=>void,navigate?:()=>void):HTMLDivElement {
 const group=document.createElement('div');group.className='rn-actions';
 if(!validId(row.user?.id)||row.user.id===account||row.accountId!==account)return group;
 const feedback=(text:string):void=>{if(accountId()!==account)return;if(group.isConnected)status(text);else if(text)window.Syncord?.toast?.show(text,{type:'failure'});};
 for(const [action,label]of [['profile',i18nText("ui.profile")],['dm',i18nText("ui.open_dm")],['request',i18nText("ui.send_friend_request")]] as const){
  const button=document.createElement('button');button.type='button';button.textContent=label;button.dataset.rnAction=action;button.dataset.rnUser=row.user.id;
  if(action==='request')button.disabled=relationshipType(row.user.id)!==0;
  button.addEventListener('click',()=>{
   try{assertAccount(account);}catch(error){status(error instanceof Error?error.message:i18nText("ui.account_changed"));return;}
   button.disabled=true;button.dataset.rnBusy='true';let sent=false;
   void quickAction(action,row,account,navigate,()=>group.isConnected).then(()=>{assertAccount(account);sent=action==='request';feedback(sent?i18nText("ui.friend_request_sent"):'');},error=>{feedback(error instanceof Error?error.message:i18nText("ui.discord_action_failed"));})
    .catch(()=>{}).finally(()=>{delete button.dataset.rnBusy;button.disabled=action==='request'?(sent||relationshipType(row.user!.id)!==0):false;});
  });group.append(button);
 }
 return group;
}
/** Refresh all visible request controls after the shared monitor processes a change. */
export function refreshActionButtons(root:ParentNode,account:string):void {
 if(accountId()!==account)return;
 for(const button of root.querySelectorAll<HTMLButtonElement>('[data-rn-action="request"]')){
  const id=button.dataset.rnUser;
  button.disabled=button.dataset.rnBusy==='true'||!validId(id)||id===account||relationshipType(id)!==0;
 }
}
