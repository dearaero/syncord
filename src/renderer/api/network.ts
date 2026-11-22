/**
 * Renderer-side client for the main-process Network Broker.
 *
 * Plugins never call this directly. `ctx.network` (see
 * `src/renderer/api/plugin/context.ts`) binds the caller's plugin id into a
 * closure that this module does not expose, so a plugin cannot pass someone
 * else's id — the identity comes from the plugin manager, not from the plugin.
 *
 * This is *not* a security boundary on its own: a plugin that reaches
 * `window.SyncordNative` directly can still send any pluginId it likes. What
 * it does buy is that a plugin has to make a deliberate, greppable effort to
 * bypass the broker, and what the *main process* enforces — the permission
 * allowlist, the SSRF guard, the header filter, the limits and the rate limit —
 * is unaffected by anything the renderer claims.
 */
import type {
  SyncordNetworkRequest,
  SyncordNetworkResponse,
} from "../../shared/native";

type NativeSecurity = {
  requestNetwork: (req: SyncordNetworkRequest) => Promise<SyncordNetworkResponse>;
  registerManifest: (entries: unknown) => Promise<{ accepted: number }>;
};

function nativeSecurity(): NativeSecurity | undefined {
  const api = window.SyncordNative as unknown as
    | { security?: NativeSecurity }
    | undefined;
  return api?.security;
}

export { nativeSecurity as getSecurityBridge };

/**
 * Perform a permissioned request as `pluginId`.
 * Returns a denial object rather than throwing, so plugin code can degrade
 * gracefully and the Security Center still shows the event.
 */
export async function requestAsPlugin(
  pluginId: string,
  init: { url: string; method?: string; headers?: Record<string, string>; body?: string },
): Promise<SyncordNetworkResponse> {
  const security = nativeSecurity();
  if (security === undefined) {
    return {
      ok: false,
      status: 0,
      text: "",
      truncated: false,
      blockedReason: "network broker unavailable",
    };
  }
  try {
    return await security.requestNetwork({ pluginId, ...init });
  } catch (err) {
    // An exception here means the IPC layer rejected the *sender*, not the
    // request. Surface it as a denial; never echo the error object verbatim
    // into user-visible text.
    const message = err instanceof Error ? err.message : "request failed";
    return { ok: false, status: 0, text: "", truncated: false, blockedReason: message };
  }
}

export const networkClient = { request: requestAsPlugin };
