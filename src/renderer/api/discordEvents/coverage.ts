import type {Action} from './hub';
export type CoverageRequest={typing?:boolean;activities?:boolean;threads?:boolean;userIds?:readonly string[]};
type Features={typing:boolean;activities:boolean;threads:boolean};
const FLAGS=['typing','activities','threads'] as const;
const REFRESH_EVENTS=new Set(['GUILD_CREATE','GUILD_DELETE','CHANNEL_SELECT','VOICE_CHANNEL_SELECT']);
export type CoverageDeps={guildIds:()=>string[];retainedGuilds:()=>Set<string>;membersRetained?:(id:string)=>boolean;nativeFeatures:(id:string)=>Features;dispatch:(action:Action)=>unknown;
  set:(callback:()=>void,delay:number)=>number;clear:(id:number)=>void;report:(error:unknown)=>void;changed:()=>void};
function record(value:unknown):Record<string,unknown>|undefined {return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;}
function ids(value:readonly string[]|undefined):Set<string> {return new Set((value??[]).filter(id=>/^\d{17,20}$/.test(id)).slice(0,32));}

/** Combines consumers into native subscription updates; never downloads channel history/member lists. */
export class GuildCoverage {
  private requests=new Map<symbol,CoverageRequest>();
  private native=new Map<string,Features>();
  private ownedMembers=new Map<string,Set<string>>();
  private applied=new Map<string,string>();
  private timer:number|undefined;
  private connected=true;
  private sending=false;
  private force=false;
  constructor(private readonly deps:CoverageDeps) {}
  acquire(request:CoverageRequest):{update:(next:CoverageRequest)=>void;release:()=>void} {
    if(!this.requests.size){this.connected=true;this.force=false;}
    const key=Symbol();this.requests.set(key,this.clean(request));this.schedule();
    let released=false;
    return {update:next=>{if(!released){this.requests.set(key,this.clean(next));this.schedule();}},release:()=>{
      if(released)return;released=true;this.requests.delete(key);
      if(!this.requests.size){this.cancel();this.reconcile();this.native.clear();this.applied.clear();}
      else this.schedule();
    }};
  }
  private clean(request:CoverageRequest):CoverageRequest {return {typing:request.typing===true,activities:request.activities===true,
    threads:request.threads===true,userIds:[...ids(request.userIds)]};}
  private wanted():{features:Features;users:Set<string>} {
    const features:Features={typing:false,activities:false,threads:false},users=new Set<string>();
    for(const request of this.requests.values()) {for(const flag of FLAGS)features[flag] ||= request[flag]===true;
      for(const id of request.userIds??[])if(users.size<32)users.add(id);}
    return {features,users};
  }
  private base(id:string):Features {let value=this.native.get(id);if(!value){value={...this.deps.nativeFeatures(id)};this.native.set(id,value);}return value;}
  before(action:Action):void {
    if(this.sending||action.type!=='GUILD_SUBSCRIPTIONS_FLUSH'||!this.requests.size)return;
    const subscriptions=record(action.subscriptions);if(!subscriptions)return;
    const {features,users}=this.wanted();let copy:Record<string,unknown>|undefined;
    for(const id of this.deps.guildIds()) {
      const incoming=record(subscriptions[id]);if(!incoming)continue;
      const base=this.base(id);for(const flag of FLAGS)if(typeof incoming[flag]==='boolean')base[flag]=incoming[flag] as boolean;
      const merged={...incoming};for(const flag of FLAGS)if(features[flag])merged[flag]=true;
      // A native idle/channel switch flush must not cancel a selected-member lease.
      if(Array.isArray(incoming.members)&&users.size)merged.members=[...new Set([...incoming.members,...users])];
      copy??={...subscriptions};copy[id]=merged;
    }
    if(copy)action.subscriptions=copy;
  }
  after(action:Action):void {
    if(this.sending||!this.requests.size)return;
    if(action.type==='CONNECTION_CLOSED'||action.type==='LOGOUT') {
      this.connected=false;this.cancel();this.applied.clear();
      if(action.type==='LOGOUT')this.ownedMembers.clear();else this.dropClearedMembers();
      this.native.clear();this.deps.changed();return;
    }
    if(action.type==='CONNECTION_OPEN'||action.type==='CONNECTION_OPEN_SUPPLEMENTAL'||action.type==='CONNECTION_RESUMED') {
      this.connected=true;this.applied.clear();this.force=true;this.schedule();
    } else if(action.type==='IDLE'&&action.idle===true) {
      // Native GuildSubscriptionsStore clears non-selected guild member references on idle.
      this.applied.clear();this.dropClearedMembers();this.force=true;this.schedule();
    } else if(REFRESH_EVENTS.has(action.type??''))this.schedule();
  }
  private dropClearedMembers():void {const retained=this.deps.retainedGuilds();for(const id of this.ownedMembers.keys())if(!(this.deps.membersRetained?.(id)??retained.has(id)))this.ownedMembers.delete(id);}
  private schedule():void {if(!this.connected||this.timer!==undefined)return;this.timer=this.deps.set(()=>{this.timer=undefined;this.reconcile();},250);}
  private cancel():void {if(this.timer!==undefined)this.deps.clear(this.timer);this.timer=undefined;}
  private send(action:Action):boolean {
    this.sending=true;try {this.deps.dispatch(action);return true;}catch(error){this.deps.report(error);return false;}finally{this.sending=false;}
  }
  private reconcile():void {
    if(!this.connected) {
      if(!this.requests.size){for(const [id,members] of this.ownedMembers)this.send({type:'GUILD_SUBSCRIPTIONS_MEMBERS_REMOVE',guildId:id,userIds:[...members]});this.ownedMembers.clear();}
      return;
    }
    const guilds=this.requests.size?this.deps.guildIds():[],wantedGuilds=new Set(guilds),{features,users}=this.wanted();
    const subscriptions:Record<string,Features>={};
    for(const [id,previous] of this.ownedMembers) {
      const remove=[...previous].filter(user=>!wantedGuilds.has(id)||!users.has(user));
      if(remove.length&&this.send({type:'GUILD_SUBSCRIPTIONS_MEMBERS_REMOVE',guildId:id,userIds:remove}))for(const user of remove)previous.delete(user);
      if(!previous.size)this.ownedMembers.delete(id);
    }
    for(const id of guilds) {
      const base=this.base(id),next:Features={typing:base.typing||features.typing,activities:base.activities||features.activities,threads:base.threads||features.threads};
      const signature=JSON.stringify(next);
      if(this.force||this.applied.get(id)!==signature)subscriptions[id]=next;
      if(users.size) {
        let owned=this.ownedMembers.get(id);if(!owned){owned=new Set();this.ownedMembers.set(id,owned);}
        const add=[...users].filter(user=>!owned.has(user));
        if(add.length&&this.send({type:'GUILD_SUBSCRIPTIONS_MEMBERS_ADD',guildId:id,userIds:add}))for(const user of add)owned.add(user);
      }
    }
    for(const id of this.applied.keys())if(!wantedGuilds.has(id)) {
      // Leave native typing/activity/threads and native channel ranges intact.
      if(this.deps.guildIds().includes(id))subscriptions[id]={...this.base(id)};
    }
    // Discord's native sender already splits frames at its 15 KiB limit. Small batches reduce bursts.
    const entries=Object.entries(subscriptions);
    for(let offset=0;offset<entries.length;offset+=25) {
      const batch=Object.fromEntries(entries.slice(offset,offset+25));
      if(this.send({type:'GUILD_SUBSCRIPTIONS_FLUSH',subscriptions:batch}))for(const [id,value] of Object.entries(batch))this.applied.set(id,JSON.stringify(value));
    }
    for(const id of this.applied.keys())if(!wantedGuilds.has(id)){this.applied.delete(id);this.native.delete(id);}
    this.force=false;this.deps.changed();
  }
  status():{consumers:number;guilds:number;members:number;pending:boolean;connected:boolean} {
    return {consumers:this.requests.size,guilds:this.requests.size?this.applied.size:0,
      members:[...this.ownedMembers.values()].reduce((n,set)=>n+set.size,0),pending:this.timer!==undefined,connected:this.connected};
  }
}
