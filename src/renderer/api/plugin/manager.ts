import {localizeKnown} from "../../i18n/core";
import { createLogger } from "../logger";
import { getSecurityBridge } from "../network";
import { settings } from "../settings";
import { summarizePermissions, validatePluginPermissions } from "../../../security/permissions";
import { corePluginIdSet } from "../../../security/corePlugins";
import type { SyncordPluginManifestEntry } from "../../../shared/native";
import {
  createPluginContext,
  type PluginContextInternal,
} from "./context";
import {
  assertPluginId,
  type PluginDefinition,
  type PluginPublicInfo,
} from "./types";

const log = createLogger("plugins");

/**
 * Plugin lifecycle state.
 *
 * A single boolean was not enough. Claiming `started = true` *before* awaiting
 * `start()` fixed the double-start race, but created the mirror one: a `disable()`
 * arriving mid-start saw `started === true`, ran `stop()` against a context whose
 * `start()` had not returned yet, and then `start()` resolved and added disposers
 * to a plugin the manager already believed was stopped. The patch or listener
 * that plugin installed was never undone.
 *
 * The four states make "a start is in flight" representable, so every caller can
 * tell the difference between "running" and "becoming running".
 */
type LifecycleState = "stopped" | "starting" | "started" | "stopping";

type Runtime = {
  def: PluginDefinition;
  started: boolean;
  ctx: PluginContextInternal | undefined;
  /** Authoritative state. `started` is kept in step for the existing readers. */
  state: LifecycleState;
  /**
   * Tail of this plugin's operation chain.
   *
   * Every start and stop is appended, so operations run in request order and
   * never overlap. This is what makes the outcome deterministic rather than
   * dependent on which await happened to resume first.
   */
  chain: Promise<void>;
};

/** id → runtime. Map for O(1) enable/disable without scanning. */
const byId = new Map<string, Runtime>();
/** Registration order for deterministic start. */
const order: string[] = [];

function enabledKey(id: string): string {
  return `plugins.${id}.enabled`;
}

/**
 * Decided once, on the first boot that sees it missing: an empty settings file
 * is a fresh install, where every plugin starts off until the user enables it.
 * Existing installs keep each plugin's `enabledByDefault`.
 */
const DEFAULTS_OFF_KEY = "pluginDefaults.off";
let defaultsOff: boolean | undefined;

function pluginsDefaultOff(): boolean {
  if (defaultsOff !== undefined) return defaultsOff;
  // Before settings load an empty cache proves nothing, so do not decide yet.
  if (!settings.isLoaded()) return false;
  const saved = settings.get<unknown>(DEFAULTS_OFF_KEY);
  if (typeof saved === "boolean") return (defaultsOff = saved);
  defaultsOff = Object.keys(settings.getAll()).length === 0;
  settings.set(DEFAULTS_OFF_KEY, defaultsOff);
  return defaultsOff;
}

function isEnabled(def: PluginDefinition): boolean {
  const fallback = !pluginsDefaultOff() && def.enabledByDefault !== false;
  return settings.get<boolean>(enabledKey(def.id), fallback) !== false;
}

/**
 * Safe Mode (Phase 13): skip every non-core plugin.
 *
 * The list is the main process's (`corePluginIds()`), not a hardcoded set here,
 * so the decision about what "core" means lives in one place. Core plugins only
 * *present* information Discord already has; nothing that writes, sends or
 * patches survives Safe Mode.
 *
 * The main process independently blocks plugin network access in Safe Mode, so
 * a plugin that somehow still ran could not reach the network — this is the
 * convenience half of the same policy, not the enforcement half.
 */
const safeModeActive = (): boolean => safeModeFlag;

/** Set once at boot from the main process status. */
let safeModeFlag = false;

export function setSafeMode(active: boolean): void {
  safeModeFlag = active;
}

export function isSafeModeActive(): boolean {
  return safeModeFlag;
}

