import { canonicalMessage as i18nText } from "../../i18n";
import { mediaUrl, originalUrl, isGif } from './model';
export type HoverImage = {element: HTMLImageElement | HTMLVideoElement; hitArea: Element; preview:string; original:string; name:string; gif:boolean};
const IMAGE_CONTAINER='.imageWrapper,[class*="imageWrapper_"],[class*="imageContainer_"],[class*="embedImage_"],[class*="embedThumbnail_"],[class*="mosaicItem_"],[data-mc-pane],.dion-log-preview-media';
export function hoverImage(target: EventTarget|null, avatars: boolean): HoverImage | undefined {
  if (!(target instanceof Element) || target.closest('#Syncord-image-zoom,[data-spoiler-hidden="true"]')) return;
  // Discord leaves spoiler images mounted. Never reveal one through its blur.
  for(let node:Element|null=target,depth=0;node&&depth<8;node=node.parentElement,depth++) {
    const classes=node.getAttribute('class')??'';
    if (/hiddenSpoiler|spoilerHidden/i.test(classes) || (/spoiler/i.test(classes)&&/(?:^|\s)hidden(?:_|$)/i.test(classes))) return;
  }
  // Discord's data-role=img anchor is a sibling overlay, not an img ancestor.
  const wrapper=target.closest('.imageWrapper,[class*="imageWrapper_"]');
  const element=target.closest('img,video')??wrapper?.querySelector('img,video');
  if (!(element instanceof HTMLImageElement || element instanceof HTMLVideoElement)) return;
  const avatar=!!element.closest('[class*="avatar_"],[class*="avatarWrapper_"],[data-list-item-id^="guildsnav"]') || /\/(?:avatars|icons)\//.test(element.getAttribute('src')??'');
  if (element.closest('[class*="emoji"],[class*="badge"],[class*="sticker"]') || (avatar && !avatars)) return;
  const anchor=element.closest<HTMLAnchorElement>('a[href]')??wrapper?.querySelector<HTMLAnchorElement>('a[data-role=img][href]');
  const preview=(element instanceof HTMLVideoElement&&mediaUrl(element.poster,location.href))||mediaUrl((element instanceof HTMLImageElement&&!element.complete?element.getAttribute('src'):element.currentSrc)||element.getAttribute('src')||'',location.href);
  if (!preview) return;
  const attachment=/\/(?:attachments|ephemeral-attachments|external)\//.test(new URL(preview,location.href).pathname);
  if (!avatar && !attachment && !element.closest(IMAGE_CONTAINER)) return;
  const name=(element instanceof HTMLImageElement ? element.alt : '') || anchor?.getAttribute('download') || new URL(preview,location.href).pathname.split('/').pop() || i18nText("ui.image");
  const original=originalUrl(preview,anchor?.href,location.href)??preview;
  const gif=isGif(original,name);
  if (element instanceof HTMLVideoElement && !gif) return;
  // Avatars/embeds without an imageWrapper need an equally bounded native
 // parent. Never turn a whole message/sidebar into an image viewport.
 let hitArea=wrapper;
 if(!hitArea){const parent=element.parentElement,r=element.getBoundingClientRect(),p=parent?.getBoundingClientRect();
  if(parent&&p&&Math.abs(p.width-r.width)<3&&Math.abs(p.height-r.height)<3)hitArea=parent;
 }
 if(!(hitArea instanceof HTMLElement)||element.getBoundingClientRect().width<=0)return;
 return {element,hitArea,preview,original,name:name.slice(0,180),gif};
}
