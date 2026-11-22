import {findByProps,findByStoreName} from '../../webpack';
import {CloneError,object,validId,type Snapshot} from './model';
import {makeSnapshot} from './snapshot';
export function store<T>(name:string):T|undefined{return ((window.Syncord?.common?.stores as unknown as Record<string,unknown>|undefined)?.[name]??findByStoreName(name)) as T|undefined;}
type Guild={id:string;name:string;ownerId?:string;owner_id?:string;unavailable?:boolean};
type Guilds={getGuild:(id:string)=>Guild|undefined;getGuilds:()=>Record<string,Guild>};
export function accountId():string|undefined {const id=store<{getCurrentUser?:()=>{id?:unknown}|null}>('UserStore')?.getCurrentUser?.()?.id;return validId(id)?id:undefined;}
export function assertAccount(expected:string):void{if(accountId()!==expected)throw new CloneError('account');}
export function guilds():Record<string,Guild>{const data=store<Guilds>('GuildStore')?.getGuilds?.();if(!object(data))throw new CloneError('unavailable');return data;}
export function assertGuild(id:string):Guild {
 if(!validId(id))throw new CloneError('invalid');
 const guild=store<Guilds>('GuildStore')?.getGuild?.(id);
 if(!guild||guild.id!==id||guild.unavailable)throw new CloneError('unavailable');
 return guild;
}
export function isAdministrator(id:string):boolean {
 assertGuild(id);
 return store<{canWithPartialContext?:(bits:bigint,context:{guildId:string})=>boolean}>('PermissionStore')?.canWithPartialContext?.(8n,{guildId:id})===true;
}
export function assertTarget(id:string,source:string):void{if(id===source||!isAdministrator(id))throw new CloneError('permission');}
export function targetSupports(id:string,type:number):boolean {
 if([0,2,4].includes(type))return true;
 if(![5,13,15,16].includes(type))return false;
 const guild=assertGuild(id) as Guild&{features?:{has?:(flag:string)=>boolean}|readonly string[]};
 return Array.isArray(guild.features)?guild.features.includes('COMMUNITY'):(guild.features as {has?:(flag:string)=>boolean}|undefined)?.has?.('COMMUNITY')===true;
}
export function readSnapshot(id:string):Snapshot {
 const guild=assertGuild(id),roles=store<{getRolesSnapshot?:(id:string)=>unknown;getRoles?:(id:string)=>unknown}>('GuildRoleStore');
 const channels=store<{getMutableGuildChannelsForGuild?:(id:string)=>unknown}>('ChannelStore');
 const permissions=store<{can?:(bits:bigint,channel:unknown)=>boolean}>('PermissionStore');
 if(typeof permissions?.can!=='function')throw new CloneError('unavailable');
 return makeSnapshot(guild,roles?.getRolesSnapshot?.(id)??roles?.getRoles?.(id),channels?.getMutableGuildChannelsForGuild?.(id),raw=>permissions.can!(1024n,raw)===true);
}
export function openSettings(id:string,section:'ROLES'|'CHANNELS'):unknown {
 if(!isAdministrator(id))throw new CloneError('permission');
 const actions=findByProps('open','init','saveGuild','setSection') as {open?:(id:string,section:string)=>unknown}|undefined;
 if(typeof actions?.open!=='function')throw new CloneError('unavailable');
 return actions.open(id,section);
}
export function watchStore(name:string,listener:()=>void):()=>void {
 const value=store<{addChangeListener?:(fn:()=>void)=>void;removeChangeListener?:(fn:()=>void)=>void}>(name);
 if(typeof value?.addChangeListener!=='function'||typeof value.removeChangeListener!=='function')return()=>{};
 try{value.addChangeListener(listener);}catch{value.removeChangeListener(listener);}
 return()=>value.removeChangeListener?.(listener);
}
