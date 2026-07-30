import { FetchHttpClient } from "@effect/platform";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { claudeStrategy } from "./claude.ts";
import type { AgentInvocationRequest, PreparedAgentInvocation } from "./types.ts";

// No llmConfig.baseUrl → adaptToLiteLlmEffect short-circuits and returns the model without a
// network call, so buildInvocationEffect is exercised offline (the HttpClient layer is never hit).
function baseRequest(overrides: Partial<AgentInvocationRequest> = {}): AgentInvocationRequest {
  return {
    systemPrompt: "",
    taskPrompt: "do the thing",
    cwd: "/tmp",
    env: {},
    effectiveEnv: {},
    timeout: 1000,
    ...overrides,
  };
}

const buildInvocation = (request: AgentInvocationRequest): Promise<PreparedAgentInvocation> =>
  Effect.runPromise(
    claudeStrategy.buildInvocation(request).pipe(Effect.provide(FetchHttpClient.layer)),
  );

describe("claudeStrategy.validateEnvironment", () => {
  it("passes when ANTHROPIC_API_KEY is set in effectiveEnv", () => {
    expect(claudeStrategy.validateEnvironment({ ANTHROPIC_API_KEY: "sk-test" }, {})).toBeNull();
  });

  it("passes when ANTHROPIC_API_KEY is set in processEnv", () => {
    expect(claudeStrategy.validateEnvironment({}, { ANTHROPIC_API_KEY: "sk-test" })).toBeNull();
  });

  it("passes when CLAUDE_CODE_OAUTH_TOKEN is set in processEnv", () => {
    expect(
      claudeStrategy.validateEnvironment({}, { CLAUDE_CODE_OAUTH_TOKEN: "tok-test" }),
    ).toBeNull();
  });

  it("passes when ANTHROPIC_AUTH_TOKEN is set in processEnv", () => {
    expect(claudeStrategy.validateEnvironment({}, { ANTHROPIC_AUTH_TOKEN: "tok-test" })).toBeNull();
  });

  it("fails when all three credentials are absent", () => {
    const result = claudeStrategy.validateEnvironment({}, {});
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
  });

  it("still passes with ANTHROPIC_API_KEY alone (regression guard)", () => {
    expect(claudeStrategy.validateEnvironment({ ANTHROPIC_API_KEY: "sk-test" }, {})).toBeNull();
  });

  it("still passes with CLAUDE_CODE_OAUTH_TOKEN alone (regression guard)", () => {
    expect(
      claudeStrategy.validateEnvironment({}, { CLAUDE_CODE_OAUTH_TOKEN: "tok-test" }),
    ).toBeNull();
  });
});

describe("claudeStrategy.extractMetrics partial fold (no terminal result event)", () => {
  // The B1 shape: a timed-out/killed run has assistant events
  // carrying per-API-call usage but no result event — fold them instead of reporting nothing.
  const usageEvent = (id: string, usage: Record<string, number>, model = "kimi-k3") => ({
    type: "assistant",
    message: { id, model, usage, content: [{ type: "text", text: "…" }] },
  });

  it("folds assistant usage deduped by message.id (several events share one API call's usage)", () => {
    // Verified live: 30 assistant events / 14 distinct message ids on a timed-out kimi run.
    const metrics = claudeStrategy.extractMetrics(
      [
        usageEvent("msg-1", { input_tokens: 100, output_tokens: 10 }),
        usageEvent("msg-1", { input_tokens: 100, output_tokens: 10 }), // same call, second block
        usageEvent("msg-2", {
          input_tokens: 200,
          output_tokens: 20,
          cache_read_input_tokens: 50,
        }),
      ],
      baseRequest(),
    );

    expect(metrics).toEqual({
      tokenUsage: { input: 350, output: 30 },
      model: "kimi-k3",
      numTurns: 2,
      costPartial: true,
    });
  });

  it("returns {} when the partial stream has no usage at all (never a fake zero)", () => {
    expect(
      claudeStrategy.extractMetrics(
        [
          { type: "system", subtype: "init" },
          { type: "assistant", message: { content: [] } },
        ],
        baseRequest(),
      ),
    ).toEqual({});
  });

  it("prefers the terminal result event when present (unchanged final accounting)", () => {
    const metrics = claudeStrategy.extractMetrics(
      [
        usageEvent("msg-1", { input_tokens: 999, output_tokens: 99 }),
        {
          type: "result",
          total_cost_usd: 1.25,
          num_turns: 7,
          modelUsage: { "kimi-k3": { inputTokens: 10, outputTokens: 5, costUSD: 1.25 } },
        },
      ],
      baseRequest(),
    );

    expect(metrics.costUsd).toBe(1.25);
    expect(metrics.numTurns).toBe(7);
    expect(metrics.costPartial).toBeUndefined();
  });
});

describe("claudeStrategy.buildInvocation permission mode", () => {
  it("uses --permission-mode plan and omits skip-permissions when permissionMode is 'plan'", async () => {
    const { args } = await buildInvocation(baseRequest({ permissionMode: "plan" }));

    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
  });

  it("defaults to --dangerously-skip-permissions when permissionMode is unset", async () => {
    const { args } = await buildInvocation(baseRequest());

    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--permission-mode");
  });

  it("passes a model override through as --model", async () => {
    const { args } = await buildInvocation(baseRequest({ model: "claude-sonnet-4-6" }));

    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-4-6");
  });

  it("falls back to the default model when model is an empty string", async () => {
    // Regression guard: empty-string model must not defeat the default (|| vs ??).
    const { args } = await buildInvocation(baseRequest({ model: "" }));

    expect(args[args.indexOf("--model") + 1]).not.toBe("");
  });
});
