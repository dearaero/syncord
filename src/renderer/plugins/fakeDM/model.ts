export const ID='fake-dm';
export const LIMITS={channel:200,account:3000,content:8000,bytes:128*1024} as const;
export type LocalRecord={id:string;accountId:string;channelId:string;authorId:string;kind:'message'|'call';content:string;timestamp:string;createdAt:number;updatedAt:number;receiverId?:string;missed?:boolean;endedAt?:string};
export type Database={version:1;accounts:Record<string,Record<string,LocalRecord[]>>};
export const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export const snowflake=(v:unknown):v is string=>typeof v==='string'&&/^\d{17,20}$/.test(v);
export const localId=(v:unknown):v is string=>typeof v==='string'&&/^syncord-local:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
export function iso(v:unknown):v is string {if(typeof v!=='string'||v.length!==24)return false;const ms=Date.parse(v);return Number.isFinite(ms)&&ms>=Date.UTC(2015,0,1)&&ms<=Date.UTC(2100,0,1)&&new Date(ms).toISOString()===v;}
export function validate(v:unknown,account:string,channel:string):LocalRecord|undefined{
 if(!object(v)||!localId(v.id)||v.accountId!==account||v.channelId!==channel||!snowflake(v.authorId)||!iso(v.timestamp)||!Number.isSafeInteger(v.createdAt)||!Number.isSafeInteger(v.updatedAt)||Number(v.createdAt)<0||Number(v.updatedAt)<Number(v.createdAt))return;
 const base={id:v.id,accountId:account,channelId:channel,authorId:v.authorId,timestamp:v.timestamp,createdAt:Number(v.createdAt),updatedAt:Number(v.updatedAt)};
 if(v.kind==='message'&&typeof v.content==='string'&&v.content.trim()&&v.content.length<=LIMITS.content)return {...base,kind:'message',content:v.content};
 if(v.kind==='call'&&snowflake(v.receiverId)&&v.receiverId!==v.authorId&&typeof v.missed==='boolean'&&iso(v.endedAt)){
  const duration=Date.parse(v.endedAt)-Date.parse(v.timestamp);
  if(duration>=0&&duration<=86400000&&(!v.missed||duration===0))return {...base,kind:'call',content:'',receiverId:v.receiverId,missed:v.missed,endedAt:v.endedAt};
 }
 return;
}
export const compare=(a:LocalRecord,b:LocalRecord):number=>a.timestamp.localeCompare(b.timestamp)||a.createdAt-b.createdAt||a.id.localeCompare(b.id);
export function load(v:unknown):Database{
 const out:Database={version:1,accounts:{}};
 if(v===undefined)return out;
 if(!object(v)||v.version!==1||!object(v.accounts)||new TextEncoder().encode(JSON.stringify(v)).byteLength>LIMITS.bytes)throw Error('fd.invalid');
 const seen=new Set<string>();
 for(const [account,channels]of Object.entries(v.accounts)){
  if(!snowflake(account)||!object(channels))continue;let count=0;const next:Record<string,LocalRecord[]>={};
  for(const [channel,rows]of Object.entries(channels)){
   if(!snowflake(channel)||!Array.isArray(rows))continue;const valid:LocalRecord[]=[];
   for(const raw of rows){if(valid.length>=LIMITS.channel||count>=LIMITS.account)break;const row=validate(raw,account,channel);if(!row||seen.has(row.id))continue;seen.add(row.id);valid.push(row);count++;}
   if(valid.length)next[channel]=valid.sort(compare);
  }
  if(count)out.accounts[account]=next;
 }
 return out;
}
/** Local input must survive a round trip (reject impossible days and DST gaps). */
export function parseDate(value:string):string|undefined{
 if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/.test(value))return;
 const date=new Date(value);if(!Number.isFinite(date.getTime()))return;
 const expected=value.length===16?value+':00':value;
 if(toLocal(date.toISOString())!==expected)return;
 return iso(date.toISOString())?date.toISOString():undefined;
}
export function toLocal(value:string):string{
 const d=new Date(value),pad=(n:number)=>String(n).padStart(2,'0');
 return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
