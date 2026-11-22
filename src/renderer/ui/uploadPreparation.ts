export type UploadContext={channelId:string;valid:()=>boolean};
export type UploadPreparer=(files:File[],context:UploadContext)=>Promise<File[]|undefined>;
let prepare:UploadPreparer|undefined;
/** Shared optional preflight. It never sends files or calls a Discord API. */
export function registerUploadPreparer(handler:UploadPreparer):()=>void{prepare=handler;return()=>{if(prepare===handler)prepare=undefined;};}
export function prepareUploadFiles(files:File[],context:UploadContext):Promise<File[]|undefined>{return prepare?prepare(files,context):Promise.resolve(files);}
