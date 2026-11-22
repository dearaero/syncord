import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(path.join(tmpdir(),"syncord-user-activity-"));
const file = path.join(dir,"bundle.mjs");
await build({stdin:{resolveDir:process.cwd(),loader:"ts",contents:`
  export * from './src/renderer/i18n/core';
  export * from './src/renderer/plugins/userActivity/text';
  export * from './src/renderer/plugins/userActivity/types';
  export * from './src/renderer/plugins/userActivity/engine';
  export * from './src/renderer/plugins/userActivity/notifications';
  export * from './src/renderer/plugins/userActivity/discord';
  export * from './src/renderer/plugins/userActivity/runtime';
  export * from './src/renderer/plugins/userActivity/panel';
  export * from './src/renderer/api/discordEvents';
  import {settings} from './src/renderer/api/settings';
  export {settings};
`},bundle:true,platform:"neutral",format:"esm",outfile:file,logLevel:"warning",
plugins:[{name:"activity-test-dependencies",setup(b){
  b.onResolve({filter:/\/(toast|settings|logger|recorder)$/},args=>({path:args.path.split("/").pop(),namespace:"fixture"}));
  b.onLoad({filter:/.*/,namespace:"fixture"},args=>({loader:"js",contents:args.path==="recorder" ? `export class ActivityRecorder {record(notice){globalThis.activityRecords?.push(notice);}async message(){return undefined;}async settle(){}failure(){}stop(){}}`
    : args.path==="toast"
    ? `export const showToast = (message) => globalThis.toasts.push(message);`
    : args.path==="settings" ? `const data = new Map(); export const settings = {get:(key,fallback)=>data.has(key)?data.get(key):fallback,set:(key,value)=>data.set(key,value)};`
    : `export const createLogger = () => ({info(){},warn(){},error(){}});`}));
}}]});
const T = await import(pathToFileURL(file).href);
rmSync(dir,{recursive:true,force:true});
const USER="1425993161108357191", OTHER="1425993161108357192";
const defaults=()=>T.readConfig((key,fallback)=>key==="userId"?USER:fallback);
function setup(cfg=defaults()) {
  const notices=[];let now=10_000;
  const engine=new T.ActivityEngine(cfg,notice=>notices.push(notice),id=>id!=="hidden",()=>now);
  engine.seed({user:{id:USER,avatar:"a",username:"before",global_name:null},status:"offline",activities:[],voice:{userId:USER,channelId:null}});
  return {engine,notices,advance:ms=>{now+=ms;}};
}
function message(id,channel="visible",user=USER){return {message:{id:String(id),channel_id:channel,author:{id:user},content:"Observed message content"}};}

