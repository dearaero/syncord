import {object,snowflake} from './model';
function store(name:string):Record<string,unknown>|undefined{try{const common=window.Syncord?.common?.stores as Record<string,unknown>|undefined;const value=common?.[name]??window.Syncord?.webpack?.findByStoreName(name);return object(value)?value:undefined;}catch{return;}}
export function accountId():string|undefined{try{const users=store('UserStore') as {getCurrentUser?:()=>{id?:unknown}}|undefined;const id=users?.getCurrentUser?.()?.id;return snowflake(id)?id:undefined;}catch{return;}}
export type Target={id:string;participants:string[]};
export function target(id:unknown):Target|undefined{
 if(!snowflake(id))return;try{const channels=store('ChannelStore') as {getChannel?:(id:string)=>unknown}|undefined;const channel=channels?.getChannel?.(id),me=accountId();if(!me||!object(channel)||![1,3].includes(Number(channel.type))||channel.guild_id)return;
 const values=Array.isArray(channel.recipients)?channel.recipients:typeof channel.getRecipientIds==='function'?(channel.getRecipientIds as ()=>unknown).call(channel):undefined;
 if(!Array.isArray(values)||values.some(v=>!snowflake(v)))return;
 const participants=[...new Set([me,...values as string[]])];if(participants.length<2||participants.length>11)return;return {id,participants};
 }catch{return;}
}
export function cachedUser(id:string):Record<string,unknown>|undefined{
 try{const users=store('UserStore') as {getUser?:(id:string)=>unknown}|undefined,user=users?.getUser?.(id);return object(user)&&user.id===id?user:undefined;}catch{return;}
}
export function display(id:string):{name:string;avatar?:string}{
 try{const user=cachedUser(id);if(!user)return {name:id};
 const name=typeof user.globalName==='string'?user.globalName:typeof user.username==='string'?user.username:id;
 let avatar:unknown;if(typeof user.getAvatarURL==='function')avatar=(user.getAvatarURL as (...args:unknown[])=>unknown).call(user,undefined,64,false);
 if(typeof avatar==='string'&&/^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\//.test(avatar))return {name,avatar};return {name};
 }catch{return {name:id};}
}

export function current():Target|undefined{try{const selected=store('SelectedChannelStore') as {getChannelId?:()=>unknown}|undefined;return target(selected?.getChannelId?.());}catch{return;}}
