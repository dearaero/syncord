import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(path.join(tmpdir(),'syncord-platform-model-'));
await build({stdin:{resolveDir:process.cwd(),loader:'ts',contents:`export * from './src/renderer/api/discordEvents/presence';`},bundle:true,format:'esm',platform:'neutral',outfile:path.join(dir,'model.mjs'),logLevel:'warning'});
const M=await import(pathToFileURL(path.join(dir,'model.mjs')).href);rmSync(dir,{recursive:true,force:true});
const ID='1425993161108357191';
test('platforms: simultaneous desktop/mobile/browser/VR sessions retain their own exact status',()=>{
 const rows=M.platformIndicators('dnd',{desktop:'dnd',mobile:'online',web:'idle',vr:'online'},[]);
 assert.deepEqual(rows.map(r=>[r.id,r.status,r.source]),[['desktop','dnd','session'],['mobile','online','session'],['web','idle','session'],['vr','online','session']]);
 assert.match(M.platformLabel(rows[0]),/Do not disturb/);assert.match(M.platformLabel(rows[2]),/Idle/);
});
test('platforms: offline, invisible, unknown and malformed overall statuses never expose stale client/activity data',()=>{
 for(const status of ['offline','invisible','unknown',null,{},false])assert.deepEqual(M.platformIndicators(status,{desktop:'online'},[{type:0,platform:'xbox'}]),[]);
 assert.deepEqual(M.platformIndicators('online',{desktop:'offline',mobile:'invisible',web:null,vr:true},[]),[]);
 assert.deepEqual(M.platformIndicators(undefined,undefined,[{type:0,platform:'xbox'}]),[]);
 assert.equal(M.platformIndicators(undefined,{mobile:'idle'},[])[0].id,'mobile');
});
test('platforms: explicit console session vs game activity, no inference from game names, supported_platforms or embedded apps',()=>{
 assert.equal(M.platformIndicators('online',{embedded:'online'},[])[0].source,'session');
 const rows=M.platformIndicators('online',{desktop:'online'},[{type:0,platform:'xbox'},{type:0,platform:'ps5'},{type:0,platform:'xbox'}]);
 assert.deepEqual(rows.map(r=>r.id),['desktop','activity-xbox','activity-ps5']);assert.match(M.platformLabel(rows[1]),/not a confirmed Discord login/);
 assert.deepEqual(M.platformIndicators('online',{},[{type:0,name:'Xbox',supported_platforms:['ps5']},{type:0,platform:'embedded'},{type:4,platform:'xbox'},{type:2,platform:'ps5'}]),[]);
 assert.equal(M.platformIndicators('online',{console:'online'},[{type:0,platform:'xbox'}]).length,1);
 assert.deepEqual(M.platformIndicators('online',{},[{type:0,platform:'xbox'}],false),[]);
});
test('platforms: Meta Quest and future clients use bounded safe icons without inventing OS information',()=>{
 assert.equal(M.platformIndicators('online',{},[{type:0,platform:'meta_quest'}])[0].icon,'vr');
 assert.equal(M.platformIndicators('online',{vr:'online'},[{type:0,platform:'meta_quest'}]).length,1);
 const rows=M.platformIndicators('online',{'<img onerror=alert(1)>':'online',future:'idle'},[]);
 assert.equal(rows.length,1);assert.equal(rows[0].label,'Other Discord client');assert.equal(rows[0].icon,'other');
 assert.equal(M.platformIndicators('online',{desktop:'online'},[{type:0,platform:'ios'}]).length,1);
 assert.deepEqual(M.platformIndicators('online',{},Array.from({length:1000},(_,i)=>({type:0,platform:'unknown-'+i}))),[]);
});
test('platforms: native store methods preserve their receiver, malformed/missing data fails locally and hidden activities are never read',()=>{
 const store={calls:[],getStatus(id){this.calls.push(['status',id]);return'online';},getClientStatus(id){this.calls.push(['clients',id]);return{mobile:'online'};},getActivities(id){this.calls.push(['activities',id]);return[];},getHiddenActivities(){throw Error('Must not read hidden activities');}};
 assert.equal(M.isPlatformPresenceStore(store),true);assert.equal(M.readPlatforms(store,ID,false)[0].id,'mobile');assert.equal(store.calls.length,2);
 M.readPlatforms(store,ID,true);assert.equal(store.calls.length,5);
 assert.deepEqual(M.readPlatforms({...store,getClientStatus(){throw Error('native version drift');}},ID,true),[]);
 assert.equal(M.isPlatformPresenceStore({getStatus(){}}),false);assert.equal(M.isPlatformPresenceStore(null),false);
 assert.deepEqual(M.readPlatforms(undefined,ID,true),[]);assert.deepEqual(M.readPlatforms(store,'../../x',true),[]);
});
