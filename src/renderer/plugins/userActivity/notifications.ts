import { t as i18nText } from "../../i18n";
import { type ActivityNotice, cleanText } from "./types";

export type NoticeClock = { now:()=>number; set:(fn:()=>void,delay:number)=>number; clear:(id:number)=>void };
const MAX_PENDING = 16;
/** One timer, at most 16 small summaries; native toasts cannot accumulate unboundedly. */
export class NoticeBuffer {
  private pending = new Map<string, {notice:ActivityNotice;count:number}>();
  private overflow = 0;
  private timer: number | undefined;
  private lastShown = -Infinity;
  private stopped = false;
  constructor(private readonly clock: NoticeClock, private readonly interval:()=>number,
    private readonly describe:(notice:ActivityNotice)=>string, private readonly show:(text:string)=>void) {}
  add(notice: ActivityNotice): void {
    if (this.stopped) return;
    const key = `${notice.userId ?? ""}:${notice.kind}:${notice.channelId ?? ""}`;
    // Retain only the small presentation snapshot, never a full message/action.
    const snapshot:ActivityNotice={kind:notice.kind,userId:notice.userId,channelId:notice.channelId,
      text:cleanText(notice.text,180),...(notice.content?{content:cleanText(notice.content,120)}:{})};
    const previous = this.pending.get(key);
    if (previous) { previous.notice = snapshot; previous.count++; }
    else if (this.pending.size < MAX_PENDING) this.pending.set(key,{notice:snapshot,count:1});
    else this.overflow++;
    if (this.timer === undefined) {
      const delay = Math.max(250,this.lastShown + this.interval() * 1000 - this.clock.now());
      this.timer = this.clock.set(()=>this.flush(),delay);
    }
  }
  private flush(): void {
    this.timer = undefined;
    if (this.stopped || this.pending.size === 0) return;
    const entries = [...this.pending.values()];
    const shown = entries.slice(0,3);
    const remaining = entries.slice(3).reduce((n,item)=>n+item.count,0) + this.overflow;
    const text = shown.map(item=>`${cleanText(this.describe(item.notice),180)}${item.count > 1 ? ` (${i18nText('count.events',{count:item.count})})` : ""}`).join(" · ")
      + (remaining ? ` (+${i18nText('count.other_events',{count:remaining})})` : "");
    this.pending.clear(); this.overflow = 0; this.lastShown = this.clock.now();
    this.show(text);
  }
  clear(): void {
    if (this.timer !== undefined) this.clock.clear(this.timer);
    this.timer = undefined; this.pending.clear(); this.overflow = 0;
  }
  dispose(): void { this.clear(); this.stopped = true; }
  size(): number { return this.pending.size; }
}
