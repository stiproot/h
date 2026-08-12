/**
 * Running git as a subprocess, and getting its failures out of the package without leaking a
 * credential. Shared by every git-core module — the clone/worktree provisioning path and the GC
 * path — so there is exactly ONE place that knows how a git invocation is spawned and exactly one
 * path from a raw failure to a caller-visible error.
 *
 * Internal to the package: nothing here is re-exported from index.ts.
 */

import { Command } from "@effect/platform";
import type { CommandExecutor } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { Data, Effect, Stream } from "effect";

/** A git subprocess exited non-zero. Raw stderr — scrubbed before leaving the port. */
export class GitExitError extends Data.TaggedError("GitExitError")<{
  readonly exitCode: number;
  readonly stderr: string;
}> {}

export const causeText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const collectText = (
  stream: Stream.Stream<Uint8Array, PlatformError>,
): Effect.Effect<string, PlatformError> =>
  stream.pipe(
    Stream.decodeText("utf-8"),
    Stream.runFold("", (acc, chunk) => acc + chunk),
  );

/**
 * Run git with the given args, capturing stdout as the result and stderr for diagnostics
 * (the Effect sibling of execFileSync's `stdio: "pipe"` throw). stdout/stderr/exit are read
 * concurrently so a chatty stream can never deadlock the pipe buffer.
 */
export const runGit = (
  args: ReadonlyArray<string>,
  cwd?: string,
  env?: Record<string, string>,
): Effect.Effect<string, GitExitError | PlatformError, CommandExecutor.CommandExecutor> =>
  Effect.scoped(
    Effect.gen(function* () {
      const base = Command.make("git", ...args);
      const withCwd = cwd ? Command.workingDirectory(base, cwd) : base;
      const command = env ? Command.env(withCwd, env) : withCwd;
      const process = yield* Command.start(command);
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [collectText(process.stdout), collectText(process.stderr), process.exitCode],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) return yield* new GitExitError({ exitCode, stderr });
      return stdout;
    }),
  );

const REDACTED = "<redacted>";

const scrub = (text: string, token: string | undefined): string =>
  token ? text.split(token).join(REDACTED) : text;

/**
 * The only path from a raw git failure into a port error: every piece of text that could echo
 * the authenticated URL (stderr, platform error messages) passes through scrub() first.
 */
export const redactedCause = (
  failure: GitExitError | PlatformError,
  token: string | undefined,
): Error =>
  failure._tag === "GitExitError"
    ? new Error(scrub(`git exited with code ${failure.exitCode}: ${failure.stderr.trim()}`, token))
    : new Error(scrub(failure.message, token));
