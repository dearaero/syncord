import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {cargoInvocation,cargoJobs,acquireRustBuildLock,RUST_BUILD_LOCK} from '../lib/rust-build.mjs';
const approved={SYNCORD_ALLOW_INJECTOR_BUILD:'1'};
test('compilation requires explicit authorization; read-only metadata remains available',()=>{
 for(const command of ['build','check','clippy','test','run','bench','doc','install','rustc','rustdoc'])assert.throws(()=>cargoInvocation([command],{}),/disabled/);
 assert.equal(cargoInvocation(['metadata','--no-deps'],{}).compile,false);
});
test('jobs cannot exceed two and clippy arguments remain after separator',()=>{
 assert.equal(cargoJobs('64'),2);assert.equal(cargoJobs('1'),1);
 assert.throws(()=>cargoJobs('-1'));
 const result=cargoInvocation(['clippy','--workspace','-j2','--','-D','warnings'],{...approved,SYNCORD_CARGO_JOBS:'64',CARGO_BUILD_JOBS:'64',RAYON_NUM_THREADS:'64'});
 assert.deepEqual(result.args,['clippy','--workspace','--jobs','2','--','-D','warnings']);
 assert.equal(result.env.CARGO_BUILD_JOBS,'2');assert.equal(result.env.RAYON_NUM_THREADS,'1');assert.equal(result.env.CARGO_PROFILE_RELEASE_CODEGEN_UNITS,'1');
 for(const args of [['build','-j3'],['build','--jobs=8'],['build','--jobs']])assert.throws(()=>cargoInvocation(args,approved));
 assert.equal(cargoInvocation(['build','-j2'],{...approved,SYNCORD_CARGO_JOBS:'1'}).env.CARGO_BUILD_JOBS,'1');
});
test('cross-process lock rejects a second build and releases deterministically without invoking Cargo',()=>{
 const release=acquireRustBuildLock();
 try{
  const url=new URL('../lib/rust-build.mjs',import.meta.url).href;
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import {acquireRustBuildLock} from ${JSON.stringify(url)}; acquireRustBuildLock();`],{encoding:'utf8'});
  assert.notEqual(child.status,0);assert.match(child.stderr,/Another Syncord Rust build/);
  assert.equal(fs.existsSync(RUST_BUILD_LOCK),true);
 }finally{release();}
 assert.equal(fs.existsSync(RUST_BUILD_LOCK),false);
 const again=acquireRustBuildLock();again();
});
test('default verification gates native suites and keeps the two-job cap',()=>{
 for(const name of ['packaging.test.mjs','update-e2e.test.mjs'])assert.match(fs.readFileSync(new URL(name,import.meta.url),'utf8'),/injectorBuildAllowed\(\)/);
 const config=fs.readFileSync(new URL('../../.cargo/config.toml',import.meta.url),'utf8');assert.match(config,/jobs = 2/);
});
