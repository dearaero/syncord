import {emptyPlayback,type Playback} from '../../api/spotify/model';
let playback=emptyPlayback(),running=false,openPlayer:(()=>void)|undefined;
const listeners=new Set<()=>void>();
export const spotifyStatus=()=>({running,playback});
export function publishSpotify(value:Playback,enabled:boolean):void{playback=value;running=enabled;for(const listener of listeners)listener();}
export function onSpotifyStatus(listener:()=>void):()=>void{listeners.add(listener);return()=>listeners.delete(listener);}
export function registerSpotifyPlayer(open:()=>void):()=>void{openPlayer=open;return()=>{if(openPlayer===open)openPlayer=undefined;};}
export const showSpotifyPlayer=():void=>openPlayer?.();
