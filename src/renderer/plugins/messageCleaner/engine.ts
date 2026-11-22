import { canonicalMessage as i18nText } from "../../i18n";
import { CleanupMeter, type CleanupMetrics } from "./metrics";
import { DeleteWindow } from "./deleteWindow";
import { DeletePacer } from "./pacer";
/** Bounded, quota-aware own-message cleanup. No Discord globals or message-content cache. */
export type CleanupMode = "steady" | "adaptive";
export const STEADY_INTERVAL_MS = 1000/1.4;
export type CleanupLimit = 10 | 100 | null;
export type CleanupTarget = { channelId: string; userId: string; name: string };
export type CleanupState = {
  phase: "idle" | "running" | "waiting" | "stopping" | "completed" | "stopped" | "error";
  target?: CleanupTarget; limit: CleanupLimit; bulkProcessed: number; deleted: number; missing: number; skipped: number; scanned: number;
  detail: string; waitUntil: number; pacing: string; metrics?: CleanupMetrics;
  mode?:CleanupMode; automaticIntervalMs?:number; lastRetryMs?:number; retrySource?:string;
};
export type RestResponse = { status?: number; body?: unknown; headers?: unknown; retryAfter?: unknown };
export type CleanupPort = {
  request(method: "get" | "del", channelId: string, messageIdOrBefore: string): Promise<RestResponse>;
  assertTarget(target: CleanupTarget): void;
  deleted(channelId: string, messageId: string): void;
  canBulk?(target: CleanupTarget): boolean;
  bulk?(channelId: string, messageIds: string[]): Promise<RestResponse>;
};
type Message = { id: string; channel_id: string; author?: { id?: unknown }; type?: unknown; webhook_id?: unknown };
const ID = /^[1-9]\d{0,19}$/;
// Discord's documented deletable message types. Unknown future types fail closed.
const DELETABLE = new Set([0,6,7,8,9,10,11,12,14,15,16,17,18,19,20,22,23,25,26,27,28,29,31,32,36,37,38,39,44,46]);
export function validId(value: unknown): value is string { return typeof value === "string" && ID.test(value) && BigInt(value) < 1n << 64n; }
export function parseCooldown(value: string): number {
  if (!value.trim()) return 0;
  const seconds = /^[+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) throw new Error("Cooldown must be between 0 and 86400 seconds.");
  return Math.ceil(seconds * 1000);
}
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" ? value as Record<string, unknown> : {}; }
export function header(headers: unknown, name: string): string | undefined {
  const h = object(headers);
  if (typeof h.get === "function") { const v = (h.get as (name: string) => unknown).call(headers, name); if (v != null) return String(v); }
  for (const [key, value] of Object.entries(h)) if (key.toLowerCase() === name.toLowerCase() && value != null) return String(value);
  return undefined;
}
function seconds(value: unknown): number { const n = typeof value === "string" || typeof value === "number" ? Number(value) : NaN; return Number.isFinite(n * 1000) && n >= 0 ? n * 1000 : 0; }
export function retryDelay(response: RestResponse, now = Date.now()): number {
  const raw = header(response.headers, "retry-after");
  const date = raw && !Number.isFinite(Number(raw)) ? Math.max(0, Date.parse(raw) - now) : 0;
  return Math.max(seconds(object(response.body).retry_after), seconds(response.retryAfter), seconds(raw), Number.isFinite(date) ? date : 0);
}
function resetDelay(response: RestResponse, now: number): number {
  // Relative reset time is independent of the computer's wall clock. Do not
  // combine it with an absolute epoch: clock skew would add artificial waits.
  const relative = header(response.headers, "x-ratelimit-reset-after");
  if (relative !== undefined && relative.trim() !== "") {
    const ms = Number(relative) * 1000;
    if (Number.isFinite(ms) && ms >= 0) return Math.ceil(ms);
  }
  const reset = seconds(header(response.headers, "x-ratelimit-reset"));
  if (!reset) return 0;
  const serverDate = Date.parse(header(response.headers, "date") ?? "");
  return Math.max(0, Math.ceil(reset - (Number.isFinite(serverDate) ? serverDate : now)));
}
function zeroRetry(value:unknown):boolean {
  return (typeof value === "number" || (typeof value === "string" && value.trim()!=="")) && Number(value)===0;
}
export function recoveryWait(response:RestResponse,streak:number,now=Date.now()):{delay:number;source:string} {
  const explicit=retryDelay(response,now);
  const zero=[object(response.body).retry_after,response.retryAfter,header(response.headers,"retry-after")].some(zeroRetry);
  const remaining=header(response.headers,"x-ratelimit-remaining");
  // Reset-After is a budget reset, not necessarily this request's retry time.
  // A non-exhausted shared bucket must not turn a short Retry-After into minutes.
  const reset=remaining==="0" || (!explicit&&!zero&&remaining===undefined) ? resetDelay(response,now) : 0;
  const hint=Math.max(explicit,reset);
  const fallback=Math.min(300_000,(zero?500:5000)*2**Math.min(10,Math.max(0,streak-1)));
  const repeated=streak>=3?Math.min(300_000,1000*2**Math.min(9,streak-3)):0;
  const delay=Math.max(hint>0?hint:fallback,repeated)+50;
  const source=hint>0?(reset>explicit?i18nText("ui.discord_exhausted_bucket_reset"):i18nText("ui.discord_retry_time")):zero?i18nText("ui.discord_zero_second_retry_grace"):"Missing retry time; recovery backoff";
  return{delay,source:repeated>Math.max(hint||fallback,0)?i18nText("ui.repeated_rate_limit_backoff"):source};
}
function normalize(error: unknown): RestResponse {
  const e = object(error); const nested = object(e.response);
  let body = e.body ?? nested.body;
  // Native HTTPResponseError also exposes retryAfter directly. Some transports
  // keep their JSON response as text; parse only a bounded JSON candidate.
  const raw = typeof body === "string" ? body : e.text ?? nested.text;
  if ((body == null || typeof body === "string") && typeof raw === "string" && raw.length <= 16_384 && raw.trimStart().startsWith("{")) {
    try { body = JSON.parse(raw); } catch { /* Missing metadata uses recovery backoff. */ }
  }
  return { status: Number(e.status ?? e.statusCode ?? e.httpStatus ?? nested.status) || 0, body,
    headers: e.headers ?? nested.headers, retryAfter:e.retryAfter ?? nested.retryAfter };
}
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Stopped", "AbortError")); return; }
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, Math.min(ms, 2_147_483_647));
    function abort(): void { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new DOMException("Stopped", "AbortError")); }
    signal.addEventListener("abort", abort, { once: true });
  });
}
export class MessageCleanup {
  private state: CleanupState = { phase:"idle",limit:10,bulkProcessed:0,deleted:0,missing:0,skipped:0,scanned:0,detail:i18nText("ui.ready_e20846d"),waitUntil:0,pacing:i18nText("ui.idle") };
  private controller?: AbortController;
  private meter?: CleanupMeter;
  private globalUntil = 0;
  private readUntil = 0;
  private deleteUntil = 0;
  private lastDeleteAt = 0;
  private bulkUntil = 0;
  private pacer = new DeletePacer();
  private recovery = new Map<"get"|"del"|"bulk",{streak:number;until:number}>();
  private routeBuckets = new Map<"get" | "del" | "bulk",string>();
  constructor(private port: CleanupPort, private changed: (state: CleanupState) => void,
    private now: () => number = Date.now, private sleep = abortableSleep) {}
  snapshot(): CleanupState { return { ...this.state, automaticIntervalMs:this.state.mode==="steady"?STEADY_INTERVAL_MS:this.pacer.interval(), metrics:this.meter?.snapshot(this.state.deleted-this.state.bulkProcessed), target:this.state.target ? { ...this.state.target } : undefined }; }
  active(): boolean { return !!this.controller; }
  private update(patch: Partial<CleanupState>): void { Object.assign(this.state, patch); this.changed(this.snapshot()); }
  stop(): void { if (this.controller && !this.controller.signal.aborted) { this.update({phase:"stopping",detail:i18nText("ui.stopping_after_in_flight_requests")}); this.controller.abort(); } }
  async run(target: CleanupTarget, limit: CleanupLimit, cooldownMs: number, mode:CleanupMode="adaptive"): Promise<void> {
    if (this.controller) throw new Error("A cleanup is already running.");
    if (!validId(target.channelId) || !validId(target.userId) || ![10,100,null].includes(limit)
      || !["steady","adaptive"].includes(mode) || !Number.isFinite(cooldownMs) || cooldownMs < 0 || cooldownMs > 86_400_000) throw new Error("Invalid cleanup options.");
    this.port.assertTarget(target);
    const controller = new AbortController(); this.controller = controller;
    const frozen = { ...target };
    this.meter=new CleanupMeter(this.now);
    this.pacer.begin(`${frozen.userId}:${frozen.channelId}`);
    this.state = { phase:"running",target:frozen,limit,mode,bulkProcessed:0,deleted:0,missing:0,skipped:0,scanned:0,detail:i18nText("ui.reading_message_history"),waitUntil:0,pacing:i18nText("ui.reading_history") };
    this.update({});
    // A fixed upper bound excludes messages sent after Start, even during a long scan.
    let before = ((BigInt(this.now()) - 1_420_070_400_000n) << 22n).toString();
    const window = new DeleteWindow();
    // Serialize launch scheduling, not HTTP responses. Waiting workers cannot
    // reserve the same start time or wake together after a changed deadline.
    let launchGate: Promise<void> = Promise.resolve();
    let fault: Error | undefined;
    let steadyNext=0,deleteGeneration=0;
    const reschedule=new Error("Deletion launch rescheduled after rate limit");
    const assertActive = (): void => { if (fault) throw fault; if (controller.signal.aborted) throw new DOMException("Stopped", "AbortError"); this.port.assertTarget(frozen); };
    const pauseRoute = (method: "get" | "del" | "bulk", until: number): void => {
      const key = this.routeBuckets.get(method);
      for (const route of ["get","del","bulk"] as const) {
        if (route !== method && (!key || this.routeBuckets.get(route) !== key)) continue;
        if (route === "get") this.readUntil = Math.max(this.readUntil,until);
        else if (route === "bulk") this.bulkUntil = Math.max(this.bulkUntil,until);
        else {this.deleteUntil = Math.max(this.deleteUntil,until);this.meter!.rateDeadline(until);}
      }
    };
    const request = async (method: "get" | "del" | "bulk", id: string | string[]): Promise<RestResponse> => {
      const generation=deleteGeneration;
      const assertLaunch=():void=>{assertActive();if(mode==="steady"&&method==="del"&&generation!==deleteGeneration)throw reschedule;};
      for (;;) {
        assertLaunch();
        const previous=launchGate;
        let release=():void=>{};
        launchGate=new Promise<void>(resolve=>{release=resolve;});
        let pending:Promise<RestResponse>;
        let endRequest=():void=>{};
        let startedAt=0;
        await previous;
        try {
          assertLaunch();
          for (;;) {
            const rateUntil=Math.max(this.globalUntil,method === "get" ? this.readUntil : method === "bulk" ? this.bulkUntil : this.deleteUntil);
            const cooldownUntil=method === "del" && this.lastDeleteAt ? this.lastDeleteAt+cooldownMs : 0;
            const paceUntil=method === "del" ? mode==="steady"?steadyNext:this.pacer.until() : 0;
            const until=Math.max(rateUntil,cooldownUntil,paceUntil);
            if(until<=this.now())break;
            const rateLimited=rateUntil>this.now(),custom=cooldownUntil>this.now();
            const endWait=this.meter!.wait(until,rateUntil,cooldownUntil);
            this.update({phase:"waiting",waitUntil:until,detail:rateLimited?"Waiting for Discord's rate limit; cleanup will resume automatically…":custom?i18nText("ui.waiting_for_your_cooldown"):i18nText("ui.pacing_requests_to_reduce_rate_limits")});
            try { await this.sleep(until-this.now(),controller.signal); } finally { endWait(); }
            assertLaunch();
          }
          assertLaunch();this.update({phase:"running",waitUntil:0,detail:method === "get" ? i18nText("ui.reading_message_history") : method === "bulk" ? i18nText("ui.deleting_a_batch_of_your_messages") : i18nText("ui.deleting_your_messages")});
          assertActive();startedAt=this.now();
          if(method === "del"){if(mode==="steady")steadyNext=startedAt+STEADY_INTERVAL_MS;else this.pacer.started(startedAt,window.spacing());}
          endRequest=this.meter!.request();
          try { pending=method === "bulk" ? this.port.bulk!(frozen.channelId,id as string[]) : this.port.request(method,frozen.channelId,id as string); }
          catch(error) { pending=Promise.reject(error); }
        } finally { release(); }
        let response:RestResponse;
        try { response=normalize(await pending); } catch(error) { response=normalize(error); } finally { endRequest(); }
        if(method === "del"){
          window.completed(this.now()-startedAt);
          if(mode==="adaptive")this.pacer.completed(this.now()-startedAt,response.status===204,this.now(),this.meter!.snapshot(this.state.deleted-this.state.bulkProcessed));
        }
        if (method === "del" && response.status === 204) window.observe(header(response.headers,"x-ratelimit-bucket"),
          header(response.headers,"x-ratelimit-remaining"),resetDelay(response,this.now()),this.now());
        const bucket = header(response.headers,"x-ratelimit-bucket");
        if(bucket)this.routeBuckets.set(method,`${frozen.channelId}:${bucket}`);
        const remaining = header(response.headers, "x-ratelimit-remaining");
        if (remaining === "0") {
          const reset = resetDelay(response, this.now());
          if (reset > 0) {
            pauseRoute(method,this.now()+reset+50);
          }
        }
        if (response.status === 429) {
          this.meter!.limited();
          const at=this.now();
          const prior=this.recovery.get(method);
          // Parallel responses from one rejected group are one recovery episode.
          const streak=prior && startedAt<prior.until ? prior.streak : Math.min(16,(prior?.streak??0)+1);
          const recovery=recoveryWait(response,streak,at);
          const until=at+recovery.delay;
          this.state.lastRetryMs=recovery.delay;this.state.retrySource=recovery.source;
          this.recovery.set(method,{streak,until:Math.max(prior?.until??0,until)});
          const scope=header(response.headers,"x-ratelimit-scope");
          if (object(response.body).global === true || header(response.headers,"x-ratelimit-global") === "true" || scope === "global"
            || (object(response.body).global !== false && !scope)) {this.globalUntil = Math.max(this.globalUntil,until);this.meter!.rateDeadline(until);}
          else pauseRoute(method,until);
          if (method === "del") { deleteGeneration++;window.limited(until);if(mode==="adaptive")this.pacer.limited(startedAt,until,at);return response; }
          continue;
        }
        const recovering=this.recovery.get(method);
        if(response.status && response.status>=200 && response.status<300 && recovering && startedAt>=recovering.until)this.recovery.delete(method);
        return response;
      }
    };
    const rollingDeletes=async(messages:Message[]):Promise<void>=>{
      type Outcome={message:Message;retry:boolean;generation:number};
      type Task={task:Promise<Task>;outcome:Outcome};
      const pending=new Set<Promise<Task>>();
      const queued=messages.slice();
      let ready=false,draining=false,generation=deleteGeneration;
      const perform=async(message:Message):Promise<Outcome>=>{
        const launchedGeneration=deleteGeneration;
        let retry=false;
        try {
          const result=await request("del",message.id);
          this.lastDeleteAt=this.now();
          if(result.status===204){this.meter!.confirmed();this.update({deleted:this.state.deleted+1});this.port.deleted(frozen.channelId,message.id);}
          else if(result.status===404&&object(result.body).code===10008)this.update({missing:this.state.missing+1});
          else if(result.status===429)retry=true;
          else throw new Error(this.failure(result));
        }catch(error){
          if(error===reschedule)retry=true;
          else if(!controller.signal.aborted){fault=error instanceof Error?error:new Error("Cleanup failed.");controller.abort();}
        }
        return{message,retry,generation:launchedGeneration};
      };
      while(queued.length||pending.size){
        if(generation!==deleteGeneration){generation=deleteGeneration;ready=false;draining=true;}
        if(draining&&!pending.size)draining=false;
        this.deleteUntil=Math.max(this.deleteUntil,window.blockedUntil(this.now()));
        const capacity=ready?window.steadyWidth(this.now(),cooldownMs):1;
        while(!controller.signal.aborted&&!draining&&queued.length&&pending.size<capacity){
          this.update({pacing:cooldownMs>0?i18nText("ui.steady_sequential_custom_cooldown"):i18nText("ui.steady_1_40_messages_s_target_up_to_value_in_flight", {v0: capacity})});
          window.reserve(1);
          const task:Promise<Task>=perform(queued.shift()!).then(outcome=>({task,outcome}));
          pending.add(task);
        }
        // Stop/error drains actual in-flight results, but never launches queued work.
        if(!pending.size){assertActive();break;}
        const {task,outcome}=await Promise.race(pending);pending.delete(task);
        if(outcome.retry){queued.push(outcome.message);queued.sort((a,b)=>BigInt(a.id)>BigInt(b.id)?-1:1);}
        else if(outcome.generation===deleteGeneration)ready=true;
      }
      assertActive();
    };
    try {
      let finished = false;
      let bulkAllowed = cooldownMs === 0 && !!this.port.bulk && !!this.port.canBulk;
      while (!finished) {
        const response = await request("get", before); assertActive();
        if (response.status !== 200) throw new Error(this.failure(response));
        if (!Array.isArray(response.body) || response.body.length > 100) throw new Error("Discord returned an invalid history page. Cleanup stopped.");
        if (!response.body.length) break;
        const page = response.body as Message[];
        const ids = new Set<string>();
        for (const m of page) {
          if (!m || !validId(m.id) || m.channel_id !== frozen.channelId || BigInt(m.id) >= BigInt(before) || ids.has(m.id))
            throw new Error("Discord returned an inconsistent history page. Cleanup stopped.");
          ids.add(m.id);
        }
        page.sort((a,b)=>BigInt(a.id)>BigInt(b.id)?-1:1);
        before = page[page.length-1].id;
        this.update({scanned:this.state.scanned+page.length});
        const eligible: Message[] = [];
        const needed = limit === null ? Infinity : limit-this.state.deleted-this.state.missing;
        for (const m of page) {
          if (eligible.length >= needed) break;
          if (m.author?.id !== frozen.userId || m.webhook_id != null) continue;
          if (!DELETABLE.has(m.type as number)) { this.update({skipped:this.state.skipped+1}); continue; }
          eligible.push(m);
        }
        let offset = 0;
        while (offset < eligible.length) {
          assertActive();
          if (bulkAllowed && this.port.canBulk?.(frozen)) {
            const recent: Message[] = [];
            // Keep a one-day margin from the documented two-week cutoff.
            const cutoff = this.now()-13*86_400_000;
            for (const m of eligible.slice(offset)) {
              if (Number(BigInt(m.id)>>22n)+1_420_070_400_000 <= cutoff) break;
              recent.push(m);
            }
            if (recent.length >= 2) {
              this.update({pacing:i18nText("ui.bulk_server_supported_guild_channel")});
              const result = await request("bulk",recent.map(m=>m.id));
              if (result.status === 204) {
                this.update({deleted:this.state.deleted+recent.length,bulkProcessed:this.state.bulkProcessed+recent.length});
                for (const m of recent) this.port.deleted(frozen.channelId,m.id);
                offset+=recent.length;
                if(limit!==null&&this.state.deleted+this.state.missing>=limit){finished=true;break;}
                continue;
              }
              // Unsupported user/endpoint or a message aged across the cutoff:
              // use individual own-message deletes, never retry a rejected bulk.
              if ([403,404,405].includes(result.status ?? 0) || (result.status === 400 && [20002,50034].includes(object(result.body).code as number))) bulkAllowed=false;
              else throw new Error(this.failure(result));
            }
          }
          if(mode==="steady"){
            await rollingDeletes(eligible.slice(offset));
            offset=eligible.length;
            if(limit!==null&&this.state.deleted+this.state.missing>=limit)finished=true;
            continue;
          }
          this.deleteUntil = Math.max(this.deleteUntil,window.blockedUntil(this.now()));
          const width = Math.min(eligible.length-offset,window.width(this.now(),cooldownMs));
          this.update({pacing:window.description(this.now(),cooldownMs)+(this.pacer.interval()?i18nText("ui.learned_interval_valuems", {v0: Math.round(this.pacer.interval())}):"")});
          const batch = eligible.slice(offset,offset+width);
          window.reserve(width);
          const retry: Message[] = [];
          // All in-flight results settle before finishing, stopping or moving to
          // the next group; successes remain accurately counted on cancellation.
          await Promise.all(batch.map(async m=>{
            try {
              const result = await request("del",m.id);
              this.lastDeleteAt = this.now();
              if (result.status === 204) { this.meter!.confirmed();this.update({deleted:this.state.deleted+1}); this.port.deleted(frozen.channelId,m.id); }
              else if (result.status === 404 && object(result.body).code === 10008) this.update({missing:this.state.missing+1});
              else if (result.status === 429) {
                retry.push(m);
              } else throw new Error(this.failure(result));
            } catch (error) {
              if (!controller.signal.aborted) { fault=error instanceof Error?error:new Error("Cleanup failed.");controller.abort(); }
            }
          }));
          assertActive();
          // A rate-limited deletion is retried as a fresh, initially serial
          // probe; parallel workers never wake and burst together after 429.
          eligible.splice(offset,width,...retry.sort((a,b)=>BigInt(a.id)>BigInt(b.id)?-1:1));
          if (limit !== null && this.state.deleted+this.state.missing >= limit) { finished=true;break; }
        }
      }
      this.meter!.finish();
      this.update({phase:controller.signal.aborted?"stopped":"completed",waitUntil:0,detail:controller.signal.aborted?i18nText("ui.cleanup_stopped"):i18nText("ui.cleanup_complete")});
    } catch (error) {
      this.meter!.finish();
      this.update({phase:fault?"error":controller.signal.aborted?"stopped":"error",waitUntil:0,detail:fault?.message ?? (controller.signal.aborted?i18nText("ui.cleanup_stopped"):error instanceof Error?error.message:i18nText("ui.cleanup_failed"))});
    } finally { this.controller=undefined; }
  }
  private failure(response: RestResponse): string {
    if (response.status === 401) return i18nText("ui.your_discord_session_changed_cleanup_stopped");
    if (response.status === 403) return i18nText("ui.discord_denied_access_or_deletion_cleanup_stopped");
    if (response.status === 404) return i18nText("ui.the_target_channel_is_no_longer_available_cleanup_stopped");
    return `Discord request failed (${response.status || i18nText("ui.network_error")}). Cleanup stopped; deleted messages cannot be restored.`;
  }
}
