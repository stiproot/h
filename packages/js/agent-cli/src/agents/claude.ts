import { Effect } from "effect";

import { adaptToLiteLlmEffect } from "../lib/litellm.ts";
import {
  buildCliInvocation,
  createMissingEnvResult,
  extractStandardSessionId,
  resolveEnvValue,
} from "./shared.ts";
import type {
  AgentInvocationRequest,
  AgentStrategy,
  InvocationResult,
  PreparedAgentInvocation,
  StreamEvent,
  StreamEventModelUsage,
} from "./types.ts";

const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";

export const claudeStrategy: AgentStrategy = {
  type: "claude",
  name: "Claude Code",

  validateEnvironment(effectiveEnv, processEnv) {
    const hasApiKey =
      resolveEnvValue(effectiveEnv, "ANTHROPIC_API_KEY") ||
      resolveEnvValue(processEnv, "ANTHROPIC_API_KEY");
    // A Claude Max/Pro subscription authenticates the CLI via an OAuth token
    // (`claude setup-token` → CLAUDE_CODE_OAUTH_TOKEN), inherited from the process
    // env, instead of an API key. Either one satisfies the requirement.
    const hasOAuthToken = resolveEnvValue(processEnv, "CLAUDE_CODE_OAUTH_TOKEN");
    // ANTHROPIC_AUTH_TOKEN supports third-party Anthropic-compatible endpoints
    // (e.g. Moonshot AI) that authenticate via Authorization: Bearer header.
    const hasAuthToken =
      resolveEnvValue(effectiveEnv, "ANTHROPIC_AUTH_TOKEN") ||
      resolveEnvValue(processEnv, "ANTHROPIC_AUTH_TOKEN");
    if (!hasApiKey && !hasOAuthToken && !hasAuthToken) {
      return createMissingEnvResult(
        "Claude",
        "ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, or ANTHROPIC_AUTH_TOKEN",
      );
    }
    return null;
  },

  prepareEnvironment(request) {
    const { llmConfig } = request;
    if (!llmConfig) return {};

    // Only forward an API key when one is actually set. An empty ANTHROPIC_API_KEY
    // would shadow the subscription's CLAUDE_CODE_OAUTH_TOKEN and force API billing.
    const env: Record<string, string> = {};
    if (llmConfig.apiKey) {
      env["ANTHROPIC_API_KEY"] = llmConfig.apiKey;
    }
    if (llmConfig.baseUrl) {
      env["ANTHROPIC_BASE_URL"] = llmConfig.baseUrl;
    }
    return env;
  },

  buildInvocation(request) {
    return adaptToLiteLlmEffect(request, request.model || DEFAULT_CLAUDE_MODEL).pipe(
      Effect.map((effectiveModel) => buildClaudeInvocation(request, effectiveModel)),
    );
  },

  extractSessionId(events) {
    return extractStandardSessionId(events);
  },

  extractMetrics(events) {
    const resultEvent = events.find((event) => event.type === "result");
    // No terminal result event — the run timed out or was killed mid-stream. Fold the partial
    // per-call usage off the assistant events instead of reporting nothing (B1,
    // the Moonshot $20 day): two 30-minute kimi runs billed their full duration and
    // ledgered zero because this path returned {}.
    if (!resultEvent) return foldPartialClaudeUsage(events);
    const metrics = resultEvent.modelUsage ? normalizeClaudeModelUsage(resultEvent.modelUsage) : {};

    return {
      ...metrics,
      costUsd: resultEvent.total_cost_usd ?? metrics.costUsd,
      numTurns: resultEvent.num_turns,
    };
  },

  // The claude CLI's verified shape: it never emits a top-level `tool_use` — calls arrive as
  // content blocks nested in an assistant message. `stats.tool_calls` is trusted when reported.
  tallyToolCalls(current, event) {
    let next = current;
    if ((event as { type?: string }).type === "tool_use") next += 1;
    const content = (event as { message?: { content?: unknown } }).message?.content;
    if (Array.isArray(content)) {
      next += content.filter((block) => (block as { type?: string })?.type === "tool_use").length;
    }
    const reported = (event as { stats?: { tool_calls?: number } }).stats?.tool_calls;
    if (typeof reported === "number") next = Math.max(next, reported);
    return next;
  },
};

