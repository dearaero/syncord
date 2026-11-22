import {performanceModeEnabled,onPerformanceModeChange} from '../../core/performance/state';
import {t,onLocaleChange,getDirection} from '../../i18n';
import {openSettings} from '../../ui/settingsPanel';
import {hideTooltip} from '../../ui/tooltip';
import {positionAt,spotifyLink,type SpotifySession,type SpotifyCommand} from '../../api/spotify';
import {options,SPOTIFY_SETTINGS} from './settings';
import {springStep} from './spring';
import {registerSpotifyPlayer} from './state';
const SVG='http://www.w3.org/2000/svg';
const paths:Record<string,string>={
  play:'M7 4.8c0-.9 1-1.4 1.7-.9l12 7.2c.7.4.7 1.4 0 1.8l-12 7.2c-.7.5-1.7 0-1.7-.9Z',
  pause:'M6 5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1Zm8 0a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1Z',
  next:'M2 5.5c0-.8.8-1.2 1.5-.8L13 11V5.5c0-.8.8-1.2 1.5-.8L24 11c.8.4.8 1.6 0 2l-9.5 6.3c-.7.4-1.5 0-1.5-.8V13l-9.5 6.3c-.7.4-1.5 0-1.5-.8Z',
  previous:'M24 5.5c0-.8-.8-1.2-1.5-.8L13 11V5.5c0-.8-.8-1.2-1.5-.8L2 11c-.8.4-.8 1.6 0 2l9.5 6.3c.7.4 1.5 0 1.5-.8V13l9.5 6.3c.7.4 1.5 0 1.5-.8Z',
  shuffle:'M3 6h2c5 0 9 12 14 12h2m-4-4 4 4-4 4M3 18h2c2 0 4-3 6-6m3-4c2-2 3-2 5-2h2m-4-4 4 4-4 4',
  open:'M14 3h7v7m0-7L10 14M10 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-5',
  settings:'M10 3h4l.7 2.5 2 1.2 2.5-.6 2 3.5-1.8 1.9v2.3l1.8 1.9-2 3.5-2.5-.6-2 1.2L14 22h-4l-.7-2.7-2-1.2-2.5.6-2-3.5 1.8-1.9V11L2.8 9.1l2-3.5 2.5.6 2-1.2ZM15.5 12.5a3.5 3.5 0 1 0-7 0 3.5 3.5 0 0 0 7 0Z',
  volume:'M3 9h4l5-4v14l-5-4H3Zm13-1a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14',
  repeat:'M4 10V7h15m-4-4 4 4-4 4M20 14v3H5m4 4-4-4 4-4',
};
function icon(kind:string):SVGSVGElement {
  const svg=document.createElementNS(SVG,'svg');svg.setAttribute('viewBox',kind==='next'||kind==='previous'?'0 0 26 24':'0 0 24 24');svg.setAttribute('aria-hidden','true');
  const p=document.createElementNS(SVG,'path'),filled=['play','pause','next','previous'].includes(kind);
  p.setAttribute('d',paths[kind]??paths.play);p.setAttribute('fill',filled?'currentColor':'none');p.setAttribute('stroke',filled?'none':'currentColor');p.setAttribute('stroke-width','1.7');p.setAttribute('stroke-linecap','round');p.setAttribute('stroke-linejoin','round');svg.append(p);return svg;
}
const clock=(ms:number):string=>{const seconds=Math.max(0,Math.floor(ms/1000));return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;};
/** Repeated native notifications must not manufacture child-list mutations. */
function setText(node:HTMLElement,value:string):void {if(node.textContent!==value)node.textContent=value;}
export type IslandView={update:()=>void;dispose:()=>void};
export function mountIsland(button:HTMLButtonElement,session:SpotifySession):IslandView {
  const compact=document.createElement('span');compact.className='syncord-spotify-compact';
  const smallArt=document.createElement('img');smallArt.alt='';const smallName=document.createElement('span');smallName.className='syncord-spotify-title';smallName.dir='auto';
  const eq=document.createElement('span');eq.className='syncord-spotify-eq';eq.setAttribute('aria-hidden','true');eq.innerHTML='<i></i><i></i><i></i><i></i><i></i>';compact.append(smallArt,smallName,eq);button.prepend(compact);compact.hidden=true;
  const panel=document.createElement('div');panel.id='Syncord-spotify-island';panel.setAttribute('popover','manual');panel.setAttribute('role','dialog');
  panel.innerHTML='<div class="syncord-spotify-player"><div class="syncord-spotify-heading"><span class="syncord-spotify-art" data-art-space></span><div><span class="syncord-spotify-name"></span><span class="syncord-spotify-artist"></span></div></div><input class="syncord-spotify-seek" data-seek type="range" min="0" step="1000"><div class="syncord-spotify-times"><span data-elapsed></span><span data-duration></span></div><div class="syncord-spotify-controls"></div><label class="syncord-spotify-volume"><span data-volume-label></span><input data-volume type="range" min="0" max="100" step="1"></label><p class="syncord-spotify-error" role="status"></p><div class="syncord-spotify-links"><button type="button" data-open></button><button type="button" data-settings></button></div></div>';
  const get=<T extends HTMLElement>(selector:string)=>panel.querySelector<T>(selector) as T;
  const body=get<HTMLElement>('.syncord-spotify-player'),heading=get<HTMLElement>('.syncord-spotify-heading');
  // The heading and artwork share the surface's spring, rather than fading in
  // a second header. The in-flow spacer preserves the transport's layout.
  const spacer=document.createElement('div');spacer.className='syncord-spotify-heading-space';heading.replaceWith(spacer);panel.append(heading);
  const art=document.createElement('span');art.className='syncord-spotify-artwork';art.setAttribute('aria-hidden','true');
  const oldArt=document.createElement('img'),newArt=document.createElement('img');oldArt.alt=newArt.alt='';art.append(oldArt,newArt);panel.append(art);
  const expandedEq=eq.cloneNode(true) as HTMLElement;expandedEq.classList.add('syncord-spotify-expanded-eq');panel.append(expandedEq);document.body.append(panel);
  const name=get<HTMLElement>('.syncord-spotify-name'),artist=get<HTMLElement>('.syncord-spotify-artist'),seek=get<HTMLInputElement>('[data-seek]'),volume=get<HTMLInputElement>('[data-volume]'),elapsed=get<HTMLElement>('[data-elapsed]');
  get('[data-open]').append(icon('open'));get('[data-settings]').append(icon('settings'));get('.syncord-spotify-volume').prepend(icon('volume'));
  let artworkUrl='',loadedArtwork='',lastPlaying:boolean|undefined;
  const animations=new Set<Animation>();
  const micro=(element:HTMLElement|SVGElement,keyframes:Keyframe[],duration=220):void=>{
    if(!options().animation||motion.matches||performanceModeEnabled()||document.hidden||!panel.matches(':popover-open'))return;
    // A rapid stream of player updates cannot accumulate animation objects.
    for(const animation of element.getAnimations()){animations.delete(animation);animation.cancel();}
    const animation=element.animate(keyframes,{duration,easing:'cubic-bezier(.2,.75,.25,1)'});animations.add(animation);
    animation.onfinish=animation.oncancel=()=>animations.delete(animation);
  };
  const artworkLoaded=():void=>{
    if(disposed||!artworkUrl||newArt.getAttribute('src')!==artworkUrl)return;
    newArt.style.opacity='1';
    if(loadedArtwork&&loadedArtwork!==artworkUrl){oldArt.src=loadedArtwork;micro(newArt,[{opacity:0,transform:'scale(1.045)'},{opacity:1,transform:'scale(1)'}],260);}
    loadedArtwork=artworkUrl;
  };
  newArt.addEventListener('load',artworkLoaded);
  const controls=new Map<string,HTMLButtonElement>();
  for(const kind of ['shuffle','previous','play','next','repeat']){const control=document.createElement('button');control.type='button';control.dataset.command=kind;control.append(icon(kind));get('.syncord-spotify-controls').append(control);controls.set(kind,control);}
  let disposed=false,expanded=false,hovered=false,dragging=false,keyboardFocus=false,frame=0,closeTimer=0,tick=0,progress=0,velocity=0,lastTime=0,lastTrack='',smallWidth=200,anchor={top:0,center:0},wide=392,previousWidth=button.style.width;
  const motion=matchMedia('(prefers-reduced-motion: reduce)');
  let layoutFrame=0,geometryDirty=true,observedSlots:Element[]=[];
  const layoutObserver=typeof ResizeObserver==='undefined'?undefined:new ResizeObserver(()=>{geometryDirty=true;if(!layoutFrame)layoutFrame=requestAnimationFrame(()=>{layoutFrame=0;if(!disposed)update();});});
  const measure=():void=>{
    const rect=button.getBoundingClientRect();anchor={top:Math.max(0,rect.top),center:rect.left+rect.width/2};wide=Math.max(220,Math.min(392,innerWidth-24));
    const bar=button.closest('[data-syncord-titlebar-layout]'),children=bar?[...bar.children]:[];
    const leading=children.find(el=>[...el.classList].some(c=>c.startsWith('leading_'))),trailing=children.find(el=>[...el.classList].some(c=>c.startsWith('trailing_')));
    const slots=[button,...(bar?[bar]:[]),...(leading?[leading]:[]),...(trailing?[trailing]:[])];
    if(slots.length!==observedSlots.length||slots.some((slot,i)=>slot!==observedSlots[i])){layoutObserver?.disconnect();for(const slot of slots)layoutObserver?.observe(slot);observedSlots=slots;}
    const center=innerWidth/2,available=leading&&trailing?2*Math.min(center-leading.getBoundingClientRect().right-8,trailing.getBoundingClientRect().left-center-8):Math.min(220,innerWidth*.3);
    const navigation=leading?.querySelector('[class*="backForward"]');
    if(navigation&&trailing){
      const safeWidth=2*Math.min(center-navigation.getBoundingClientRect().right-12,trailing.getBoundingClientRect().left-center-12);
      // A narrow window must leave the real navigation/window controls usable.
      wide=Math.min(wide,Math.max(220,safeWidth));
    }
    smallWidth=Math.max(60,Math.min(220,available));button.style.setProperty('--spotify-available',String(available));
    if(button.hasAttribute('data-spotify-island'))button.style.width=`${smallWidth}px`;
    geometryDirty=false;
  };
  const paintGeometry=():void=>{
    const p=Math.max(0,Math.min(1.04,progress)),settled=Math.min(1,p);
    const width=smallWidth+(wide-smallWidth)*p,height=28+230*p;
    panel.style.width=`${width}px`;panel.style.height=`${height}px`;panel.style.top=`${anchor.top}px`;
    panel.style.left=`${Math.max(8,Math.min(innerWidth-width-8,anchor.center-width/2))}px`;
    panel.style.borderRadius=`${14+24*p}px`;
    const reveal=Math.max(0,Math.min(1,(p-.28)/.65));
    panel.style.setProperty('--spotify-content-opacity',String(reveal));
    panel.style.setProperty('--spotify-progress',String(settled));
    body.style.width=`${wide}px`;
    const hasCover=!art.hidden,textStart=hasCover?39+53*settled:10+12*settled;
    Object.assign(heading.style,{left:`${textStart}px`,top:`${5+20*settled}px`,width:`${Math.max(0,width-textStart-48)}px`});
    name.style.fontSize=`${12+3*settled}px`;name.style.lineHeight=`${18+3*settled}px`;
    artist.style.opacity=String(Math.max(0,(settled-.32)/.68));
    artist.style.transform=`translateY(${-3*(1-settled)}px)`;
    const size=21+41*settled;
    Object.assign(art.style,{width:`${size}px`,height:`${size}px`,top:`${3.5+16.5*settled}px`,left:`${10+12*settled}px`,borderRadius:`${10.5+3.5*settled}px`});
    Object.assign(expandedEq.style,{right:`${10+12*settled}px`,top:`${6.5+30*settled}px`,transform:`scale(${1+.12*settled})`});
  };
  const stopTick=():void=>{clearInterval(tick);tick=0;};
  const paintProgress=():void=>{const s=session.snapshot();if(!dragging)seek.value=String(positionAt(s));seek.style.setProperty('--spotify-fill',`${s.track?.duration?Math.min(100,Number(seek.value)/s.track.duration*100):0}%`);setText(elapsed,clock(Number(seek.value)));const previous=controls.get('previous');if(previous)previous.disabled=!session.can(options().restart&&positionAt(s)>3000?'seek':'previous');};
  const syncTick=():void=>{const cfg=options();eq.dataset.moving=expandedEq.dataset.moving=String(session.snapshot().playing&&cfg.animation&&cfg.equalizer&&!motion.matches&&!performanceModeEnabled()&&!document.hidden);if(expanded&&session.snapshot().playing&&!document.hidden){paintProgress();if(!tick)tick=window.setInterval(paintProgress,500);}else stopTick();};
  const animate=(now:number):void=>{
    frame=0;if(disposed)return;const target=expanded?1:0;
    if(!options().animation||motion.matches||performanceModeEnabled()){progress=target;velocity=0;}
    else{const result=springStep(progress,velocity,target,(lastTime?Math.min(64,now-lastTime):16)/1000*options().speed);progress=result.position;velocity=result.velocity;}
    lastTime=now;paintGeometry();
    if(Math.abs(progress-target)>.001||Math.abs(velocity)>.01)frame=requestAnimationFrame(animate);
    else{progress=target;velocity=0;paintGeometry();if(!expanded&&panel.matches(':popover-open')){panel.hidePopover();button.removeAttribute('data-spotify-morphing');}}
  };
  const transition=(open:boolean):void=>{
    if(disposed||(open&&!session.snapshot().track))return;
    clearTimeout(closeTimer);if(open===expanded&&panel.matches(':popover-open'))return;expanded=open;button.setAttribute('aria-expanded',String(open));
    if(open){hideTooltip();measure();if(!panel.matches(':popover-open')){progress=0;paintGeometry();panel.showPopover();button.setAttribute('data-spotify-morphing','');}}
    syncTick();if(!frame){lastTime=0;frame=requestAnimationFrame(animate);}
  };
  const closeLater=():void=>{clearTimeout(closeTimer);closeTimer=window.setTimeout(()=>{if(!hovered&&!dragging&&!(keyboardFocus&&(panel.contains(document.activeElement)||document.activeElement===button)))transition(false);},140);};
  const enter=():void=>{hovered=true;clearTimeout(closeTimer);if(options().hover)transition(true);};
  const leave=():void=>{hovered=false;closeLater();};
  const trigger=(e:Event):void=>{if(e instanceof MouseEvent&&e.detail>0)keyboardFocus=false;if(!button.hasAttribute('data-spotify-island'))return;e.preventDefault();e.stopImmediatePropagation();transition(!expanded);};
  const release=():void=>{dragging=false;if(!hovered)closeLater();};
  const key=(e:KeyboardEvent):void=>{keyboardFocus=true;if(e.key==='Escape'&&expanded){e.preventDefault();e.stopPropagation();transition(false);button.focus({preventScroll:true});}};
  const resize=():void=>{geometryDirty=true;update();};
  const settingsClick=():void=>{transition(false);openSettings();};
  const openClick=():void=>{const url=spotifyLink(session.snapshot().track);if(url)window.open(url,'_blank','noopener,noreferrer');};
  const command=(kind:string):void=>{
    const s=session.snapshot();let c:SpotifyCommand;
    if(kind==='play')c={kind:s.playing?'pause':'play'};
    else if(kind==='previous'&&options().restart&&positionAt(s)>3000)c={kind:'seek',value:0};
    else if(kind==='shuffle')c={kind:'shuffle',value:!s.shuffle};
    else if(kind==='repeat')c={kind:'repeat',value:s.repeat==='off'?'context':s.repeat==='context'?'track':'off'};
    else if(kind==='next'||kind==='previous')c={kind};else return;
    void session.command(c);
  };
  for(const [kind,control]of controls)control.onclick=()=>{micro(control,[{transform:'scale(.88)'},{transform:'scale(1)'}],260);command(kind);};
  seek.oninput=()=>{const duration=session.snapshot().track?.duration??0;seek.style.setProperty('--spotify-fill',`${duration?Number(seek.value)/duration*100:0}%`);setText(elapsed,clock(Number(seek.value)));};seek.onchange=()=>{void session.command({kind:'seek',value:Number(seek.value)});};
  volume.oninput=()=>volume.style.setProperty('--spotify-fill',`${volume.value}%`);
  volume.onchange=()=>{void session.command({kind:'volume',value:Number(volume.value)});};
  panel.onpointerdown=event=>{keyboardFocus=false;if(event.target instanceof HTMLInputElement)dragging=true;};
  panel.onpointerenter=()=>{hovered=true;clearTimeout(closeTimer);};panel.onpointerleave=leave;panel.addEventListener('focusout',closeLater);
  get<HTMLButtonElement>('[data-settings]').onclick=settingsClick;get<HTMLButtonElement>('[data-open]').onclick=openClick;
  button.addEventListener('pointerenter',enter);button.addEventListener('pointerleave',leave);button.addEventListener('click',trigger,true);button.addEventListener('focusout',closeLater);
  panel.addEventListener('keydown',key);button.addEventListener('keydown',key);window.addEventListener('pointerup',release);window.addEventListener('pointercancel',release);window.addEventListener('resize',resize);document.addEventListener('visibilitychange',syncTick);
  const update=():void=>{
    if(disposed)return;const s=session.snapshot(),cfg=options();if(geometryDirty)measure();
    panel.dataset.motion=String(cfg.animation&&!motion.matches);
    if(!cfg.animation||motion.matches){for(const animation of animations)animation.cancel();animations.clear();}
    if(!s.connected||!s.track){if(expanded)transition(false);}
    const visible=cfg.island&&s.connected&&s.track!==null&&Number(button.style.getPropertyValue('--spotify-available'))>=60;
    button.toggleAttribute('data-spotify-island',visible);compact.hidden=!visible;
    if(visible){button.style.width=`${smallWidth}px`;button.setAttribute('aria-haspopup','dialog');button.dataset.syncordTitlebarLabel=`${s.track?.name} · ${s.track?.artist}`;}
    else{button.style.width=previousWidth;delete button.dataset.syncordTitlebarLabel;button.removeAttribute('aria-haspopup');button.removeAttribute('aria-expanded');if(expanded)transition(false);}
    const url=s.track?.cover??'';smallArt.hidden=art.hidden=!cfg.cover||!url;
    if(url&&smallArt.getAttribute('src')!==url)smallArt.src=url;
    if(url!==artworkUrl){
      artworkUrl=url;
      if(url){if(loadedArtwork)oldArt.src=loadedArtwork;newArt.style.opacity='0';newArt.src=url;}
      else{newArt.removeAttribute('src');oldArt.removeAttribute('src');loadedArtwork='';}
    }
    if(!url)smallArt.removeAttribute('src');
    get('[data-art-space]').hidden=!cfg.cover||!s.track?.cover;
    setText(smallName,s.track?.name??'');setText(name,s.track?.name??'');setText(artist,s.track?.artist??'');
    eq.dataset.moving=expandedEq.dataset.moving=String(s.playing&&cfg.animation&&cfg.equalizer&&!motion.matches&&!performanceModeEnabled());eq.hidden=expandedEq.hidden=!cfg.equalizer;panel.dataset.playing=String(s.playing);
    panel.dir=getDirection();name.dir=artist.dir='auto';panel.setAttribute('aria-label',t('spotify.player'));panel.setAttribute('aria-busy',String(s.busy));
    for(const [kind,control]of controls){const actual=kind==='play'?(s.playing?'pause':'play'):kind;
      control.setAttribute('aria-label',t('spotify.'+actual));control.title=t('spotify.'+actual);
      const capability=kind==='previous'&&cfg.restart&&positionAt(s)>3000?'seek':actual;
      control.disabled=!session.can(capability as SpotifyCommand['kind']);
      if(kind==='play'&&lastPlaying!==s.playing){control.replaceChildren(icon(actual));micro(control.firstElementChild as SVGElement,[{opacity:.25,transform:'scale(.8)'},{opacity:1,transform:'scale(1)'}],180);}
      if(kind==='shuffle')control.setAttribute('aria-pressed',String(s.shuffle===true));
      if(kind==='repeat'){control.dataset.mode=s.repeat??'off';control.setAttribute('aria-pressed',String(s.repeat!==null&&s.repeat!=='off'));control.title=t('spotify.repeat')+': '+t('spotify.'+(s.repeat??'unavailable'));}
    }
    seek.max=String(s.track?.duration??0);seek.disabled=!session.can('seek');seek.setAttribute('aria-label',t('spotify.seek'));if(!dragging)seek.value=String(positionAt(s));
    setText(get('[data-duration]'),clock(s.track?.duration??0));paintProgress();
    volume.disabled=!session.can('volume');volume.setAttribute('aria-label',t('spotify.volume'));if(!dragging)volume.value=String(s.volume);volume.style.setProperty('--spotify-fill',`${volume.value}%`);setText(get('[data-volume-label]'),t('spotify.volume'));
    get('[data-open]').setAttribute('aria-label',t('spotify.open'));get('[data-open]').title=t('spotify.open');get<HTMLButtonElement>('[data-open]').disabled=!spotifyLink(s.track);get('[data-settings]').setAttribute('aria-label',t('ui.open_syncord_settings'));get('[data-settings]').title=t('ui.open_syncord_settings');
    setText(get('.syncord-spotify-error'),s.error!=='none'?t('spotify.'+s.error):!s.premium||s.restricted||!s.deviceId?t('spotify.unavailable'):'');
    lastPlaying=s.playing;
    const trackKey=s.track?.id??'';
    if(lastTrack&&trackKey!==lastTrack){micro(name,[{opacity:.2,transform:'translateY(3px)'},{opacity:1,transform:'translateY(0)'}],260);micro(artist,[{opacity:0},{opacity:1}],280);}
    lastTrack=trackKey;
    syncTick();if(panel.matches(':popover-open'))paintGeometry();
  };
  window.addEventListener(SPOTIFY_SETTINGS,update);motion.addEventListener('change',update);const locale=onLocaleChange(update),player=registerSpotifyPlayer(()=>transition(true));
  const performanceChange=onPerformanceModeChange(()=>{for(const animation of animations)animation.finish();animations.clear();if(performanceModeEnabled()&&frame){cancelAnimationFrame(frame);frame=0;animate(performance.now());}update();});
  const first=requestAnimationFrame(update);update();
  return {update,dispose(){disposed=true;layoutObserver?.disconnect();observedSlots=[];cancelAnimationFrame(layoutFrame);cancelAnimationFrame(first);cancelAnimationFrame(frame);clearTimeout(closeTimer);stopTick();newArt.removeEventListener('load',artworkLoaded);for(const animation of animations)animation.cancel();animations.clear();locale();player();performanceChange();window.removeEventListener(SPOTIFY_SETTINGS,update);motion.removeEventListener('change',update);button.removeEventListener('pointerenter',enter);button.removeEventListener('pointerleave',leave);button.removeEventListener('click',trigger,true);button.removeEventListener('focusout',closeLater);button.removeEventListener('keydown',key);panel.removeEventListener('focusout',closeLater);window.removeEventListener('pointerup',release);window.removeEventListener('pointercancel',release);window.removeEventListener('resize',resize);document.removeEventListener('visibilitychange',syncTick);button.removeAttribute('data-spotify-island');button.removeAttribute('data-spotify-morphing');delete button.dataset.syncordTitlebarLabel;button.removeAttribute('aria-haspopup');button.removeAttribute('aria-expanded');button.style.width=previousWidth;button.style.removeProperty('--spotify-available');compact.remove();panel.remove();}};
}
