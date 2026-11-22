import {ApiError,type Env,type Database} from '../types';
import {adminApi} from './api';
import {supporterAdminApi} from './supporter';
import {uploadAdminPng} from './png';
import {beginAdminLogin,adminCallback,endAdminLogin} from './auth';
import {session,csrf,quota,response,headers,pageHeaders,ADMIN_ORIGIN} from './security';
import {ADMIN_HTML,ADMIN_SCRIPT,ADMIN_CSS} from './page';
function failure(error:unknown):Response{
 if(error instanceof ApiError)return response({error:error.code},error.status);
 const message=error instanceof Error?error.message:'';
 const supporter=/supporter\.[A-Za-z]+/.exec(message)?.[0];if(supporter)return response({error:supporter},409);
 for(const code of ['admin_badge_exists','admin_catalog_full','admin_revision_conflict','admin_badge_deleted','admin_invalid_badge'])if(message.includes(code))return response({error:code},409);
 if(/^(Invalid |Too many |Choose |Duplicate )/.test(message))return response({error:'admin_invalid_input'},400);
 return response({error:'admin_unavailable'},503);
}
export async function adminOAuthCallback(request:Request,env:Env,db:Database,now:number):Promise<Response|undefined>{
 try{
  if(!env.ADMIN_DISCORD_IDS)return;
  await quota(db,request,now,'oauth',30);
  return await adminCallback(request,env,db,now);
 }catch(error){return failure(error);}
}
export async function adminRoutes(request:Request,env:Env,db:Database,now:number):Promise<Response>{
 try{
  const url=new URL(request.url);if(url.origin!==ADMIN_ORIGIN||env.PUBLIC_ORIGIN!==ADMIN_ORIGIN)throw new ApiError(403,'admin_origin_denied');
  await quota(db,request,now,'edge',120);
  const path=url.pathname;
  if(request.method==='GET'){
   const page=path==='/admin'||path==='/admin/';
   const asset=page?{body:ADMIN_HTML,type:'text/html; charset=utf-8'}:path==='/admin/app.js'?{body:ADMIN_SCRIPT,type:'text/javascript; charset=utf-8'}:path==='/admin/style.css'?{body:ADMIN_CSS,type:'text/css; charset=utf-8'}:undefined;
   if(asset)return new Response(asset.body,{headers:{...(page?pageHeaders:headers),'content-type':asset.type}});
  }
  if(path==='/admin/login'&&request.method==='POST'){await quota(db,request,now,'login',5);return await beginAdminLogin(request,env,db,now);}
  const s=await session(request,env,db,now);
  if(request.method!=='GET'){
   await csrf(request,s);await quota(db,request,now,'write',20,s.account_id);
   if(path==='/admin/logout'&&request.method==='POST')return await endAdminLogin(s,db,now);
  }else await quota(db,request,now,'read',90,s.account_id);
  if(path==='/admin/api/badge-images'&&request.method==='POST')return await uploadAdminPng(request,env,db,s,now);
  if(path.startsWith('/admin/api/supporter/'))return await supporterAdminApi(request,env,db,s,now);
  return await adminApi(request,db,s,now);
 }catch(error){return failure(error);}
}
