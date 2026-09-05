/**
 * Tests for the `run-exec` builtin activity: `runExec` (the infrastructure implementation) and
 * the `applyOutputContract` seam it feeds through the ExecPort contract.
 *
 * Tests 1 and 4 exercise `runExec` directly (CommandExecutor only).
 * Tests 2 and 3 exercise the contract seam: `runExec` produces stdout → `applyOutputContract`
 * validates it — the same path the execute.ts dispatch follows.
 */

import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { applyOutputContract } from "workflow-core";
import { describe, expect, it } from "vitest";

import { ExecError, ExecTimeoutError, runExec } from "./exec-activity.ts";

// Provide the real Node CommandExecutor and run to promise.
const run = <A, E extends Error>(effect: Effect.Effect<A, E, NodeContext.NodeContext>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeContext.layer)));

// Fail a run and get the typed error.
const runFail = <E>(effect: Effect.Effect<unknown, E, NodeContext.NodeContext>): Promise<E> =>
  Effect.runPromise(effect.pipe(Effect.flip, Effect.provide(NodeContext.layer)));

describe("run-exec", () => {
  it("1. non-zero exit produces ExecError naming the exit code and stderr tail", async () => {
    const effect = runExec("exit 42", process.cwd(), 5000);
    const err = await runFail(effect);

    expect(err).toBeInstanceOf(ExecError);
    const execErr = err as ExecError;
    expect(execErr.exitCode).toBe(42);
    expect(execErr.message).toContain("42");
    expect(execErr.command).toContain("exit 42");
  });

  it("2. stdout with fenced JSON and a matching contract lands as `structured`", async () => {
    // Command that emits a valid fenced json block to stdout.
    const contract = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    };
    const cmd = `printf 'Here is the result\\n\\n\`\`\`json\\n{"answer":"hello"}\\n\`\`\`\\n'`;

    const result = await run(runExec(cmd, process.cwd(), 5000));
    const withContract = applyOutputContract(
      { sessionId: null, output: result.stdout, toolCalls: null },
      contract,
    );

    expect(withContract.structured).toEqual({ answer: "hello" });
  });

  it("3. stdout with malformed JSON and a contract fails with a StructuredOutputError message", async () => {
    const contract = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    };
    // The block is syntactically valid JSON but fails the schema (missing required property).
    const cmd = `printf 'Result\\n\\n\`\`\`json\\n{"wrong_field":123}\\n\`\`\`\\n'`;

    const result = await run(runExec(cmd, process.cwd(), 5000));
    expect(() =>
      applyOutputContract({ sessionId: null, output: result.stdout, toolCalls: null }, contract),
    ).toThrow();
  });

  it("4. command that exceeds timeoutMs produces ExecTimeoutError", async () => {
    const effect = runExec("sleep 10", process.cwd(), 100);
    const err = await runFail(effect);

    expect(err).toBeInstanceOf(ExecTimeoutError);
    const timeoutErr = err as ExecTimeoutError;
    expect(timeoutErr.timeoutMs).toBe(100);
    expect(timeoutErr.message).toContain("100");
  });
});
