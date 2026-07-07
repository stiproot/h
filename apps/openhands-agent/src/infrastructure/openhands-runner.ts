import { join } from "path";

import { FileSystem } from "@effect/platform";
import { AgentInvoker } from "agent-cli";
import { AgentRunner, RunLedger, startRunLedgerEffect } from "agent-server";
import { AgentRunError } from "core";
import type { AgentRequest, AgentResponse } from "core";
import { Config, type ConfigError, Data, Effect, Layer, Option } from "effect";
import { LoggerTag } from "logger";

import { resolveOpenhandsMcpConfig } from "./mcp-config.ts";

/** Default workspace root, shared with the composition root's workspace-dir resolver. */
export const DEFAULT_AGENT_BASE_DIR = "/workspace/openhands-agent";

const AGENT_ID = "openhands-agent";

/**
 * An openhands run failed before producing a result: the workspace dir could not be
 * created, or the invoker failed in its error channel (today only the LiteLLM model
 * check — timeouts and spawn failures resolve as structured exit-124/exit-1 results).
 * Local to this app; mapped to core's `AgentRunError` at the `AgentRunner` port boundary.
 */
export class OpenhandsRunError extends Data.TaggedError("OpenhandsRunError")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

// Env resolved once at layer build (the Effect sibling of index.ts's process.env reads).
const openhandsConfig = Effect.gen(function* () {
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
  // Optional OpenHands MCP config source (workflow-mcp, github, dapr, obs). When set, each run
  // provisions it into a per-run HOME so the CLI reads it ($HOME/.openhands/mcp.json). Unset →
  // no MCP servers (the legacy behaviour), so this is backward-compatible.
  const mcpConfigSrc = yield* Config.option(Config.string("MCP_CONFIG_SRC"));
  return { apiKey, baseUrl, model, baseDir, runsDir, daprHttpPort, mcpConfigSrc };
});

/**
 * `AgentRunner` implementation layer (Phase 5 of the Effect migration — see
 * plans/effect-refactor-map.md). All collaborators (invoker, run ledger, logger,
 * FileSystem) are captured at layer build so the port method stays `R = never`.
 */
export const OpenhandsRunnerLive: Layer.Layer<
  AgentRunner,
  ConfigError.ConfigError,
  AgentInvoker | RunLedger | LoggerTag | FileSystem.FileSystem
> = Layer.effect(
  AgentRunner,
  Effect.gen(function* () {
    const cfg = yield* openhandsConfig;
    const invoker = yield* AgentInvoker;
    const ledger = yield* RunLedger;
    const logger = yield* LoggerTag;
    const fs = yield* FileSystem.FileSystem;

    const run = (request: AgentRequest): Effect.Effect<AgentResponse, OpenhandsRunError> =>
      Effect.gen(function* () {
        const { input, systemPrompt, workflowInstanceId, workspaceId } = request;
        // A workspaceId pins a reusable workspace dir; without one, fall back to the per-run instance id.
        const workspaceKey = workspaceId ?? workflowInstanceId;
        const cwd = workspaceKey ? join(cfg.baseDir, workspaceKey) : cfg.baseDir;
        // Own the workspace dir so a run works without a preceding setup step (spawning with a
        // non-existent cwd fails as `spawn openhands ENOENT`, which masquerades as a missing binary).
        if (workspaceKey) {
          yield* fs
            .makeDirectory(cwd, { recursive: true })
            .pipe(Effect.mapError((cause) => new OpenhandsRunError({ cause })));
        }

        // Provision the OpenHands MCP config (workflow-mcp, github, dapr, obs) into a per-run HOME.
        // OpenHands reads $HOME/.openhands/mcp.json (global, HOME-keyed) — unlike the claude CLI,
        // which reads .mcp.json from cwd — so HOME points at a dir OUTSIDE the workspace (the agent
        // never commits its .openhands state) and we write the resolved config there before spawn.
        const mcpEnv: Record<string, string> = {};
        const mcpConfigSrc = Option.getOrUndefined(cfg.mcpConfigSrc);
        if (mcpConfigSrc) {
          const homeDir = join(cfg.baseDir, ".oh-home", workspaceKey ?? "default");
          const ohDir = join(homeDir, ".openhands");
          const source = yield* fs
            .readFileString(mcpConfigSrc)
            .pipe(Effect.mapError((cause) => new OpenhandsRunError({ cause })));
          const resolved = resolveOpenhandsMcpConfig(source, process.env);
          yield* fs
            .makeDirectory(ohDir, { recursive: true })
            .pipe(Effect.mapError((cause) => new OpenhandsRunError({ cause })));
          yield* fs
            .writeFileString(join(ohDir, "mcp.json"), resolved)
            .pipe(Effect.mapError((cause) => new OpenhandsRunError({ cause })));
          mcpEnv["HOME"] = homeDir;
        }

        const log = yield* logger.child({ workflowInstanceId, workspaceId, agent: "openhands" });

        const handle = yield* startRunLedgerEffect({
          agentId: AGENT_ID,
          runsDir: cfg.runsDir,
          workflowInstanceId,
          workspaceId,
          workspacePath: cwd,
          input,
          daprHttpPort: Option.getOrUndefined(cfg.daprHttpPort),
        }).pipe(Effect.provideService(RunLedger, ledger));

        const result = yield* invoker
          .invoke({
            systemPrompt: systemPrompt ?? "",
            taskPrompt: input,
            cwd,
            env: {
              ...(workflowInstanceId ? { WORKFLOW_INSTANCE_ID: workflowInstanceId } : {}),
              ...mcpEnv,
            },
            timeout: 300_000,
            model: cfg.model,
            llmConfig: { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl },
            // The invoker delivers events on a sync callback; the logger effect is a sync
            // Pino write, run in place so event order matches the ledger append chain.
            onEvent: (event) => {
              Effect.runSync(log.info(event, "agent output"));
              handle.onEvent(event);
            },
          })
          .pipe(
            Effect.withSpan("openhands cli", { attributes: { "openhands.model": cfg.model } }),
            Effect.mapError((cause) => new OpenhandsRunError({ cause })),
            // The legacy try/catch also caught unexpected throws — keep defects on the same
            // failed-ledger-then-500 path instead of letting them skip the ledger write.
            Effect.catchAllDefect((cause) => Effect.fail(new OpenhandsRunError({ cause }))),
            Effect.tapError((err) =>
              handle.finish({ status: "failed", output: "", error: String(err.cause) }),
            ),
          );

        const summary = yield* handle.finish({
          status: "completed",
          output: result.stdout,
          sessionId: result.sessionId ?? null,
          model: result.model ?? cfg.model,
          turns: result.numTurns ?? 1,
          tokens: result.tokenUsage ?? { input: 0, output: 0 },
          costUsd: result.costUsd ?? null,
        });

        return {
          output: result.stdout,
          sessionId: result.sessionId ?? null,
          usage: result.tokenUsage ?? { input: 0, output: 0 },
          model: result.model ?? cfg.model,
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
