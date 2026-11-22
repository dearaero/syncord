import type {DiscordMessage} from './log';
const text=(value:unknown,limit:number):string|undefined=>typeof value==='string'?value.slice(0,limit):undefined;
/** Bounded snapshots for received messages, including channels never opened. No native object graph. */
export class RecentMessages {
  private rows=new Map<string,{message:DiscordMessage;bytes:number}>();
  private bytes=0;
  constructor(private readonly evicted:(id:string)=>void,private readonly maxCount=12_000,private readonly byteBudget=16*1024*1024) {}
  get size():number{return this.rows.size;}
  get retainedBytes():number{return this.bytes;}
  get(id:string):DiscordMessage|undefined{return this.rows.get(id)?.message;}
  keys():IterableIterator<string>{return this.rows.keys();}
  set(id:string,source:DiscordMessage):void {
    if(!id||id.length>32)return;
    const author=source.author;
    const timestamp=source.timestamp instanceof Date?source.timestamp.getTime():source.timestamp;
    const message:DiscordMessage={id,channel_id:text(source.channel_id??source.channelId,32),content:text(source.content,8000),
      flags:source.flags,timestamp:typeof timestamp==='number'?timestamp:text(timestamp,80),
      author:author?{id:text(author.id,32),username:text(author.username,100),globalName:text(author.globalName,100),global_name:text(author.global_name,100),bot:author.bot===true}:undefined,
      attachments:source.attachments?.slice(0,8).map(file=>({filename:text(file.filename,256),url:text(file.url,2048)})),
      embeds:source.embeds?.slice(0,8).map(embed=>({title:text(embed.title,256),description:text(embed.description,2000)})),
      stickerItems:source.stickerItems?.slice(0,8).map(sticker=>({name:text(sticker.name,100)})),
      stickers:source.stickers?.slice(0,8).map(sticker=>({name:text(sticker.name,100)}))};
    const bytes=JSON.stringify(message).length*2+256;
    const previous=this.rows.get(id);if(previous){this.bytes-=previous.bytes;this.rows.delete(id);}
    this.rows.set(id,{message,bytes});this.bytes+=bytes;
    while(this.rows.size>this.maxCount||this.bytes>this.byteBudget){const oldest=this.rows.keys().next();if(oldest.done)break;this.delete(oldest.value);}
  }
  delete(id:string):void {const row=this.rows.get(id);if(!row)return;this.rows.delete(id);this.bytes-=row.bytes;this.evicted(id);}
  clear():void {for(const id of this.rows.keys())this.evicted(id);this.rows.clear();this.bytes=0;}
}
