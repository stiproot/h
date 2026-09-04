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

  // What codex ACTUALLY streams for a shell command and a file edit (verbatim shapes from a
  // 2026-09-04 run ledger). These were tallied as nothing for two months — see CODEX_TOOL_ITEMS.
  it.each([
    { type: "command_execution", command: "/bin/bash -lc 'bun run lint'", exit_code: 0 },
    { type: "file_change", changes: [{ path: "src/a.ts", kind: "update" }], status: "completed" },
  ])("parses item.completed $type into tool_use", async (item) => {
    const parser = await getParser();
    const events: StreamEvent[] = [];
    parser.parseLine(JSON.stringify({ type: "item.completed", item }), events);
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

  it("parses item.completed command_execution into tool_use (the shell calls a coding agent makes)", async () => {
    const parser = await getParser();
    const events: StreamEvent[] = [];
    parser.parseLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", command: "sed -n 1,80p src/ops/like.ts", exit_code: 0 },
      }),
      events,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "tool_use" });
  });

  it("parses turn.completed usage in the input_tokens/cached_input_tokens shape codex 0.60+ emits", async () => {
    // Verbatim from ledger local-260904-071251 (2026-09-04); the old names read this as input 0.
    const parser = await getParser();
    const events: StreamEvent[] = [];
    parser.parseLine(
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 38268,
          cached_input_tokens: 22528,
          cache_write_input_tokens: 0,
          output_tokens: 111,
          reasoning_output_tokens: 0,
        },
      }),
      events,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "result",
      usage: { input_tokens: 38268, output_tokens: 111, cached_input_tokens: 22528 },
    });
  });

  it("parses turn.completed usage in the older prompt_tokens/cached_tokens shape", async () => {
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

describe("codexStrategy.tallyToolCalls (every item type codex streams for a tool)", () => {
  const tally = (items: string[]): number =>
    items.reduce(
      (n, type) =>
        codexStrategy.tallyToolCalls?.call(codexStrategy, n, {
          type: "item.completed",
          item: { type },
        }) ?? n,
      0,
    );

  it("counts a shell command and a file edit, not just an MCP call", () => {
    // The 2026-09-04 implement run: 22 commands + 6 file changes + 9 messages, 0 MCP calls —
    // and a tally of 0 before this set was widened.
    const items = [
      ...Array<string>(22).fill("command_execution"),
      ...Array<string>(6).fill("file_change"),
      ...Array<string>(9).fill("agent_message"),
    ];
    expect(tally(items)).toBe(28);
  });

  it("does not count assistant text, reasoning or an item that only started", () => {
    expect(tally(["agent_message", "reasoning", "error"])).toBe(0);
    expect(
      codexStrategy.tallyToolCalls?.call(codexStrategy, 0, {
        type: "item.started",
        item: { type: "command_execution" },
      }),
    ).toBe(0);
  });
});
