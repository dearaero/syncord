type AnyFn = (...args: unknown[]) => unknown;

type HookKind = "before" | "after" | "instead" | "around";

type HookEntry = {
  id: symbol;
  kind: HookKind;
  hook: AnyFn;
};

type MethodChain = {
  original: AnyFn;
  hooks: HookEntry[];
  wrapper: AnyFn;
};

/**
 * WeakMap: chains vanish with the target object.
 * `liveTargets` only retains objects that currently have hooks (cleared on last unpatch).
 */
const chains = new WeakMap<object, Map<string, MethodChain>>();
const liveTargets = new Set<object>();

function getChainMap(object: object): Map<string, MethodChain> {
  let map = chains.get(object);
  if (!map) {
    map = new Map();
    chains.set(object, map);
  }
  return map;
}

function buildWrapper(chain: MethodChain): AnyFn {
  const { original, hooks } = chain;

  const arounds=hooks.filter(h=>h.kind === "around");
  const core = function patched(this: unknown, ...args: unknown[]) {
    const befores: HookEntry[] = [];
    const afters: HookEntry[] = [];
    let instead: HookEntry | undefined;

    for (let i = 0; i < hooks.length; i++) {
      const h = hooks[i]!;
      if (h.kind === "before") befores.push(h);
      else if (h.kind === "after") afters.push(h);
      else if(h.kind === "instead") instead = h;
    }

    for (let i = 0; i < befores.length; i++) {
      try {
        (befores[i]!.hook as (args: unknown[]) => void).call(this, args);
      } catch {
        /* isolate */
      }
    }

    let result: unknown;
    if (instead) {
      try {
        result = (
          instead.hook as (args: unknown[], original: AnyFn) => unknown
        ).call(this, args, original.bind(this));
      } catch {
        result = original.apply(this, args);
      }
    } else {
      result = original.apply(this, args);
    }

    for (let i = 0; i < afters.length; i++) {
      try {
        const next = (
          afters[i]!.hook as (args: unknown[], result: unknown) => unknown
        ).call(this, args, result);
        if (next !== undefined) result = next;
      } catch {
        /* isolate */
      }
    }

    return result;
  };
  if(!arounds.length)return core;
  return function(this:unknown,...args:unknown[]) {
    const invoke=(index:number,nextArgs:unknown[]):unknown=>{
      const entry=arounds[index];if(!entry)return core.apply(this,nextArgs);
      return (entry.hook as (args:unknown[],next:AnyFn)=>unknown).call(this,nextArgs,(...values)=>invoke(index+1,values));
    };
    return invoke(0,args);
  };
}

function ensureInstalled(
  object: object,
  method: string,
  chain: MethodChain,
): void {
  chain.wrapper = buildWrapper(chain);
  (object as Record<string, unknown>)[method] = chain.wrapper;
  if((object as Record<string,unknown>)[method]!==chain.wrapper)throw new TypeError(`patcher: ${method} cannot be replaced`);
  liveTargets.add(object);
}

function addHook(
  object: object,
  method: string,
  kind: HookKind,
  hook: AnyFn,
): () => void {
  const target = object as Record<string, unknown>;
  const current = target[method];
  const map = getChainMap(object);
  let chain = map.get(method);

  if (!chain) {
    if (typeof current !== "function") {
      throw new TypeError(`patcher: ${method} is not a function`);
    }
    chain = {
      original: current as AnyFn,
      hooks: [],
      wrapper: current as AnyFn,
    };
    map.set(method, chain);
  }

  const entry: HookEntry = { id: Symbol(kind), kind, hook };
  chain.hooks.push(entry);
  try {ensureInstalled(object, method, chain);} catch(error) {
    chain.hooks.splice(chain.hooks.indexOf(entry),1);
    if(!chain.hooks.length){map.delete(method);if(!map.size){chains.delete(object);liveTargets.delete(object);}}
    throw error;
  }

  let active = true;
  return () => {
    if (!active) return;
    active = false;

    const c = map.get(method);
    if (!c) return;

    const idx = c.hooks.findIndex((h) => h.id === entry.id);
    if (idx !== -1) c.hooks.splice(idx, 1);

    if (c.hooks.length === 0) {
      target[method] = c.original;
      map.delete(method);
      if (map.size === 0) {
        chains.delete(object);
        liveTargets.delete(object);
      }
      return;
    }

    ensureInstalled(object, method, c);
  };
}

export function before(
  object: object,
  method: string,
  hook: (args: unknown[]) => void,
): () => void {
  return addHook(object, method, "before", hook as AnyFn);
}

export function after(
  object: object,
  method: string,
  hook: (args: unknown[], result: unknown) => unknown,
): () => void {
  return addHook(object, method, "after", hook as AnyFn);
}

export function instead(
  object: object,
  method: string,
  hook: (args: unknown[], original: AnyFn) => unknown,
): () => void {
  return addHook(object, method, "instead", hook as AnyFn);
}

/** Internal transaction wrapper: composes with existing before/after/instead hooks. */
export function around(object:object,method:string,hook:(args:unknown[],next:AnyFn)=>unknown):()=>void {
  return addHook(object,method,"around",hook as AnyFn);
}

/** Restore every live patch to the true original (emergency / shutdown). */
export function unpatchAll(): void {
  for (const object of [...liveTargets]) {
    const map = chains.get(object);
    if (!map) {
      liveTargets.delete(object);
      continue;
    }
    for (const [method, chain] of map) {
      (object as Record<string, unknown>)[method] = chain.original;
    }
    map.clear();
    chains.delete(object);
    liveTargets.delete(object);
  }
}

export const patcher = { before, after, instead, unpatchAll };
