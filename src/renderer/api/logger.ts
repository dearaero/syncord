import { LOG_PREFIX } from "../../shared/constants";

type LogFn = (...args: unknown[]) => void;

function tagged(level: "log" | "info" | "warn" | "error", tag: string): LogFn {
  const prefix = `${LOG_PREFIX}:${tag}`;
  return (...args: unknown[]) => {
    // Avoid retaining args beyond the call — console owns the print.
    console[level](prefix, ...args);
  };
}

export type Logger = {
  log: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
};

export function createLogger(tag: string): Logger {
  return {
    log: tagged("log", tag),
    info: tagged("info", tag),
    warn: tagged("warn", tag),
    error: tagged("error", tag),
  };
}

export const logger = createLogger("core");
