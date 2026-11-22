type Channel={id:string;guild_id?:string;guildId?:string;type?:number};
/** Require actual view permission even if a hidden-channel plugin patches can(). */
export function canViewChannel(id:string):boolean {
  try {
    const stores=window.Syncord?.common?.stores;
    const channels=stores?.ChannelStore as {getChannel?:(id:string)=>Channel|undefined}|undefined;
    const channel=channels?.getChannel?.(id);if(!channel)return false;
    if(!channel.guild_id&&!channel.guildId)return channel.type===1||channel.type===3;
    const permissions=stores?.PermissionStore as {computePermissions?:(channel:Channel)=>unknown;can?:(bit:bigint,channel:Channel)=>boolean}|undefined;
    if(typeof permissions?.computePermissions==='function') {
      const raw=permissions.computePermissions(channel);
      const bits=typeof raw==='bigint'?raw:typeof raw==='string'&&/^\d{1,30}$/.test(raw)?BigInt(raw)
        :typeof raw==='number'&&Number.isSafeInteger(raw)?BigInt(raw):undefined;
      return bits!==undefined&&((bits&8n)!==0n||(bits&1024n)!==0n);
    }
    return permissions?.can?.(1024n,channel)===true;
  } catch{return false;}
}
