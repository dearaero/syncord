import { canonicalMessage as i18nText } from "../../i18n";
import {SearchPacing,type WaitKind} from './pacing';
import {abortableSleep,retryDelay,type RestResponse} from '../messageCleaner/engine';
import {validatePlan,parsePage,hitBytes,PAGE_SIZE,MAX_OFFSET,MAX_RESULTS,MAX_TEXT_BYTES,type Guild,type Hit,type Plan,type Criteria} from './model';
export type Scope=Guild&{offset:number;total?:number;more:boolean;issue?:string;historical?:boolean;retryable?:boolean;fingerprint?:string;pages:number};
export type Timing={rateLimits:number;requestMs:number;rateMs:number;quotaMs:number;pacingMs:number;indexingMs:number;retryMs:number;intervalMs:number};
const timing=():Timing=>({rateLimits:0,requestMs:0,rateMs:0,quotaMs:0,pacingMs:0,indexingMs:0,retryMs:0,intervalMs:1000});
export type State={timing:Timing;phase:'idle'|'running'|'waiting'|'stopping'|'ready'|'stopped'|'error';detail:string;waitUntil:number;processed:number;roundTotal:number;requests:number;limited:boolean;scopes:Scope[];hits:Hit[];criteria?:Criteria};
export type Port={assertAccount(id:string):void;assertGuild(id:string):void;request(guildId:string,criteria:Criteria,offset:number,signal?:AbortSignal):Promise<RestResponse>};
function response(error:unknown):RestResponse{
 const e=error!==null&&typeof error==='object'?error as Record<string,unknown>:{},r=e.response as Record<string,unknown>|undefined;
 let body=e.body??r?.body;const raw=typeof body==='string'?body:e.text??r?.text;
 if((body==null||typeof body==='string')&&typeof raw==='string'&&raw.length<=16384&&raw.trimStart().startsWith('{')){try{body=JSON.parse(raw);}catch{/* Recovery uses bounded backoff when metadata is absent. */}}
 return{status:Number(e.status??e.statusCode??e.httpStatus??r?.status)||0,body,headers:e.headers??r?.headers,retryAfter:e.retryAfter??r?.retryAfter};
}
export class GlobalSearch{
 private state:State={timing:timing(),phase:'idle',detail:i18nText("ui.select_servers_and_enter_a_search"),waitUntil:0,processed:0,roundTotal:0,requests:0,limited:false,scopes:[],hits:[]};
 private controller?:AbortController;private plan?:Plan;private pacing=new SearchPacing();private bytes=0;private seen=new Set<string>();
 constructor(private port:Port,private changed:(state:State)=>void,private now:()=>number=Date.now,private sleep=abortableSleep){}
 active():boolean{return!!this.controller;}
 snapshot():State{return{...this.state,timing:{...this.state.timing},criteria:this.state.criteria?{...this.state.criteria}:undefined,scopes:this.state.scopes.map(s=>({...s})),hits:this.state.hits.slice()};}
 private update(patch:Partial<State>={}):void{Object.assign(this.state,patch);this.state.timing.intervalMs=this.pacing.interval(this.now());this.changed(this.snapshot());}
 stop():void{if(!this.controller||this.controller.signal.aborted)return;this.controller.abort();this.update({phase:'stopping',detail:i18nText("ui.stopping_after_the_current_request")});}
 clear():void{if(this.active())throw Error("Stop the search before clearing results.");this.plan=undefined;this.bytes=0;this.seen.clear();this.update({timing:timing(),phase:'idle',detail:i18nText("ui.select_servers_and_enter_a_search"),waitUntil:0,processed:0,roundTotal:0,requests:0,limited:false,scopes:[],hits:[],criteria:undefined});}
 async start(plan:Plan):Promise<void>{
  if(this.active())throw Error("A search is already running.");const frozen=validatePlan(plan);this.port.assertAccount(frozen.accountId);this.plan=frozen;this.bytes=0;this.seen.clear();
  this.state={timing:timing(),phase:'idle',detail:i18nText("ui.starting"),waitUntil:0,processed:0,roundTotal:0,requests:0,limited:false,scopes:frozen.guilds.map(g=>({...g,offset:0,more:true,pages:0})),hits:[],criteria:{...frozen.criteria}};
  await this.round(this.state.scopes);
 }
 async more():Promise<void>{if(this.active())throw Error("A search is already running.");if(!this.state.limited)await this.round(this.state.scopes.filter(s=>s.more&&!s.issue));}
 async retry():Promise<void>{if(this.active())throw Error("A search is already running.");if(this.state.limited)return;const targets=this.state.scopes.filter(s=>s.issue&&s.retryable!==false);for(const s of targets){s.issue=undefined;s.more=true;}await this.round(targets);}
 private async round(targets:Scope[]):Promise<void>{
  const plan=this.plan;if(!plan||!targets.length)return;this.port.assertAccount(plan.accountId);
  const ctrl=new AbortController();this.controller=ctrl;
  const assert=():void=>{if(ctrl.signal.aborted)throw new DOMException('Stopped','AbortError');this.port.assertAccount(plan.accountId);};
  const pause=async(until:number,kind:WaitKind):Promise<void>=>{
   const labels:Record<WaitKind,string>={rate:i18nText("ui.waiting_for_discord_s_request_limit"),quota:i18nText("ui.scheduling_within_discord_s_available_search_quota"),pacing:i18nText("ui.pacing_search_requests"),indexing:i18nText("ui.waiting_for_discord_s_server_index"),retry:i18nText("ui.waiting_to_retry_a_temporary_error")};
   const key=kind==='rate'?'rateMs':kind==='quota'?'quotaMs':kind==='indexing'?'indexingMs':kind==='retry'?'retryMs':'pacingMs';
   while(until>this.now()){assert();this.update({phase:'waiting',detail:labels[kind],waitUntil:until});const start=this.now();try{await this.sleep(Math.min(2147483647,until-start),ctrl.signal);}finally{this.state.timing[key]+=Math.max(0,this.now()-start);}}assert();
  };
  type Job={scope:Scope;rateAttempts:number;indexAttempts:number;transientAttempts:number;readyAt:number};
  const jobs:Job[]=targets.map(scope=>({scope,rateAttempts:0,indexAttempts:0,transientAttempts:0,readyAt:0}));
  this.update({phase:'running',detail:i18nText("ui.searching_selected_servers"),processed:0,roundTotal:targets.length,waitUntil:0});
  try{
   while(jobs.length&&!this.state.limited){
    assert();const now=this.now();let chosen=0,deadline={at:Infinity,kind:'pacing' as WaitKind};
    for(let i=0;i<jobs.length;i++){const job=jobs[i]!,slot=this.pacing.ready(job.scope.id,now),ready=job.readyAt>slot.at?{at:job.readyAt,kind:'retry' as WaitKind}:slot;if(ready.at<=now){chosen=i;deadline=ready;break;}if(ready.at<deadline.at){chosen=i;deadline=ready;}}
    if(deadline.at>now){await pause(deadline.at,deadline.kind);continue;}
    const job=jobs.splice(chosen,1)[0]!,scope=job.scope;
    try{
     assert();this.port.assertGuild(scope.id);this.state.timing.intervalMs=this.pacing.interval(this.now());this.update({phase:'running',detail:i18nText("ui.searching_value", {v0: scope.name}),waitUntil:0});
     const started=this.now();this.pacing.launched(started);this.state.requests++;
     let r:RestResponse;try{r=await this.port.request(scope.id,plan.criteria,scope.offset,ctrl.signal);}catch(e){r=response(e);}
     const at=this.now();this.state.timing.requestMs+=Math.max(0,at-started);const observed=this.pacing.observe(scope.id,r,at,job.rateAttempts+1);
     this.state.timing.intervalMs=this.pacing.interval(at);
     if(observed.rateLimited){this.state.timing.rateLimits++;assert();if(++job.rateAttempts>=6)throw Error("Discord is still rate limiting this search. Retry this server later.");if(observed.resourceOnly)jobs.push(job);else jobs.unshift(job);continue;}
     assert();this.port.assertGuild(scope.id);
     if(r.status===202){this.pacing.hold(scope.id,at+Math.max(1000,retryDelay(r,at)||1000*(job.indexAttempts+1))+50,'indexing');if(++job.indexAttempts>5)throw Error("Discord is still indexing this server. Retry it later.");jobs.push(job);continue;}
     if(r.status===401)throw Error('SESSION_EXPIRED');
     if((!r.status||r.status>=500)&&job.transientAttempts++<2){job.readyAt=at+1000*2**job.transientAttempts;jobs.push(job);continue;}
     if(r.status!==200)throw Error(r.status===403?i18nText("ui.search_access_denied"):r.status===404?i18nText("ui.server_is_no_longer_available"):r.status===400?i18nText("ui.discord_rejected_these_search_filters"):i18nText("ui.search_failedvalue", {v0: r.status?` (HTTP ${r.status})`:''}));
     const page=parsePage(r.body,scope.id),fingerprint=page.hits.map(h=>h.id).join(',');
     if(page.count&&(!page.hits.length||fingerprint===scope.fingerprint))throw Error("Discord returned an empty or repeated search page. Narrow the search or retry.");
     scope.fingerprint=fingerprint;scope.total=page.total;scope.historical=page.historical;scope.pages++;
     for(const hit of page.hits){if(this.seen.has(hit.id))continue;const cost=hitBytes(hit);if(this.state.hits.length>=MAX_RESULTS||this.bytes+cost>MAX_TEXT_BYTES){this.state.limited=true;break;}this.seen.add(hit.id);this.bytes+=cost;this.state.hits.push(hit);}
     scope.offset+=page.count;scope.more=page.count>0&&(page.total===undefined?page.count>=PAGE_SIZE:scope.offset<page.total);
     if(scope.offset>MAX_OFFSET&&scope.more){scope.more=false;scope.retryable=false;scope.issue=i18nText("ui.discord_s_10_000_result_window_was_reached_narrow_the_date_range");}
    }catch(e){
     assert();if(e instanceof Error&&e.message==='SESSION_EXPIRED')throw Error("Your Discord session expired. Sign in again before searching.");
     scope.issue=e instanceof Error?e.message:i18nText("ui.this_server_could_not_be_searched");scope.more=false;
    }
    this.update({processed:this.state.processed+1});
   }
   assert();this.update({phase:'ready',waitUntil:0,detail:this.state.limited?i18nText("ui.result_memory_limit_reached_narrow_your_search_to_continue"):this.state.scopes.some(s=>s.issue)?i18nText("ui.search_pass_finished_with_some_server_issues"):this.state.scopes.some(s=>s.more)?i18nText("ui.search_pass_complete_load_more_to_continue_across_servers"):i18nText("ui.search_complete")});
  }catch(e){
   this.update({phase:ctrl.signal.aborted?'stopped':'error',waitUntil:0,detail:ctrl.signal.aborted?i18nText("ui.search_stopped_loaded_results_are_kept"):e instanceof Error?e.message:i18nText("ui.search_failed")});
  }finally{this.controller=undefined;this.update();}
 }
}
