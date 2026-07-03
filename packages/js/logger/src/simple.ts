import type { Context, Logger } from "./index.ts";

export function singleCallbackLogger(cb: (obj: Record<string, unknown>) => void): Logger {
  return {
    trace(context: Context, message: string) {
      cb({ ...context, level: "trace", message });
    },
    debug(context: Context, message: string) {
      cb({ ...context, level: "debug", message });
    },
    info(context: Context, message: string) {
      cb({ ...context, level: "info", message });
    },
    warn(context: Context, message: string) {
      cb({ ...context, level: "warn", message });
    },
    error(context: Context, message: string) {
      cb({ ...context, level: "error", message });
    },
    child(context: Context): Logger {
      return singleCallbackLogger((obj) => cb({ ...context, ...obj }));
    },
  };
}
