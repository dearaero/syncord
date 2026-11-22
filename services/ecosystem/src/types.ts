export type Result<T=Record<string,unknown>>={results:T[];meta:{changes:number}};
export interface Statement{bind(...values:unknown[]):Statement;first<T=Record<string,unknown>>():Promise<T|null>;all<T=Record<string,unknown>>():Promise<Result<T>>;run():Promise<Result>}
export interface Database{prepare(sql:string):Statement;batch(statements:Statement[]):Promise<Result[]>;withSession?(mode:string):Database}
export type Env={DB:Database;DISCORD_CLIENT_ID:string;DISCORD_CLIENT_SECRET:string;PUBLIC_ORIGIN:string;REWARD_API_KEY?:string;ADMIN_DISCORD_IDS?:string;BADGE_ASSETS?:BadgeBucket;RELEASES?:ReleaseBucket;BADGE_IMAGES?:BadgeImages;SUPPORTER_UPLOAD_ENABLED?:string};
export class ApiError extends Error{constructor(readonly status:number,readonly code:string){super(code);}}

export interface BadgeBucket {put(key:string,value:Uint8Array,options?:{httpMetadata:{contentType:string}}):Promise<unknown>;get(key:string):Promise<{body:ReadableStream<Uint8Array>;size:number}|null>}
export interface ReleaseBucket {get(key:string):Promise<{body:ReadableStream<Uint8Array>;size:number}|null>}
export interface BadgeImages{info(stream:ReadableStream<Uint8Array>):Promise<{width?:number;height?:number;format?:string}>;input(stream:ReadableStream<Uint8Array>):{transform(options:{width:number;height:number;fit:'pad';background:string;metadata:'none'}):{output(options:{format:'image/png';anim:false}):Promise<{response():Response}>}}}
