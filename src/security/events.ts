/**
 * Security event model.
 *
 * Pure: no electron, no fs. The main process owns the writer, the renderer
 * gets a copy over IPC for the Security Center. Everything recorded here is
 * already redacted — callers must not pass raw headers or bodies, and even if
 * they do, `redactValue` scrubs them on the way in.
 */
import { redactValue } from "./redact";

export const SECURITY_EVENT_TYPES = [
  "NETWORK_BLOCKED",
  "NETWORK_ALLOWED",
  /**
   * A request was *observed* leaving Discord's origin and was allowed through.
   *
   * Distinct from `NETWORK_BLOCKED` on purpose. The renderer observer is
   * pass-through by design (incident 005 — a non-boundary control must not
   * deny), but it was reporting through the same channel and main was labelling
   * every observation `NETWORK_BLOCKED`. The result on a real launch was a
   * warning-severity "blocked" entry for every Spotify and Discord-media
   * request Discord itself made: a security log that cries wolf, which is how a
   * log gets ignored. Observation is information; blocking is a decision.
   */
  "EGRESS_OBSERVED",
  "IPC_BLOCKED",
  "ORIGIN_BLOCKED",
  "WEBHOOK_BLOCKED",
  "PERMISSION_GRANTED",
  "PERMISSION_REVOKED",
  "PLUGIN_INTEGRITY_FAIL",
  "PRELOAD_INTEGRITY_FAIL",
  "REMOTE_SCRIPT_BLOCKED",
  "NAVIGATION_BLOCKED",
  "WINDOW_OPEN_BLOCKED",
  "RATE_LIMIT_TRIGGERED",
  "LOCKDOWN_ENABLED",
  // Extension events (Phases 12+).
  "SAFE_MODE_ENABLED",
  "SETTINGS_REJECTED",
  "NETWORK_DLP_BLOCKED",
  "PERMISSION_REQUESTED",
  "DEVTOOLS_TOGGLED",
  "INTEGRITY_OK",
  /**
   * A captcha was solved through the main-process solver.
   *
   * Recorded without the token, the sitekey or the key: what matters for an
   * incident review is *that* a paid third-party call happened, from which
   * plugin, and how long it took.
   */
  "CAPTCHA_SOLVED",
  /** The solver refused a request, or the service refused one. */
  "CAPTCHA_BLOCKED",
  /** An API key was written to, or removed from, the OS keychain. */
  "CAPTCHA_KEY_CHANGED",
] as const;

export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

export type SecuritySeverity = "info" | "notice" | "warning" | "critical";

const SEVERITY: Record<SecurityEventType, SecuritySeverity> = {
  NETWORK_BLOCKED: "warning",
  NETWORK_ALLOWED: "info",
  EGRESS_OBSERVED: "info",
  IPC_BLOCKED: "warning",
  ORIGIN_BLOCKED: "warning",
  WEBHOOK_BLOCKED: "critical",
  PERMISSION_GRANTED: "notice",
  PERMISSION_REVOKED: "notice",
  PLUGIN_INTEGRITY_FAIL: "critical",
  PRELOAD_INTEGRITY_FAIL: "critical",
  REMOTE_SCRIPT_BLOCKED: "critical",
  NAVIGATION_BLOCKED: "warning",
  WINDOW_OPEN_BLOCKED: "warning",
  RATE_LIMIT_TRIGGERED: "warning",
  LOCKDOWN_ENABLED: "critical",
  SAFE_MODE_ENABLED: "warning",
  SETTINGS_REJECTED: "warning",
  NETWORK_DLP_BLOCKED: "critical",
  PERMISSION_REQUESTED: "notice",
  DEVTOOLS_TOGGLED: "info",
  INTEGRITY_OK: "info",
  CAPTCHA_SOLVED: "info",
  CAPTCHA_BLOCKED: "warning",
  CAPTCHA_KEY_CHANGED: "notice",
};

export function severityOf(type: SecurityEventType): SecuritySeverity {
  return SEVERITY[type] ?? "info";
}

/**
 * The allowlist of fields an event may carry. Keeping this closed means a
 * future caller cannot start smuggling request bodies or tokens into the log
 * just because the type is `unknown`-ish.
 */
