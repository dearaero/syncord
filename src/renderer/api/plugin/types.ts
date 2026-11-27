import type { createLogger } from "../logger";
import type { after, before, instead } from "../patcher";
import type { PluginPermissions } from "../../../security/permissions";
import type { SyncordNetworkRequest, SyncordNetworkResponse } from "../../../shared/native";

export type Disposable = () => void;

export type PluginMeta = {
  /** Stable settings key. Lowercase kebab-case, unique. */
  id: string;
  /** Human-readable name. */
  name: string;
  description?: string;
  author?: string;
  /** Default true. Persisted under settings.plugins.<id>.enabled */
  enabledByDefault?: boolean;
  /** Executed Discord factory changes need a client restart for full removal. */
  restartOnDisable?: boolean;
  /**
   * Least-privilege declaration (Phase 9).
   *
   * Absent ⇒ an empty permission set, i.e. no network, no native, no clipboard.
   * `network: ["*"]` is a hard error in `validatePluginPermissions`, not a
   * supported shorthand, so one plugin cannot opt out of the policy.
   */
  permissions?: PluginPermissions;
  /**
   * Built-in plugins ship with Syncord and are part of the trusted bundle.
   * Safe Mode (Phase 13) leaves `core: true` plugins running and disables the
   * rest, which is what makes "Discord still works" true in safe mode.
   */
  core?: boolean;
};

/**
 * Capability surface handed to a plugin.
 *
 * Every entry is created per plugin by `createPluginContext`, with the plugin's
 * identity already bound. A plugin cannot obtain a context for a different
 * plugin, and there is no `ctx.native.ipcRenderer`, `ctx.fs`, or
 * `ctx.eval`.
 */
export type PluginContext = {
  drop: import("../../../shared/drop").DropBridge;
  popoutChats: import("../../../shared/popoutChats").PopoutBridge;
  /** Available only to the built-in Screen Recorder with its native capability. */
  ecosystemSelf?: {profile:(account:string)=>Promise<import("../../../shared/ecosystem").EcoProfile>;lookup:(ids:string[])=>Promise<import("../../../shared/ecosystem").EcoLookup>};
  ecosystemBadges?: {art?:import("../ecosystem/art").BadgeImageResolver;lookup:(ids:string[])=>Promise<import("../../../shared/ecosystem").EcoLookup>};
  recording: import("../../../shared/recording").RecordingBridge;
  /** Available only to the built-in Time Machine with `native: ["chat-snapshot"]`. */
  snapshot: import("../../../shared/snapshot").SnapshotBridge;
  /**
   * hCaptcha solving through the main process.
   *
   * Available only to a plugin that declares `permissions.native:
   * ["captcha-solve"]`. The NoneCap credential never enters this realm: the
   * key lives in the OS keychain, the request is made in main against one
   * fixed host, and this surface hands back a token or a typed failure.
   */
  captcha: import("../../../shared/captcha").CaptchaBridge;
  readonly plugin: Readonly<PluginMeta>;
  readonly log: ReturnType<typeof createLogger>;
  /** Register cleanup; run automatically on stop (LIFO). */
  disposable: (fn: Disposable) => void;
  /** The validated, canonical permission set for this plugin. */
  readonly permissions: Readonly<PluginPermissions>;
  patch: {
    before: typeof before;
    after: typeof after;
    instead: typeof instead;
  };
  css: {
    /** Inject CSS scoped to this plugin; auto-removed on stop. */
    inject: (cssText: string) => void;
  };
  settings: {
    get: <T = unknown>(key: string, fallback?: T) => T | undefined;
    set: (key: string, value: unknown) => void;
  };
  /**
   * Network access through the main-process broker.
   *
   * The plugin id is bound in the closure, so `ctx.network.request` cannot be
   * pointed at another plugin's permissions. Requests are still authorized by
   * the main process against the manifest; this is a convenience that makes the
   * honest path the easy one, not the enforcement point.
   *
   * Returns a denial object (`blockedReason` set) instead of throwing, so a
   * refused request cannot be mistaken for a network failure.
   */
  network: {
    request: (
      init: Omit<SyncordNetworkRequest, "pluginId">,
    ) => Promise<SyncordNetworkResponse>;
  };
};

export type PluginDefinition = PluginMeta & {
  start: (ctx: PluginContext) => void | Promise<void>;
  /** Optional; disposables already ran before this. */
  stop?: (ctx: PluginContext) => void | Promise<void>;
};

export type PluginPublicInfo = PluginMeta & {
  enabled: boolean;
  started: boolean;
  /** One-line summary for the Security Center, e.g. "network: api.example.com". */
  permissionSummary: string;
};

const ID_RE = /^[a-z][a-z0-9-]*$/;

export function assertPluginId(id: string): void {
  if (!ID_RE.test(id)) {
    throw new Error(
      `Invalid plugin id "${id}" — use lowercase kebab-case (e.g. "my-plugin")`,
    );
  }
}
