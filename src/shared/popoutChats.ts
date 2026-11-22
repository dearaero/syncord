/** Local, main-owned chat windows. No arbitrary method, URL, path or channel routing. */
export const POPOUT_BASE_URL = "syncord-chat://local";
export const POPOUT_ARGUMENT = "--syncord-chat-window";
export const POPOUT_IPC = {
  CONNECT:"Syncord_POPOUT_CONNECT", OPEN:"Syncord_POPOUT_OPEN", STOP:"Syncord_POPOUT_STOP",
  PUBLISH:"Syncord_POPOUT_PUBLISH", EVENT:"Syncord_POPOUT_EVENT",
  INIT:"Syncord_POPOUT_INIT", ACTION:"Syncord_POPOUT_ACTION", STATE:"Syncord_POPOUT_STATE",
} as const;
// Exact public-media hosts used by Discord's native GIF picker (Klipy plus
// existing Tenor/Giphy favorites). No API hosts, wildcard or credential path.
export const POPOUT_MEDIA_HOSTS = ['cdn.discordapp.com','media.discordapp.net','images-ext-1.discordapp.net','images-ext-2.discordapp.net','media.tenor.com','c.tenor.com','media.tenor.co','static.klipy.com','media.giphy.com','i.giphy.com'] as const;
export function isPopoutAsset(raw:string):boolean {
  try{const url=new URL(raw);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&(POPOUT_MEDIA_HOSTS as readonly string[]).includes(url.hostname);}catch{return false;}
}
export type ChatBounds = {x:number;y:number;width:number;height:number};
export type ChatFile = {name:string;type:string;bytes:ArrayBuffer};
export type ChatSticker = {id:string;name:string;format:number};
export function chatStickerUrl(sticker:ChatSticker):string|undefined {
  if(!/^\d{5,22}$/.test(sticker.id)||![1,2,4].includes(sticker.format))return;
  return `https://media.discordapp.net/stickers/${sticker.id}.${sticker.format===4?'gif':'png'}?size=160`;
}
export type ChatAction =
  | {kind:"draft"|"send";text:string}
  | {kind:"reply";messageId:string}
  | {kind:"older"|"latest"|"ready"|"pin"|"cancel-reply"|"clear-files"}
  | {kind:"picker";picker:"Emoji"|"GIF"|"Stickers"}
  | {kind:"file";file:ChatFile}
  | {kind:"link";url:string};
