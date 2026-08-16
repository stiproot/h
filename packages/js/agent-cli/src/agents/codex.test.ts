import { FetchHttpClient } from "@effect/platform";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { codexStrategy } from "./codex.ts";
import type { AgentInvocationRequest, StreamEvent } from "./types.ts";

const buildInvocation = (request: AgentInvocationRequest) =>
  Effect.runPromise(
    codexStrategy.buildInvocation(request).pipe(Effect.provide(FetchHttpClient.layer)),
  );

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

  it("passes an explicit model through as --model", async () => {
    const inv = await buildInvocation(baseRequest({ model: "gpt-5" }));
    expect(inv.args[inv.args.indexOf("--model") + 1]).toBe("gpt-5");
  });

  it("OMITS --model when none is set (ChatGPT-account plan uses its own default)", async () => {
    const inv = await buildInvocation(baseRequest());
    expect(inv.args).not.toContain("--model");
    // prompt is still the last positional arg
    expect(inv.args[inv.args.length - 1]).toBe("do the thing");
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

describe("codexStrategy.validateEnvironment", () => {
  const ok = (r: ReturnType<typeof codexStrategy.validateEnvironment>) => expect(r).toBeNull();

  it("passes with OPENAI_API_KEY in effectiveEnv (API-key mode, unchanged)", () => {
    ok(codexStrategy.validateEnvironment({ OPENAI_API_KEY: "sk-x" }, {}));
  });

  it("passes with OPENAI_API_KEY in processEnv", () => {
    ok(codexStrategy.validateEnvironment({}, { OPENAI_API_KEY: "sk-x" }));
  });

  it("passes with CODEX_AUTH_MODE=chatgpt and NO api key (ChatGPT-plan auth via auth.json)", () => {
    ok(codexStrategy.validateEnvironment({}, { CODEX_AUTH_MODE: "chatgpt" }));
  });

  it("CODEX_AUTH_MODE is case-insensitive", () => {
    ok(codexStrategy.validateEnvironment({}, { CODEX_AUTH_MODE: "ChatGPT" }));
  });

  it("passes with a CODEX_ACCESS_TOKEN (Enterprise non-interactive path)", () => {
    ok(codexStrategy.validateEnvironment({}, { CODEX_ACCESS_TOKEN: "tok" }));
  });

  it("fails when no key and no chatgpt auth, naming both options", () => {
    const r = codexStrategy.validateEnvironment({}, {});
    expect(r).not.toBeNull();
    expect(r!.success).toBe(false);
    expect(r!.stderr).toContain("OPENAI_API_KEY or CODEX_AUTH_MODE=chatgpt");
  });

  it("does NOT accept an unrelated CODEX_AUTH_MODE value", () => {
    const r = codexStrategy.validateEnvironment({}, { CODEX_AUTH_MODE: "apikey" });
    expect(r).not.toBeNull();
  });

  it("treats an empty OPENAI_API_KEY as missing", () => {
    const r = codexStrategy.validateEnvironment({ OPENAI_API_KEY: "" }, {});
    expect(r).not.toBeNull();
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
    const metrics = codexStrategy.extractMetrics(events, baseRequest());
    expect(metrics.tokenUsage).toEqual({ input: 120, output: 50 });
  });

  it("returns empty when no result event is present", () => {
    expect(codexStrategy.extractMetrics([], baseRequest())).toEqual({});
  });

  it("never includes costUsd (Codex does not report it)", () => {
    const events: StreamEvent[] = [
      { type: "result", usage: { input_tokens: 10, output_tokens: 5 } },
    ];
    const metrics = codexStrategy.extractMetrics(events, baseRequest());
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

  it("parses item.completed agent_message (flat text) into an assistant event", async () => {
    // The REAL codex shape — a flat `text` field, not a content[] array. This is the final message
    // that carries the structured-output json block; if it isn't captured, the contract fails.
    const parser = await getParser();
    const events: StreamEvent[] = [];
    parser.parseLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: '```json\n{"pr": 58}\n```' },
      }),
      events,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "assistant",
      message: { content: [{ type: "text", text: '```json\n{"pr": 58}\n```' }] },
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

  it("parses item.completed mcp_tool_call into tool_use", async () => {
    const parser = await getParser();
    const events: StreamEvent[] = [];
    parser.parseLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "mcp_tool_call", server: "github", tool: "create_pull_request" },
      }),
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
