export const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object';
export const validId=(v:unknown):v is string=>typeof v==='string'&&/^[1-9]\d{16,19}$/.test(v);
export type Problem='cache'|'managed'|'member'|'unsupported'|'mapping'|'permissions'|'order'|'fields'|'missing';
export type Issue={code:Problem;item:string};
export class CloneError extends Error {constructor(public readonly code:'unavailable'|'permission'|'invalid'|'account'|'stale'|'busy'){super(code);}}
export function bits(value:unknown):string {
 if(typeof value==='number'&&(!Number.isSafeInteger(value)||value<0))throw new CloneError('invalid');
 if(!['string','number','bigint'].includes(typeof value)||!/^\d+$/.test(String(value)))throw new CloneError('invalid');
 const n=BigInt(String(value));if(n>=(1n<<64n))throw new CloneError('invalid');return n.toString();
}
export type Overwrite=Readonly<{id:string;type:0|1;allow:string;deny:string}>;
export type Role=Readonly<{id:string;name:string;position:number;permissions:string;color:number;hoist:boolean;mentionable:boolean;managed:boolean;icon:string|null;unicodeEmoji:string|null;colors:Readonly<Record<string,number|null>>}>;
export type Detail=Readonly<Record<string,string|boolean|null>>;
export type Setting=string|number|boolean|null|Detail|readonly Detail[];
export type Channel=Readonly<{id:string;name:string;type:number;position:number;parent:string|null;overwrites:readonly Overwrite[];settings:Readonly<Record<string,Setting>>;synced:boolean|null}>;
export type Snapshot=Readonly<{id:string;name:string;icon:string|null;roles:readonly Role[];channels:readonly Channel[];coverage:'visible-cache';issues:readonly Issue[]}>;
export const automaticType=(type:number):boolean=>[0,2,4,5,13,15,16].includes(type);
export function overwriteKey(rows:readonly Overwrite[]):string{return JSON.stringify([...rows].sort((a,b)=>a.type-b.type||a.id.localeCompare(b.id)));}
export function plan(snapshot:Snapshot):Issue[]{
 const issues=[...snapshot.issues];
 for(const role of snapshot.roles)if(role.managed)issues.push({code:'managed',item:role.name});
 const roles=new Set(snapshot.roles.filter(r=>!r.managed).map(r=>r.id));
 for(const channel of snapshot.channels){
  if(!automaticType(channel.type))issues.push({code:'unsupported',item:channel.name});
  for(const row of channel.overwrites){if(row.type===1)issues.push({code:'member',item:channel.name});else if(!roles.has(row.id))issues.push({code:'mapping',item:channel.name});}
 }
 return issues;
}
