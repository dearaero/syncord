import type {PluginContext} from './plugin';
export type IdentityPlatform='desktop'|'mobile'|'web'|'vr'|'console';
export type IdentitySnapshot={available:boolean;phase:'idle'|'armed'|'prepared'|'connected'|'failed'|'multiple'|'console';platform?:IdentityPlatform;busy?:boolean};
type NativeGateway={send:(...args:unknown[])=>unknown;close:()=>void;connect:()=>boolean;isClosed:()=>boolean;isSessionEstablished:()=>boolean;on:(event:string,fn:(event:unknown)=>void)=>void;removeListener:(event:string,fn:(event:unknown)=>void)=>void};
const listeners=new Set<()=>void>();
let occupied=false;
const object=(v:unknown):v is object=>v!==null&&typeof v==='object';
const emit=():void=>{for(const listener of [...listeners])try{listener();}catch{}}
export function onIdentityChange(fn:()=>void):()=>void{listeners.add(fn);return()=>{listeners.delete(fn);};}
const source=(fn:unknown):string=>typeof fn==='function'?Function.prototype.toString.call(fn):'';
/** Validate the loaded native gateway, not a raw WebSocket or a voice socket.
 * The native close/connect lifecycle owns session cleanup, backoff and Identify. */
export function isIdentityBuilder(value:unknown):value is NativeGateway{
 if(!object(value))return false;
 try{
  const v=value as Partial<NativeGateway>;
  return ['send','close','connect','isClosed','isSessionEstablished','on','removeListener'].every(k=>typeof (v as Record<string,unknown>)[k]==='function')&&
   ['pack','webSocket','isSessionEstablished'].every(s=>source(v.send).includes(s))&&
   ['isClosed','_cleanup','Disconnect requested by user'].every(s=>source(v.close).includes(s))&&
   ['isClosed','_connect','WILL_RECONNECT'].every(s=>source(v.connect).includes(s));
 }catch{return false;}
}
function resolveBuilder():NativeGateway|undefined{
 try{
  const common=window.Syncord?.common?.stores as Record<string,unknown>|undefined;
  const named=common?.GatewayConnectionStore??window.Syncord?.webpack?.findByStoreName('GatewayConnectionStore');
  const candidate=(object(named)&&typeof (named as {getSocket?:unknown}).getSocket==='function'?named:window.Syncord?.webpack?.findByProps('getSocket','isConnected')) as {getSocket?:()=>unknown}|undefined;
  const socket=candidate?.getSocket?.();return object(socket)?socket as NativeGateway:undefined;
 }catch{return undefined;}
}
/** Explicit platform fields; native locale and unrelated metadata are retained. */
function fields(platform:IdentityPlatform):Record<string,string>{
 switch(platform){
  case 'mobile':return {os:'iOS',browser:'Discord iOS',device:'iPhone',os_version:'',browser_user_agent:'Discord-iOS',browser_version:''};
  case 'vr':return {os:'Android',browser:'Discord VR',device:'Meta Quest',os_version:'',browser_user_agent:'Discord VR',browser_version:''};
  case 'web':return {browser:'Discord Web',device:''};
  default:return {browser:'Discord Client',device:''};
 }
}
/** One owner, one instance hook, one explicit native reconnect per request. */
export function attachIdentity(ctx:Pick<PluginContext,'plugin'|'permissions'|'patch'>,account:()=>string|undefined,allowed:()=>boolean,resolve=resolveBuilder,clock={set:(fn:()=>void,ms:number)=>window.setTimeout(fn,ms),clear:(id:number)=>window.clearTimeout(id),now:()=>Date.now()}){
 if(ctx.plugin.id!=='platform-spoofer'||!ctx.permissions.webpackPatch)throw Error('Platform identity capability denied');
 if(occupied)throw Error('Platform identity capability already active');occupied=true;
 let expected:string|undefined,selected:IdentityPlatform|undefined,disposed=false,builder:NativeGateway|undefined,undo:undefined|(()=>void),installed:unknown;
 let restoring=false;
 let timer=0,lastAttempt=-Infinity,pendingCleanup:undefined|(()=>void),generation=0;
 let state:IdentitySnapshot={available:false,phase:'idle'};
 const valid=():boolean=>!disposed&&allowed()&&!!expected&&account()===expected;
 const cancel=():void=>{generation++;clock.clear(timer);timer=0;pendingCleanup?.();pendingCleanup=undefined;};
 const unpatch=():void=>{undo?.();undo=undefined;installed=undefined;};
 const fail=():void=>{cancel();unpatch();selected=undefined;state={available:!!builder,phase:'failed',busy:false};emit();};
 function discover():boolean{
  if(disposed)return false;
  try{
   const raw=resolve(),current=raw===builder&&undo&&raw?.send===installed?raw:isIdentityBuilder(raw)?raw:undefined;
   if(current!==builder){cancel();unpatch();builder=current;expected=undefined;selected=undefined;state={available:!!builder,phase:'idle'};}
   return !!builder;
  }catch{return false;}
 }
 function install():boolean{
  if(!builder)return false;
  try{
   undo=ctx.patch.before(builder,'send',args=>{
    if(!valid()||!selected||args[0]!==2||!object(args[1]))return;
    // Treat the Identify body as opaque: never enumerate it or read auth fields.
    try{
     const slot=Object.getOwnPropertyDescriptor(args[1],'properties');
     if(!slot||!('value'in slot)||!slot.writable||!object(slot.value))throw Error('incompatible properties');
     const descriptors=Object.getOwnPropertyDescriptors(slot.value);
     for(const [key,value]of Object.entries(fields(selected)))descriptors[key]={value,enumerable:true,configurable:true,writable:true};
     const properties:unknown=Object.create(Object.getPrototypeOf(slot.value),descriptors);
     if(!valid())return;
     Object.defineProperty(args[1],'properties',{...slot,value:properties});
     state={...state,phase:'prepared',platform:selected};emit();
    }catch{fail();}
   });installed=builder.send;return true;
  }catch{fail();return false;}
 }
 function reconnect():boolean{
  if(!builder||!valid()||state.busy||clock.now()-lastAttempt<15000)return false;
  const target=builder,id=expected,version=++generation;
  try{if(!target.isSessionEstablished())return false;}catch{return false;}
  let started=false,detached=false,closeTimer=0;
  const cleanup=():void=>{target.removeListener('disconnect',disconnected);clock.clear(closeTimer);closeTimer=0;};
  const disconnected=(event:unknown):void=>{
   const reason=object(event)?Object.getOwnPropertyDescriptor(event,'reason')?.value:undefined;
   if(reason!=='Disconnect requested by user')return;
   cleanup();pendingCleanup=undefined;
   // Native close schedules its disconnect/reset. Wait for that callback to
   // finish before connect; otherwise its delayed reset can erase a new session.
   queueMicrotask(()=>{
    if(account()!==id||!allowed())return;
    // If disabled during native close, finish the user's already-started
    // reconnect with the hook removed, so Discord is not left disconnected.
    if(!detached&&(version!==generation||!valid()||expected!==id))return;
    try{if(target.isClosed()&&target.connect()===false&&!detached)fail();}catch{if(!detached)fail();}
   });
  };
  try{
   target.on('disconnect',disconnected);pendingCleanup=()=>{detached=true;};
   // Even an incompatible native close cannot retain the one-shot waiter.
   closeTimer=clock.set(()=>{cleanup();pendingCleanup=undefined;if(!detached)fail();},5000);
   lastAttempt=clock.now();state={...state,phase:'armed',busy:true};
   timer=clock.set(()=>{if(version===generation)fail();},30000);
   started=true;target.close();emit();return true;
  }catch{cleanup();pendingCleanup=undefined;if(started){try{if(target.isClosed())target.connect();}catch{}}fail();return false;}
 }
 return{
  snapshot:():IdentitySnapshot=>{const available=discover()&&!!account()&&allowed();return {...state,available};},
  request(values:IdentityPlatform[],id:string):boolean{
   if(disposed||state.busy||!allowed()||account()!==id||!/^\d{17,20}$/.test(id)||!discover())return false;
   if(values.length!==1){cancel();unpatch();expected=undefined;selected=undefined;state={available:true,phase:values.length?'multiple':'idle'};emit();return false;}
   if(values[0]==='console'){cancel();unpatch();expected=undefined;selected=undefined;state={available:true,phase:'console'};emit();return false;}
   if(!['desktop','mobile','web','vr'].includes(values[0]))return false;
   if(clock.now()-lastAttempt<15000){state={...state,phase:'failed'};emit();return false;}
   cancel();unpatch();restoring=false;expected=id;selected=values[0];
   if(!install()||!reconnect()){fail();return false;}return true;
  },
  connected():void{
   if(!valid()||(!state.busy&&state.phase!=='prepared'))return;
   // READY must follow an actual Identify send, not merely a resumed connection.
   const prepared=restoring||state.phase==='prepared';cancel();state={...state,phase:prepared?'connected':'failed',busy:false};if(!prepared)unpatch();restoring=false;emit();
  },
  restore(id:string):boolean{
   if(disposed||state.busy||!allowed()||account()!==id||!discover()||clock.now()-lastAttempt<15000)return false;
   cancel();unpatch();restoring=true;expected=id;selected=undefined;state={available:true,phase:'idle'};
   return reconnect();
  },
  clear():void{cancel();unpatch();expected=undefined;selected=undefined;state={available:false,phase:'idle'};},
  dispose():void{if(disposed)return;disposed=true;cancel();unpatch();expected=undefined;selected=undefined;builder=undefined;state={available:false,phase:'idle'};occupied=false;},
 };
}
