import { t as i18nText } from "../../i18n";
import type {ActivityNotice} from './types';
import {activityAccount,channelName,userName} from './discord';
import {activityHistory,ACTIVITY_LOG_CHANGED,ACTIVITY_LOG_FAILED,type ActivityLogInput,type ActivityLogEntry} from './history';
import {showToast} from '../../ui/toast';

/** Batch synchronous event bursts into one transaction; retain no saved history in RAM. */
export class ActivityRecorder {
  private pending:ActivityLogInput[]=[];
  private scheduled=false;
  private stopped=false;
  private lastError=-Infinity;
  private writes:Promise<void>=Promise.resolve();
  constructor(private readonly report:(error:unknown)=>void) {}
  record(notice:ActivityNotice & {userId:string}):void {
    if(this.stopped)return;
    const account=activityAccount();
    if(!account){this.failure(new Error('Your Discord account is not ready for activity history.'));return;}
    this.pending.push({accountId:account,userId:notice.userId,userName:userName(notice.userId),kind:notice.kind,
      text:notice.text,messageId:notice.messageId,messageEvent:notice.messageEvent,content:notice.content,timestamp:notice.timestamp??Date.now(),...(notice.channelId?{channelId:notice.channelId,channelName:channelName(notice.channelId)}:{})});
    if(this.scheduled)return;
    this.scheduled=true;queueMicrotask(()=>{this.scheduled=false;this.flush();});
  }
  private flush():void {
    const rows=this.pending;this.pending=[];if(!rows.length)return;
    this.writes=this.writes.then(()=>activityHistory.appendMany(rows)).then(()=>{
      if(!this.stopped){
        const accounts=new Map<string,Set<string>>();
        for(const row of rows){let ids=accounts.get(row.accountId);if(!ids){ids=new Set();accounts.set(row.accountId,ids);}ids.add(row.userId);}
        for(const [accountId,ids] of accounts)window.dispatchEvent(new CustomEvent(ACTIVITY_LOG_CHANGED,{detail:{accountId,userIds:[...ids]}}));
      }
    }).catch(error=>this.failure(error));
  }
  failure(error:unknown):void {
    if(Date.now()-this.lastError<30_000)return;
    this.lastError=Date.now();this.report(error);
    if(!this.stopped){
      const message=i18nText("ui.activity_history_could_not_be_saved_check_available_disk_space_and_try");
      window.dispatchEvent(new CustomEvent(ACTIVITY_LOG_FAILED,{detail:{message}}));
      showToast(message,{type:"failure",duration:7000});
    }
  }
  async message(accountId:string,channelId:string,id:string):Promise<ActivityLogEntry|undefined> {await this.settle();return activityHistory.message(accountId,channelId,id);}
  async settle():Promise<void> {this.flush();await this.writes;}
  stop():void {this.stopped=true;this.flush();}
}