export type ChatState = {
  title:string;avatar:string;html:string;draft:string;draftVersion:number;reply:string;attachments:string;
  stickers?:ChatSticker[];
  pickerSize?:{width:number;height:number};pickerReady?:string;busy:boolean;historyLoading?:boolean;older:boolean;error:string;locale:string;light:boolean;labels:Record<string,string>;
};
export type ChatEvent = {session:string;channelId:string} & (
  | {type:"picker";picker:"Emoji"|"GIF"|"Stickers";frameName:string}
  | {type:"picker-closed";reason?:"startup-timeout"}
  | {type:"action";action:ChatAction}
  | {type:"bounds";bounds:ChatBounds}
  | {type:"closed";bounds:ChatBounds}
);
export type PopoutBridge = {
  connect(accountId:string):Promise<string>;
  open(session:string,channelId:string,bounds?:ChatBounds):Promise<void>;
  stop(session:string):Promise<void>;
  publish(session:string,channelId:string,state:ChatState):Promise<void>;
  subscribe(listener:(event:ChatEvent)=>void):()=>void;
};
/** Only window opening may retry once after main has explicitly rejected its lease. */
export function isExpiredPopoutSession(error:unknown):boolean {
  const message=error instanceof Error?error.message:typeof error==='string'?error:'';
  return message==='Expired chat session'||message===`Error invoking remote method '${POPOUT_IPC.OPEN}': Error: Expired chat session`;
}
export function chatId(value:unknown):string {
  if(typeof value!=="string" || !/^\d{5,22}$/.test(value))throw Error("Invalid chat identity");return value;
}
function text(value:unknown,max:number):string {
  if(typeof value!=="string"||value.length>max)throw Error("Invalid chat text");return value;
}
export function parseChatAction(value:unknown):ChatAction {
  if(!value||typeof value!=="object")throw Error("Invalid chat action");
  const v=value as Record<string,unknown>;
  switch(v.kind){
    case "draft":case "send":return {kind:v.kind,text:text(v.text,4000)};
    case "reply":return {kind:v.kind,messageId:chatId(v.messageId)};
    case "older":case "latest":case "ready":case "pin":case "cancel-reply":case "clear-files":return {kind:v.kind};
    case "picker":if(v.picker!=="Emoji"&&v.picker!=="GIF"&&v.picker!=="Stickers")break;return {kind:v.kind,picker:v.picker};
    case "file":{
      const f=v.file as Record<string,unknown>|undefined;
      if(!f||!(f.bytes instanceof ArrayBuffer)||f.bytes.byteLength===0||f.bytes.byteLength>25*1024*1024)break;
      return {kind:v.kind,file:{name:text(f.name,255),type:text(f.type,128),bytes:f.bytes}};
    }
    case "link":{
      const url=text(v.url,2048);const parsed=new URL(url);
      if(parsed.protocol!=="https:"&&parsed.protocol!=="http:")break;
      if(parsed.username||parsed.password)break;return {kind:v.kind,url};
    }
  }
  throw Error("Invalid chat action");
}
export function parseChatState(value:unknown):ChatState {
  if(!value||typeof value!=="object")throw Error("Invalid chat state");const v=value as Record<string,unknown>;
  if(typeof v.busy!=="boolean"||typeof v.older!=="boolean"||typeof v.light!=="boolean"||!Number.isSafeInteger(v.draftVersion)||Number(v.draftVersion)<0)throw Error("Invalid chat state");
  if(v.historyLoading!==undefined&&typeof v.historyLoading!=="boolean")throw Error("Invalid chat history state");
  if(!v.labels||typeof v.labels!=="object"||Object.keys(v.labels).length>40)throw Error("Invalid chat labels");
  const labels:Record<string,string>={};for(const [k,val] of Object.entries(v.labels)){
    if(!/^[a-z-]{1,32}$/.test(k))throw Error("Invalid chat label");labels[k]=text(val,500);
  }
  const pickerReady=v.pickerReady===undefined?undefined:text(v.pickerReady,100);
  let pickerSize:ChatState['pickerSize'];
  let stickers:ChatSticker[]|undefined;
  if(v.stickers!==undefined){
    if(!Array.isArray(v.stickers)||v.stickers.length>3)throw Error('Invalid chat stickers');
    stickers=v.stickers.map((raw:unknown)=>{
      if(!raw||typeof raw!=='object')throw Error('Invalid chat sticker');const item=raw as Record<string,unknown>;
      if(typeof item.format!=='number'||![1,2,3,4].includes(item.format))throw Error('Invalid chat sticker');
      return {id:chatId(item.id),name:text(item.name,200),format:item.format};
    });
  }
  if(v.pickerSize!==undefined){const size=v.pickerSize as Record<string,unknown>|null;if(!pickerReady||!size||!Number.isInteger(size.width)||!Number.isInteger(size.height)||Number(size.width)<160||Number(size.width)>1000||Number(size.height)<120||Number(size.height)>1000)throw Error('Invalid picker size');pickerSize={width:Number(size.width),height:Number(size.height)};}
  return {stickers,pickerSize,pickerReady,title:text(v.title,200),avatar:text(v.avatar,2048),html:text(v.html,2*1024*1024),draft:text(v.draft,4000),draftVersion:Number(v.draftVersion),reply:text(v.reply,300),attachments:text(v.attachments,3000),busy:v.busy,historyLoading:v.historyLoading===true,older:v.older,error:text(v.error,1000),locale:text(v.locale,20),light:v.light,labels};
}
