import {getLocale} from "../../i18n";
import { requestAsPlugin } from "../network";
import { inject as injectCss, remove as removeCss } from "../css";
import { createLogger } from "../logger";
import * as patcher from "../patcher";
import { settings } from "../settings";
import { validatePluginPermissions } from "../../../security/permissions";
import type { SyncordNetworkRequest, SyncordNetworkResponse } from "../../../shared/native";
import type { Disposable, PluginContext, PluginDefinition } from "./types";

/**
 * Per-plugin runtime bag. Holds only disposers + tiny meta — no Discord module graphs.
 *
 * Capability gating (Phase 9). `ctx.patch` and `ctx.css` are the two powers that
 * let a plugin change what the user sees, so they are gated on declared
 * permissions:
 *
 *  - `webpackPatch` — required for `ctx.patch`. A plugin that monkeypatches
 *    Discord's internals can rewrite any other plugin's behaviour, so it is the
 *    single most powerful capability in the system and is opt-in per plugin.
 *  - `media` — required for `ctx.css.inject`, because injected CSS may reference
 *    remote `url()` resources. This is a *narrower* gate than it looks: CSS
 *    cannot execute script, but CSS network fetches are not broker-enforced.
 *    The session credential monitor is observe-only, so `media` must not be
 *    described as a transport-level host allowlist.
 *
 * A plugin without the permission gets a no-op and a warning rather than an
 * exception, so a missing declaration degrades the feature instead of breaking
 * plugin startup.
 */
