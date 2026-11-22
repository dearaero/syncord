/** Development-only build policy: explicit opt-in, at most two jobs, one Cargo build. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
export function cargoJobs(value=process.env.SYNCORD_CARGO_JOBS){
 if(value===undefined||value.trim()==='')return 2;
 if(!/^[1-9]\d*$/.test(value)||!Number.isSafeInteger(Number(value)))throw Error('SYNCORD_CARGO_JOBS must be a positive integer.');
 return Math.min(2,Number(value));
}
export const CARGO_JOBS=cargoJobs();
export const CARGO_JOB_FLAGS=Object.freeze(['-j',String(CARGO_JOBS)]);
export const CARGO_ENV=Object.freeze({CARGO_BUILD_JOBS:String(CARGO_JOBS),CARGO_PROFILE_DEV_CODEGEN_UNITS:'1',CARGO_PROFILE_RELEASE_CODEGEN_UNITS:'1',CARGO_PROFILE_TEST_CODEGEN_UNITS:'1',CARGO_PROFILE_BENCH_CODEGEN_UNITS:'1',RAYON_NUM_THREADS:'1',CMAKE_BUILD_PARALLEL_LEVEL:'1'});
export const injectorBuildAllowed=()=>process.env.SYNCORD_ALLOW_INJECTOR_BUILD==='1';
const compiling=new Set(['build','check','clippy','test','run','bench','doc','rustc','rustdoc','install']);
const readOnly=new Set(['--version','version','metadata','fmt','audit','deny']);
export const RUST_BUILD_LOCK=path.join(os.tmpdir(),'syncord-rust-'+crypto.createHash('sha256').update(os.userInfo().username).digest('hex').slice(0,16)+'.lock');
export function acquireRustBuildLock(){
 const token=crypto.randomUUID();let fd;
 try{fd=fs.openSync(RUST_BUILD_LOCK,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw Error('Another Syncord Rust build owns the lock. Wait for it to finish; delete the lock file only if no Rust build is running.');throw error;}
 try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid,token,startedAt:new Date().toISOString()}));}catch(error){fs.closeSync(fd);fs.unlinkSync(RUST_BUILD_LOCK);throw error;}fs.closeSync(fd);
 return()=>{try{const owner=JSON.parse(fs.readFileSync(RUST_BUILD_LOCK,'utf8'));if(owner.pid===process.pid&&owner.token===token)fs.unlinkSync(RUST_BUILD_LOCK);}catch(error){if(error.code!=='ENOENT')throw error;}};
}
export function cargoInvocation(args,env=process.env){
 if(!Array.isArray(args)||!args.length||args.some(v=>typeof v!=='string'))throw Error('Choose a Cargo command.');
 const compile=compiling.has(args[0]);if(!compile&&!readOnly.has(args[0]))throw Error('Unsupported Cargo command.');
 if(compile&&env.SYNCORD_ALLOW_INJECTOR_BUILD!=='1')throw Error('Injector compilation is disabled. It requires an explicit user request and --allow-build.');
 const result=[args[0]],tail=[];let jobs=cargoJobs(env.SYNCORD_CARGO_JOBS),separator=false;
 for(let i=1;i<args.length;i++){const arg=args[i];if(separator){tail.push(arg);continue;}if(arg==='--'){separator=true;continue;}
  let value;if(arg==='-j'||arg==='--jobs')value=args[++i];else if(/^(-j\d|--jobs=)/.test(arg))value=arg.replace(/^(?:-j|--jobs=)/,'');
  if(value!==undefined){if(!/^[12]$/.test(value))throw Error('Rust compilation permits only -j1 or -j2.');jobs=Math.min(jobs,Number(value));}else if(arg==='-j'||arg==='--jobs')throw Error('Missing Cargo jobs value.');else result.push(arg);
 }
 if(compile)result.push('--jobs',String(jobs));if(separator)result.push('--',...tail);
 return{args:result,env:{...env,...CARGO_ENV,CARGO_BUILD_JOBS:String(jobs)},compile};
}
export function runCargoSync(args,options={}){
 const invocation=cargoInvocation(args,options.env??process.env),release=invocation.compile?acquireRustBuildLock():()=>{};
 try{return spawnSync('cargo',invocation.args,{...options,env:invocation.env});}finally{release();}
}
