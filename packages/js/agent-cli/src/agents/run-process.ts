import { Command, type CommandExecutor, type HttpClient } from "@effect/platform";
import { Duration, Effect, Stream } from "effect";

import type { Logger } from "../lib/logger.ts";
import { appendStreamEventsFromChunk, buildInvocationResult } from "./parse-stream.ts";
import { commandExists } from "./shared.ts";
import type {
  AgentInvocationRequest,
  AgentStrategy,
  InvocationResult,
  LiteLlmError,
  PreparedAgentInvocation,
  StreamEvent,
} from "./types.ts";
import { AgentSpawnError, AgentTimeoutError } from "./types.ts";

/**
 * Run an agent CLI subprocess. The subprocess is started with `Command.start`
 * inside a `Scope`, so interruption (e.g. the timeout) kills the process via
 * the scope finalizer — replacing the legacy `setTimeout` + `kill`
 * bookkeeping. Stdout is decoded and split into lines by
 * the stream pipeline (`Stream.decodeText` → `Stream.splitLines` subsumes the
 * legacy partial-line buffer and close-time flush), and `onEvent` fires
 * incrementally as lines arrive because the stdout pipeline runs concurrently
 * with the exit wait.
 *
 * Failure channel: `AgentTimeoutError` / `AgentSpawnError` are internal — the
 * invoker layer maps them back to the exit-124 / exit-1 structured results the
 * legacy implementation resolved with. LiteLLM errors (from
 * `buildInvocationEffect`) propagate, matching the legacy throw.
 */
export function runAgentProcessEffect(
  strategy: AgentStrategy,
  request: AgentInvocationRequest,
  log: Logger,
): Effect.Effect<
  InvocationResult,
  AgentSpawnError | AgentTimeoutError | LiteLlmError,
  CommandExecutor.CommandExecutor | HttpClient.HttpClient
> {
  return Effect.gen(function* () {
    const envOverrides = strategy.prepareEnvironment?.(request);

    const effectiveEnv = envOverrides
      ? { ...request.effectiveEnv, ...envOverrides }
      : request.effectiveEnv;
    const envError = strategy.validateEnvironment(effectiveEnv, process.env);
    if (envError) {
      return envError;
    }

    const prepared = strategy.buildInvocationEffect
      ? yield* strategy.buildInvocationEffect(request)
      : // The strategy contract requires at least one of the two build methods.
        yield* Effect.promise(() => strategy.buildInvocation!(request));

    // The strategy may have written temp artifacts (e.g. the `--file` task file)
    // in buildInvocation; guarantee its teardown runs on every exit path below —
    // success, failure, timeout, interruption, or an early command-not-found return.
    const runInvocation = runPreparedInvocation(strategy, request, prepared, envOverrides, log);
    return yield* prepared.cleanup
      ? runInvocation.pipe(
          Effect.ensuring(Effect.promise(async () => prepared.cleanup!()).pipe(Effect.ignore)),
        )
      : runInvocation;
  });
}

/**
 * The subprocess run itself, split out so {@link runAgentProcessEffect} can wrap
 * it in a cleanup finalizer that fires regardless of how it terminates.
 */
function runPreparedInvocation(
  strategy: AgentStrategy,
  request: AgentInvocationRequest,
  prepared: PreparedAgentInvocation,
  envOverrides: Record<string, string> | undefined,
  log: Logger,
): Effect.Effect<
  InvocationResult,
  AgentSpawnError | AgentTimeoutError,
  CommandExecutor.CommandExecutor
> {
  return Effect.gen(function* () {
    const found = yield* Effect.sync(() => commandExists(prepared.command));
    if (!found) {
      log.error(`Command not found: ${prepared.command}`);
      return {
        success: false,
        stdout: `Command not found: ${prepared.command}. Ensure the CLI is installed and in PATH.`,
        stderr: `Command '${prepared.command}' not found`,
        exitCode: 127,
      };
    }

    if (strategy.ensureReady) {
      const setupResult = yield* Effect.promise(() => strategy.ensureReady!(request, log));
      if (setupResult) {
        return setupResult;
      }
    }

    const childEnv = envOverrides ? { ...request.env, ...envOverrides } : request.env;

    const streamEvents: StreamEvent[] = [];
    let stderrText = "";
    const startTime = Date.now();

    log.debug(`Spawning ${strategy.name} in: ${request.cwd}`);
    log.debug(`Command: ${prepared.command} ${prepared.args.join(" ")}`);

    // splitLines already delivers whole lines (partial-line carryover and the
    // trailing flush included), so each line is handed to the existing pure
    // per-line parsers as a self-contained chunk.
    const handleLine = (line: string): void => {
      if (prepared.streamParser) {
        prepared.streamParser.parseChunk("", `${line}\n`, streamEvents, request.onEvent);
      } else {
        appendStreamEventsFromChunk({
          buffer: "",
          chunk: `${line}\n`,
          events: streamEvents,
          onEvent: request.onEvent,
          shouldFilterEvent: prepared.shouldFilterEvent,
        });
      }
    };

    const command = Command.make(prepared.command, ...prepared.args).pipe(
      Command.workingDirectory(request.cwd),
      Command.env(childEnv),
      // Feeding the (possibly empty) stdin input writes it and closes the
      // child's stdin — the equivalent of the legacy write-then-end / end.
      Command.feed(prepared.stdinInput ?? ""),
    );

    const runProcess = Effect.scoped(
      Effect.gen(function* () {
        const proc = yield* Command.start(command);

        const awaitExit = proc.exitCode.pipe(
          Effect.map((code) => ({ exitCode: code as number | null, signal: null })),
          // The executor fails `exitCode` when the child was killed by a
          // signal; the legacy contract reports that as a signal exit.
          Effect.catchAll((error) =>
            Effect.succeed({ exitCode: null, signal: extractSignal(error) }),
          ),
        );

        const drainStdout = proc.stdout.pipe(
          Stream.tap((bytes) => Effect.sync(() => process.stdout.write(bytes))),
          Stream.decodeText("utf-8"),
          Stream.splitLines,
          Stream.runForEach((line) => Effect.sync(() => handleLine(line))),
        );

        const drainStderr = proc.stderr.pipe(
          Stream.tap((bytes) => Effect.sync(() => process.stderr.write(bytes))),
          Stream.decodeText("utf-8"),
          Stream.runForEach((chunk) =>
            Effect.sync(() => {
              stderrText += chunk;
            }),
          ),
        );

        const [exit] = yield* Effect.all([awaitExit, drainStdout, drainStderr], {
          concurrency: 3,
        });
        return exit;
      }),
    ).pipe(Effect.mapError((cause) => new AgentSpawnError({ command: prepared.command, cause })));

    const timedProcess =
      request.timeout > 0
        ? runProcess.pipe(
            Effect.timeoutFail({
              duration: Duration.millis(request.timeout),
              onTimeout: () => new AgentTimeoutError({ timeoutMs: request.timeout }),
            }),
          )
        : runProcess;

    const { exitCode, signal } = yield* timedProcess;

    const durationMs = Date.now() - startTime;
    log.debug(`${strategy.name} exited (code=${exitCode}, signal=${signal}, ms=${durationMs})`);

    return buildInvocationResult({
      events: streamEvents,
      stderr: stderrText,
      exitCode,
      signal,
      sessionId: strategy.extractSessionId(streamEvents),
      metrics: strategy.extractMetrics(streamEvents, request),
    });
  });
}

function extractSignal(error: unknown): NodeJS.Signals | null {
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error);
  const match = message.match(/signal:\s*(\w+)/);
  return (match?.[1] as NodeJS.Signals | undefined) ?? null;
}
