import { t as i18nText } from "../../i18n";
import {validId} from '../messageCleaner/engine';
export const PAGE_SIZE=25,MAX_OFFSET=9975,MAX_RESULTS=2000,MAX_TEXT_BYTES=4*1024*1024;
export type Guild={id:string;name:string};
export type Criteria={content:string;authorId?:string;from?:string;through?:string;has?:'image'|'video'|'file'|'link'|'sound';order:'desc'|'asc'};
export type Plan={accountId:string;guilds:Guild[];criteria:Criteria};
export type Hit={id:string;channelId:string;guildId:string;authorId:string;authorName:string;content:string;timestamp:number;attachments:string[]};
export type Page={hits:Hit[];count:number;total?:number;historical:boolean};
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'?v as Record<string,unknown>:{};
export function dateBoundary(value:string,end=false):string {
 if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw Error("Choose a valid date.");
 const ms=Date.parse(value+'T00:00:00Z');if(!Number.isFinite(ms)||new Date(ms).toISOString().slice(0,10)!==value||ms<1420070400000)throw Error("Dates must be valid and on or after January 1, 2015.");
 const id=(BigInt(ms+(end?86400000:0))-1420070400000n)<<22n;if(id<0n||id>=1n<<64n)throw Error("Date is outside Discord’s supported range.");return id.toString();
}
export function validatePlan(plan:Plan):Plan{
 if(!validId(plan.accountId)||!Array.isArray(plan.guilds)||!plan.guilds.length||plan.guilds.length>1000)throw Error("Select at least one available server.");
 const ids=new Set<string>();for(const g of plan.guilds){if(!g||!validId(g.id)||typeof g.name!=='string'||ids.has(g.id))throw Error("Invalid or duplicate server selection.");ids.add(g.id);}
 const c=plan.criteria;if(!c||typeof c.content!=='string'||c.content.trim().length>500||!['desc','asc'].includes(c.order))throw Error("Search text must be at most 500 characters.");
 if(c.authorId&&!validId(c.authorId))throw Error("Sender must be a Discord user ID.");
 if(c.has&&!['image','video','file','link','sound'].includes(c.has))throw Error("Invalid content type.");
 if(c.from)dateBoundary(c.from);if(c.through)dateBoundary(c.through,true);if(c.from&&c.through&&c.from>c.through)throw Error("From date must be on or before Through date.");
 if(!c.content.trim()&&!c.authorId&&!c.from&&!c.through&&!c.has)throw Error("Enter search text or choose an advanced filter.");
 return{accountId:plan.accountId,guilds:plan.guilds.map(g=>({id:g.id,name:g.name.slice(0,200)})),criteria:{...c,content:c.content.trim()}};
}
export function queryFor(criteria:Criteria,offset:number):Record<string,unknown>{
 if(!Number.isInteger(offset)||offset<0||offset>MAX_OFFSET)throw Error("Discord’s search page limit was reached. Narrow the date range.");
 // Also normalize at the native REST boundary: author-only requests must never
 // acquire a content filter from an empty or whitespace-only text field.
 const content=criteria.content.trim();
 return{...(content?{content}:{}),limit:PAGE_SIZE,offset,sort_by:'timestamp',sort_order:criteria.order,
  ...(criteria.authorId?{author_id:[criteria.authorId]}:{}),...(criteria.from?{min_id:dateBoundary(criteria.from)}:{}),...(criteria.through?{max_id:dateBoundary(criteria.through,true)}:{}),...(criteria.has?{has:[criteria.has]}:{})};
}
export function parsePage(body:unknown,guildId:string):Page {
 const b=object(body);if(!Array.isArray(b.messages)||b.messages.length>100)throw Error("Discord returned an unrecognized search response.");
 const hits:Hit[]=[],seen=new Set<string>();
 for(const raw of b.messages){
  if(!Array.isArray(raw))throw Error("Discord returned an unrecognized message group.");
  // Legacy search bundles include neighboring context marked hit:false. Newer
  // bundles may contain only the matching message and omit the flag entirely.
  const items=raw.slice(0,100).map(object),flagged=items.some(m=>typeof m.hit==='boolean');
  for(const m of flagged?items.filter(m=>m.hit===true):items.slice(0,1)){
   const author=object(m.author);if(!validId(m.id)||!validId(m.channel_id)||!validId(author.id)||seen.has(m.id)||m.guild_id!==undefined&&m.guild_id!==guildId)continue;
   seen.add(m.id);const timestamp=Number((BigInt(m.id)>>22n)+1420070400000n);
   hits.push({id:m.id,channelId:m.channel_id,guildId,authorId:author.id,authorName:String(author.global_name||author.username||author.id).slice(0,120),content:typeof m.content==='string'?m.content.slice(0,8000):'',timestamp,
    attachments:Array.isArray(m.attachments)?m.attachments.slice(0,4).map(a=>{const f=object(a);return typeof f.filename==='string'?f.filename.slice(0,200):i18nText("ui.attachment");}):[]});
  }
 }
 const total=typeof b.total_results==='number'&&Number.isSafeInteger(b.total_results)&&b.total_results>=0?Math.min(b.total_results,1_000_000_000):undefined;
 return{hits,count:b.messages.length,total,historical:b.doing_deep_historical_index===true||b.doing_historical_index===true};
}
export type ResultView={guildId:string;sender:string;sort:'newest'|'oldest'|'server'|'sender'};
export function viewResults(hits:readonly Hit[],guilds:readonly Guild[],view:ResultView):Hit[]{
 const names=new Map(guilds.map(g=>[g.id,g.name])),sender=view.sender.trim().toLocaleLowerCase();
 return hits.filter(h=>(!view.guildId||h.guildId===view.guildId)&&(!sender||h.authorId===sender||h.authorName.toLocaleLowerCase().includes(sender))).sort((a,b)=>{
  const grouped=view.sort==='server'?(names.get(a.guildId)??a.guildId).localeCompare(names.get(b.guildId)??b.guildId):view.sort==='sender'?a.authorName.localeCompare(b.authorName):0;
  return grouped||(view.sort==='oldest'?a.timestamp-b.timestamp:b.timestamp-a.timestamp)||((a.id===b.id?0:BigInt(a.id)<BigInt(b.id)?-1:1)*(view.sort==='oldest'?1:-1));
 });
}
export function hitBytes(hit:Hit):number{return 512+2*(hit.content.length+hit.authorName.length+hit.attachments.join('').length);}
