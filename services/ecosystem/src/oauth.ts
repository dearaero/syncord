/** Confidential OAuth2 client. These identify-scoped OAuth credentials are
 * issued by Discord here, never extracted from the installed Discord client. */
import {ApiError,type Database,type Env} from './types';
import {ecoAccount} from '../../../src/shared/ecosystem';
import {hash,challenge,random} from './crypto';
const html=(message:string,status=200,cookie?:string):Response=>new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Syncord Ecosystem</title><h1>Syncord Ecosystem</h1><p>'+message+'</p></html>',{status,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'",...(cookie?{'set-cookie':cookie}:{})}});
export async function discordFetch(url:string,init:RequestInit):Promise<Record<string,unknown>>{
 const response=await fetch(url,{...init,redirect:'manual',signal:AbortSignal.timeout(10000)});
 if(!response.ok){await response.body?.cancel();throw new ApiError(502,'discord_verification_unavailable');}
 const reader=response.body?.getReader();let text='';if(reader){const decoder=new TextDecoder();let bytes=0;try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>16384){await reader.cancel();throw new ApiError(502,'discord_response_too_large');}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}}
 const r=JSON.parse(text) as unknown;if(!r||typeof r!=='object'||Array.isArray(r))throw new ApiError(502,'discord_invalid_response');return r as Record<string,unknown>;
}
export async function oauthRoutes(request:Request,env:Env,db:Database,now:number):Promise<Response>{
 if(request.method!=='GET'||env.PUBLIC_ORIGIN!=='https://api.syncord.pro'||!env.DISCORD_CLIENT_SECRET||!/^\d{17,20}$/.test(env.DISCORD_CLIENT_ID))throw new ApiError(503,'verification_unconfigured');
 const url=new URL(request.url),state=url.searchParams.get('state');if(!state||!/^[a-f0-9]{64}$/.test(state))throw new ApiError(400,'invalid_oauth_state');
 const stateHash=await hash(state),cookieName='__Host-syncord-'+state.slice(0,16),clearCookie=cookieName+'=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
 const row=await db.prepare("SELECT poll_hash,expected_id,verifier,browser_hash,consumed FROM challenges WHERE state_hash=? AND expires_at>? AND purpose='user'").bind(stateHash,now).first<{poll_hash:string;expected_id:string;verifier:string;browser_hash:string|null;consumed:number}>();
 if(!row||row.consumed)throw new ApiError(410,'link_expired');
 if(url.pathname==='/oauth/start'){
  const browser=random();await db.prepare('UPDATE challenges SET browser_hash=? WHERE state_hash=? AND consumed=0').bind(await hash(browser),stateHash).run();
  const target=new URL('https://discord.com/oauth2/authorize');for(const [key,value]of Object.entries({response_type:'code',client_id:env.DISCORD_CLIENT_ID,scope:'identify',redirect_uri:env.PUBLIC_ORIGIN+'/oauth/callback',state,code_challenge:await challenge(row.verifier),code_challenge_method:'S256'}))target.searchParams.set(key,value);
  return new Response(null,{status:302,headers:{location:target.href,'set-cookie':cookieName+'='+browser+'; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600','cache-control':'no-store','referrer-policy':'no-referrer'}});
 }
 if(url.pathname!=='/oauth/callback')throw new ApiError(404,'not_found');
 const cookies=(request.headers.get('cookie')??'').split(';').map(x=>x.trim()),browser=cookies.find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);
 if(!browser||!row.browser_hash||await hash(browser)!==row.browser_hash||url.searchParams.get('iss')!=='https://discord.com')throw new ApiError(401,'invalid_oauth_state');
 const claimed=await db.prepare('UPDATE challenges SET consumed=1 WHERE state_hash=? AND consumed=0 RETURNING poll_hash').bind(stateHash).first();if(!claimed)throw new ApiError(410,'link_expired');
 let credential:string|undefined;
 try{
  const code=url.searchParams.get('code');if(url.searchParams.has('error')||!code||code.length>2048)throw new ApiError(400,'authorization_declined');
  const tokens=await discordFetch('https://discord.com/api/oauth2/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.DISCORD_CLIENT_ID,client_secret:env.DISCORD_CLIENT_SECRET,grant_type:'authorization_code',code,redirect_uri:env.PUBLIC_ORIGIN+'/oauth/callback',code_verifier:row.verifier})});
  if(typeof tokens.access_token!=='string'||!tokens.access_token||tokens.access_token.length>4096)throw new ApiError(401,'invalid_oauth_token');credential=tokens.access_token;
  if(tokens.token_type!=='Bearer'||tokens.scope!=='identify')throw new ApiError(401,'invalid_oauth_scope');
  const user=await discordFetch('https://discord.com/api/v10/users/@me',{headers:{authorization:'Bearer '+credential}}),id=ecoAccount(user.id);
  if(id!==row.expected_id)throw new ApiError(403,'discord_account_mismatch');
  const username=typeof user.username==='string'?user.username.slice(0,80):id,avatar=typeof user.avatar==='string'&&/^(?:a_)?[a-f0-9]{32}$/.test(user.avatar)?user.avatar:null;
  await db.batch([
   db.prepare('INSERT INTO accounts(id,username,avatar,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,avatar=excluded.avatar').bind(id,username,avatar,now),
   db.prepare('UPDATE challenges SET verified_id=?,verifier=\'\',browser_hash=NULL WHERE state_hash=? AND consumed=1').bind(id,stateHash),
   db.prepare(`INSERT INTO reward_grants(id,account_id,rule_id,event_id,amount,created_at) SELECT ?,?,'verified-welcome',?,amount,? FROM reward_rules r WHERE id='verified-welcome' AND enabled=1 AND NOT EXISTS(SELECT 1 FROM reward_grants WHERE account_id=? AND rule_id='verified-welcome')`).bind(crypto.randomUUID(),id,id,now,id)
  ]);
  return html('Discord verification complete. Return to the Syncord panel. You can close this page.',200,clearCookie);
 }catch(error){await db.prepare('UPDATE challenges SET failure=?,verifier=\'\',browser_hash=NULL WHERE state_hash=?').bind('verification_failed',stateHash).run();return html(error instanceof ApiError&&error.code==='discord_account_mismatch'?'A different Discord account was authorized. Return to Syncord and retry with the matching account.':'Discord verification could not be completed. Return to Syncord and start a new authorization.',400,clearCookie);}
 finally{
  // No OAuth access/refresh token is persisted or returned to the browser/client.
  if(credential)try{const r=await fetch('https://discord.com/api/oauth2/token/revoke',{method:'POST',redirect:'manual',signal:AbortSignal.timeout(5000),headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.DISCORD_CLIENT_ID,client_secret:env.DISCORD_CLIENT_SECRET,token:credential,token_type_hint:'access_token'})});await r.body?.cancel();}catch{/* Credential is discarded even if revocation is temporarily unavailable. */}
 }
}
