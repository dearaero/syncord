/** Only local navigation metadata. These IDs must never enter a Discord store. */
export type ChannelRef = {guildId:string;channelId:string};
export type Trial = {id:string;name:string;channels:ChannelRef[]};
export const LIMIT_NAME=48;
export function snowflake(value:unknown):value is string {
 return typeof value==='string'&&/^[1-9]\d{0,19}$/.test(value)&&BigInt(value)<(1n<<64n);
}
const object=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
/** Bounded local channel references; empty servers are valid. */
export function normalizeTrial(value:unknown):Trial|undefined {
 const raw=object(value);if(!raw||raw.id!=='virtual:trial'||typeof raw.name!=='string'||!Array.isArray(raw.channels)||raw.channels.length>100)return;
 const name=raw.name.trim().slice(0,LIMIT_NAME);if(!name)return;
 const channels:ChannelRef[]=[];
 for(const input of raw.channels){const ref=object(input);if(!ref||(ref.guildId!=='@me'&&!snowflake(ref.guildId))||!snowflake(ref.channelId))return;if(channels.some(c=>c.channelId===ref.channelId))continue;channels.push({guildId:ref.guildId,channelId:ref.channelId});}
 return{id:'virtual:trial',name,channels};
}
export function routeFor(ref:ChannelRef):string {return `/channels/${ref.guildId}/${ref.channelId}`;}
export type Location = {pathname:string;key?:string};
/** Route ownership is explicit; matching a saved channel alone never activates it. */
export class VirtualNavigation {
 active=false;selected:string|undefined;
 private pending:string|undefined;
 private owner:Location|undefined;
 private history=new Map<string,string>();
 constructor(private trial:()=>Trial|undefined){}
 enter(location?:Location):void {this.active=true;this.selected=undefined;this.pending=undefined;this.owner=location?{...location}:undefined;}
 begin(ref:ChannelRef):void {this.active=true;this.selected=ref.channelId;this.pending=routeFor(ref);}
 confirm(location:Location):void {if(this.pending===location.pathname)this.settle(location,'PUSH');}
 settle(location:Location,action:unknown):void {
  const trial=this.trial(),path=location.pathname;
  const ref=trial?.channels.find(c=>routeFor(c)===path);
  if(ref&&this.pending===path){this.pending=undefined;this.active=true;this.selected=ref.channelId;this.owner={...location};if(location.key){this.history.set(location.key,path);if(this.history.size>64)this.history.delete(this.history.keys().next().value!);}return;}
  this.pending=undefined;
  this.active=!!ref&&action==='POP'&&!!location.key&&this.history.get(location.key)===path;
  this.selected=this.active?ref?.channelId:undefined;this.owner=this.active?{...location}:undefined;
 }
 /** Selection events can precede native history listeners; keep a confirmed entry only. */
 observe(location:Location):void {
  if(this.pending){this.confirm(location);return;}
  if(this.active&&(!this.owner||this.owner.pathname!==location.pathname||this.owner.key!==location.key))this.exit();
 }
 exit():void {this.active=false;this.pending=undefined;this.selected=undefined;this.owner=undefined;}
 reset():void {this.exit();this.history.clear();}
}

/** Reorders local references only; never changes a native channel position. */
export function reorderChannels(channels:readonly ChannelRef[],source:string,target:string,after:boolean):ChannelRef[] {
 const from=channels.findIndex(c=>c.channelId===source),to=channels.findIndex(c=>c.channelId===target);
 if(from<0||to<0||from===to)return [...channels];
 const next=channels.filter(c=>c.channelId!==source),index=next.findIndex(c=>c.channelId===target);
 next.splice(index+(after?1:0),0,channels[from]);return next;
}
