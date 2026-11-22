import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
const dir=mkdtempSync(path.join(tmpdir(),'syncord-performance-'));
await build({stdin:{resolveDir:process.cwd(),contents:`export * from './src/renderer/core/performance/state';export * from './src/renderer/core/performance/native';export * from './src/renderer/core/performance/decorations';`},bundle:true,platform:'node',format:'esm',outfile:dir+'/mode.mjs',logLevel:'silent'});
const api=await import(dir+'/mode.mjs');
test.after(()=>rmSync(dir,{recursive:true,force:true}));
function clock(){
 let time=0,serial=0;const jobs=new Map(),events=new Map();
 globalThis.window={setTimeout:(fn,ms)=>{const id=++serial;jobs.set(id,{at:time+ms,fn});return id;}};
 globalThis.clearTimeout=id=>jobs.delete(id);
 globalThis.requestAnimationFrame=fn=>window.setTimeout(fn,16);
 globalThis.cancelAnimationFrame=clearTimeout;
 globalThis.document={hidden:false,addEventListener:(type,fn)=>{const set=events.get(type)??new Set();set.add(fn);events.set(type,set);},removeEventListener:(type,fn)=>events.get(type)?.delete(fn)};
 return {advance(ms){const end=time+ms;while(true){const next=[...jobs].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;time=next[1].at;jobs.delete(next[0]);next[1].fn(time);}time=end;},visibility(hidden){document.hidden=hidden;for(const fn of events.get('visibilitychange')??[])fn();},pending:()=>jobs.size,listeners:()=>[...events.values()].reduce((n,v)=>n+v.size,0)};
}
test('continuous decoration churn is coalesced without dropping the final update',()=>{
 const c=clock();let runs=0;const task=api.decorationScheduler(()=>runs++);
 api.setPerformanceMode(false,false);
 for(let i=0;i<60;i++){task.schedule();c.advance(16);}c.advance(150);const before=runs;
 runs=0;api.setPerformanceMode(true,false);
 for(let i=0;i<60;i++){task.schedule();c.advance(16);}c.advance(150);const after=runs;
 assert.equal(before,60);assert.equal(after,8);assert(after<before/5);
 task.dispose();api.setPerformanceMode(false,false);assert.equal(c.pending(),0);assert.equal(c.listeners(),0);
 console.log('PERFORMANCE_MODE_WORK:'+JSON.stringify({events:60,beforeScans:before,afterScans:after,reductionPercent:(1-after/before)*100}));
});
test('hidden windows defer decorations, mode changes reschedule, logout cancellation can resume, disposal drains timers/listeners',()=>{
 const c=clock();api.setPerformanceMode(true,false);let runs=0;
 for(let cycle=0;cycle<30;cycle++){
  const task=api.decorationScheduler(()=>runs++);c.visibility(true);task.schedule();c.advance(500);const old=runs;
  assert.equal(c.pending(),0);c.visibility(false);c.advance(120);assert.equal(runs,old+1);
  task.schedule();task.cancel();c.advance(150);assert.equal(runs,old+1);
  task.schedule();api.setPerformanceMode(false,false);c.advance(16);assert.equal(runs,old+2);
  task.schedule();task.dispose();c.advance(150);assert.equal(runs,old+2);assert.equal(c.pending(),0);assert.equal(c.listeners(),0);
  api.setPerformanceMode(true,false);
 }
 api.setPerformanceMode(false,false);
});
class SpringFixture {
 steps=0;rests=0;active=true;
 get idle(){return !this.active;}
 advance(){this.steps++;if(this.steps===60)this.finish();}
 _resume(){} start(){} update(){} set(){} pause(){} resume(){}
 finish(){if(this.active){this.active=false;this.rests++;}return this;}
}
test('native springs use their finish contract on the next advance; loop scheduling, restoration and unrelated classes survive',()=>{
 const original=SpringFixture.prototype.advance;
 const baseline=new SpringFixture();for(let i=0;i<60;i++)baseline.advance();assert.equal(baseline.steps,60);
 const undo=api.accelerateSpring(SpringFixture);assert.equal(typeof undo,'function');
 const fast=new SpringFixture();assert.equal(fast.active,true,'_resume is not completed synchronously');assert.equal(fast.advance(),fast);assert.equal(fast.steps,0);assert.equal(fast.rests,1);fast.advance();assert.equal(fast.rests,1);
 undo();assert.equal(SpringFixture.prototype.advance,original);const restored=new SpringFixture();restored.advance();assert.equal(restored.steps,1);assert.equal(restored.rests,0);
 assert.equal(api.accelerateSpring(class Unrelated{advance(){}finish(){}}),undefined);
 class Frozen extends SpringFixture{get idle(){return super.idle;}advance(){super.advance();}}
 Object.freeze(Frozen.prototype);assert.equal(api.accelerateSpring(Frozen),undefined);
});
