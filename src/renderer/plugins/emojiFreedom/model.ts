export type Media = {id:string;name?:string;animated?:boolean;available?:boolean;guild_id?:string;guildId?:string;format_type?:number;type?:number};
export type Alternative = {kind:'native'}|{kind:'link';url:string}|{kind:'unsupported'};
export const native:Alternative={kind:'native'};
export function mediaAlternative(kind:'emoji'|'sticker',media:Media,blocked:boolean):Alternative {
  if(!blocked||!/^\d{17,20}$/.test(media.id)||media.available===false)return native;
  if(kind==='emoji')return {kind:'link',url:`https://cdn.discordapp.com/emojis/${media.id}.${media.animated?'gif':'png'}?size=128&quality=lossless`};
  switch(media.format_type){
    case 1:case 2:return {kind:'link',url:`https://media.discordapp.net/stickers/${media.id}.png?size=320&passthrough=true`};
    case 4:return {kind:'link',url:`https://media.discordapp.net/stickers/${media.id}.gif?size=320`};
    case 3:return {kind:'unsupported'};
    default:return native;
  }
}
