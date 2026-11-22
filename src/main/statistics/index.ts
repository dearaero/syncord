import {app} from 'electron';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {VERSION} from '../../shared/constants';
import type {StatisticsSnapshot,StorageStatistics} from '../../shared/statistics';
import {SyncordUserDataPath} from '../security/core';
import {integrityStatus} from '../security/integrity';
import {recordingDirectory} from '../recording/store';
import {networkStatistics,installStatisticsNetwork} from './network';
import {ResourceSampler} from './resources';
import {measureStorage} from './storage';
const startedAt=Date.now()-process.uptime()*1000,sampler=new ResourceSampler();let cached:StatisticsSnapshot|undefined,storageCache:StorageStatistics|undefined,storageJob:Promise<StorageStatistics>|undefined;
let identity:StatisticsSnapshot['build']|undefined,systemIdentity:Pick<StatisticsSnapshot['system'],'platform'|'arch'|'release'|'logicalCpus'|'cpuModel'>|undefined;
export const installStatistics=():void=>installStatisticsNetwork();
export function statisticsSnapshot():StatisticsSnapshot {
 const now=Date.now();if(cached&&now-cached.sampledAt<1000)return cached;
 if(!identity){let id='unavailable';try{const file=path.join(__dirname,'integrity.manifest.json'),stat=fs.statSync(file);if(stat.size<=32768)id=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0,12);}catch{/* Development or older install. */}identity={version:VERSION,id,electron:process.versions.electron??'unavailable',chromium:process.versions.chrome??'unavailable',node:process.versions.node,integrity:'unverified'};}
 if(!systemIdentity){const cpus=os.cpus();systemIdentity={platform:process.platform,arch:process.arch,release:os.release(),logicalCpus:Math.max(1,cpus.length),cpuModel:cpus[0]?.model??'Unavailable'};}
 let metrics:Electron.ProcessMetric[]=[];try{metrics=app.getAppMetrics();}catch{/* Not ready or unsupported. */}
 const heap=process.memoryUsage();
 cached={sampledAt:now,startedAt,uptimeSeconds:Math.max(0,(now-startedAt)/1000),build:{...identity,integrity:integrityStatus().state},system:{...systemIdentity,memoryTotal:os.totalmem(),memoryFree:os.freemem(),uptimeSeconds:os.uptime()},resources:sampler.sample(metrics,now,systemIdentity.logicalCpus),mainHeap:{used:heap.heapUsed,total:heap.heapTotal,external:heap.external,arrayBuffers:heap.arrayBuffers},network:networkStatistics()};return cached;
}
export function statisticsStorage():Promise<StorageStatistics>{
 if(storageJob)return storageJob;if(storageCache&&Date.now()-storageCache.sampledAt<120000)return Promise.resolve(storageCache);
 storageJob=measureStorage(app.getPath('userData'),SyncordUserDataPath(),recordingDirectory(),__dirname).then(value=>(storageCache=value)).finally(()=>{storageJob=undefined;});return storageJob;
}
