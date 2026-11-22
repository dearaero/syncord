import type {Action} from "../../api/discordEvents";
import {activityAccount,canViewChannel} from "./discord";
import {messageContent,record,userId} from "./types";
import type {ActivityRecorder} from "./recorder";

type Snapshot={userId:string;content?:string};
function snapshot(value:unknown):Snapshot|undefined {
  const message=record(value),id=userId(record(message?.author)?.id);
  return id?{userId:id,content:messageContent(message?.content)}:undefined;
}
function nativeMessage(channel:string,id:string):Snapshot|undefined {
  const store=window.Syncord?.common?.stores.MessageStore as {getMessage?:(channel:string,id:string)=>unknown}|undefined;
  try{return snapshot(store?.getMessage?.(channel,id));}catch{return undefined;}
}

/** Only scalar snapshots cross the dispatch boundary. Content fallback uses an indexed disk lookup. */
export class MessageActivity {
  private work:Promise<void>=Promise.resolve();
  constructor(private readonly recorder:ActivityRecorder,
    private readonly selected:(id:string)=>boolean,
    private readonly deliver:(type:string,message:Record<string,unknown>)=>void) {}
  observe(action:Action):void {
    const type=action.type;
    if(type!=="MESSAGE_DELETE"&&type!=="MESSAGE_DELETE_BULK"&&type!=="MESSAGE_UPDATE")return;
    const incoming=record(action.message),rawChannel=action.channelId??action.channel_id??incoming?.channel_id??incoming?.channelId;
    const channel=typeof rawChannel==='string'&&rawChannel.length<=64?rawChannel:'';
    const account=activityAccount(),observedAt=Date.now();
    if(!account||!channel||!canViewChannel(channel))return;
    if(type==='MESSAGE_UPDATE'&&typeof incoming?.content!=='string')return;
    const ids=new Set<string>();
    const add=(id:unknown):void=>{if(typeof id==='string'&&id.length>0&&id.length<=32)ids.add(id);};
    add(action.id);add(action.messageId);add(action.message_id);add(incoming?.id);
    for(const list of [action.ids,action.messageIds])if(Array.isArray(list))for(const id of list)add(id);
    for(const id of ids){
      // Capture before Discord removes/replaces its store record, never retain the native model.
      const seen=nativeMessage(channel,id)??snapshot(incoming);
      if(seen&&!this.selected(seen.userId))continue;
      const content=type==='MESSAGE_UPDATE'?messageContent(incoming?.content):seen?.content;
      this.work=this.work.then(async()=>{
        if(activityAccount()!==account||!canViewChannel(channel))return;
        const previous=await this.recorder.message(account,channel,id);
        const author=seen?.userId??previous?.userId;
        if(!author||!this.selected(author)||activityAccount()!==account||!canViewChannel(channel))return;
        const body=content??previous?.content;
        if(type==='MESSAGE_UPDATE'&&(previous?.messageEvent==='deleted'||previous?.content===body))return;
        if(type!=='MESSAGE_UPDATE'&&previous?.messageEvent==='deleted')return;
        this.deliver(type==='MESSAGE_UPDATE'?'MESSAGE_UPDATE':'MESSAGE_DELETE',
          {id,channel_id:channel,author:{id:author},content:body,observedAt});
        // The next deletion (including duplicates in another bulk event) observes this commit.
        await this.recorder.settle();
      }).catch(error=>this.recorder.failure(error));
    }
  }
  drain():Promise<void> {return this.work;}
}
