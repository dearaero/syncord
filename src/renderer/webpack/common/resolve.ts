import { createLogger } from "../../api/logger";
import { find, findByProps, findByStoreName } from "../index";

const log = createLogger("common");

/** Discord modules are opaque; plugins use known method names at runtime. */
export type ModuleRef = Record<string, unknown> | undefined;

const found: string[] = [];
const missing: string[] = [];

export function drainStatus(): { found: string[]; missing: string[] } {
  const result = { found: [...found], missing: [...missing] };
  found.length = 0;
  missing.length = 0;
  return result;
}

export function resolveStore(
  label: string,
  storeName: string,
  aliases: string[] = [],
): ModuleRef {
  for (const name of [storeName, ...aliases]) {
    try {
      const mod = findByStoreName(name) as ModuleRef;
      if (mod) {
        found.push(label);
        return mod;
      }
    } catch (err) {
      log.error(`store ${label}:`, err);
    }
  }
  missing.push(label);
  return undefined;
}

export function resolveProps(label: string, ...props: string[]): ModuleRef {
  try {
    const mod = findByProps(...props) as ModuleRef;
    if (mod) {
      found.push(label);
      return mod;
    }
  } catch (err) {
    log.error(`props ${label}:`, err);
  }
  missing.push(label);
  return undefined;
}

export function resolveFilter(
  label: string,
  filter: (m: unknown) => boolean,
): ModuleRef {
  try {
    const mod = find(filter) as ModuleRef;
    if (mod) {
      found.push(label);
      return mod;
    }
  } catch (err) {
    log.error(`filter ${label}:`, err);
  }
  missing.push(label);
  return undefined;
}
