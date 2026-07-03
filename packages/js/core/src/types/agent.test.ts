import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { AgentRequest, AgentResponse } from "./agent.ts";

// Plain vitest + runSyncExit (decoding a plain Struct is synchronous); see the
// refactor map's testing note re @effect/vitest peering on vitest 3 vs repo's 4.
const decodeRequest = (input: unknown) =>
  Effect.runSyncExit(Schema.decodeUnknown(AgentRequest)(input));
const decodeResponse = (input: unknown) =>
  Effect.runSyncExit(Schema.decodeUnknown(AgentResponse)(input));

describe("AgentRequest schema", () => {
  it("accepts a minimal request", () => {
    const exit = decodeRequest({ input: "do the thing" });
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toEqual({ input: "do the thing" });
  });

  it("accepts a fully-populated request, including a null sessionId", () => {
    const full = {
      input: "task",
      systemPrompt: "be terse",
      sessionId: null,
      workflowInstanceId: "wf-1",
      workspaceId: "ws-1",
      cwd: "/tmp/worktree",
      model: "claude-sonnet-4-5",
      permissionMode: "plan",
    };
    const exit = decodeRequest(full);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toEqual(full);
  });

  it("rejects a request without input", () => {
    expect(Exit.isFailure(decodeRequest({ systemPrompt: "hi" }))).toBe(true);
  });

  it('rejects a permissionMode other than "plan"', () => {
    expect(Exit.isFailure(decodeRequest({ input: "x", permissionMode: "yolo" }))).toBe(true);
  });

  it("rejects a non-object body", () => {
    expect(Exit.isFailure(decodeRequest("input"))).toBe(true);
  });
});

describe("AgentResponse schema", () => {
  const minimal = {
    output: "done",
    sessionId: null,
    usage: { input: 10, output: 20 },
    model: "claude-sonnet-4-5",
    turns: 3,
  };

  it("accepts a minimal response", () => {
    const exit = decodeResponse(minimal);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toEqual(minimal);
  });

  it("accepts optional cost/toolCalls/runId/workspacePath", () => {
    const exit = decodeResponse({
      ...minimal,
      sessionId: "s-1",
      workspacePath: "/ws",
      costUsd: 0.42,
      toolCalls: 7,
      runId: "run-1",
    });
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("rejects a malformed usage block", () => {
    expect(Exit.isFailure(decodeResponse({ ...minimal, usage: { input: "10", output: 20 } }))).toBe(
      true,
    );
  });

  it("rejects a missing sessionId (null is required, absence is not)", () => {
    const { sessionId: _sessionId, ...rest } = minimal;
    expect(Exit.isFailure(decodeResponse(rest))).toBe(true);
  });
});
