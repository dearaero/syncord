import {ecoAccount} from '../../../../src/shared/ecosystem';
import {ApiError,type Database,type Env} from '../types';
import {hash,secretEqual} from '../crypto';
export const ADMIN_COOKIE='__Host-syncord-admin';
export const ADMIN_ORIGIN='https://api.syncord.pro';
export const ADMIN_TTL=15*60000;
export const headers={
 'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer',
 'content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; require-trusted-types-for 'script'",
 'x-frame-options':'DENY','cross-origin-opener-policy':'same-origin','cross-origin-resource-policy':'same-origin',
 'permissions-policy':'camera=(), microphone=(), geolocation=(), payment=()',
 'strict-transport-security':'max-age=31536000',
};
// Native form POSTs need a non-opaque Origin, and Chromium checks form-action
// against the OAuth redirect as well as the initial same-origin destination.
// Other responses (especially callbacks) keep the stricter defaults above.
export const pageHeaders={
 ...headers,'referrer-policy':'same-origin',
 'content-security-policy':headers['content-security-policy'].replace("form-action 'self';","form-action 'self' https://discord.com/oauth2/authorize;"),
};
export function response(value:unknown,status=200):Response{return Response.json(value,{status,headers});}
export function cookies(request:Request,name:string):string|undefined{
 const raw=request.headers.get('cookie')??'';if(raw.length>8192)return undefined;
 const matches=raw.split(';').map(s=>s.trim()).filter(s=>s.startsWith(name+'='));
 const value=matches.length===1?matches[0]!.slice(name.length+1):'';return /^[a-f0-9]{64}$/.test(value)?value:undefined;
}
export function allowlist(env:Env):Set<string>{
 try{const values=env.ADMIN_DISCORD_IDS?.split(',').map(v=>v.trim())??[];if(!values.length||values.length>8)return new Set();return new Set(values.map(ecoAccount));}catch{return new Set();}
}
export function sameOrigin(request:Request):void{
 if(request.headers.get('origin')!==ADMIN_ORIGIN)throw new ApiError(403,'admin_origin_denied');
 const site=request.headers.get('sec-fetch-site');if(site&&site!=='same-origin')throw new ApiError(403,'admin_origin_denied');
}
export async function quota(db:Database,request:Request,now:number,group:string,max:number,actor?:string):Promise<void>{
 const minute=Math.floor(now/60000),subject=actor??request.headers.get('cf-connecting-ip')??'local';
 const key=await hash('admin:'+group+':'+subject+':'+minute);
 const row=await db.prepare('INSERT INTO request_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(key,now+120000).first<{count:number}>();
 if(!row||row.count>max)throw new ApiError(429,'admin_rate_limited');
}
export type Session={hash:string;account_id:string;username:string;csrf:string;expires_at:number;created_at:number};
export async function session(request:Request,env:Env,db:Database,now:number):Promise<Session>{
 const token=cookies(request,ADMIN_COOKIE);if(!token)throw new ApiError(401,'admin_sign_in_required');
 const row=await db.prepare('SELECT * FROM admin_sessions WHERE hash=? AND expires_at>?').bind(await hash(token),now).first<Session>();
 if(!row)throw new ApiError(401,'admin_session_expired');
 if(!allowlist(env).has(row.account_id))throw new ApiError(403,'admin_access_denied');return row;
}
export async function csrf(request:Request,s:Session):Promise<void>{
 sameOrigin(request);const token=request.headers.get('x-csrf-token')??'';
 if(!/^[a-f0-9]{64}$/.test(token)||!await secretEqual(token,s.csrf))throw new ApiError(403,'admin_csrf_denied');
}
export function clearSessionCookie():string{return ADMIN_COOKIE+'=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0';}
