import { statSync } from "node:fs";

import type { CommandExecutor, HttpClient } from "@effect/platform";
import { Context, Effect, Layer, Logger, LogLevel } from "effect";

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
import { codexStrategy } from "./agents/codex.ts";
import { openhandsStrategy } from "./agents/openhands.ts";
import { piStrategy } from "./agents/pi.ts";
import { runAgentProcessEffect } from "./agents/run-process.ts";

/** Input for one agent CLI invocation via the {@link AgentInvoker} service. */
export interface AgentInvokeParams {
  systemPrompt: string;
  taskPrompt: string;
  cwd: string;
  env: Record<string, string>;
  timeout: number;
  model?: string;
  resumeSessionId?: string;
  onEvent?: AgentEventCallback;
  verbose?: boolean;
  llmConfig?: LlmConfig;
  /** "plan" → read-only mode; omit for skip-permissions */
  permissionMode?: "plan";
}

/** Invoke an agent CLI subprocess. Timeouts (exit 124), spawn failures (exit 1 —
 * including a missing `cwd`, which the platform reports indistinguishably from a
 * missing binary), and missing commands (exit 127) are folded into
 * `InvocationResult` — the error channel carries only LiteLLM model-check errors. */
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

export const CodexInvokerLive: Layer.Layer<
  AgentInvoker,
  never,
  CommandExecutor.CommandExecutor | HttpClient.HttpClient
> = layerAgentInvoker(codexStrategy);

function invokeAgent(
  strategy: AgentStrategy,
  params: AgentInvokeParams,
): Effect.Effect<
  InvocationResult,
  LiteLlmError,
  CommandExecutor.CommandExecutor | HttpClient.HttpClient
> {
  const baseEffect = Effect.suspend(() => {
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

    return runAgentProcessEffect(strategy, request);
  }).pipe(
    // Behaviour flag: a timeout must not fail the call — run-process resolves it as an exit-124
    // structured result built from the events collected so far (partial usage capture, B1). Spawn
    // failures resolved as exit-1 results (exit-127 when the command is not found).
    Effect.catchTags({
      AgentSpawnError: (error) => Effect.succeed(describeSpawnFailure(error)),
    }),
  );

  return params.verbose ? baseEffect.pipe(Logger.withMinimumLogLevel(LogLevel.Debug)) : baseEffect;
}

/**
 * Turn a spawn failure into a result that names the ACTUAL cause.
 *
 * The platform reports both a missing EXECUTABLE and a missing WORKING DIRECTORY as the same
 * `SystemError`/`NotFound` — so blaming the binary unconditionally makes a bad cwd masquerade as an
 * uninstalled CLI, which is unfalsifiable from the outside (it bit a local-substrate run: a member
 * died in 8ms with "Command 'claude' not found" while `claude` was on PATH the whole time). Stat the
 * cwd first: it is the one half we can check cheaply and decisively, so a NotFound with a healthy cwd
 * is genuinely the binary.
 */
function describeSpawnFailure(error: {
  command: string;
  cwd: string;
  cause: unknown;
}): InvocationResult {
  const base = { success: false, stopReason: "failed" } as const;

  // The cwd is checked FIRST and for every spawn failure, not just NotFound: when the directory the
  // child was to run in is broken, that is the most actionable fact whatever errno the platform
  // chose (ENOENT arrives as a NotFound event, ENOTDIR as a synchronous throw).
  const cwdProblem = checkCwd(error.cwd);
  if (cwdProblem !== null) {
    return {
      ...base,
      stdout: `${cwdProblem}: ${error.cwd}. ${error.command} was never spawned.`,
      stderr: `${cwdProblem}: '${error.cwd}'`,
      // NOT 127 — the shell's "command not found" would be a lie about a cwd we just proved wrong.
      exitCode: 1,
    };
  }

  if (isPlatformNotFoundError(error.cause)) {
    return {
      ...base,
      stdout: `Command not found: ${error.command}. Ensure the CLI is installed and in PATH.`,
      stderr: `Command '${error.command}' not found`,
      exitCode: 127,
    };
  }

  return {
    ...base,
    stdout: `Failed to spawn ${error.command}: ${describeCause(error.cause)}`,
    stderr: describeCause(error.cause),
    exitCode: 1,
  };
}

/** `null` when the cwd is a usable directory, else the problem with it. */
function checkCwd(cwd: string): string | null {
  try {
    return statSync(cwd).isDirectory() ? null : "Working directory is not a directory";
  } catch {
    // ENOENT, or a path component we may not traverse — either way the cwd, not the binary.
    return "Working directory not found";
  }
}

function isPlatformNotFoundError(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  const c = cause as Record<string, unknown>;
  return c._tag === "SystemError" && c.reason === "NotFound";
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