test("activity config: strict IDs, bounded numbers and malformed persisted settings",()=>{
  assert.equal(T.userId(`<@!${USER}>`),USER);assert.equal(T.userId("garbage"),"");
  const cfg=T.readConfig((key,fallback)=>({userId:USER,typingCooldown:Infinity,notificationInterval:0,presence:"false"}[key]??fallback));
  assert.equal(cfg.typingCooldown,30);assert.equal(cfg.notificationInterval,5);assert.equal(cfg.presence,false);
});
test("activity: startup is silent, other users and malformed actions are ignored",()=>{
  const {engine,notices}=setup();
  for(const type of ["MESSAGE_CREATE","TYPING_START","PRESENCE_UPDATES","USER_UPDATE","VOICE_STATE_UPDATES"]){
    for(const action of [null,undefined,[],"wrong",{}, {userId:OTHER}]) engine.handle(type,action);
  }
  engine.handle("PRESENCE_UPDATES",{updates:[{user:{id:OTHER},status:"online"},{user:{id:USER},status:"offline",activities:[]}]});
  assert.deepEqual(notices,[]);
});
test("activity: batched Discord presence transitions and invisible do not reveal hidden status",()=>{
  const {engine,notices}=setup();
  for(const state of ["online","online","dnd","idle","invisible","offline"])
    engine.handle("PRESENCE_UPDATES",{updates:[{user:{id:OTHER},status:"idle"},{user:{id:USER},status:state}]});
  assert.deepEqual(notices.map(n=>n.text),["Offline → Online","Online → Do Not Disturb","Do Not Disturb → Idle","Idle → Offline"]);
});
test("activity: partial user updates do not invent profile removals",()=>{
  const {engine,notices}=setup();
  engine.handle("USER_UPDATE",{user:{id:USER,avatar:"a"}});
  engine.handle("USER_UPDATE",{user:{id:USER,avatar:"b"}});
  engine.handle("USER_UPDATE",{user:{id:USER,username:"after"}});
  engine.handle("USER_PROFILE_FETCH_SUCCESS",{userProfile:{user:{id:USER,avatar:null}}});
  assert.deepEqual(notices.map(n=>n.kind),["avatar","profile","avatar"]);
  assert.equal(engine.sizes().fields,3);
});
test("activity: first unseen profile field is a baseline, not a change",()=>{
  const {engine,notices}=setup();
  engine.handle("GUILD_MEMBER_UPDATE",{guildId:"guild",user:{id:USER},avatar:"a",nick:"Alice"});
  engine.handle("GUILD_MEMBER_UPDATE",{guildId:"guild",user:{id:USER},avatar:"b",nick:"Bob"});
  assert.deepEqual(notices.map(n=>n.kind),["avatar","profile"]);
});
test("activity: activities ignore changing progress timestamps and normalize ordering",()=>{
  const {engine,notices}=setup();
  const a={type:0,name:"Game",details:"Playing",timestamps:{start:1}};
  engine.handle("PRESENCE_UPDATE",{user:{id:USER},activities:[a]});
  engine.handle("PRESENCE_UPDATE",{user:{id:USER},activities:[{...a,timestamps:{start:2}}]});
  engine.handle("PRESENCE_UPDATE",{user:{id:USER},activities:[]});
  assert.equal(notices.length,2);
});
test("activity: message duplicates, optimistic sends, hidden channels and other authors are skipped",()=>{
  const {engine,notices}=setup();
  engine.handle("MESSAGE_CREATE",message(1));engine.handle("MESSAGE_CREATE",message(1));
  engine.handle("MESSAGE_CREATE",{...message(2),optimistic:true});
  engine.handle("MESSAGE_CREATE",message(3,"hidden"));engine.handle("MESSAGE_CREATE",message(4,"visible",OTHER));
  assert.deepEqual(notices,[{kind:"messages",channelId:"visible",text:"Sent a message",messageId:"1",messageEvent:"sent",content:"Observed message content"}]);
});
test("activity: typing is independently throttled per channel",()=>{
  const {engine,notices,advance}=setup();
  const typing=channel=>engine.handle("TYPING_START",{userId:USER,channelId:channel});
  typing("a");typing("a");typing("b");typing("hidden");advance(29_999);typing("a");advance(1);typing("a");
  assert.deepEqual(notices.map(n=>n.channelId),["a","b","a"]);
});
test("activity: voice join, move, mute and leave support native batches",()=>{
  const {engine,notices}=setup();
  for(const state of [{channelId:"a"},{channelId:"a",selfMute:true},{channelId:"b"},{channelId:null}])
    engine.handle("VOICE_STATE_UPDATES",{voiceStates:[{userId:OTHER,channelId:"a"},{userId:USER,...state}]});
  assert.deepEqual(notices.map(n=>n.channelId),["a","a","b","b"]);
});
test("activity: pause, event switches, reconnection baseline and target changes",()=>{
  const {engine,notices}=setup();
  engine.suspend();engine.handle("MESSAGE_CREATE",message(1));
  engine.resume({user:{id:USER,avatar:"new"},status:"dnd"});
  engine.handle("PRESENCE_UPDATE",{user:{id:USER},status:"dnd"});
  engine.configure({...defaults(),messages:false},{});engine.handle("MESSAGE_CREATE",message(2));
  engine.configure({...defaults(),paused:true},{});engine.handle("TYPING_START",{userId:USER,channelId:"a"});
  engine.configure({...defaults(),userId:OTHER},{});engine.handle("MESSAGE_CREATE",message(3));
  assert.deepEqual(notices,[]);
});
test("activity: 100,000 irrelevant events allocate no per-user state; target state is capped",()=>{
  const {engine,notices}=setup();
  const before=engine.sizes();
  for(let i=0;i<100_000;i++) engine.handle("PRESENCE_UPDATES",{updates:[{user:{id:OTHER},status:"online"}]});
  assert.deepEqual(engine.sizes(),before);assert.equal(notices.length,0);
  for(let i=0;i<1000;i++){
    engine.handle("MESSAGE_CREATE",message(i));
    engine.handle("TYPING_START",{userId:USER,channelId:`c${i}`});
    engine.handle("GUILD_MEMBER_UPDATE",{user:{id:USER},guildId:`g${i}`,avatar:"x",nick:"N"});
  }
  for(const count of Object.values(engine.sizes())) assert.ok(count<=128);
  engine.dispose();assert.deepEqual(engine.sizes(),{fields:0,messages:0,typing:0});
});

