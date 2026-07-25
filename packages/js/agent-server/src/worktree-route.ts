import { dirname, join } from "path";

import { FileSystem } from "@effect/platform";
import { CloneError } from "core";
import { Effect, type ManagedRuntime, Schema } from "effect";
import type { FastifyInstance } from "fastify";
import { GitClient } from "git-core";
import { withServerSpan } from "telemetry";

import { resolveGitAuth } from "./git-auth.ts";
import { runHandler } from "./run-handler.ts";
import { RunLedger, recordActivityEffect } from "./run-ledger.ts";
import type { ActivityLedgerConfig, ActivityRecord } from "./run-ledger.ts";

/** Wire contract for POST /worktree. */
const WorktreeBody = Schema.Struct({
  workflowInstanceId: Schema.String,
  workspaceId: Schema.optional(Schema.String),
  // Local path of the pre-cloned repo to cut the worktree from; defaults to <sharedRoot>/repo.
  // NB: a filesystem path, NOT a GitHub owner/name (that is `repo`, the wf-identity segment).
  clonePath: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  baseRef: Schema.optional(Schema.String),
  // Branch to refresh from origin before cutting a new branch, so the worktree is up to date with the
  // remote rather than the pre-clone's stale local checkout. Defaults to "main"; ignored when baseRef
  // pins an explicit start point. Pass an empty string to skip the refresh (branch from local HEAD).
  remoteBase: Schema.optional(Schema.String),
  // Auth strategy NAME only (secrets stay in the service env — see resolveGitAuth).
  auth: Schema.optional(Schema.Literal("pat", "ssh")),
});
type WorktreeBody = Schema.Schema.Type<typeof WorktreeBody>;

/** Everything the Effect worktree route yields from the runtime. */
export type WorktreeRouteEffectEnv = GitClient | RunLedger | FileSystem.FileSystem;

export interface WorktreeRouteEffectConfig {
  /** The shared per-process runtime; must provide `ExecGitClient`, `RunLedgerLive`, and FileSystem. */
  runtime: ManagedRuntime.ManagedRuntime<WorktreeRouteEffectEnv, never>;
  /** Shared, agent-neutral workspace root holding the pre-cloned target repo and worktrees/. */
  sharedRoot: string;
  ledger?: ActivityLedgerConfig;
}

/**
 * Registers POST /worktree: adds a git worktree of a pre-cloned source repo at a run-specific
 * path under the shared workspace root (sharedRoot/worktrees/<key>, key = workspaceId ??
 * workflowInstanceId — an agent-neutral path), so every agent in the run resolves the same
 * worktree. Idempotent: a second caller in the same run (or a re-run) finds the worktree
 * present and returns its path. Opt-in like registerCloneRouteEffect. Yields the `GitClient`
 * tag and maps its `GitWorktreeError` to `core`'s `CloneError` at this boundary (core's tag
 * deliberately covers "worktree provisioning off a clone"; `url` carries the source repo
 * path, `dir` the worktree path). Replies 200 `{ worktreePath }` so downstream steps can
 * target it, and 400s a malformed body.
 */
export function registerWorktreeRouteEffect(
  fastify: FastifyInstance,
  { runtime, sharedRoot, ledger }: WorktreeRouteEffectConfig,
): void {
  fastify.post("/worktree", (request, reply) =>
    withServerSpan("POST /worktree", request.headers, () =>
      runHandler(runtime, reply, worktreeEffect(request.body, { sharedRoot, ledger })),
    ),
  );
}

const worktreeEffect = (
  rawBody: unknown,
  { sharedRoot, ledger }: Pick<WorktreeRouteEffectConfig, "sharedRoot" | "ledger">,
) =>
  Effect.gen(function* () {
    const { workflowInstanceId, workspaceId, clonePath, branch, baseRef, remoteBase, auth } =
      yield* Schema.decodeUnknown(WorktreeBody)(rawBody);
    // Refresh from origin/main by default so a new worktree is cut from the latest remote tip, not
    // the pre-clone's stale local checkout. A pinned baseRef wins; an explicit empty remoteBase
    // opts out (branch from local HEAD, the pre-refresh behaviour).
    const effectiveRemoteBase = baseRef ? undefined : (remoteBase ?? "main") || undefined;
    const startedAtMs = Date.now();
    const key = workspaceId ?? workflowInstanceId;
    const worktreePath = join(sharedRoot, "worktrees", key);
    // Empty string = unset: templates now always emit clonePath as a {{params.clonePath}} token
    // whose default is "" (multi-repo promotion) — treat blank exactly like absent.
    const repoPath = clonePath?.trim() ? clonePath : join(sharedRoot, "repo");
    const rec = (
      status: ActivityRecord["status"],
      extra?: Partial<ActivityRecord>,
    ): Effect.Effect<void, never, RunLedger> =>
      ledger
        ? recordActivityEffect(ledger, {
            activity: "worktree",
            workflowInstanceId,
            workspaceId,
            status,
            startedAtMs,
            detail: worktreePath,
            ...extra,
          })
        : Effect.void;

    const fs = yield* FileSystem.FileSystem;
    // Idempotent: a second caller in the same run (or a re-run) finds the worktree present.
    const alreadyPresent = yield* fs.exists(worktreePath).pipe(Effect.orElseSucceed(() => false));
    if (alreadyPresent) {
      yield* rec("skipped");
      return { worktreePath };
    }

    const git = yield* GitClient;
    // Reuse-by-branch (issue #76): addWorktree returns the EFFECTIVE path — the requested one,
    // or the existing worktree already holding this branch (a finished chain's leftover in any
    // workspace). Downstream steps cwd into whichever is returned.
    const effectivePath = yield* Effect.gen(function* () {
      yield* fs.makeDirectory(dirname(worktreePath), { recursive: true });
      return yield* git.addWorktree({
        repoPath,
        worktreePath,
        branch,
        baseRef,
        remoteBase: effectiveRemoteBase,
        auth: resolveGitAuth(auth),
      });
    }).pipe(
      Effect.tapError((err) => rec("failed", { error: err.message })),
      Effect.mapError((cause) => new CloneError({ cause, url: repoPath, dir: worktreePath })),
    );

    yield* rec("completed", effectivePath !== worktreePath ? { detail: effectivePath } : undefined);
    return { worktreePath: effectivePath };
  });
