const MEDIA_HOSTS = new Set(['cdn.discordapp.com','media.discordapp.net','images-ext-1.discordapp.net','images-ext-2.discordapp.net','media.tenor.com','c.tenor.com','media.giphy.com','i.giphy.com']);
export function mediaUrl(raw: string, base: string): string | undefined {
  try {
    const url = new URL(raw,base);
    if (url.protocol === 'blob:' && url.origin === new URL(base).origin) return url.href;
    if (/^data:image\/(?:png|jpeg|gif|webp|avif|bmp);/i.test(raw)) return raw;
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return;
    if (MEDIA_HOSTS.has(url.hostname)) return url.href;
  } catch { /* Not an image source that this viewer supports. */ }
}
export function originalUrl(preview: string, link: string | undefined, base: string): string | undefined {
  const safe = mediaUrl(preview,base);
  if (!safe) return;
  let selected = safe;
  const original = link && mediaUrl(link,base);
  if (original && /\.(?:png|jpe?g|gif|webp|avif|bmp)(?:$|[?#])/i.test(original)) selected = original;
  const url = new URL(selected,base);
  if (url.protocol !== 'https:') return selected;
  if (url.hostname === 'cdn.discordapp.com' || url.hostname.endsWith('.discordapp.net')) {
    for (const key of ['width','height','quality','format']) url.searchParams.delete(key);
    if (url.hostname === 'media.discordapp.net' && /^\/(?:attachments|ephemeral-attachments)\//.test(url.pathname)) url.hostname = 'cdn.discordapp.com';
    if (/^\/(?:avatars|icons|banners|guilds)\//.test(url.pathname)) url.searchParams.set('size','4096');
  }
  return url.href;
}
export const isGif = (url: string, name=''): boolean => /\.gif(?:$|[?#])/i.test(url) || /\.gif$/i.test(name);
export function keyMatches(binding: string, key: string, code: string): boolean {
  return binding.split(',').some(raw => {
    const value=raw.trim().toLowerCase();
    if (!value) return false;
    return value === key.toLowerCase() || value === code.toLowerCase() || (value === 'space' && key === ' ');
  });
}
export function modifierMatches(modifier: string, event: Pick<WheelEvent,'altKey'|'shiftKey'|'ctrlKey'|'metaKey'>): boolean {
  const pressed={alt:event.altKey,shift:event.shiftKey,ctrl:event.ctrlKey,meta:event.metaKey};
  if (modifier === 'none') return !Object.values(pressed).some(Boolean);
  return pressed[modifier as keyof typeof pressed] === true && Object.entries(pressed).every(([key,on])=>key===modifier || !on);
}
export function wheelSteps(delta: number, mode: number): number {
  return Math.min(4,Math.max(-4,delta*(mode===1?16:mode===2?400:1)/100));
}
/** Scale the native image box while keeping pan inside its original bounds. */
export function inlineTransform(width:number,height:number,zoom:number,px:number,py:number):{x:number;y:number} {
  const at=(v:number):number=>Math.max(0,Math.min(1,v));
  return {x:zoom>1?-(width*(zoom-1))*at(px):width*(1-zoom)/2,y:zoom>1?-(height*(zoom-1))*at(py):height*(1-zoom)/2};
}
