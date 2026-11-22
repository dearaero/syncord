import {t} from '../../i18n';
import type {Job} from './queue';
import {currentUserId} from '../multiChatCanvas/discord';
import {showToast,ToastType} from '../../ui/toast';
export const CSS=`#Syncord-long-messages{position:fixed;right:16px;bottom:76px;z-index:1001;width:min(330px,calc(100vw - 32px));display:grid;gap:8px;pointer-events:none;font:inherit}#Syncord-long-messages section{pointer-events:auto;background:var(--background-floating,#202024);color:var(--text-normal,#eee);padding:12px;border:1px solid var(--background-modifier-accent,#555);border-radius:12px;box-shadow:0 4px 16px #0003;font-size:13px;overflow-wrap:anywhere}#Syncord-long-messages p{margin:6px 0;color:var(--text-muted,#aaa)}#Syncord-long-messages progress{width:100%;height:4px;accent-color:var(--brand-500,#5865f2)}#Syncord-long-messages footer{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}#Syncord-long-messages button{font:inherit;border:0;border-radius:6px;padding:6px 9px;color:inherit;background:var(--background-modifier-hover,#444);cursor:pointer}#Syncord-long-messages button:focus-visible{outline:2px solid var(--focus-primary,#949aff);outline-offset:2px}`;
export function transferUi(){
  let stopped=false;const nodes=new Map<Job,HTMLElement>(),timers=new Set<ReturnType<typeof setTimeout>>();
  const root=document.createElement('aside');root.id='Syncord-long-messages';
  const update=(job:Job):void=>{
    if(stopped)return;
    if(job.request.accountId!==currentUserId()){nodes.get(job)?.remove();nodes.delete(job);return;}
    if(!root.isConnected)document.body.append(root);
    let node=nodes.get(job);if(!node){node=document.createElement('section');root.append(node);nodes.set(job,node);}
    const status=document.createElement('div');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    const title=document.createElement('strong');title.textContent=t('long.progress',{sent:job.sent,total:job.parts.length});
    const text=document.createElement('p');text.textContent=t('long.'+job.status);
    const progress=document.createElement('progress');progress.max=job.parts.length;progress.value=job.sent;progress.setAttribute('aria-label',title.textContent);
    status.append(title,text,progress);const footer=document.createElement('footer');
    const button=(key:string,action:()=>void)=>{const b=document.createElement('button');b.type='button';b.dataset.longAction=key;b.textContent=t(key);b.onclick=action;footer.append(b);};
    if(job.status==='confirm')button('long.send',job.confirm);
    if(['confirm','sending','cancelling'].includes(job.status))button('long.cancel',job.cancel);
    else if(job.status!=='done'){
      button('long.copy',()=>{void navigator.clipboard.writeText(job.remaining).catch(()=>showToast(t('long.unavailable'),{type:ToastType.FAILURE}));});
      if(job.request.restore)button('long.restore',()=>{if(!job.request.restore?.(job.remaining))showToast(t('long.kept'),{type:ToastType.FAILURE});});
      // Retain source until the user explicitly acknowledges the result.
      button('long.close',()=>{job.parts=[];job.remaining='';nodes.get(job)?.remove();nodes.delete(job);dismiss?.(job);});
    }
    const focus=node.contains(document.activeElement)?(document.activeElement as HTMLElement).dataset.longAction:undefined;
    node.replaceChildren(status,footer);
    if(focus)node.querySelector<HTMLButtonElement>(`[data-long-action="${focus}"]`)?.focus({preventScroll:true});
    if(job.status==='done'){const timer=setTimeout(()=>{nodes.get(job)?.remove();nodes.delete(job);timers.delete(timer);},2000);timers.add(timer);}
  };
  let dismiss:((job:Job)=>void)|undefined;
  return {update,accountChanged(){for(const [job,node]of nodes)if(job.request.accountId!==currentUserId()){node.remove();nodes.delete(job);}},onDismiss(fn:(job:Job)=>void){dismiss=fn;},dispose(){stopped=true;for(const timer of timers)clearTimeout(timer);timers.clear();nodes.clear();root.remove();}};
}
