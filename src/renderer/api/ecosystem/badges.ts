import {ECOSYSTEM_CHANGED,OFFICIAL_BADGE_REFRESH_MS,type EcoBadge,type EcoLookup,ecoIds} from '../../../shared/ecosystem';

type Consumer={visible:Set<string>;lookup:((ids:string[])=>Promise<EcoLookup>)|undefined;changed:(ids:string[])=>void;refreshTargets?:(()=>string[])};
const cache=new Map<string,{until:number;badges:EcoBadge[]}>();
const consumers=new Set<Consumer>();
let running=false,epoch=0,eventTarget:Window|undefined;
let timer:ReturnType<typeof setTimeout>|undefined,visibilityTarget:Document|undefined;
export function officialBadges(id:string):EcoBadge[]{return cache.get(id)?.badges??[];}

function cancelRefresh():void{if(timer!==undefined)clearTimeout(timer);timer=undefined;}
function hidden():boolean{return visibilityTarget?.visibilityState==='hidden';}
function targets():Set<string>{const ids=new Set<string>();for(const consumer of consumers)for(const id of consumer.visible)ids.add(id);return ids;}
function scheduleRefresh():void{
 cancelRefresh();if(running||hidden()||![...consumers].some(c=>c.lookup))return;
 let next=Infinity;for(const id of targets())next=Math.min(next,cache.get(id)?.until??Date.now());
 if(Number.isFinite(next))timer=setTimeout(()=>{timer=undefined;wake();},Math.max(1,next-Date.now()));
}
function wake():void{
 if(hidden()){cancelRefresh();return;}
 for(const consumer of consumers)if(consumer.refreshTargets)try{consumer.visible=new Set(ecoIds(consumer.refreshTargets().slice(0,100),100));}catch{consumer.visible.clear();}
 void pump();
}
function sameBadges(a:EcoBadge[],b:EcoBadge[]):boolean{return a.length===b.length&&a.every((badge,i)=>{const other=b[i];return other!==undefined&&badge.id===other.id&&badge.name===other.name&&badge.description===other.description&&badge.art===other.art&&badge.price===other.price&&badge.image===other.image;});}

/** One bounded cache and request lane for chat, member lists and native profiles. */
async function pump():Promise<void>{
 cancelRefresh();if(running||!consumers.size||hidden())return;
 const lookup=[...consumers].find(c=>c.lookup)?.lookup;if(!lookup)return;
 const ids=[...targets()].filter(id=>(cache.get(id)?.until??0)<=Date.now()).slice(0,50);if(!ids.length){scheduleRefresh();return;}
 running=true;const token=epoch;let failed=false,rows:EcoLookup={};
 try{rows=await lookup(ids);}catch{failed=true;}
 running=false;
 if(token!==epoch){void pump();return;}
 const changed:string[]=[];
 for(const id of ids){
  const previous=cache.get(id),badges=failed?previous?.badges??[]:rows[id]??[];
  if(!previous||!sameBadges(previous.badges,badges))changed.push(id);
  cache.delete(id);cache.set(id,{until:Date.now()+OFFICIAL_BADGE_REFRESH_MS,badges});
 }
 while(cache.size>512){const first=cache.keys().next();if(first.done)break;cache.delete(first.value);}
 for(const consumer of [...consumers]){
  const relevant=changed.filter(id=>consumer.visible.has(id));
  if(relevant.length)try{consumer.changed(relevant);}catch{/* A failed surface must not block other badge consumers. */}
 }
 void pump();
}
function invalidate(event:Event):void{
 const id=(event as CustomEvent<{id?:unknown}>).detail?.id;if(typeof id!=='string')return;
 epoch++;cache.delete(id);void pump();
}
/** One expiry timer for all tracked surfaces; pause while Discord is hidden. */
export function watchOfficialBadges(lookup:Consumer['lookup'],changed:Consumer['changed'],refreshTargets?:Consumer['refreshTargets']):{update:(ids:string[])=>void;release:()=>void}{
 const consumer:Consumer={visible:new Set(),lookup,changed,refreshTargets};let stopped=false;consumers.add(consumer);
 if(!eventTarget){
  eventTarget=window;eventTarget.addEventListener(ECOSYSTEM_CHANGED,invalidate);eventTarget.addEventListener('focus',wake);eventTarget.addEventListener('online',wake);
  if(typeof document!=='undefined'){visibilityTarget=document;visibilityTarget.addEventListener('visibilitychange',wake);}
 }
 return{
  update:ids=>{if(stopped)return;try{consumer.visible=new Set(ecoIds(ids.slice(0,100),100));}catch{consumer.visible.clear();}void pump();},
  release:()=>{if(stopped)return;stopped=true;consumers.delete(consumer);consumer.visible.clear();if(!consumers.size){epoch++;cache.clear();cancelRefresh();eventTarget?.removeEventListener(ECOSYSTEM_CHANGED,invalidate);eventTarget?.removeEventListener('focus',wake);eventTarget?.removeEventListener('online',wake);visibilityTarget?.removeEventListener('visibilitychange',wake);eventTarget=undefined;visibilityTarget=undefined;}else scheduleRefresh();},
 };
}
