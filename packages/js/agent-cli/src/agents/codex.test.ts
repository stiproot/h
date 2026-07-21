import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { codexStrategy } from "./codex.ts";
import type { AgentInvocationRequest, StreamEvent } from "./types.ts";

const buildInvocation = (request: AgentInvocationRequest) =>
  Effect.runPromise(codexStrategy.buildInvocation(request));

function baseRequest(overrides: Partial<AgentInvocationRequest> = {}): AgentInvocationRequest {
  return {
    systemPrompt: "",
    taskPrompt: "do the thing",
    cwd: "/tmp/workspace",
    env: {},
    effectiveEnv: {},
    timeout: 1000,
    ...overrides,
  };
}

describe("codexStrategy.buildInvocation", () => {
  it("builds codex exec invocation with all required flags", async () => {
    const inv = await buildInvocation(baseRequest({ model: "o4-mini" }));
    expect(inv.command).toBe("codex");
    expect(inv.args).toContain("exec");
    expect(inv.args).toContain("--json");
    expect(inv.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(inv.args).toContain("--skip-git-repo-check");
    expect(inv.args).toContain("--cd");
    expect(inv.args).toContain("/tmp/workspace");
    expect(inv.args).toContain("--model");
    expect(inv.args).toContain("o4-mini");
  });

  it("passes the task prompt as the last positional argument", async () => {
    const inv = await buildInvocation(baseRequest({ taskPrompt: "write tests" }));
    expect(inv.args[inv.args.length - 1]).toBe("write tests");
  });

  it("defaults model to o4-mini when not specified", async () => {
    const inv = await buildInvocation(baseRequest());
    expect(inv.args[inv.args.indexOf("--model") + 1]).toBe("o4-mini");
  });

  it("uses the cwd from the request for --cd", async () => {
    const inv = await buildInvocation(baseRequest({ cwd: "/workspace/my-run" }));
    expect(inv.args[inv.args.indexOf("--cd") + 1]).toBe("/workspace/my-run");
  });

  it("does not use stdin (prompt is a positional arg)", async () => {
    const inv = await buildInvocation(baseRequest());
    expect(inv.stdinInput).toBeUndefined();
  });
});

describe("codexStrategy.extractSessionId", () => {
  it("returns the session_id from a session_start event", () => {
    const events: StreamEvent[] = [{ type: "session_start", session_id: "thread-abc" }];
    expect(codexStrategy.extractSessionId(events)).toBe("thread-abc");
  });

  it("returns undefined when no session_start event is present", () => {
    expect(codexStrategy.extractSessionId([])).toBeUndefined();
  });
});

describe("codexStrategy.extractMetrics", () => {
  it("sums prompt_tokens and cached_tokens into input", () => {
    const events: StreamEvent[] = [
      { type: "result", usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 20 } },
    ];
    const metrics = codexStrategy.extractMetrics(events);
    expect(metrics.tokenUsage).toEqual({ input: 120, output: 50 });
  });

  it("returns empty when no result event is present", () => {
    expect(codexStrategy.extractMetrics([])).toEqual({});
  });

  it("never includes costUsd (Codex does not report it)", () => {
    const events: StreamEvent[] = [
      { type: "result", usage: { input_tokens: 10, output_tokens: 5 } },
    ];
    const metrics = codexStrategy.extractMetrics(events);
    expect(metrics.costUsd).toBeUndefined();
  });
});

describe("codex JSONL parser", () => {
  async function getParser() {
    const inv = await buildInvocation(baseRequest());
    return inv.streamParser!;
  }

  it("parses thread.started into session_start", async () => {
    const parser = await getParser();
    const events: StreamEvent[] = [];
    parser.parseLine(JSON.stringify({ type: "thread.started", thread_id: "t-001" }), events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "session_start", session_id: "t-001" });
  });

  it("parses item.completed message into assistant event with content", async () => {
    const parser = await getParser();
    const events: StreamEvent[] = [];
    parser.parseLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "message", content: [{ type: "text", text: "Hello!" }] },
      }),
      events,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello!" }] },
    });
  });

  it("parses item.completed function_call into tool_use", async () => {
    const parser = await getParser();
    const events: StreamEvent[] = [];
    parser.parseLine(
      JSON.stringify({ type: "item.completed", item: { type: "function_call" } }),
      events,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "tool_use" });
  });

  it("parses turn.completed into result with usage", async () => {
    const parser = await getParser();
    const events: StreamEvent[] = [];
    parser.parseLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { prompt_tokens: 100, cached_tokens: 10, output_tokens: 50 },
      }),
      events,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "result",
      usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 10 },
    });
  });

  it("parses error event", async () => {
    const parser = await getParser();
    const events: StreamEvent[] = [];
    parser.parseLine(JSON.stringify({ type: "error", error: "something went wrong" }), events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", result: "something went wrong" });
  });

  it("ignores empty and whitespace-only lines", async () => {
    const parser = await getParser();
    const events: StreamEvent[] = [];
    parser.parseLine("", events);
    parser.parseLine("   ", events);
    expect(events).toHaveLength(0);
  });

  it("ignores malformed JSON", async () => {
    const parser = await getParser();
    const events: StreamEvent[] = [];
    parser.parseLine("{not json}", events);
    expect(events).toHaveLength(0);
  });

  it("ignores unknown event types", async () => {
    const parser = await getParser();
    const events: StreamEvent[] = [];
    parser.parseLine(JSON.stringify({ type: "unknown.event", data: {} }), events);
    expect(events).toHaveLength(0);
  });
});
