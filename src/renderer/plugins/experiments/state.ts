let enabled=false;
const listeners=new Set<()=>void>();
export const running=():boolean=>enabled;
export function setRunning(value:boolean):void {if(enabled===value)return;enabled=value;for(const listener of listeners){try{listener();}catch{/* A stale panel cannot interrupt plugin shutdown. */}}}
export function subscribe(listener:()=>void):()=>void {listeners.add(listener);return()=>{listeners.delete(listener);};}
