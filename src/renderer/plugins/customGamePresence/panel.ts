import {searchGames} from './search';
import {h,t,messageHtml,onLocaleChange,getLocale} from '../../i18n';
import {bindTooltip} from '../../ui/tooltip';
import {currentUserId} from '../multiChatCanvas/discord';
import {watchAccount} from '../globalMessageSearch/discord';
import {GAME_CHANGE,config,saveConfig,seconds,type Config} from './settings';
import {cachedGames,loadGames,resolveGame,iconUrl} from './discord';
import {gameState,onGameState} from './state';
import type {Game} from '../../api/gameSimulation';
let expanded=false;
export const isGameExpanded=():boolean=>expanded;
export const gameExpandHtml=():string=>`<button type="button" class="dion-icon-btn dion-expand" data-game-expand aria-expanded="${expanded}" aria-label="${h('game.name')}" data-si18n-aria-label="game.name">⌄</button>`;
export const gameSectionHtml=():string=>`<section class="dion-plugin-details" data-game-panel>
 <div class="dion-search"><input type="search" maxlength="160" data-game-search aria-label="${h('game.search')}" placeholder="${h('game.search')}" data-si18n-aria-label="game.search" data-si18n-placeholder="game.search"></div>
 <p class="dion-setting-desc">${messageHtml('game.catalog_notice')}</p><div class="dion-game-results" data-game-results></div>
 <details data-game-manual-section><summary>${messageHtml('game.manual_add')}</summary><div class="dion-game-manual"><label>${messageHtml('game.manual_name')}<input type="text" maxlength="128" data-game-name aria-label="${h('game.manual_name')}" data-si18n-aria-label="game.manual_name"></label><label>${messageHtml('game.application_id')}<input type="text" inputmode="numeric" maxlength="20" data-game-id aria-label="${h('game.application_id')}" data-si18n-aria-label="game.application_id"></label><button type="button" class="dion-primary-btn" data-game-manual>${messageHtml('game.select')}</button></div></details>
 <label class="dion-setting-row"><span class="dion-setting-copy"><span class="dion-setting-title">${messageHtml('game.time')}</span></span><span class="dion-game-time"><input type="number" min="0" step="1" data-game-time aria-label="${h('game.time')}" data-si18n-aria-label="game.time"><span class="dion-select-wrap"><select class="dion-select" data-game-unit aria-label="${h('game.unit')}" data-si18n-aria-label="game.unit">${(['seconds','minutes','hours'] as const).map(unit=>`<option value="${unit}">${messageHtml('game.'+unit)}</option>`).join('')}</select></span></span></label>
 <label class="dion-setting-row"><span class="dion-setting-copy"><span class="dion-setting-title">${messageHtml('game.real_priority')}</span></span><span class="dion-switch"><input type="checkbox" role="switch" data-game-priority aria-label="${h('game.real_priority')}" data-si18n-aria-label="game.real_priority"><span class="dion-track" aria-hidden="true"></span></span></label>
 <div class="dion-game-preview"><small>${messageHtml('game.preview')}</small><strong data-game-selected></strong><span data-game-elapsed></span></div>
 <p role="status" class="dion-setting-desc" data-game-status></p><p role="alert" class="dion-setting-desc" data-game-error hidden></p><p class="dion-setting-desc">${messageHtml('game.visibility')}</p></section>`;
