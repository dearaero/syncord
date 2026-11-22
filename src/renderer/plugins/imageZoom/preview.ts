import { h, localizeError, messageHtml as i18nHtml, setLocalizedAttribute, setLocalizedHtml, t as i18nText } from "../../i18n";
import { GifPlayback, readGif, type GifState } from './gif';
import { inlineTransform, keyMatches, modifierMatches, wheelSteps } from './model';
import type { HoverImage } from './source';
import type { ImageZoomOptions } from './settings';

// Transient, property-level ownership: a native rerender always wins. Never
// replace/move a React-owned image or restore a stale copy of its whole style.
class NativeEdits {
  private styles=new Map<HTMLElement,Map<string,{before:string;priority:string;value:string}>>();
  private attrs=new Map<HTMLElement,Map<string,{before:string|null;value:string|null}>>();
  private emptyStyle=new Set<HTMLElement>();
  style(element:HTMLElement,key:string,value:string):void {
    let entries=this.styles.get(element);
    if(!entries){this.styles.set(element,entries=new Map());if(!element.hasAttribute('style'))this.emptyStyle.add(element);}
    const entry=entries.get(key);
    if(entry&&(element.style.getPropertyValue(key)!==entry.value||element.style.getPropertyPriority(key)!=='important'))return;
    const before=entry??{before:element.style.getPropertyValue(key),priority:element.style.getPropertyPriority(key),value:''};
    element.style.setProperty(key,value,'important');before.value=element.style.getPropertyValue(key);entries.set(key,before);
  }
  attr(element:HTMLElement,key:string,value:string|null):void {
    let entries=this.attrs.get(element);if(!entries)this.attrs.set(element,entries=new Map());
    const previous=entries.get(key);if(previous&&element.getAttribute(key)!==previous.value)return;
    const entry=previous??{before:element.getAttribute(key),value:null};
    if(value===null)element.removeAttribute(key);else element.setAttribute(key,value);entry.value=element.getAttribute(key);entries.set(key,entry);
  }
  releaseStyle(el:HTMLElement,key:string):void {
    const entries=this.styles.get(el),entry=entries?.get(key);if(!entry)return;
    if(el.style.getPropertyValue(key)===entry.value&&el.style.getPropertyPriority(key)==='important'){
      if(entry.before)el.style.setProperty(key,entry.before,entry.priority);else el.style.removeProperty(key);
    }
    entries?.delete(key);if(this.emptyStyle.has(el)&&!el.style.length)el.removeAttribute('style');
  }
  ownsAttributes():boolean {for(const [el,entries]of this.attrs)for(const [key,entry]of entries)if(el.getAttribute(key)!==entry.value)return false;return true;}
  restore():void {
    for(const [el,entries]of this.styles){for(const [key,entry]of entries)if(el.style.getPropertyValue(key)===entry.value&&el.style.getPropertyPriority(key)==='important'){
      if(entry.before)el.style.setProperty(key,entry.before,entry.priority);else el.style.removeProperty(key);
    }if(this.emptyStyle.has(el)&&!el.style.length)el.removeAttribute('style');}
    for(const [el,entries]of this.attrs){
      const nativeSourceChanged=['src','srcset'].some(key=>{const e=entries.get(key);return e&&el.getAttribute(key)!==e.value;});
      for(const [key,entry]of entries)if(!(nativeSourceChanged&&['src','srcset'].includes(key))&&el.getAttribute(key)===entry.value){if(entry.before===null)el.removeAttribute(key);else el.setAttribute(key,entry.before);}
    }
    this.styles.clear();this.attrs.clear();
  }
}

