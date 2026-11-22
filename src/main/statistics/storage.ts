import fs from 'node:fs/promises';
import path from 'node:path';
import type {StorageMeasurement,StorageStatistics} from '../../shared/statistics';
/** Metadata only. No symlinks, contents, arbitrary renderer path, or unbounded walk. */
export async function directorySize(root:string,limits={entries:20000,ms:2000}):Promise<StorageMeasurement>{
 const result:StorageMeasurement={bytes:0,files:0,complete:true,available:true},pending=[{file:root,depth:0}];const until=performance.now()+limits.ms;let entries=0;
 while(pending.length){
  if(performance.now()>until||entries>=limits.entries){result.complete=false;break;}
  const item=pending.pop()!;
  try{
   const stat=await fs.lstat(item.file);if(stat.isSymbolicLink()){result.complete=false;continue;}
   if(stat.isFile()){result.bytes+=stat.size;result.files++;continue;}if(!stat.isDirectory())continue;
   const dir=await fs.opendir(item.file);
   try{for await(const entry of dir){
    if(++entries>limits.entries||performance.now()>until){result.complete=false;break;}
    if(entry.isSymbolicLink()){result.complete=false;continue;}
    if(item.depth>=24||pending.length>=1024){result.complete=false;continue;}
    pending.push({file:path.join(item.file,entry.name),depth:item.depth+1});
   }}catch{result.complete=false;}
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'){result.complete=false;result.available=false;}}
 }
 return result;
}
export async function measureStorage(profile:string,syncord:string,recordings:string,bundles:string):Promise<StorageStatistics>{
 const profileSize=await directorySize(profile),syncordSize=await directorySize(syncord),recordingsSize=await directorySize(recordings);
 const bundleSize:StorageMeasurement={bytes:0,files:0,complete:true,available:true};
 for(const name of ['main.js','preload.js','renderer.js','integrity.manifest.json','syncord-version.json'])try{const s=await fs.lstat(path.join(bundles,name));if(s.isFile()&&!s.isSymbolicLink()){bundleSize.bytes+=s.size;bundleSize.files++;}else bundleSize.complete=false;}catch{bundleSize.complete=false;}
 let disk:StorageStatistics['disk']=null;try{const s=await fs.statfs(profile);disk={total:s.bsize*s.blocks,available:s.bsize*s.bavail};}catch{/* Unsupported filesystem. */}
 return{sampledAt:Date.now(),profile:profileSize,syncord:syncordSize,recordings:recordingsSize,bundles:bundleSize,disk};
}
