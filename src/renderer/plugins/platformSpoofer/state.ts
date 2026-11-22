import type {Platform,Snapshot} from './model';
export const empty=():Snapshot=>({running:false,selected:[],saving:false,result:'',visibility:'unknown',available:false,evidence:{}});
let state=empty(),control:((selected:Platform[],account:string,restore:boolean)=>boolean)|undefined,refresh:undefined|(()=>void);
const listeners=new Set<()=>void>();
export const spooferState=():Readonly<Snapshot>=>state;
export function publish(value:Snapshot):void{
 if(JSON.stringify(value)===JSON.stringify(state))return;
 state=Object.freeze({...value,selected:Object.freeze([...value.selected]) as Platform[],evidence:Object.freeze(Object.fromEntries(Object.entries(value.evidence).map(([k,v])=>[k,Object.freeze({...v})])))});
 for(const fn of [...listeners])try{fn();}catch{/* Isolate closed settings views. */}
}
export function controls(apply:typeof control,read:typeof refresh):()=>void{
 control=apply;refresh=read;
 return()=>{if(control===apply){control=undefined;refresh=undefined;publish(empty());}};
}
export function saveSelection(selected:Platform[],account:string,restore=false):boolean{return control?.(selected,account,restore)??false;}
export function refreshObservation():void{refresh?.();}
export function onSpooferState(fn:()=>void):()=>void{listeners.add(fn);return()=>{listeners.delete(fn);};}
