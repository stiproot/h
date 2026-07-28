import { existsSync, mkdtempSync, readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { NodeContext } from "@effect/platform-node";
import { AgentInvoker, LiteLlmCheckError } from "agent-cli";
import type { AgentInvokeParams, InvocationResult, LiteLlmError } from "agent-cli";
import { AgentRunner, RunLedgerLive } from "agent-server";
import type { AgentRunError } from "core";
import { Cause, ConfigProvider, Effect, Exit, Layer, ManagedRuntime, Option } from "effect";
import { LoggerTest } from "logger";
import { describe, expect, it } from "vitest";

import { OpenhandsRunnerLive } from "./openhands-runner.ts";

// Plain vitest + Effect.runPromise via a real ManagedRuntime over the full layer graph
// (stub invoker + LoggerTest + real FileSystem in temp dirs); see the refactor map's
// testing note re @effect/vitest peering on vitest 3 vs the repo's 4.

type Invoke = (params: AgentInvokeParams) => Effect.Effect<InvocationResult, LiteLlmError>;

function makeHarness(invoke: Invoke): {
  runtime: ManagedRuntime.ManagedRuntime<AgentRunner, unknown>;
  baseDir: string;
  runsDir: string;
  logs: Record<string, unknown>[];
} {
  const baseDir = mkdtempSync(join(tmpdir(), "openhands-base-"));
  const runsDir = mkdtempSync(join(tmpdir(), "openhands-runs-"));
  const logs: Record<string, unknown>[] = [];
  const layer = OpenhandsRunnerLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentInvoker, { invoke }),
        RunLedgerLive.pipe(Layer.provide(NodeContext.layer)),
        LoggerTest((obj) => logs.push(obj)),
        NodeContext.layer,
      ),
    ),
    Layer.provide(
      Layer.setConfigProvider(
        ConfigProvider.fromMap(
          new Map([
            ["AGENT_BASE_DIR", baseDir],
            ["AGENT_RUNS_DIR", runsDir],
            ["AGENT_MODEL", "test-model"],
            ["LLM_API_KEY", "test-key"],
            ["LLM_BASE_URL", "http://llm.test"],
          ]),
        ),
      ),
    ),
  );
  return { runtime: ManagedRuntime.make(layer), baseDir, runsDir, logs };
}

const runRequest = (input: string, workflowInstanceId: string) =>
  Effect.gen(function* () {
    const runner = yield* AgentRunner;
    return yield* runner.run({ input, workflowInstanceId });
  });

/** The single run dir the ledger wrote under `<runsDir>/<group>/`. */
function ledgerSummary(runsDir: string, group: string): Record<string, unknown> {
  const [runDir] = readdirSync(join(runsDir, group));
  return JSON.parse(readFileSync(join(runsDir, group, runDir!, "summary.json"), "utf8"));
}

describe("OpenhandsRunnerLive", () => {
  it("maps the invocation result onto the AgentResponse and writes the run ledger", async () => {
    const { runtime, baseDir, runsDir, logs } = makeHarness((params) => {
      // openhands' REAL ledger stream: raw stdout lines. Its unit of tool use is an ActionEvent
      // (the parser's normalised `tool_use` goes only into the INTERNAL events array, which the
      // ledger never sees) — so the tally counts these lines, not a synthetic `tool_use`.
      params.onEvent?.({ type: "output", text: JSON.stringify({ kind: "ActionEvent" }) });
      params.onEvent?.({ type: "output", text: "hello" });
      return Effect.succeed({
        success: true,
        stdout: "all done",
        tokenUsage: { input: 3, output: 7 },
        numTurns: 2,
        costUsd: 0.5,
        sessionId: "sess-1",
      });
    });

    const response = await runtime.runPromise(runRequest("do the thing", "wf-1"));

    expect(response).toMatchObject({
      output: "all done",
      sessionId: "sess-1",
      usage: { input: 3, output: 7 },
      // The stub reports no model — the response falls back to the configured one.
      model: "test-model",
      turns: 2,
      costUsd: 0.5,
      toolCalls: 1,
      workspacePath: join(baseDir, "wf-1"),
    });
    expect(response.runId).toContain("wf-1:openhands-agent:");
    // The runner owns the workspace dir (mkdir -p before spawning).
    expect(existsSync(join(baseDir, "wf-1"))).toBe(true);
    // Ledger artifacts: summary.json + events.jsonl under <runsDir>/<instanceId>/.
    expect(ledgerSummary(runsDir, "wf-1")).toMatchObject({
      status: "completed",
      agentId: "openhands-agent",
      toolCalls: 1,
    });
    // Each streamed event is logged through the Logger service with the child context.
    const eventLogs = logs.filter((l) => l.message === "agent output");
    expect(eventLogs).toHaveLength(2);
    expect(eventLogs[0]).toMatchObject({ agent: "openhands", workflowInstanceId: "wf-1" });

    await runtime.dispose();
  });

  it("maps an invoker failure to AgentRunError (wrapping OpenhandsRunError) and records a failed run", async () => {
    const failure = new LiteLlmCheckError({ url: "http://litellm.test", status: 500 });
    const { runtime, runsDir } = makeHarness(() => Effect.fail(failure));

    const exit = await runtime.runPromiseExit(runRequest("boom", "wf-2"));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Option.getOrThrow(Cause.failureOption(exit.cause)) as AgentRunError;
      expect(error._tag).toBe("AgentRunError");
      expect(error.agentId).toBe("openhands-agent");
      const inner = error.cause as { _tag: string; cause: unknown };
      expect(inner._tag).toBe("OpenhandsRunError");
      // Field-level asserts: crossing Effect.withSpan wraps the failure in a
      // stack-annotating Proxy, so reference identity does not survive the run.
      const cliError = inner.cause as { _tag?: string; url?: string; status?: number };
      expect(cliError._tag).toBe("LiteLlmCheckError");
      expect(cliError.url).toBe("http://litellm.test");
      expect(cliError.status).toBe(500);
    }
    expect(ledgerSummary(runsDir, "wf-2")).toMatchObject({ status: "failed" });

    await runtime.dispose();
  });
});
