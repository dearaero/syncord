/** Public playback data only. Never retain a native socket/account object. */
export type RepeatMode='off'|'context'|'track';
export type SpotifyCommand={kind:'play'|'pause'|'next'|'previous'}|{kind:'seek';value:number}|{kind:'volume';value:number}|{kind:'shuffle';value:boolean}|{kind:'repeat';value:RepeatMode};
export type Track={id:string;type:'track'|'episode';name:string;artist:string;cover:string;duration:number};
export type Playback={connected:boolean;deviceId:string;playing:boolean;track:Track|null;position:number;observedAt:number;volume:number;shuffle:boolean|null;repeat:RepeatMode|null;restricted:boolean;premium:boolean;volumeSupported:boolean;disallows:Record<string,boolean>;busy:boolean;error:'none'|'unavailable'|'denied'|'failed'|'rate-limit'};
export const emptyPlayback=():Playback=>({connected:false,deviceId:'',playing:false,track:null,position:0,observedAt:Date.now(),volume:0,shuffle:null,repeat:null,restricted:true,premium:false,volumeSupported:false,disallows:{},busy:false,error:'none'});
export const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'?v as Record<string,unknown>:{};
const finite=(v:unknown,fallback=0):number=>typeof v==='number'&&Number.isFinite(v)?v:fallback;
const text=(v:unknown):string=>typeof v==='string'?v.slice(0,400):'';
export function coverUrl(v:unknown):string {
  if(typeof v!=='string')return '';
  try{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&['i.scdn.co','mosaic.scdn.co'].includes(u.hostname)?u.href:'';}catch{return '';}
}
export function trackFrom(value:unknown):Track|null {
  const v=object(value);if(typeof v.name!=='string')return null;
  const album=object(v.album),images=Array.isArray(album.images)?album.images:[],image=object(album.image??images[0]);
  const artists=Array.isArray(v.artists)?v.artists:[];
  return {id:text(v.id),type:v.type==='episode'?'episode':'track',name:text(v.name),artist:artists.map(a=>text(object(a).name)).filter(Boolean).slice(0,8).join(', '),cover:coverUrl(image.url),duration:Math.max(0,finite(v.duration_ms,finite(v.duration)))};
}
export function positionAt(state:Playback,now=Date.now()):number {return Math.min(state.track?.duration??0,Math.max(0,state.position+(state.playing?Math.max(0,now-state.observedAt):0)));}
export function applyPlayer(state:Playback,value:unknown,now=Date.now()):Playback {
  const v=object(value),raw='item'in v,track=trackFrom(raw?v.item:v.track),device=object(v.device),actions=object(object(v.actions).disallows),disallows:Record<string,boolean>={};
  for(const [k,x]of Object.entries(actions))if(typeof x==='boolean')disallows[k]=x;
  const repeat=raw?v.repeat_state:v.actual_repeat,shuffle=raw?v.shuffle_state:v.shuffle;
  return {...state,track,playing:(raw?v.is_playing:v.isPlaying)===true,position:Math.max(0,finite(raw?v.progress_ms:v.position)),observedAt:now,volume:Math.max(0,Math.min(100,finite(raw?device.volume_percent:v.volumePercent,state.volume))),
    deviceId:typeof device.id==='string'?device.id:state.deviceId,restricted:typeof device.is_restricted==='boolean'?device.is_restricted:state.restricted,volumeSupported:typeof device.supports_volume==='boolean'?device.supports_volume:state.volumeSupported,
    repeat:repeat==='off'||repeat==='context'||repeat==='track'?repeat:(track?.id===state.track?.id?state.repeat:null),shuffle:typeof shuffle==='boolean'?shuffle:(track?.id===state.track?.id?state.shuffle:null),disallows:raw?disallows:state.disallows,error:'none'};
}
export function commandRequest(c:SpotifyCommand,duration:number):{method:'get'|'put'|'post';route:string;query?:Record<string,string|number|boolean>} {
  switch(c.kind){
    case'play':case'pause':return {method:'put',route:c.kind};
    case'next':case'previous':return {method:'post',route:c.kind};
    case'seek':if(!Number.isFinite(c.value)||c.value<0||c.value>duration)break;return {method:'put',route:'seek',query:{position_ms:Math.round(c.value)}};
    case'volume':if(!Number.isFinite(c.value)||c.value<0||c.value>100)break;return {method:'put',route:'volume',query:{volume_percent:Math.round(c.value)}};
    case'shuffle':if(typeof c.value!=='boolean')break;return {method:'put',route:'shuffle',query:{state:c.value}};
    case'repeat':if(!['off','context','track'].includes(c.value))break;return {method:'put',route:'repeat',query:{state:c.value}};
  }
  throw Error('Invalid playback command');
}
export function canControl(s:Playback,kind:SpotifyCommand['kind'],post:boolean):boolean {
  if(!s.connected||!s.track||!s.deviceId||s.restricted||!s.premium||s.busy)return false;
  const blocked:Partial<Record<SpotifyCommand['kind'],string>>={play:'resuming',pause:'pausing',next:'skipping_next',previous:'skipping_prev',seek:'seeking',shuffle:'toggling_shuffle',repeat:s.repeat==='context'?'toggling_repeat_track':'toggling_repeat_context'};
  return !s.disallows[blocked[kind]??'']&&(!(kind==='next'||kind==='previous')||post)&&(kind!=='volume'||s.volumeSupported)&&(kind!=='shuffle'||s.shuffle!==null)&&(kind!=='repeat'||s.repeat!==null);
}
export function spotifyLink(t:Track|null):string|null{return t&&/^[A-Za-z0-9]{22}$/.test(t.id)?`https://open.spotify.com/${t.type}/${t.id}`:null;}
