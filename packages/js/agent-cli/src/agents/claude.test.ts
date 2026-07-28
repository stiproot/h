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
