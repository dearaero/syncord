/**
 * Per-plugin rate limiting.
 *
 * Abuses the broker with a valid permission still need a ceiling: a runaway or
 * hostile plugin can otherwise turn an allowed host into a traffic amplifier or
 * simply hang the main process on a slow response. The limiter is a token bucket
 * per (plugin, channel) with a cooldown after a trip, so a plugin that trips its
 * limit stays limited for a while instead of retrying into the same wall.
 *
 * Discord's own traffic is never rate limited: nothing in Discord's code path
 * goes through this module.
 */

export type RateLimitRule = {
  /** Sustained rate. */
  perSecond: number;
  /** Bucket size — how much burst is tolerated. */
  burst: number;
  /** How long a tripped limiter keeps refusing, in ms. */
  cooldownMs: number;
};

export const RATE_LIMITS = {
  network: { perSecond: 5, burst: 15, cooldownMs: 30_000 } satisfies RateLimitRule,
  ipc: { perSecond: 200, burst: 600, cooldownMs: 5_000 } satisfies RateLimitRule,
  permissionPrompt: { perSecond: 0.2, burst: 3, cooldownMs: 60_000 } satisfies RateLimitRule,
  /**
   * Paid, credentialed calls to a third-party captcha solver.
   *
   * Its own bucket rather than the shared `ipc` one for the same reason the
   * broker has its own: a solve is not a UI click, and a page looping the
   * channel would spend real money at 200 requests a second. Three in flight
   * with a one-minute refill is above anything the Auto Quests watcher needs
   * (at most a couple of claims per poll) and far below anything worth
   * defending against.
   */
  captchaSolve: { perSecond: 0.05, burst: 3, cooldownMs: 60_000 } satisfies RateLimitRule,
} as const;

export type LimitKey = keyof typeof RATE_LIMITS;

type Bucket = {
  tokens: number;
  lastRefill: number;
  coolingUntil: number;
};

const buckets = new Map<string, Bucket>();

/**
 * Hard ceiling on tracked buckets.
 *
 * Never evict an active/cooling bucket to make room for a new key. The previous
 * "lowest tokens wins" eviction policy let a hostile caller deliberately evict
 * the *most rate-limited* real client (tokens=0), and the next request recreated
 * that bucket at a full burst budget.
 *
 * Idle buckets are safe to prune after five minutes: every rule in this module
 * has fully refilled long before then, so deleting one cannot restore budget it
 * would not already have naturally regained.
 */
const MAX_BUCKETS = 512;
const IDLE_BUCKET_TTL_MS = 5 * 60_000;

function pruneIdleBuckets(now = Date.now()): void {
  for (const [key, bucket] of buckets) {
    if (now < bucket.coolingUntil) continue;
    if (now - bucket.lastRefill < IDLE_BUCKET_TTL_MS) continue;
    buckets.delete(key);
  }
}

function bucketFor(key: string, rule: RateLimitRule): Bucket | undefined {
  let bucket = buckets.get(key);
  if (bucket !== undefined) return bucket;

  pruneIdleBuckets();
  if (buckets.size >= MAX_BUCKETS) return undefined;

  bucket = { tokens: rule.burst, lastRefill: Date.now(), coolingUntil: 0 };
  buckets.set(key, bucket);
  return bucket;
}

/** How many buckets are tracked. Exposed so the bound is testable, not assumed. */
export function trackedBucketCount(): number {
  return buckets.size;
}

export type RateVerdict = { allowed: true } | { allowed: false; retryAfterMs: number };

/** Consume one token. Returns whether the call may proceed. */
export function consumeLimit(key: string, kind: LimitKey): RateVerdict {
  const rule = RATE_LIMITS[kind];
  const now = Date.now();
  const bucket = bucketFor(key, rule);

  // Fail closed when the bounded table has no safe slot. Crucially, no existing
  // client's bucket is deleted just to admit a new identity.
  if (bucket === undefined) {
    return { allowed: false, retryAfterMs: rule.cooldownMs };
  }

  if (now < bucket.coolingUntil) {
    return { allowed: false, retryAfterMs: bucket.coolingUntil - now };
  }

  const elapsed = Math.max(0, now - bucket.lastRefill);
  bucket.lastRefill = now;
  bucket.tokens = Math.min(rule.burst, bucket.tokens + (elapsed / 1000) * rule.perSecond);

  if (bucket.tokens < 1) {
    // Tripping the limiter starts a cooldown, so hammering the refusal is not a
    // viable strategy for getting back in.
    bucket.coolingUntil = now + rule.cooldownMs;
    bucket.tokens = 0;
    return { allowed: false, retryAfterMs: rule.cooldownMs };
  }

  bucket.tokens -= 1;
  return { allowed: true };
}

/** Read-only peek, for the Security Center. */
export function limitSnapshot(): Array<{ key: string; tokens: number; cooling: boolean }> {
  return [...buckets.entries()].map(([key, bucket]) => ({
    key,
    tokens: Math.round(bucket.tokens * 100) / 100,
    cooling: Date.now() < bucket.coolingUntil,
  }));
}

export function resetLimits(): void {
  buckets.clear();
}
