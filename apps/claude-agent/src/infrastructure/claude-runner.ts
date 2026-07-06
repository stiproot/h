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
  // "replace" overwrites the cwd's servers entirely (the claude-coder posture); default "merge".
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

/**
 * Provisions the run cwd's `.mcp.json` from `src` per `mode` (exported for tests):
 *
 * - `merge`: h's servers merge into whatever `.mcp.json` the cwd already has (the project's
 *   own servers and top-level keys survive; h's win on a name conflict). A missing `src` is
 *   skipped — merge mode is a convenience, not a guarantee.
 * - `replace`: the cwd's config is discarded entirely and only `src`'s servers survive — the
 *   claude-coder posture, where the cwd is a target repo whose `.mcp.json` must never reach
 *   the agent executing untrusted specs. Fails CLOSED: a missing `src` is a defect (the run
 *   aborts loudly), because silently skipping the rewrite would leave the target repo's own
 *   servers — potentially h's control-plane set — in place.
 */
export const provisionMcpConfig = (
  cwd: string,
  src: string,
  mode: "merge" | "replace",
): Effect.Effect<void, unknown, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const mcpDest = join(cwd, ".mcp.json");
    if (!(yield* fs.exists(src))) {
      if (mode === "replace") {
        return yield* Effect.dieMessage(
          `MCP_CONFIG_MODE=replace requires MCP_CONFIG_SRC to exist; missing: ${src}`,
        );
      }
      return;
    }
    // Replace mode never reads the cwd config it would discard.
    const existing =
      mode === "replace"
        ? null
        : (yield* fs.exists(mcpDest))
          ? yield* fs.readFileString(mcpDest)
          : null;
    const incoming = yield* fs.readFileString(src);
    const merged = yield* Effect.try({
      try: () => mergeMcpConfig(existing, incoming, mode),
      catch: (cause) => cause,
    });
    yield* fs.writeFileString(mcpDest, merged);
  });

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
