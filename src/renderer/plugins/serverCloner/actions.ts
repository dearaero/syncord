import {findByProps} from '../../webpack';
import {CloneError,object,validId,type Role,type Channel,type Overwrite} from './model';
import {accountId,assertGuild,assertTarget,readSnapshot,store,targetSupports} from './discord';
type NativeRoles={createRole:(guild:string,name:string,color:number,colors:unknown,options:{skipSelect:true})=>Promise<unknown>;updateRole:(guild:string,id:string,data:unknown)=>Promise<unknown>;batchRoleUpdate:(guild:string,data:unknown)=>Promise<unknown>;batchChannelUpdate:(guild:string,data:unknown)=>Promise<unknown>};
type CreateChannel={createChannel:(data:unknown)=>Promise<unknown>};
type UpdateChannel={updateChannel:(id:string,data:unknown)=>Promise<unknown>};
export type ClonePort={
 cooldown?:{until:number};
 check:()=>void;
 supports:(type:number)=>boolean;
 createRole:(role:Role)=>Promise<unknown>;
 updateRole:(id:string,role:Role)=>Promise<unknown>;
 orderRoles:(rows:{id:string;position:number}[])=>Promise<unknown>;
 createChannel:(channel:Channel,parent:string|null,overwrites:Overwrite[])=>Promise<unknown>;
 updateChannel:(id:string,channel:Channel,overwrites:Overwrite[])=>Promise<unknown>;
 orderChannels:(rows:{id:string;position:number}[])=>Promise<unknown>;
 snapshot:()=>ReturnType<typeof readSnapshot>;
};
// Channel records carry defaults for unrelated types. Only forward fields
// accepted for the destination type, rather than PATCHing those defaults.
export function channelFields(channel:Channel):Record<string,unknown> {
 const voice=[2,13].includes(channel.type),forum=[15,16].includes(channel.type),text=[0,5].includes(channel.type);
 const keys=new Set<string>();
 if(text||forum)for(const key of ['topic','defaultAutoArchiveDuration'])keys.add(key);
 if(text||voice||forum)keys.add('nsfw');
 if(channel.type===0||voice||forum)keys.add('rateLimitPerUser');
 if(voice)for(const key of ['bitrate','userLimit','rtcRegion','videoQualityMode'])keys.add(key);
 if(forum)for(const key of ['defaultReactionEmoji','defaultThreadRateLimitPerUser','defaultSortOrder'])keys.add(key);
 if(channel.type===15)keys.add('defaultForumLayout');
 const fields:Record<string,unknown>={};
 for(const [key,value]of Object.entries(channel.settings))if(keys.has(key))fields[key.replace(/[A-Z]/g,c=>'_'+c.toLowerCase())]=key==='defaultReactionEmoji'&&object(value)?{emoji_id:value.emojiId,emoji_name:value.emojiName}:value;
 return fields;
}
const cooldowns=new Map<string,{until:number}>();
export function createdId(response:unknown):string {
 const raw=object(response)&&object(response.body)?response.body:response;
 if(!object(raw)||!validId(raw.id))throw new CloneError('unavailable');return raw.id;
}
/** Resolve only already-loaded native actions; never load factories or create
 * an HTTP client. Every write is pinned to the explicitly selected destination. */
export function nativePort(source:string,target:string,guard:()=>void):ClonePort {
 const roles=findByProps('createRole','updateRole','batchRoleUpdate','batchChannelUpdate') as NativeRoles|undefined;
 const create=findByProps('createChannel','createRoleSubscriptionTemplateChannel') as CreateChannel|undefined;
 const update=findByProps('updateChannel','updatePermissionOverwrite','clearPermissionOverwrite') as UpdateChannel|undefined;
 if(!roles||!create||!update||![roles.createRole,roles.updateRole,roles.batchRoleUpdate,roles.batchChannelUpdate,create.createChannel,update.updateChannel].every(fn=>typeof fn==='function'))throw new CloneError('unavailable');
 const before=readSnapshot(target),existingRoles=new Set(before.roles.map(r=>r.id)),existingChannels=new Set(before.channels.map(c=>c.id));
 const roleIds=new Set<string>(),channelIds=new Set<string>();
 const check=():void=>{guard();assertGuild(source);assertTarget(target,source);};
 check();const account=accountId();if(!account)throw new CloneError('account');
 for(const [id,value]of cooldowns)if(value.until<=Date.now())cooldowns.delete(id);
 const cooldown=cooldowns.get(account)??{until:0};cooldowns.set(account,cooldown);
 const own=(ids:Set<string>,id:string):void=>{check();if(!ids.has(id))throw new CloneError('invalid');};
 const colors=(role:Role):unknown=>({primary_color:role.colors.primaryColor??role.color,secondary_color:role.colors.secondaryColor??null,tertiary_color:role.colors.tertiaryColor??null});
 return{
  check,cooldown,supports:type=>targetSupports(target,type),snapshot:()=>readSnapshot(target),
  async createRole(role){check();const response=await roles.createRole(target,role.name,role.color,colors(role),{skipSelect:true}),id=createdId(response);if(existingRoles.has(id)||roleIds.has(id))throw new CloneError('invalid');roleIds.add(id);return response;},
  updateRole(id,role){own(roleIds,id);return roles.updateRole(target,id,{name:role.name,color:role.color,colors:colors(role),permissions:role.permissions,hoist:role.hoist,mentionable:role.mentionable,...(role.unicodeEmoji?{unicodeEmoji:role.unicodeEmoji}:{})});},
  orderRoles(rows){for(const row of rows)own(roleIds,row.id);return roles.batchRoleUpdate(target,rows);},
  async createChannel(channel,parent,overwrites){check();if(parent!==null&&!channelIds.has(parent)||overwrites.some(row=>row.type!==0||row.id!==target&&!roleIds.has(row.id)))throw new CloneError('invalid');
   const response=await create.createChannel({guildId:target,type:channel.type,name:channel.name,parentId:parent,permissionOverwrites:overwrites,...([2,13].includes(channel.type)?{bitrate:channel.settings.bitrate,userLimit:channel.settings.userLimit}:{}),...([15,16].includes(channel.type)?{availableTags:channel.settings.availableTags}:{})});
   const id=createdId(response);if(existingChannels.has(id)||channelIds.has(id))throw new CloneError('invalid');
   const raw=object(response)&&object(response.body)?response.body:response;if(!object(raw)||raw.guild_id!==target)throw new CloneError('invalid');channelIds.add(id);return response;
  },
  updateChannel(id,channel,overwrites){own(channelIds,id);if(overwrites.some(row=>row.type!==0||row.id!==target&&!roleIds.has(row.id)))throw new CloneError('invalid');const current=store<{getChannel?:(id:string)=>{guild_id?:string}|undefined}>('ChannelStore')?.getChannel?.(id);if(current&&current.guild_id!==target)throw new CloneError('invalid');
   return update.updateChannel(id,{...channelFields(channel),permission_overwrites:overwrites});
  },
  orderChannels(rows){for(const row of rows)own(channelIds,row.id);return roles.batchChannelUpdate(target,rows);},
 };
}
