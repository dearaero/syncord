import {accountId,record,observe,type Observation} from './model';
function store(name:string):Record<string,unknown>|undefined{
 try{
  const common=window.Syncord?.common?.stores as Record<string,unknown>|undefined;
  return record(common?.[name])??record(window.Syncord?.webpack?.findByStoreName(name));
 }catch{return undefined;}
}
function call(target:Record<string,unknown>|undefined,key:string,...args:string[]):unknown{
 try{const fn=target?.[key];return typeof fn==='function'?fn.apply(target,args):undefined;}catch{return undefined;}
}
export function ownAccount():string|undefined{
 try{const id=record(call(store('UserStore'),'getCurrentUser'))?.id;return accountId(id)?id:undefined;}catch{return undefined;}
}
/** Only bounded public platform/status scalars leave these native store reads. */
export function ownObservation(account:string):Observation{
 if(!accountId(account)||ownAccount()!==account)return{visibility:'unknown',available:false,evidence:{}};
 const presence=store('PresenceStore');
 const status=call(presence,'getStatus',account),clients=call(presence,'getClientStatus',account);
 const sessions=call(store('SessionsStore'),'getSessions');
 try{return ownAccount()===account?observe(status,clients,sessions):{visibility:'unknown',available:false,evidence:{}};}catch{return{visibility:'unknown',available:false,evidence:{}};}
}

/** Identify may run while UserStore is stale during an account transition. */
export function identityAccount():string|undefined{
 const current=ownAccount(),authenticated=call(store('AuthenticationStore'),'getId');
 return accountId(authenticated)&&current===authenticated?current:undefined;
}
