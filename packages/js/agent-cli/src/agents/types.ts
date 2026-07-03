import type { HttpClient } from "@effect/platform";
import { Data, type Effect } from "effect";

import type { Logger } from "../lib/logger.ts";

/**
 * LLM API keys forwarded to agent CLI processes. Which key is required
 * depends on the agent type and is validated contextually at invocation time.
 */
export const AGENT_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "CURSOR_API_KEY",
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "LLM_API_KEY",
] as const;

export type AgentEnv = Partial<Record<(typeof AGENT_ENV_KEYS)[number], string>>;

/** LLM provider configuration: API key plus optional proxy base URL and routing hint. */
export interface LlmConfig {
  apiKey: string;
  baseUrl?: string;
  /** Environment hint for model routing (e.g. 'production' vs 'development') */
  llmEnv?: string;
}

/** Per-model token and cost usage breakdown. */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
}

/** Called for each JSON event emitted by the agent CLI stream. */
export type AgentEventCallback = (event: Record<string, unknown>) => void;

/** Invokes an agent CLI subprocess and resolves with its run result. */
export type AgentInvoker = (params: {
  systemPrompt: string;
  taskPrompt: string;
  cwd: string;
  env: Record<string, string>;
  timeout: number;
  /** Model to use for this invocation */
  model?: string;
  /** Agent CLI to use (default: 'claude') */
  agent?: string;
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
}) => Promise<{
  success: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** Aggregated token usage across all models */
  tokenUsage?: { input: number; output: number };
  /** Primary model (highest cost) */
  model?: string;
  /** Per-model usage breakdown */
  modelUsage?: Record<string, ModelUsage>;
  /** Total cost across all models */
  costUsd?: number;
  /** Number of agent conversation turns */
  numTurns?: number;
  /** Session ID for conversation continuation */
  sessionId?: string;
}>;

export type AgentType = "claude" | "cursor" | "gemini" | "codex" | "openhands";

/** The agent CLI subprocess could not be spawned or its stdio streams failed. */
export class AgentSpawnError extends Data.TaggedError("AgentSpawnError")<{
  readonly command: string;
  readonly cause: unknown;
}> {}

/**
 * The agent CLI subprocess exceeded the requested timeout. Internal: the
 * invoker layer converts it back into the exit-124 `InvocationResult` so the
 * observable contract matches the legacy Promise implementation.
 */
export class AgentTimeoutError extends Data.TaggedError("AgentTimeoutError")<{
  readonly timeoutMs: number;
}> {}

/** The LiteLLM proxy model listing failed (request error, non-2xx, or malformed body). */
export class LiteLlmCheckError extends Data.TaggedError("LiteLlmCheckError")<{
  readonly url: string;
  readonly status?: number;
  readonly body?: string;
  readonly cause?: unknown;
}> {}

/** The LiteLLM proxy model listing did not answer within the check timeout. */
export class LiteLlmTimeoutError extends Data.TaggedError("LiteLlmTimeoutError")<{
  readonly url: string;
  readonly timeoutMs: number;
}> {}

/** The requested model is not served by the LiteLLM proxy. */
export class LiteLlmModelUnavailableError extends Data.TaggedError("LiteLlmModelUnavailableError")<{
  readonly model: string;
  readonly available: ReadonlyArray<string>;
}> {}

export type LiteLlmError = LiteLlmCheckError | LiteLlmTimeoutError | LiteLlmModelUnavailableError;

export interface InvocationResult {
  success: boolean;
  stdout: string;
  stderr?: string;
  exitCode?: number;
  tokenUsage?: {
    input: number;
    output: number;
  };
  model?: string;
  modelUsage?: Record<string, ModelUsage>;
  costUsd?: number;
  numTurns?: number;
  sessionId?: string;
}

export interface StreamEventModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
}

export interface StreamEventStatsModel {
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cached?: number;
  input?: number;
}

export interface StreamEvent {
  type: string;
  subtype?: string;
  thread_id?: string;
  model?: string;
  num_turns?: number;
  message?: {
    content?: Array<{
      type: string;
      text?: string;
    }>;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  stats?: {
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    cached?: number;
    input?: number;
    duration_ms?: number;
    tool_calls?: number;
    models?: Record<string, StreamEventStatsModel>;
  };
  modelUsage?: Record<string, StreamEventModelUsage>;
  total_cost_usd?: number;
  session_id?: string;
}

export interface AgentInvocationRequest {
  systemPrompt: string;
  taskPrompt: string;
  cwd: string;
  env: Record<string, string>;
  effectiveEnv: AgentEnv;
  timeout: number;
  model?: string;
  resumeSessionId?: string;
  onEvent?: AgentEventCallback;
  verbose?: boolean;
  llmConfig?: LlmConfig;
  permissionMode?: "plan";
}

export interface AgentStreamParser {
  parseChunk(
    buffer: string,
    chunk: string,
    events: StreamEvent[],
    onEvent?: AgentEventCallback,
  ): string;
  flushBuffer(buffer: string, events: StreamEvent[], onEvent?: AgentEventCallback): void;
}

export interface PreparedAgentInvocation {
  command: string;
  args: string[];
  stdinInput?: string;
  shouldFilterEvent?: (event: StreamEvent) => boolean;
  streamParser?: AgentStreamParser;
}

export interface AgentStrategy {
  readonly type: AgentType;
  readonly name: string;

  validateEnvironment(
    effectiveEnv: AgentEnv,
    processEnv: NodeJS.ProcessEnv,
  ): InvocationResult | null;

  prepareEnvironment?(request: AgentInvocationRequest): Record<string, string>;

  ensureReady?(request: AgentInvocationRequest, log: Logger): Promise<InvocationResult | void>;

  /**
   * Promise-based invocation builder. A strategy must provide this or
   * {@link buildInvocationEffect} (the invoker prefers the Effect variant).
   */
  buildInvocation?(request: AgentInvocationRequest): Promise<PreparedAgentInvocation>;

  /**
   * Effect-native sibling of {@link buildInvocation}, preferred by the
   * invoker. Lets a strategy surface tagged errors (e.g. the LiteLLM
   * model check) in the error channel instead of throwing.
   */
  buildInvocationEffect?(
    request: AgentInvocationRequest,
  ): Effect.Effect<PreparedAgentInvocation, LiteLlmError, HttpClient.HttpClient>;

  extractSessionId(events: StreamEvent[]): string | undefined;

  extractMetrics(events: StreamEvent[], request: AgentInvocationRequest): Partial<InvocationResult>;
}
