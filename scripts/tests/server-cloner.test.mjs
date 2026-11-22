import test,{after} from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';
const dir=mkdtempSync(tmpdir()+'/syncord-cloner-');after(()=>{delete globalThis.window;rmSync(dir,{recursive:true,force:true});});
await build({stdin:{resolveDir:process.cwd(),contents:`export * from './src/renderer/plugins/serverCloner/model';export * from './src/renderer/plugins/serverCloner/snapshot';export * from './src/renderer/plugins/serverCloner/verify';export * from './src/renderer/plugins/serverCloner/actions';export * from './src/renderer/plugins/serverCloner/engine';export * from './src/renderer/plugins/serverCloner/state';export * from './src/renderer/plugins/serverCloner/discord';export * from './src/renderer/plugins/serverCloner/menu';export * from './src/renderer/plugins/serverCloner';export * from './src/renderer/i18n/serverCloner';`},bundle:true,platform:'node',format:'esm',outfile:dir+'/test.mjs',logLevel:'silent',plugins:[{name:'native',setup(b){b.onResolve({filter:/\/webpack$/},()=>({path:'webpack',namespace:'fixture'}));b.onResolve({filter:/\/api\/plugin$/},()=>({path:'plugin',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path==='plugin'?'export const definePlugin=x=>x;':`export const getRequire=()=>undefined;export const findByStoreName=name=>window.stores?.[name];export const findByProps=(...keys)=>window.modules?.find(v=>v&&keys.every(key=>v[key]!==undefined));`}));}}]});
const M=await import(dir+'/test.mjs');const S='100000000000000001',T='200000000000000001',U='300000000000000001';
function fixture(base=S){const id=n=>String(BigInt(base)+BigInt(n));const overwrites={[base]:{id:base,type:0,allow:'0',deny:'1024'},[id(1)]:{id:id(1),type:0,allow:'1024',deny:'0'}};
 const role=(n,name,position)=>({id:n,name,position,permissions:'18014398509481984',color:123,hoist:false,mentionable:false,managed:false,icon:null});
 return{guild:{id:base,name:'Source <script>',icon:null,ownerId:U},roles:{[base]:role(base,'@everyone',0),[id(1)]:role(id(1),'Admin',2),[id(2)]:role(id(2),'Member',1)},channels:{[id(10)]:{id:id(10),guild_id:base,name:'STAFF',type:4,position:0,parent_id:null,permissionOverwrites:structuredClone(overwrites)},[id(11)]:{id:id(11),guild_id:base,name:'rules',type:0,position:0,parent_id:id(10),topic:'Read these rules.',nsfw:false,rateLimitPerUser:5,permissionOverwrites:structuredClone(overwrites)},[id(12)]:{id:id(12),guild_id:base,name:'voice',type:2,position:0,parent_id:null,bitrate:64000,userLimit:8,permissionOverwrites:[]}}};}
const snap=(f,visible=()=>true)=>M.makeSnapshot(f.guild,f.roles,f.channels,visible);
function runtime(){const a=fixture(),b=fixture(T),guilds={[S]:a.guild,[T]:b.guild},data={[S]:a,[T]:b};let account=U;const admins=new Set([T]),calls=[];
 globalThis.window={stores:{UserStore:{getCurrentUser:()=>({id:account})},GuildStore:{getGuild:id=>guilds[id],getGuilds:()=>guilds},GuildRoleStore:{getRolesSnapshot:id=>data[id]?.roles},ChannelStore:{getMutableGuildChannelsForGuild:id=>data[id]?.channels},PermissionStore:{can:()=>true,canWithPartialContext:(bits,ctx)=>bits===8n&&admins.has(ctx.guildId)}},modules:[]};
 return{a,b,guilds,data,admins,calls,setAccount:v=>{account=v;}};}
