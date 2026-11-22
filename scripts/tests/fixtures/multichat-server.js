import './multichat-media';
import { listChannelChoices } from '../../../src/renderer/plugins/multiChatCanvas/discord';

const guildA = '700000000000000001', guildB = '700000000000000002';
const ids = Object.fromEntries(['text','announcement','publicThread','privateThread','announcementThread','readOnly','hidden','voice','category','forum','media','cachedThread','getterGuild','otherServer'].map((name, index) => [name, String(800000000000000001n + BigInt(index))]));
const channels = Object.fromEntries(Object.entries(ids).map(([name, id]) => [id, {
  id, name, guild_id:guildA, type:0,
}]));
Object.assign(channels[ids.text], {name:'general', parent_id:ids.category});
Object.assign(channels[ids.category], {name:'Community', type:4});
Object.assign(channels[ids.announcement], {type:5});
for (const [name, type] of [['publicThread',11],['privateThread',12],['announcementThread',10],['cachedThread',11]]) Object.assign(channels[ids[name]], {type,parent_id:ids.text});
for (const [name,type] of [['voice',2],['forum',15],['media',16]]) channels[ids[name]].type=type;
Object.assign(channels[ids.getterGuild], {guild_id:undefined,getGuildId:()=>guildB});
Object.assign(channels[ids.otherServer], {name:'general',guild_id:guildB});
window.serverIds=ids;
window.serverChannels=channels;
window.deniedChannels=[];
window.fetched=[];
window.nativeDraft='Native Discord draft';
const stores=window.Syncord.common.stores;
const originalGetChannel=stores.ChannelStore.getChannel;
const originalIds=stores.ChannelStore.getChannelIds;
stores.ChannelStore={
  getChannel:id=>channels[id]??originalGetChannel(id),
  // Current Discord: an omitted guild ID enumerates only DMs.
  getChannelIds:guildId=>guildId?Object.values(channels).filter(c=>c.guild_id===guildId&&c.type!==11&&c.type!==12&&c.type!==10).map(c=>c.id):originalIds(),
  getMutableBasicGuildChannelsForGuild:guildId=>Object.fromEntries(Object.entries(channels).filter(([id,c])=>c.guild_id===guildId&&c.type!==11&&c.type!==12&&c.type!==10)),
  getMutableGuildChannelsForGuild:guildId=>Object.fromEntries(Object.entries(channels).filter(([id,c])=>c.guild_id===guildId&&c.type!==11&&c.type!==12&&c.type!==10)),
  getAllThreadsForGuild:guildId=>Object.values(channels).filter(c=>c.guild_id===guildId&&[10,11,12].includes(c.type)&&c.id!==ids.cachedThread),
};
stores.GuildStore={getGuildIds:()=>[guildA,guildB],getGuilds:()=>({[guildA]:{id:guildA,name:'First Server'},[guildB]:{id:guildB,name:'Second Server'}}),getGuild:id=>stores.GuildStore.getGuilds()[id]};
stores.PermissionStore={
  computePermissions(channel){
    if(channel.id===ids.hidden) return 0n;
    const view=1n<<10n;
    if(channel.id===ids.readOnly || window.deniedChannels.includes(channel.id)) return view;
    return view | (1n<<([10,11,12].includes(channel.type)?38n:11n));
  },
  // ShowHiddenChannels may patch this to return true for VIEW_CHANNEL.
  can:()=>true,
};
stores.GuildMemberStore={getNick:(guildId,userId)=>guildId===guildA?'Server Nick':null};
const originalMessages=stores.MessageStore.getMessages;
stores.MessageStore.getMessages=id=>channels[id]?{_array:window.fetched.includes(id)?[{id:'server-message',channel_id:id,content:'Message in '+channels[id].name,author:{id:'user',username:'User'},timestamp:new Date().toISOString()}]:[],ready:window.fetched.includes(id),hasMoreBefore:false}:originalMessages(id);
stores.DraftStore={saveDraft:()=>{throw new Error('Must not write native drafts')},getDraft:()=>window.nativeDraft};
const actions=window.Syncord.common.actions.MessageActions;
actions.fetchMessages=async function(options){if(this!==actions)throw new Error('fetchMessages owner lost');window.fetched.push(options.channelId);};
const originalSend=actions.sendMessage;
actions.sendMessage=async function(...args){if(this!==actions)throw new Error('sendMessage owner lost');return originalSend.apply(this,args)};
// This channel is resolvable by ID, but intentionally absent from every list.
for(const method of ['getChannelIds','getMutableBasicGuildChannelsForGuild','getMutableGuildChannelsForGuild']) {
  const original=stores.ChannelStore[method];
  stores.ChannelStore[method]=guildId=>{
    const result=original(guildId);
    return Array.isArray(result)?result.filter(id=>id!==ids.getterGuild):Object.fromEntries(Object.entries(result).filter(([id])=>id!==ids.getterGuild));
  };
}
window.getServerChoices=query=>listChannelChoices(query).map(({id,label,sublabel,kind})=>({id,label,sublabel,kind}));
