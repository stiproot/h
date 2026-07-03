import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandExecutor, HttpClient } from "@effect/platform";
import { NodeContext, NodeHttpClient } from "@effect/platform-node";
import { AgentInvoker, ClaudeInvokerLive, LiteLlmCheckError } from "agent-cli";
import type { AgentInvokerService } from "agent-cli";
import { AgentRunner, ExecGitClient, RunLedgerLive } from "agent-server";
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { makeTracingLive } from "telemetry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClaudeRunnerLive } from "./infrastructure/claude-runner.ts";

// Mirrors the AppLive composition in index.ts (which cannot be imported here — it starts the
// server). The invoker layer is a parameter so the run-flow test can substitute a stub for the
// one dependency whose *invocation* would spawn a subprocess and hit the LiteLLM proxy; the
// rest of the graph is the real thing.
const appLayer = (
  invoker: Layer.Layer<
    AgentInvoker,
    never,
    CommandExecutor.CommandExecutor | HttpClient.HttpClient
  >,
) => {
  const PlatformLive = Layer.mergeAll(NodeContext.layer, NodeHttpClient.layer);
  return Layer.mergeAll(
    makeTracingLive("claude-agent"),
    ClaudeRunnerLive.pipe(
      Layer.provide(invoker),
      Layer.provide(RunLedgerLive),
      Layer.provide(PlatformLive),
    ),
    RunLedgerLive.pipe(Layer.provide(NodeContext.layer)),
    ExecGitClient.pipe(Layer.provide(NodeContext.layer)),
    NodeContext.layer,
  );
};

const ENV_KEYS = [
  "AGENT_BASE_DIR",
  "AGENT_RUNS_DIR",
  "MCP_CONFIG_SRC",
  "DAPR_HTTP_PORT",
  "ANTHROPIC_BASE_URL",
] as const;
const savedEnv = ENV_KEYS.map((key) => [key, process.env[key]] as const);

beforeEach(() => {
  // Required config with no code default — the layer fails to build without it.
  process.env.ANTHROPIC_BASE_URL = "http://llm.test";
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("claude-agent app layer", () => {
  it("builds the full layer graph, resolves AgentRunner, and disposes cleanly", async () => {
    const runtime = ManagedRuntime.make(appLayer(ClaudeInvokerLive));
    try {
      const runner = await runtime.runPromise(AgentRunner);
      expect(typeof runner.run).toBe("function");
    } finally {
      await runtime.dispose();
    }
  });

  it("runs the full run flow (workspace mkdir, mcp merge, ledger, response) with a stub invoker", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-agent-test-"));
    const baseDir = join(root, "base");
    const runsDir = join(root, "runs");
    const mcpSrc = join(root, "src.mcp.json");
    writeFileSync(
      mcpSrc,
      JSON.stringify({ mcpServers: { dapr: { type: "sse", url: "http://dapr-mcp:8000/sse" } } }),
    );
    process.env.AGENT_BASE_DIR = baseDir;
    process.env.AGENT_RUNS_DIR = runsDir;
    process.env.MCP_CONFIG_SRC = mcpSrc;
    delete process.env.DAPR_HTTP_PORT; // no statestore mirror — the test must not hit a sidecar

    const stub: AgentInvokerService = {
      invoke: (params) =>
        Effect.sync(() => {
          params.onEvent?.({ type: "tool_use" });
          return {
            success: true,
            stdout: "stub output",
            sessionId: "sess-1",
            model: "stub-model",
            numTurns: 2,
            tokenUsage: { input: 10, output: 5 },
            costUsd: 0.01,
          };
        }),
    };
    const runtime = ManagedRuntime.make(appLayer(Layer.succeed(AgentInvoker, stub)));
    try {
      const response = await runtime.runPromise(
        Effect.gen(function* () {
          const runner = yield* AgentRunner;
          return yield* runner.run({ input: "do the thing", workflowInstanceId: "wf-123" });
        }),
      );

      expect(response.output).toBe("stub output");
      expect(response.sessionId).toBe("sess-1");
      expect(response.usage).toEqual({ input: 10, output: 5 });
      expect(response.model).toBe("stub-model");
      expect(response.turns).toBe(2);
      expect(response.costUsd).toBe(0.01);
      expect(response.toolCalls).toBe(1);
      expect(response.runId).toMatch(/^wf-123:claude-agent:/);

      // Workspace provisioned and h's MCP config merged into it.
      const cwd = join(baseDir, "workspaces", "wf-123");
      const merged = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
      expect(merged.mcpServers.dapr.url).toBe("http://dapr-mcp:8000/sse");

      // Run ledger written under the instance group.
      const runDirs = readdirSync(join(runsDir, "wf-123"));
      expect(runDirs).toHaveLength(1);
      const runDir = join(runsDir, "wf-123", runDirs[0]!);
      const summary = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8"));
      expect(summary.status).toBe("completed");
      expect(summary.toolCalls).toBe(1);
      expect(readFileSync(join(runDir, "output.txt"), "utf8")).toBe("stub output");
      expect(existsSync(join(runDir, "events.jsonl"))).toBe(true);
    } finally {
      await runtime.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("wraps invoker failures in AgentRunError and records a failed ledger entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-agent-test-"));
    process.env.AGENT_BASE_DIR = join(root, "base");
    process.env.AGENT_RUNS_DIR = join(root, "runs");
    process.env.MCP_CONFIG_SRC = join(root, "absent.mcp.json"); // no source → merge step skipped
    delete process.env.DAPR_HTTP_PORT;

    const boom = new LiteLlmCheckError({ url: "http://litellm/models", status: 500 });
    const stub: AgentInvokerService = { invoke: () => Effect.fail(boom) };
    const runtime = ManagedRuntime.make(appLayer(Layer.succeed(AgentInvoker, stub)));
    try {
      const exit = await runtime.runPromiseExit(
        Effect.gen(function* () {
          const runner = yield* AgentRunner;
          return yield* runner.run({ input: "boom", workflowInstanceId: "wf-fail" });
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        // Compare tags/fields, not identity: the span-capture machinery wraps a failed error
        // in a Proxy on its way through Effect.withSpan, so the original instance identity is
        // (deliberately) not preserved.
        const error = Cause.squash(exit.cause) as { _tag?: string; cause?: { _tag?: string } };
        expect(error._tag).toBe("AgentRunError");
        expect(error.cause?._tag).toBe("LiteLlmCheckError");
      }

      const runDirs = readdirSync(join(root, "runs", "wf-fail"));
      const summary = JSON.parse(
        readFileSync(join(root, "runs", "wf-fail", runDirs[0]!, "summary.json"), "utf8"),
      );
      expect(summary.status).toBe("failed");
    } finally {
      await runtime.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
