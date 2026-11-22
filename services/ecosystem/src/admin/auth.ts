import {ecoAccount} from '../../../../src/shared/ecosystem';
import {ApiError,type Database,type Env} from '../types';
import {hash,random,challenge} from '../crypto';
import {discordFetch} from '../oauth';
import {ADMIN_COOKIE,ADMIN_ORIGIN,ADMIN_TTL,allowlist,cookies,headers,sameOrigin,clearSessionCookie} from './security';
const stateCookie=(state:string):string=>'__Host-syncord-admin-state-'+state.slice(0,16);
export async function beginAdminLogin(request:Request,env:Env,db:Database,now:number):Promise<Response>{
 sameOrigin(request);
 if(!allowlist(env).size||!env.DISCORD_CLIENT_SECRET||!/^\d{17,20}$/.test(env.DISCORD_CLIENT_ID)||env.PUBLIC_ORIGIN!==ADMIN_ORIGIN)throw new ApiError(503,'admin_not_configured');
 const state=random(),browser=random(),verifier=random();
 await db.prepare('INSERT INTO admin_challenges(state_hash,browser_hash,verifier,expires_at) VALUES(?,?,?,?)').bind(await hash(state),await hash(browser),verifier,now+600000).run();
 const url=new URL('https://discord.com/oauth2/authorize');
 for(const [key,value]of Object.entries({response_type:'code',client_id:env.DISCORD_CLIENT_ID,scope:'identify',redirect_uri:ADMIN_ORIGIN+'/oauth/callback',state,code_challenge:await challenge(verifier),code_challenge_method:'S256',prompt:'consent'}))url.searchParams.set(key,value);
 return new Response(null,{status:303,headers:{...headers,location:url.href,'set-cookie':stateCookie(state)+'='+browser+'; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600'}});
}
export async function adminCallback(request:Request,env:Env,db:Database,now:number):Promise<Response|undefined>{
 const url=new URL(request.url),state=url.searchParams.get('state');if(!state||!/^[a-f0-9]{64}$/.test(state))return;
 const digest=await hash(state),row=await db.prepare('SELECT * FROM admin_challenges WHERE state_hash=?').bind(digest).first<{browser_hash:string;verifier:string;consumed:number;expires_at:number}>();if(!row)return;
 if(url.origin!==ADMIN_ORIGIN)throw new ApiError(403,'admin_origin_denied');
 if(request.method!=='GET'||row.consumed||row.expires_at<=now)throw new ApiError(410,'admin_link_expired');
 const browser=cookies(request,stateCookie(state));if(!browser||await hash(browser)!==row.browser_hash||url.searchParams.get('iss')!=='https://discord.com')throw new ApiError(401,'invalid_oauth_state');
 if(env.PUBLIC_ORIGIN!==ADMIN_ORIGIN||!env.DISCORD_CLIENT_SECRET||!allowlist(env).size)throw new ApiError(503,'admin_not_configured');
 const claim=await db.prepare('UPDATE admin_challenges SET consumed=1,verifier=\'\',browser_hash=\'\' WHERE state_hash=? AND consumed=0 RETURNING state_hash').bind(digest).first();if(!claim)throw new ApiError(410,'admin_link_expired');
 const resultHeaders=new Headers(headers);resultHeaders.append('set-cookie',stateCookie(state)+'=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
 let credential:string|undefined;
 try{
  const code=url.searchParams.get('code');if(url.searchParams.has('error')||!code||code.length>2048)throw new ApiError(400,'admin_authorization_declined');
  const tokens=await discordFetch('https://discord.com/api/oauth2/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.DISCORD_CLIENT_ID,client_secret:env.DISCORD_CLIENT_SECRET,grant_type:'authorization_code',code,redirect_uri:ADMIN_ORIGIN+'/oauth/callback',code_verifier:row.verifier})});
  if(typeof tokens.access_token!=='string'||!tokens.access_token||tokens.access_token.length>4096)throw new ApiError(401,'invalid_oauth_token');credential=tokens.access_token;
  if(tokens.token_type!=='Bearer'||tokens.scope!=='identify')throw new ApiError(401,'invalid_oauth_scope');
  const user=await discordFetch('https://discord.com/api/v10/users/@me',{headers:{authorization:'Bearer '+credential}}),id=ecoAccount(user.id);
  if(!allowlist(env).has(id)||user.bot===true||user.system===true)throw new ApiError(403,'admin_access_denied');
  if(user.mfa_enabled!==true)throw new ApiError(403,'admin_mfa_required');
  const raw=random(),csrf=random(),username=typeof user.username==='string'?user.username.slice(0,80):id;
  const old=cookies(request,ADMIN_COOKIE),auditKey=crypto.randomUUID();
  await db.batch([
   ...(old?[db.prepare('DELETE FROM admin_sessions WHERE hash=?').bind(await hash(old))]:[]),
   db.prepare('INSERT INTO admin_sessions(hash,account_id,username,csrf,created_at,expires_at) VALUES(?,?,?,?,?,?)').bind(await hash(raw),id,username,csrf,now,now+ADMIN_TTL),
   db.prepare('INSERT INTO admin_audit(actor_id,request_key,action,target_id,expected_revision,request_hash,after_json,created_at) VALUES(?,?,?,?,0,?,?,?)').bind(id,auditKey,'session.login',id,await hash(auditKey),'{"session":"created"}',now)
  ]);
  resultHeaders.append('set-cookie',ADMIN_COOKIE+'='+raw+'; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=900');resultHeaders.set('location','/admin');
 }catch(error){
  const code=error instanceof ApiError&&['admin_access_denied','admin_mfa_required','admin_authorization_declined'].includes(error.code)?error.code:'admin_verification_failed';
  resultHeaders.set('location','/admin?error='+code);
 }finally{
  if(credential)try{const r=await fetch('https://discord.com/api/oauth2/token/revoke',{method:'POST',redirect:'manual',signal:AbortSignal.timeout(5000),headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.DISCORD_CLIENT_ID,client_secret:env.DISCORD_CLIENT_SECRET,token:credential,token_type_hint:'access_token'})});await r.body?.cancel();}catch{/* Never persist provider credentials, including on upstream failure. */}
 }
 return new Response(null,{status:303,headers:resultHeaders});
}
export async function endAdminLogin(s:{hash:string;account_id:string},db:Database,now:number):Promise<Response>{
 const key=crypto.randomUUID();await db.batch([
  db.prepare('DELETE FROM admin_sessions WHERE hash=?').bind(s.hash),
  db.prepare('INSERT INTO admin_audit(actor_id,request_key,action,target_id,expected_revision,request_hash,after_json,created_at) VALUES(?,?,?,?,0,?,?,?)').bind(s.account_id,key,'session.logout',s.account_id,await hash(key),'{"session":"revoked"}',now)
 ]);return new Response(null,{status:204,headers:{...headers,'set-cookie':clearSessionCookie()}});
}
