import {bits,CloneError,object,validId,overwriteKey,type Channel,type Overwrite,type Role,type Snapshot,type Setting,type Detail} from './model';
const text=(v:unknown,max=100):string=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw new CloneError('invalid');return v;};
const integer=(v:unknown):number=>{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0)throw new CloneError('invalid');return v;};
const nullable=(v:unknown):string|null=>v==null?null:text(v,256);
function overwrites(value:unknown):readonly Overwrite[]{
 if(!object(value))throw new CloneError('invalid');
 const values=Array.isArray(value)?value:Object.values(value),seen=new Set<string>();
 return Object.freeze(values.map(raw=>{
  if(!object(raw)||!validId(raw.id)||(raw.type!==0&&raw.type!==1)||seen.has(raw.id))throw new CloneError('invalid');seen.add(raw.id);
  const allow=bits(raw.allow),deny=bits(raw.deny);if(BigInt(allow)&BigInt(deny))throw new CloneError('invalid');
  return Object.freeze({id:raw.id,type:raw.type,allow,deny});
 }));
}
const settingKeys=['topic','nsfw','rateLimitPerUser','bitrate','userLimit','rtcRegion','videoQualityMode','defaultAutoArchiveDuration','defaultThreadRateLimitPerUser','defaultSortOrder','defaultForumLayout','flags'] as const;
const snake=(v:string):string=>v.replace(/[A-Z]/g,c=>'_'+c.toLowerCase());
export function makeSnapshot(guild:unknown,roleData:unknown,channelData:unknown,canView:(raw:Record<string,unknown>)=>boolean):Snapshot {
 if(!object(guild)||!validId(guild.id)||guild.unavailable||!object(roleData)||!object(channelData))throw new CloneError('unavailable');
 const rawRoles=Object.values(roleData),rawChannels=Object.values(channelData);if(rawRoles.length>1000||rawChannels.length>5000)throw new CloneError('invalid');
 const roles:Role[]=rawRoles.map(raw=>{
  if(!object(raw)||!validId(raw.id)||typeof raw.hoist!=='boolean'||typeof raw.mentionable!=='boolean'||typeof raw.managed!=='boolean')throw new CloneError('invalid');
  const colors:Record<string,number|null>={};if(object(raw.colors))for(const key of ['primaryColor','secondaryColor','tertiaryColor']){const v=raw.colors[key];if(v!==undefined)colors[key]=v===null?null:integer(v);}
  return Object.freeze({id:raw.id,name:text(raw.name),position:integer(raw.position),permissions:bits(raw.permissions),color:integer(raw.color),hoist:raw.hoist,mentionable:raw.mentionable,managed:raw.managed,icon:nullable(raw.icon),unicodeEmoji:nullable(raw.unicodeEmoji??raw.unicode_emoji),colors:Object.freeze(colors)});
 });
 if(!roles.some(r=>r.id===guild.id)||new Set(roles.map(r=>r.id)).size!==roles.length)throw new CloneError('invalid');
 const channels:Channel[]=[];
 for(const raw of rawChannels){
  if(!object(raw)||raw.guild_id!==guild.id||!validId(raw.id))throw new CloneError('invalid');
  if(!canView(raw))continue;
  const parent=raw.parent_id;if(parent!=null&&!validId(parent))throw new CloneError('invalid');
  const settings:Record<string,Setting>={};
  for(const key of settingKeys){const v=raw[key]!==undefined?raw[key]:raw[snake(key)];if(v===undefined)continue;if(v!==null&&typeof v!=='boolean'&&typeof v!=='string'&&!(typeof v==='number'&&Number.isSafeInteger(v)&&v>=0))throw new CloneError('invalid');if(typeof v==='string'&&v.length>4096)throw new CloneError('invalid');settings[key]=v;}
  const emoji=(v:unknown):Detail=>{
   if(!object(v))throw new CloneError('invalid');
   const id=v.emojiId??v.emoji_id,name=v.emojiName??v.emoji_name;
   if(id!=null&&!validId(id))throw new CloneError('invalid');
   return Object.freeze({emojiId:id??null,emojiName:nullable(name)});
  };
  const reaction=raw.defaultReactionEmoji??raw.default_reaction_emoji;
  if(reaction!==undefined)settings.defaultReactionEmoji=reaction===null?null:emoji(reaction);
  const tags=raw.availableTags??raw.available_tags;
  if(tags!==undefined){
   if(!Array.isArray(tags)||tags.length>100)throw new CloneError('invalid');
   settings.availableTags=Object.freeze(tags.map(v=>{if(!object(v)||typeof v.moderated!=='boolean')throw new CloneError('invalid');return Object.freeze({...emoji(v),name:text(v.name),moderated:v.moderated});}));
  }
  channels.push(Object.freeze({id:raw.id,name:text(raw.name),type:integer(raw.type),position:integer(raw.position),parent:parent??null,overwrites:overwrites(raw.permissionOverwrites??raw.permission_overwrites),settings:Object.freeze(settings),synced:null}));
 }
 if(new Set(channels.map(c=>c.id)).size!==channels.length)throw new CloneError('invalid');
 const byId=new Map(channels.map(c=>[c.id,c]));
 const withSync=channels.map(c=>{const candidate=c.parent?byId.get(c.parent):undefined,parent=candidate?.type===4?candidate:undefined;return Object.freeze({...c,synced:parent?overwriteKey(parent.overwrites)===overwriteKey(c.overwrites):null});});
 return Object.freeze({id:guild.id,name:text(guild.name),icon:nullable(guild.icon),roles:Object.freeze(roles.sort((a,b)=>b.position-a.position||a.id.localeCompare(b.id))),channels:Object.freeze(withSync),coverage:'visible-cache',issues:Object.freeze([{code:'cache' as const,item:text(guild.name)}])});
}
