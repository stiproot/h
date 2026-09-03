import { join } from "path";

import { FileSystem } from "@effect/platform";
import { AgentInvoker, toolCallTallyFor } from "agent-cli";
import type { QuotaReport } from "agent-cli";
import { AgentRunner, RunLedger, type RunOutcome, startRunLedgerEffect } from "agent-server";
import { AgentRunError, provisionMcpConfig } from "core";
import type { AgentRequest, AgentResponse } from "core";
import { Cause, Config, Effect, Layer, Option } from "effect";

const AGENT_ID = "kimi-agent";

const DEFAULT_RUN_TIMEOUT_MS = 1_800_000;

// Custom Config schema — reads MOONSHOT_API_KEY as ANTHROPIC_AUTH_TOKEN
// and KIMI_ANTHROPIC_URL (not ANTHROPIC_BASE_URL) to avoid collision with
// the user's existing Anthropic base URL. Never constructs an llmConfig object,
// so adaptToLiteLlmEffect short-circuits at litellm.ts:27 (!llmConfig?.baseUrl).
const kimiRunnerConfig = Config.all({
  baseDir: Config.string("AGENT_BASE_DIR").pipe(Config.withDefault("/workspace/kimi-agent")),
  model: Config.string("AGENT_MODEL").pipe(Config.withDefault("kimi-k3")),
  moonShotApiKey: Config.string("ANTHROPIC_AUTH_TOKEN"),
  kimiAnthropicUrl: Config.string("KIMI_ANTHROPIC_URL").pipe(
    Config.withDefault("https://api.moonshot.ai/anthropic"),
  ),
  runsDir: Config.option(Config.string("AGENT_RUNS_DIR")),
  mcpConfigSrc: Config.option(Config.string("MCP_CONFIG_SRC")),
  mcpConfigMode: Config.literal(
    "merge",
    "replace",
  )("MCP_CONFIG_MODE").pipe(Config.withDefault("merge" as const)),
  runTimeoutMs: Config.number("AGENT_RUN_TIMEOUT_MS").pipe(
    Config.withDefault(DEFAULT_RUN_TIMEOUT_MS),
  ),
  daprHttpPort: Config.option(Config.string("DAPR_HTTP_PORT")),
});

type KimiRunnerConfig = {
  baseDir: string;
  model: string;
  moonShotApiKey: string;
  kimiAnthropicUrl: string;
  runsDir: string;
  mcpConfigSrc: string;
  mcpConfigMode: "merge" | "replace";
  runTimeoutMs: number;
  daprHttpPort: string | undefined;
};

const resolveConfig = kimiRunnerConfig.pipe(
  Effect.map(
    (raw): KimiRunnerConfig => ({
      baseDir: raw.baseDir,
      model: raw.model,
      moonShotApiKey: raw.moonShotApiKey,
      kimiAnthropicUrl: raw.kimiAnthropicUrl,
      runsDir: Option.getOrElse(raw.runsDir, () => join(raw.baseDir, "..", ".runs")),
      mcpConfigSrc: Option.getOrElse(raw.mcpConfigSrc, () => join(raw.baseDir, ".mcp.json")),
      mcpConfigMode: raw.mcpConfigMode,
      runTimeoutMs: raw.runTimeoutMs,
      daprHttpPort: Option.getOrUndefined(raw.daprHttpPort),
    }),
  ),
);

