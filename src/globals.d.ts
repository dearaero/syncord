/**
 * Sources are bundled to CommonJS for Electron injection.
 * These globals exist at runtime in main/preload.
 */
declare var __dirname: string;
declare var require: NodeJS.Require;

import type { SyncordApi } from "./renderer/api/types";
import type { SyncordNativeApi } from "./shared/native";

declare global {
  interface Window {
    Syncord: SyncordApi;
    SyncordNative?: SyncordNativeApi;
  }
}

export {};
