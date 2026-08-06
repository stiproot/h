import { FileSystem } from "@effect/platform";
import { CloneError } from "core";
import { Effect, type ManagedRuntime, Schema } from "effect";
import type { FastifyInstance } from "fastify";
import { GitClient } from "git-core";
import { withServerSpan } from "telemetry";

import { resolveGitAuth } from "./git-auth.ts";
import { runHandler } from "./run-handler.ts";
import { RunLedger, recordActivityEffect } from "run-ledger";
import type { ActivityLedgerConfig, ActivityRecord } from "run-ledger";

/** Wire contract for POST /clone. */
const CloneBody = Schema.Struct({
  workflowInstanceId: Schema.String,
  workspaceId: Schema.optional(Schema.String),
  url: Schema.String,
  branch: Schema.optional(Schema.String),
  depth: Schema.optional(Schema.Number),
  dir: Schema.optional(Schema.String),
  // Auth strategy NAME only (secrets stay in the service env — see resolveGitAuth).
  auth: Schema.optional(Schema.Literal("pat", "ssh")),
});
type CloneBody = Schema.Schema.Type<typeof CloneBody>;

/** Everything the Effect clone route yields from the runtime. */
export type CloneRouteEffectEnv = GitClient | RunLedger | FileSystem.FileSystem;

export interface CloneRouteEffectConfig {
  /** The shared per-process runtime; must provide `ExecGitClient`, `RunLedgerLive`, and FileSystem. */
  runtime: ManagedRuntime.ManagedRuntime<CloneRouteEffectEnv, never>;
  resolveWorkspaceDir: (workspaceKey: string) => string;
  ledger?: ActivityLedgerConfig;
}

/**
 * Registers POST /clone: shallow-clones a repo into the per-instance workspace. Opt-in
 * (not part of registerAgentRoutesEffect) since not every agent needs it. Yields the
 * `GitClient` tag and maps its `GitCloneError` to `core`'s cross-service `CloneError` at
 * this boundary (the tag that crosses the Dapr-invoke boundary to workflow-svc's clone
 * activity), so downstream consumers match one vocabulary. Replies 204 on success,
 * records the outcome into the run ledger when `ledger` is set, and 400s a malformed body.
 */
export function registerCloneRouteEffect(
  fastify: FastifyInstance,
  { runtime, resolveWorkspaceDir, ledger }: CloneRouteEffectConfig,
): void {
  fastify.post("/clone", (request, reply) =>
    withServerSpan("POST /clone", request.headers, () =>
      runHandler(runtime, reply, cloneEffect(request.body, { resolveWorkspaceDir, ledger }), {
        successStatus: 204,
      }),
    ),
  );
}

const cloneEffect = (
  rawBody: unknown,
  { resolveWorkspaceDir, ledger }: Pick<CloneRouteEffectConfig, "resolveWorkspaceDir" | "ledger">,
) =>
  Effect.gen(function* () {
    const { workflowInstanceId, workspaceId, url, branch, depth, dir, auth } =
      yield* Schema.decodeUnknown(CloneBody)(rawBody);
    const startedAtMs = Date.now();
    const workspaceDir = resolveWorkspaceDir(workspaceId ?? workflowInstanceId);
    const targetDir = dir ?? "repo";
    const rec = (
      status: ActivityRecord["status"],
      extra?: Partial<ActivityRecord>,
    ): Effect.Effect<void, never, RunLedger> =>
      ledger
        ? recordActivityEffect(ledger, {
            activity: "clone",
            workflowInstanceId,
            workspaceId,
            status,
            startedAtMs,
            detail: url,
            ...extra,
          })
        : Effect.void;

    const fs = yield* FileSystem.FileSystem;
    // Workspace provisioning failures are not ledger-recorded (parity with the legacy route,
    // where mkdirSync sits outside the try/catch); they still map to the CloneError tag.
    yield* fs
      .makeDirectory(workspaceDir, { recursive: true })
      .pipe(Effect.mapError((cause) => new CloneError({ cause, url, dir: targetDir })));

    const git = yield* GitClient;
    yield* git
      .clone({
        url,
        dir: targetDir,
        cwd: workspaceDir,
        branch,
        depth: depth ?? 1,
        auth: resolveGitAuth(auth),
      })
      .pipe(
        Effect.tapError((err) => rec("failed", { error: err.message })),
        Effect.mapError((cause) => new CloneError({ cause, url, dir: targetDir })),
      );

    yield* rec("completed");
  });