/**
 * Emergency Lockdown, on the renderer side.
 *
 * Kept as its own flag rather than folded into `safeModeFlag`. The two are
 * different user intentions with different consequences: Safe Mode is a
 * diagnostic convenience the user can leave, while Lockdown is a one-way
 * emergency stop. Merging them would mean a user leaving Safe Mode also lifted
 * the lockdown, which is the opposite of what pressing the button should do.
 *
 * The distinction costs one boolean and keeps both semantics intact.
 */
let lockdownFlag = false;

/**
 * Arm the renderer side of Emergency Lockdown. **One way only.**
 *
 * This used to be `setLockdown(active: boolean)` and it was exported through the
 * public `plugins` object, so `Syncord.plugins.setLockdown(false)` undid the
 * renderer gate. Main's network lockdown would still hold, but the restricted-mode
 * check that refuses non-core plugins would reopen — and a non-core plugin could
 * be started again. That is the opposite of what an emergency stop means, and it
 * was reachable from ordinary page code.
 *
 * There is deliberately no parameter: the only thing a caller can express is
 * "armed". Leaving lockdown is not something the renderer can be asked to do.
 * Test isolation uses a fresh module instance rather than an unlock path, so
 * there is no production code shaped like a way out.
 */
export function armLockdown(): void {
  lockdownFlag = true;
}

export function isLockdownActive(): boolean {
  return lockdownFlag;
}

/**
 * Does a restricted mode forbid this plugin from running?
 *
 * One predicate for both modes, because the *rule* is identical — only core
 * plugins survive — while the flags stay separate. `startOne` and `enable` both
 * go through here, so there is one place where a non-core plugin can be refused
 * and no path around it.
 */
function restrictedModeBlocks(id: string): boolean {
  if (corePluginIds().has(id)) return false;
  return safeModeFlag || lockdownFlag;
}

/**
 * The core set, from the one shared definition.
 *
 * Kept as a local decision rather than an IPC round-trip on purpose: a renderer
 * that cannot reach main must still be able to refuse to start a non-core
 * plugin, so the check stays on this side and fails closed. What is *data* —
 * which ids are core — is no longer duplicated, because it comes from
 * `src/security/corePlugins.ts`, which every realm bundles. Main remains
 * authoritative for the network half.
 */
function corePluginIds(): Set<string> {
  return corePluginIdSet();
}

export function definePlugin(def: PluginDefinition): PluginDefinition {
  assertPluginId(def.id);
  if (byId.has(def.id)) {
    throw new Error(`Plugin id "${def.id}" is already registered`);
  }
  // Validate at registration, not at first use. A malformed permission
  // declaration is a programming error and must fail loudly during development
  // rather than silently degrading to "no permissions" in production.
  const normalized = validatePluginPermissions(def.id, def.permissions);
  const definition: PluginDefinition = { ...def, permissions: normalized };
  byId.set(definition.id, { def: definition, started: false, ctx: undefined, state: "stopped", chain: Promise.resolve() });
  order.push(definition.id);
  return definition;
}

/**
 * Publish the plugin/permission manifest to the main process (Phase 3/9).
 *
 * Until this succeeds the broker denies everything, because it has no entry for
 * any plugin id. That ordering is deliberate: registering the manifest is what
 * *grants* access, so a renderer that fails to boot never accidentally has it.
 *
 * Syncord's own first-party integrations would be added to `CORE_IDENTITIES`
 * here rather than being special-cased in main, so the policy keeps a single
 * source of truth and a single place to review. It is currently empty: no
 * built-in integration makes a request of its own, so every identity below
 * belongs to a plugin.
 */
const CORE_IDENTITIES: SyncordPluginManifestEntry[] = [];

