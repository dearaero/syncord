/**
 * The privileged API exposed to the Discord renderer through `contextBridge`.
 *
 * Everything here is exposed **only** on trusted Discord origins (see
 * `src/preload/index.ts`), and every call is re-validated on the main-process
 * side against the sender's origin and frame identity.
 *
 * What was removed and why:
 *   - `httpFetch({ url, method, headers, body })` — an unrestricted main-process
 *     `fetch` callable by any renderer code. Replaced by `security.request`,
 *     which carries a plugin identity and is checked against a permission
 *     allowlist, an SSRF guard, a header filter, size limits and a rate limit.
 *   - There is deliberately no `getToken`, `saveToken`, `exportToken`, raw
 *     `ipcRenderer`, filesystem, or `openExternal` entry point. That list is the
 *     design, not an oversight.
 */

export type SyncordNetworkRequest = {
  /** Which plugin is asking. Cannot be spoofed into existence — see the broker. */
  pluginId: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type SyncordNetworkResponse = {
  ok: boolean;
  status: number;
  text: string;
  /** Body hit the response size cap and was cut short. */
  truncated: boolean;
  /** Present when the broker refused before opening a socket. */
  blockedReason?: string;
};

export type SyncordSecurityEvent = {
  id: number;
  timestamp: number;
  type: string;
  severity: string;
  reason?: string;
  pluginId?: string;
  origin?: string;
  host?: string;
  method?: string;
  channel?: string;
  permission?: string;
  webContentsId?: number;
  durationMs?: number;
  count?: number;
};

export type SyncordPrivacyStatus = {
  requestFilterInstalled: boolean;
  nativeCrashGuard: boolean;
  discordCrashStartupDisabled: boolean;
  blocked: { analytics: number; metrics: number; crashReports: number; sentryScript: number };
};

export type SyncordSecurityStatus = {
  /** Core feature, independent of plugin lifecycle. Optional for older bridges. */
  privacy?: SyncordPrivacyStatus;
  version: string;
  /** Preload exposed `SyncordNative` (we are on a trusted origin). */
  trustedOrigins: boolean;
  /** Main-process sender validation is registered. */
  senderValidation: boolean;
  networkLockedDown: boolean;
  developerMode: boolean;
  safeMode: boolean;
  lockdown: boolean;
  devTools: boolean;
  /**
   * Is the session-layer credential monitor installed?
   *
   * Named for what it is, not for what someone hoped it was. It is a **monitor**:
   * it sees every request carrying a credential to a non-Discord host and records
   * it, and it deliberately does not cancel — Discord's own Spotify
   * rich-presence integration matches that rule, so enforcing it broke a real
   * feature (SECURITY_AUDIT.md §17). `egressEnforcing` was the previous name and
   * it overclaimed.
   *
   * The control that *does* deny plugin network traffic is the broker, reported
   * separately as `brokerEnforcing`.
   */
  egressMonitor: boolean;
  /** True when the network broker is the active, denying control for plugins. */
  brokerEnforcing: boolean;
  permissionHandlers: boolean;
  integrity: IntegrityState;
  /** OS keychain available for Syncord's own secrets. */
  encryptionAvailable: boolean;
};

/** Build integrity state, as reported by the main process. */
export type IntegrityState = "unverified" | "development" | "ok" | "modified" | "unreadable";

export type SyncordPluginManifestEntry = {
  id: string;
  network?: Array<{ host: string; methods?: string[]; paths?: string[] }>;
  webhookSend?: boolean;
};

export type SyncordBrokerPolicy = {
  lockedDown: boolean;
  plugins: Array<{ id: string; hosts: string[]; webhookSend: boolean; blocked: boolean }>;
};

/** Categories a user can approve. `script` is deliberately not grantable. */
export type SyncordPermissionCategory =
  | "network-connect"
  | "image"
  | "media"
  | "font"
  | "style";

export type SyncordPermissionGrant = {
  key: string;
  pluginId: string;
  category: SyncordPermissionCategory;
  host: string;
  methods: string[];
  /** false = session only; true = persisted across restarts. */
  trusted: boolean;
  grantedAt: number;
};

export type SyncordPermissionResult =
  | { ok: true; grant: SyncordPermissionGrant }
  | { ok: false; reason: string };

export type SyncordPermissionRequest = {
  pluginId: string;
  category: SyncordPermissionCategory;
  host: string;
  methods?: string[];
  /** Must be an explicit user opt-in; the UI only sets true from the checkbox. */
  trusted?: boolean;
};

/**
 * A refused direct-egress attempt, as reported by the renderer hooks.
 * Hostnames and a short reason only — never a URL, body, or header value.
 */
export type SyncordEgressReport = {
  transport: string;
  host: string;
  reason: string;
  /** A size, not content. */
  detail?: string;
};

export type SyncordSecurityBridge = {
  registerManifest(entries: SyncordPluginManifestEntry[]): Promise<{ accepted: number }>;
  requestNetwork(req: SyncordNetworkRequest): Promise<SyncordNetworkResponse>;
  status(): Promise<SyncordSecurityStatus>;
  events(limit: number): Promise<SyncordSecurityEvent[]>;
  policy(): Promise<SyncordBrokerPolicy>;
  permissions(): Promise<SyncordPermissionGrant[]>;
  grant(req: {
    pluginId: string;
    category: SyncordPermissionCategory;
    host: string;
    methods?: string[];
    trusted?: boolean;
  }): Promise<SyncordPermissionResult>;
  revoke(key: string): Promise<boolean>;
  reportEgress(report: SyncordEgressReport): Promise<void>;
  lockdown(): Promise<{ locked: boolean }>;
  setSafeMode(enabled: boolean): Promise<{ safeMode: boolean }>;
  /**
   * Append one line to the boot log in the main process.
   *
   * Reporting only. Exists because the renderer's own console is invisible from
   * a terminal and it has no `fs`, so without this the last third of the boot
   * chain is unobservable.
   */
  bootLog(line: string): Promise<void>;
};

/**
 * Update service, mirrored from `src/main/security/updater.ts`.
 *
 * Deliberately a sibling of `security`, not a member of it: the Network Broker
 * and the permission model govern *plugins*, and auto-update is a first-class
 * client feature that must keep working when Safe Mode or Lockdown has stopped
 * every plugin. A compromised plugin therefore has no route to the updater
 * through the broker — it would have to forge a direct bridge call, which lands
 * on the same trusted-sender check as every other channel.
 *
 * No method here accepts a URL, a hostname or a path to write. `handOff`
 * takes the absolute path of the *installer the user configured*, which main
 * validates as an existing regular file and passes as an argument vector with
 * no shell.
 */
export type SyncordUpdatePhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "ready"
  | "handing-off"
  | "handed-off"
  | "awaiting-restart"
  | "error";

export type SyncordUpdateStatus = {
  phase: SyncordUpdatePhase;
  /** Safe to render verbatim. Main never puts a path or a server message here. */
  detail: string;
  /** The running build, as compiled in. `current` is what is compared against. */
  build: string;
  current: string;
  latest: string | null;
  channel: string;
  platform: string | null;
  /** 0..1 while downloading, otherwise null. */
  progress: number | null;
  stagedVersion: string | null;
  lastError: string | null;
};

/** Where the Syncord Installer lives, as main found it. */
export type SyncordInjectorLocation = {
  /** Absolute path, or `null` when no candidate was usable. */
  found: string | null;
  /** The read-only candidates that were checked, for an actionable message. */
  searched: string[];
};

export type SyncordUpdateBridge = {
  /** Ask the release feed for the current version. Moves no data inbound. */
  check(channel: string): Promise<SyncordUpdateStatus>;
  /** Read the current state. Safe to poll. */
  status(): Promise<SyncordUpdateStatus>;
  /** Download and verify the already-accepted release into staging. */
  stage(): Promise<SyncordUpdateStatus>;
  /**
   * Run the installer against the staged bundle and wait for the result.
   *
   * `injectorPath` is optional. When it is absent or empty, main discovers the
   * installer from a fixed list of read-only candidates, so the common case
   * needs no configured path. A supplied path wins, and is validated in main.
   *
   * Resolves only once the installer has exited. The first version spawned it
   * detached with no output captured and reported success immediately, which
   * meant the UI could claim an install that had not happened.
   */
  handOff(injectorPath?: string): Promise<SyncordUpdateStatus>;
  /** Close this Discord only after a verified worker is ready to install and relaunch it. */
  restart(): Promise<boolean>;
  /**
   * Forget the accepted release.
   *
   * Called when automatic updates are switched off: without it the Download
   * button keeps offering a release the user has stopped checking for.
   */
  reset(): Promise<SyncordUpdateStatus>;
  /** Where the installer was found, so the UI can say before the user presses. */
  injector(): Promise<SyncordInjectorLocation>;
};

export type SyncordNativeApi = {
  popoutChats?: import("./popoutChats").PopoutBridge;
  /** Copies a rectangle of the calling page to the clipboard; returns only its size. */
  snapshot?: import("./snapshot").SnapshotBridge;
  /** Read-only local process and storage aggregates; no arbitrary paths or commands. */
  drop?: import("./drop").DropBridge;
  ecosystem?: import("./ecosystem").EcosystemBridge;
  statistics?: import("./statistics").StatisticsBridge;
  /** Screen Recorder: fixed local library, explicit source picker, no raw paths. */
  recording?: import("./recording").RecordingBridge;
  /**
   * Captcha solving: a fixed third-party host, a key held in the OS keychain,
   * and no way to name a URL, a header or a timeout.
   *
   * `setKey` is the only method that takes a secret, and it is a one-way door:
   * nothing in this interface returns the key back, so a compromised renderer
   * can overwrite or delete the stored one but cannot read it.
   */
  captcha?: import("./captcha").CaptchaBridge;
  ping(): Promise<"pong">;
  getVersion(): Promise<string>;
  getSettings(): Promise<Record<string, unknown>>;
  setSettings(data: Record<string, unknown>): Promise<void>;
  /**
   * Present only on trusted Discord origins. The absence of this property is
   * itself the signal that the preload gate rejected the page.
   */
  security?: SyncordSecurityBridge;
  /** Also gated on the trusted-origin check, for the same reason. */
  updates?: SyncordUpdateBridge;
};
