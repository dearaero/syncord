import { canonicalMessage as i18nText } from "../../i18n";
import {isDiscordRestApi} from '../../webpack/common/rest';
import {validId,type RestResponse} from '../messageCleaner/engine';
import {validatePlan,type Plan,type Target,type Port} from './engine';
type Channel={id:string;type:number;name?:string;guild_id?:string;guildId?:string;recipients?:string[]};
type Guild={id:string;name?:string;ownerId?:string;owner_id?:string;owner?:boolean};
type Channels={getChannel?(id:string):Channel|undefined;getMutablePrivateChannels?():Record<string,Channel>;getSortedPrivateChannels?():Channel[]};
type Guilds={getGuilds?():Record<string,Guild>;getGuild?(id:string):Guild|undefined};
type Users={getCurrentUser?():{id?:string};getUser?(id:string):{globalName?:string;global_name?:string;username?:string}|undefined};
function store<T>(name:string):T|undefined{
  const common=window.Syncord?.common?.stores as unknown as Record<string,unknown>|undefined;
  return (common?.[name]??window.Syncord?.webpack?.findByStoreName?.(name)) as T|undefined;
}
export function assertAccount(id:string):void{
  if(!validId(id)||store<Users>('UserStore')?.getCurrentUser?.()?.id!==id)throw new Error('Your Discord account changed or is unavailable. Closing stopped.');
}
function ownership(g:Guild,userId:string):'owned'|'other'|'unknown'{
  // Conflicting or missing metadata fails closed. Never offer deleting a server.
  const raw=[g.ownerId,g.owner_id].filter(v=>v!==undefined&&v!==null),ids=raw.filter(validId);
  if(g.owner===true||ids.includes(userId))return'owned';
  return ids.length===raw.length&&ids.length>0&&new Set(ids).size===1?'other':'unknown';
}
function privateChannel(c:Channel):boolean{return validId(c.id)&&[1,3].includes(c.type)&&!c.guild_id&&!c.guildId;}
export function closingPlan(includeGuilds:boolean):Plan{
  const users=store<Users>('UserStore'),userId=users?.getCurrentUser?.()?.id;
  if(!validId(userId))throw new Error('Discord’s account is not ready. Try again after Discord loads.');
  const channels=store<Channels>('ChannelStore');
  const values=channels?.getMutablePrivateChannels?.()??channels?.getSortedPrivateChannels?.();
  if(!values||typeof values!=='object'||!channels?.getChannel)throw new Error('Discord’s DM list is not ready. Open Direct Messages and try again.');
  const targets:Target[]=[],seen=new Set<string>();
  for(const c of Object.values(values)){
    if(!c||!privateChannel(c)||seen.has(c.id))continue;seen.add(c.id);
    const peer=c.type===1&&c.recipients?.[0]?users?.getUser?.(c.recipients[0]):undefined;
    targets.push({id:c.id,kind:c.type===1?'dm':'group',name:(c.name||peer?.globalName||peer?.global_name||peer?.username||(c.type===1?'DM':'Group DM')).slice(0,200)});
  }
  const plan:Plan={userId,includeGuilds,targets,owned:0,unknown:0};
  if(includeGuilds){
    const guildStore=store<Guilds>('GuildStore'),guilds=guildStore?.getGuilds?.();
    if(!guilds||typeof guilds!=='object'||!guildStore?.getGuild)throw new Error('Discord’s server list is not ready. Try again after Discord loads.');
    for(const g of Object.values(guilds)){
      if(!g||!validId(g.id)||seen.has(g.id))continue;seen.add(g.id);
      const owner=ownership(g,userId);
      if(owner==='owned'){plan.owned++;continue;}
      if(owner==='unknown'){plan.unknown++;continue;}
      targets.push({id:g.id,kind:'guild',name:(g.name||'Server').slice(0,200)});
    }
  }
  assertAccount(userId);validatePlan(plan);return plan;
}
export function inspectTarget(target:Target,userId:string):string|undefined{
  assertAccount(userId);
  if(!validId(target.id))throw new Error('Invalid closing target.');
  if(target.kind==='guild'){
    const guilds=store<Guilds>('GuildStore');if(!guilds?.getGuild)throw new Error('Discord’s server list became unavailable.');
    const guild=guilds.getGuild(target.id);if(!guild)return i18nText("ui.already_left_or_unavailable");
    if(guild.id!==target.id)return i18nText("ui.server_identity_changed");
    const owner=ownership(guild,userId);return owner==='owned'?i18nText("ui.owned_server_kept"):owner==='unknown'?i18nText("ui.ownership_unknown_kept"):undefined;
  }
  const channels=store<Channels>('ChannelStore');if(!channels?.getChannel)throw new Error('Discord’s DM list became unavailable.');
  const c=channels.getChannel(target.id);if(!c)return i18nText("ui.already_closed_or_unavailable");
  if(c.id!==target.id||!privateChannel(c)||c.type!==(target.kind==='dm'?1:3))return i18nText("ui.chat_type_changed_kept");
}
export function discordPort(log:{warn(...args:unknown[]):void}):Port{
  const preferred=window.Syncord?.common?.utils?.RestAPI;
  const candidate=isDiscordRestApi(preferred)?preferred:window.Syncord?.webpack?.find?.(isDiscordRestApi);
  if(!isDiscordRestApi(candidate))throw new Error('Discord’s API is not ready. Try again after Discord loads.');
  const rest=candidate as unknown as {del(options:Record<string,unknown>):Promise<RestResponse>};
  const dispatcher=(window.Syncord?.common?.flux?.FluxDispatcher??window.Syncord?.webpack?.findByProps?.('dispatch','subscribe')) as {dispatch?(event:unknown):unknown}|undefined;
  if(!dispatcher?.dispatch)throw new Error('Discord’s event dispatcher is not ready. Try again after Discord loads.');
  return{
    assertAccount,inspect:inspectTarget,
    request(target,userId){
      const skip=inspectTarget(target,userId);if(skip)throw new Error(`Target changed: ${skip}. Refresh the list.`);
      // Guard and native request share a synchronous call stack. No native
      // closePrivateChannel action: it removes UI optimistically and swallows errors.
      return rest.del({url:target.kind==='guild'?`/users/@me/guilds/${target.id}`:`/channels/${target.id}`,
        ...(target.kind==='guild'?{body:{lurking:false}}:{query:{silent:false}}),
        retries:0,oldFormErrors:true,rejectWithError:true,failImmediatelyWhenRateLimited:true});
    },
    acknowledged(target,userId){
      assertAccount(userId);
      try{
        // Same native Flux shapes, only after HTTP acknowledgement. The gateway
        // can deliver the same idempotent removal before or after this dispatch.
        void Promise.resolve(dispatcher.dispatch!(target.kind==='guild'?{type:'GUILD_DELETE',guild:{id:target.id}}:
          {type:'CHANNEL_DELETE',channel:{id:target.id,guild_id:undefined,parent_id:undefined},silent:false})).catch(error=>log.warn('Closing cache update failed',error));
      }catch(error){log.warn('Closing cache update failed',error);}
    },
  };
}
