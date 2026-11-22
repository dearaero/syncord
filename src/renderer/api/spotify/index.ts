import {findByStoreName,waitFor} from '../../webpack';
import {nativeSpotifyTransport,onSpotifyTransport,postOptions,useSpotifyTransport} from './transport';
import {applyPlayer,canControl,commandRequest,emptyPlayback,object,type Playback,type SpotifyCommand} from './model';
export * from './model';
type NativeSocket={accountId:string;accessToken?:unknown;isPremium?:boolean;socket?:EventTarget};
type NativeStore={hasConnectedAccount():boolean;getActiveSocketAndDevice():{socket:NativeSocket;device:unknown}|undefined;getPlayerState?(account:string):unknown;addChangeListener(listener:()=>void):void;removeChangeListener(listener:()=>void):void};
type Dispatcher={subscribe(event:string,listener:(event:unknown)=>void):void;unsubscribe(event:string,listener:(event:unknown)=>void):void};
export type SpotifySession={snapshot:()=>Playback;can:(kind:SpotifyCommand['kind'])=>boolean;command:(command:SpotifyCommand)=>Promise<void>;dispose:()=>void};
export function createSpotifySession(changed:()=>void):SpotifySession {
  let deviceIdentity='',state=emptyPlayback(),active=true,store:NativeStore|undefined,bound:EventTarget|undefined,account='',generation=0,refreshing=false,refreshGeneration=-1,refreshPending=false;
  const disposers:Array<()=>void>=[useSpotifyTransport()];
  const publish=(next:Playback):void=>{if(!active||Object.keys(next).every(key=>next[key as keyof Playback]===state[key as keyof Playback]))return;state=next;changed();};
  const current=()=>store?.getActiveSocketAndDevice();
  const apply=(value:unknown):void=>publish(applyPlayer(state,value));
  const message=(event:Event):void=>{
    const data=(event as MessageEvent<unknown>).data;if(typeof data!=='string'||data.length>2*1024*1024)return;
    try{const payload=object(JSON.parse(data));if(!Array.isArray(payload.payloads))return;
      for(const entry of payload.payloads){const events=object(entry).events;if(!Array.isArray(events))continue;for(const e of events){const row=object(e);if(row.type==='PLAYER_STATE_CHANGED')apply(object(row.event).state);}}
    }catch{/* Ignore non-player or malformed native socket payloads. */}
  };
  const can=(kind:SpotifyCommand['kind'])=>!!nativeSpotifyTransport()&&canControl(state,kind,nativeSpotifyTransport()?.post===true);
  /** All credential handling stays here, transiently in Discord's own adapter.
   * Plugins cannot supply URLs, headers, account IDs or credentials. Never log
   * native errors/responses: they can contain authenticated request metadata.
   */
  const request=async(command?:SpotifyCommand):Promise<unknown>=>{
    const native=current(),api=nativeSpotifyTransport();if(!active||!native||!api)throw Error('Unavailable playback');
    const call=command?commandRequest(command,state.track?.duration??0):{method:'get' as const,route:''};
    if(call.method==='post'&&!api.post)throw Error('Unavailable playback');
    const device=object(native.device),options={url:'https://api.spotify.com/v1/me/player'+(call.route?'/'+call.route:''),query:{...call.query,...(typeof device.id==='string'?{device_id:device.id}:{})},onlyRetryOnAuthorizationErrors:true};
    // No token is copied into playback state, persisted, logged or returned.
    const response=await api[call.method==='get'?'get':'put'](native.socket.accountId,native.socket.accessToken,call.method==='post'?postOptions(options):options);
    if(response.status!==undefined&&(response.status<200||response.status>=300))throw {status:response.status};
    return response.body;
  };
  const refresh=async():Promise<void>=>{
    if(!active||!current()||!nativeSpotifyTransport())return;
    if(refreshing){if(refreshGeneration!==generation)refreshPending=true;return;}
    refreshing=true;const version=generation;refreshGeneration=version;
    try{const body=await request();if(active&&version===generation&&body!==undefined)apply(body);}catch{/* Status remains native; a failed read is not a successful command. */}finally{refreshing=false;if(refreshPending&&active){refreshPending=false;void refresh();}}
  };
  const sync=():void=>{
    if(!active||!store)return;
    const native=current(),nextAccount=native?.socket.accountId??'';
    const nextDevice=object(native?.device).id;const deviceChanged=typeof nextDevice==='string'&&nextDevice!==deviceIdentity;
    if(nextAccount!==account){generation++;account=nextAccount;state=emptyPlayback();}else if(deviceChanged){generation++;state={...state,busy:false};}
    deviceIdentity=typeof nextDevice==='string'?nextDevice:'';
    const socket=native?.socket.socket;
    if(bound!==socket){bound?.removeEventListener('message',message);bound=socket;bound?.addEventListener('message',message);}
    const device=object(native?.device),connected=store.hasConnectedAccount();
    publish({...state,connected,deviceId:typeof device.id==='string'?device.id:'',restricted:device.is_restricted!==false,premium:native?.socket.isPremium===true,volumeSupported:device.supports_volume!==false&&typeof device.volume_percent==='number'});
    if(native&&state.track===null){const initial=object(store.getPlayerState?.(nextAccount));if(initial.track)apply({...initial,position:Math.max(0,Date.now()-Number(initial.startTime)),isPlaying:true,device});void refresh();}
    if(deviceChanged)void refresh();
    if(!connected&&state.track)publish({...emptyPlayback(),connected:false});
  };
  const attach=(value:unknown):void=>{
    const v=object(value);if(store||typeof v.getActiveSocketAndDevice!=='function'||typeof v.hasConnectedAccount!=='function'||typeof v.addChangeListener!=='function'||typeof v.removeChangeListener!=='function')return;
    store=v as unknown as NativeStore;store.addChangeListener(sync);disposers.push(()=>store?.removeChangeListener(sync));sync();
  };
  const dispatcher=window.Syncord?.common?.flux.FluxDispatcher as Dispatcher|undefined;
  const player=(value:unknown):void=>{const event=object(value);if(!account||event.accountId!==account)return;apply(event);};
  const reset=():void=>{generation++;account='';bound?.removeEventListener('message',message);bound=undefined;publish(emptyPlayback());};
  if(dispatcher?.subscribe&&dispatcher.unsubscribe){for(const [event,fn]of [['SPOTIFY_PLAYER_STATE',player],['SPOTIFY_SET_DEVICES',sync],['SPOTIFY_PROFILE_UPDATE',sync],['USER_CONNECTIONS_UPDATE',sync],['CONNECTION_OPEN',sync],['LOGOUT',reset]] as const){dispatcher.subscribe(event,fn);disposers.push(()=>dispatcher.unsubscribe(event,fn));}}
  attach(findByStoreName('SpotifyStore'));
  if(!store)disposers.push(waitFor(['getActiveSocketAndDevice','hasConnectedAccount'],attach));
  disposers.push(onSpotifyTransport(()=>{sync();void refresh();}));void refresh();
  return {snapshot:()=>({...state,track:state.track?{...state.track}:null,disallows:{...state.disallows}}),can,
    async command(command){
      if(!can(command.kind)){publish({...state,error:'unavailable'});return;}
      const version=generation;publish({...state,busy:true,error:'none'});
      try{await request(command);if(!active||version!==generation)return;await refresh();}
      catch(error){if(active&&version===generation){const status=object(error).status;publish({...state,error:status===429?'rate-limit':status===401||status===403?'denied':'failed'});}}
      finally{if(active&&version===generation)publish({...state,busy:false});}
    },
    dispose(){active=false;generation++;bound?.removeEventListener('message',message);bound=undefined;for(const dispose of disposers.reverse())dispose();state=emptyPlayback();}
  };
}
