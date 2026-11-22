#!/usr/bin/env node
/** Explicit operator entry point. Never invoked by normal build/verify. */
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {cargoInvocation,acquireRustBuildLock} from './lib/rust-build.mjs';
const args=process.argv.slice(2),approved=args[0]==='--allow-build';if(approved)args.shift();
try{
 const invocation=cargoInvocation(args,{...process.env,...(approved?{SYNCORD_ALLOW_INJECTOR_BUILD:'1'}:{})});
 const release=invocation.compile?acquireRustBuildLock():()=>{};
 try{
  const child=spawn('cargo',invocation.args,{cwd:fileURLToPath(new URL('../injector/',import.meta.url)),env:invocation.env,stdio:'inherit'});
  const interrupt=()=>child.kill('SIGINT'),terminate=()=>child.kill('SIGTERM');process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
  try{process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve(code??(signal==='SIGINT'?130:143)));});}
  finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',terminate);}
 }finally{release();}
}catch(error){console.error(error.message);process.exitCode=1;}
