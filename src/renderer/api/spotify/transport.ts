import {beforeWebpackReady,type WebpackRequire} from '../../webpack';
import {object} from './model';
type Options={url:string;query?:Record<string,string|number|boolean>;[POST]?:boolean};
type Response={status?:number;body?:unknown};
type NativeCall=(account:string,credential:unknown,options:Options)=>Promise<Response>;
type Transport={get:NativeCall;put:NativeCall;post:boolean};
const POST=Symbol('syncord-native-spotify-post');
let transport:Transport|undefined,clients=0;
const listeners=new Set<()=>void>();
export function useSpotifyTransport():()=>void{clients++;return()=>{clients=Math.max(0,clients-1);};}
export function nativeSpotifyTransport():Transport|undefined{return transport;}
export function onSpotifyTransport(listener:()=>void):()=>void{listeners.add(listener);return()=>listeners.delete(listener);}
/** Marker stays in memory and is stripped before Discord's HTTP client sees it. */
export function postOptions(options:Options):Options{return {...options,[POST]:true};}
export function isSpotifyFactory(source:string):boolean{return ['PLAYER_DEVICES','SPOTIFY_SET_ACTIVE_DEVICE','onlyRetryOnAuthorizationErrors'].every(s=>source.includes(s));}
function capture(exports:unknown,post:boolean):void {
  for(const value of Object.values(object(exports))){const v=object(value);if(typeof v.get==='function'&&typeof v.put==='function'){transport={get:v.get as NativeCall,put:v.put as NativeCall,post};for(const listener of listeners)listener();return;}}
}
/** Scope the dependency adapter to Discord's existing Spotify request factory.
 * No factories are force-loaded, no source is evaluated and no global HTTP
 * method is changed. Native auth/refresh stays in Discord's original closure.
 */
beforeWebpackReady(req=>{
  const modules=req.m;if(!modules)return;
  const matches=Object.entries(modules).filter(([,factory])=>typeof factory==='function'&&isSpotifyFactory(Function.prototype.toString.call(factory)));
  if(matches.length!==1)return;
  const [id,original]=matches[0];if(!original)return;
  const cached=req.c?.[id];if(cached?.loaded){capture(cached.exports,false);return;}
  modules[id]=function(module,exports,nativeReq){
    // One-shot wrapper, restored as soon as the native module initializes.
    modules[id]=original;
    let supportsPost=false;
    const wrapped=new Proxy(nativeReq,{apply(target,thisArg,args){
      const loaded=Reflect.apply(target,thisArg,args) as unknown;if(!loaded||typeof loaded!=='object')return loaded;const record=object(loaded);
      return new Proxy(record,{get(obj,key,receiver){
        const value=Reflect.get(obj,key,receiver) as unknown,v=object(value);
        if(typeof v.get!=='function'||typeof v.put!=='function'||typeof v.post!=='function')return value;
        const http=v as {get:(o:Options)=>Promise<Response>;put:(o:Options)=>Promise<Response>;post:(o:Options)=>Promise<Response>};
        supportsPost=true;
        return new Proxy(http,{get(api,method){if(method!=='put')return Reflect.get(api,method);
          return (options:Options)=>{
            if(!options[POST])return api.put(options);
            // The only extra verb is Spotify's skip command. A tagged request
            // never falls through to PUT if the plugin has stopped.
            if(!clients||!['https://api.spotify.com/v1/me/player/next','https://api.spotify.com/v1/me/player/previous'].includes(options.url))return Promise.reject(Error('Unavailable playback command'));
            const clean={...options};delete clean[POST];
            return api.post(clean).then(response=>response.status===202?{...response,status:204}:response);
          };
        }});
      }});
    }}) as WebpackRequire;
    original(module,exports,wrapped);capture(object(module).exports??exports,supportsPost);
  };
});