export type SecurityEventInput = {
  type: SecurityEventType;
  /** Short, human-readable cause. No user data, no secrets. */
  reason?: string;
  pluginId?: string;
  /** Origin of the requesting frame, e.g. "https://discord.com". */
  origin?: string;
  /** Hostname involved, e.g. "evil.com". */
  host?: string;
  method?: string;
  /** IPC channel name. */
  channel?: string;
  /** Electron webContents id — needed to correlate a blocked popup. */
  webContentsId?: number;
  /** Permission category, e.g. "network-connect". */
  permission?: string;
  durationMs?: number;
  /** Numeric counters only. Never free-form payloads. */
  count?: number;
};

export type SecurityEvent = SecurityEventInput & {
  id: number;
  timestamp: number;
  severity: SecuritySeverity;
};

export type SecurityEventLog = {
  record: (input: SecurityEventInput) => SecurityEvent;
  /** Newest first. */
  list: (limit?: number) => SecurityEvent[];
  byType: (type: SecurityEventType, limit?: number) => SecurityEvent[];
  counts: () => Partial<Record<SecurityEventType, number>>;
  since: (timestamp: number) => SecurityEvent[];
  clear: () => void;
  subscribe: (listener: (event: SecurityEvent) => void) => () => void;
  size: () => number;
};

/** Only the fields above survive, and only strings are redacted. */
function sanitize(input: SecurityEventInput): SecurityEventInput {
  const out: SecurityEventInput = { type: input.type };
  const copyString = (key: keyof SecurityEventInput, value: unknown): void => {
    if (typeof value !== "string") return;
    const text = value.length > 300 ? `${value.slice(0, 300)}…` : value;
    (out as Record<string, unknown>)[key] = redactValue(text);
  };
  copyString("reason", input.reason);
  copyString("pluginId", input.pluginId);
  copyString("origin", input.origin);
  copyString("host", input.host);
  copyString("method", input.method);
  copyString("channel", input.channel);
  copyString("permission", input.permission);
  if (typeof input.webContentsId === "number" && Number.isFinite(input.webContentsId)) {
    out.webContentsId = input.webContentsId;
  }
  if (typeof input.durationMs === "number" && Number.isFinite(input.durationMs)) {
    out.durationMs = Math.max(0, Math.round(input.durationMs));
  }
  if (typeof input.count === "number" && Number.isFinite(input.count)) {
    out.count = Math.max(0, Math.round(input.count));
  }
  return out;
}

export const DEFAULT_EVENT_LIMIT = 500;

/**
 * Bounded in-memory ring buffer.
 *
 * Bounded on purpose: an attacker who can trigger security events must not be
 * able to grow the heap without limit, and Phase 12 explicitly accepts
 * "memory + bounded recent events" for the first version.
 */
export function createSecurityEventLog(limit: number = DEFAULT_EVENT_LIMIT): SecurityEventLog {
  const cap = Math.max(1, Math.min(limit, 5000));
  const events: SecurityEvent[] = [];
  const listeners = new Set<(event: SecurityEvent) => void>();
  let nextId = 1;

  return {
    record(input) {
      const event: SecurityEvent = {
        ...sanitize(input),
        id: nextId++,
        timestamp: Date.now(),
        severity: severityOf(input.type),
      };
      events.push(event);
      if (events.length > cap) events.splice(0, events.length - cap);
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          /* a broken listener must not break logging */
        }
      }
      return event;
    },
    list(max) {
      const take = max === undefined ? events.length : Math.max(0, Math.min(max, events.length));
      return events.slice(events.length - take).reverse();
    },
    byType(type, max) {
      const filtered = events.filter((event) => event.type === type);
      const take = max === undefined ? filtered.length : Math.max(0, Math.min(max, filtered.length));
      return filtered.slice(filtered.length - take).reverse();
    },
    counts() {
      const out: Partial<Record<SecurityEventType, number>> = {};
      for (const event of events) {
        out[event.type] = (out[event.type] ?? 0) + 1;
      }
      return out;
    },
    since(timestamp) {
      return events.filter((event) => event.timestamp >= timestamp).reverse();
    },
    clear() {
      events.length = 0;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    size() {
      return events.length;
    },
  };
}
