/** Async, sequential disk IO. Hash work is bounded to one 256 KiB disk block
 * per await; no whole-file buffer or synchronous multi-gigabyte hash pass. */
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DROP_BLOCK,dropFile,type DropFile} from '../../shared/drop';
const fail=():never=>{throw Error('drop.file_error');};
export function saveName(name:string):string {let v=name.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g,'_').replace(/[. ]+$/,'');if(!v||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(v))v='_'+v;return Array.from(v).slice(0,120).join('');}
export class DropSource {
 private offset=0;private hash=createHash('sha256');private busy=false;private closed=false;
 private constructor(private handle:fs.FileHandle,readonly file:DropFile,private stamp:{dev:number;ino:number;mtimeMs:number}){}
 static async open(file:string):Promise<DropSource>{
  const before=await fs.lstat(file);if(!before.isFile()||before.isSymbolicLink())return fail();
  const handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{const stat=await handle.stat();if(!stat.isFile()||stat.ino!==before.ino||stat.dev!==before.dev)return fail();return new DropSource(handle,dropFile({name:path.basename(file),size:stat.size}),stat);}catch(e){await handle.close();throw e;}
 }
 async read():Promise<Uint8Array>{
  if(this.closed||this.busy)throw Error('drop.state');this.busy=true;
  try{const data=Buffer.allocUnsafe(Math.min(DROP_BLOCK,this.file.size-this.offset));let n=0;
   while(n<data.length){const r=await this.handle.read(data,n,data.length-n,this.offset+n);if(!r.bytesRead)throw Error('drop.file_error');n+=r.bytesRead;}
   this.offset+=n;this.hash.update(data);return new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
  }finally{this.busy=false;}
 }
 async digest():Promise<string>{
  if(this.closed||this.busy||this.offset!==this.file.size)throw Error('drop.state');const stat=await this.handle.stat();
  if(stat.size!==this.file.size||stat.mtimeMs!==this.stamp.mtimeMs||stat.ino!==this.stamp.ino||stat.dev!==this.stamp.dev)throw Error('drop.file_error');
  return this.hash.copy().digest('hex');
 }
 async close():Promise<void>{if(this.closed)return;this.closed=true;await this.handle.close().catch(()=>{});}
}
export class DropSink {
 private offset=0;private hash=createHash('sha256');private busy=false;private closed=false;private saved=false;
 private constructor(private handle:fs.FileHandle,private part:string,private target:string,readonly file:DropFile,private parent:string,private inode:number){}
 static async open(target:string,file:DropFile):Promise<DropSink>{
  dropFile(file);const parent=await fs.realpath(path.dirname(target)),destination=path.join(parent,path.basename(target));
  // Never replace an existing file, including a symlink. A successful native
  // overwrite prompt is not permission for this capability to race another writer.
  try{await fs.lstat(destination);throw Error('drop.exists');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const part=path.join(parent,'.syncord-drop-'+randomUUID()+'.part');const h=await fs.open(part,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW??0),0o600);
  try{const stat=await h.stat();return new DropSink(h,part,destination,file,parent,stat.ino);}catch(e){await h.close();await fs.unlink(part).catch(()=>{});throw e;}
 }
 async write(bytes:unknown):Promise<number>{
  if(this.closed||this.busy||!(bytes instanceof Uint8Array)||!bytes.byteLength||bytes.byteLength>DROP_BLOCK||this.offset+bytes.byteLength>this.file.size)throw Error('drop.state');
  this.busy=true;try{let n=0;while(n<bytes.byteLength){const r=await this.handle.write(bytes,n,bytes.byteLength-n,this.offset+n);if(!r.bytesWritten)throw Error('drop.file_error');n+=r.bytesWritten;}
   this.hash.update(bytes);this.offset+=bytes.byteLength;return this.offset;
  }catch(e){if((e as NodeJS.ErrnoException).code==='ENOSPC')throw Error('drop.disk_full');throw Error('drop.file_error');}finally{this.busy=false;}
 }
 async finish(digest:unknown):Promise<void>{
  if(this.closed||this.busy||this.offset!==this.file.size||typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest)||this.hash.copy().digest('hex')!==digest)throw Error('drop.integrity');
  this.busy=true;try{
   const stat=await fs.lstat(this.part);if(stat.isSymbolicLink()||!stat.isFile()||stat.ino!==this.inode||await fs.realpath(path.dirname(this.part))!==this.parent)throw Error('drop.file_error');
   await this.handle.sync();await this.handle.close();this.closed=true;
   // Same-directory hard link is atomic and no-replace on Windows/macOS/Linux.
   // Unlike rename(), it cannot silently overwrite a newly created target.
   await fs.link(this.part,this.target);this.saved=true;await fs.unlink(this.part);
  }catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw Error('drop.exists');throw e;}finally{this.busy=false;}
 }
 savedPath():string{if(!this.saved)throw Error('drop.state');return this.target;}
 async close():Promise<void>{if(!this.closed){this.closed=true;await this.handle.close().catch(()=>{});}await fs.unlink(this.part).catch(()=>{});}
}
