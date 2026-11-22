import { type ModuleRef, resolveProps } from "./resolve";

export type CommonReact = {
  React: ModuleRef;
  ReactDOM: ModuleRef;
};

export function resolveReact(): CommonReact {
  return {
    React: resolveProps("react.React", "createElement", "useEffect"),
    ReactDOM: resolveProps("react.ReactDOM", "createPortal"),
  };
}
