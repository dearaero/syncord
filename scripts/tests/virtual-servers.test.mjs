import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(path.join(tmpdir(),'syncord-virtual-model-'));
await build({stdin:{resolveDir:process.cwd(),contents:`export * from './src/renderer/plugins/virtualServers/model';export * from './src/renderer/plugins/virtualServers/discord';export * from './src/renderer/plugins/virtualServers/projection';export * from './src/renderer/i18n/virtualServers';`},bundle:true,platform:'neutral',format:'esm',outfile:path.join(dir,'model.mjs'),logLevel:'silent'});
const M=await import(pathToFileURL(path.join(dir,'model.mjs')).href);test.after(()=>rmSync(dir,{recursive:true,force:true}));
const A={guildId:'10',channelId:'11'},B={guildId:'20',channelId:'21'},raw={id:'virtual:trial',name:'My Space',channels:[A,B]};
const R={createElement:(type,props,...children)=>({type,props:{...props,children}}),cloneElement:(node,props)=>({...node,props:{...node.props,...props}}),isValidElement:n=>!!n&&typeof n==='object'&&'type'in n&&'props'in n};
test('metadata is bounded, deduplicated and stripped of channel/member/message data',()=>{
 const input=structuredClone({...raw,members:['secret'],messages:['no']});input.channels[0].guild_id='wrong';input.channels[0].parentId='native';const before=JSON.stringify(input),normalized=M.normalizeTrial(input);assert.deepEqual(normalized,raw);assert.equal(JSON.stringify(input),before);
 for(const value of [null,{}, {...raw,id:'10'},{...raw,name:' '},{...raw,channels:[A,{...B,channelId:'../../x'}]},{...raw,channels:Array.from({length:101},()=>A)}])assert.equal(M.normalizeTrial(value),undefined);
 assert.deepEqual(M.normalizeTrial({...raw,channels:[]}).channels,[]);assert.equal(M.normalizeTrial({...raw,channels:[A,A]}).channels.length,1);
 assert.equal(M.normalizeTrial({...raw,name:'x'.repeat(200)}).name.length,48);assert.equal(M.snowflake('18446744073709551616'),false);
});
test('virtual selection keeps actual guild/channel routes and cannot reactivate on a matching external deep link',()=>{
 const nav=new M.VirtualNavigation(()=>raw);nav.settle({pathname:M.routeFor(A),key:'ordinary'},'PUSH');assert.equal(nav.active,false);
 nav.begin(A);nav.settle({pathname:M.routeFor(A),key:'a'},'PUSH');assert.equal(nav.active,true);assert.equal(nav.selected,'11');nav.confirm({pathname:M.routeFor(A),key:'a'});assert.equal(nav.active,true);
 nav.begin(B);nav.settle({pathname:M.routeFor(B),key:'b'},'PUSH');assert.equal(nav.active,true);assert.equal(nav.selected,'21');
 nav.settle({pathname:'/channels/@me',key:'home'},'PUSH');assert.equal(nav.active,false);
 nav.settle({pathname:M.routeFor(B),key:'b'},'POP');assert.equal(nav.active,true);
 nav.settle({pathname:M.routeFor(A),key:'external'},'PUSH');assert.equal(nav.active,false);
 nav.begin(B);nav.settle({pathname:M.routeFor(A),key:'redirect'},'REPLACE');assert.equal(nav.active,false);
 nav.reset();nav.settle({pathname:M.routeFor(B),key:'b'},'POP');assert.equal(nav.active,false);
});
test('permissions and membership are native read-only checks; mismatches, unknown/hidden channels fail closed',()=>{
 let view=true,member=true;const channels={'11':Object.freeze({id:'11',guild_id:'10',parent_id:'99',type:0,name:'general'}),'21':Object.freeze({id:'21',guild_id:'20',type:5,name:'coding'})};
 const before=JSON.stringify(channels);globalThis.window={Syncord:{common:{stores:{UserStore:{getCurrentUser:()=>({id:'100'})},ChannelStore:{getChannel:id=>channels[id]},GuildStore:{getGuild:id=>member&&['10','20'].includes(id)?{id,name:'real'}:null},PermissionStore:{can:(bit,c)=>{assert.equal(bit,1024n);assert.strictEqual(c,channels[c.id]);return view;}},ReadStateStore:{hasUnread:()=>true,getMentionCount:()=>3}}}}};
 assert.equal(M.accountId(),'100');assert.strictEqual(M.channelFor(A),channels['11']);assert.deepEqual(M.resolveChannel('21'),B);assert.deepEqual(M.unread(A),{unread:true,mentions:3});assert.equal(M.channelFor({...A,guildId:'20'}),undefined);
 view=false;assert.equal(M.channelFor(A),undefined);assert.deepEqual(M.unread(A),{unread:false,mentions:0});view=true;member=false;assert.equal(M.resolveChannel('11'),undefined);assert.equal(JSON.stringify(channels),before);
 delete window.Syncord.common.stores.PermissionStore;assert.equal(M.channelFor(A),undefined);delete globalThis.window;
});
test('missing native helpers fail closed before Discord modules hydrate',()=>{
 globalThis.window={Syncord:{common:{stores:{}},webpack:{getRequire:()=>undefined}}};
 assert.equal(M.accountId(),undefined);assert.equal(M.resolveChannel('11'),undefined);assert.equal(M.routing(),undefined);assert.equal(M.store('UserStore'),undefined);delete globalThis.window;
});
test('sidebar projection modifies only the native nav presentation and leaves native context objects unchanged',()=>{
 const guild=Object.freeze({id:'10'}),chat=Object.freeze({type:'NativeChat',props:{guildId:'10',channelId:'11'}}),members=Object.freeze({type:'NativeMembers',props:{guildId:'10'}});
 const nav=Object.freeze({type:'nav',props:Object.freeze({className:'native-sidebar',onContextMenu:()=>{},children:'original'})});const layout={chat,members,nav};
 const instance={props:{guild},render(){return nav;},renderChannelList(){},renderGuildHeader(){},getGuildBannerHash(){},forceUpdate(){}};assert.equal(M.isSidebar(instance),true);
 const virtual=M.projectSidebar(nav,R,'two local rows','My Space');assert.equal(virtual.props.className,'native-sidebar');assert.equal(virtual.props.children,'two local rows');assert.equal(virtual.props.onContextMenu,undefined);assert.equal(nav.props.children,'original');assert.strictEqual(layout.chat,chat);assert.strictEqual(layout.members,members);assert.strictEqual(instance.props.guild,guild);
 assert.strictEqual(M.projectSidebar(chat,R,'anything','My Space'),chat);assert.equal(M.isSidebar({props:{guild},render(){}}),false);
});
test('all 18 locales support the create and channel-management flow; no privileged bridge or alternate chat is installed',()=>{
 for(const locale of ['en-US','es-ES','de','ja','fr','pt-BR','ru','it','nl','pl','tr','zh-CN','id','fa','cs','vi','ko','uk']){const catalog=M.virtualServersCatalog(locale);assert.equal(Object.keys(catalog).length,18);for(const value of Object.values(catalog))assert.ok(value.trim());}
 const index=readFileSync('src/renderer/plugins/virtualServers/index.ts','utf8');assert.match(index,/enabledByDefault:false/);assert.doesNotMatch(index,/SyncordNative|new RTCPeerConnection|setInterval|fetch\(|MessageStore|GuildMemberStore/);
 assert.equal(readFileSync('src/renderer/plugins/index.ts','utf8').split('import "./virtualServers"').length-1,1);
});

test('current minified native Routing/Utils resolves by semantic function source, independently of the observer',()=>{
 const calls=[];const nativeHistory={location:{pathname:'/channels/@me'},push:path=>calls.push(['push',path]),replace:path=>calls.push(['replace',path])};
 const logger=()=>{};
 // Same structural signals as the inspected native function; its export key is arbitrary.
 function q9(path){const url=new URL(path,'https://discord.com');logger('transitionTo - Transitioning to');if(nativeHistory.location.pathname===url.pathname)nativeHistory.replace(path);else nativeHistory.push(path);}
 const exports={renamed:q9};let forced=0;
 globalThis.window={Syncord:{common:{utils:{}},webpack:{findByProps:()=>undefined,find:predicate=>Object.values(exports).find(predicate),getRequire:()=>{forced++;throw Error('must not require factories');}}},history:{state:{key:'browser'}},location:{pathname:'/channels/10/11'}};
 assert.equal(M.isNativeTransition(q9),true);assert.equal(M.isNativeTransition(()=> 'transitionTo - Transitioning to'),false);
 const api=M.routing();assert.ok(api);assert.equal(api.manager,undefined);api.router.transitionTo('/channels/10/11');assert.deepEqual(calls,[['push','/channels/10/11']]);assert.equal(forced,0);
 assert.deepEqual(M.routeLocation(),{pathname:'/channels/10/11',key:'browser'});assert.deepEqual(M.routeLocation({getHistory(){throw Error('stale');}}),M.routeLocation());
 delete globalThis.window;
});
test('observer-free navigation keeps its confirmed native entry, but exits on an external entry or path',()=>{
 const nav=new M.VirtualNavigation(()=>raw);nav.enter({pathname:'/channels/@me',key:'home'});nav.observe({pathname:'/channels/@me',key:'home'});assert.equal(nav.active,true);
 nav.begin(A);nav.confirm({pathname:M.routeFor(A),key:'owned'});nav.observe({pathname:M.routeFor(A),key:'owned'});assert.equal(nav.active,true);
 nav.observe({pathname:M.routeFor(A),key:'external'});assert.equal(nav.active,false);
 nav.enter({pathname:'/channels/@me',key:'home'});nav.observe({pathname:M.routeFor(B),key:'new'});assert.equal(nav.active,false);
});

test('DM and group references preserve native @me routes, reject forged guild associations and keep original metadata',()=>{
 const dm={id:'31',type:1,recipients:['200']},group={id:'41',type:3,name:'Friends',recipients:['200','300']};
 const channels={'31':dm,'41':group,'51':{id:'51',type:2},'61':{id:'61',type:1,guild_id:'10'}};
 globalThis.window={Syncord:{common:{stores:{UserStore:{getCurrentUser:()=>({id:'100'}),getUser:id=>({id,username:'User '+id})},ChannelStore:{getChannel:id=>channels[id],getMutablePrivateChannels:()=>channels},GuildStore:{getGuilds:()=>({})}}}}};
 try {
  for(const id of ['31','41']){const ref={guildId:'@me',channelId:id};assert.deepEqual(M.resolveChannel(id),ref);assert.strictEqual(M.channelFor(ref),channels[id]);assert.equal(M.routeFor(ref),'/channels/@me/'+id);assert.deepEqual(M.normalizeTrial({...raw,channels:[A,ref]}).channels,[A,ref]);}
  assert.equal(M.channelLabel({guildId:'@me',channelId:'31'}),'User 200');assert.equal(M.channelLabel({guildId:'@me',channelId:'41'}),'Friends');
  assert.deepEqual(M.channelChoices().map(c=>c.ref.channelId).sort(),['31','41']);
  assert.equal(M.channelFor({guildId:'10',channelId:'31'}),undefined);assert.equal(M.channelFor({guildId:'@me',channelId:'61'}),undefined);assert.equal(M.resolveChannel('51'),undefined);
  window.Syncord.common.stores.UserStore.getCurrentUser=()=>null;assert.equal(M.resolveChannel('31'),undefined);
 } finally {delete globalThis.window;}
});
test('local drag ordering supports both insertion edges without mutation, duplicates or unknown IDs',()=>{
 const C={guildId:'@me',channelId:'31'},list=Object.freeze([A,B,C]);
 assert.deepEqual(M.reorderChannels(list,'11','31',true),[B,C,A]);assert.deepEqual(M.reorderChannels(list,'31','11',false),[C,A,B]);assert.deepEqual(M.reorderChannels(list,'11','21',false),list);
 for(const [source,target]of [['11','11'],['unknown','11'],['11','unknown']])assert.deepEqual(M.reorderChannels(list,source,target,true),list);
 assert.deepEqual(list,[A,B,C]);
});
