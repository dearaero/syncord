import {BodyMutationObserver} from "../../ui/bodyObserver";
import { localizeError, setLocalizedAttribute, t as i18nText } from "../../i18n";
import {definePlugin} from '../../api/plugin';
import {bindTooltip} from '../../ui/tooltip';
import {showToast,ToastType} from '../../ui/toast';
import {GlobalSearch} from './engine';
import {accountId,assertAccount,availableGuilds,currentGuild,discordPort,jumpToHit,watchAccount} from './discord';
import {openSearch} from './ui';
import {CSS,BUTTON_ID} from './styles';
const PLUGIN_ID='global-message-search',SELECTION=`plugins.${PLUGIN_ID}.data.selection`;
export const GlobalMessageSearchPlugin=definePlugin({
 id:PLUGIN_ID,name:i18nText("ui.global_message_search"),author:i18nText("ui.syncord"),enabledByDefault:true,
 get description() { return i18nText("ui.search_selected_servers_in_one_place_filter_by_sender_and_date_and_jum"); },
 permissions:{media:true,userData:true,discordStores:['user','guild','channel','UserStore','GuildStore','ChannelStore','SelectedGuildStore'],discordActions:['message-search','message-jump','channel-navigation']},
 start(ctx){
  ctx.css.inject(CSS);let stopped=false,frame=0,generation=0,wrapper:HTMLElement|undefined,tooltip:(()=>void)|undefined,runner:GlobalSearch|undefined,owner:string|undefined,view:ReturnType<typeof openSearch>|undefined;
  const paint=():void=>{document.getElementById(BUTTON_ID)?.setAttribute('aria-pressed',String(!!view));};
  const reset=():void=>{generation++;view?.close();view=undefined;runner?.stop();runner=undefined;owner=undefined;paint();};
  const open=():void=>{
   if(stopped)return;if(view){view.close();return;}
   try{
    const id=accountId();if(!id)throw Error("Discord’s account is not ready. Try again after it loads.");if(owner!==id)reset();
    const guilds=availableGuilds(),current=currentGuild();
    if(!runner){const port=discordPort(id),token=++generation;owner=id;runner=new GlobalSearch(port,state=>{if(stopped||token!==generation)return;if(accountId()!==id){reset();return;}view?.render(state);});}
    const raw=ctx.settings.get<unknown>(SELECTION),saved=raw!==null&&typeof raw==='object'?raw as {accountId?:unknown;ids?:unknown}:undefined;
    const ids=saved?.accountId===id&&Array.isArray(saved.ids)?saved.ids.filter((v):v is string=>typeof v==='string'&&guilds.some(g=>g.id===v)):guilds.some(g=>g.id===current)&&current?[current]:[];
    view=openSearch({account:id,guilds,selected:ids,current,runner,remember:ids=>{if(!stopped&&accountId()===id)ctx.settings.set(SELECTION,{accountId:id,ids:ids.slice(0,1000)});},jump:hit=>{assertAccount(id);return jumpToHit(hit,id);},closed:()=>{view=undefined;paint();}});paint();
   }catch(e){showToast(e instanceof Error?localizeError(e):i18nText("ui.global_message_search_could_not_open"),{type:ToastType.FAILURE});}
  };
  const mount=():void=>{
   if(stopped||document.getElementById(BUTTON_ID))return;
   const anchor=document.getElementById('Syncord-dm-closer-toolbar-btn')??document.getElementById('Syncord-message-cleaner-toolbar-btn')??document.getElementById('Syncord-recording-toolbar-btn')??document.getElementById('Syncord-multichat-toolbar-btn');
   const inbox=document.querySelector<HTMLElement>('[aria-label="Inbox"],[aria-label="Gelen Kutusu"]'),slot=anchor?.parentElement??inbox?.closest<HTMLElement>('[class*="iconWrapper"]')??inbox?.parentElement;
   if(!slot?.parentElement)return;
   tooltip?.();wrapper?.remove();wrapper=document.createElement('div');wrapper.className=slot.className;
   const button=document.createElement('button');button.type='button';button.id=BUTTON_ID;setLocalizedAttribute(button, 'aria-label', "ui.global_message_search");button.setAttribute('aria-haspopup','dialog');button.innerHTML='<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10 2a8 8 0 1 0 4.9 14.3l5.4 5.4 1.4-1.4-5.4-5.4A8 8 0 0 0 10 2Zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12Z"/></svg>';
   button.addEventListener('click',open);wrapper.append(button);if(anchor)slot.after(wrapper);else slot.before(wrapper);tooltip=bindTooltip(button,() => i18nText("ui.global_message_search"),{position:'bottom'});paint();
  };
  const observer=new BodyMutationObserver(()=>{if(stopped||frame||document.getElementById(BUTTON_ID))return;frame=requestAnimationFrame(()=>{frame=0;mount();});});observer.observe(document.body,{childList:true,subtree:true});mount();
  const unwatch=watchAccount(()=>{if(owner&&accountId()!==owner)reset();});
  ctx.disposable(()=>{stopped=true;reset();unwatch();observer.disconnect();if(frame)cancelAnimationFrame(frame);tooltip?.();wrapper?.remove();});
 },
});
