import { join } from "path";

import { FileSystem } from "@effect/platform";
import { AgentInvoker, toolCallTallyFor } from "agent-cli";
import { AgentRunner, RunLedger, startRunLedgerEffect } from "agent-server";
import { AgentRunError } from "core";
import type { AgentRequest, AgentResponse } from "core";
import { Config, type ConfigError, Data, Effect, Layer, Option } from "effect";
import { LoggerTag } from "logger";

/** Default workspace root, shared with the composition root's workspace-dir resolver. */
export const DEFAULT_AGENT_BASE_DIR = "/workspace/pi-agent";

const AGENT_ID = "pi-agent";

/**
 * A pi run failed before producing a result: the workspace dir could not be
 * created, or the invoker failed in its error channel (today only the LiteLLM model
 * check — timeouts and spawn failures resolve as structured exit-124/exit-1 results).
 * Local to this app; mapped to core's `AgentRunError` at the `AgentRunner` port boundary.
 */
export class PiRunError extends Data.TaggedError("PiRunError")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

// Env resolved once at layer build (the Effect sibling of index.ts's process.env reads).
const piConfig = Effect.gen(function* () {
  const apiKey = yield* Config.withDefault(Config.string("LLM_API_KEY"), "");
  const baseUrl = yield* Config.string("LLM_BASE_URL");
  const model = yield* Config.withDefault(Config.string("AGENT_MODEL"), "claude-sonnet-4-6");
  const baseDir = yield* Config.withDefault(
    Config.string("AGENT_BASE_DIR"),
    DEFAULT_AGENT_BASE_DIR,
  );
  // Shared run-ledger root, visible to every agent and the host (sibling of the per-agent base dir).
  const runsDir = yield* Config.withDefault(
    Config.string("AGENT_RUNS_DIR"),
    join(baseDir, "..", ".runs"),
  );
  const daprHttpPort = yield* Config.option(Config.string("DAPR_HTTP_PORT"));
  // Max wall-clock for one agent CLI run; default 30 min, override with AGENT_RUN_TIMEOUT_MS
  // (mirrors claude-runner). A real feature can exceed the old 5-minute cap on a slower model.
  const runTimeoutMs = yield* Config.withDefault(Config.number("AGENT_RUN_TIMEOUT_MS"), 1_800_000);
  return { apiKey, baseUrl, model, baseDir, runsDir, daprHttpPort, runTimeoutMs };
});

/**
 * `AgentRunner` implementation layer. All collaborators (invoker, run ledger, logger,
 * FileSystem) are captured at layer build so the port method stays `R = never`.
 */
export const PiRunnerLive: Layer.Layer<
  AgentRunner,
  ConfigError.ConfigError,
  AgentInvoker | RunLedger | LoggerTag | FileSystem.FileSystem
> = Layer.effect(
  AgentRunner,
  Effect.gen(function* () {
    const cfg = yield* piConfig;
    const invoker = yield* AgentInvoker;
    const ledger = yield* RunLedger;
    const logger = yield* LoggerTag;
    const fs = yield* FileSystem.FileSystem;

    const run = (request: AgentRequest): Effect.Effect<AgentResponse, PiRunError> =>
      Effect.gen(function* () {
        const {
          input,
          systemPrompt,
          workflowInstanceId,
          workspaceId,
          cwd: cwdOverride,
          model: modelOverride,
        } = request;
        // A workspaceId pins a reusable workspace dir; without one, fall back to the per-run instance id.
        const workspaceKey = workspaceId ?? workflowInstanceId;
        // An explicit cwd (e.g. a shared worktree path) overrides the computed workspace dir.
        const cwd = cwdOverride ?? (workspaceKey ? join(cfg.baseDir, workspaceKey) : cfg.baseDir);
        // Per-step model override (a workflow step choosing a model); falls back to AGENT_MODEL.
        const model = modelOverride ?? cfg.model;
        // Own the workspace dir so a run works without a preceding setup step.
        if (workspaceKey) {
          yield* fs
            .makeDirectory(cwd, { recursive: true })
            .pipe(Effect.mapError((cause) => new PiRunError({ cause })));
        }

        const log = yield* logger.child({ workflowInstanceId, workspaceId, agent: "pi" });

        const handle = yield* startRunLedgerEffect({
          agentId: AGENT_ID,
          runsDir: cfg.runsDir,
          workflowInstanceId,
          workspaceId,
          workspacePath: cwd,
          input,
          daprHttpPort: Option.getOrUndefined(cfg.daprHttpPort),
          // pi counts its OWN stream shape; see agent-cli event-shape.ts.
          tallyToolCalls: toolCallTallyFor("pi"),
        }).pipe(Effect.provideService(RunLedger, ledger));

        const result = yield* invoker
          .invoke({
            systemPrompt: systemPrompt ?? "",
            taskPrompt: input,
            cwd,
            env: {
              ...(workflowInstanceId ? { WORKFLOW_INSTANCE_ID: workflowInstanceId } : {}),
            },
            timeout: cfg.runTimeoutMs,
            model,
            llmConfig: { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl },
            onEvent: (event) => {
              Effect.runSync(log.info(event, "agent output"));
              handle.onEvent(event);
            },
          })
          .pipe(
            Effect.withSpan("pi cli", { attributes: { "pi.model": model } }),
            Effect.mapError((cause) => new PiRunError({ cause })),
            Effect.catchAllDefect((cause) => Effect.fail(new PiRunError({ cause }))),
            Effect.tapError((err) =>
              handle.finish({ status: "failed", output: "", error: String(err.cause) }),
            ),
          );

        // A resolved InvocationResult may carry a non-zero exit code (timeout → 124,
        // spawn failure → 1, or the agent itself exited with an error). Check and
        // propagate as a run failure so the workflow step does not silently succeed.
        if (result.exitCode !== undefined && result.exitCode !== 0) {
          const msg = result.stderr ?? `Agent exited with code ${result.exitCode}`;
          yield* handle.finish({
            status: "failed",
            output: result.stdout ?? "",
            error: msg,
            stopReason: result.stopReason ?? null,
            // What the run DID spend before failing — a failed run must not ledger null cost
            // when usage is known (docs/plans/cost-containment.md B1).
            costUsd: result.costUsd ?? null,
            costPartial: result.costPartial ?? null,
            tokens: result.tokenUsage ?? null,
            model: result.model ?? null,
            turns: result.numTurns ?? null,
          });
          return yield* Effect.fail(new PiRunError({ cause: new Error(msg) }));
        }

        const summary = yield* handle.finish({
          status: "completed",
          output: result.stdout,
          sessionId: result.sessionId ?? null,
          model: result.model ?? model,
          turns: result.numTurns ?? 1,
          tokens: result.tokenUsage ?? { input: 0, output: 0 },
          costUsd: result.costUsd ?? null,
          stopReason: result.stopReason ?? null,
        });

        return {
          output: result.stdout,
          sessionId: result.sessionId ?? null,
          usage: result.tokenUsage ?? { input: 0, output: 0 },
          model: result.model ?? model,
          turns: result.numTurns ?? 1,
          workspacePath: cwd,
          costUsd: result.costUsd,
          toolCalls: summary.toolCalls,
          runId: summary.runId,
        };
      });

    return {
      // Port boundary: the AgentRunner contract's E is core's cross-service AgentRunError.
      run: (request) =>
        run(request).pipe(
          Effect.mapError((cause) => new AgentRunError({ cause, agentId: AGENT_ID })),
        ),
    };
  }),
);
