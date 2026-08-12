import { join } from "path";

import { Effect, Schema } from "effect";
import type { ManagedRuntime } from "effect";
import type { FastifyInstance } from "fastify";
import { GitClient } from "git-core";
import { withServerSpan } from "telemetry";

import { runHandler } from "./run-handler.ts";
import { RunLedger, recordActivityEffect } from "run-ledger";
import type { ActivityLedgerConfig, ActivityRecord } from "run-ledger";

/**
 * Wire contract for POST /worktree/gc.
 *
 * Deliberately NOT parameterized by root or repo: the collector sweeps the shared workspace this
 * service was configured with, so a caller cannot point it at an arbitrary directory. The only
 * knobs a caller gets are the ones that make it collect LESS.
 */
const GcBody = Schema.Struct({
  /** Ledger identity, as on /worktree — the collection is an activity like any other. */
  workflowInstanceId: Schema.optional(Schema.String),
  workspaceId: Schema.optional(Schema.String),
  /** Minimum age before a worktree may be collected; defaults to git-core's 24h. */
  minAgeMs: Schema.optional(Schema.Number),
  /** Discard untracked scratch files. Off by default — the caller must ask. */
  pruneUntracked: Schema.optional(Schema.Boolean),
  /** Workspace keys to spare whatever their age. */
  keep: Schema.optional(Schema.Array(Schema.String)),
  /** Classify and report, change nothing. */
  dryRun: Schema.optional(Schema.Boolean),
});

export type GcRouteEffectEnv = GitClient | RunLedger;

export interface GcRouteEffectConfig {
  /** The shared per-process runtime; must provide `ExecGitClient` and `RunLedgerLive`. */
  runtime: ManagedRuntime.ManagedRuntime<GcRouteEffectEnv, never>;
  /** Shared workspace root holding the pre-cloned target repo and worktrees/. */
  sharedRoot: string;
  ledger?: ActivityLedgerConfig;
}

/**
 * Registers POST /worktree/gc: collect the worktrees under this service's shared workspace that
 * hold nothing worth keeping.
 *
 * It lives HERE, beside the route that creates them, because that is where the workspace is.
 * workflow-svc — which owns the engines and would be the intuitive place to clean up after a
 * run — mounts no workspace at all; only the agent services do. So collection goes back through
 * the same seam that provisioned it, and the caller is an ordinary workflow step.
 *
 * The response is the full report (removed, kept-with-reason, bytes) rather than a count, because
 * the useful outcome of a collection is often what it REFUSED to take and why.
 */
export function registerGcRouteEffect(
  fastify: FastifyInstance,
  { runtime, sharedRoot, ledger }: GcRouteEffectConfig,
): void {
  fastify.post("/worktree/gc", (request, reply) =>
    withServerSpan("POST /worktree/gc", request.headers, () =>
      runHandler(runtime, reply, gcEffect(request.body, { sharedRoot, ledger })),
    ),
  );
}

const gcEffect = (
  rawBody: unknown,
  { sharedRoot, ledger }: Pick<GcRouteEffectConfig, "sharedRoot" | "ledger">,
) =>
  Effect.gen(function* () {
    const body = yield* Schema.decodeUnknown(GcBody)(rawBody);
    const startedAtMs = Date.now();
    const worktreesRoot = join(sharedRoot, "worktrees");

    const git = yield* GitClient;
    const report = yield* git.gcWorktrees({
      repoPath: join(sharedRoot, "repo"),
      roots: [worktreesRoot],
      ...(body.minAgeMs === undefined ? {} : { minAgeMs: body.minAgeMs }),
      ...(body.pruneUntracked === undefined ? {} : { pruneUntracked: body.pruneUntracked }),
      // The caller's OWN workspace is always spared: the collecting step runs inside a worktree of
      // the very root being swept, and a collector that eats its own workspace mid-run is the one
      // failure this must never have.
      keep: [...(body.keep ?? []), ...(body.workspaceId ? [body.workspaceId] : [])],
      ...(body.dryRun === undefined ? {} : { dryRun: body.dryRun }),
    });

    const rec = (status: ActivityRecord["status"]): Effect.Effect<void, never, RunLedger> =>
      ledger
        ? recordActivityEffect(ledger, {
            activity: "worktree-gc",
            workflowInstanceId: body.workflowInstanceId ?? "gc",
            ...(body.workspaceId === undefined ? {} : { workspaceId: body.workspaceId }),
            status,
            startedAtMs,
            detail: `removed ${report.removed.length}, kept ${report.kept.length}`,
          })
        : Effect.void;
    yield* rec("completed");

    return report;
  });
