/** Drop capabilities are opaque, owner-document-bound and never paths or credentials. */
export const DROP_IPC={CONNECT:'Syncord_DROP_CONNECT',INBOX:'Syncord_DROP_INBOX',PICK:'Syncord_DROP_PICK',INVITE:'Syncord_DROP_INVITE',VIEW:'Syncord_DROP_VIEW',ACTION:'Syncord_DROP_ACTION',SAVE:'Syncord_DROP_SAVE',READ:'Syncord_DROP_READ',WRITE:'Syncord_DROP_WRITE',HASH:'Syncord_DROP_HASH',FINISH:'Syncord_DROP_FINISH',REVEAL:'Syncord_DROP_REVEAL',STOP:'Syncord_DROP_STOP',EVENT:'Syncord_DROP_EVENT'} as const;
export const DROP_BLOCK=256*1024,DROP_FRAME=16*1024,DROP_WINDOW=2*1024*1024,DROP_MAX_BYTES=Number.MAX_SAFE_INTEGER;
export type DropFile={name:string;size:number};
export type DropInvite=DropFile&{id:string;sender:string;receiver:string;senderName:string;receiverName:string;state:'pending'|'accepted'|'declined'|'cancelled'|'connected';expires:number;offer?:string;answer?:string};
export type DropAction='accept'|'decline'|'cancel'|'offer'|'answer'|'connected';
export type DropBridge={
 readonly availability:1;
 inbox(account:string,available?:boolean):Promise<DropInvite[]>;
 connect(account:string):Promise<string>;pick(session:string):Promise<DropFile|null>;
 invite(session:string,receiver:string):Promise<DropInvite>;view(session:string,id:string):Promise<DropInvite>;
 action(session:string,id:string,action:DropAction,sdp?:string):Promise<DropInvite>;
 save(session:string,id:string):Promise<boolean>;read(session:string):Promise<Uint8Array>;
 write(session:string,bytes:Uint8Array):Promise<number>;hash(session:string):Promise<string>;
 finish(session:string,digest:string):Promise<void>;reveal(session:string):Promise<void>;stop(session:string):Promise<void>;
 subscribe(listener:(session:string)=>void):()=>void;
};
export function dropId(value:unknown):string {if(typeof value!=='string'||!(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/).test(value))throw Error('drop.invalid');return value;}
export function dropFile(value:unknown):DropFile {
 if(!value||typeof value!=='object')throw Error('drop.invalid');const v=value as Record<string,unknown>;
 if(typeof v.name!=='string'||!v.name.trim()||v.name.length>255||/[/\\\x00-\x1f\x7f]/.test(v.name)||['.','..'].includes(v.name)||!Number.isSafeInteger(v.size)||Number(v.size)<0||Number(v.size)>DROP_MAX_BYTES)throw Error('drop.invalid');
 return{name:v.name,size:Number(v.size)};
}
export function dropSdp(value:unknown):string {if(typeof value!=='string'||value.length>65536||!value.startsWith('v=0\r\n')||!/^a=fingerprint:sha-256 (?:[a-fA-F0-9]{2}:){31}[a-fA-F0-9]{2}\r?$/m.test(value)||value.split('m=application ').length!==2||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)||value.includes('m=audio ')||value.includes('m=video '))throw Error('drop.invalid');return value;}
export function dropInvite(value:unknown):DropInvite {
 const f=dropFile(value),r=value as DropInvite;
 if(!/^\d{17,20}$/.test(r.sender)||!/^\d{17,20}$/.test(r.receiver)||r.sender===r.receiver||typeof r.senderName!=='string'||typeof r.receiverName!=='string'||r.senderName.length>80||r.receiverName.length>80||!Number.isSafeInteger(r.expires)||!['pending','accepted','declined','cancelled','connected'].includes(r.state))throw Error('drop.invalid');
 return{...f,id:dropId(r.id),sender:r.sender,receiver:r.receiver,senderName:r.senderName,receiverName:r.receiverName,state:r.state,expires:r.expires,...(r.offer?{offer:dropSdp(r.offer)}:{}),...(r.answer?{answer:dropSdp(r.answer)}:{})};
}
export function dropLink(id:string):string{return 'https://api.syncord.pro/drop/'+dropId(id);}
export function parseDropLink(input:string):string|undefined {try{const url=new URL(input);if(url.origin==='https://api.syncord.pro'&&url.pathname.startsWith('/drop/')&&!url.username&&!url.password&&!url.search&&!url.hash)return dropId(url.pathname.slice('/drop/'.length));}catch{}return undefined;}

/** Bounded incoming metadata only; never another account's inbox or SDP. */
export function dropInbox(value:unknown,account:string):DropInvite[]{
 if(!Array.isArray(value)||value.length>8)throw Error('drop.invalid');
 const seen=new Set<string>();
 return value.map(item=>{
  const invite=dropInvite(item);
  if(invite.receiver!==account||invite.state!=='pending'||invite.offer||invite.answer||seen.has(invite.id))throw Error('drop.invalid');
  seen.add(invite.id);return invite;
 });
}
