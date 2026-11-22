import { settings } from "../settings";

export type SettingType = "boolean" | "string" | "number";

export type SettingDef<T = unknown> = {
  type: SettingType;
  default: T;
  description?: string;
  /** Optional UI title; falls back to key. */
  title?: string;
};

export type SettingsSchema = Record<string, SettingDef>;

type InferDef<D> = D extends SettingDef<infer T> ? T : never;

export type InferredStore<S extends SettingsSchema> = {
  [K in keyof S]: InferDef<S[K]>;
};

/**
 * Typed plugin settings schema. Values live under
 * `plugins.<pluginId>.data.<key>` — call `bind(pluginId)` from start().
 */
export function definePluginSettings<S extends SettingsSchema>(schema: S) {
  const keys = Object.keys(schema) as (keyof S & string)[];

  function dataKey(pluginId: string, key: string): string {
    return `plugins.${pluginId}.data.${key}`;
  }

  function read<K extends keyof S & string>(
    pluginId: string,
    key: K,
  ): InferDef<S[K]> {
    const def = schema[key]!;
    const raw = settings.get(dataKey(pluginId, key), def.default);
    return raw as InferDef<S[K]>;
  }

  function write<K extends keyof S & string>(
    pluginId: string,
    key: K,
    value: InferDef<S[K]>,
  ): void {
    const def = schema[key]!;
    if (def.type === "boolean" && typeof value !== "boolean") return;
    if (def.type === "string" && typeof value !== "string") return;
    if (def.type === "number" && typeof value !== "number") return;
    settings.set(dataKey(pluginId, key), value);
  }

  return {
    schema,
    keys,
    bind(pluginId: string) {
      const store = {} as InferredStore<S>;

      for (const key of keys) {
        Object.defineProperty(store, key, {
          enumerable: true,
          configurable: true,
          get: () => read(pluginId, key),
          set: (v: InferDef<S[typeof key]>) => write(pluginId, key, v),
        });
      }

      return {
        schema,
        store,
        get: <K extends keyof S & string>(key: K) => read(pluginId, key),
        set: <K extends keyof S & string>(key: K, value: InferDef<S[K]>) =>
          write(pluginId, key, value),
        /** Snapshot for UI — plain object, no getters. */
        snapshot(): InferredStore<S> {
          const out = {} as InferredStore<S>;
          for (const key of keys) {
            out[key] = read(pluginId, key);
          }
          return out;
        },
      };
    },
  };
}

export type PluginSettingsHandle<S extends SettingsSchema> = ReturnType<
  ReturnType<typeof definePluginSettings<S>>["bind"]
>;
