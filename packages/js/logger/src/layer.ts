import { Context, Data, Effect, Layer } from "effect";
import type { DestinationStream } from "pino";

import type { Context as LogContext, Logger } from "./index.ts";
import { flushLogger, initLogger } from "./service.ts";
import { singleCallbackLogger } from "./simple.ts";

/** Environment the Pino adapter reads at layer build (same shape `initLogger` takes). */
export type LoggerEnv = Partial<Record<"LOG_LEVEL" | "PRETTY_LOGS" | "NODE_ENV", string>>;

/** Raised when the Pino logger cannot be built (e.g. `LOG_LEVEL` is missing). */
export class LoggerInitError extends Data.TaggedError("LoggerInitError")<{
  readonly cause: unknown;
}> {}

/**
 * The Effect-shaped logging service behind {@link LoggerTag}. Same surface as the
 * sync `Logger` interface, with each method lifted into the Effect world.
 */
export interface LoggerService {
  readonly trace: (context: LogContext, message: string) => Effect.Effect<void>;
  readonly debug: (context: LogContext, message: string) => Effect.Effect<void>;
  readonly info: (context: LogContext, message: string) => Effect.Effect<void>;
  readonly warn: (context: LogContext, message: string) => Effect.Effect<void>;
  readonly error: (context: LogContext, message: string) => Effect.Effect<void>;
  readonly child: (context: LogContext) => Effect.Effect<LoggerService>;
}

/** Service tag for the logger. Yield it to log: `const log = yield* LoggerTag`. */
export class LoggerTag extends Context.Tag("Logger")<LoggerTag, LoggerService>() {}

/**
 * Lift any sync `Logger` (Pino, the callback stub, an app's own adapter) into the
 * Effect service shape. Both layers below reuse the existing implementations
 * through this bridge — nothing is duplicated.
 */
export const fromSyncLogger = (logger: Logger): LoggerService => ({
  trace: (context, message) => Effect.sync(() => logger.trace(context, message)),
  debug: (context, message) => Effect.sync(() => logger.debug(context, message)),
  info: (context, message) => Effect.sync(() => logger.info(context, message)),
  warn: (context, message) => Effect.sync(() => logger.warn(context, message)),
  error: (context, message) => Effect.sync(() => logger.error(context, message)),
  child: (context) => Effect.sync(() => fromSyncLogger(logger.child(context))),
});

/**
 * Live Pino layer. Builds the logger with the existing `initLogger` (preserving the
 * `traceContextMixin` trace/span stamping exactly) and registers `flushLogger` as a
 * scope finalizer. A missing `LOG_LEVEL` surfaces as `LoggerInitError` in the error
 * channel at layer build. Flush failures are ignored — teardown is best-effort,
 * observability must never break shutdown.
 */
export const LoggerLive = (
  name: string,
  env: LoggerEnv = process.env,
  opts?: { stream?: DestinationStream },
): Layer.Layer<LoggerTag, LoggerInitError> =>
  Layer.scoped(
    LoggerTag,
    Effect.gen(function* () {
      const pinoLogger = yield* Effect.try({
        try: () => initLogger(env, name, opts),
        catch: (cause) => new LoggerInitError({ cause }),
      });
      yield* Effect.addFinalizer(() =>
        Effect.ignore(Effect.tryPromise(() => flushLogger(pinoLogger))),
      );
      return fromSyncLogger(pinoLogger);
    }),
  );

/**
 * Test layer over the existing `singleCallbackLogger` stub: every log record is
 * delivered to `cb` as a flat object (context + `level` + `message`).
 */
export const LoggerTest = (cb: (obj: Record<string, unknown>) => void): Layer.Layer<LoggerTag> =>
  Layer.succeed(LoggerTag, fromSyncLogger(singleCallbackLogger(cb)));
