/**
 * The core-plugin list — one source of truth, shared by all three realms.
 *
 * ## Why this file exists
 *
 * Safe Mode and Emergency Lockdown both decide what "core" means, and the answer
 * was written down **twice**: once in `src/main/security/modes.ts` and once as a
 * literal in `src/renderer/api/plugin/manager.ts`. The renderer copy carried the
 * comment "Mirrors src/main/security/modes.ts", which is precisely the kind of
 * comment that is true until someone edits one of them.
 *
 * The cost is not theoretical. A plugin id present in one list and not the other
 * means Safe Mode lets it start (renderer check) while the main process blocks
 * its network (main check) — two different policies for the same plugin, with
 * neither one obviously wrong when you go looking. It also made a test I wrote
 * during the previous pass pass or fail for the wrong reason: it used a
 * main-process-only id, so the assertion was really about the drift rather than
 * about Safe Mode.
 *
 * ## Why here, and why not something larger
 *
 * `src/security/` is dependency-free and bundled into main, preload and renderer,
 * so a constant placed here is one value in all three — no IPC, no new module
 * boundary, no plugin-architecture change. The renderer deliberately keeps its
 * *own copy of the decision* rather than asking main over IPC: a renderer that
 * cannot reach main must still be able to refuse to start a non-core plugin, and
 * that fail-closed behaviour is the reason the list is duplicated in spirit. What
 * is duplicated here is only the **data**, which cannot drift.
 *
 * Main remains authoritative for the network half.
 */

/**
 * Plugins that survive Safe Mode and Emergency Lockdown.
 *
 * The bar: these only *present* information Discord already has. Nothing that
 * writes, sends, patches or reaches the network is core, because neither mode
 * may leave a capability running.
 */
export const CORE_PLUGIN_IDS = ["message-logger", "session-restore", "show-badges"] as const;

export type CorePluginId = (typeof CORE_PLUGIN_IDS)[number];

/** A fresh mutable set, so a caller cannot mutate the shared constant. */
export function corePluginIdSet(): Set<string> {
  return new Set<string>(CORE_PLUGIN_IDS);
}
