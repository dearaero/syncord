import { t as i18nText } from "../../i18n";
import { definePlugin } from '../../api/plugin';
import { sharedDispatcher } from '../../api/discordEvents';
import { imageZoomOptions, IMAGE_ZOOM_ID, IMAGE_ZOOM_CHANGED } from './settings';
import { hoverImage, type HoverImage } from './source';
import { InlineImageZoom } from './preview';
import { IMAGE_ZOOM_CSS } from './styles';
export const ImageZoomPlugin=definePlugin({
  id:IMAGE_ZOOM_ID,name:'ImageZoom',author:i18nText("ui.syncord"),enabledByDefault:true,
  get description() { return i18nText("ui.hover_to_inspect_original_images_with_smooth_zoom_pan_sharp_pixels_and"); },
  permissions:{media:true,userData:true},
  start(ctx){
    ctx.css.inject(IMAGE_ZOOM_CSS);
    const events=new AbortController();let stopped=false,view:InlineImageZoom|undefined,pending:HoverImage|undefined;
    let opening:ReturnType<typeof setTimeout>|undefined,closing:ReturnType<typeof setTimeout>|undefined,raf=0;
    let point={x:0,y:0};
    const cancelOpening=():void=>{if(opening!==undefined)clearTimeout(opening);opening=undefined;pending=undefined;};
    const cancelClosing=():void=>{if(closing!==undefined)clearTimeout(closing);closing=undefined;};
    const close=():void=>{cancelOpening();cancelClosing();view?.close();view=undefined;if(raf)cancelAnimationFrame(raf);raf=0;};
    const scheduleClose=():void=>{
      cancelOpening();if(!view||closing!==undefined)return;
      closing=setTimeout(()=>{closing=undefined;close();},view.options.closeDelay);
    };
    const over=(event:PointerEvent):void=>{
      if(stopped||event.pointerType==='touch'||event.buttons)return;
      if(event.target instanceof Node&&view?.element.contains(event.target)){cancelClosing();return;}
      const options=imageZoomOptions(),candidate=options.hover?hoverImage(event.target,options.avatars):undefined;
      if(!candidate){scheduleClose();return;}
      point={x:event.clientX,y:event.clientY};cancelClosing();
      if(view?.source.element===candidate.element||pending?.element===candidate.element)return;
      close();pending=candidate;
      const open=():void=>{
        opening=undefined;if(stopped||!candidate.element.isConnected||pending!==candidate)return;
        pending=undefined;const fresh=hoverImage(candidate.element,options.avatars);if(!fresh)return;
        try{view=new InlineImageZoom(fresh,options,()=>{view=undefined;cancelClosing();});}
        catch(error){ctx.log.warn('ImageZoom inline inspection unavailable',error);}
      };
      if(options.hoverDelay>0)opening=setTimeout(open,options.hoverDelay);else open();
    };
    const move=(event:PointerEvent):void=>{
      point={x:event.clientX,y:event.clientY};if(!view)return;
      if(!(event.target instanceof Node)||!view.source.hitArea.contains(event.target))return;
      if(raf)return;raf=requestAnimationFrame(()=>{raf=0;view?.pointer(point.x,point.y);});
    };
    const out=(event:PointerEvent):void=>{
      const next=event.relatedTarget;
      if(next instanceof Node&&(view?.element.contains(next)||view?.source.hitArea.contains(next)||pending?.hitArea.contains(next)))return;
      scheduleClose();
    };
    const editing=(target:EventTarget|null):boolean=>target instanceof Element&&!!target.closest('input,textarea,[contenteditable]:not([contenteditable=false]),[role=textbox]');
    document.addEventListener('pointerover',over,{capture:true,signal:events.signal});
    document.addEventListener('pointerout',out,{capture:true,signal:events.signal});
    document.addEventListener('pointermove',move,{passive:true,signal:events.signal});
    document.addEventListener('wheel',event=>{
      if(!view||editing(event.target))return;
      if(!(event.target instanceof Node)||(!view.source.hitArea.contains(event.target)&&!view.element.contains(event.target)))return;
      if(view.wheel(event)){event.preventDefault();event.stopPropagation();}
    },{capture:true,passive:false,signal:events.signal});
    document.addEventListener('keydown',event=>{if(view&&!event.defaultPrevented&&view.key(event,editing(event.target))){event.preventDefault();event.stopPropagation();}},{capture:true,signal:events.signal});
    document.addEventListener('scroll',event=>{if(!(event.target instanceof Node&&view?.element.contains(event.target)))close();},{capture:true,passive:true,signal:events.signal});
    document.addEventListener('visibilitychange',()=>{if(document.hidden)close();},{signal:events.signal});
    window.addEventListener('blur',close,{signal:events.signal});window.addEventListener('resize',()=>view?.resize(),{signal:events.signal});
    window.addEventListener('popstate',close,{signal:events.signal});window.addEventListener('hashchange',close,{signal:events.signal});
    window.addEventListener(IMAGE_ZOOM_CHANGED,close,{signal:events.signal});
    // Reuse the existing shared dispatcher: no message/presence subscription,
    // polling, webpack patch, whole-page observer or per-image event handlers.
    const dispatcher=sharedDispatcher();
    try{dispatcher?.subscribe('CHANNEL_SELECT',close);dispatcher?.subscribe('LOGOUT',close);}catch{/* DOM lifecycle remains available. */}
    ctx.disposable(()=>{stopped=true;events.abort();close();try{dispatcher?.unsubscribe('CHANNEL_SELECT',close);dispatcher?.unsubscribe('LOGOUT',close);}catch{/* Native shutdown. */}});
  },
});