function fakeClock(){
  let time=0,next=0;const jobs=new Map();
  return {jobs,now:()=>time,set:(fn,delay)=>{const id=++next;jobs.set(id,{fn,at:time+delay});return id;},clear:id=>jobs.delete(id),
    tick(ms){const end=time+ms;for(;;){let first;for(const [id,job] of jobs)if(job.at<=end&&(!first||job.at<first[1].at))first=[id,job];
      if(!first)break;time=first[1].at;jobs.delete(first[0]);first[1].fn();}time=end;}};
}
test("activity notices: bursts coalesce, pending memory and timer count stay bounded",()=>{
  const clock=fakeClock(),shown=[];
  const buffer=new T.NoticeBuffer(clock,()=>5,n=>n.text,text=>shown.push(text));
  for(let i=0;i<10_000;i++) buffer.add({kind:"messages",channelId:`c${i}`,text:"Sent message"});
  assert.equal(buffer.size(),16);assert.equal(clock.jobs.size,1);clock.tick(250);
  assert.equal(shown.length,1);assert.match(shown[0],/other events/);assert.equal(buffer.size(),0);
  buffer.add({kind:"typing",text:"Typing"});buffer.add({kind:"typing",text:"Typing"});clock.tick(4999);
  assert.equal(shown.length,1);clock.tick(1);assert.equal(shown.length,2);assert.match(shown[1],/2 events/);
  assert.equal(clock.jobs.size,0);buffer.add({kind:"presence",text:"Online"});buffer.dispose();clock.tick(10_000);
  assert.equal(shown.length,2);assert.equal(clock.jobs.size,0);
});