export async function registerSecurityManifest(): Promise<void> {
  const bridge = getSecurityBridge();
  if (bridge === undefined) {
    log.warn("Security bridge unavailable — network broker will deny all requests");
    return;
  }
  const entries: SyncordPluginManifestEntry[] = [...CORE_IDENTITIES];
  for (const id of order) {
    const def = byId.get(id)?.def;
    if (def === undefined) continue;
    entries.push({
      id: def.id,
      network: (def.permissions?.network ?? []).map((rule) => ({
        host: rule.host,
        ...(rule.methods ? { methods: rule.methods } : {}),
        ...(rule.paths ? { paths: rule.paths } : {}),
      })),
      webhookSend: def.permissions?.webhookSend === true,
    });
  }
  try {
    const result = await bridge.registerManifest(entries);
    log.info(`Security manifest registered (${result.accepted} identities)`);
  } catch (err) {
    // Fail closed: if the manifest cannot be published, nothing gets network
    // access. Surfacing the error beats silently degrading.
    log.error("Failed to register the security manifest:", err);
  }
}

/**
 * Append an operation to this plugin's chain and wait for it to run.
 *
 * The chain is the whole mechanism: operations are queued, never interleaved, so
 * `enable` during a start and `disable` during a start both produce a defined
 * final state instead of a race. A failing operation must not break the chain for
 * the operations behind it, hence the `.catch` on the tail rather than on the
 * operation itself.
 */
function enqueue(rt: Runtime, op: () => Promise<void>): Promise<void> {
  rt.chain = rt.chain.then(op, op).catch(() => {
    /* startOne/stopOne handle their own failures; this only keeps the chain alive */
  });
  return rt.chain;
}

function startOne(rt: Runtime): Promise<void> {
  return enqueue(rt, async () => {
    if (rt.state === "started" || rt.state === "starting") return;
    if (rt.state === "stopping") return; // the queued stop will finish first
    if (restrictedModeBlocks(rt.def.id)) {
      log.info(`Skip ${rt.def.id} (restricted mode)`);
      return;
    }
    if (!isEnabled(rt.def)) {
      log.info(`Skip ${rt.def.id} (disabled)`);
      return;
    }

    const ctx = createPluginContext(rt.def) as PluginContextInternal;
    rt.ctx = ctx;
    rt.state = "starting";

    try {
      await rt.def.start(ctx);
      rt.state = "started";
      rt.started = true;
      log.info(`Started ${rt.def.id}`);
    } catch (err) {
      // Disposers run even on a failed start: a plugin that patched something
      // and then threw has still left the patch in place.
      log.error(`Failed to start ${rt.def.id}:`, err);
      try {
        ctx._disposeAll();
      } catch {
        /* the plugin may not have got as far as registering any */
      }
      rt.ctx = undefined;
      // Back to `stopped`, not `starting`, so a later enable can retry.
      rt.state = "stopped";
      rt.started = false;
    }
  });
}

function stopOne(rt: Runtime): Promise<void> {
  return enqueue(rt, async () => {
    // `stopping` is deliberately *not* treated as "not running". A stop queued
    // behind a start must still run, and the start may have installed
    // disposers by the time it resolves.
    if (rt.state === "stopped") return;

    rt.state = "stopping";
    const ctx = rt.ctx;
    try {
      // Disposers first (patches/css) so stop() sees a clean world.
      ctx?._disposeAll();
      if (ctx && rt.def.stop) {
        await rt.def.stop(ctx);
      }
      log.info(`Stopped ${rt.def.id}`);
    } catch (err) {
      log.error(`Failed to stop ${rt.def.id}:`, err);
    } finally {
      rt.ctx = undefined;
      rt.started = false;
      rt.state = "stopped";
    }
  });
}

/** Start every enabled plugin (call after common modules are ready). */
export async function startAll(): Promise<void> {
  const safeMode = safeModeActive();
  const core = corePluginIds();
  const kept: string[] = [];
  const skipped: string[] = [];

  for (const id of order) {
    const rt = byId.get(id);
    if (rt === undefined) continue;
    if (safeMode && !core.has(id)) {
      skipped.push(id);
      continue;
    }
    if (safeMode) kept.push(id);
    await startOne(rt);
  }

  if (safeMode) {
    log.warn(`Safe Mode: ${kept.length} core plugin(s) started, ${skipped.length} disabled`);
    window.dispatchEvent(
      new CustomEvent("Syncord-safe-mode-applied", {
        detail: { kept, skipped },
      }),
    );
  }
}

