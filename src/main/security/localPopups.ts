/** One-use main-owned blank documents for native UI mounted by its existing opener. */
import type {BrowserWindowConstructorOptions,WebContents,WindowOpenHandlerResponse} from 'electron';
type Lease={name:string;expires:number;create:(options:BrowserWindowConstructorOptions)=>WebContents};
const leases=new WeakMap<WebContents,Lease>();
const dispatchers=new WeakSet<WebContents>();
/** Discord may replace its own window handler after BrowserWindow construction.
 * Preserve its latest handler while keeping the one-use native UI route ahead of it.
 * This is instance-local; no Electron/global prototype is patched.
 */
export function installLocalPopupDispatcher(owner:WebContents):void{
  if(dispatchers.has(owner))return;dispatchers.add(owner);
  const setter=owner.setWindowOpenHandler;
  owner.setWindowOpenHandler=function(handler){return setter.call(this,details=>consumeLocalPopup(owner,details)??handler(details));};
  owner.once('destroyed',()=>{owner.setWindowOpenHandler=setter;dispatchers.delete(owner);});
}
export function leaseLocalPopup(owner:WebContents,name:string,create:Lease['create']):()=>void{
  const lease={name,create,expires:Date.now()+3000};leases.set(owner,lease);
  const timer=setTimeout(()=>{if(leases.get(owner)===lease)leases.delete(owner);},3000);timer.unref();
  return ()=>{clearTimeout(timer);if(leases.get(owner)===lease)leases.delete(owner);};
}
export function consumeLocalPopup(owner:WebContents,details:{url:string;frameName:string}):WindowOpenHandlerResponse|undefined{
  const lease=leases.get(owner);
  if(!lease||details.url!=='about:blank'||details.frameName!==lease.name)return;
  leases.delete(owner);
  if(Date.now()>lease.expires)return {action:'deny'};
  // createWindow bypasses did-create-window. The creating capability owns all
  // child hardening; ordinary blank/data popups still fail the normal policy.
  return {action:'allow',createWindow:lease.create};
}
