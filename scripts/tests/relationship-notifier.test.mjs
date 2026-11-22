import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(path.join(tmpdir(),'syncord-relationships-'));
await build({stdin:{resolveDir:process.cwd(),contents:"export * from './src/renderer/plugins/relationshipNotifier/engine';export * from './src/renderer/plugins/relationshipNotifier/types';"},outfile:path.join(dir,'model.mjs'),bundle:true,platform:'node',format:'esm',logLevel:'silent'});
const T=await import(pathToFileURL(path.join(dir,'model.mjs')));test.after(()=>rmSync(dir,{recursive:true,force:true}));
const A='1425993161108357000',B='1425993161108357001',U='1425993161108357002',V='1425993161108357003',G='1425993161108357004',S='1425993161108357005';
const person=id=>({id,username:id===U?'alice':'bob',name:id===U?'Alice':'Bob'}),rel=(id,type=1)=>({...person(id),type});
const group=members=>({id:G,name:'Study group',members:Object.fromEntries(members.map(id=>[id,person(id)])),membersComplete:true});
const cfg={friends:true,requests:true,groups:true,servers:true,members:true,history:true,backup:true,offline:true,notifyFriendAdded:true,notifyFriendRemoved:true,notifyRequestReceived:true,notifyIncomingRequestEnded:true,notifyOutgoingRequestEnded:true,notifyGroupRemoved:true,notifyServerRemoved:true,notifyMemberAdded:true,notifyMemberRemoved:true,notifySelf:false,notifyOffline:true,duration:10};
const input={relationships:{[U]:rel(U),[V]:rel(V,3)},groups:{[G]:group([U,V])},guilds:{[S]:{id:S,name:'Server'}},complete:{relationships:true,groups:true,guilds:true}};
const initial=()=>T.reconcile(undefined,A,input,cfg,1000,true);
test('RelationshipNotifier: first authoritative baseline backs up friends without inventing historical events',()=>{
 const state=initial();assert.deepEqual(state.entries,[]);assert.equal(state.backup.length,1);assert.equal(state.backup[0].id,U);assert.equal(state.snapshot.accountId,A);
});
test('RelationshipNotifier: offline diff has detection time and previous observation, and repeated snapshots do not duplicate',()=>{
 const changed=T.reconcile(initial().snapshot,A,{relationships:{},complete:{relationships:true}},cfg,4000,true);
 assert.deepEqual(changed.entries.map(r=>r.kind),['friend-removed','incoming-request-ended']);
 assert.equal(changed.entries[0].detectedAt,4000);assert.equal(changed.entries[0].previousSeenAt,1000);assert.equal(changed.entries[0].offline,true);assert.equal(changed.entries[0].cause,'unknown');
 assert.equal(T.reconcile(changed.snapshot,A,{relationships:{},complete:{relationships:true}},cfg,5000,true).entries.length,0);
});
test('RelationshipNotifier: partial caches, unavailable guilds and failed snapshots never imply membership loss',()=>{
 const state=initial().snapshot;
 assert.equal(T.reconcile(state,A,{relationships:{},groups:{},guilds:{}},cfg,2000,true).entries.length,0);
 const outage=T.transition(state,A,{scope:'guild',id:S,value:{id:S,name:S,unavailable:true}},cfg,2000,'unknown');
 assert.equal(outage.entries.length,0);assert.equal(outage.snapshot.guilds[S].name,'Server');
 const still=T.reconcile(outage.snapshot,A,{guilds:{[S]:{id:S,name:S,unavailable:true}},complete:{guilds:true}},cfg,3000,true);assert.equal(still.entries.length,0);
 const back=T.transition(still.snapshot,A,{scope:'guild',id:S,value:{id:S,name:'Server'}},cfg,4000,'unknown');assert.equal(back.entries.length,0);
});
test('RelationshipNotifier: partial group observations support live events but require complete input to infer offline absence',()=>{
 const partial=T.reconcile(undefined,A,{groups:{[G]:group([U])}},cfg,1000,true);
 assert.equal(T.reconcile(partial.snapshot,A,{groups:{}},cfg,2000,true).entries.length,0);
 const live=T.transition(partial.snapshot,A,{scope:'group',id:G},cfg,2000,'unknown');assert.equal(live.entries[0].kind,'group-removed');
});
test('RelationshipNotifier: pending local actions keep the baseline; successful confirmations are local and idempotent',()=>{
 const pending=T.transition(initial().snapshot,A,{scope:'relationship',id:U},cfg,2000,'pending');assert.ok(pending.snapshot.relationships[U]);assert.deepEqual(pending.entries,[]);
 const ack=T.transition(pending.snapshot,A,{scope:'relationship',id:U},cfg,3000,'local');assert.equal(ack.entries[0].cause,'local');assert.equal(T.notificationEnabled(ack.entries[0],cfg),false);
 assert.equal(T.transition(ack.snapshot,A,{scope:'relationship',id:U},cfg,3100,'unknown').entries.length,0);
});
test('RelationshipNotifier: request acceptance is a friendship, not a claimed cancellation or rejection',()=>{
 const before=T.reconcile(undefined,A,{relationships:{[U]:rel(U,4)},complete:{relationships:true}},cfg,1000,true);
 const accept=T.transition(before.snapshot,A,{scope:'relationship',id:U,value:rel(U,1)},cfg,2000,'unknown');assert.deepEqual(accept.entries.map(r=>r.kind),['friend-added']);
 const removed=T.transition(before.snapshot,A,{scope:'relationship',id:U},cfg,2000,'unknown');assert.equal(removed.entries[0].kind,'outgoing-request-ended');assert.doesNotMatch(T.describe(removed.entries[0]),/rejected|blocked|withdrew/i);
});
test('RelationshipNotifier: your account blocking a former friend is local; it never implies the other person blocked you',()=>{
 const result=T.transition(initial().snapshot,A,{scope:'relationship',id:U,value:rel(U,2)},cfg,2000,'unknown');assert.equal(result.entries[0].cause,'local');assert.doesNotMatch(T.describe(result.entries[0]),/blocked/i);
});
test('RelationshipNotifier: optional group membership changes deduplicate and never announce the current user as another member',()=>{
 const state=initial().snapshot,leave={scope:'member',id:G,user:person(U),added:false};
 const first=T.transition(state,A,leave,cfg,2000,'unknown');assert.equal(first.entries[0].kind,'group-member-removed');assert.equal(first.entries[0].user.name,'Alice');
 assert.equal(T.transition(first.snapshot,A,leave,cfg,2001,'unknown').entries.length,0);
 assert.equal(T.transition(state,A,leave,{...cfg,members:false},2000,'unknown').entries.length,0);
 const self=T.transition(state,A,{...leave,user:person(A)},cfg,2000,'unknown');assert.equal(self.entries[0].kind,'group-removed');
});
test('RelationshipNotifier: incomplete group metadata preserves known recipients and cannot create false member changes',()=>{
 const partial={...group([]),membersComplete:false};const result=T.reconcile(initial().snapshot,A,{groups:{[G]:partial}},cfg,2000,true);
 assert.equal(result.entries.length,0);assert.ok(result.snapshot.groups[G].members[U]);
});
test('RelationshipNotifier: tracking, notifications, offline summaries and backup are independent switches',()=>{
 const state=initial().snapshot,d={scope:'relationship',id:U};
 const muted=T.transition(state,A,d,{...cfg,notifyFriendRemoved:false},2000,'unknown');assert.equal(muted.entries.length,1);assert.equal(T.notificationEnabled(muted.entries[0],{...cfg,notifyFriendRemoved:false}),false);
 const disabled=T.transition(state,A,d,{...cfg,friends:false,backup:false},2000,'unknown');assert.equal(disabled.entries.length,0);assert.equal(disabled.backup.length,0);assert.equal(disabled.snapshot.relationships[U],undefined);
 const offline=T.reconcile(state,A,{relationships:{},complete:{relationships:true}},{...cfg,offline:false},2000,true);assert.equal(offline.entries.length,0);assert.deepEqual(offline.snapshot.relationships,{});
});
test('RelationshipNotifier: each notification event type can be disabled independently',()=>{
 const switches={'friend-added':'notifyFriendAdded','friend-removed':'notifyFriendRemoved','request-received':'notifyRequestReceived','incoming-request-ended':'notifyIncomingRequestEnded','outgoing-request-ended':'notifyOutgoingRequestEnded','group-removed':'notifyGroupRemoved','server-removed':'notifyServerRemoved','group-member-added':'notifyMemberAdded','group-member-removed':'notifyMemberRemoved'};
 for(const [kind,key]of Object.entries(switches)){
  const row={accountId:A,kind,subjectId:U,name:'Alice',detectedAt:1000,offline:false,cause:'unknown'};
  assert.equal(T.notificationEnabled(row,cfg),true,kind);assert.equal(T.notificationEnabled(row,{...cfg,[key]:false}),false,kind);
 }
});
test('RelationshipNotifier: intent expiry, cancellation and single consumption prevent stale local attribution',()=>{
 const intents=new T.IntentLedger(),key='relationship:'+U+':0',first=intents.mark(key,0);assert.equal(intents.cause(key,1),'pending');
 const second=intents.mark(key,2);intents.cancel(key,first);assert.equal(intents.confirm(key,first,3),false);assert.equal(intents.confirm(key,second,3),true);assert.equal(intents.consume(key,4),'local');assert.equal(intents.consume(key,5),'unknown');
 intents.mark(key,6);assert.equal(intents.cause(key,60_007),'unknown');
});
test('RelationshipNotifier: an account switch starts fresh; the previous account cannot become a new account baseline',()=>{
 assert.throws(()=>T.reconcile(initial().snapshot,B,input,cfg,2000,true),/account mismatch/);
 const fresh=T.reconcile(undefined,B,{relationships:{},complete:{relationships:true}},cfg,2000,true);assert.equal(fresh.entries.length,0);assert.deepEqual(fresh.snapshot.relationships,{});
});
test('RelationshipNotifier: integration registers once, declares permissions and wires all settings lifecycle hooks',()=>{
 const index=readFileSync('src/renderer/plugins/index.ts','utf8'),panel=readFileSync('src/renderer/ui/settingsPanel.ts','utf8');assert.equal(index.match(/import "\.\/relationshipNotifier"/g)?.length,1);
 for(const hook of ['relationshipSectionHtml()','relationshipExpandButtonHtml()','isRelationshipExpanded()','bindRelationshipPanel(root)','disposeRelationshipPanel=undefined'])assert.ok(panel.includes(hook),hook);
 const source=readFileSync('src/renderer/plugins/relationshipNotifier/runtime.ts','utf8');assert.match(source,/enabledByDefault:false/);assert.match(source,/webpackPatch:true/);assert.match(source,/userData:true/);
});
