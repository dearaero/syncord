import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(path.join(tmpdir(),'syncord-background-plugins-')),out=path.join(dir,'bundle.mjs');
await build({stdin:{resolveDir:process.cwd(),loader:'ts',contents:`
export {MessageLoggerPlugin} from './src/renderer/plugins/messageLogger';
export {startActivity} from './src/renderer/plugins/userActivity/runtime';
export * from './src/renderer/api/discordEvents';
`},bundle:true,platform:'neutral',format:'esm',outfile:out,logLevel:'warning',plugins:[{name:'fixture',setup(b){
 b.onResolve({filter:/\/recorder$/},args=>({path:args.path,namespace:'activity-recorder-fixture'}));
 b.onLoad({filter:/.*/,namespace:'activity-recorder-fixture'},()=>({loader:'js',contents:'export class ActivityRecorder {record(){}async message(){return undefined;}async settle(){}failure(){}stop(){}}'}));
 b.onResolve({filter:/api\/plugin$/},()=>({path:'plugin',namespace:'fixture'}));
 b.onResolve({filter:/messageLogger\/log$|^\.\/log$/},()=>({path:'log',namespace:'fixture'}));
 b.onResolve({filter:/\/(logger|toast)$/},args=>({path:args.path.split('/').pop(),namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',contents:args.path==='plugin'?`
 export const definePlugin=x=>x;export const definePluginSettings=defs=>({bind:()=>({get:key=>globalThis.saved[key]??defs[key].default,set:(key,value)=>globalThis.saved[key]=value})});
 `:args.path==='log'?`
 export const channelIdOf=m=>m.channel_id??m.channelId??'';
 export const deletedInRange=()=>[];export const entry=()=>undefined;export const liveMessage=()=>undefined;
 export const loadLog=()=>{};export const holdMessage=()=>{};export const releaseMessage=()=>{};
 export const onLogReset=()=>()=>{};export const undoDelete=()=>false;export const saveLogNow=()=>{};export const setLogLimit=()=>{};
 export const rememberDelete=m=>{const row={id:m.id,content:m.content,channelId:channelIdOf(m),deleted:1};globalThis.deleted.push(row);return row;};
 export const rememberEdit=(m,next)=>globalThis.edits.push({previous:m.content,next});
 export const rememberActivity=()=>undefined;
 `:args.path==='toast'?`export const showToast=text=>globalThis.notices.push(text);`:`export const createLogger=()=>({info(){},warn(){},error(){}});`}));
}}]});
const T=await import(pathToFileURL(out).href);rmSync(dir,{recursive:true,force:true});
const USER='1425993161108357191',SELF='1425993161108357192',GUILD='1425993161108357193',CHANNEL='1425993161108357194',MESSAGE='1425993161108357195';
function world() {
 globalThis.saved={userId:USER};globalThis.deleted=[];globalThis.edits=[];globalThis.notices=[];
 globalThis.HTMLElement=class {};globalThis.document={querySelector:()=>null,querySelectorAll:()=>[],getElementById:()=>null};
 const bus=new EventTarget(),jobs=new Map(),sent=[];let n=0,time=0;
 const set=(fn,delay,repeat=false)=>{const id=++n;jobs.set(id,{fn,at:time+delay,delay,repeat});return id;};
 const tick=ms=>{const end=time+ms;for(;;){const first=[...jobs].filter(([,job])=>job.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!first)break;
   const [id,job]=first;time=job.at;jobs.delete(id);job.fn();if(job.repeat&&!job.cancelled)jobs.set(id,{...job,at:time+job.delay});}time=end;};
 const flux={dispatch(action){sent.push(structuredClone(action));return action.type;},subscribe(){throw new Error('duplicate native listener');},unsubscribe(){throw new Error('duplicate native listener');}},original=flux.dispatch;
 globalThis.window={Syncord:{common:{flux:{FluxDispatcher:flux},stores:{
   GuildStore:{getGuildIds:()=>[GUILD],getGuild:()=>({name:'Unopened X'})},
   ChannelStore:{getChannel:id=>({id,guild_id:GUILD,type:0,name:'never-opened'})},
   PermissionStore:{computePermissions:()=>1024n},SelectedChannelStore:{getChannelId:()=>''},
   UserStore:{getUser:id=>({id,username:'Selected',avatar:'a'}),getCurrentUser:()=>({id:SELF})},
   PresenceStore:{getStatus:()=> 'offline',getActivities:()=>[]},MessageStore:{getMessage:()=>undefined,getMessages:()=>undefined},
 }},webpack:{findByStoreName:()=>undefined}},setTimeout:(fn,delay)=>set(fn,delay),clearTimeout:id=>jobs.delete(id),setInterval:(fn,delay)=>set(fn,delay,true),clearInterval:id=>jobs.delete(id),
 addEventListener:bus.addEventListener.bind(bus),removeEventListener:bus.removeEventListener.bind(bus),dispatchEvent:bus.dispatchEvent.bind(bus)};
 const ctx=()=>{const clean=[];return {disposable:fn=>clean.push(fn),settings:{get:(key,fallback)=>saved[key]??fallback,set:(key,value)=>saved[key]=value},
   log:{info(){},warn(){},error(error){throw new Error(String(error));}},css:{inject(){}},stop:()=>{for(const fn of clean.reverse())fn();}};};
 return {flux,original,tick,ctx,jobs,sent,emit:action=>flux.dispatch(action)};
}
for(const first of ['logger','activity'])test(`unopened guild integration: ${first} starts first, one hook and both plugins receive create/edit/delete`,async()=>{
 const f=world(),logger=f.ctx(),activity=f.ctx();
 const startLogger=()=>T.MessageLoggerPlugin.start(logger),startActivity=()=>T.startActivity(activity);
 if(first==='logger'){startLogger();startActivity();}else{startActivity();startLogger();}
 assert.deepEqual(T.discordEventStats(),{listeners:15,interceptors:2,attached:true});assert.equal(T.guildCoverageStatus().consumers,2);
 f.tick(250);assert.equal(T.guildCoverageStatus().guilds,1);
 const message={id:MESSAGE,channel_id:CHANNEL,content:'before',author:{id:USER,username:'Selected'}};
 f.emit({type:'MESSAGE_CREATE',message});f.tick(250);assert.equal(notices.length,1);assert.match(notices[0],/Sent a message.*Unopened X/);
 f.emit({type:'MESSAGE_UPDATE',message:{id:MESSAGE,channel_id:CHANNEL,content:'after'}});assert.deepEqual(edits,[{previous:'before',next:'after'}]);
 f.emit({type:'MESSAGE_DELETE',id:MESSAGE,channelId:CHANNEL});await Promise.resolve();assert.equal(deleted.length,1);assert.equal(deleted[0].content,'after');
 assert.equal(f.sent.filter(a=>a.type==='MESSAGE_CREATE').length,1);assert.equal(f.sent.filter(a=>a.type==='GUILD_SUBSCRIPTIONS_FLUSH').length,1);
 assert.ok(!f.sent.some(a=>a.type==='LOAD_MESSAGES'||a.type==='CHANNEL_SELECT'));
 logger.stop();assert.equal(T.guildCoverageStatus().consumers,1);assert.equal(T.discordEventStats().interceptors,1);
 f.emit({type:'MESSAGE_CREATE',message:{...message,id:'1425993161108357196'}});activity.stop();assert.equal(T.discordEventStats().attached,false);assert.equal(f.flux.dispatch,f.original);assert.equal(f.jobs.size,0);
});
test('unopened guild integration: permissions still exclude hidden channels and pre-start content is never fabricated',()=>{
 const f=world(),logger=f.ctx();T.MessageLoggerPlugin.start(logger);f.tick(250);
 f.emit({type:'MESSAGE_DELETE',id:MESSAGE,channelId:CHANNEL});assert.equal(deleted.length,0);
 window.Syncord.common.stores.PermissionStore.computePermissions=()=>0n;
 f.emit({type:'MESSAGE_CREATE',message:{id:MESSAGE,channel_id:CHANNEL,content:'hidden',author:{id:USER}}});
 f.emit({type:'MESSAGE_DELETE',id:MESSAGE,channelId:CHANNEL});assert.equal(deleted.length,0);logger.stop();assert.equal(f.jobs.size,0);
});

test('message logger: disabling immediately after deletion cancels pending paint and notices',async()=>{
 const f=world(),logger=f.ctx();T.MessageLoggerPlugin.start(logger);f.tick(250);
 let touches=0;document.getElementById=()=>{touches++;return null;};
 f.emit({type:'MESSAGE_CREATE',message:{id:MESSAGE,channel_id:CHANNEL,content:'new',author:{id:USER}}});
 f.emit({type:'MESSAGE_DELETE',id:MESSAGE,channelId:CHANNEL});logger.stop();const before=touches;
 await Promise.resolve();assert.equal(touches,before);assert.equal(f.jobs.size,0);assert.equal(f.flux.dispatch,f.original);
});