function runtimeWorld(initial={}){
  const sent=[],bus=new EventTarget(),clock=fakeClock(),subscriptions=new Map(),saved={userId:USER,...initial},disposers=[];
  globalThis.toasts=[];globalThis.activityRecords=[];
  const flux={dispatch(action){sent.push(structuredClone(action));},subscribe(type,fn){assert.ok(!subscriptions.has(type));subscriptions.set(type,fn);},unsubscribe(type,fn){assert.equal(subscriptions.get(type),fn);subscriptions.delete(type);}};
  globalThis.window={addEventListener:bus.addEventListener.bind(bus),removeEventListener:bus.removeEventListener.bind(bus),dispatchEvent:bus.dispatchEvent.bind(bus),
    setTimeout:clock.set,clearTimeout:clock.clear,setInterval:clock.set,clearInterval:clock.clear,
    Syncord:{common:{flux:{FluxDispatcher:flux},stores:{
      UserStore:{getUser:id=>({id,username:id===USER?"Alice":id===OTHER?"Bob":id,avatar:"a",getAvatarURL:()=>"https://cdn.discordapp.com/avatars/a.png"}),getUsers:()=>({[USER]:{id:USER,username:"Alice"}})},
      PresenceStore:{getStatus:()=>"offline",getActivities:()=>[]},VoiceStateStore:{getVoiceStateForUser:()=>undefined},
      ChannelStore:{getChannel:id=>({id,type:0,guild_id:"g",name:"general"})},
      PermissionStore:{computePermissions:()=>1024n,can:()=>true},GuildStore:{getGuild:()=>({name:"Guild"})},
    }}}};
  const ctx={settings:{get:(key,fallback)=>saved[key]??fallback},log:{warn(){}},disposable:fn=>disposers.push(fn)};
  return {saved,sent,subscriptions,clock,flux,emit:(type,value)=>flux.dispatch({...value,type}),
    change:()=>window.dispatchEvent(new Event(T.ACTIVITY_SETTINGS_EVENT)),stop:()=>disposers.reverse().forEach(fn=>fn()),ctx};
}
test("activity runtime: no selected user is idle; pausing or muting notifications retains recording",()=>{
  for(const saved of [{userId:""},{paused:true},Object.fromEntries(T.EVENT_KINDS.map(kind=>[kind,false]))]){
    const world=runtimeWorld(saved);T.startActivity(world.ctx);world.clock.tick(250);
    assert.equal(T.discordEventStats().attached,saved.userId!=="");
    world.emit("MESSAGE_CREATE",message(1));world.clock.tick(250);
    assert.equal(toasts.length,0);assert.equal(activityRecords.length,saved.userId===""?0:1);
    assert.equal(world.clock.jobs.size,0);world.stop();
  }
});
test("activity runtime: native reconnect event and stop clean subscriptions and pending timers",()=>{
  const world=runtimeWorld();T.startActivity(world.ctx);
  assert.ok(T.discordEventStats().attached);world.clock.tick(250);assert.equal(world.clock.jobs.size,0);
  world.emit("MESSAGE_CREATE",message(1));assert.equal(world.clock.jobs.size,1);
  world.emit("CONNECTION_CLOSED",{});assert.equal(world.clock.jobs.size,0);
  world.emit("MESSAGE_CREATE",message(2));assert.equal(world.clock.jobs.size,0);
  world.emit("CONNECTION_RESUMED",{});world.clock.tick(250);world.emit("MESSAGE_CREATE",message(3));assert.equal(world.clock.jobs.size,1);
  world.saved.paused=true;world.change();world.clock.tick(250);assert.equal(T.discordEventStats().attached,true);assert.equal(world.clock.jobs.size,0);
  world.saved.paused=false;world.change();assert.ok(T.discordEventStats().attached);
  world.stop();assert.equal(T.discordEventStats().attached,false);assert.equal(world.clock.jobs.size,0);
  world.change();assert.equal(world.subscriptions.size,0);assert.equal(T.activityStatus(),"Disabled");
});
test("activity Discord adapter: computed permissions override hidden-channel patches; search is bounded",()=>{
  runtimeWorld();window.Syncord.common.stores.PermissionStore.computePermissions=()=>0n;
  assert.equal(T.canViewChannel("hidden"),false);
  assert.equal(T.choice(USER).avatar,"https://cdn.discordapp.com/avatars/a.png");
  window.Syncord.common.stores.UserStore.getUser=id=>({id,username:"User",getAvatarURL:()=>"https://evil.example/secret"});
  assert.equal(T.choice(USER).avatar,"");
  window.Syncord.common.stores.UserStore.getUsers=()=>Object.fromEntries(Array.from({length:1000},(_,i)=>[String(i),{id:String(i),username:"User"}]));
  assert.equal(T.searchUsers("User").length,20);
  delete globalThis.window;
});

