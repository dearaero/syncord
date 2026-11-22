import {app,webContents,type WebContents} from 'electron';
import fs from 'node:fs/promises';
import {isTrustedDiscordOrigin} from '../../security/origins';
import {TrafficLedger,sumTraffic} from './traffic';
const since=Date.now(),retired=new TrafficLedger();
const NETWORK_OPTIONS={maxTotalBufferSize:1,maxResourceBufferSize:1,maxPostDataSize:1};
const METADATA_EPOCH_REQUESTS=512;
type Target={wc:WebContents;ledger:TrafficLedger;owned:boolean;active:boolean;token:number;blocked:boolean;dispose():void};
const targets=new Map<number,Target>();let gaps=0,installed=false,uploads=0;
function trusted(url:string):boolean {try{return isTrustedDiscordOrigin(new URL(url));}catch{return false;}}
function watch(wc:WebContents):void {
 if(wc.isDestroyed()||targets.size>=128)return;
 // Electron's debugger getter throws once WebContents is destroyed. Keep the
 // live handle and ID so the destroyed-event cleanup never reads that getter.
 const id=wc.id,debuggerHandle=wc.debugger;if(targets.has(id)||!debuggerHandle)return;
 let disposed=false,epochRequests=0,compacting=false;
 const target:Target={wc,ledger:new TrafficLedger(),owned:false,active:false,token:0,blocked:false,dispose:()=>{}};targets.set(id,target);
 const stop=():void=>{target.token++;epochRequests=0;compacting=false;target.active=false;target.ledger.clearPending();if(target.owned){target.owned=false;try{if(!wc.isDestroyed())debuggerHandle.detach();}catch{/* Already detached by DevTools or destruction. */}}};
 const attach=(url:string):void=>{
  if(disposed)return;
  if(wc.isDestroyed()||!trusted(url)){stop();return;}if(target.owned)return;
  if(wc.isDevToolsOpened()||debuggerHandle.isAttached()){if(!target.blocked)gaps++;target.blocked=true;return;}
  const token=++target.token;
  try{debuggerHandle.attach('1.3');target.owned=true;target.blocked=false;
   // Chromium treats maxPostDataSize=0 as UNLIMITED, not disabled. A positive
   // one-byte cap avoids serializing upload bodies into protocol events. Body
   // buffers are also capped; no response/post body retrieval is performed.
   void debuggerHandle.sendCommand('Network.enable',NETWORK_OPTIONS).then(()=>{if(target.token===token&&target.owned)target.active=true;},()=>{if(target.token===token){gaps++;target.blocked=true;stop();}});
  }catch{gaps++;target.blocked=true;}
 };
 const start=():void=>{if(!disposed&&!wc.isDestroyed())attach(wc.getURL());};
 const message=(_event:unknown,method:string,params:unknown):void=>{
  if(!target.owned)return;target.ledger.event(method,params);
  if(method==='Network.requestWillBeSent')epochRequests++;
  if(epochRequests<METADATA_EPOCH_REQUESTS||target.ledger.activeRequests||!target.active||compacting)return;
  // Chromium's body limits do NOT bound its ResourceData map (URLs, headers,
  // timing metadata). Clear the inspector at HTTP idle, without detaching the
  // debugger or touching actual connections, stores, requests or the ledger.
  const token=target.token;epochRequests=0;compacting=true;target.active=false;gaps++;
  const current=():boolean=>!disposed&&target.owned&&target.token===token&&!wc.isDestroyed();
  void Promise.resolve().then(()=>{if(current())return debuggerHandle.sendCommand('Network.disable');}).then(async()=>{
   if(!current())return;
   await debuggerHandle.sendCommand('Network.enable',NETWORK_OPTIONS);
   if(current())target.active=true;
  }).catch(()=>{if(current()){target.blocked=true;stop();}}).finally(()=>{if(target.token===token)compacting=false;});
 };
 const detached=():void=>{if(target.owned){gaps++;target.blocked=true;}target.owned=false;target.active=false;target.token++;epochRequests=0;compacting=false;target.ledger.clearPending();};
 const navigate=(_event:unknown,url:string,_inPlace:boolean,main:boolean):void=>{if(main){if(trusted(url))attach(url);else stop();}};
 const dispose=():void=>{
  // Detach may synchronously trigger destruction during app shutdown. Retire
  // this target before detaching so nested cleanup cannot count it twice.
  if(disposed)return;disposed=true;targets.delete(id);
  stop();for(const key of Object.keys(retired.totals) as (keyof TrafficLedger['totals'])[])retired.totals[key]=Math.min(Number.MAX_SAFE_INTEGER,retired.totals[key]+target.ledger.totals[key]);
  debuggerHandle.removeListener('message',message);debuggerHandle.removeListener('detach',detached);wc.removeListener('did-start-navigation',navigate);wc.removeListener('dom-ready',start);wc.removeListener('devtools-closed',start);wc.removeListener('destroyed',dispose);
 };
 target.dispose=dispose;debuggerHandle.on('message',message);debuggerHandle.on('detach',detached);wc.on('did-start-navigation',navigate);wc.on('dom-ready',start);wc.on('devtools-closed',start);wc.once('destroyed',dispose);start();
}
/** Does not take over an existing debugger or replace any webRequest listener. */
export function installStatisticsNetwork():void {
 if(installed)return;installed=true;app.on('web-contents-created',(_event,wc)=>watch(wc));
 void app.whenReady().then(()=>{for(const wc of webContents?.getAllWebContents?.()??[])watch(wc);}).catch(()=>{});
 app.on('will-quit',()=>{for(const target of [...targets.values()])target.dispose();});
}
/** Called inside the existing privacy webRequest hook, after its cancel decision. */
export function measureSubmittedUpload(webContentsId:number|undefined,data:Electron.UploadData[]|undefined):void {
 const target=typeof webContentsId==='number'?targets.get(webContentsId):undefined;if(!target?.owned||!data?.length)return;
 let size=0,unknown=0;
 for(const item of data.slice(0,64)){
  if(item.bytes?.byteLength){size+=item.bytes.byteLength;continue;}
  if(item.file&&uploads<32){uploads++;void fs.stat(item.file).then(stat=>{retired.upload(stat.isFile()?stat.size:0,stat.isFile()?0:1);},()=>retired.upload(0,1)).finally(()=>{uploads--;});}
  else unknown++;
 }
 retired.upload(size,unknown+Math.max(0,data.length-64));
}
export function networkStatistics():ReturnType<typeof sumTraffic>{
 const all=[...targets.values()];return sumTraffic([retired,...all.map(t=>t.ledger)],since,all.filter(t=>t.active).length,all.filter(t=>!t.active&&!t.wc.isDestroyed()&&trusted(t.wc.getURL())).length,gaps);
}
