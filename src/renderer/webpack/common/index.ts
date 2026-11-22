import { createLogger } from "../../api/logger";
import { resolveActions, type CommonActions } from "./actions";
import { resolveFlux, type CommonFlux } from "./flux";
import { resolveReact, type CommonReact } from "./react";
import { drainStatus } from "./resolve";
import { resolveStores, type CommonStores } from "./stores";
import { resolveUtils, type CommonUtils } from "./utils";

const log = createLogger("common");

export type CommonModules = {
  /** Discord's React instance (not npm react). */
  react: CommonReact;
  /** Flux + dispatcher. */
  flux: CommonFlux;
  /** Named Flux stores. */
  stores: CommonStores;
  /** Action creators / managers. */
  actions: CommonActions;
  /** Misc shared helpers. */
  utils: CommonUtils;
  /** Resolve report from last initCommon(). */
  status: {
    found: string[];
    missing: string[];
  };
};

let _common: CommonModules | undefined;

/**
 * Resolve all common modules once webpack is ready.
 * Safe to call multiple times — re-resolves and replaces the snapshot.
 */
export function initCommon(): CommonModules {
  drainStatus();

  const react = resolveReact();
  const flux = resolveFlux();
  const stores = resolveStores();
  const actions = resolveActions();
  const utils = resolveUtils();
  const status = drainStatus();

  _common = { react, flux, stores, actions, utils, status };

  log.info(
    `resolved ${status.found.length} modules` +
      (status.missing.length
        ? `, missing ${status.missing.length}: ${status.missing.join(", ")}`
        : ""),
  );

  return _common;
}

export function getCommon(): CommonModules | undefined {
  return _common;
}

export const common = {
  init: initCommon,
  get: getCommon,
};

export type { CommonStores, CommonReact, CommonFlux, CommonActions, CommonUtils };
