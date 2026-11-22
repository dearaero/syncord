import { canonicalMessage as i18nText } from "../../i18n";
import {abortableSleep, header, retryDelay, validId, type RestResponse} from '../messageCleaner/engine';
export type Target = {id:string;kind:'dm'|'group'|'guild';name:string};
export type Plan = {userId:string;includeGuilds:boolean;targets:Target[];owned:number;unknown:number};
export type State = {
  phase:'idle'|'running'|'waiting'|'stopping'|'completed'|'stopped'|'error';
  total:number;processed:number;closed:number;groups:number;guilds:number;skipped:number;failed:number;
  detail:string;waitUntil:number;issues:string[];
};
export type Port = {
  assertAccount(userId:string):void;
  inspect(target:Target,userId:string):string|undefined;
  request(target:Target,userId:string):Promise<RestResponse>;
  acknowledged(target:Target,userId:string):void;
};
export function validatePlan(plan:Plan):void {
  if(!validId(plan.userId)||typeof plan.includeGuilds!=='boolean'||!Array.isArray(plan.targets)
    ||!Number.isSafeInteger(plan.owned)||plan.owned<0||!Number.isSafeInteger(plan.unknown)||plan.unknown<0)
    throw new Error('Invalid closing plan. Refresh the list and try again.');
  const seen=new Set<string>();
  for(const t of plan.targets){
    if(!validId(t.id)||!['dm','group','guild'].includes(t.kind)||typeof t.name!=='string'
      ||(t.kind==='guild'&&!plan.includeGuilds)||seen.has(t.id))throw new Error('Invalid closing target.');
    seen.add(t.id);
  }
}
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'?v as Record<string,unknown>:{};
function response(error:unknown):RestResponse {
  const e=object(error),r=object(e.response);
  return{status:Number(e.status??e.statusCode??e.httpStatus??r.status)||0,body:e.body??r.body,headers:e.headers??r.headers};
}
function reset(response:RestResponse,now:number):number {
  if(header(response.headers,'x-ratelimit-remaining')!=='0')return 0;
  const relative=header(response.headers,'x-ratelimit-reset-after');
  if(relative!==undefined&&relative.trim()&&Number.isFinite(Number(relative))&&Number(relative)>=0)return Number(relative)*1000;
  const epoch=Number(header(response.headers,'x-ratelimit-reset'))*1000;
  const serverDate=Date.parse(header(response.headers,'date')??'');
  return Number.isFinite(epoch)?Math.max(0,epoch-(Number.isFinite(serverDate)?serverDate:now)):0;
}
export class DmCloser {
  private controller?:AbortController;
  private until=0;
  private plan?:Plan;
  private state:State={phase:'idle',total:0,processed:0,closed:0,groups:0,guilds:0,skipped:0,failed:0,detail:i18nText("ui.ready_e20846d"),waitUntil:0,issues:[]};
  constructor(private port:Port,private changed:(state:State)=>void,private now:()=>number=Date.now,private sleep=abortableSleep){}
  active():boolean{return!!this.controller;}
  snapshot():State{return{...this.state,issues:[...this.state.issues]};}
  currentPlan():Plan|undefined{return this.plan?{...this.plan,targets:this.plan.targets.map(t=>({...t}))}:undefined;}
  private update(patch:Partial<State>):void{Object.assign(this.state,patch);this.changed(this.snapshot());}
  stop():void {
    if(!this.controller||this.controller.signal.aborted)return;
    this.controller.abort();this.update({phase:'stopping',detail:i18nText("ui.stopping_after_the_current_request")});
  }
  async run(plan:Plan):Promise<void>{
    if(this.active())throw new Error('Closing is already running.');
    validatePlan(plan);this.port.assertAccount(plan.userId);
    const frozen:Plan={...plan,targets:plan.targets.map(t=>({...t}))};this.plan=frozen;
    const controller=new AbortController();this.controller=controller;
    this.state={phase:'running',total:frozen.targets.length,processed:0,closed:0,groups:0,guilds:0,skipped:0,failed:0,detail:i18nText("ui.starting"),waitUntil:0,issues:[]};
    const assertActive=():void=>{
      if(controller.signal.aborted)throw new DOMException('Stopped','AbortError');
      this.port.assertAccount(frozen.userId);
    };
    const issue=(text:string):void=>{this.state.issues=[...this.state.issues.slice(-19),text];};
    try{
      this.update({});
      let denied=0;
      for(const target of frozen.targets){
        let finished=false;
        for(let attempt=0;!finished;attempt++){
          assertActive();
          while(this.until>this.now()){
            this.update({phase:'waiting',waitUntil:this.until,detail:i18nText("ui.waiting_for_discord_s_rate_limit")});
            assertActive();await this.sleep(this.until-this.now(),controller.signal);assertActive();
          }
          // Recheck after every wait: ownership, membership and account may change.
          const skip=this.port.inspect(target,frozen.userId);
          if(skip){issue(`${target.name}: ${skip}`);this.state.skipped++;finished=true;break;}
          this.update({phase:'running',waitUntil:0,detail:`${target.kind==='dm'?i18nText("ui.closing"): i18nText("ui.leaving")} ${target.name}…`});
          assertActive();
          let result:RestResponse;
          try{result=await this.port.request(target,frozen.userId);}catch(error){result=response(error);}
          const at=this.now();
          this.until=Math.max(this.until,at+reset(result,at));
          if(result.status===429){
            // The full deadline survives Stop/Start. Never shorten a server wait.
            this.until=Math.max(this.until,at+Math.max(1000,retryDelay(result,at))+50);
            assertActive();if(attempt>=4)throw new Error('Discord is still rate limiting requests. Try again later.');
            continue;
          }
          if((target.kind==='guild'&&result.status===204)||(target.kind!=='guild'&&(result.status===200||result.status===204))){
            this.state[target.kind==='dm'?'closed':target.kind==='group'?'groups':'guilds']++;
            // Do not replay old-account events into a newly signed-in account.
            try{this.port.assertAccount(frozen.userId);this.port.acknowledged(target,frozen.userId);}catch{/* Confirmed HTTP success is still counted. */}
            denied=0;finished=true;
          }else if(result.status===404&&[10003,10004].includes(Number(object(result.body).code))){
            this.state.skipped++;issue(i18nText("ui.value_already_unavailable", {v0: target.name}));finished=true;
          }else{
            const body=object(result.body);
            const reason=Array.isArray(body.captcha_key)?i18nText("ui.discord_requires_a_captcha_complete_it_in_discord_before_retrying"):
              result.status===401?i18nText("ui.your_discord_session_expired_sign_in_again"):
              i18nText("ui.discord_refused_value_http_valuevalue", {v0: target.name, v1: result.status||'unknown', v2: body.code?i18nText("ui.code_value", {v0: String(body.code)}):''});
            this.state.failed++;issue(reason);
            // Denied membership actions can be skipped, but repeated denial is not retried.
            if(result.status!==403||++denied>=3)throw new Error(reason);
            finished=true;
          }
        }
        this.state.processed++;
        assertActive();this.update({});
      }
      assertActive();this.update({phase:'completed',detail:this.state.failed?i18nText("ui.finished_with_errors"):i18nText("ui.closing_complete"),waitUntil:0});
    }catch(error){
      this.update({phase:controller.signal.aborted?'stopped':'error',waitUntil:0,
        detail:controller.signal.aborted?i18nText("ui.closing_stopped"):error instanceof Error?error.message:i18nText("ui.closing_failed")});
    }finally{this.controller=undefined;}
  }
}
