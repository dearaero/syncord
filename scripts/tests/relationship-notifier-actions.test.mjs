import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(path.join(tmpdir(),'syncord-relationship-actions-'));
await build({stdin:{resolveDir:process.cwd(),contents:"export {quickAction} from './src/renderer/plugins/relationshipNotifier/discord';"},outfile:path.join(dir,'actions.mjs'),bundle:true,platform:'node',format:'esm',logLevel:'silent'});
const {quickAction}=await import(pathToFileURL(path.join(dir,'actions.mjs')));
test.after(()=>{delete globalThis.window;rmSync(dir,{recursive:true,force:true});});
const A='1425993161108357000',B='1425993161108357001',U='1425993161108357002',D='1425993161108357102';
const row={accountId:A,kind:'friend-removed',subjectId:U,name:'Alice',user:{id:U,name:'Alice',username:'alice'},detectedAt:1000,offline:false,cause:'unknown'};
let state,channels,profiles,router,selector,modules;
test.beforeEach(()=>{
 state={account:A,relationship:0,channels:{},mapped:undefined,created:[],routes:[],selections:[],profiles:[],requests:[],closed:0,left:0,lazy:[]};
 channels={
  async openPrivateChannel({recipientIds}){throw Error('Unsafe openPrivateChannel must not be used');},
  async ensurePrivateChannel(recipients){assert.equal(this,channels);assert.deepEqual(recipients,[U]);state.created.push(recipients);state.channels[D]={id:D,type:1,recipients:[U]};return D;},
  async getOrEnsurePrivateChannel(id){assert.equal(this,channels);assert.equal(id,U);return state.mapped??this.ensurePrivateChannel([id]);}
 };
 profiles={openUserProfileModal(options){assert.equal(this,profiles);assert.deepEqual(options,{userId:U});assert.equal(state.left,1);assert.equal(state.closed,1);state.profiles.push(options);}};
 router={transitionTo(route){assert.equal(this,router);state.routes.push(route);}};
 selector={selectPrivateChannel(channelId){assert.equal(this,selector);assert.equal(channelId,D);state.selections.push(channelId);state.routes.push('/channels/@me/'+channelId);}};
 const relationships={addRelationship(options){assert.equal(this,relationships);state.requests.push(options);return Promise.resolve();},removeRelationship(){}};
 modules=[channels,profiles,selector,relationships];
 globalThis.window={Syncord:{common:{stores:{UserStore:{getCurrentUser:()=>({id:state.account})},RelationshipStore:{getRelationshipType:()=>state.relationship},ChannelStore:{getDMFromUserId:()=>state.mapped,getChannel:id=>state.channels[id]}},actions:{ChannelActionCreators:channels},utils:{}},webpack:{findByProps:(...props)=>modules.find(m=>props.every(p=>typeof m[p]==='function')),findByCode:(...codes)=>{state.lazy.push(codes);return profiles;}},closeSettings(){state.closed++;}}};
});
const left=()=>{state.left++;};
test('RelationshipNotifier actions: standalone profile export needs no close function and is resolved after startup',async()=>{
 await quickAction('profile',row,A,left);assert.equal(state.profiles.length,1);assert.deepEqual(state.lazy,[]);
});
test('RelationshipNotifier actions: first profile click loads only the identified lazy profile action module',async()=>{
 modules=modules.filter(m=>m!==profiles);await quickAction('profile',row,A,left);
 assert.deepEqual(state.lazy,[['openUserProfileModal','UserProfileModalActionCreators']]);assert.equal(state.profiles.length,1);
});
test('RelationshipNotifier actions: missing native profile action preserves the current view',async()=>{
 modules=modules.filter(m=>m!==profiles);window.Syncord.webpack.findByCode=()=>undefined;
 await assert.rejects(quickAction('profile',row,A,left),/profile action/);assert.equal(state.left,0);assert.equal(state.closed,0);
});
test('RelationshipNotifier actions: an existing DM is validated and reused without a create request',async()=>{
 state.mapped=D;state.channels[D]={id:D,type:1,recipients:[{id:U}]};await quickAction('dm',row,A,left);
 assert.deepEqual(state.routes,['/channels/@me/'+D]);assert.deepEqual(state.created,[]);assert.equal(state.closed,1);
});
test('RelationshipNotifier actions: an uncached user gets exactly one native single-recipient DM, never an empty group',async()=>{
 await quickAction('dm',row,A,left);assert.deepEqual(state.created,[[U]]);assert.deepEqual(state.routes,['/channels/@me/'+D]);
});
test('RelationshipNotifier actions: explicit single-recipient ensure fallback keeps the native receiver',async()=>{
 delete channels.getOrEnsurePrivateChannel;await quickAction('dm',row,A,left);assert.deepEqual(state.created,[[U]]);assert.deepEqual(state.routes,['/channels/@me/'+D]);
});
test('RelationshipNotifier actions: a DM whose native recipient getter is available is accepted',async()=>{
 state.mapped=D;state.channels[D]={id:D,type:1,getRecipientId(){assert.equal(this,state.channels[D]);return U;}};
 await quickAction('dm',row,A,left);assert.deepEqual(state.routes,['/channels/@me/'+D]);
});
test('RelationshipNotifier actions: a group, another user, missing channel or guild cannot become a DM destination',async()=>{
 channels.getOrEnsurePrivateChannel=async()=>D;
 for(const channel of [{id:D,type:3,recipients:[U]},{id:D,type:1,recipients:[B]},{id:D,type:1,recipients:[]},{id:D,type:1,guild_id:B,recipients:[U]},undefined]){
  state.channels[D]=channel;await assert.rejects(quickAction('dm',row,A,left),/one-to-one DM/);
 }
 assert.deepEqual(state.routes,[]);assert.equal(state.left,0);
});
test('RelationshipNotifier actions: no native selector or legacy router means no DM creation request',async()=>{
 modules=modules.filter(m=>m!==selector);
 await assert.rejects(quickAction('dm',row,A,left),/navigation/);assert.deepEqual(state.created,[]);
});

