import {badgeImageData} from '../../api/ecosystem/art';
import {ecoBadgeImage,type BadgeArt} from '../../../shared/ecosystem';
const PATH:Record<BadgeArt,string>={spark:'m12 2 2.6 6.8L22 12l-7.4 3.2L12 22l-2.6-6.8L2 12l7.4-3.2L12 2Z',orbit:"M12 4a8 8 0 1 0 8 8h-2a6 6 0 1 1-6-6V4Zm5-2 1.5 3.5L22 7l-3.5 1.5L17 12l-1.5-3.5L12 7l3.5-1.5L17 2Z",shield:"m12 2 8 3v6c0 5-4 8.5-8 11-4-2.5-8-6-8-11V5l8-3Zm-1 13 6-6-1.4-1.4L11 12.2 8.4 9.6 7 11l4 4Z",compass:"M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm5 5-3 7-7 3 3-7 7-3Zm-5 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"};
const COLOR:Record<BadgeArt,string>={spark:'#ffca67',orbit:'#a5a0ff',shield:'#62dcb0',compass:'#70c7ff'};
export function ecosystemArt(art:BadgeArt,pixels=32,image?:string):string{if(!Object.hasOwn(PATH,art))return '';const n=Math.max(8,Math.min(64,pixels));if(imageId(image))return `<img alt="" width="${n}" height="${n}" data-syncord-badge-image="${imageId(image)}" src="${ecosystemArtUrl(art,image)}" referrerpolicy="no-referrer" style="object-fit:contain">`;return `<svg width="${n}" height="${n}" viewBox="0 0 24 24" aria-hidden="true" style="color:${COLOR[art]}"><path fill="currentColor" d="${PATH[art]}"/></svg>`;}

function imageId(image:unknown):string{try{return ecoBadgeImage(image)??'';}catch{return '';}}
/** Native profile badge images use the same artwork as the store. */
export function ecosystemArtUrl(art:BadgeArt,image?:string):string{
 const uploaded=badgeImageData(image);if(uploaded)return uploaded;
 const svg=ecosystemArt(art,32);return svg?'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg.replace('<svg ','<svg xmlns="http://www.w3.org/2000/svg" ')):'';
}
