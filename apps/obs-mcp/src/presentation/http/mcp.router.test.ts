import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  ObservabilityError,
  ObservabilityService,
  type ObservabilityServiceShape,
} from "../../domain/ports/IObservabilityService.ts";
import { toolEffect } from "./mcp.router.ts";

// A stub port: every method succeeds empty unless overridden.
function stubService(overrides: Partial<ObservabilityServiceShape> = {}) {
  return Layer.succeed(ObservabilityService, {
    traceSearch: () => Effect.succeed([]),
    traceGet: () => Effect.succeed(Option.none()),
    logsQuery: () => Effect.succeed([]),
    runsList: () => Effect.succeed([]),
    runGet: () => Effect.succeed({ summary: Option.none(), output: Option.none(), events: [] }),
    systemOverview: () => Effect.succeed({ services: [], recentRuns: [] }),
    ...overrides,
  });
}

function callTool(name: string, args: unknown, layer = stubService()) {
  const effect = toolEffect(name, args);
  if (!effect) throw new Error(`unknown tool: ${name}`);
  return Effect.runPromise(effect.pipe(Effect.provide(layer)));
}

describe("toolEffect", () => {
  it("returns undefined for an unknown tool (protocol-level error, not a ToolResult)", () => {
    expect(toolEffect("nope", {})).toBeUndefined();
  });

  it("a genuine tool failure becomes an { isError: true } ToolResult — never a rejection", async () => {
    const failing = stubService({
      traceSearch: () =>
        Effect.fail(
          new ObservabilityError({ op: "traceSearch", cause: new Error("zipkin exploded") }),
        ),
    });
    const result = await callTool("trace_search", {}, failing);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Error:");
  });

  it("a decode failure (missing required arg) becomes an { isError: true } ToolResult", async () => {
    const result = await callTool("run_get", {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Error:");
  });

  it("tolerated-missing results stay structured empty results, NOT isError", async () => {
    const traceGet = await callTool("trace_get", { traceId: "t1" });
    expect(traceGet.isError).toBeUndefined();
    expect(traceGet.content[0]!.text).toBe("null");

    const runGet = await callTool("run_get", { runId: "g:a:1" });
    expect(runGet.isError).toBeUndefined();
    expect(JSON.parse(runGet.content[0]!.text)).toEqual({
      summary: null,
      output: null,
      events: [],
    });

    const runsList = await callTool("runs_list", {});
    expect(runsList.isError).toBeUndefined();
    expect(runsList.content[0]!.text).toBe("[]");
  });

  it("passes decoded filters through to the port", async () => {
    const seen: unknown[] = [];
    const layer = stubService({
      runsList: (params) => {
        seen.push(params);
        return Effect.succeed([{ agentId: "claude" }]);
      },
    });
    const result = await callTool(
      "runs_list",
      { agentId: "claude", limit: 5, instanceId: "inst-1" },
      layer,
    );
    expect(seen).toEqual([{ agentId: "claude", limit: 5, instanceId: "inst-1" }]);
    expect(JSON.parse(result.content[0]!.text)).toEqual([{ agentId: "claude" }]);
  });
});