// Custom run flow — injects credentials into child env dict, NOT into llmConfig.
// llmConfig is intentionally absent so adaptToLiteLlmEffect returns immediately.
const runKimi = (
  cfg: KimiRunnerConfig,
  request: AgentRequest,
): Effect.Effect<AgentResponse, unknown, AgentInvoker | RunLedger | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const {
      input,
      systemPrompt,
      sessionId,
      workflowInstanceId,
      workspaceId,
      cwd: cwdOverride,
      model: modelOverride,
      permissionMode,
    } = request;
    const fs = yield* FileSystem.FileSystem;

    const workspaceKey = workspaceId ?? workflowInstanceId;
    const cwd =
      cwdOverride ?? (workspaceKey ? join(cfg.baseDir, "workspaces", workspaceKey) : cfg.baseDir);

    if (cwdOverride || workspaceKey) yield* fs.makeDirectory(cwd, { recursive: true });

    if ((cwdOverride || workspaceKey) && (yield* fs.exists(cwd))) {
      yield* provisionMcpConfig(cwd, cfg.mcpConfigSrc, cfg.mcpConfigMode);
    }

    const model = modelOverride ?? cfg.model;

    const ledger = yield* startRunLedgerEffect({
      agentId: AGENT_ID,
      runsDir: cfg.runsDir,
      workflowInstanceId,
      workspaceId,
      workspacePath: cwd,
      input,
      daprHttpPort: cfg.daprHttpPort,
      tallyToolCalls: toolCallTallyFor("claude"),
    });

    let capturedOutput = "";
    let capturedStopReason: string | undefined;
    let capturedQuota: QuotaReport | undefined;
    // Metrics captured before the nonzero-exit failure below, so the failure-path ledger finish
    // records what the run DID spend instead of dropping it (the cost-containment fix:
    // failed/timed-out runs used to ledger costUsd: null even when usage was known).
    let capturedMetrics: Partial<
      Pick<RunOutcome, "costUsd" | "costPartial" | "tokens" | "model" | "turns">
    > = {};
    return yield* Effect.gen(function* () {
      const invoker = yield* AgentInvoker;
      const result = yield* invoker
        .invoke({
          systemPrompt: systemPrompt ?? "",
          taskPrompt: input,
          cwd,
          env: {
            // Explicitly blank to override any ambient ANTHROPIC_API_KEY in the container.
            // mergeProcessEnv is { ...process.env, ...env } so the explicit dict wins.
            ANTHROPIC_API_KEY: "",
            ANTHROPIC_BASE_URL: cfg.kimiAnthropicUrl,
            ANTHROPIC_AUTH_TOKEN: cfg.moonShotApiKey,
            ANTHROPIC_MODEL: model,
            ANTHROPIC_DEFAULT_OPUS_MODEL: model,
            ANTHROPIC_DEFAULT_SONNET_MODEL: model,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
            ANTHROPIC_DEFAULT_FABLE_MODEL: model,
            CLAUDE_CODE_SUBAGENT_MODEL: model,
            ENABLE_TOOL_SEARCH: "false",
            CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1048576",
            ...(workflowInstanceId ? { WORKFLOW_INSTANCE_ID: workflowInstanceId } : {}),
          },
          timeout: cfg.runTimeoutMs,
          model,
          permissionMode,
          resumeSessionId: sessionId ?? undefined,
          onEvent: ledger.onEvent,
          // llmConfig intentionally absent — adaptToLiteLlmEffect bails on !llmConfig?.baseUrl
        })
        .pipe(Effect.withSpan("kimi cli", { attributes: { "kimi.model": model } }));

      capturedOutput = result.stdout ?? "";
      capturedStopReason = result.stopReason;
      capturedQuota = result.quota;
      capturedMetrics = {
        costUsd: result.costUsd ?? null,
        costPartial: result.costPartial ?? null,
        tokens: result.tokenUsage ?? null,
        model: result.model ?? null,
        turns: result.numTurns ?? null,
      };

      if (result.exitCode !== undefined && result.exitCode !== 0) {
        return yield* Effect.fail(
          new Error(result.stderr ?? `Agent exited with code ${result.exitCode}`),
        );
      }

      const summary = yield* ledger.finish({
        status: "completed",
        output: result.stdout ?? "",
        sessionId: result.sessionId ?? null,
        model: result.model ?? model,
        turns: result.numTurns ?? 1,
        tokens: result.tokenUsage ?? { input: 0, output: 0 },
        costUsd: result.costUsd ?? null,
        costPartial: result.costPartial ?? null,
        stopReason: result.stopReason ?? null,
        // The account's rate-limit windows as the CLI reported them — the watcher folds this
        // into the `quota:` registry at finalize, which is what the pre-fire gate reads.
        quota: result.quota ?? null,
      });

      return {
        output: result.stdout ?? "",
        sessionId: result.sessionId ?? null,
        usage: result.tokenUsage ?? { input: 0, output: 0 },
        model: result.model ?? model,
        turns: result.numTurns ?? 1,
        costUsd: result.costUsd,
        toolCalls: summary.toolCalls,
        runId: summary.runId,
      } satisfies AgentResponse;
    }).pipe(
      Effect.tapErrorCause((cause) =>
        ledger.finish({
          status: "failed",
          output: capturedOutput,
          error: String(Cause.squash(cause)),
          stopReason: capturedStopReason ?? null,
          quota: capturedQuota ?? null,
          ...capturedMetrics,
        }),
      ),
    );
  });

export const KimiRunnerLive: Layer.Layer<
  AgentRunner,
  never,
  AgentInvoker | RunLedger | FileSystem.FileSystem
> = Layer.effect(
  AgentRunner,
  Effect.gen(function* () {
    const cfg = yield* Effect.orDie(resolveConfig);
    const context = yield* Effect.context<AgentInvoker | RunLedger | FileSystem.FileSystem>();
    return {
      run: (request: AgentRequest) =>
        runKimi(cfg, request).pipe(
          Effect.provide(context),
          Effect.mapError((cause) => new AgentRunError({ cause, agentId: AGENT_ID })),
        ),
    };
  }),
);