/**
 * Stop every running non-core plugin, leaving core plugins alone.
 *
 * This is the "controlled stop" half of Emergency Lockdown. Main already cut the
 * network and dropped the credentials, but a plugin that patched a store method
 * or injected CSS was still running and still changing the page — the visible
 * half of the damage lockdown is meant to stop.
 *
 * Core plugins keep running on purpose: message logging and the settings/security
 * UI are how the user reads the audit log and turns lockdown off. Stopping those
 * would remove the recovery path at the moment it is needed.
 *
 * Disposers run before `stop()` (see `stopOne`), so patches and injected styles
 * are undone before the plugin's own teardown sees the page.
 */
export async function stopNonCore(): Promise<{ stopped: string[]; kept: string[] }> {
  const core = corePluginIds();
  const stopped: string[] = [];
  const kept: string[] = [];

  for (let i = order.length - 1; i >= 0; i -= 1) {
    const id = order[i]!;
    if (core.has(id)) {
      if (byId.get(id)?.state === "started") kept.push(id);
      continue;
    }
    const rt = byId.get(id);
    // `state !== "stopped"`, not `rt.started`. A plugin whose `start()` is still
    // in flight has `started === false` but is *about to* be running, and
    // skipping it would leave a non-core plugin live after lockdown — precisely
    // the window an emergency stop is pressed in. The queued stop runs once the
    // start settles, so the plugin ends up stopped rather than never-stopped.
    if (rt === undefined || rt.state === "stopped") continue;
    await stopOne(rt);
    stopped.push(id);
  }

  if (stopped.length > 0) {
    log.warn(`Lockdown: stopped ${stopped.length} non-core plugin(s) (${stopped.join(", ")})`);
  }
  return { stopped, kept };
}

export async function stopAll(): Promise<void> {
  for (let i = order.length - 1; i >= 0; i--) {
    const rt = byId.get(order[i]!);
    if (rt) await stopOne(rt);
  }
}

export async function enable(id: string): Promise<void> {
  const rt = byId.get(id);
  if (!rt) throw new Error(`Unknown plugin "${id}"`);
  // Safe Mode is a filter, not a one-time gate.
  //
  // `startAll()` skips non-core plugins while Safe Mode is on, but `enable()`
  // did not check, so anything holding a reference to the manager — the settings
  // UI, a plugin, or page code reaching `window.Syncord` — could start a
  // non-core plugin anyway. Safe Mode is what a user reaches for when a plugin
  // is misbehaving; it has to hold until they turn it off.
  if (restrictedModeBlocks(id)) {
    log.warn(`Restricted mode: refusing to start non-core plugin "${id}"`);
    return;
  }
  settings.set(enabledKey(id), true);
  await startOne(rt);
}

export async function disable(id: string): Promise<void> {
  const rt = byId.get(id);
  if (!rt) throw new Error(`Unknown plugin "${id}"`);
  settings.set(enabledKey(id), false);
  await stopOne(rt);
}

export function get(id: string): PluginPublicInfo | undefined {
  const rt = byId.get(id);
  if (!rt) return undefined;
  return toPublic(rt);
}

export function list(): PluginPublicInfo[] {
  const out: PluginPublicInfo[] = [];
  for (const id of order) {
    const rt = byId.get(id);
    if (rt) out.push(toPublic(rt));
  }
  return out;
}

function toPublic(rt: Runtime): PluginPublicInfo {
  const { def } = rt;
  return {
    id: def.id,
    name: localizeKnown(def.name),
    description: def.description ? localizeKnown(def.description) : undefined,
    author: def.author,
    enabledByDefault: def.enabledByDefault,
    restartOnDisable: def.restartOnDisable,
    permissions: def.permissions,
    core: def.core,
    permissionSummary: localizeKnown(summarizePermissions(def.permissions ?? {})),
    enabled: isEnabled(def),
    started: rt.state === "started",
  };
}

/** @deprecated Use definePlugin from this module. Kept via index re-export. */
export function scheduleStartAll(): void {
  log.warn("scheduleStartAll is obsolete — boot calls startAll after common");
}
