import { dirname } from "node:path";

import { Command, type CommandExecutor, FileSystem } from "@effect/platform";
import { Effect, Layer, Stream } from "effect";
import { GitClient, seedWorktree } from "git-core";

import type { WorktreeSpec } from "../domain/models.ts";
import { WorkspaceError, WorkspacePort, type SetupCommand } from "../domain/ports.ts";

/**
 * The `WorkspacePort` adapter: git-core for checkouts, the shell for provisioning — the same
 * `addWorktree` and the same command loop the service substrate reaches through an agent
 * service's `/worktree` and `/setup` routes, called in-process.
 *
 * No token is passed to git: local execution fetches with the operator's own credentials
 * (ssh-agent, credential helper, whatever their shell already uses), which is the premise of the
 * substrate. A private repo the operator can clone by hand works here too.
 */
export const GitWorkspaceLive: Layer.Layer<
  WorkspacePort,
  never,
  GitClient | FileSystem.FileSystem | CommandExecutor.CommandExecutor
> = Layer.effect(
  WorkspacePort,
  Effect.gen(function* () {
    const git = yield* GitClient;
    const fs = yield* FileSystem.FileSystem;
    const context = yield* Effect.context<CommandExecutor.CommandExecutor>();

    const prepare = (spec: WorktreeSpec) =>
      Effect.gen(function* () {
        // Idempotent, mirroring the /worktree route: a second step in the same run — or a re-run
        // under the same group — finds the worktree present and uses it rather than failing on
        // "already exists".
        const present = yield* fs.exists(spec.worktreePath).pipe(Effect.orElseSucceed(() => false));
        let worktreePath = spec.worktreePath;
        if (!present) {
          yield* fs.makeDirectory(dirname(spec.worktreePath), { recursive: true });
          // addWorktree returns the EFFECTIVE path: a branch lives in at most one worktree, so if
          // one already holds it, that path comes back instead of an error.
          // spec.checkout is git-core's GitCheckout in all but name (the domain may not import an
          // I/O package). This assignment is the drift guard: a shape change on either side fails
          // the typecheck here.
          worktreePath = yield* git.addWorktree({
            repoPath: spec.repoPath,
            worktreePath: spec.worktreePath,
            checkout: spec.checkout,
          });
        }
        // Seeding runs on the reused path too: it never overwrites, so a present worktree only
        // gains what it lacks — which is what makes a re-run under the same group safe.
        const seeded = yield* seedWorktree({
          repoPath: spec.repoPath,
          worktreePath,
          paths: spec.seed ?? [],
        });
        return { worktreePath, seeded };
      }).pipe(
        Effect.mapError((cause) => new WorkspaceError({ worktreePath: spec.worktreePath, cause })),
      );

    const provision = (cwd: string, commands: ReadonlyArray<SetupCommand>) =>
      Effect.forEach(commands, ({ cmd, validateCmd }) =>
        Effect.forEach(
          [cmd, validateCmd].filter((c): c is string => Boolean(c)),
          (one) => runShell(one, cwd),
        ),
      ).pipe(
        Effect.asVoid,
        Effect.provide(context),
        Effect.mapError((cause) => new WorkspaceError({ worktreePath: cwd, cause })),
      );

    return { prepare, provision };
  }),
);

/** One setup command through the shell; stderr is captured so a failure says why. */
const runShell = (
  cmd: string,
  cwd: string,
): Effect.Effect<void, Error, CommandExecutor.CommandExecutor> =>
  Effect.scoped(
    Effect.gen(function* () {
      const process = yield* Command.start(
        Command.make(cmd).pipe(Command.workingDirectory(cwd), Command.runInShell(true)),
      );
      // stderr and the exit code are read concurrently so a chatty command cannot deadlock the
      // pipe buffer while we wait on the exit.
      const [stderr, exitCode] = yield* Effect.all(
        [
          process.stderr.pipe(
            Stream.decodeText("utf-8"),
            Stream.runFold("", (acc, chunk) => acc + chunk),
          ),
          process.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) {
        return yield* Effect.fail(
          new Error(`setup command failed (exit ${exitCode}): ${cmd}\n${stderr.trim()}`),
        );
      }
    }),
  ).pipe(Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))));