export function createPluginContext(def: PluginDefinition): PluginContext {
  const disposers: Disposable[] = [];
  const cssId = `plugin-${def.id}`;
  let cssMounted = false;
  let disposed = false;

  const track = (fn: Disposable): void => {
    if(disposed){try{fn();}catch{/* Isolate late cleanup failures. */}}
    else disposers.push(fn);
  };

  // The plugin id is captured here, once, from the definition the manager owns.
  // A plugin cannot pass a different id to `ctx.network.request`; the only way to
  // reach the broker with someone else's identity is to bypass `ctx` entirely
  // and use `window.SyncordNative` — which is documented in
  // THIRD_PARTY_PLUGIN_SECURITY.md as the reason untrusted plugins cannot share
  // this realm.
  const identity = def.id;

  // The permission object on the context is the *validated* one, re-normalized
  // here so a definition constructed outside `definePlugin` (tests, an internal
  // module) still cannot hand a context an unvalidated permission set.
  const permissions = validatePluginPermissions(def.id, def.permissions);
  const canPatch = permissions.webpackPatch === true;
  const canInjectCss = permissions.media === true;
  const log = createLogger(def.id);

  /**
   * Warn when a permission is *used*, not when a context is created.
   *
   * The previous version logged both warnings eagerly for every plugin. Most
   * plugins never patch webpack and never inject CSS, so a real launch was
   * buried in "ctx.patch is unavailable" lines that said nothing — and the one
   * that mattered (`auto-quests` genuinely needs `webpackPatch` and was missing
   * it, so its quest logic was silently inert) looked exactly like the rest.
   *
   * A security control that logs the same thing for every caller has stopped
   * being information. This fires at most once per plugin and only when the
   * plugin actually reaches for something it was not granted.
   */
  const warnOnce = (() => {
    const already = new Set<string>();
    return (message: string): void => {
      if (already.has(message)) return;
      already.add(message);
      log.warn(message);
    };
  })();

  const requirePatch = (): boolean => {
    if(disposed)return false;
    if (canPatch) return true;
    warnOnce("ctx.patch used without permissions.webpackPatch — add it to declare the intent");
    return false;
  };
  const requireCss = (): boolean => {
    if(disposed)return false;
    if (canInjectCss) return true;
    warnOnce("ctx.css.inject used without permissions.media — add it to declare the intent");
    return false;
  };

  const recordingBridge = (): import("../../../shared/recording").RecordingBridge => {
    if (identity !== "screen-recorder" || !permissions.native?.includes("screen-recording")) throw new Error("Recording capability denied.");
    const bridge = window.SyncordNative?.recording;
    if (!bridge) throw new Error("Screen Recorder needs the updated Syncord preload. Restart Discord after updating.");
    return bridge;
  };

  /**
   * The captcha solver bridge.
   *
   * Gated twice, like recording: the plugin must declare the capability, and
   * only the plugin that owns this feature is served. A capability check alone
   * would let any plugin that copied `permissions: { native: ["captcha-solve"] }`
   * spend the user's solver credits on challenges of its own choosing — which,
   * given the fixed host and Discord-only URLs the main process enforces, still
   * means "every Discord captcha, forever, on the user's dime".
   *
   * Every method answers with a denial instead of throwing. The caller is a
   * background loop, and a rejected promise inside one of those is an unhandled
   * rejection rather than the "automatic claiming is off" the user should see.
   */
  const captchaDenied = (reason: string): import("../../../shared/captcha").CaptchaBridge => ({
    status: async () => ({ configured: false, masked: null, encryptionAvailable: false, lockedDown: false }),
    setKey: async () => ({ ok: false, reason }),
    clearKey: async () => ({ cleared: false }),
    solve: async () => ({
      ok: false,
      code: "not_permitted",
      message: reason,
      retryable: false,
      solveId: null,
    }),
    feedback: async () => ({ ok: false, recorded: 0, failed: 0, reason }),
  });

  /** The live bridge, or a denial that explains why there isn't one. */
  const captchaBridge = (): import("../../../shared/captcha").CaptchaBridge => {
    if (identity !== "auto-quests" || !permissions.native?.includes("captcha-solve")) {
      return captchaDenied("Captcha solving capability denied.");
    }
    const bridge = window.SyncordNative?.captcha;
    if (!bridge) {
      return captchaDenied("Captcha solving needs the updated Syncord preload. Restart Discord after updating.");
    }
    return bridge;
  };

  const popoutBridge = (): import("../../../shared/popoutChats").PopoutBridge => {
    if(identity!=="popout-chats"||!permissions.native?.includes("popout-chats"))throw Error("Popout capability denied");
    const bridge=window.SyncordNative?.popoutChats;if(!bridge)throw Error("Restart Discord to load Popout Chats");return bridge;
  };
  const dropBridge=():import("../../../shared/drop").DropBridge=>{
    if(identity!=="syncord-drop"||!permissions.native?.includes("syncord-drop"))throw Error("drop.denied");
    const bridge=window.SyncordNative?.drop;if(!bridge||bridge.availability!==1||typeof bridge.inbox!=="function")throw Error("drop.restart");return bridge;
  };
  const snapshotBridge=():import("../../../shared/snapshot").SnapshotBridge=>{
    if(identity!=="time-machine"||!permissions.native?.includes("chat-snapshot"))throw Error("Snapshot capability denied");
    const bridge=window.SyncordNative?.snapshot;if(!bridge)throw Error("Restart Discord to load Time Machine snapshots");return bridge;
  };
  const ctx: PluginContext = {
    snapshot:{copy:rect=>snapshotBridge().copy(rect)},
    drop:{availability:1,inbox:(account,available)=>dropBridge().inbox(account,available),connect:async account=>{await settings.flush();return dropBridge().connect(account);},pick:s=>dropBridge().pick(s),invite:(s,r)=>dropBridge().invite(s,r),view:(s,id)=>dropBridge().view(s,id),action:(s,id,a,sdp)=>dropBridge().action(s,id,a,sdp),save:(s,id)=>dropBridge().save(s,id),read:s=>dropBridge().read(s),write:(s,b)=>dropBridge().write(s,b),hash:s=>dropBridge().hash(s),finish:(s,h)=>dropBridge().finish(s,h),reveal:s=>dropBridge().reveal(s),stop:s=>dropBridge().stop(s),subscribe:fn=>dropBridge().subscribe(fn)},
    popoutChats:{connect:account=>popoutBridge().connect(account),open:(session,id,bounds)=>popoutBridge().open(session,id,bounds),stop:session=>popoutBridge().stop(session),publish:(session,id,state)=>popoutBridge().publish(session,id,state),subscribe:listener=>popoutBridge().subscribe(listener)},
    ecosystemBadges:{art:async image=>{
      if(identity!=="show-badges"||!permissions.native?.includes("ecosystem-badges"))throw Error("Official badge capability denied.");
      const bridge=window.SyncordNative?.ecosystem;if(!bridge?.art)throw Error("Restart Discord after updating Syncord to load badge images.");return bridge.art(image);
    },lookup:async ids=>{
      if(identity!=="show-badges"||!permissions.native?.includes("ecosystem-badges"))throw Error("Official badge capability denied.");
      return window.SyncordNative?.ecosystem?.lookup(ids)??{};
    }},
    recording: {
      setLocale: async locale => { await recordingBridge().setLocale?.(locale); },
      devices: async () => {const bridge=recordingBridge();await bridge.setLocale?.(getLocale());return bridge.devices();},
      start: async options => {const bridge=recordingBridge();await bridge.setLocale?.(getLocale());return bridge.start(options);},
      stop: async release => recordingBridge().stop(release),
      status: async () => recordingBridge().status(),
      list: async before => recordingBridge().list(before),
      play: async id => {
        const bridge=recordingBridge();
        if(typeof bridge.readPlayback!=="function"||typeof bridge.closePlayback!=="function")throw new Error("Restart Discord after applying the updated Syncord build to use the in-client player.");
        return bridge.play(id);
      },
      readPlayback: async (token, offset) => recordingBridge().readPlayback(token, offset),
      closePlayback: async token => recordingBridge().closePlayback(token),
      reveal: async id => recordingBridge().reveal(id),
    },
    /**
     * Resolved per call rather than captured once: a plugin that never touches
     * the capability must not fail to start because the preload is old.
     */
    captcha: {
      status: () => captchaBridge().status(),
      setKey: key => captchaBridge().setKey(key),
      clearKey: () => captchaBridge().clearKey(),
      solve: input => captchaBridge().solve(input),
      feedback: input => captchaBridge().feedback(input),
    },
    plugin: {
      id: def.id,
      name: def.name,
      description: def.description,
      author: def.author,
      enabledByDefault: def.enabledByDefault,
      restartOnDisable: def.restartOnDisable,
      permissions: def.permissions,
      core: def.core,
    },
    permissions,
    log,
    disposable(fn) {
      track(fn);
    },
    patch: {
      before(object, method, hook) {
        if (!requirePatch()) return noopPatch;
        const undo = patcher.before(object, method, hook);
        track(undo);
        return undo;
      },
      after(object, method, hook) {
        if (!requirePatch()) return noopPatch;
        const undo = patcher.after(object, method, hook);
        track(undo);
        return undo;
      },
      instead(object, method, hook) {
        if (!requirePatch()) return noopPatch;
        const undo = patcher.instead(object, method, hook);
        track(undo);
        return undo;
      },
    },
    css: {
      inject(cssText: string) {
        if (!requireCss()) return;
        injectCss(cssId, cssText);
        if (!cssMounted) {
          cssMounted = true;
          track(() => {
            removeCss(cssId);
            cssMounted = false;
          });
        }
      },
    },
    settings: {
      get<T = unknown>(key: string, fallback?: T) {
        return settings.get<T>(`plugins.${def.id}.data.${key}`, fallback);
      },
      set(key: string, value: unknown) {
        settings.set(`plugins.${def.id}.data.${key}`, value);
      },
    },
    network: {
      request(init: Omit<SyncordNetworkRequest, "pluginId">): Promise<SyncordNetworkResponse> {
        if(disposed)return Promise.resolve({ok:false,status:0,text:'',truncated:false,blockedReason:'plugin stopped'});
        return requestAsPlugin(identity, init);
      },
    },
  };

  return Object.assign(ctx, {
    /** @internal */
    _disposeAll(): void {
      if(disposed)return;
      disposed=true;
      for (let i = disposers.length - 1; i >= 0; i--) {
        try {
          disposers[i]!();
        } catch {
          /* isolate cleanup errors */
        }
      }
      disposers.length = 0;
    },
  });
}

export type PluginContextInternal = PluginContext & {
  _disposeAll: () => void;
};

/** Returned instead of a patch disposer when patching is not permitted. */
function noopPatch(): void {
  /* the patch was refused; nothing to undo */
}