test("activity config: migrates a single user, deduplicates and bounds a persisted multi-user list",()=>{
  const read=saved=>T.readConfig((key,fallback)=>saved[key]??fallback);
  assert.deepEqual(read({userId:USER}).userIds,[USER]);
  assert.deepEqual(read({userId:USER,userIds:[]}).userIds,[]);
  assert.equal(read({userId:USER,userIds:[]}).userId,"");
  assert.deepEqual(read({userId:USER,userIds:[OTHER,OTHER,`<@${USER}>`,null,"bad"]}).userIds,[OTHER,USER]);
  const ids=Array.from({length:100},(_,i)=>String(1425993161108357200n+BigInt(i)));
  assert.equal(read({userIds:ids}).userIds.length,T.MAX_ACTIVITY_USERS);
  assert.deepEqual(read({userIds:"invalid",userId:USER}).userIds,[USER]);
});
test("activity notices: different users in the same channel retain their own name and event counts",()=>{
  const clock=fakeClock(),shown=[];
  const buffer=new T.NoticeBuffer(clock,()=>5,n=>`${n.userId}: ${n.text}`,text=>shown.push(text));
  buffer.add({userId:USER,kind:"typing",channelId:"same",text:"Typing"});
  buffer.add({userId:USER,kind:"typing",channelId:"same",text:"Typing"});
  buffer.add({userId:OTHER,kind:"typing",channelId:"same",text:"Typing"});
  assert.equal(clock.jobs.size,1);clock.tick(250);
  assert.equal(shown[0],`${USER}: Typing (2 events) · ${OTHER}: Typing`);
  buffer.dispose();
});
test("activity runtime: many users share one subscription set and unrelated traffic skips their engines",()=>{
  const ids=[USER,OTHER,...Array.from({length:30},(_,i)=>String(1425993161108357300n+BigInt(i)))];
  const world=runtimeWorld({userIds:ids});
  window.Syncord.common.stores.GuildStore.getGuildIds=()=>["1425993161108357500"];
  T.startActivity(world.ctx);world.clock.tick(250);
  const members=world.sent.find(action=>action.type==="GUILD_SUBSCRIPTIONS_MEMBERS_ADD");
  assert.deepEqual(members?.userIds,ids);
  const stats=T.discordEventStats();assert.equal(stats.listeners,15);assert.equal(T.guildCoverageStatus().consumers,1);
  const handle=T.ActivityEngine.prototype.handle;let calls=0;
  T.ActivityEngine.prototype.handle=function(...args){calls++;return handle.apply(this,args);};
  try {
    for(let i=0;i<100_000;i++)world.emit("MESSAGE_CREATE",message(i,"visible","1425993161108357999"));
    assert.equal(calls,0);assert.equal(world.clock.jobs.size,0);
    world.emit("MESSAGE_CREATE",message(1,"visible",USER));world.emit("MESSAGE_CREATE",message(2,"visible",OTHER));
    assert.equal(calls,2);assert.equal(world.clock.jobs.size,1);world.clock.tick(250);
    assert.equal(toasts.length,1);assert.match(toasts[0],/Alice: Sent a message/);assert.match(toasts[0],/Bob: Sent a message/);
    assert.deepEqual(T.discordEventStats(),stats);
  }finally{T.ActivityEngine.prototype.handle=handle;world.stop();}
  assert.equal(world.clock.jobs.size,0);assert.equal(T.discordEventStats().attached,false);
});
test("activity runtime: presence, profile, avatar, voice and typing route to the correct selected user",()=>{
  const world=runtimeWorld({userIds:[USER,OTHER]});T.startActivity(world.ctx);world.clock.tick(250);
  try {
    world.emit("PRESENCE_UPDATES",{updates:[null,{user:{id:USER},status:"online"},{user:{id:OTHER},status:"dnd"},{user:{id:"ignored"},status:"online"}]});
    world.clock.tick(250);assert.match(toasts.at(-1),/Alice: Offline → Online/);assert.match(toasts.at(-1),/Bob: Offline → Do Not Disturb/);
    world.emit("USER_UPDATE",{user:{id:USER,avatar:"new"}});
    world.emit("USER_PROFILE_FETCH_SUCCESS",{userProfile:{user:{id:OTHER,username:"newname"}}});
    world.clock.tick(6000);assert.match(toasts.at(-1),/Alice: Profile photo changed/);assert.match(toasts.at(-1),/Bob: Username changed to newname/);
    world.emit("VOICE_STATE_UPDATES",{voiceStates:[{userId:USER,channelId:"visible"},{user_id:OTHER,channel_id:"visible"}]});
    world.clock.tick(6000);assert.match(toasts.at(-1),/Alice: Joined/);assert.match(toasts.at(-1),/Bob: Joined/);
    world.emit("TYPING_START",{userId:USER,channelId:"visible"});world.emit("TYPING_START",{userId:OTHER,channelId:"visible"});
    world.emit("TYPING_START",{userId:USER,channelId:"visible"});
    world.clock.tick(6000);assert.match(toasts.at(-1),/Alice: Started typing/);assert.match(toasts.at(-1),/Bob: Started typing/);
    assert.ok(!toasts.at(-1).includes("events"));
    world.emit("VOICE_STATE_UPDATE",{voiceState:{userId:OTHER,channelId:null}});
    world.clock.tick(6000);assert.match(toasts.at(-1),/^Bob: Left voice channel/);
  }finally{world.stop();}
});
test("activity runtime: removal discards pending notices, retained users preserve typing cooldowns and all-empty stops",()=>{
  const world=runtimeWorld({userIds:[USER,OTHER]});T.startActivity(world.ctx);world.clock.tick(250);
  const stats=T.discordEventStats();
  world.emit("TYPING_START",{userId:OTHER,channelId:"visible"});
  world.emit("MESSAGE_CREATE",message(1,"visible",USER));
  world.saved.userIds=[OTHER];world.change();world.clock.tick(250);
  assert.equal(toasts.length,0);
  world.emit("MESSAGE_CREATE",message(2,"visible",USER));
  world.emit("TYPING_START",{userId:OTHER,channelId:"visible"});assert.equal(world.clock.jobs.size,0);
  world.emit("MESSAGE_CREATE",message(3,"visible",OTHER));world.clock.tick(250);
  assert.match(toasts.at(-1),/^Bob: Sent a message/);assert.deepEqual(T.discordEventStats(),stats);
  world.saved.userIds=[];world.change();assert.equal(T.discordEventStats().attached,false);
  assert.equal(world.clock.jobs.size,0);world.stop();
});
test("activity runtime: a user added while disconnected stays silent until all users reconnect",()=>{
  const world=runtimeWorld({userIds:[USER]});T.startActivity(world.ctx);world.clock.tick(250);
  world.emit("CONNECTION_CLOSED",{});world.saved.userIds=[USER,OTHER];world.change();
  world.emit("MESSAGE_CREATE",message(1,"visible",USER));world.emit("MESSAGE_CREATE",message(2,"visible",OTHER));
  world.clock.tick(6000);assert.equal(toasts.length,0);
  world.emit("CONNECTION_RESUMED",{});world.clock.tick(250);
  world.emit("MESSAGE_CREATE",message(3,"visible",USER));world.emit("MESSAGE_CREATE",message(4,"visible",OTHER));world.clock.tick(250);
  assert.match(toasts.at(-1),/Alice: Sent a message/);assert.match(toasts.at(-1),/Bob: Sent a message/);
  world.saved.paused=true;world.change();assert.equal(T.discordEventStats().attached,true);
  world.saved.paused=false;world.change();assert.equal(T.discordEventStats().listeners,15);
  world.stop();assert.equal(world.clock.jobs.size,0);
});

