export type Context = Record<string, unknown>;

// The sync logger shape. Stays exported: it is the shape Pino and the callback stub
// implement, and what `fromSyncLogger` lifts into the Effect service.
export interface Logger {
  trace(context: Context, message: string): void;
  debug(context: Context, message: string): void;
  info(context: Context, message: string): void;
  warn(context: Context, message: string): void;
  error(context: Context, message: string): void;
  child(context: Context): Logger;
}

// Effect surface — the tag, layers, error, and the sync-to-Effect bridge.
export { fromSyncLogger, LoggerInitError, LoggerLive, LoggerTag, LoggerTest } from "./layer.ts";
export type { LoggerEnv, LoggerService } from "./layer.ts";
