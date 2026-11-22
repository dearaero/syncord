/** Closed first-party Supporter operations. Credentials and URLs never cross this contract. */
export const SUPPORTER_IPC={STATUS:'Syncord_SUPPORTER_STATUS',CREATE:'Syncord_SUPPORTER_CREATE',EDIT:'Syncord_SUPPORTER_EDIT',UPLOAD:'Syncord_SUPPORTER_UPLOAD',SUBMIT:'Syncord_SUPPORTER_SUBMIT',DELETE:'Syncord_SUPPORTER_DELETE',ACTIVE:'Syncord_SUPPORTER_ACTIVE',PREVIEW:'Syncord_SUPPORTER_PREVIEW'} as const;
export const MAX_CUSTOM_BADGE_INPUT=1024*1024,MAX_CUSTOM_BADGE_OUTPUT=65536;
export type SupporterTier=0|1|2|3;
export const CUSTOM_BADGE_STATES=['DRAFT','PROCESSING','PENDING_REVIEW','APPROVED','REJECTED','REVOKED'] as const;
export type CustomBadgeStatus=typeof CUSTOM_BADGE_STATES[number];
export type CustomBadge={id:string;accountId:string;name:string;description:string;status:CustomBadgeStatus;active:boolean;image?:string;revision:number;createdAt:number;submittedAt:number|null;reason:string};
export type SupporterStatus={tier:SupporterTier;suspended:boolean;revision:number;slotsUsed:number;uploadConfigured:boolean;badges:CustomBadge[]};
export type CustomBadgeInput={name:string;description:string};
export type BadgeMutation={id:string;revision:number;key:string};
export type SupporterBridge={
 status(account:string):Promise<SupporterStatus>;
 create(account:string,input:CustomBadgeInput,key:string):Promise<SupporterStatus>;
 edit(account:string,mutation:BadgeMutation,input:CustomBadgeInput):Promise<SupporterStatus>;
 upload(account:string,mutation:BadgeMutation,bytes:Uint8Array):Promise<SupporterStatus>;
 submit(account:string,mutation:BadgeMutation):Promise<SupporterStatus>;
 remove(account:string,mutation:BadgeMutation):Promise<SupporterStatus>;
 activate(account:string,ids:string[],key:string):Promise<SupporterStatus>;
 preview(account:string,id:string):Promise<string>;
};
export function supporterTier(value:unknown):SupporterTier {if(value!==0&&value!==1&&value!==2&&value!==3)throw Error('supporter.invalid');return value;}
export function badgeRevision(value:unknown):number {if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1||value>10000)throw Error('supporter.invalid');return value;}
export function customBadgeId(value:unknown):string {if(typeof value!=='string'||!/^custom-[a-f0-9]{32}$/.test(value))throw Error('supporter.invalid');return value;}
export function badgeText(value:unknown,max:number,min=0):string {
 if(typeof value!=='string'||value.length>max*2||/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value))throw Error('supporter.invalid');
 const text=value.normalize('NFKC').trim();if([...text].length<min||[...text].length>max||(!/[\p{L}\p{N}\p{P}\p{S}]/u.test(text)&&min>0))throw Error('supporter.invalid');return text;
}
export function badgeInput(value:unknown):CustomBadgeInput {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('supporter.invalid');const r=value as Record<string,unknown>;
 if(Object.keys(r).some(k=>k!=='name'&&k!=='description'))throw Error('supporter.invalid');return{name:badgeText(r.name,32,2),description:badgeText(r.description,160)};
}
export function badgeBytes(value:unknown):Uint8Array {if(!(value instanceof Uint8Array)||!value.byteLength||value.byteLength>MAX_CUSTOM_BADGE_INPUT)throw Error('supporter.invalidImage');return value;}
