import { Command, type CommandExecutor, type HttpClient } from "@effect/platform";
import { Duration, Effect, Stream } from "effect";

import { buildInvocationResult, parseStreamLine } from "./parse-stream.ts";
import { killRunGroup, registerLiveRun, unregisterLiveRun } from "./reaper.ts";
import type {
  AgentInvocationRequest,
  AgentStrategy,
  InvocationResult,
  LiteLlmError,
  PreparedAgentInvocation,
  StreamEvent,
} from "./types.ts";
import { AgentSpawnError, AgentTimeoutError } from "./types.ts";

/** Run an agent CLI subprocess inside a `Scope` so interruption kills the process
 * via the scope finalizer. Stdout is decoded and split into lines by the stream
 * pipeline; `onEvent` fires incrementally as lines arrive.
 *
 * Failure channel: `AgentTimeoutError` / `AgentSpawnError` are internal — the
 * invoker layer maps them back to exit-124 / exit-1 structured results. */
export function runAgentProcessEffect(
  strategy: AgentStrategy,
  request: AgentInvocationRequest,
): Effect.Effect<
  InvocationResult,
  AgentSpawnError | LiteLlmError,
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

    const prepared = yield* strategy.buildInvocation(request);

    // Guarantee the strategy's cleanup runs on every exit path — success, failure,
    // timeout, interruption, or early command-not-found return.
    const runInvocation = runPreparedInvocation(strategy, request, prepared, envOverrides);
    return yield* prepared.cleanup
      ? runInvocation.pipe(
          Effect.ensuring(
            Effect.promise(() => Promise.resolve(prepared.cleanup!())).pipe(Effect.ignore),
          ),
        )
      : runInvocation;
  });
}

/**
 * Isolate a dropped-uid sub-agent's bun cache (docs/plans/impl/agent-process-identity.md). When the
 * untrusted CLI runs as `SUB_AGENT_UID` via sudo, its `bun install` (e.g. a verify step) must NOT
 * write a bun cache SHARED with a different uid: under `fs.protected_hardlinks=1` the other uid
 * (the agent-server, or the host user) then can't hardlink those entries, and bun silently leaves
 * 0-byte stubs that break the whole native toolchain (this is exactly what poisoned the host
 * `~/.bun` during the privilege-drop's own validation — see the `Toolchain guard` gotcha in
 * CLAUDE.md). Point the cache at a per-uid dir the sub-agent OWNS, so it hardlinks from its own
 * cache and can never poison a shared one. Pure so it is unit-tested without spawning.
 *
 * - Only applies when a uid drop is active (`SUB_AGENT_UID` set) — local/host mode is untouched.
 * - An explicit `BUN_INSTALL_CACHE_DIR` (e.g. an ops-provisioned per-uid or group-writable cache)
 *   is respected and wins.
 * - `HOME` is deliberately left as-is: the CLI needs it to find its own config (`~/.claude`); only
 *   bun's cache is redirected.
 */