test('RelationshipNotifier actions: current Discord native DM selection works without any named router export',async()=>{
 assert.equal(window.Syncord.common.utils.NavigationRouter,undefined);assert.equal(window.Syncord.webpack.findByProps('transitionTo'),undefined);
 await quickAction('dm',row,A,left);assert.deepEqual(state.selections,[D]);assert.deepEqual(state.created,[[U]]);
});
test('RelationshipNotifier actions: native selection takes precedence over a legacy router',async()=>{
 window.Syncord.common.utils.NavigationRouter={transitionTo(){throw Error('Legacy router must not be used');}};
 await quickAction('dm',row,A,left);assert.deepEqual(state.selections,[D]);
});
test('RelationshipNotifier actions: a cached legacy router remains a supported fallback',async()=>{
 modules=modules.filter(m=>m!==selector);window.Syncord.common.utils.NavigationRouter=router;
 await quickAction('dm',row,A,left);assert.deepEqual(state.routes,['/channels/@me/'+D]);assert.deepEqual(state.selections,[]);
});
test('RelationshipNotifier actions: a legacy router loaded after startup is resolved on click',async()=>{
 modules=modules.filter(m=>m!==selector);modules.push(router);
 await quickAction('dm',row,A,left);assert.deepEqual(state.routes,['/channels/@me/'+D]);assert.deepEqual(state.selections,[]);
});
test('RelationshipNotifier actions: failed native selection is reported once and never retries through another navigation path',async()=>{
 selector.selectPrivateChannel=()=>Promise.reject(Error('Selection unavailable'));modules.push(router);
 await assert.rejects(quickAction('dm',row,A,left),/Selection unavailable/);assert.deepEqual(state.routes,[]);assert.deepEqual(state.created,[[U]]);
});
test('RelationshipNotifier actions: a native rejection preserves the history view and allows retry',async()=>{
 const original=channels.getOrEnsurePrivateChannel;channels.getOrEnsurePrivateChannel=()=>Promise.reject(Error('DM unavailable'));
 await assert.rejects(quickAction('dm',row,A,left),/DM unavailable/);assert.equal(state.left,0);
 channels.getOrEnsurePrivateChannel=original;await quickAction('dm',row,A,left);assert.deepEqual(state.routes,['/channels/@me/'+D]);
});
test('RelationshipNotifier actions: account switches and closed views stop pending DM navigation',async()=>{
 for(const mode of ['account','closed']){
  state.account=A;let active=true,finish;channels.getOrEnsurePrivateChannel=()=>new Promise(resolve=>{finish=resolve;});
  const pending=quickAction('dm',row,A,left,()=>active);state.channels[D]={id:D,type:1,recipients:[U]};
  if(mode==='account')state.account=B;else active=false;finish(D);
  await assert.rejects(pending,/account changed|no longer active/);
 }
 assert.deepEqual(state.routes,[]);assert.equal(state.left,0);
});
test('RelationshipNotifier actions: self IDs and entries belonging to another account are refused',async()=>{
 await assert.rejects(quickAction('dm',{...row,user:{...row.user,id:A}},A,left),/other user/);
 await assert.rejects(quickAction('request',{...row,accountId:B},A,left),/no longer active/);assert.deepEqual(state.requests,[]);
});
test('RelationshipNotifier actions: a friend request is explicit, account-bound and unavailable for nonzero/unknown relationships',async()=>{
 for(const type of [1,2,3,4,5,undefined]){state.relationship=type;await assert.rejects(quickAction('request',row,A),/already a friend/);}
 assert.deepEqual(state.requests,[]);state.relationship=0;await quickAction('request',row,A);assert.deepEqual(state.requests,[{userId:U,context:{location:'RelationshipNotifier'}}]);assert.equal(state.closed,0);
});
test('RelationshipNotifier actions: duplicate in-flight requests are suppressed and failures release the guard',async()=>{
 const module=modules.find(m=>m.addRelationship);let finish;module.addRelationship=()=>new Promise((resolve,reject)=>{finish=reject;});
 const pending=quickAction('request',row,A);await assert.rejects(quickAction('request',row,A),/already in progress/);finish(Error('Request failed'));await assert.rejects(pending,/Request failed/);
 module.addRelationship=options=>{state.requests.push(options);};await quickAction('request',row,A);assert.equal(state.requests.length,1);
});
