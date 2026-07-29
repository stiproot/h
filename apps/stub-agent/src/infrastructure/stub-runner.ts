import { join } from "path";

import { FileSystem } from "@effect/platform";
import { AgentRunner, RunLedger, startRunLedgerEffect } from "agent-server";
import { AgentRunError } from "core";
import type { AgentRequest, AgentResponse } from "core";
import { Config, Effect, Layer, Option } from "effect";

const AGENT_ID = "stub-agent";

// Canned output: a valid fenced json block satisfying the smoke outputContract.
const CANNED_OUTPUT = `Stub agent: smoke run complete.

\`\`\`json
{"goal": "RESOLVED", "status": "smoke-passed"}
\`\`\`
`;

const stubRunnerConfig = Config.all({
  baseDir: Config.string("AGENT_BASE_DIR").pipe(Config.withDefault("/workspace/stub-agent")),
  runsDir: Config.option(Config.string("AGENT_RUNS_DIR")),
  daprHttpPort: Config.option(Config.string("DAPR_HTTP_PORT")),
});

const runStub = (
  cfg: { baseDir: string; runsDir: string; daprHttpPort: string | undefined },
  request: AgentRequest,
): Effect.Effect<AgentResponse, unknown, RunLedger | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const { input, workflowInstanceId, workspaceId } = request;
    const fs = yield* FileSystem.FileSystem;

    const workspaceKey = workspaceId ?? workflowInstanceId;
    const cwd = workspaceKey ? join(cfg.baseDir, "workspaces", workspaceKey) : cfg.baseDir;

    if (workspaceKey) yield* fs.makeDirectory(cwd, { recursive: true }).pipe(Effect.ignore);

    const ledger = yield* startRunLedgerEffect({
      agentId: AGENT_ID,
      runsDir: cfg.runsDir,
      workflowInstanceId,
      workspaceId,
      workspacePath: cwd,
      input,
      daprHttpPort: cfg.daprHttpPort,
    });

    const summary = yield* ledger.finish({
      status: "completed",
      output: CANNED_OUTPUT,
      sessionId: null,
      model: "stub",
      turns: 1,
      tokens: { input: 0, output: 0 },
      costUsd: 0,
      stopReason: "completed",
    });

    return {
      output: CANNED_OUTPUT,
      sessionId: null,
      usage: { input: 0, output: 0 },
      model: "stub",
      turns: 1,
      costUsd: 0,
      toolCalls: 0,
      runId: summary.runId,
    } satisfies AgentResponse;
  });

export const StubRunnerLive: Layer.Layer<AgentRunner, never, RunLedger | FileSystem.FileSystem> =
  Layer.effect(
    AgentRunner,
    Effect.gen(function* () {
      const raw = yield* Effect.orDie(stubRunnerConfig);
      const cfg = {
        baseDir: raw.baseDir,
        runsDir: Option.getOrElse(raw.runsDir, () => join(raw.baseDir, "..", ".runs")),
        daprHttpPort: Option.getOrUndefined(raw.daprHttpPort),
      };
      const context = yield* Effect.context<RunLedger | FileSystem.FileSystem>();
      return {
        run: (request: AgentRequest) =>
          runStub(cfg, request).pipe(
            Effect.provide(context),
            Effect.mapError((cause) => new AgentRunError({ cause, agentId: AGENT_ID })),
          ),
      };
    }),
  );
