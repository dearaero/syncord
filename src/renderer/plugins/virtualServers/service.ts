import type {Trial} from './model';
export type TrialService={read:()=>Trial|undefined;save:(name:string)=>boolean;open:()=>boolean;clear:()=>void;ready:()=>boolean};
let active:TrialService|undefined;
export const trialService=():TrialService|undefined=>active;
export function registerTrialService(value:TrialService):()=>void {active=value;return()=>{if(active===value)active=undefined;};}