test('snapshot copies roles, hierarchy, topics, voice fields, overwrites and synchronized categories without retaining native data',()=>{
 const f=fixture(),original=JSON.stringify(f),s=snap(f);assert.equal(s.roles[0].name,'Admin');assert.equal(s.roles[0].permissions,'18014398509481984');assert.equal(s.channels[1].settings.topic,'Read these rules.');assert.equal(s.channels[1].synced,true);assert.equal(s.channels[2].settings.bitrate,64000);assert.equal(s.channels[2].settings.userLimit,8);assert.equal(s.coverage,'visible-cache');assert.equal(s.issues[0].code,'cache');assert.ok(Object.isFrozen(s.channels[1].settings));
 assert.equal(JSON.stringify(f),original);f.roles[S].permissions='0';f.channels[String(BigInt(S)+11n)].topic='changed';assert.equal(s.roles.at(-1).permissions,'18014398509481984');assert.equal(s.channels[1].settings.topic,'Read these rules.');
});
test('snapshots never read hidden channel content and never certify an incomplete cache as complete',()=>{
 const f=fixture(),hidden=f.channels[String(BigInt(S)+11n)];Object.defineProperty(hidden,'topic',{get(){assert.fail('hidden content read');}});const s=snap(f,c=>c!==hidden);assert.equal(s.channels.length,2);assert.equal(s.coverage,'visible-cache');assert.throws(()=>M.makeSnapshot(f.guild,{},f.channels,()=>true));assert.throws(()=>M.makeSnapshot(f.guild,f.roles,undefined,()=>true));
});
test('bitfields retain 64-bit precision, reject unsafe numbers, malformed data and overlapping allow/deny',()=>{
 assert.equal(M.bits((1n<<63n)+1024n),'9223372036854776832');for(const value of [2**54,-1,'-1','1e20','no',undefined,1n<<64n])assert.throws(()=>M.bits(value));
 const f=fixture();f.channels[String(BigInt(S)+11n)].permissionOverwrites[S].allow='1024';assert.throws(()=>snap(f));delete f.channels[String(BigInt(S)+11n)].permissionOverwrites;assert.throws(()=>snap(f));
});
test('a safe native structural copy verifies IDs through maps, never creates another everyone role or changes source',()=>{
 const source=snap(fixture()),target=snap(fixture(T)),before=JSON.stringify(source),r=M.verify(source,target);assert.equal(r.roles,3);assert.equal(r.categories,1);assert.equal(r.channels,2);assert.equal(r.permissions,true);assert.equal(r.roleIds.get(S),T);assert.equal(r.roleIds.size,3);assert.equal(r.channelIds.get(String(BigInt(S)+11n)),String(BigInt(T)+11n));assert.deepEqual(r.issues.map(i=>i.code),['cache']);assert.equal(JSON.stringify(source),before);
});
test('missing or ambiguous role mappings cannot turn a private channel into a verified public channel',()=>{
 const a=fixture(),b=fixture(T);delete b.roles[String(BigInt(T)+1n)];const r=M.verify(snap(a),snap(b));assert.equal(r.permissions,false);assert.equal(r.channels,1);assert.ok(r.issues.some(i=>i.code==='mapping'));assert.ok(r.issues.some(i=>i.code==='permissions'));
 const duplicate={...b.roles[String(BigInt(T)+2n)],id:String(BigInt(T)+3n),position:1};b.roles[duplicate.id]=duplicate;assert.equal(M.verify(snap(a),snap(b)).roleIds.has(String(BigInt(S)+2n)),false);
});
test('member overwrites and managed roles are reported; no member is implicitly transferred or remapped as a role',()=>{
 const f=fixture(),id=String(BigInt(S)+3n);f.roles[id]={...f.roles[S],id,name:'Bot',managed:true,position:3};f.channels[String(BigInt(S)+11n)].permissionOverwrites[U]={id:U,type:1,allow:'1024',deny:'0'};
 const p=M.plan(snap(f));assert.ok(p.some(i=>i.code==='managed'));assert.ok(p.some(i=>i.code==='member'));const r=M.verify(snap(f),snap(fixture(T)));assert.equal(r.roleIds.has(id),false);assert.equal(r.permissions,false);
});
test('Forum, Announcement, Stage and unknown channel types never silently become text channels',()=>{
 for(const type of [5,13,15,16,999]){const a=fixture(),b=fixture(T);a.channels[String(BigInt(S)+11n)].type=type;const p=M.plan(snap(a));assert.equal(p.some(i=>i.code==='unsupported'),type===999);const r=M.verify(snap(a),snap(b));assert.ok(r.issues.some(i=>i.code==='missing'));assert.equal(r.channels,1);b.channels[String(BigInt(T)+11n)].type=type;assert.equal(M.verify(snap(a),snap(b)).channels,2);}
});
test('topic, overwrite, hierarchy, order and synchronization mismatches stay visible in the report',()=>{
 const a=fixture(),b=fixture(T);b.channels[String(BigInt(T)+11n)].topic='wrong';b.channels[String(BigInt(T)+11n)].permissionOverwrites=[];b.roles[String(BigInt(T)+1n)].position=0;const r=M.verify(snap(a),snap(b));for(const code of ['fields','permissions','order'])assert.ok(r.issues.some(i=>i.code===code),code);assert.equal(r.permissions,false);
 const c=fixture(T);c.channels[String(BigInt(T)+11n)].parent_id=null;assert.ok(M.verify(snap(a),snap(c)).issues.some(i=>i.code==='missing'));
});
test('target list contains only current administrators, excludes source and does not require source management',()=>{
 const rt=runtime(),other='400000000000000001';rt.guilds[other]=fixture(other).guild;const s=new M.CloneSession(S);assert.equal(s.source.channels.length,3);assert.deepEqual(s.targets(),[{id:T,name:rt.b.guild.name}]);rt.admins.delete(T);assert.deepEqual(s.targets(),[]);assert.throws(()=>M.assertTarget(T,S),e=>e.code==='permission');rt.admins.add(S);assert.throws(()=>M.assertTarget(S,S));
});
function portFixture(){
 const source=snap(fixture()),raw=fixture(T);raw.roles={[T]:raw.roles[T]};raw.channels={};let seq=100n,clock=0,allowed=true;const calls=[],waits=[],cooldown={until:0};
 const port={cooldown,check:()=>{if(!allowed)throw new M.CloneError('permission');},supports:type=>[0,2,4].includes(type),snapshot:()=>snap(raw),
  async createRole(role){const id=String(BigInt(T)+seq++);raw.roles[id]={...role,id,colors:{...role.colors}};calls.push(['role',id]);return{id};},
  async updateRole(id,role){Object.assign(raw.roles[id],role,{id});calls.push(['role-update',id]);return{status:200};},
  async orderRoles(rows){for(const row of rows)raw.roles[row.id].position=row.position;calls.push(['role-order',rows]);return{status:200};},
  async createChannel(c,parent,overwrites){const id=String(BigInt(T)+seq++);raw.channels[id]={id,guild_id:T,type:c.type,name:c.name,position:c.position,parent_id:parent,permissionOverwrites:structuredClone(overwrites)};calls.push(['channel',id,structuredClone(overwrites)]);return{status:201,body:{id,guild_id:T}};},
  async updateChannel(id,c,overwrites){Object.assign(raw.channels[id],c.settings);raw.channels[id].permissionOverwrites=structuredClone(overwrites);calls.push(['channel-update',id,structuredClone(overwrites)]);return{status:200};},
  async orderChannels(rows){for(const row of rows)raw.channels[row.id].position=row.position;calls.push(['channel-order',rows]);return{status:200};}};
 return{source,raw,port,calls,waits,sleep:async(ms,signal)=>{if(signal.aborted)throw new DOMException('Stopped','AbortError');waits.push(ms);clock+=ms;},now:()=>clock,revoke:()=>{allowed=false;}};
}
test('direct native engine creates roles before categories/channels, stages privacy, preserves topics and verifies explicit mappings',async()=>{
 const f=portFixture(),states=[],engine=new M.CloneEngine(f.source,T,f.port,s=>states.push(s),f.sleep,f.now);await engine.run();const p=engine.snapshot();assert.equal(p.roles,2);assert.equal(p.categories,1);assert.equal(p.channels,2);assert.equal(p.phase,'partial');assert.equal(p.result.channels,2);assert.equal(p.result.permissions,true);
 assert.ok(f.calls.findIndex(c=>c[0]==='role-order')<f.calls.findIndex(c=>c[0]==='channel'));for(const c of f.calls.filter(c=>c[0]==='channel'))assert.deepEqual(c[2],[{id:T,type:0,allow:'0',deny:'1024'}]);assert.equal(Object.values(f.raw.channels).find(c=>c.name==='rules').topic,'Read these rules.');assert.equal(f.raw.roles[T].permissions,'18014398509481984');assert.ok(f.waits.every(ms=>ms>=500));assert.equal(engine.active(),false);
});
test('default target permissions stay unchanged; mismatches remain private, missing role mappings are skipped',async()=>{
 const f=portFixture();f.raw.roles[T].permissions='0';const engine=new M.CloneEngine(f.source,T,f.port,()=>{},f.sleep,f.now);await engine.run();assert.equal(f.raw.roles[T].permissions,'0');for(const c of Object.values(f.raw.channels))assert.ok(c.permissionOverwrites.some(row=>row.id===T&&(BigInt(row.deny)&1024n)));assert.equal(engine.snapshot().result.permissions,false);
 const raw=fixture();raw.channels[String(BigInt(S)+11n)].permissionOverwrites[U]={id:U,type:0,allow:'0',deny:'1024'};const g=portFixture(),e=new M.CloneEngine(snap(raw),T,g.port,()=>{},g.sleep,g.now);await e.run();assert.ok(!Object.values(g.raw.channels).some(c=>c.name==='rules'));assert.ok(e.snapshot().result.issues.some(i=>i.code==='mapping'));
});
test('ambiguous creation failures are not retried; failed channel configuration leaves the new channel private',async()=>{
 const f=portFixture();let attempts=0;f.port.createRole=async()=>{attempts++;throw Error('Connection reset after server acceptance');};const e=new M.CloneEngine(f.source,T,f.port,()=>{},f.sleep,f.now);await e.run();assert.equal(attempts,1);assert.equal(e.snapshot().phase,'failed');assert.equal(e.snapshot().roles,0);assert.equal(e.snapshot().channels,0);
 const g=portFixture();g.port.updateChannel=async()=>{throw Error('Denied');};const engine=new M.CloneEngine(g.source,T,g.port,()=>{},g.sleep,g.now);await engine.run();const first=Object.values(g.raw.channels)[0];assert.equal(engine.snapshot().phase,'failed');assert.equal(Object.values(g.raw.channels).length,1);assert.deepEqual(first.permissionOverwrites,[{id:T,type:0,allow:'0',deny:'1024'}]);
});
test('explicit 429 waits respect Retry-After and never overlap requests; stop and privilege loss halt subsequent actions',async()=>{
 const f=portFixture(),create=f.port.createRole;let attempts=0;f.port.createRole=async role=>{if(++attempts===1)throw{status:429,body:{retry_after:12}};return create(role);};const e=new M.CloneEngine(f.source,T,f.port,()=>{},f.sleep,f.now);await e.run();assert.ok(f.waits[0]>=12000);assert.equal(e.snapshot().roles,2);
 const g=portFixture(),gcreate=g.port.createRole;let resolve;g.port.createRole=role=>new Promise(done=>{resolve=()=>gcreate(role).then(done);});const stopped=new M.CloneEngine(g.source,T,g.port,()=>{},g.sleep,g.now),pending=stopped.run();stopped.stop();await resolve();await pending;assert.equal(stopped.snapshot().phase,'cancelled');assert.equal(stopped.snapshot().roles,1);assert.equal(g.calls.filter(c=>c[0]==='role-update').length,0);
 const h=portFixture(),hcreate=h.port.createRole;h.port.createRole=async r=>{const response=await hcreate(r);h.revoke();return response;};const revoked=new M.CloneEngine(h.source,T,h.port,()=>{},h.sleep,h.now);await assert.rejects(revoked.run(),e=>e.code==='permission');assert.equal(revoked.snapshot().channels,0);
});
test('native adapter never writes source/existing items and accepts only typed, destination-bound created IDs',async()=>{
 const rt=runtime(),writes=[],roleId='200000000000000500',channelId='200000000000000501';
 const roles={async createRole(guild,...args){writes.push(['create-role',guild,args]);return{id:roleId};},async updateRole(guild,id,data){writes.push(['update-role',guild,id,data]);return{status:200};},async batchRoleUpdate(guild,data){writes.push(['role-order',guild,data]);return{status:200};},async batchChannelUpdate(guild,data){writes.push(['channel-order',guild,data]);return{status:200};}};
 const channel={async createChannel(data){writes.push(['create-channel',data]);return{status:201,body:{id:channelId,guild_id:T}};},createRoleSubscriptionTemplateChannel(){}};
 const update={async updateChannel(id,data){writes.push(['channel-update',id,data]);return{status:200};},updatePermissionOverwrite(){},clearPermissionOverwrite(){}};window.modules=[roles,channel,update];
 const port=M.nativePort(S,T,()=>{}),role=snap(rt.a).roles[0],c=snap(rt.a).channels[1];await port.createRole(role);await port.updateRole(roleId,role);await port.createChannel(c,null,[{id:T,type:0,allow:'0',deny:'1024'}]);await port.updateChannel(channelId,c,[{id:T,type:0,allow:'0',deny:'1024'}]);assert.equal(writes[0][1],T);assert.equal(writes[2][1].guildId,T);assert.equal(writes[3][2].topic,'Read these rules.');assert.throws(()=>port.updateRole(T,role),e=>e.code==='invalid');assert.throws(()=>port.orderChannels([{id:S,position:0}]),e=>e.code==='invalid');rt.admins.delete(T);assert.throws(()=>port.updateRole(roleId,role),e=>e.code==='permission');
});
test('source snapshots, account switches, duplicate starts and disable guards cannot redirect a clone',async()=>{
 const rt=runtime(),s=new M.CloneSession(S);rt.setAccount(T);assert.throws(()=>s.targets(),e=>e.code==='account');rt.setAccount(U);s.dispose();await assert.rejects(s.run(T),e=>e.code==='account');
 const f=portFixture(),g=portFixture();let resolve;f.port.createRole=()=>new Promise(done=>{resolve=done;});const one=new M.CloneEngine(f.source,T,f.port,()=>{},f.sleep,f.now),two=new M.CloneEngine(g.source,T,g.port,()=>{},g.sleep,g.now);const pending=one.run();await assert.rejects(two.run(),e=>e.code==='busy');one.stop();resolve({id:'200000000000000900'});await pending;assert.equal(one.snapshot().phase,'cancelled');
});
test('guild context detection rejects other menus, wrong rail targets and channel contexts',()=>{
 const menu=(id,props)=>({id,__reactFiber$fixture:{memoizedProps:props}}),gesture=id=>({closest:()=>({getAttribute:()=> 'guildsnav___'+id})});assert.equal(M.menuGuild(menu('guild-context',{guild:{id:S}}),gesture(S)),S);assert.equal(M.menuGuild(menu('user-context',{guild:{id:S}}),gesture(S)),undefined);assert.equal(M.menuGuild(menu('guild-context',{guild:{id:S}}),gesture(T)),undefined);
});
test('registration, non-core lifecycle, 18 catalogs and absence of removed workflow / credential / custom HTTP code',()=>{
 assert.equal(M.ServerCloner.id,'server-cloner');assert.equal(M.ServerCloner.enabledByDefault,false);assert.notEqual(M.ServerCloner.core,true);assert.equal(M.ServerCloner.permissions.network,undefined);assert.equal(M.ServerCloner.permissions.native,undefined);assert.ok(M.ServerCloner.permissions.discordActions.includes('guild-channel-create'));assert.equal((readFileSync('src/renderer/plugins/index.ts','utf8').match(/import "\.\/serverCloner"/g)||[]).length,1);
 for(const [locale,rows]of Object.entries(M.serverClonerMessages)){assert.equal(rows.length,M.serverClonerKeys.length,locale);assert.ok(rows.every(s=>s.trim()),locale);}assert.equal(Object.keys(M.serverClonerMessages).length,18);
 const sources=['state','discord','actions','engine','ui'].map(file=>readFileSync('src/renderer/plugins/serverCloner/'+file+'.ts','utf8')).join('\n');assert.doesNotMatch(sources,/openTemplate|resolveGuildTemplate|GUILD_TEMPLATES|fetch\(|\.post\(/);
});

test('native channel fields omit unrelated record defaults and terminal rate limits survive a session',async()=>{
 const c=snap(fixture()).channels[0],settings={topic:'text',nsfw:false,bitrate:64000,userLimit:8,defaultForumLayout:1,defaultSortOrder:0,flags:123};
 assert.deepEqual(M.channelFields({...c,type:4,settings}),{});
 assert.deepEqual(M.channelFields({...c,type:2,settings}),{nsfw:false,bitrate:64000,user_limit:8});
 assert.deepEqual(M.channelFields({...c,type:16,settings}),{topic:'text',nsfw:false,default_sort_order:0});
 const f=portFixture();let calls=0;f.port.createRole=async()=>{calls++;throw{status:429,body:{retry_after:12}};};const e=new M.CloneEngine(f.source,T,f.port,()=>{},f.sleep,f.now);await e.run();assert.equal(calls,3);assert.equal(e.snapshot().phase,'failed');assert.ok(f.port.cooldown.until>=f.now()+12000);
});

test('pacing reduces idle time, spreads advertised budgets and slows after native rate limits',async()=>{
 const f=portFixture();await new M.CloneEngine(f.source,T,f.port,()=>{},f.sleep,f.now).run();assert.ok(f.waits.length>0);assert.ok(f.waits.every(ms=>ms===500));assert.equal(f.waits.reduce((a,b)=>a+b,0),500*(f.calls.length-1));
 const g=portFixture(),create=g.port.createRole;let first=true;g.port.createRole=async role=>{const value=await create(role);if(first){first=false;return{...value,headers:{'x-ratelimit-remaining':'2','x-ratelimit-reset-after':'4'}};}return value;};await new M.CloneEngine(g.source,T,g.port,()=>{},g.sleep,g.now).run();assert.equal(g.waits[0],2050);
 const h=portFixture(),hcreate=h.port.createRole;let attempt=0;h.port.createRole=async role=>{if(++attempt===1)throw{httpStatus:429,retryAfter:3};return hcreate(role);};await new M.CloneEngine(h.source,T,h.port,()=>{},h.sleep,h.now).run();assert.ok(h.waits[0]>=3000);assert.ok(h.waits.slice(1).every(ms=>ms>=750));
 const slow=portFixture(),slowcreate=slow.port.createRole;slow.port.createRole=async role=>{await slow.sleep(800,new AbortController().signal);return slowcreate(role);};await new M.CloneEngine(slow.source,T,slow.port,()=>{},slow.sleep,slow.now).run();assert.equal(slow.waits.filter(ms=>ms===500).length,slow.calls.length-3);
});