test("activity search: selected friends do not occupy the result limit or hide remaining cached users",()=>{
  runtimeWorld();
  const ids=Array.from({length:50},(_,i)=>String(1425993161108357200n+BigInt(i)));
  const users=Object.fromEntries(ids.map(id=>[id,{id,username:`User ${id}`} ]));
  window.Syncord.common.stores.UserStore={getUser:id=>users[id],getUsers:()=>users};
  window.Syncord.common.stores.RelationshipStore={getFriendIDs:()=>ids};
  const excluded=new Set(ids.slice(0,25));
  assert.deepEqual(T.searchUsers("",excluded).map(user=>user.id),ids.slice(25,45));
  assert.deepEqual(T.searchUsers(ids[0],excluded),[]);
  assert.deepEqual(T.searchUsers(ids[49],excluded).map(user=>user.id),[ids[49]]);
  delete globalThis.window;
});

test("activity history: all typing events survive cooldowns and disabled notification flags without toast flooding",()=>{
  const cfg={...defaults(),paused:true,...Object.fromEntries(T.EVENT_KINDS.map(kind=>[kind,false]))};
  const captured=[],shown=[];const engine=new T.ActivityEngine(cfg,n=>shown.push(n),id=>id!=="hidden",()=>10_000,n=>captured.push(n));
  engine.seed({user:{id:USER,avatar:"a",username:"Alice"},status:"offline",activities:[],voice:{userId:USER,channelId:null}});
  for(let i=0;i<40;i++)engine.handle("TYPING_START",{userId:USER,channelId:"visible"});
  engine.handle("MESSAGE_CREATE",message(1));engine.handle("MESSAGE_CREATE",message(1));
  engine.handle("MESSAGE_CREATE",message(2,"hidden"));
  engine.handle("PRESENCE_UPDATE",{user:{id:USER},status:"online",activities:[{name:"Game",type:0}]});
  engine.handle("USER_UPDATE",{user:{id:USER,avatar:"b",username:"New"}});
  engine.handle("VOICE_STATE_UPDATE",{userId:USER,channelId:"visible"});
  assert.equal(captured.filter(n=>n.kind==="typing").length,40);
  assert.deepEqual(new Set(captured.map(n=>n.kind)),new Set(T.EVENT_KINDS));
  assert.equal(captured.filter(n=>n.kind==="messages").length,1);assert.equal(shown.length,0);
  assert.equal(captured.find(n=>n.kind==="messages").content,"Observed message content");
  engine.configure({...defaults(),typingCooldown:30},{status:"online"});
  for(let i=0;i<5;i++)engine.handle("TYPING_START",{userId:USER,channelId:"visible"});
  assert.equal(shown.length,1);assert.equal(captured.filter(n=>n.kind==="typing").length,45);
  engine.dispose();
});


test("activity i18n: queued summaries use the current locale and retain literal user content",()=>{
  T.setLocale('en-US');const clock=fakeClock(),shown=[],retained=[];
  const buffer=new T.NoticeBuffer(clock,()=>5,n=>{retained.push(n);return T.formatActivityText(n)+': '+n.content;},text=>shown.push(text));
  const notice={kind:'messages',text:'Sent a message',content:'Cancel $& <b>Online</b>'+'x'.repeat(1000)};
  buffer.add(notice);buffer.add(notice);notice.content='mutated';
  assert.equal(retained.length,0);T.setLocale('de');clock.tick(250);
  assert.match(shown[0],/Nachricht gesendet/);assert.match(shown[0],/Cancel \$& <b>Online<\/b>/);assert.match(shown[0],/2 Ereignisse/);
  assert.ok(retained[0].content.length<=120);assert.notEqual(retained[0].content,'mutated');
  assert.equal(T.formatActivityText({kind:'profile',text:'Username changed to Cancel'}),T.t('activity.username_changed',{name:'Cancel'}));
  assert.equal(T.formatActivityText({kind:'presence',text:'Offline → Online'}),T.t('ui.offline')+' → '+T.t('ui.online'));
  buffer.dispose();T.setLocale('en-US');
});
