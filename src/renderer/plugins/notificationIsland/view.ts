import {performanceModeEnabled} from '../../core/performance/state';
import {t,getDirection} from '../../i18n';
import {kit,openNativeMenu,ensureReact,scanKit,type MenuViewProps} from '../../discordKit';
import {springStep} from '../spotifyControls/spring';
import {options,setOption,ISLAND_SETTINGS} from './settings';
import type {IslandCore,IslandItem} from './core';
import {openItem,markRead,reply,react,QUICK_REACTIONS} from './actions';
import {richParts} from './classify';
import {currentUserId,userLabel,channelLabel} from './sources';

export const PANEL_ID='Syncord-notify-island',PILL_ID='Syncord-notify-pill';
const BUTTON_ID='Syncord-titlebar-btn',SPOTIFY_PANEL='Syncord-spotify-island';
const MESSAGE_KINDS=new Set(['mention','dm','reply','keyword']);
const GLYPHS:Record<string,string>={voiceJoin:'🔊',voiceLeave:'🔈',stream:'📺',call:'📞',update:'⬆',sp:'✦',badge:'🏅',pluginError:'⚠',friendSyncord:'👋'};
type Mode='idle'|'item'|'list'|'toast';type Size={width:number;height:number};
const set=(node:Element,value:string):void=>{if(node.textContent!==value)node.textContent=value;};
const time=(at:number):string=>new Date(at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
/** Mentions become bold names (yellow for me) built from text nodes; never parsed as HTML. */
function rich(node:HTMLElement,text:string,guildId?:string,suffix=''):void{
  const me=currentUserId();
  node.replaceChildren(...richParts(text).map(part=>{
    if(part.type==='text')return part.value;
    const strong=document.createElement('strong');strong.className=part.type==='user'&&part.id===me?'ni-mention ni-self':'ni-mention';
    strong.textContent=part.type==='user'?'@'+userLabel(part.id,guildId):channelLabel(part.id);return strong;
  }),suffix);
}

/** The history bell: white bell, green ring waves (drawn as SVG so it stays sharp at 22px). */
function bellIcon():SVGSVGElement{
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');
  svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width','19');svg.setAttribute('height','19');svg.setAttribute('aria-hidden','true');
  const add=(tag:string,attrs:Record<string,string>):void=>{const el=document.createElementNS(ns,tag);for(const [k,v]of Object.entries(attrs))el.setAttribute(k,v);svg.append(el);};
  const line={fill:'none','stroke-width':'1.9','stroke-linecap':'round','stroke-linejoin':'round'};
  add('path',{...line,stroke:'#33d35a',d:'M8.3 3.4A6.6 6.6 0 0 0 4.4 8.6'});
  add('path',{...line,stroke:'#33d35a',d:'M15.7 3.4A6.6 6.6 0 0 1 19.6 8.6'});
  add('circle',{cx:'12',cy:'4.6',r:'1.1',fill:'#f2f2f5'});
  add('path',{...line,stroke:'#f2f2f5',d:'M12 6.1c-2.4 0-3.8 1.8-3.8 4.2 0 2.3-.4 3.6-1.6 5.2-.4.6-.1 1.2.6 1.2h9.6c.7 0 1-.6.6-1.2-1.2-1.6-1.6-2.9-1.6-5.2 0-2.4-1.4-4.2-3.8-4.2Z'});
  add('path',{fill:'#f2f2f5',d:'M10.2 18.3h3.6a1.8 1.8 0 0 1-3.6 0Z'});
  return svg;
}

function trashIcon():SVGSVGElement{
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg'),path=document.createElementNS(ns,'path');
  svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width','16');svg.setAttribute('height','16');svg.setAttribute('aria-hidden','true');
  path.setAttribute('fill','none');path.setAttribute('stroke','currentColor');path.setAttribute('stroke-width','1.9');path.setAttribute('stroke-linecap','round');path.setAttribute('stroke-linejoin','round');
  path.setAttribute('d','M4.5 7h15M9.5 7V5.2c0-.7.5-1.2 1.2-1.2h2.6c.7 0 1.2.5 1.2 1.2V7m3 0-.7 11.2c-.1 1-.9 1.8-1.9 1.8H9.1c-1 0-1.8-.8-1.9-1.8L6.5 7m3.7 4v5m3.6-5v5');
  svg.append(path);return svg;
}

function doubleCheckIcon():SVGSVGElement{
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg'),path=document.createElementNS(ns,'path');
  svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width','16');svg.setAttribute('height','16');svg.setAttribute('aria-hidden','true');
  path.setAttribute('fill','none');path.setAttribute('stroke','currentColor');path.setAttribute('stroke-width','2');path.setAttribute('stroke-linecap','round');path.setAttribute('stroke-linejoin','round');
  path.setAttribute('d','M2.5 12.5 7 17 16.5 7.5M12 16l1 1 9.5-9.5');svg.append(path);return svg;
}

export type IslandView={wake:()=>void;dispose:()=>void};
export function mountIsland(core:IslandCore,log:{warn:(...args:unknown[])=>void}):IslandView{
  const panel=document.createElement('div');panel.id=PANEL_ID;panel.setAttribute('popover','manual');panel.setAttribute('role','dialog');
  panel.innerHTML='<div class="ni-item"><div class="ni-head" data-ni-open><span class="ni-face"><img alt=""><span class="ni-glyph"></span></span><span class="ni-copy"><strong class="ni-title" dir="auto"></strong><span class="ni-place" dir="auto"></span></span><span class="ni-count"></span></div><p class="ni-text" dir="auto" data-ni-open></p><div class="ni-actions"><span class="ni-reactions"></span><button type="button" data-ni-reply></button><button type="button" data-ni-read></button><button type="button" data-ni-read-all hidden></button><button type="button" data-ni-dismiss>✕</button></div><form class="ni-reply" hidden><input maxlength="2000" dir="auto"><button type="submit"></button></form><p class="ni-error" role="status"></p></div><div class="ni-toast" role="status" hidden><span class="ni-toast-icon"></span><span class="ni-toast-text"></span></div><div class="ni-list" hidden><div class="ni-list-head"><strong></strong><button type="button" data-ni-clear></button></div><div class="ni-rows" role="list"></div></div>';
  const pill=document.createElement('button');pill.id=PILL_ID;pill.type='button';pill.hidden=true;const bell=bellIcon();
  document.body.append(panel,pill);
  const q=<T extends Element>(selector:string)=>panel.querySelector(selector) as T;
  const itemBox=q<HTMLElement>('.ni-item'),listBox=q<HTMLElement>('.ni-list'),rows=q<HTMLElement>('.ni-rows'),avatar=q<HTMLImageElement>('.ni-face img'),glyph=q<HTMLElement>('.ni-glyph'),actionsRow=q<HTMLElement>('.ni-actions'),form=q<HTMLFormElement>('.ni-reply'),input=q<HTMLInputElement>('.ni-reply input'),error=q<HTMLElement>('.ni-error'),toastBox=q<HTMLElement>('.ni-toast');
  const reactions=q<HTMLElement>('.ni-reactions'),readAll=q<HTMLButtonElement>('[data-ni-read-all]');readAll.append(doubleCheckIcon());
  for(const emoji of QUICK_REACTIONS){const b=document.createElement('button');b.type='button';b.dataset.niReact=emoji;b.textContent=emoji;reactions.append(b);}
  const motion=matchMedia('(prefers-reduced-motion: reduce)');
  let mode:Mode='idle',shown:IslandItem|undefined,disposed=false,progress=0,velocity=0,frame=0,last=0,timer=0,retry=0,leaveTimer=0,hovered=false,typing=false;
  // The panel springs from size `a` (progress 0) to size `b` (progress 1); `cur` is what is painted now.
  let from={left:0,top:0,width:120,height:28},a:Size={width:120,height:28},b:Size={width:380,height:124},cur:Size={...a},fade=true,edge=false;
  const wide=():number=>Math.max(240,Math.min(380,innerWidth-24));
  const button=():HTMLElement|null=>document.getElementById(BUTTON_ID);
  const spotifyOpen=():boolean=>!!document.getElementById(SPOTIFY_PANEL)?.matches(':popover-open');
  const measure=():void=>{
    const rect=button()?.getBoundingClientRect();
    from=rect&&rect.width?{left:rect.left,top:Math.max(0,rect.top),width:rect.width,height:rect.height||28}:{left:innerWidth/2-60,top:4,width:120,height:28};
  };
  const paint=():void=>{
    const p=Math.max(0,Math.min(1.04,progress)),width=Math.max(1,a.width+(b.width-a.width)*p),height=Math.max(1,a.height+(b.height-a.height)*p),center=from.left+from.width/2;
    cur={width,height};
    Object.assign(panel.style,{width:`${width}px`,height:`${height}px`,top:`${from.top}px`,left:`${Math.max(8,Math.min(innerWidth-width-8,center-width/2))}px`,borderRadius:`${Math.min(24,height/2)}px`});
    // Near the button the island cross-fades with the titlebar label instead of covering it with a black block.
    const blend=edge?Math.max(0,Math.min(1,p/.35)):1;panel.style.opacity=String(blend);button()?.style.setProperty('--ni-label',String(1-blend));
    panel.style.setProperty('--ni-reveal',fade?String(Math.max(0,Math.min(1,(p-.3)/.6))):'1');
    itemBox.style.width=listBox.style.width=`${wide()}px`;
  };
  const instant=():boolean=>motion.matches||performanceModeEnabled();
  const step=(now:number):void=>{
    frame=0;if(disposed)return;const target=mode==='idle'?0:1;
    if(instant()){progress=target;velocity=0;}else{const r=springStep(progress,velocity,target,(last?Math.min(64,now-last):16)/1000);progress=r.position;velocity=r.velocity;}
    last=now;paint();
    if(Math.abs(progress-target)>.001||Math.abs(velocity)>.01){frame=requestAnimationFrame(step);return;}
    progress=target;velocity=0;paint();
    if(mode==='idle'&&panel.matches(':popover-open')){panel.hidePopover();button()?.removeAttribute('data-notify-morphing');button()?.style.removeProperty('--ni-label');paintPill();}
  };
  const animate=():void=>{if(!frame){last=0;frame=requestAnimationFrame(step);}};
  /** Springs from whatever is painted (or the titlebar button) to the given size. */
  const morph=(next:Mode,height:number,width=wide(),withFade=true):void=>{
    mode=next;pill.hidden=true;measure();fade=withFade;
    edge=!panel.matches(':popover-open');
    if(edge){a={width:from.width,height:from.height};panel.showPopover();button()?.setAttribute('data-notify-morphing','');}else a={...cur};
    b={width,height};progress=0;velocity=0;paint();animate();
  };
  const collapse=():void=>{mode='idle';if(!panel.matches(':popover-open'))return;measure();fade=true;edge=true;a={width:from.width,height:from.height};b={...cur};progress=1;velocity=0;animate();};
  const close=():void=>{clearTimeout(timer);shown=undefined;typing=false;form.hidden=true;collapse();};
  const paintPill=():void=>{
    const unread=core.unread(),b=button()?.getBoundingClientRect();
    // Shown items count as seen at once, so the entry point stays while there is any history.
    pill.hidden=disposed||mode!=='idle'||core.history().length===0||!b||!b.width;
    if(pill.hidden||!b)return;
    if(unread)set(pill,String(Math.min(99,unread)));else if(pill.firstChild!==bell||pill.childNodes.length!==1)pill.replaceChildren(bell);pill.dataset.unread=String(unread>0);pill.setAttribute('aria-label',`${t('island.history')}: ${unread}`);pill.title=t('island.history');
    Object.assign(pill.style,{left:`${b.right+6}px`,top:`${b.top+(b.height-22)/2}px`});
  };
  const schedule=(ms:number):void=>{clearTimeout(timer);timer=window.setTimeout(()=>{if(!hovered&&!typing)advance();},ms);};
  /** "+N" badge, and the read-all button whenever more than one message is waiting. */
  const paintCount=():void=>{const more=core.pending()-1;set(q('.ni-count'),more>0?t('island.more',{v0:more}):'');readAll.hidden=!(more>0&&shown&&MESSAGE_KINDS.has(shown.kind));};
  const renderItem=(item:IslandItem):number=>{
    shown=item;itemBox.hidden=false;listBox.hidden=true;toastBox.hidden=true;error.textContent='';form.hidden=true;input.value='';
    const message=MESSAGE_KINDS.has(item.kind);
    avatar.hidden=!item.avatar;if(item.avatar&&avatar.getAttribute('src')!==item.avatar)avatar.src=item.avatar;if(!item.avatar)avatar.removeAttribute('src');
    glyph.hidden=!!item.avatar;set(glyph,GLYPHS[item.kind]??'💬');
    set(q('.ni-title'),item.title);set(q('.ni-place'),[item.place,time(item.at)].filter(Boolean).join(' · '));
    rich(q('.ni-text'),item.body,item.guildId);paintCount();
    reactions.hidden=!item.messageId;actionsRow.dataset.message=String(message);
    q<HTMLButtonElement>('[data-ni-reply]').hidden=q<HTMLButtonElement>('[data-ni-read]').hidden=!message;
    panel.classList.toggle('ni-clickable',!!item.channelId);
    return message?124:76;
  };
  const listHeight=(count:number):number=>Math.min(360,52+Math.max(1,Math.min(count,30))*50);
  /** Second click on the armed delete strip: the row folds away, then the island shrinks to fit. */
  const removeEntry=(entry:HTMLElement,id:string):void=>{
    if(entry.hasAttribute('data-removing'))return;entry.setAttribute('data-removing','');core.remove(id);paintPill();
    const finish=():void=>{entry.remove();if(mode!=='list')return;if(!core.history().length)morph('list',renderList(),wide(),false);else morph('list',listHeight(core.history().length),wide(),false);};
    if(instant()||typeof entry.animate!=='function'){finish();return;}
    entry.animate([{height:`${entry.offsetHeight}px`,opacity:1,transform:'none'},{height:'0px',opacity:0,transform:'translateX(24px) scale(.96)'}],{duration:260,easing:'cubic-bezier(.2,.75,.25,1)',fill:'forwards'}).finished.then(finish,finish);
  };
  const renderList=():number=>{
    itemBox.hidden=true;toastBox.hidden=true;listBox.hidden=false;set(q('.ni-list-head strong'),t('island.history'));set(q('[data-ni-clear]'),t('island.clearHistory'));
    const items=core.history();rows.replaceChildren();
    if(!items.length){const empty=document.createElement('p');empty.className='ni-empty';empty.textContent=t('island.empty');rows.append(empty);}
    for(const item of items.slice(0,30)){
      const entry=document.createElement('div');entry.className='ni-entry';entry.setAttribute('role','listitem');
      entry.addEventListener('pointerleave',()=>entry.removeAttribute('data-armed'));
      const del=document.createElement('button');del.type='button';del.className='ni-del';del.dataset.niDel=item.id;del.setAttribute('aria-label',t('island.deleteOne'));
      const label=document.createElement('span');label.className='ni-del-text';label.textContent=t('island.deleteConfirm');del.append(trashIcon(),label);
      const row=document.createElement('button');row.type='button';row.className='ni-row';row.dataset.niHistory=item.id;
      const face=document.createElement('span');face.className='ni-face';
      if(item.avatar){const img=document.createElement('img');img.alt='';img.src=item.avatar;face.append(img);}else{const g=document.createElement('span');g.className='ni-glyph';g.textContent=GLYPHS[item.kind]??'💬';face.append(g);}
      const copy=document.createElement('span');copy.className='ni-copy';const title=document.createElement('strong');title.dir='auto';title.textContent=item.title;const body=document.createElement('span');body.className='ni-place';body.dir='auto';rich(body,item.body,item.guildId,` · ${time(item.at)}`);copy.append(title,body);
      row.append(face,copy);entry.append(del,row);rows.append(entry);
    }
    return listHeight(items.length);
  };
  const advance=():void=>{
    if(disposed)return;const next=shown?core.advance():core.current();
    if(!next){close();return;}
    if(spotifyOpen()){shown=undefined;collapse();clearTimeout(retry);retry=window.setTimeout(advance,800);return;}
    const height=renderItem(next);core.markSeen();morph('item',height);schedule(options().duration*1000);
  };
  const wake=():void=>{if(disposed)return;if(mode==='idle')advance();else if(mode==='item'&&shown)paintCount();paintPill();};
  const showList=():void=>{clearTimeout(timer);clearTimeout(leaveTimer);core.markSeen();morph('list',renderList());};
  const done=():void=>{if(mode==='item')advance();};
  const fail=(err:unknown):void=>{log.warn('island action failed',err);error.textContent=t('island.failed');schedule(4000);};
  /** Shrinks to a ✓/✕ pill; success moves on, failure brings the same notification (and typed text) back. */
  const toast=(ok:boolean,text:string):void=>{
    if(disposed)return;clearTimeout(timer);typing=false;form.hidden=true;itemBox.hidden=listBox.hidden=true;toastBox.hidden=false;
    toastBox.dataset.ok=String(ok);set(q('.ni-toast-icon'),ok?'✓':'✕');set(q('.ni-toast-text'),text);
    morph('toast',36,Math.min(wide(),Math.max(140,Math.ceil(toastBox.getBoundingClientRect().width))));
    timer=window.setTimeout(()=>{
      if(disposed||mode!=='toast')return;if(ok||!shown){advance();return;}
      const draft=input.value;let height=renderItem(shown);
      if(draft){input.value=draft;form.hidden=false;typing=true;height=156;}
      morph('item',height);if(!typing)schedule(4000);
    },1600);
  };
  const failed=(err:unknown):void=>{log.warn('island action failed',err);toast(false,t('island.actionFailed'));};
  const click=(event:MouseEvent):void=>{
    const target=event.target instanceof Element?event.target:null;if(!target)return;
    const reactBtn=target.closest<HTMLElement>('[data-ni-react]');
    if(reactBtn&&shown&&mode==='item'){const item=shown;void react(item,reactBtn.dataset.niReact??'').then(()=>toast(true,t('island.reactionSent')),failed);return;}
    if(target.closest('[data-ni-reply]')){form.hidden=false;typing=true;clearTimeout(timer);morph('item',156,wide(),false);input.focus();return;}
    if(target.closest('[data-ni-read-all]')&&shown&&mode==='item'){
      const seen=new Set<string>();let ok=true;
      for(const item of core.drain())if(MESSAGE_KINDS.has(item.kind)&&item.channelId&&!seen.has(item.channelId)){seen.add(item.channelId);ok=markRead(item)&&ok;}
      if(ok)toast(true,t('island.allRead'));else failed(new Error('ack unavailable'));return;
    }
    if(target.closest('[data-ni-read]')&&shown){if(!markRead(shown))fail(new Error('ack unavailable'));else done();return;}
    if(target.closest('[data-ni-dismiss]')){done();return;}
    if(target.closest('[data-ni-clear]')){core.clear();morph('list',renderList(),wide(),false);return;}
    const del=target.closest<HTMLElement>('[data-ni-del]'),entry=del?.closest<HTMLElement>('.ni-entry');
    if(del&&entry){if(entry.hasAttribute('data-armed'))removeEntry(entry,del.dataset.niDel??'');else entry.setAttribute('data-armed','');return;}
    const history=target.closest<HTMLElement>('[data-ni-history]');
    if(history){const item=core.history().find(entry=>entry.id===history.dataset.niHistory);if(item?.channelId){void openItem(item).catch(fail);close();}return;}
    if(target.closest('[data-ni-open]')&&shown?.channelId){const item=shown;void openItem(item).catch(fail);done();}
  };
  const submit=(event:Event):void=>{event.preventDefault();const item=shown,text=input.value;if(!item||!text.trim())return;input.disabled=true;void reply(item,text).then(()=>{input.disabled=false;input.value='';typing=false;toast(true,t('island.messageSent'));},err=>{input.disabled=false;failed(err);});};
  const inputBlur=():void=>{if(!input.value.trim()){typing=false;if(!hovered)schedule(2500);}};
  const enter=():void=>{hovered=true;if(mode!=='toast')clearTimeout(timer);clearTimeout(leaveTimer);};
  const leave=():void=>{hovered=false;if(mode==='item'&&!typing)schedule(2500);if(mode==='list'){clearTimeout(leaveTimer);leaveTimer=window.setTimeout(()=>{if(!hovered&&mode==='list')close();},300);}};
  const key=(event:KeyboardEvent):void=>{if(event.key==='Escape'&&mode!=='idle'){event.preventDefault();event.stopPropagation();if(mode==='item')done();else close();}};
  const menu=(event:MouseEvent):void=>{
    event.preventDefault();event.stopPropagation();ensureReact();scanKit();
    const r=kit.react;if(!r||!kit.menu||!kit.menuCheckbox||!kit.menuRadio){log.warn('Discord menu components unavailable');return;}
    const MenuView=({navId,label,onClose}:MenuViewProps):unknown=>{
      const [,bump]=r.useState(0) as [unknown,(fn:(n:number)=>number)=>void];const cfg=options();
      const silent=r.createElement(kit.menuCheckbox,{id:'Syncord-island-silent',label:t('island.silent'),checked:cfg.silent,action:()=>{setOption('silent',!cfg.silent);bump(n=>n+1);}});
      const radio=(value:'session'|'persistent',label:string)=>r.createElement(kit.menuRadio,{id:`Syncord-island-history-${value}`,label,checked:cfg.historyMode===value,action:()=>{setOption('historyMode',value);bump(n=>n+1);}});
      const historyGroup=kit.menuGroup?r.createElement(kit.menuGroup,{label:t('island.history')},radio('session',t('island.historySession')),radio('persistent',t('island.historyPersistent'))):radio('session',t('island.historySession'));
      const clear=kit.menuItem?r.createElement(kit.menuItem,{id:'Syncord-island-clear',label:t('island.clearHistory'),action:()=>{core.clear();paintPill();if(mode==='list')morph('list',renderList(),wide(),false);onClose();}}):null;
      return r.createElement(kit.menu,{navId,'aria-label':label,onClose},silent,historyGroup,...(clear?[clear]:[]));
    };
    if(!openNativeMenu(event,MenuView,'Syncord-notification-island',t('island.menu')))log.warn('native menu could not be opened');
  };
  const pillEnter=():void=>{clearTimeout(leaveTimer);leaveTimer=window.setTimeout(showList,250);};
  const pillLeave=():void=>{clearTimeout(leaveTimer);};
  const relocate=():void=>{if(mode!=='idle'){measure();paint();}paintPill();};
  const localize=():void=>{
    panel.dir=getDirection();panel.setAttribute('aria-label',t('island.name'));
    set(q('[data-ni-reply]'),t('island.replyPlaceholder'));set(q('[data-ni-read]'),'✓');q('[data-ni-read]').setAttribute('aria-label',t('island.markRead'));(q('[data-ni-read]') as HTMLElement).title=t('island.markRead');readAll.setAttribute('aria-label',t('island.markAllRead'));readAll.title=t('island.markAllRead');
    q('[data-ni-dismiss]').setAttribute('aria-label',t('island.dismiss'));input.placeholder=t('island.replyPlaceholder');set(q('.ni-reply button'),t('island.send'));
    panel.dataset.motion=String(!instant());if(mode==='list')morph('list',renderList(),wide(),false);paintPill();
  };
  panel.addEventListener('click',click);panel.addEventListener('contextmenu',menu);panel.addEventListener('keydown',key);panel.addEventListener('pointerenter',enter);panel.addEventListener('pointerleave',leave);
  form.addEventListener('submit',submit);input.addEventListener('blur',inputBlur);
  // Discord's global shortcuts must not steal keystrokes typed into the reply box.
  const isolate=(event:KeyboardEvent):void=>{if(event.key!=='Escape')event.stopPropagation();};input.addEventListener('keydown',isolate);
  pill.addEventListener('click',showList);pill.addEventListener('contextmenu',menu);pill.addEventListener('pointerenter',pillEnter);pill.addEventListener('pointerleave',pillLeave);
  window.addEventListener('resize',relocate);window.addEventListener(ISLAND_SETTINGS,localize);
  const layout=typeof ResizeObserver==='undefined'?undefined:new ResizeObserver(relocate);
  // The titlebar button can be re-created by Discord re-renders; follow the current one.
  let observed:HTMLElement|null=null;
  const observeButton=window.setInterval(()=>{const b=button();if(b!==observed){observed=b;layout?.disconnect();if(b)layout?.observe(b);}paintPill();},2000);
  localize();
  return {wake,dispose(){
    disposed=true;cancelAnimationFrame(frame);clearTimeout(timer);clearTimeout(retry);clearTimeout(leaveTimer);clearInterval(observeButton);layout?.disconnect();
    window.removeEventListener('resize',relocate);window.removeEventListener(ISLAND_SETTINGS,localize);
    button()?.removeAttribute('data-notify-morphing');button()?.style.removeProperty('--ni-label');panel.remove();pill.remove();
  }};
}
