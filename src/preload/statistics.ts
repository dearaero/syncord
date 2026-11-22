import {webFrame} from 'electron';
import type {RendererMemoryStatistics} from '../shared/statistics';
const size=(n:number):number=>Number.isFinite(n)&&n>=0?n:0;
let cached:RendererMemoryStatistics|undefined;
/** Numeric measurements only; never expose Electron handles or retain page objects. */
export function rendererMemory():RendererMemoryStatistics {
 const now=Date.now();if(cached&&now-cached.sampledAt<1000)return cached;
 const result:RendererMemoryStatistics={sampledAt:now,heap:null,blink:null,cache:null};
 // Electron's heap/Blink APIs report KiB; webFrame cache sizes are bytes.
 try{const h=process.getHeapStatistics();result.heap={used:size(h.usedHeapSize)*1024,total:size(h.totalHeapSize)*1024};}catch{/* Older runtime. */}
 try{const b=process.getBlinkMemoryInfo();result.blink={used:size(b.allocated)*1024,total:size(b.total)*1024};}catch{/* Older runtime. */}
 try{const r=webFrame.getResourceUsage();result.cache={images:size(r.images.size),scripts:size(r.scripts.size),styles:size(r.cssStyleSheets.size),fonts:size(r.fonts.size),other:size(r.other.size)+size(r.xslStyleSheets.size)};}catch{/* Frame shutting down. */}
 return cached=result;
}
