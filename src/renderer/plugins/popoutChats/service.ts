/** Integration point shared by native menus and MultiChat; no Canvas state crosses it. */
const listeners=new Set<()=>void>();
export function onPopoutAvailabilityChange(listener:()=>void):()=>void {listeners.add(listener);return()=>listeners.delete(listener);}
const notify=():void=>{for(const listener of listeners)listener();};
let opener:((channelId:string)=>void)|undefined;
export function registerPopoutOpener(open:(channelId:string)=>void):()=>void {
  opener=open;notify();return()=>{if(opener===open){opener=undefined;notify();}};
}
export function popoutsAvailable():boolean{return Boolean(opener);}
export function openChatPopout(channelId:string):void {opener?.(channelId);}
