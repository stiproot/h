import { createHash } from "crypto";
import { join } from "path";

import { Command, type CommandExecutor, FileSystem } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { AgentRequest } from "core";
import { Data, Effect, type ManagedRuntime, Schema, Stream } from "effect";
import type { FastifyInstance } from "fastify";
import { withServerSpan } from "telemetry";

import { runHandler } from "./run-handler.ts";
import { RunLedger, recordActivityEffect } from "./run-ledger.ts";
import type { ActivityLedgerConfig, ActivityRecord } from "./run-ledger.ts";
import { AgentRunner } from "./runner.ts";

/** One provisioning step of a /setup request — schema plus derived type, same name. */
export const SetupItem = Schema.Struct({
  cmd: Schema.String,
  validateCmd: Schema.optional(Schema.String),
});
export type SetupItem = Schema.Schema.Type<typeof SetupItem>;

/** Wire contract for POST /setup — schema plus derived type, same name. */
export const SetupBody = Schema.Struct({
  workflowInstanceId: Schema.String,
  workspaceId: Schema.optional(Schema.String),
  setup: Schema.Array(SetupItem),
  /** Explicit working dir for the setup commands (e.g. a worktree); overrides the computed dir. */
  cwd: Schema.optional(Schema.String),
});
export type SetupBody = Schema.Schema.Type<typeof SetupBody>;

// Marks a workspace as provisioned. Holds a hash of the setup spec, so a reused workspace re-runs
// setup only when the spec changes. A fresh per-run workspace never has it and always provisions.
const SETUP_SENTINEL = ".agent-setup-complete";

/** A /setup provisioning step failed — the shell command (or the fs step named in `cmd`). */
export class SetupError extends Data.TaggedError("SetupError")<{
  readonly cmd: string;
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    if (this.stderr?.trim()) return `Command failed: ${this.cmd}\n${this.stderr.trim()}`;
    if (this.cause) {
      const detail = this.cause instanceof Error ? this.cause.message : String(this.cause);
      return `Command failed: ${this.cmd}: ${detail}`;
    }
    return `Command failed: ${this.cmd}`;
  }
}

const collectText = (
  stream: Stream.Stream<Uint8Array, PlatformError>,
): Effect.Effect<string, PlatformError> =>
  stream.pipe(
    Stream.decodeText("utf-8"),
    Stream.runFold("", (acc, chunk) => acc + chunk),
  );

// Runs one setup command through the shell (the Effect sibling of `execSync(cmd, { stdio: "pipe" })`).
// stdout is drained (never inherited) and stderr is captured into the SetupError, matching the
// piped-stdio semantics; stdout/stderr/exit are read concurrently so a chatty stream cannot
// deadlock the pipe buffer.
const runSetupCommand = (
  cmd: string,
  cwd: string,
): Effect.Effect<void, SetupError, CommandExecutor.CommandExecutor> =>
  Effect.scoped(
    Effect.gen(function* () {
      const command = Command.make(cmd).pipe(
        Command.workingDirectory(cwd),
        Command.runInShell(true),
      );
      const process = yield* Command.start(command);
      const [stderr, exitCode] = yield* Effect.all(
        [collectText(process.stderr), process.exitCode],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) return yield* new SetupError({ cmd, exitCode, stderr });
    }),
  ).pipe(
    Effect.mapError((failure) =>
      failure instanceof SetupError ? failure : new SetupError({ cmd, cause: failure }),
    ),
  );

/** Everything the Effect agent routes yield from the runtime. */
export type AgentRoutesEffectEnv =
  | AgentRunner
  | RunLedger
  | FileSystem.FileSystem
  | CommandExecutor.CommandExecutor;

export interface AgentRoutesEffectConfig {
  /**
   * The shared per-process runtime (built once in the composition root). Must provide the
   * `AgentRunner` implementation layer, `RunLedgerLive`, and the platform services
   * (`NodeContext.layer` covers FileSystem + CommandExecutor).
   */
  runtime: ManagedRuntime.ManagedRuntime<AgentRoutesEffectEnv, never>;
  /** Resolves the absolute workspace dir for a workspace key (a workspaceId or, by default, a workflow instance id). */
  resolveWorkspaceDir: (workspaceKey: string) => string;
  /** When set, /setup records its outcome (completed/skipped/failed) into the run ledger. */
  ledger?: ActivityLedgerConfig;
}

