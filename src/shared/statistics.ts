/** Read-only local diagnostics. Never includes URLs, headers, content or file paths. */
export type ProcessStatistics = {pid:number;kind:string;name:string;cpuPercent:number|null;cpuSeconds:number|null;memoryBytes:number;peakBytes:number;privateBytes:number|null;ageSeconds:number;sandboxed:boolean|null};
export type NetworkStatistics = {since:number;httpReceived:number;httpSubmitted:number;wsReceived:number;wsSent:number;requests:number;failed:number;cached:number;activeRequests:number;framesReceived:number;framesSent:number;activeSockets:number;activeTargets:number;unavailableTargets:number;gaps:number;droppedRequests:number;unknownUploads:number};
export type StatisticsSnapshot = {
 sampledAt:number;startedAt:number;uptimeSeconds:number;build:{version:string;id:string;electron:string;chromium:string;node:string;integrity:string};
 system:{platform:string;arch:string;release:string;logicalCpus:number;cpuModel:string;memoryTotal:number;memoryFree:number;uptimeSeconds:number};
 resources:{available:boolean;cpuPercent:number|null;cpuCapacityPercent:number|null;memoryBytes:number;peakObservedBytes:number;processes:ProcessStatistics[];truncated:boolean};
 mainHeap:{used:number;total:number;external:number;arrayBuffers:number};network:NetworkStatistics;
};
export type StorageMeasurement={bytes:number;files:number;complete:boolean;available:boolean};
export type StorageStatistics={sampledAt:number;profile:StorageMeasurement;syncord:StorageMeasurement;recordings:StorageMeasurement;bundles:StorageMeasurement;disk:{total:number;available:number}|null};
export type RendererMemoryStatistics={sampledAt:number;heap:{used:number;total:number}|null;blink:{used:number;total:number}|null;cache:{images:number;scripts:number;styles:number;fonts:number;other:number}|null};
export type StatisticsBridge={snapshot():Promise<StatisticsSnapshot>;rendererMemory?():RendererMemoryStatistics;storage():Promise<StorageStatistics>};
