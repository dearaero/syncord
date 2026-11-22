import { type ModuleRef, resolveProps } from "./resolve";

export type CommonFlux = {
  Flux: ModuleRef;
  FluxDispatcher: ModuleRef;
  ComponentDispatch: ModuleRef;
};

export function resolveFlux(): CommonFlux {
  return {
    Flux: resolveProps("flux.Flux", "connectStores"),
    FluxDispatcher: resolveProps(
      "flux.FluxDispatcher",
      "dispatch",
      "subscribe",
    ),
    ComponentDispatch: resolveProps(
      "flux.ComponentDispatch",
      "dispatchToLastSubscribed",
    ),
  };
}
