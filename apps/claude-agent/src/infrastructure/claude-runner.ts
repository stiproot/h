import { join } from "path";

import { FileSystem } from "@effect/platform";
import { AgentInvoker } from "agent-cli";
import { AgentRunner, RunLedger, startRunLedgerEffect } from "agent-server";
import { AgentRunError } from "core";
import type { AgentRequest, AgentResponse } from "core";
import { Cause, Config, Effect, Layer, Option } from "effect";

import { mergeMcpConfig } from "./mcp-config.ts";

const AGENT_ID = "claude-agent";

// Max wall-clock for one agent CLI run. Real code work (explore a repo, edit several files, run
// tests) routinely exceeds the old 5-minute cap, so default to 30 minutes — generous but still well
// under the 1h Dapr resiliency timeout on agent activities. Override with AGENT_RUN_TIMEOUT_MS.
const DEFAULT_RUN_TIMEOUT_MS = 1_800_000;

// Env surface of the runner, resolved once at layer build (a malformed value — e.g. a
// non-numeric AGENT_RUN_TIMEOUT_MS — is a typed startup failure, not a silent NaN).
const claudeRunnerConfig = Config.all({
  baseDir: Config.string("AGENT_BASE_DIR").pipe(Config.withDefault("/workspace/claude-agent")),
  model: Config.string("AGENT_MODEL").pipe(Config.withDefault("claude-sonnet-4-6")),
  apiKey: Config.string("ANTHROPIC_API_KEY").pipe(Config.withDefault("")),
  baseUrl: Config.string("ANTHROPIC_BASE_URL"),
  // Shared run-ledger root, visible to every agent and the host (defaults to a sibling of baseDir).
  runsDir: Config.option(Config.string("AGENT_RUNS_DIR")),
  // Source .mcp.json merged into each run's cwd (defaults to the file mounted at baseDir).
  mcpConfigSrc: Config.option(Config.string("MCP_CONFIG_SRC")),
  runTimeoutMs: Config.number("AGENT_RUN_TIMEOUT_MS").pipe(
    Config.withDefault(DEFAULT_RUN_TIMEOUT_MS),
  ),
  // Dapr sidecar HTTP port; when set, the run ledger mirrors records to the statestore.
  daprHttpPort: Config.option(Config.string("DAPR_HTTP_PORT")),
});

type ClaudeRunnerConfig = {
  baseDir: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  runsDir: string;
  mcpConfigSrc: string;
  runTimeoutMs: number;
  daprHttpPort: string | undefined;
};

const resolveConfig = claudeRunnerConfig.pipe(
  Effect.map(
    (raw): ClaudeRunnerConfig => ({
      baseDir: raw.baseDir,
      model: raw.model,
      apiKey: raw.apiKey,
      baseUrl: raw.baseUrl,
      runsDir: Option.getOrElse(raw.runsDir, () => join(raw.baseDir, "..", ".runs")),
      mcpConfigSrc: Option.getOrElse(raw.mcpConfigSrc, () => join(raw.baseDir, ".mcp.json")),
      runTimeoutMs: raw.runTimeoutMs,
      daprHttpPort: Option.getOrUndefined(raw.daprHttpPort),
    }),
  ),
);

