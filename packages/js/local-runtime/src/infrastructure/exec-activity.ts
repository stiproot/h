import { Command, CommandExecutor } from "@effect/platform";
import { Duration, Effect, Layer, Stream } from "effect";

import { ExecError, ExecPort, ExecTimeoutError } from "../domain/ports.ts";
import type { ExecResult } from "../domain/ports.ts";

export { ExecError, ExecTimeoutError };

const MAX_BYTES = 512 * 1024;

/**
 * Accumulate a text stream up to MAX_BYTES. Beyond the cap, only the TAIL is kept (a build's last
 * lines are more useful than its first). Stream errors are converted to defects — a failure reading
 * from a started process's stdout/stderr pipe is a platform bug, not a domain error.
 */
const collectCapped = (
  stream: Stream.Stream<Uint8Array, unknown>,
): Effect.Effect<{ text: string; truncated: boolean }, never, never> =>
  stream.pipe(
    Stream.orDie,
    Stream.decodeText("utf-8"),
    Stream.runFold(
      { text: "", bytes: 0, truncated: false },
      ({ text, bytes, truncated }, chunk) => {
        const added = Buffer.byteLength(chunk, "utf-8");
        const next = bytes + added;
        if (next <= MAX_BYTES) {
          return { text: text + chunk, bytes: next, truncated };
        }
        // Keep only the tail: drop enough from the front to stay within cap.
        const combined = text + chunk;
        const encoded = Buffer.from(combined, "utf-8");
        const tail = encoded.slice(encoded.length - MAX_BYTES);
        return { text: tail.toString("utf-8"), bytes: MAX_BYTES, truncated: true };
      },
    ),
    Effect.map(({ text, truncated }) => ({ text, truncated })),
    Effect.orDie,
  );

/**
 * Run `command` through the shell in `cwd`, capturing stdout and stderr.
 *
 * Non-zero exit → `ExecError`. Timeout → `ExecTimeoutError`.
 * Stdout and stderr are each capped at 512 KB; only the TAIL is retained beyond that.
 *
 * Process-group limitation: `Command.runInShell(true)` spawns `sh -c <cmd>`. The platform
 * finalizer kills the shell on scope close, but grandchildren the shell spawned may survive
 * briefly. This is documented in the result's `notes` field — callers that need stronger
 * guarantees should spawn with a dedicated process group via Node child_process APIs.
 */
export const runExec = (
  command: string,
  cwd: string,
  timeoutMs: number,
): Effect.Effect<ExecResult, ExecError | ExecTimeoutError, CommandExecutor.CommandExecutor> =>
  Effect.scoped(
    Effect.gen(function* () {
      const process = yield* Command.start(
        Command.make(command).pipe(Command.workingDirectory(cwd), Command.runInShell(true)),
      ).pipe(
        // A PlatformError here means the shell failed to start — report as ExecError.
        Effect.mapError(
          (err) =>
            new ExecError({
              command,
              exitCode: -1,
              stderrTail: String(err),
              message: `run-exec: failed to start command: ${command}: ${String(err)}`,
            }),
        ),
      );

      // Drain stdout, stderr, and the exit code CONCURRENTLY to prevent pipe-buffer deadlock:
      // a command that fills stderr while stdout is unread would stall otherwise.
      // `process.exitCode` can fail with `PlatformError` which is a platform bug, not a domain
      // error — convert it to a defect so the error channel stays `ExecError | ExecTimeoutError`.
      const [stdoutResult, stderrResult, exitCode] = yield* Effect.all(
        [
          collectCapped(process.stdout),
          collectCapped(process.stderr),
          process.exitCode.pipe(Effect.orDie),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const stderrTail = stderrResult.text.slice(-500);
        return yield* Effect.fail(
          new ExecError({
            command,
            exitCode,
            stderrTail,
            message:
              `run-exec: command exited ${exitCode}: ${command}` +
              (stderrTail ? `\n${stderrTail}` : ""),
          }),
        );
      }

      return {
        exitCode,
        stdout: stdoutResult.text,
        stderr: stderrResult.text,
        ...(stdoutResult.truncated ? { stdoutTruncated: true as const } : {}),
        ...(stderrResult.truncated ? { stderrTruncated: true as const } : {}),
        notes:
          "process group: only the shell (sh -c) is killed on timeout; grandchildren may survive briefly",
      } satisfies ExecResult;
    }),
  ).pipe(
    Effect.timeout(Duration.millis(timeoutMs)),
    Effect.catchTag("TimeoutException", () =>
      Effect.fail(
        new ExecTimeoutError({
          command,
          timeoutMs,
          message: `command timed out after ${timeoutMs}ms: ${command}`,
        }),
      ),
    ),
  );

/** The real `ExecPort` adapter: runs shell commands through Node's `CommandExecutor`. */
export const ExecPortLive: Layer.Layer<ExecPort, never, CommandExecutor.CommandExecutor> =
  Layer.effect(
    ExecPort,
    Effect.gen(function* () {
      const context = yield* Effect.context<CommandExecutor.CommandExecutor>();
      return {
        runCommand: (command: string, cwd: string, timeoutMs: number) =>
          runExec(command, cwd, timeoutMs).pipe(Effect.provide(context)),
      };
    }),
  );
