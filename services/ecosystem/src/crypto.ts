const encoder=new TextEncoder();
export const hex=(bytes:ArrayBuffer|Uint8Array):string=>[...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
export const hash=async(value:string):Promise<string>=>hex(await crypto.subtle.digest('SHA-256',encoder.encode(value)));
export const random=():string=>hex(crypto.getRandomValues(new Uint8Array(32)));
export async function challenge(verifier:string):Promise<string>{const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(verifier)));return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
export async function secretEqual(a:string,b:string):Promise<boolean>{const x=await hash(a),y=await hash(b);let difference=0;for(let i=0;i<x.length;i++)difference|=x.charCodeAt(i)^y.charCodeAt(i);return difference===0;}
