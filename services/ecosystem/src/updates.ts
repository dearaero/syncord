import {ApiError,type Env} from './types';
import {isReleaseAssetName,isReleaseChannel} from '../../../src/shared/release';
import {normalizeVersion} from '../../../src/shared/version';
// Read-only update feed. It holds no signing key: the client verifies the Ed25519
// signature, so a compromised bucket can withhold or replay a release, not forge one.
const SAFE={'x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox",'referrer-policy':'no-referrer'};
export async function updateRoutes(request:Request,env:Env):Promise<Response|undefined>{
 const path=new URL(request.url).pathname;if(!path.startsWith('/v1/update/'))return;
 if(request.method!=='GET'&&request.method!=='HEAD')throw new ApiError(405,'method_not_allowed');
 const channel=path.match(/^\/v1\/update\/([a-z]{1,16})$/),file=path.match(/^\/v1\/update\/releases\/([^/]{1,64})\/([^/]{1,96})$/);
 let key:string,type:string,cache:string;
 if(channel&&isReleaseChannel(channel[1])){key=`channels/${channel[1]}.json`;type='application/json; charset=utf-8';cache='public, max-age=300';}
 else if(file&&normalizeVersion(file[1])===file[1]&&isReleaseAssetName(file[2])){key=`releases/${file[1]}/${file[2]}`;type='application/octet-stream';cache='public, max-age=86400';}
 else throw new ApiError(404,'not_found');
 if(!env.RELEASES)throw new ApiError(503,'updates_unconfigured');
 const object=await env.RELEASES.get(key);if(!object)throw new ApiError(404,'not_found');
 return new Response(request.method==='HEAD'?null:object.body,{headers:{...SAFE,'content-type':type,'content-length':String(object.size),'cache-control':cache}});
}
