import type {NetworkStatistics} from '../../shared/statistics';
const record=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'?v as Record<string,unknown>:{};
const bytes=(v:unknown):number=>typeof v==='number'&&Number.isFinite(v)&&v>=0?Math.min(Number.MAX_SAFE_INTEGER,Math.floor(v)):0;
const add=(a:number,b:number):number=>Math.min(Number.MAX_SAFE_INTEGER,a+b);
/** Only IDs and integer sizes survive a protocol event. One ledger per observed target. */
export class TrafficLedger {
 readonly totals={httpReceived:0,httpSubmitted:0,wsReceived:0,wsSent:0,requests:0,failed:0,cached:0,framesReceived:0,framesSent:0,droppedRequests:0,unknownUploads:0};
 private requests=new Map<string,{received:number;cached:boolean}>();private sockets=new Set<string>();
 constructor(private readonly limit=2048){}
 event(method:string,raw:unknown):void {
  const p=record(raw),id=typeof p.requestId==='string'?p.requestId:'';
  if(method==='Network.requestWillBeSent'&&id){
   const previous=this.requests.get(id);if(previous){this.finish(previous,record(p.redirectResponse).encodedDataLength);this.requests.delete(id);}
   if(this.requests.size>=this.limit){const key=this.requests.keys().next().value;if(key!==undefined)this.requests.delete(key);this.totals.droppedRequests++;}
   this.requests.set(id,{received:0,cached:false});this.totals.requests++;return;
  }
  const row=this.requests.get(id);
  if(method==='Network.requestServedFromCache'&&row){this.cache(row);return;}
  if(method==='Network.responseReceived'&&row){const r=record(p.response);if(r.fromDiskCache===true||r.fromServiceWorker===true||r.fromPrefetchCache===true)this.cache(row);return;}
  if(method==='Network.dataReceived'&&row&&!row.cached){const size=bytes(p.encodedDataLength);row.received=add(row.received,size);this.totals.httpReceived=add(this.totals.httpReceived,size);return;}
  if(method==='Network.loadingFinished'&&row){this.finish(row,p.encodedDataLength);this.requests.delete(id);return;}
  if(method==='Network.loadingFailed'&&row){this.requests.delete(id);this.totals.failed++;return;}
  if(method==='Network.webSocketCreated'&&id){if(this.sockets.size<this.limit)this.sockets.add(id);else this.totals.droppedRequests++;return;}
  if(method==='Network.webSocketClosed'){this.sockets.delete(id);return;}
  if(method==='Network.webSocketFrameSent'||method==='Network.webSocketFrameReceived'){
   const frame=record(p.response),payload=frame.payloadData;if(typeof payload!=='string')return;
   // Binary frames are base64. Calculate length without decoding or retaining data.
   const size=frame.opcode===1?Buffer.byteLength(payload,'utf8'):Math.max(0,Math.floor(payload.length*3/4)-(payload.endsWith('==')?2:payload.endsWith('=')?1:0));
   const incoming=method==='Network.webSocketFrameReceived';this.totals[incoming?'wsReceived':'wsSent']=add(this.totals[incoming?'wsReceived':'wsSent'],size);this.totals[incoming?'framesReceived':'framesSent']++;
  }
 }
 upload(size:number,unknown=0):void {this.totals.httpSubmitted=add(this.totals.httpSubmitted,bytes(size));this.totals.unknownUploads+=bytes(unknown);}
 clearPending():void {this.requests.clear();this.sockets.clear();}
 get activeRequests():number{return this.requests.size;}
 get activeSockets():number{return this.sockets.size;}
 private cache(row:{received:number;cached:boolean}):void {if(row.cached)return;row.cached=true;this.totals.cached++;this.totals.httpReceived=Math.max(0,this.totals.httpReceived-row.received);row.received=0;}
 private finish(row:{received:number;cached:boolean},total:unknown):void {if(!row.cached)this.totals.httpReceived=add(this.totals.httpReceived,Math.max(0,bytes(total)-row.received));}
}
export function sumTraffic(ledgers:Iterable<TrafficLedger>,since:number,activeTargets:number,unavailableTargets:number,gaps:number):NetworkStatistics {
 const result:NetworkStatistics={since,httpReceived:0,httpSubmitted:0,wsReceived:0,wsSent:0,requests:0,failed:0,cached:0,activeRequests:0,framesReceived:0,framesSent:0,activeSockets:0,activeTargets,unavailableTargets,gaps,droppedRequests:0,unknownUploads:0};
 for(const ledger of ledgers){for(const key of Object.keys(ledger.totals) as (keyof TrafficLedger['totals'])[])result[key]=add(result[key],ledger.totals[key]);result.activeRequests+=ledger.activeRequests;result.activeSockets+=ledger.activeSockets;}return result;
}