/**
 * Registers the HTTP contract every agent service shares: POST /run, POST /setup, and
 * GET /dapr/subscribe. Each handler builds ONE handler Effect (Schema decode inside it,
 * then yield the `AgentRunner` tag) run through the shared runtime via the `runHandler`
 * bridge — so a malformed body is
 * a real 400 and tagged failures map to 500. The inbound server span stays at the Fastify
 * edge (`withServerSpan`); `runHandler` parents the fiber under it. `/dapr/subscribe` stays
 * a trivial Fastify route.
 */
export function registerAgentRoutesEffect(
  fastify: FastifyInstance,
  { runtime, resolveWorkspaceDir, ledger }: AgentRoutesEffectConfig,
): void {
  fastify.post("/run", (request, reply) =>
    withServerSpan("POST /run", request.headers, () =>
      runHandler(
        runtime,
        reply,
        Effect.gen(function* () {
          const body = yield* Schema.decodeUnknown(AgentRequest)(request.body);
          const runner = yield* AgentRunner;
          return yield* runner.run(body);
        }),
      ),
    ),
  );

  fastify.post("/setup", (request, reply) =>
    withServerSpan("POST /setup", request.headers, () =>
      runHandler(runtime, reply, setupEffect(request.body, { resolveWorkspaceDir, ledger }), {
        successStatus: 204,
      }),
    ),
  );

  fastify.get("/dapr/subscribe", async (_request, reply) => {
    return reply.send([]);
  });
}

const setupEffect = (
  rawBody: unknown,
  { resolveWorkspaceDir, ledger }: Pick<AgentRoutesEffectConfig, "resolveWorkspaceDir" | "ledger">,
) =>
  Effect.gen(function* () {
    const { workflowInstanceId, workspaceId, setup, cwd } =
      yield* Schema.decodeUnknown(SetupBody)(rawBody);
    const startedAtMs = Date.now();
    const rec = (
      status: ActivityRecord["status"],
      extra?: Partial<ActivityRecord>,
    ): Effect.Effect<void, never, RunLedger> =>
      ledger
        ? recordActivityEffect(ledger, {
            activity: "setup",
            workflowInstanceId,
            workspaceId,
            status,
            startedAtMs,
            ...extra,
          })
        : Effect.void;

    const fs = yield* FileSystem.FileSystem;
    // An explicit cwd (e.g. a worktree) runs setup there; otherwise the computed workspace dir.
    const workspaceDir = cwd ?? resolveWorkspaceDir(workspaceId ?? workflowInstanceId);
    yield* fs
      .makeDirectory(workspaceDir, { recursive: true })
      .pipe(Effect.mapError((cause) => new SetupError({ cmd: `mkdir -p ${workspaceDir}`, cause })));

    const specHash = createHash("sha256").update(JSON.stringify(setup)).digest("hex");
    const sentinel = join(workspaceDir, SETUP_SENTINEL);
    // A missing/unreadable sentinel means "not provisioned" (existsSync parity), never a failure.
    const alreadyProvisioned = yield* fs.readFileString(sentinel).pipe(
      Effect.map((content) => content === specHash),
      Effect.orElseSucceed(() => false),
    );
    if (alreadyProvisioned) {
      yield* rec("skipped");
      return;
    }

    // Only command failures record a "failed" activity (fs failures before/after do not) — the
    // same scope as the legacy try/catch around the command loop.
    yield* Effect.gen(function* () {
      for (const { cmd, validateCmd } of setup) {
        yield* Effect.gen(function* () {
          yield* runSetupCommand(cmd, workspaceDir);
          if (validateCmd) yield* runSetupCommand(validateCmd, workspaceDir);
        }).pipe(Effect.withSpan(`setup: ${cmd}`, { attributes: { "setup.cmd": cmd } }));
      }
    }).pipe(Effect.tapError((err) => rec("failed", { error: err.message })));

    yield* fs
      .writeFileString(sentinel, specHash)
      .pipe(Effect.mapError((cause) => new SetupError({ cmd: `write ${SETUP_SENTINEL}`, cause })));
    yield* rec("completed");
  });