export function isolatedSubAgentEnv(
  env: Record<string, string>,
  subAgentUid: string | undefined,
): Record<string, string> {
  if (!subAgentUid || env.BUN_INSTALL_CACHE_DIR) return env;
  return { ...env, BUN_INSTALL_CACHE_DIR: `/tmp/bun-cache-uid-${subAgentUid}` };
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
): Effect.Effect<InvocationResult, AgentSpawnError, CommandExecutor.CommandExecutor> {
  return Effect.gen(function* () {
    const childEnv = envOverrides ? { ...request.env, ...envOverrides } : request.env;

    const streamEvents: StreamEvent[] = [];

    yield* Effect.logDebug(`Spawning ${strategy.name} in: ${request.cwd}`);
    yield* Effect.logDebug(`Command: ${prepared.command} ${prepared.args.join(" ")}`);

    // `Stream.splitLines` (below) delivers one complete line at a time, so the
    // parser never needs to buffer — it just consumes each line.
    const handleLine = (line: string): void => {
      if (prepared.streamParser) {
        prepared.streamParser.parseLine(line, streamEvents, request.onEvent);
      } else {
        parseStreamLine(line, streamEvents, request.onEvent, prepared.shouldFilterEvent);
      }
    };

    // Config-gated privilege drop (docs/plans/impl/agent-process-identity.md): when SUB_AGENT_UID is set
    // (container mode) the untrusted CLI runs as that lower-trust non-root user via sudo — a non-root
    // agent-server can't setuid on its own. Unset (local/host mode) → spawn directly as the current
    // user, the unchanged behaviour. --preserve-env carries spawnEnv to the CLI (the sudoers rule
    // grants SETENV); the server's working directory is inherited so the CLI runs in the run's cwd.
    // (Group leadership for reaping needs no wrapper: the platform executor spawns `detached`, so
    // the child already leads a fresh process group — see reaper.ts.)
    const subAgentUid = process.env.SUB_AGENT_UID;
    const execCommand = subAgentUid ? "sudo" : prepared.command;
    const execArgs = subAgentUid
      ? ["--preserve-env", "-u", `#${subAgentUid}`, "--", prepared.command, ...prepared.args]
      : prepared.args;

    // Isolate the sub-agent's bun cache so its installs can't poison a cache shared with a different
    // uid (the hollow-toolchain trap — see isolatedSubAgentEnv). No-op when no uid drop is active.
    const spawnEnv = isolatedSubAgentEnv(childEnv, subAgentUid);

    const command = Command.make(execCommand, ...execArgs).pipe(
      Command.workingDirectory(request.cwd),
      Command.env(spawnEnv),
      Command.feed(prepared.stdinInput ?? ""),
    );

    const runProcess = Effect.scoped(
      Effect.gen(function* () {
        const proc = yield* Command.start(command);

        // Register for shutdown reaping (app death runs no finalizers — the process-exit hook in
        // reaper.ts reaps live groups) + group-kill on every scope close: timeout interruption
        // AND normal completion (the platform's release skips cleanup on exit 0, so a background
        // child the CLI left running would linger), and as the dropped uid on the sudo path
        // (a kill from this uid reaches only sudo itself). Runs before the platform's own kill
        // (LIFO), which tolerates an already-gone leader.
        const live = registerLiveRun(proc.pid, subAgentUid);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            killRunGroup(live, "SIGTERM");
            unregisterLiveRun(live);
          }),
        );

        const awaitExit = proc.exitCode.pipe(
          Effect.map((code) => ({ exitCode: code as number | null, signal: null })),
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
          Stream.mkString,
        );

        const [exit, , stderrText] = yield* Effect.all([awaitExit, drainStdout, drainStderr], {
          concurrency: 3,
        });
        return { ...exit, stderrText };
      }),
    ).pipe(Effect.mapError((cause) => new AgentSpawnError({ command: prepared.command, cause })));

    // A timeout is handled HERE, where `streamEvents` is still in scope — the interruption kills
    // the child via the scope finalizer, and the result is built from the events collected so far
    // (partial usage, rate-limit retries) instead of a bare synthetic 124 that discards them
    // (docs/plans/cost-containment.md B1: two 30-minute runs billed their duration, ledgered zero).
    const timedProcess =
      request.timeout > 0
        ? runProcess.pipe(
            Effect.timeoutFail({
              duration: Duration.millis(request.timeout),
              onTimeout: () => new AgentTimeoutError({ timeoutMs: request.timeout }),
            }),
            Effect.catchTag("AgentTimeoutError", () =>
              Effect.succeed({
                exitCode: 124 as number | null,
                signal: null as NodeJS.Signals | null,
                stderrText: "",
                timedOut: true,
              }),
            ),
          )
        : runProcess;

    const [duration, { exitCode, signal, stderrText, ...rest }] = yield* Effect.timed(timedProcess);
    const timedOut = "timedOut" in rest && rest.timedOut === true;

    yield* Effect.logDebug(
      `${strategy.name} exited (code=${exitCode}, signal=${signal}, ms=${Duration.toMillis(duration)})`,
    );

    // Under the sudo privilege-drop path, a missing inner command surfaces as sudo's own exit 127
    // (not a parent ENOENT). Detect it by the combination of the sudo path being active, exit 127,
    // and no JSONL events (a real agent exiting 127 would have emitted events before stopping).
    if (subAgentUid !== undefined && exitCode === 127 && streamEvents.length === 0) {
      return {
        success: false,
        stdout: `Command not found: ${prepared.command}. Ensure the CLI is installed and in PATH.`,
        stderr: `Command '${prepared.command}' not found`,
        exitCode: 127,
      };
    }

    return buildInvocationResult({
      events: streamEvents,
      stderr: stderrText,
      exitCode,
      signal,
      sessionId: strategy.extractSessionId(streamEvents),
      metrics: strategy.extractMetrics(streamEvents, request),
      timedOutAfterMs: timedOut ? request.timeout : undefined,
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
