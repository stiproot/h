import type { CommandExecutor, HttpClient } from "@effect/platform";
import { Context, Effect, Layer } from "effect";

import type {
  AgentEnv,
  AgentEventCallback,
  AgentInvocationRequest,
  AgentStrategy,
  InvocationResult,
  LiteLlmError,
  LlmConfig,
} from "./agents/types.ts";
import { AGENT_ENV_KEYS } from "./agents/types.ts";
import { claudeStrategy } from "./agents/claude.ts";
import { openhandsStrategy } from "./agents/openhands.ts";
import { piStrategy } from "./agents/pi.ts";
import { runAgentProcessEffect } from "./agents/run-process.ts";
import { createLogger } from "./lib/logger.ts";

/** Input for one agent CLI invocation via the {@link AgentInvoker} service. */
export interface AgentInvokeParams {
  systemPrompt: string;
  taskPrompt: string;
  cwd: string;
  env: Record<string, string>;
  timeout: number;
  /** Model to use for this invocation */
  model?: string;
  /** Resume an existing session instead of starting a new one */
  resumeSessionId?: string;
  /** Optional callback for streaming events (for sys-log.jsonl) */
  onEvent?: AgentEventCallback;
  /** Enable verbose debug output */
  verbose?: boolean;
  /** LLM provider configuration from job config */
  llmConfig?: LlmConfig;
  /** "plan" → invoke the CLI read-only via --permission-mode plan instead of skip-permissions */
  permissionMode?: "plan";
}

/**
 * Port: invoke an agent CLI subprocess and produce its run result.
 *
 * Failure channel carries only the LiteLLM model-check errors — the legacy
 * contract resolved (never rejected) on timeout (exit 124), spawn failure
 * (exit 1), missing command (exit 127), and non-zero exits, and the Effect
 * version preserves that by folding those cases into the `InvocationResult`.
 */
export interface AgentInvokerService {
  readonly invoke: (params: AgentInvokeParams) => Effect.Effect<InvocationResult, LiteLlmError>;
}

export class AgentInvoker extends Context.Tag("agent-cli/AgentInvoker")<
  AgentInvoker,
  AgentInvokerService
>() {}

/**
 * Build an {@link AgentInvoker} layer for a strategy. `CommandExecutor` (and
 * `HttpClient`, for the LiteLLM check) are captured at layer build so the port
 * methods stay `R = never`; consumers provide `NodeContext.layer` and an
 * `HttpClient` layer (e.g. `NodeHttpClient.layer` or `FetchHttpClient.layer`).
 */
export const layerAgentInvoker = (
  strategy: AgentStrategy,
): Layer.Layer<AgentInvoker, never, CommandExecutor.CommandExecutor | HttpClient.HttpClient> =>
  Layer.effect(
    AgentInvoker,
    Effect.gen(function* () {
      const context = yield* Effect.context<
        CommandExecutor.CommandExecutor | HttpClient.HttpClient
      >();
      return {
        invoke: (params: AgentInvokeParams) =>
          invokeAgent(strategy, params).pipe(Effect.provide(context)),
      };
    }),
  );

export const ClaudeInvokerLive: Layer.Layer<
  AgentInvoker,
  never,
  CommandExecutor.CommandExecutor | HttpClient.HttpClient
> = layerAgentInvoker(claudeStrategy);

export const OpenhandsInvokerLive: Layer.Layer<
  AgentInvoker,
  never,
  CommandExecutor.CommandExecutor | HttpClient.HttpClient
> = layerAgentInvoker(openhandsStrategy);

export const PiInvokerLive: Layer.Layer<
  AgentInvoker,
  never,
  CommandExecutor.CommandExecutor | HttpClient.HttpClient
> = layerAgentInvoker(piStrategy);

function invokeAgent(
  strategy: AgentStrategy,
  params: AgentInvokeParams,
): Effect.Effect<
  InvocationResult,
  LiteLlmError,
  CommandExecutor.CommandExecutor | HttpClient.HttpClient
> {
  return Effect.suspend(() => {
    const mergedEnv = mergeProcessEnv(params.env);
    const request: AgentInvocationRequest = {
      systemPrompt: params.systemPrompt,
      taskPrompt: params.taskPrompt,
      cwd: params.cwd,
      env: mergedEnv,
      effectiveEnv: extractAgentEnv(mergedEnv),
      timeout: params.timeout,
      model: params.model,
      resumeSessionId: params.resumeSessionId,
      onEvent: params.onEvent,
      verbose: params.verbose,
      llmConfig: params.llmConfig,
      permissionMode: params.permissionMode,
    };
    const log = createLogger(params.verbose ?? false);

    return runAgentProcessEffect(strategy, request, log);
  }).pipe(
    // Behaviour flag (plan §6): a timeout must not fail the call — it resolves
    // the legacy exit-124 structured result. Spawn failures likewise resolved
    // as exit-1 results.
    Effect.catchTags({
      AgentTimeoutError: (error) =>
        Effect.succeed<InvocationResult>({
          success: false,
          stdout: `Task timed out after ${error.timeoutMs}ms`,
          stderr: "Task timed out",
          exitCode: 124,
        }),
      AgentSpawnError: (error) =>
        Effect.succeed<InvocationResult>({
          success: false,
          stdout: `Failed to spawn ${error.command}: ${describeCause(error.cause)}`,
          stderr: describeCause(error.cause),
          exitCode: 1,
        }),
    }),
  );
}

function mergeProcessEnv(env: Record<string, string>): Record<string, string> {
  return Object.entries({ ...process.env, ...env }).reduce<Record<string, string>>(
    (acc, [key, value]) => {
      if (value !== undefined) acc[key] = value;
      return acc;
    },
    {},
  );
}

function describeCause(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    return String((cause as { message: unknown }).message);
  }
  return String(cause);
}

function extractAgentEnv(sourceEnv: Record<string, string | undefined>): AgentEnv {
  const effectiveEnv: AgentEnv = {};

  for (const key of AGENT_ENV_KEYS) {
    const value = sourceEnv[key];
    if (value !== undefined) effectiveEnv[key] = value;
  }

  return effectiveEnv;
}
