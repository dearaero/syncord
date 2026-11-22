import type {DropInvite} from '../../../shared/drop';

type Options={
 account:()=>string|undefined;
 enabled:()=>boolean;
 busy:()=>boolean;
 hidden:()=>boolean;
 read:(account:string,available:boolean)=>Promise<DropInvite[]>;
 show:(invite:DropInvite)=>void;
};
/** One serial metadata poll also renews a short availability lease. Busy panels
 * suppress popups, not liveness. Explicit stop/account changes withdraw the lease. */
export function watchDropInbox(options:Options):{wake:()=>void;stop:()=>void}{
 let stopped=false,running=false,account:string|undefined,next=Date.now()+1000,failures=0;
 let timer:ReturnType<typeof setTimeout>|undefined;
 let announced:string|undefined,enabled=options.enabled();
 const withdraw=():void=>{const id=announced;announced=undefined;if(id)void options.read(id,false).catch(()=>{});};
 const seen=new Map<string,number>();
 const schedule=():void=>{
  if(stopped)return;
  if(timer!==undefined)clearTimeout(timer);
  timer=setTimeout(()=>{timer=undefined;wake();},Math.max(0,next-Date.now()));
 };
 const poll=async(id:string):Promise<void>=>{
  running=true;
  try{
   announced=id;
   const invitations=await options.read(id,true);
   if(stopped||options.account()!==id)return;
   failures=0;
   if(!options.enabled()||options.busy())return;
   const now=Date.now();
   for(const [key,expires] of seen)if(expires<=now)seen.delete(key);
   for(const invite of invitations){
    if(invite.receiver!==id||invite.state!=='pending'||invite.expires<=now||seen.has(invite.id))continue;
    seen.set(invite.id,invite.expires);
    while(seen.size>128)seen.delete(seen.keys().next().value!);
    options.show(invite);break;
   }
  }catch{
   if(!stopped&&options.account()===id)failures++;
  }finally{
   running=false;
   if(!stopped){
    const delay=failures?Math.min(300000,60000*2**Math.min(failures-1,3)):options.hidden()?30000:15000;
    next=options.account()!==id?0:Date.now()+delay;
    schedule();
   }
  }
 };
 function wake():void{
  if(stopped)return;
  const current=options.account();
  if(current!==account){withdraw();account=current;seen.clear();failures=0;next=0;}
  const receiving=options.enabled();if(receiving!==enabled){enabled=receiving;next=0;}
  if(!current||!receiving)withdraw();
  if(running)return;
  if(next>Date.now()){schedule();return;}
  if(!current||!receiving){
   next=Date.now()+15000;schedule();return;
  }
  void poll(current);
 }
 schedule();
 return{wake,stop:()=>{stopped=true;withdraw();seen.clear();if(timer!==undefined)clearTimeout(timer);}};
}
