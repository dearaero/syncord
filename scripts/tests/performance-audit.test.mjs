import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
const dir=mkdtempSync(path.join(tmpdir(),'syncord-audit-perf-'));
await build({stdin:{resolveDir:process.cwd(),contents:"export {trimAuditLog} from './src/main/security/auditLog';"},bundle:true,platform:'node',format:'esm',outfile:dir+'/audit.mjs',logLevel:'silent',plugins:[{name:'paths',setup(b){b.onResolve({filter:/^\.\/core$/},a=>a.importer.endsWith('/security/auditLog.ts')?{path:'core',namespace:'fixture'}:undefined);b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const SyncordUserDataPath=()=>"";'}));}}]});
const {trimAuditLog}=await import(dir+'/audit.mjs');test.after(()=>rmSync(dir,{recursive:true,force:true}));
// Original retention algorithm, used for equivalence and work-count comparison.
function original(existing,incoming,maxBytes){const lines=existing.split('\n');let total=Buffer.byteLength(existing);while(total+Buffer.byteLength(incoming)>maxBytes&&lines.length>1)total-=Buffer.byteLength(`${lines.shift()??''}\n`);return lines.join('\n');}
test('audit trimming preserves byte bounds and identical complete UTF-8 records',()=>{
 for(let n=1;n<=80;n++){const existing=Array.from({length:n},(_,i)=>JSON.stringify({id:i,message:'Türkçe 日本語 🙂'.repeat(i%5+1)})).join('\n')+'\n',incoming='new record\n'.repeat(n),maxBytes=1000;const result=trimAuditLog(existing,Buffer.byteLength(existing),Buffer.byteLength(incoming),maxBytes);assert.equal(result,original(existing,incoming,maxBytes));if(Buffer.byteLength(incoming)<=maxBytes)assert(Buffer.byteLength(result+incoming)<=maxBytes);for(const line of result.trim().split('\n').filter(Boolean))assert.doesNotThrow(()=>JSON.parse(line));}
});
test('audit main-thread trimming avoids repeatedly measuring the incoming batch',()=>{
 const existing=Array.from({length:1000},(_,id)=>JSON.stringify({id,message:'x'.repeat(990)})).join('\n')+'\n',incoming='x'.repeat(500000),limit=1024*1024;
 const measure=fn=>{const native=Buffer.byteLength;let calls=0,bytesVisited=0;Buffer.byteLength=function(value,...args){calls++;bytesVisited+=value.length;return native(value,...args);};try{const start=performance.now(),value=fn();return {value,calls,bytesVisited,ms:performance.now()-start};}finally{Buffer.byteLength=native;}};
 const before=measure(()=>original(existing,incoming,limit)),after=measure(()=>trimAuditLog(existing,Buffer.byteLength(existing),Buffer.byteLength(incoming),limit));assert.equal(after.value,before.value);assert(after.bytesVisited<before.bytesVisited/50);console.log('AUDIT_PERF:'+JSON.stringify({before:{calls:before.calls,bytesVisited:before.bytesVisited,ms:before.ms},after:{calls:after.calls,bytesVisited:after.bytesVisited,ms:after.ms}}));
});
