export type LongRequest={accountId:string;channelId:string;text:string;limit?:number;valid:()=>boolean;send:(content:string,index:number,nonce:string)=>Promise<unknown>;delivered?:(remaining:string,count:number)=>void;settled?:(remaining:string,count:number)=>void;restore?:(remaining:string)=>boolean};
export type LongHandler=(request:LongRequest)=>Promise<void>|undefined;
let handler:LongHandler|undefined;
/** Explicit composer entry point: scheduled/background sends never enter this lane. */
export function registerLongMessages(next:LongHandler):()=>void{handler=next;return()=>{if(handler===next)handler=undefined;};}
export function offerLongMessage(request:LongRequest):Promise<void>|undefined{return handler?.(request);}

export function longMessagesEnabled():boolean{return handler!==undefined;}