// The full run flow as one Effect: resolve the workspace dir, provision it, merge the MCP
// config, start the run ledger, invoke the claude CLI, and assemble the response. Failures
// stay raw here (PlatformError, LiteLLM tags, a merge parse throw) — the port boundary in
// `ClaudeRunnerLive` wraps them all into core's `AgentRunError`, whose `cause` carries the
// original error so the HTTP reply message matches the pre-Effect throw.
const runClaude = (
  cfg: ClaudeRunnerConfig,
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

    // A workspaceId pins a reusable workspace dir; without one, fall back to the per-run instance id.
    // An explicit cwd (e.g. a shared worktree) overrides both so several agents share one checkout.
    const workspaceKey = workspaceId ?? workflowInstanceId;
    const cwd =
      cwdOverride ?? (workspaceKey ? join(cfg.baseDir, "workspaces", workspaceKey) : cfg.baseDir);

    // Own the workspace dir so a run works without a preceding setup/clone step (spawning with a
    // non-existent cwd fails as `spawn … ENOENT`, which masquerades as a missing binary).
    if (cwdOverride || workspaceKey) yield* fs.makeDirectory(cwd, { recursive: true });

    // claude auto-discovers .mcp.json in its cwd. Merge h's MCP servers into whatever .mcp.json
    // the cwd already has (e.g. a worktree of a repo that ships its own), creating it when absent, so
    // every run has h's servers without clobbering the project's.
    if ((cwdOverride || workspaceKey) && (yield* fs.exists(cwd))) {
      const mcpDest = join(cwd, ".mcp.json");
      if (yield* fs.exists(cfg.mcpConfigSrc)) {
        const existing = (yield* fs.exists(mcpDest)) ? yield* fs.readFileString(mcpDest) : null;
        const incoming = yield* fs.readFileString(cfg.mcpConfigSrc);
        const merged = yield* Effect.try({
          try: () => mergeMcpConfig(existing, incoming),
          catch: (cause) => cause,
        });
        yield* fs.writeFileString(mcpDest, merged);
      }
    }

    const ledger = yield* startRunLedgerEffect({
      agentId: AGENT_ID,
      runsDir: cfg.runsDir,
      workflowInstanceId,
      workspaceId,
      workspacePath: cwd,
      input,
      daprHttpPort: cfg.daprHttpPort,
    });

    // From here on a failure records a failed ledger entry before surfacing (the same scope as
    // the legacy try/catch — failures before the ledger starts never wrote one).
    return yield* Effect.gen(function* () {
      const invoker = yield* AgentInvoker;
      const model = modelOverride ?? cfg.model;
      const result = yield* invoker
        .invoke({
          systemPrompt: systemPrompt ?? "",
          taskPrompt: input,
          cwd,
          env: workflowInstanceId ? { WORKFLOW_INSTANCE_ID: workflowInstanceId } : {},
          timeout: cfg.runTimeoutMs,
          model,
          permissionMode,
          resumeSessionId: sessionId ?? undefined,
          onEvent: ledger.onEvent,
          llmConfig: { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl },
        })
        .pipe(Effect.withSpan("claude cli", { attributes: { "claude.model": model } }));

      const summary = yield* ledger.finish({
        status: "completed",
        output: result.stdout ?? "",
        sessionId: result.sessionId ?? null,
        model: result.model ?? cfg.model,
        turns: result.numTurns ?? 1,
        tokens: result.tokenUsage ?? { input: 0, output: 0 },
        costUsd: result.costUsd ?? null,
      });

      return {
        output: result.stdout ?? "",
        sessionId: result.sessionId ?? null,
        usage: result.tokenUsage ?? { input: 0, output: 0 },
        model: result.model ?? cfg.model,
        turns: result.numTurns ?? 1,
        costUsd: result.costUsd,
        toolCalls: summary.toolCalls,
        runId: summary.runId,
      } satisfies AgentResponse;
    }).pipe(
      // tapErrorCause, not tapError: the legacy try/catch caught every throw, so defects must
      // also record a failed ledger entry before surfacing. Cause.squash recovers the original
      // error for the same `String(err)` ledger message as before.
      Effect.tapErrorCause((cause) =>
        ledger.finish({ status: "failed", output: "", error: String(Cause.squash(cause)) }),
      ),
    );
  });

/**
 * The `AgentRunner` implementation for the claude CLI, as a Layer. Config comes from the
 * environment at layer build; `AgentInvoker`, `RunLedger`, and `FileSystem` are captured
 * from the layer's context so the port method stays `R = never`. Every failure is wrapped
 * into core's `AgentRunError` at this boundary (its `cause` keeps the original message for
 * the HTTP reply and the ledger, matching the pre-Effect runner's rethrow).
 */
export const ClaudeRunnerLive: Layer.Layer<
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
        runClaude(cfg, request).pipe(
          Effect.provide(context),
          Effect.mapError((cause) => new AgentRunError({ cause, agentId: AGENT_ID })),
        ),
    };
  }),
);