/** A single inline inspection session, bounded by the existing image wrapper. */
export class InlineImageZoom {
  readonly element:HTMLDivElement;
  private readonly controller=new AbortController();
  private readonly edits=new NativeEdits();
  private readonly canvas:HTMLCanvasElement;
  private readonly status:HTMLSpanElement;
  private readonly gifBar:HTMLSpanElement;
  private readonly frameLabel:HTMLSpanElement;
  private readonly playButton:HTMLButtonElement;
  private readonly pixelButton:HTMLButtonElement;
  private readonly host:HTMLElement;
  private readonly observer:MutationObserver;
  private readonly sizeObserver:ResizeObserver;
  private readonly layout:HTMLElement[]=[];
  private readonly originalSrc:string|null;
  private readonly originalSrcset:string|null;
  private player:GifPlayback|undefined;
  private originalLoader:HTMLImageElement|undefined;
  private closed=false;
  private videoWasPlaying=false;
  private baseWidth:number;
  private baseHeight:number;
  private zoom=1;
  private actualPixels=false;
  private panX=.5;
  private panY=.5;
  private pixel:boolean;
  private detail='';
  constructor(readonly source:HoverImage,readonly options:ImageZoomOptions,private readonly closedCallback:()=>void) {
    if(!(source.hitArea instanceof HTMLElement)||source.hitArea===source.element)throw Error("No bounded native image wrapper.");
    this.host=source.hitArea;const bounds=source.element.getBoundingClientRect();
    this.baseWidth=bounds.width;this.baseHeight=bounds.height;this.pixel=options.pixelPerfect;
    this.originalSrc=source.element.getAttribute('src');this.originalSrcset=source.element.getAttribute('srcset');
    const root=this.element=document.createElement('div');root.id='Syncord-image-zoom';setLocalizedAttribute(root, 'aria-label', "ui.inline_imagezoom_controls");
    // This layer lives inside the attachment. It contains no duplicate image,
    // dialog, portal or popover; ordinary clicks pass through to Discord.
    setLocalizedHtml(root, `<canvas hidden aria-label="${h("ui.gif_frame")}" data-si18n-aria-label="ui.gif_frame"></canvas><div class="iz-controls"><span class="iz-status" aria-live="off"></span><button type="button" data-iz="actual" aria-label="${h("ui.original_pixels_1_to_1")}" data-si18n-aria-label="ui.original_pixels_1_to_1">1:1</button><button type="button" data-iz="reset" aria-label="${h("ui.reset_image_zoom")}" data-si18n-aria-label="ui.reset_image_zoom">${i18nHtml("ui.reset")}</button><button type="button" data-iz="pixel" aria-label="${h("ui.pixel_perfect")}" aria-pressed="false" data-si18n-aria-label="ui.pixel_perfect">${i18nHtml("ui.pixels")}</button><span class="iz-gif" hidden><button type="button" data-iz="previous" aria-label="${h("ui.previous_gif_frame")}" disabled data-si18n-aria-label="ui.previous_gif_frame">‹</button><button type="button" data-iz="play" aria-label="${h("ui.play_or_pause_gif")}" disabled data-si18n-aria-label="ui.play_or_pause_gif">${i18nHtml("ui.pause")}</button><button type="button" data-iz="next" aria-label="${h("ui.next_gif_frame")}" disabled data-si18n-aria-label="ui.next_gif_frame">›</button><span class="iz-frame"></span></span></div>`);
    const get=<T extends Element>(selector:string):T=>{const el=root.querySelector<T>(selector);if(!el)throw Error("Incomplete inline controls.");return el;};
    this.canvas=get('canvas');this.status=get('.iz-status');this.gifBar=get('.iz-gif');this.frameLabel=get('.iz-frame');this.playButton=get('[data-iz=play]');this.pixelButton=get('[data-iz=pixel]');
    if(getComputedStyle(this.host).position==='static')this.edits.style(this.host,'position','relative');
    this.edits.style(this.host,'overflow','hidden');
    this.edits.attr(this.host,'data-iz-host','true');
    this.edits.attr(source.element,'src',this.originalSrc);this.edits.attr(source.element,'srcset',this.originalSrcset);
    this.edits.attr(source.element,'data-iz-media','true');
    this.edits.attr(source.element,'data-iz-smooth',String(options.smooth));
    // Keep the native thumbnail's layout when its intrinsic dimensions change.
    this.edits.style(source.element,'width',`${bounds.width}px`);this.edits.style(source.element,'height',`${bounds.height}px`);
    this.edits.style(source.element,'transform-origin','0 0');
    this.host.append(root);
    let parent=source.element.parentElement;
    while(parent&&this.host.contains(parent)&&parent!==this.host){
      const rect=parent.getBoundingClientRect();
      if(Math.abs(rect.width-bounds.width)<3&&Math.abs(rect.height-bounds.height)<3)this.layout.push(parent);
      parent=parent.parentElement;
    }
    root.addEventListener('pointerdown',event=>{
      if(event.target instanceof Element&&event.target.closest('button'))event.stopPropagation();
    },{signal:this.controller.signal});
    root.addEventListener('click',event=>{
      const button=event.target instanceof Element?event.target.closest<HTMLButtonElement>('button[data-iz]'):null;
      if(!button)return;event.preventDefault();event.stopPropagation();
      switch(button.dataset.iz){case 'actual':this.actualSize();break;case 'reset':this.reset();break;case 'pixel':this.togglePixel();break;
        case 'play':this.player?.toggle();break;case 'previous':this.player?.step(-1);break;case 'next':this.player?.step(1);break;}
    },{signal:this.controller.signal});
    // Native image clicks retain Discord's image modal, after restoring source
    // attributes. Controls are the only clicks consumed by ImageZoom.
    this.host.addEventListener('click',event=>{if(!(event.target instanceof Node&&root.contains(event.target)))this.close();},{capture:true,signal:this.controller.signal});
    source.element.addEventListener('load',()=>this.resize(),{signal:this.controller.signal});
    this.observer=new MutationObserver(()=>{
      if(!this.current())this.close();
    });
    const scopeParent=this.host.parentElement;
    const scope=scopeParent&&scopeParent!==document.body&&scopeParent!==document.documentElement?scopeParent:this.host;
    this.observer.observe(scope,{childList:true,subtree:true,attributes:true,attributeFilter:['src','srcset','data-spoiler-hidden']});
    this.sizeObserver=new ResizeObserver(()=>this.resize());this.sizeObserver.observe(this.host);
    this.resize();
    const decodeGif=source.gif&&(options.gifControls||!options.gifAutoplay);
    if(options.highResolution&&!decodeGif&&source.element instanceof HTMLImageElement&&(source.element.src!==source.original||!!source.element.srcset))this.loadOriginal();
    if(decodeGif)void this.loadGif();
  }
  private current():boolean {
    return !this.closed&&this.source.element.isConnected&&this.element.isConnected&&this.edits.ownsAttributes()
      &&!this.host.closest('[data-spoiler-hidden="true"]');
  }
  private dimensions():{width:number;height:number} {
    if(this.player)return {width:this.canvas.width,height:this.canvas.height};
    const el=this.source.element;return el instanceof HTMLImageElement?{width:el.naturalWidth,height:el.naturalHeight}:{width:el.videoWidth,height:el.videoHeight};
  }
  private loadOriginal():void {
    const loader=this.originalLoader=new Image();loader.referrerPolicy='no-referrer';loader.decoding='async';this.detail=i18nText("ui.loading_original");
    loader.addEventListener('load',()=>{
      if(!this.current()||this.originalLoader!==loader)return;
      this.originalLoader=undefined;this.detail='';
      this.edits.attr(this.source.element,'srcset',null);this.edits.attr(this.source.element,'src',this.source.original);this.paint();
    },{once:true,signal:this.controller.signal});
    loader.addEventListener('error',()=>{if(!this.current())return;this.originalLoader=undefined;this.detail=i18nText("ui.original_unavailable");loader.removeAttribute('src');this.paint();},{once:true,signal:this.controller.signal});
    loader.src=this.source.original;
  }
  private async loadGif():Promise<void> {
    const signal=this.controller.signal;this.gifBar.hidden=!this.options.gifControls;
    try{
      const bytes=await readGif(this.source.original,this.options.gifMaxMB*1024*1024,signal);signal.throwIfAborted();
      const player=await GifPlayback.create(bytes,this.canvas,{autoplay:this.options.gifAutoplay,loop:this.options.gifLoop,speed:this.options.gifSpeed,maxPixels:this.options.gifMaxMP*1_000_000},signal,state=>this.gifChanged(state),error=>this.gifFailed(error));
      if(!this.current()){player.close();this.close();return;}
      this.player=player;this.canvas.hidden=false;this.edits.style(this.source.element,'opacity','0');
      if(this.source.element instanceof HTMLVideoElement){this.videoWasPlaying=!this.source.element.paused;this.source.element.pause();}
      this.detail='';for(const button of this.gifBar.querySelectorAll('button'))button.disabled=false;
      this.gifChanged(player.snapshot());this.paint();
    }catch(error){if(!this.closed&&!signal.aborted)this.gifFailed(error);}
  }
  private gifFailed(error:unknown):void {
    if(this.closed)return;this.player?.close();this.player=undefined;this.canvas.hidden=true;
    this.edits.releaseStyle(this.source.element,'opacity');this.gifBar.hidden=true;
    this.resumeVideo();
    this.detail=i18nText("ui.gif_controls_unavailable_value", {v0: error instanceof Error?localizeError(error):i18nText("ui.cannot_decode_original")});this.paint();
  }
  private gifChanged(state:GifState):void {
    if(this.closed)return;if(!this.current()){this.close();return;}
    this.frameLabel.textContent=`${state.frame+1} / ${state.count}`;this.playButton.textContent=state.playing?i18nText("ui.pause"):i18nText("ui.play");
  }
  resize():void {if(!this.current()){this.close();return;}this.paint();}
  pointer(x:number,y:number):void {
    if(!this.current()){this.close();return;}
    if(this.options.pan){const r=this.host.getBoundingClientRect();if(r.width&&r.height){this.panX=Math.max(0,Math.min(1,(x-r.left)/r.width));this.panY=Math.max(0,Math.min(1,(y-r.top)/r.height));this.paint();}}
  }
  private paint():void {
    if(this.closed)return;
    const media=this.source.element,w=media.offsetWidth,h=media.offsetHeight;
    if(this.actualPixels&&w&&this.dimensions().width)this.zoom=this.dimensions().width/w;
    const {x,y}=inlineTransform(w,h,this.zoom,this.panX,this.panY);
    const transform=`translate(${x}px,${y}px) scale(${this.zoom})`;
    this.edits.style(media,'transform',transform);this.edits.attr(media,'data-iz-pixel',String(this.pixel));
    if(this.player){
      // Layout offsets stay stable while CSS is interpolating a zoom/pan.
      // Measuring the transformed rect here would make the GIF canvas drift.
      let node:HTMLElement|null=media,left=0,top=0;
      while(node&&node!==this.host){left+=node.offsetLeft;top+=node.offsetTop;node=node.offsetParent instanceof HTMLElement?node.offsetParent:null;}
      this.canvas.style.left=`${left}px`;this.canvas.style.top=`${top}px`;
      this.canvas.style.width=`${w}px`;this.canvas.style.height=`${h}px`;this.canvas.style.transform=transform;
      this.canvas.dataset.izPixel=String(this.pixel);this.canvas.dataset.izSmooth=String(this.options.smooth);
      this.canvas.style.objectFit=getComputedStyle(media).objectFit;
    }
    const d=this.dimensions();this.pixelButton.setAttribute('aria-pressed',String(this.pixel));
    this.status.textContent=this.detail||`${Math.round(this.zoom*100)}%`;
    this.status.title=[`${d.width} × ${d.height}`,this.detail].filter(Boolean).join(' · ');
  }
  private actualSize():void {const d=this.dimensions();if(d.width&&this.source.element.offsetWidth){this.actualPixels=true;this.zoom=d.width/this.source.element.offsetWidth;this.paint();}}
  private reset():void {this.actualPixels=false;this.zoom=1;this.panX=this.panY=.5;this.paint();}
  private togglePixel():void {this.pixel=!this.pixel;this.paint();}
  wheel(event:WheelEvent):boolean {
    if(!this.current()){this.close();return false;}
    const steps=wheelSteps(event.deltaY,event.deltaMode);if(!steps)return false;
    if(this.options.zoomEnabled&&modifierMatches(this.options.zoomModifier,event)){
      const d=this.dimensions(),width=this.source.element.offsetWidth;if(!width||!d.width)return false;
      this.actualPixels=false;this.zoom=Math.max(Math.min(1,d.width/width),Math.min(Math.max(1,d.width/width*this.options.maxZoom),this.zoom*Math.exp(-steps*this.options.zoomStep)));this.paint();return true;
    }
    if(this.options.resizeEnabled&&modifierMatches(this.options.resizeModifier,event)){
      const available=this.host.parentElement?.clientWidth||window.innerWidth;
      const width=Math.max(Math.min(48,this.baseWidth),Math.min(available,1400,this.source.element.offsetWidth-steps*this.options.resizeStep));
      const height=width*this.baseHeight/this.baseWidth;
      for(const el of [this.host,...this.layout,this.source.element]){this.edits.style(el,'width',`${width}px`);this.edits.style(el,'height',`${height}px`);this.edits.style(el,'max-width','none');this.edits.style(el,'max-height','none');}
      this.paint();return true;
    }
    return false;
  }
  key(event:KeyboardEvent,editing:boolean):boolean {
    if(!this.current()){this.close();return false;}
    const match=(binding:string):boolean=>keyMatches(binding,event.key,event.code);
    if(match(this.options.closeKey)){this.close();return true;}
    if((editing&&this.options.protectTyping)||event.ctrlKey||event.metaKey||event.altKey)return false;
    if(match(this.options.pixelKey)){if(!event.repeat)this.togglePixel();return true;}
    if(match(this.options.resetKey)){this.reset();return true;}
    if(this.options.gifControls&&this.player){
      if(match(this.options.pauseKey)){if(!event.repeat)this.player.toggle();return true;}
      if(match(this.options.previousKey)){this.player.step(-1);return true;}
      if(match(this.options.nextKey)){this.player.step(1);return true;}
    }return false;
  }
  private resumeVideo():void {
    if(this.videoWasPlaying&&this.source.element instanceof HTMLVideoElement&&this.source.element.isConnected)void this.source.element.play().catch(()=>{});
    this.videoWasPlaying=false;
  }
  close():void {
    if(this.closed)return;this.closed=true;this.controller.abort();this.observer?.disconnect();this.sizeObserver?.disconnect();
    this.player?.close();this.player=undefined;this.originalLoader?.removeAttribute('src');this.originalLoader=undefined;
    this.canvas.width=this.canvas.height=0;this.element.remove();this.edits.restore();
    this.resumeVideo();this.closedCallback();
  }
}
