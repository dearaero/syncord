import {definePluginSettings} from '../../api/plugin/settingsDef';
export const SPOTIFY_ID='spotify-controls',SPOTIFY_SETTINGS='Syncord-spotify-settings';
export const spotifySettings=definePluginSettings({
  island:{type:'boolean',default:true},hover:{type:'boolean',default:true},animation:{type:'boolean',default:true},cover:{type:'boolean',default:true},equalizer:{type:'boolean',default:true},speed:{type:'number',default:1},restart:{type:'boolean',default:true},
});
const handle=spotifySettings.bind(SPOTIFY_ID);
export type Options={island:boolean;hover:boolean;animation:boolean;cover:boolean;equalizer:boolean;speed:number;restart:boolean};
export function options():Options {const raw=handle.snapshot();return {island:raw.island!==false,hover:raw.hover!==false,animation:raw.animation!==false,cover:raw.cover!==false,equalizer:raw.equalizer!==false,speed:typeof raw.speed==='number'&&Number.isFinite(raw.speed)?Math.max(.5,Math.min(2,raw.speed)):1,restart:raw.restart!==false};}
export function setOption(key:keyof Options,value:boolean|number):void {
  const def=spotifySettings.schema[key];if(def.type!==typeof value)return;
  if(key==='speed')handle.set(key,Math.max(.5,Math.min(2,Number(value))));else handle.set(key,value as never);
  window.dispatchEvent(new Event(SPOTIFY_SETTINGS));
}
