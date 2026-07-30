import { join } from "path";

import { FileSystem } from "@effect/platform";
import { AgentInvoker, toolCallTallyFor } from "agent-cli";
import { AgentRunner, RunLedger, type RunOutcome, startRunLedgerEffect } from "agent-server";
import { AgentRunError, provisionMcpConfig } from "core";
import type { AgentRequest, AgentResponse } from "core";
import { Cause, Config, Effect, Layer, Option } from "effect";

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
  // "replace" overwrites the cwd's servers entirely (a minimal-surface posture); default "merge".
  // Config.literal makes any other value a typed startup failure — this knob is a security
  // boundary, so a typo must fail closed at boot, never silently fall back to merge.
  mcpConfigMode: Config.literal(
    "merge",
    "replace",
  )("MCP_CONFIG_MODE").pipe(Config.withDefault("merge" as const)),
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
  mcpConfigMode: "merge" | "replace";
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
      mcpConfigMode: raw.mcpConfigMode,
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

    // claude auto-discovers .mcp.json in its cwd; provision it per the configured mode
    // (see provisionMcpConfig).
    if ((cwdOverride || workspaceKey) && (yield* fs.exists(cwd))) {
      yield* provisionMcpConfig(cwd, cfg.mcpConfigSrc, cfg.mcpConfigMode);
    }

    const ledger = yield* startRunLedgerEffect({
      agentId: AGENT_ID,
      runsDir: cfg.runsDir,
      workflowInstanceId,
      workspaceId,
      workspacePath: cwd,
      input,
      daprHttpPort: cfg.daprHttpPort,
      // This agent's OWN tool-call tally — the claude CLI's shape is verified, so the ledger
      // may report a real number. Agents without a verified shape pass nothing and record
      // `toolCalls: null` (unknown) rather than a misleading 0.
      tallyToolCalls: toolCallTallyFor("claude"),
    });

    // From here on a failure records a failed ledger entry before surfacing (the same scope as
    // the legacy try/catch — failures before the ledger starts never wrote one).
    // Captures stdout from a partial result so the failed ledger entry preserves agent output
    // (the invoker result is not in scope of tapErrorCause below).
    let capturedOutput = "";
    // Captured so BOTH ledger paths (completed + failed) record why the run stopped — a usage-limit
    // may surface as exit 0 (completed) or non-zero (failed); either way the watcher reads it.
    let capturedStopReason: string | undefined;
    // Metrics captured before the nonzero-exit failure below, so the failure-path ledger finish
    // records what the run DID spend instead of dropping it (docs/plans/cost-containment.md B1).
    let capturedMetrics: Partial<
      Pick<RunOutcome, "costUsd" | "costPartial" | "tokens" | "model" | "turns">
    > = {};
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

      capturedOutput = result.stdout ?? "";
      capturedStopReason = result.stopReason;
      capturedMetrics = {
        costUsd: result.costUsd ?? null,
        costPartial: result.costPartial ?? null,
        tokens: result.tokenUsage ?? null,
        model: result.model ?? null,
        turns: result.numTurns ?? null,
      };

      // A resolved InvocationResult may carry a non-zero exit code (timeout → 124,
      // spawn failure → 1, or the agent itself exited with an error). Fail here so the
      // outer tapErrorCause records the ledger entry and the workflow step doesn't
      // silently succeed.
      if (result.exitCode !== undefined && result.exitCode !== 0) {
        return yield* Effect.fail(
          new Error(result.stderr ?? `Agent exited with code ${result.exitCode}`),
        );
      }

      const summary = yield* ledger.finish({
        status: "completed",
        output: result.stdout ?? "",
        sessionId: result.sessionId ?? null,
        model: result.model ?? cfg.model,
        turns: result.numTurns ?? 1,
        tokens: result.tokenUsage ?? { input: 0, output: 0 },
        costUsd: result.costUsd ?? null,
        costPartial: result.costPartial ?? null,
        // Orthogonal to status: a usage-limited run can still be "completed" (Claude exits 0).
        stopReason: result.stopReason ?? null,
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
        ledger.finish({
          status: "failed",
          output: capturedOutput,
          error: String(Cause.squash(cause)),
          // A usage-limit that surfaced as a non-zero exit is still recorded, so the watcher's
          // fallback can distinguish it from a generic failure on a FAILED instance.
          stopReason: capturedStopReason ?? null,
          ...capturedMetrics,
        }),
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