function buildClaudeInvocation(
  request: AgentInvocationRequest,
  effectiveModel: string,
): PreparedAgentInvocation {
  // Plan mode is read-only and mutually exclusive with skip-permissions — emit one or the other.
  const permissionFlags =
    request.permissionMode === "plan"
      ? ["--permission-mode", "plan"]
      : ["--dangerously-skip-permissions"];

  return buildCliInvocation(request, {
    command: "claude",
    flags: ["--verbose", ...permissionFlags, "--output-format", "stream-json"],
    effectiveModel,
    stdinSupport: true,
    supportsResume: true,
  });
}

/**
 * Cumulative usage from a PARTIAL stream (no terminal result event): fold assistant events'
 * per-API-call `message.usage`, deduped by `message.id` keeping the LAST usage per id — the CLI
 * emits several assistant events per API call (one per content block) all carrying that call's
 * usage (verified live: 30 assistant events / 14 distinct ids on a timed-out kimi run). No
 * per-event cost exists in the stream, so costUsd stays absent — `costPartial` marks the shape.
 */
function foldPartialClaudeUsage(
  events: StreamEvent[],
): Pick<InvocationResult, "tokenUsage" | "model" | "numTurns" | "costPartial"> {
  const byMessageId = new Map<string, NonNullable<NonNullable<StreamEvent["message"]>["usage"]>>();
  let model: string | undefined;
  let unkeyed = 0;
  let unkeyedInput = 0;
  let unkeyedOutput = 0;
  for (const event of events) {
    if (event.type !== "assistant" || !event.message?.usage) continue;
    model ??= event.message.model;
    const usage = event.message.usage;
    const id = event.message.id;
    if (id) {
      byMessageId.set(id, usage);
    } else {
      // No message id to dedupe on — count it once, conservatively.
      unkeyed += 1;
      unkeyedInput += usage.input_tokens ?? 0;
      unkeyedOutput += usage.output_tokens ?? 0;
    }
  }
  if (byMessageId.size === 0 && unkeyed === 0) return {};
  let input = unkeyedInput;
  let output = unkeyedOutput;
  for (const usage of byMessageId.values()) {
    input +=
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0);
    output += usage.output_tokens ?? 0;
  }
  return {
    tokenUsage: { input, output },
    model,
    numTurns: byMessageId.size + unkeyed,
    costPartial: true,
  };
}

function normalizeClaudeModelUsage(
  modelUsage: Record<string, StreamEventModelUsage>,
): Pick<InvocationResult, "tokenUsage" | "model" | "modelUsage" | "costUsd"> {
  const entries = Object.entries(modelUsage);
  const normalized: NonNullable<InvocationResult["modelUsage"]> = {};
  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;
  let primaryModel: string | undefined;
  let highestCost = -1;

  for (const [modelName, usage] of entries) {
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const cacheReadInputTokens = usage.cacheReadInputTokens ?? 0;
    const cacheCreationInputTokens = usage.cacheCreationInputTokens ?? 0;
    const modelCost = usage.costUSD ?? 0;

    normalized[modelName] = {
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      costUsd: modelCost,
    };

    totalInput += inputTokens + cacheReadInputTokens + cacheCreationInputTokens;
    totalOutput += outputTokens;
    totalCost += modelCost;

    if (modelCost > highestCost) {
      highestCost = modelCost;
      primaryModel = modelName;
    }
  }

  return {
    tokenUsage: { input: totalInput, output: totalOutput },
    model: primaryModel ?? entries[0]?.[0],
    modelUsage: normalized,
    costUsd: totalCost,
  };
}
