/** Live operator smoke test: use only with the account holder's approval.
 * The temporary Syncord credential stays in memory and is revoked on success.
 * No purchases, badge selections or synthetic production accounts are made.
 */
import {randomBytes,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
const origin='https://api.syncord.pro',id=process.argv[2];
if(!id||!/^\d{17,20}$/.test(id)||BigInt(id)>=(1n<<64n))throw Error('Pass the consenting Discord account ID as the only argument. Never pass any secret.');
const token=randomBytes(32).toString('hex'),pollToken=randomBytes(32).toString('hex');
async function request(path,method='GET',body,authenticated=false){
 const response=await fetch(origin+path,{method,redirect:'error',signal:AbortSignal.timeout(15000),headers:{accept:'application/json',...(body===undefined?{}:{'content-type':'application/json'}),...(authenticated?{authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const data=await response.json();if(!response.ok)throw Error('API returned '+response.status+' ('+String(data.error??'unknown_error')+').');return data;
}
let linked=false;
try{
 const health=await request('/health');if(!health.verificationConfigured)throw Error('DISCORD_CLIENT_SECRET is not bound to the active Worker. Add it in Worker secrets and Deploy first.');
 const challenge=await request('/v1/auth/challenge','POST',{accountId:id,pollToken,sessionHash:createHash('sha256').update(token).digest('hex')});
 if(typeof challenge.state!=='string'||!/^[a-f0-9]{64}$/.test(challenge.state)||!Number.isSafeInteger(challenge.expiresAt)||challenge.expiresAt>Date.now()+610000)throw Error('Invalid authorization challenge.');
 const url=origin+'/oauth/start?state='+challenge.state,command=process.platform==='darwin'?'/usr/bin/open':process.platform==='win32'?'rundll32':'xdg-open',args=process.platform==='win32'?['url.dll,FileProtocolHandler',url]:[url];
 await new Promise((resolve,reject)=>{const child=spawn(command,args,{stdio:'ignore',shell:false});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('Could not open Discord approval.')));});
 console.log('Discord approval opened. Authorize the same Discord account. The temporary test session will be revoked afterwards.');
 while(Date.now()<challenge.expiresAt){const status=await request('/v1/auth/poll','POST',{pollToken});if(status.linked===true){if(status.accountId!==id)throw Error('Account mismatch.');linked=true;break;}await new Promise(resolve=>setTimeout(resolve,3000));}
 if(!linked)throw Error('Discord approval expired. Retry after checking the redirect URI.');
 const profile=await request('/v1/me','GET',undefined,true),history=await request('/v1/me/transactions','GET',undefined,true);if(profile.id!==id||!Number.isSafeInteger(profile.balance)||profile.balance<0)throw Error('Invalid verified account response.');
 console.log(JSON.stringify({verified:true,accountId:profile.id,balance:profile.balance,ownedBadges:profile.badges.length,loadedTransactions:history.entries.length}));
}finally{
 if(linked){await request('/v1/me/session','DELETE',undefined,true);console.log('Temporary live-test session revoked. The real account and any earned welcome reward are retained.');}
}
