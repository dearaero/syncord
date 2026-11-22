import {overwriteKey,plan,type Snapshot,type Role,type Channel,type Issue} from './model';
export type Result={roles:number;categories:number;channels:number;permissions:boolean;issues:Issue[];roleIds:Map<string,string>;channelIds:Map<string,string>};
const equal=(a:unknown,b:unknown):boolean=>JSON.stringify(a)===JSON.stringify(b);
const roleFields=(r:Role):unknown=>[r.name,r.permissions,r.color,r.hoist,r.mentionable,r.icon,r.unicodeEmoji,r.colors];
export function verify(source:Snapshot,target:Snapshot,known?:{roleIds:ReadonlyMap<string,string>;channelIds:ReadonlyMap<string,string>}):Result {
 const result:Result={roles:0,categories:0,channels:0,permissions:true,issues:plan(source).filter(i=>i.code!=='unsupported'),roleIds:new Map([[source.id,target.id]]),channelIds:new Map()};
 const issue=(code:Issue['code'],item:string):void=>{result.issues.push({code,item});};
 const usedRoles=new Set([target.id]);
 const roleNames=new Map<string,Role[]>();for(const role of target.roles){const group=roleNames.get(role.name)??[];group.push(role);roleNames.set(role.name,group);}
 for(const role of source.roles){
  if(role.managed)continue;
  let candidates=known?target.roles.filter(r=>r.id===known.roleIds.get(role.id)):role.id===source.id?target.roles.filter(r=>r.id===target.id):(roleNames.get(role.name)??[]).filter(r=>!r.managed&&!usedRoles.has(r.id));
  if(candidates.length>1)candidates=candidates.filter(r=>r.position===role.position&&equal(roleFields(r),roleFields(role)));
  if(candidates.length!==1){issue('mapping',role.name);result.permissions=false;continue;}
  const found=candidates[0]!;result.roleIds.set(role.id,found.id);usedRoles.add(found.id);
  if(equal(roleFields(role),roleFields(found)))result.roles++;else{issue('fields',role.name);result.permissions=false;}
 }
 const sourceOrder=source.roles.filter(r=>!r.managed).map(r=>result.roleIds.get(r.id)).filter(Boolean);
 const targetOrder=target.roles.filter(r=>usedRoles.has(r.id)).map(r=>r.id);
 if(!equal(sourceOrder,targetOrder))issue('order',source.name);
 const usedChannels=new Set<string>();
 const channelKey=(c:Pick<Channel,'parent'|'type'|'name'>):string=>JSON.stringify([c.parent,c.type,c.name]);
 const channelIndex=new Map<string,Channel[]>();for(const channel of target.channels){const key=channelKey(channel),group=channelIndex.get(key)??[];group.push(channel);channelIndex.set(key,group);}
 for(const categoryPass of [true,false])for(const channel of source.channels){
  if((channel.type===4)!==categoryPass)continue;
  const parent=channel.parent===null?null:result.channelIds.get(channel.parent);
  if(parent===undefined){issue('mapping',channel.name);result.permissions=false;continue;}
  let candidates=(channelIndex.get(channelKey({...channel,parent}))??[]).filter(c=>!usedChannels.has(c.id)&&(!known||c.id===known.channelIds.get(channel.id)));
  if(candidates.length>1)candidates=candidates.filter(c=>c.position===channel.position&&equal(c.settings,channel.settings));
  if(candidates.length!==1){issue('missing',channel.name);result.permissions=false;continue;}
  const found=candidates[0]!;result.channelIds.set(channel.id,found.id);usedChannels.add(found.id);
  const mapped=channel.overwrites.map(row=>row.type===0&&result.roleIds.has(row.id)?{...row,id:result.roleIds.get(row.id)!}:undefined);
  const permissionMatch=mapped.every(row=>row!==undefined)&&overwriteKey(mapped.filter(row=>row!==undefined))===overwriteKey(found.overwrites);
  if(!permissionMatch){issue('permissions',channel.name);result.permissions=false;}
  const fields=Object.entries(channel.settings).every(([k,v])=>equal(v,found.settings[k]));
  if(!fields)issue('fields',channel.name);
  if(channel.synced!==null&&channel.synced!==found.synced){issue('permissions',channel.name);result.permissions=false;}
  if(permissionMatch&&fields&&channel.synced===found.synced){if(categoryPass)result.categories++;else result.channels++;}
 }
 const groups=(all:readonly Channel[],mapped:boolean):Map<string,Channel[]>=>{
  const output=new Map<string,Channel[]>();for(const c of all){if(mapped?!result.channelIds.has(c.id):!usedChannels.has(c.id))continue;
   const parent=mapped&&c.parent!==null?result.channelIds.get(c.parent):c.parent;
   if(parent===undefined)continue;const key=JSON.stringify([parent,c.type]),group=output.get(key)??[];group.push(c);output.set(key,group);
  }for(const group of output.values())group.sort((a,b)=>a.position-b.position||a.id.localeCompare(b.id));return output;
 };
 const expected=groups(source.channels,true),actual=groups(target.channels,false);
 for(const [key,group]of expected)if(!equal(group.map(c=>result.channelIds.get(c.id)),actual.get(key)?.map(c=>c.id)))issue('order',group[0]!.name);
 for(const role of target.roles)if(!role.managed&&!usedRoles.has(role.id)){issue('fields',role.name);result.permissions=false;}
 for(const channel of target.channels)if(!usedChannels.has(channel.id)){issue('fields',channel.name);result.permissions=false;}
 // Visible cache comparisons never prove that an entire guild was cloned.
 return result;
}
