import {ecoBadgeImage,MAX_BADGE_SVG_BYTES} from '../../../shared/ecosystem';
export type BadgeImageResolver=(image:string)=>Promise<string>;
const cache=new Map<string,string>(),pending=new Map<string,Promise<string>>();
const failures=new Map<string,number>();
let lane:Promise<unknown>=Promise.resolve();
export function badgeImageData(image:unknown):string{try{const id=ecoBadgeImage(image);return id?cache.get(id)??'':'';}catch{return '';}}
/** The native bridge returns bounded image data, never executable DOM markup. */
export function loadBadgeImage(image:string,resolve:BadgeImageResolver):Promise<string>{
 try{if(!ecoBadgeImage(image))return Promise.reject(Error('Invalid badge image.'));}catch(error){return Promise.reject(error);}
 const failed=failures.get(image);if(failed&&failed>Date.now())return Promise.reject(Error('Badge image unavailable.'));failures.delete(image);
 const cached=cache.get(image);if(cached)return Promise.resolve(cached);
 const existing=pending.get(image);if(existing)return existing;
 if(pending.size>=512)return Promise.reject(Error('Too many pending badge images.'));
 const work=lane.then(async()=>{
  const data=await resolve(image);
  const png=image.startsWith('png:'),prefix=png?'data:image/png;base64,':'data:image/svg+xml;base64,',max=png?65536:MAX_BADGE_SVG_BYTES;
  if(typeof data!=='string'||data.length>prefix.length+4*Math.ceil(max/3)||!data.startsWith(prefix)||data.length<=prefix.length)throw Error('Invalid badge image data.');
  const encoded=data.slice(prefix.length);if(encoded.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw Error('Invalid badge image data.');
  const bytes=encoded.length/4*3-(encoded.endsWith('==')?2:encoded.endsWith('=')?1:0);if(bytes>max)throw Error('Invalid badge image data.');
  cache.set(image,data);while(cache.size>64){const oldest=cache.keys().next();if(oldest.done)break;cache.delete(oldest.value);}return data;
 });
 pending.set(image,work);lane=work.catch(()=>{});
 void work.catch(()=>{failures.delete(image);failures.set(image,Date.now()+30000);while(failures.size>512){const oldest=failures.keys().next();if(oldest.done)break;failures.delete(oldest.value);}}).finally(()=>pending.delete(image));return work;
}
