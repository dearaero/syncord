/** Only public values cross the bridge. Session/challenge secrets stay in main. */
export const ECO_IPC={STATUS:'Syncord_ECO_STATUS',LINK:'Syncord_ECO_LINK',POLL:'Syncord_ECO_POLL',PROFILE:'Syncord_ECO_PROFILE',CATALOG:'Syncord_ECO_CATALOG',ART:'Syncord_ECO_ART',BUY:'Syncord_ECO_BUY',ACTIVE:'Syncord_ECO_ACTIVE',HISTORY:'Syncord_ECO_HISTORY',LOOKUP:'Syncord_ECO_LOOKUP',DISCONNECT:'Syncord_ECO_DISCONNECT'} as const;
export const OFFICIAL_BADGE_REFRESH_MS=30_000;
export const ECOSYSTEM_CHANGED='Syncord-ecosystem-badges-changed';
export const BADGE_ART=['spark','orbit','shield','compass'] as const;
export type BadgeArt=typeof BADGE_ART[number];
export const MAX_BADGE_SVG_BYTES=512*1024;
export const MAX_BADGE_PNG_BYTES=512*1024;
export function ecoImage(value:unknown):string|undefined{if(value===null||value===undefined)return undefined;if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw Error('Invalid badge image.');return value;}
export function ecoBadgeImage(value:unknown):string|undefined {if(typeof value==='string'&&/^png:[a-f0-9]{64}$/.test(value))return value;return ecoImage(value);}
export function badgeImagePath(image:unknown):string{const raster=typeof image==='string'&&/^png:[a-f0-9]{64}$/.test(image);if(raster)return '/v1/custom-badge-art/'+image.slice(4)+'.png';const id=ecoImage(image);return id?'/v1/badge-art/'+id+'.svg':'';}
export type EcoBadge={id:string;name:string;description:string;art:BadgeArt;price:number;image?:string};
export type EcoOwned=EcoBadge&{active:boolean};
export type EcoProfile={id:string;username:string;avatar:string|null;balance:number;badges:EcoOwned[]};
export type EcoTransaction={id:number;delta:number;balance_after:number;reason:string;created_at:number};
export type EcoHistory={entries:EcoTransaction[];next:number|null};
export type EcoStatus={configured:boolean;encryptedStorage:boolean;linked:boolean;pendingUntil?:number};
export type EcoLink={expiresAt:number};
export type EcoLookup=Record<string,EcoBadge[]>;
export type EcosystemBridge={supporter?:import('./supporter').SupporterBridge;status(account:string):Promise<EcoStatus>;link(account:string):Promise<EcoLink>;poll(account:string):Promise<{linked:boolean}>;profile(account:string):Promise<EcoProfile>;catalog():Promise<EcoBadge[]>;art?(image:string):Promise<string>;buy(account:string,badge:string,key:string,expectedPrice:number):Promise<EcoProfile>;activate(account:string,ids:string[]):Promise<EcoProfile>;history(account:string,before?:number):Promise<EcoHistory>;lookup(ids:string[]):Promise<EcoLookup>;disconnect(account:string):Promise<void>};
export function ecoAccount(value:unknown):string{if(typeof value!=='string'||!/^\d{17,20}$/.test(value)||BigInt(value)>=(1n<<64n))throw Error('Invalid Discord account.');return value;}
export function ecoBadgeId(value:unknown):string{if(typeof value!=='string'||!/^[a-z][a-z0-9-]{0,47}$/.test(value))throw Error('Invalid badge.');return value;}
export function ecoIds(value:unknown,max=50):string[]{if(!Array.isArray(value)||value.length>max)throw Error('Too many identifiers.');return [...new Set(value.map(ecoAccount))];}
export function ecoActive(value:unknown):string[]{if(!Array.isArray(value)||value.length>3)throw Error('Choose up to three badges.');const ids=value.map(ecoBadgeId);if(new Set(ids).size!==ids.length)throw Error('Duplicate badge.');return ids;}
export function ecoKey(value:unknown):string{if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value))throw Error('Invalid transaction key.');return value;}

export function ecoPrice(value:unknown):number{if(typeof value!=="number"||!Number.isSafeInteger(value)||value<1||value>1000000)throw Error("Invalid badge price.");return value;}