export const GAME_CSS=`
 [data-game-panel] .dion-game-results{display:grid;grid-template-columns:minmax(0,1fr);gap:6px;max-height:270px;overflow:auto;margin:12px 0;padding:2px;min-width:0}
 [data-game-panel] .dion-game-result{display:grid;grid-template-columns:minmax(0,1fr) 32px;align-items:center;gap:10px;min-width:0}
 [data-game-panel] .dion-game-select,[data-game-panel] .dion-game-favorite{box-sizing:border-box;display:flex;align-items:center;justify-content:center;border:1px solid var(--dion-border,var(--border-subtle,#ffffff20));border-radius:9px;background:var(--background-secondary,#18191c);color:var(--dion-text,inherit);cursor:pointer;font:inherit;transition:background-color 120ms ease,border-color 120ms ease}
 [data-game-panel] .dion-game-select{justify-content:flex-start;gap:12px;width:100%;min-width:0;min-height:48px;height:auto;padding:8px 12px;text-align:start}
 [data-game-panel] .dion-game-icon{display:grid;place-items:center;position:relative;width:32px;height:32px;flex:0 0 32px;border-radius:8px;overflow:hidden;background:var(--background-tertiary,#ffffff0a);color:var(--dion-muted,#949ba4)}
 [data-game-panel] .dion-game-icon img{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:cover}
 [data-game-panel] .dion-game-icon svg{width:20px;height:20px}
 [data-game-panel] .dion-game-select strong{display:block;flex:1;min-width:0;font-size:14px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 [data-game-panel] .dion-game-favorite{width:32px;height:32px;padding:0;font-size:20px;line-height:1;color:var(--dion-muted,#949ba4)}
 [data-game-panel] .dion-game-select:hover,[data-game-panel] .dion-game-favorite:hover{background:var(--background-modifier-hover,#ffffff0a);border-color:var(--dion-border-strong,#ffffff40)}
 [data-game-panel] .dion-game-result [aria-pressed=true]{border-color:var(--brand-500,#5865f2)}
 [data-game-panel] .dion-game-result button:focus-visible{outline:2px solid var(--brand-500,#5865f2);outline-offset:1px}
 [data-game-panel] .dion-game-result button:disabled{cursor:default;opacity:.5}
 @media(prefers-reduced-motion:reduce){[data-game-panel] .dion-game-result button{transition:none}}
 [data-game-panel] details{margin:12px 0}[data-game-panel] .dion-game-manual{padding-top:12px}
 .dion-game-manual{display:flex;gap:10px;align-items:end;flex-wrap:wrap}.dion-game-manual label{flex:1;min-width:140px;display:grid;gap:6px}.dion-game-manual input,.dion-game-time input{box-sizing:border-box;min-width:0;width:100%;border:1px solid var(--border-subtle,#ffffff20);border-radius:8px;background:var(--background-secondary,#18191c);color:inherit;padding:10px;font:inherit}.dion-game-time{display:flex;gap:8px;max-width:280px}.dion-game-time input{width:100px}.dion-game-time .dion-select-wrap{width:150px;min-width:120px;flex:0 0 150px}.dion-game-preview{display:grid;gap:6px;margin-top:16px;padding:14px;border:1px solid var(--border-subtle,#ffffff20);border-radius:10px;background:var(--background-secondary,#18191c)}.dion-game-preview strong{overflow-wrap:anywhere}.dion-game-preview span{font-variant-numeric:tabular-nums}
 @media(max-width:650px){.dion-game-time{max-width:100%}.dion-game-manual button{width:100%}}
`;
export function bindGamePanel(root:HTMLElement):()=>void{
 const host=root.querySelector<HTMLElement>('[data-game-panel]');if(!host)return()=>{};
 const q=<T extends HTMLElement=HTMLElement>(s:string):T=>host.querySelector<T>(s)!;
 let closed=false,busy=false,error='',timer:ReturnType<typeof setInterval>|undefined,debounce:ReturnType<typeof setTimeout>|undefined,operation:AbortController|undefined;
 let searchQuery='',catalogStatus='',catalogRequest:AbortController|undefined;
 let games=cachedGames();const tips:Array<()=>void>=[];
 const clearTips=():void=>{for(const off of tips.splice(0))off();};
 const active=():boolean=>!closed&&expanded;
 const elapsed=():void=>{if(!active())return;const state=gameState(),cfg=config(currentUserId()??'');const total=state.start&&state.game?.id===cfg.selected?.id&&state.running?Math.max(0,Math.floor((Date.now()-state.start)/1000)):cfg.initialSeconds;const value=[Math.floor(total/3600),Math.floor(total/60)%60,total%60].map(n=>new Intl.NumberFormat(getLocale(),{minimumIntegerDigits:2,useGrouping:false}).format(n)).join(':');q('[data-game-elapsed]').textContent=t('game.elapsed',{time:value});};
 const values=():void=>{const cfg=config(currentUserId()??'');q<HTMLInputElement>('[data-game-time]').value=String(cfg.initialSeconds/({seconds:1,minutes:60,hours:3600}[cfg.timeUnit]));q<HTMLSelectElement>('[data-game-unit]').value=cfg.timeUnit;q<HTMLInputElement>('[data-game-priority]').checked=cfg.realPriority;};
 const paint=():void=>{
  if(closed)return;const account=currentUserId(),cfg=config(account??''),state=gameState();
  q('[data-game-status]').textContent=t(state.status);q('[data-game-error]').hidden=!error;q('[data-game-error]').textContent=error?t(error):'';
  q('[data-game-selected]').textContent=cfg.selected?t('game.playing_line',{name:state.game?.id===cfg.selected.id?state.game.name:cfg.selected.name}):t('game.ready');
  q<HTMLButtonElement>('[data-game-manual]').disabled=busy||!account;
  const results=q('[data-game-results]');clearTips();results.replaceChildren();
  if(!active()){if(timer!==undefined){clearInterval(timer);timer=undefined;}return;}
  if(timer===undefined)timer=setInterval(elapsed,1000);
  const query=searchQuery;
  const list=searchGames([...cfg.favorites,...cfg.recent,...(query?games:[])],query);
  let group='';for(const game of list){
   const nextGroup=cfg.favorites.some(g=>g.id===game.id)?'favorites':cfg.recent.some(g=>g.id===game.id)?'recent':'catalog';if(!query&&nextGroup!==group){const title=document.createElement('small');title.textContent=t('game.'+nextGroup);results.append(title);group=nextGroup;}
   const row=document.createElement('div');row.className='dion-game-result';const select=document.createElement('button');select.type='button';select.className='dion-game-select';select.dataset.gameSelect=game.id;select.setAttribute('aria-pressed',String(cfg.selected?.id===game.id));select.disabled=busy||!account;
   const icon=document.createElement('span');icon.className='dion-game-icon';icon.setAttribute('aria-hidden','true');icon.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7 6h10c2 0 3 2 3.5 4l1 6c.4 2-1.8 3-3 1.5L16 15H8l-2.5 2.5C4.3 19 2.1 18 2.5 16l1-6C4 8 5 6 7 6Z"/><path d="M6 10h6m-3-3v6m7-3h.01m2 2h.01"/></svg>';select.append(icon);
   const url=iconUrl(game);if(url){const img=document.createElement('img');img.src=url;img.alt='';img.loading='lazy';img.addEventListener('error',()=>img.remove(),{once:true});icon.append(img);}
   const label=document.createElement('strong');label.textContent=game.name;select.append(label);const favorite=document.createElement('button');favorite.type='button';favorite.className='dion-game-favorite';favorite.dataset.gameFavorite=game.id;const isFavorite=cfg.favorites.some(g=>g.id===game.id);favorite.textContent=isFavorite?'★':'☆';favorite.setAttribute('aria-pressed',String(isFavorite));favorite.setAttribute('aria-label',t('game.favorite'));favorite.disabled=!account;tips.push(bindTooltip(favorite,()=>t('game.favorite')));row.append(select,favorite);results.append(row);
  }
  if(catalogStatus){const notice=document.createElement('small');notice.setAttribute('role','status');notice.textContent=t(catalogStatus);results.append(notice);}
  if(!list.length&&!catalogStatus){results.textContent=t(query?'game.empty':'game.search_prompt');}elapsed();
 };
 const loadCatalog=():void=>{
  if(!active()||catalogRequest)return;
  const request=new AbortController();catalogRequest=request;catalogStatus='game.catalog_loading';paint();
  void loadGames(request.signal).then(list=>{
   if(closed||request.signal.aborted)return;games=[...new Map([...list,...cachedGames()].map(game=>[game.id,game])).values()];catalogStatus='';
  },()=>{if(!closed&&!request.signal.aborted)catalogStatus='game.catalog_failed';}).finally(()=>{if(catalogRequest===request)catalogRequest=undefined;if(!closed&&!request.signal.aborted)paint();});
 };
 const choose=async(id:string):Promise<void>=>{
  const account=currentUserId();if(!account||busy)return;busy=true;error='';operation?.abort();const request=new AbortController();operation=request;paint();
  try{const game=await resolveGame(id,request.signal);if(closed||!active()||account!==currentUserId()||request.signal.aborted)return;const cfg=config(account);saveConfig(account,{selected:game,recent:[game,...cfg.recent.filter(g=>g.id!==game.id)].slice(0,12)});}catch(e){if(!closed&&!request.signal.aborted)error=e instanceof Error&&e.message.startsWith('game.')?e.message:'game.lookup_failed';}finally{if(operation===request){busy=false;operation=undefined;}paint();}
 };
 const click=(event:Event):void=>{
  const el=event.target instanceof Element?event.target.closest<HTMLElement>('button'):null;if(!el)return;
  if(el.hasAttribute('data-game-expand')){expanded=!expanded;el.setAttribute('aria-expanded',String(expanded));el.closest('.dion-plugin')?.classList.toggle('is-open',expanded);if(!expanded){operation?.abort();catalogRequest?.abort();catalogRequest=undefined;}else loadCatalog();paint();return;}
  if(!host.contains(el)||!active())return;
  if(el.dataset.gameSelect){void choose(el.dataset.gameSelect);return;}
  const account=currentUserId();if(!account)return;
  if(el.dataset.gameFavorite){const cfg=config(account),game=[...games,...cfg.recent,...cfg.favorites].find(g=>g.id===el.dataset.gameFavorite);if(game)saveConfig(account,{favorites:cfg.favorites.some(g=>g.id===game.id)?cfg.favorites.filter(g=>g.id!==game.id):[game,...cfg.favorites].slice(0,24)});}
  if(el.hasAttribute('data-game-manual')){const name=q<HTMLInputElement>('[data-game-name]').value.trim(),id=q<HTMLInputElement>('[data-game-id]').value.trim()||games.find(g=>g.name.toLocaleLowerCase()===name.toLocaleLowerCase())?.id;void choose(id??'');}
 };
 const change=(event:Event):void=>{const target=event.target;if(!(target instanceof HTMLElement)||!host.contains(target))return;const account=currentUserId();if(!account)return;try{error='';if(target.hasAttribute('data-game-priority'))saveConfig(account,{realPriority:(target as HTMLInputElement).checked});else if(target.hasAttribute('data-game-time')||target.hasAttribute('data-game-unit')){const unit=q<HTMLSelectElement>('[data-game-unit]').value as Config['timeUnit'];saveConfig(account,{initialSeconds:seconds(q<HTMLInputElement>('[data-game-time]').valueAsNumber,unit),timeUnit:unit});}}catch{error='game.invalid_time';paint();}};
 const input=():void=>{if(debounce!==undefined)clearTimeout(debounce);debounce=setTimeout(()=>{debounce=undefined;searchQuery=q<HTMLInputElement>('[data-game-search]').value.trim().slice(0,160);paint();},150);};
 const refresh=():void=>{values();paint();};const accountChange=():void=>{operation?.abort();error='';q<HTMLInputElement>('[data-game-id]').value='';q<HTMLInputElement>('[data-game-name]').value='';refresh();};
 root.addEventListener('click',click);host.addEventListener('change',change);q('[data-game-search]').addEventListener('input',input);window.addEventListener(GAME_CHANGE,refresh);
 const off=onGameState(paint),localeOff=onLocaleChange(paint),accountOff=watchAccount(accountChange);values();paint();if(active())loadCatalog();
 return()=>{closed=true;operation?.abort();catalogRequest?.abort();clearTips();if(timer!==undefined)clearInterval(timer);if(debounce!==undefined)clearTimeout(debounce);off();localeOff();accountOff();window.removeEventListener(GAME_CHANGE,refresh);root.removeEventListener('click',click);host.removeEventListener('change',change);q('[data-game-search]').removeEventListener('input',input);};
}
