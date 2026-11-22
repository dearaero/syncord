import { t as i18nText } from "../../i18n";
/** Conservative credits from the last completed Discord DELETE responses. */
export class DeleteWindow {
  private bucket?: string;
  private remaining?: number;
  private resetAt = 0;
  private serial = false;
  private unconfirmedSuccesses = 0;
  private unconfirmedOverlap = false;
  private reason = "ui.quota_not_confirmed";
  private gap = 20;
  private latency = 0;
  private observedLimit = false;
  observe(bucket: string | undefined, remaining: string | undefined, resetMs: number, now: number): void {
    const count = remaining?.trim() ? Number(remaining) : NaN;
    if (!bucket || !Number.isSafeInteger(count) || count < 0 || !Number.isFinite(resetMs) || resetMs <= 0) {
      if (this.bucket) this.serial = true;
      if (!this.serial) this.unconfirmedSuccesses = Math.min(2, this.unconfirmedSuccesses+1);
      if (!this.serial || this.bucket) this.reason = "ui.quota_metadata_unavailable";
      this.remaining = undefined;
      return;
    }
    // Message age can change Discord's deletion bucket. Do not infer a new
    // bucket's capacity from requests already in flight in the previous one.
    if (this.bucket && this.bucket !== bucket) { this.serial = true;this.reason = "ui.deletion_bucket_changed"; }
    if (this.resetAt <= now || this.remaining === undefined) this.remaining = count;
    else this.remaining = Math.min(this.remaining, count);
    this.bucket = bucket;
    this.resetAt = Math.max(this.resetAt, now + resetMs);
  }
  /** Tiny launch spacing avoids a simultaneous speculative burst, not a hard-coded server quota. */
  spacing(): number { return this.bucket && !this.serial ? 0 : Math.min(this.gap,this.latency*(this.observedLimit ? 0.1 : 0.04)); }
  completed(duration: number): void {
    if (Number.isFinite(duration) && duration > 0) this.latency = this.latency ? this.latency*.8+duration*.2 : duration;
  }
  blockedUntil(now: number): number { return this.remaining === 0 && this.resetAt > now ? this.resetAt : 0; }
  width(now: number, cooldown: number): number {
    if (this.resetAt <= now) this.remaining = undefined;
    return cooldown > 0 || this.serial ? 1 : Math.max(1, Math.min(3, this.remaining === undefined ? this.unconfirmedWidth() : Math.max(1,this.remaining-1)));
  }
  /** Paced mode overlaps latency without inferring unreported server credits. */
  steadyWidth(now:number,cooldown:number):number {
    if(this.resetAt<=now)this.remaining=undefined;
    if(cooldown>0 || (this.bucket&&this.serial))return 1;
    return this.remaining===undefined?2:Math.max(1,Math.min(2,this.remaining-1));
  }
  description(now:number,cooldown:number):string {
    if(cooldown>0)return i18nText("ui.sequential_custom_cooldown");
    if(this.serial)return i18nText("ui.sequential_value", {v0: i18nText(this.reason)});
    if(this.resetAt<=now||this.remaining===undefined)return this.unconfirmedWidth()>1
      ? i18nText("ui.adaptive_up_to_2_in_flight_quota_metadata_unavailable") : i18nText("ui.sequential_value", {v0: i18nText(this.reason)});
    if(this.remaining===0)return i18nText("ui.waiting_for_quota_reset");
    return i18nText("ui.adaptive_up_to_value_in_flight", {v0: Math.max(1,Math.min(3,this.remaining-1))});
  }
  reserve(count: number): void {
    if (!this.bucket && count > 1) this.unconfirmedOverlap = true;
    if (this.remaining !== undefined) this.remaining = Math.max(0, this.remaining-count);
  }
  // Without quota headers, two acknowledged deletes allow a small latency
  // overlap. A 429 disables that speculation for the rest of this job, even
  // when a success from the same in-flight group arrives after the 429.
  private unconfirmedWidth(): number { return !this.bucket && !this.serial && this.unconfirmedSuccesses >= 2 ? 2 : 1; }
  limited(until: number): void {
    this.observedLimit=true;
    this.gap = Math.min(1000,Math.max(50,this.gap*1.25,this.latency*.1));
    if (!this.bucket || this.unconfirmedOverlap) { this.serial=true;this.reason="ui.rate_limit_observed_overlap_disabled"; }
    this.remaining=0;this.resetAt=Math.max(this.resetAt,until);
  }
}
